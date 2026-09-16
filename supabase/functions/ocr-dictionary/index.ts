// @ts-nocheck
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const GEMINI_MODEL = "gemini-2.0-flash";
const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY") ?? "";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    if (!GEMINI_API_KEY) {
      return json({ error: "GEMINI_API_KEY 未配置, 请在 Supabase Dashboard > Edge Functions > Secrets 中添加" }, 500);
    }

    // 鉴权: 必须是登录用户
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "未登录" }, 401);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { global: { headers: { Authorization: authHeader } } }
    );
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return json({ error: "未登录或 token 无效" }, 401);

    // 检查是否 admin
    const { data: profile } = await supabase
      .from("user_auth")
      .select("username, is_admin")
      .eq("user_id", user.id)
      .single();
    if (!profile?.is_admin) {
      return json({ error: "无权限, 仅管理员可使用词典导入" }, 403);
    }

    const body = await req.json();
    const images = body.images; // base64 数组 [{ data: "base64...", mimeType: "image/jpeg" }]
    if (!images || !Array.isArray(images) || images.length === 0) {
      return json({ error: "缺少 images 参数" }, 400);
    }
    if (images.length > 10) {
      return json({ error: "最多 10 张图片" }, 400);
    }

    const results = [];
    for (let i = 0; i < images.length; i++) {
      const img = images[i];
      console.log(`[ocr-dictionary] 处理第 ${i + 1}/${images.length} 张`);

      const geminiResp = await callGemini(img.data, img.mimeType || "image/jpeg");
      results.push(geminiResp);
    }

    return json({ pages: results });
  } catch (e) {
    console.error("[ocr-dictionary] 错误:", e);
    return json({ error: e.message || "服务器内部错误" }, 500);
  }
});

async function callGemini(base64Data: string, mimeType: string): Promise<any> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

  const prompt = `你是一个词典页面解析专家。请仔细分析这张词典页面的图片，提取所有词条信息。

要求：
1. 识别页面上的所有词条（headword）
2. 提取每个词条的：音标、词性、释义
3. 如果有派生词、词组、例句，也要提取
4. 如果能看到页码，请提取页码
5. 如果图片不清晰或不是词典页面，返回空结果

请以 JSON 格式返回（不要加 markdown 代码块标记，直接返回纯 JSON）：
{
  "pageNumber": null,
  "words": [
    {
      "word": "abandon",
      "phonetic": "/əˈbændən/",
      "pos": "vt.",
      "meanings": ["放弃", "抛弃"],
      "derivatives": ["abandoned adj. 被遗弃的", "abandonment n. 放弃"],
      "phrases": ["abandon oneself to 沉溺于"],
      "examples": ["He abandoned his car. 他放弃了他的车。"]
    }
  ]
}`;

  const payload = {
    contents: [{
      parts: [
        { text: prompt },
        { inline_data: { mime_type: mimeType, data: base64Data } }
      ]
    }],
    generation_config: {
      temperature: 0.1,
      max_output_tokens: 8192,
      response_mime_type: "application/json"
    }
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    console.error("[ocr-dictionary] Gemini API 错误:", resp.status, errText);
    throw new Error(`Gemini API ${resp.status}: ${errText}`);
  }

  const data = await resp.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "{}";

  try {
    return JSON.parse(text);
  } catch {
    // 如果返回的不是纯 JSON, 尝试提取
    const match = text.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    return { pageNumber: null, words: [], raw: text };
  }
}

function json(body: any, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
