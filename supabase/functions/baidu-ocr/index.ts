// @ts-nocheck
/**
 * 百度 OCR Edge Function (v1.16.0)
 *
 * 流程: 前端上传图片 base64 → 本函数换百度 access_token → 调通用文字识别 → 返回文本
 *
 * 安全: API Key/Secret Key 从环境变量读取, 不硬编码, 不返回给前端
 *
 * 配置 (在 Supabase Dashboard > Edge Functions > Secrets 添加):
 *   BAIDU_API_KEY=aspJC8Q5YSRerSn02L9KeIJ8
 *   BAIDU_SECRET_KEY=<你的 Secret Key>
 *
 * 鉴权: 必须是管理员登录 (检查 user_auth.is_admin)
 *
 * 免费额度: 通用文字识别标准版 1000 次/月 (适合词典英文识别)
 */
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const BAIDU_API_KEY = Deno.env.get("BAIDU_API_KEY") ?? "";
const BAIDU_SECRET_KEY = Deno.env.get("BAIDU_SECRET_KEY") ?? "";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// access_token 缓存 (有效期 30 天, 函数实例存活期间复用)
let cachedToken: string | null = null;
let tokenExpiresAt = 0;

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    if (!BAIDU_API_KEY || !BAIDU_SECRET_KEY) {
      return json({
        error: "BAIDU_API_KEY / BAIDU_SECRET_KEY 未配置",
        hint: "在 Supabase Dashboard > Edge Functions > Secrets 添加两个变量",
      }, 500);
    }

    // 鉴权: 必须登录且是管理员
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "未登录" }, 401);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { global: { headers: { Authorization: authHeader } } }
    );
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return json({ error: "未登录或 token 无效" }, 401);

    const { data: profile } = await supabase
      .from("user_auth")
      .select("username, is_admin")
      .eq("user_id", user.id)
      .single();
    if (!profile?.is_admin) {
      return json({ error: "无权限, 仅管理员可使用词典导入" }, 403);
    }

    const body = await req.json();
    const images = body.images; // [{ data: "base64...", mimeType: "image/jpeg" }]
    if (!images || !Array.isArray(images) || images.length === 0) {
      return json({ error: "缺少 images 参数" }, 400);
    }
    if (images.length > 10) {
      return json({ error: "最多 10 张图片" }, 400);
    }

    // 拿 access_token (有缓存就用缓存)
    const accessToken = await getAccessToken();
    if (!accessToken) {
      return json({ error: "获取百度 access_token 失败" }, 500);
    }

    const pages = [];
    for (let i = 0; i < images.length; i++) {
      const img = images[i];
      console.log(`[baidu-ocr] 处理第 ${i + 1}/${images.length} 张`);

      // 调百度通用文字识别 (标准版, 英文)
      const ocrResult = await callBaiduOcr(accessToken, img.data, img.mimeType || "image/jpeg");
      if (ocrResult.error_code) {
        // 单张失败不影响其他张, 把错误塞进结果
        pages.push({ text: "", error: `百度 OCR 错误 ${ocrResult.error_code}: ${ocrResult.error_msg}` });
        continue;
      }

      // 把 words_result 数组拼成纯文本 (每行一条)
      const lines = (ocrResult.words_result || []).map((w: any) => w.words || "");
      pages.push({ text: lines.join("\n") });
    }

    return json({ pages });
  } catch (e) {
    console.error("[baidu-ocr] 错误:", e);
    return json({ error: e.message || "服务器内部错误" }, 500);
  }
});

/**
 * 获取百度 access_token (带缓存, 30 天有效期)
 * 文档: https://ai.baidu.com/ai-doc/REFERENCE/Ck3wjd4uk
 */
async function getAccessToken(): Promise<string | null> {
  // 缓存有效 (提前 5 分钟刷新)
  const now = Date.now();
  if (cachedToken && now < tokenExpiresAt - 5 * 60 * 1000) {
    return cachedToken;
  }

  const url = "https://aip.baidubce.com/oauth/2.0/token";
  const params = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: BAIDU_API_KEY,
    client_secret: BAIDU_SECRET_KEY,
  });

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  const data = await resp.json();

  if (!data.access_token) {
    console.error("[baidu-ocr] 获取 access_token 失败:", data);
    return null;
  }

  cachedToken = data.access_token;
  // expires_in 单位秒 (通常 2592000 = 30 天)
  tokenExpiresAt = now + (data.expires_in || 2592000) * 1000;
  console.log("[baidu-ocr] access_token 刷新成功, 有效期", Math.floor((data.expires_in || 0) / 86400), "天");
  return cachedToken;
}

/**
 * 调百度通用文字识别 (标准版)
 * 文档: https://ai.baidu.com/ai-doc/OCR/Ck3wjd4uk (通用文字识别—标准版)
 *
 * 接口: POST https://aip.baidubce.com/rest/2.0/ocr/v1/general_basic
 *   image: base64 编码的图片 (不带 data:xxx;base64, 前缀)
 *   language_type: ENG (英文)
 *   detect_language: false (不检测语种, 已知是英文)
 */
async function callBaiduOcr(accessToken: string, base64Data: string, _mimeType: string): Promise<any> {
  const url = `https://aip.baidubce.com/rest/2.0/ocr/v1/general_basic?access_token=${encodeURIComponent(accessToken)}`;

  // body 必须是 application/x-www-form-urlencoded
  const params = new URLSearchParams();
  params.append("image", base64Data);
  params.append("language_type", "ENG");
  params.append("detect_language", "false");
  // detect_direction: 自动旋转图片 (词典拍照可能歪)
  params.append("detect_direction", "true");
  // paragraph: false (不合并段落, 保持单行便于正则解析)
  params.append("paragraph", "false");

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  return await resp.json();
}

function json(obj: any, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
  });
}
