/**
 * PAYJS 创建支付订单 Edge Function
 * 前端调用: POST { username: string }
 * 返回: { success, qrcode, out_trade_no, total_fee }
 *
 * 环境变量 (在 Supabase Dashboard > Edge Functions > Settings 中配置):
 *   PAYJS_MCHID  - PAYJS 商户号
 *   PAYJS_KEY    - PAYJS 通信密钥
 *   PAYJS_NOTIFY_URL - 回调地址 (如 https://xxx.supabase.co/functions/v1/pay-notify)
 *   SUPABASE_SERVICE_ROLE_KEY - Supabase service_role key (用于调用 RPC)
 */

// PAYJS 签名: 参数按 key 字典序排序, 拼接 key=value&...&key=商户密钥, MD5
function sign(params: Record<string, string>, key: string): string {
  const sortedKeys = Object.keys(params).filter(k => k !== 'sign' && params[k] !== undefined && params[k] !== '').sort();
  const str = sortedKeys.map(k => `${k}=${params[k]}`).join('&') + '&key=' + key;
  // 简单 MD5 (Deno 内置)
  return md5(str);
}

// Deno 标准库 MD5
import { crypto } from "https://deno.land/std@0.208.0/crypto/mod.ts";
import { encodeHex } from "https://deno.land/std@0.208.0/encoding/hex.ts";

async function md5(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("MD5", data);
  return encodeHex(new Uint8Array(hash));
}

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const PAYJS_MCHID = Deno.env.get("PAYJS_MCHID") || "";
const PAYJS_KEY = Deno.env.get("PAYJS_KEY") || "";
const NOTIFY_URL = Deno.env.get("PAYJS_NOTIFY_URL") || "";

// 调用 Supabase RPC
async function callRpc(func: string, params: Record<string, unknown>) {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${func}`, {
    method: "POST",
    headers: {
      "apikey": SERVICE_KEY,
      "Authorization": `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(params),
  });
  return await resp.json();
}

Deno.serve(async (req) => {
  // CORS
  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }

  try {
    const { username } = await req.json();
    if (!username) {
      return new Response(JSON.stringify({ success: false, error: "缺少用户名" }), {
        status: 400,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }

    if (!PAYJS_MCHID || !PAYJS_KEY || !NOTIFY_URL) {
      return new Response(JSON.stringify({ success: false, error: "PAYJS 未配置" }), {
        status: 500,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }

    // 1. 从 admin_config 读取促销金额
    const amountResp = await fetch(
      `${SUPABASE_URL}/rest/v1/admin_config?key=eq.promo_amount&select=value`,
      {
        headers: { "apikey": SERVICE_KEY, "Authorization": `Bearer ${SERVICE_KEY}` },
      }
    );
    const amountData = await amountResp.json();
    let amount = 20; // 默认20元
    if (amountData && amountData.length > 0 && amountData[0].value) {
      amount = parseInt(amountData[0].value, 10) || 20;
    }
    const totalFee = amount * 100; // 转分

    // 2. 生成订单号 (用户名 + 时间戳)
    const outTradeNo = `${username}_${Date.now()}`;

    // 3. 调用 PAYJS native 接口创建订单
    const params: Record<string, string> = {
      mchid: PAYJS_MCHID,
      total_fee: String(totalFee),
      out_trade_no: outTradeNo,
      body: `背单词授权 - ${username}`,
      attach: username,
      notify_url: NOTIFY_URL,
    };
    params["sign"] = await sign(params, PAYJS_KEY);

    const payjsResp = await fetch("https://payjs.cn/api/native", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params).toString(),
    });
    const payjsResult = await payjsResp.json();

    if (payjsResult.return_code !== 1) {
      return new Response(JSON.stringify({ success: false, error: payjsResult.msg || "创建订单失败" }), {
        status: 500,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }

    // 4. 记录订单到数据库
    await callRpc("create_pay_order", {
      p_out_trade_no: outTradeNo,
      p_username: username,
      p_total_fee: totalFee,
      p_qrcode: payjsResult.qrcode,
    });

    return new Response(JSON.stringify({
      success: true,
      qrcode: payjsResult.qrcode,
      out_trade_no: outTradeNo,
      total_fee: totalFee,
      amount: amount,
    }), {
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ success: false, error: String(err) }), {
      status: 500,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  }
});
