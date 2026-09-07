/**
 * PAYJS 支付回调 Edge Function
 * PAYJS 支付成功后 POST 到此函数 (application/x-www-form-urlencoded)
 * 处理: 验签 -> 校验订单 -> 自动授权用户 -> 返回 "success"
 *
 * 环境变量:
 *   PAYJS_KEY    - PAYJS 通信密钥 (验签用)
 *   SUPABASE_SERVICE_ROLE_KEY - Supabase service_role key
 */

import { crypto } from "https://deno.land/std@0.208.0/crypto/mod.ts";
import { encodeHex } from "https://deno.land/std@0.208.0/encoding/hex.ts";

async function md5(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("MD5", data);
  return encodeHex(new Uint8Array(hash));
}

// PAYJS 验签: 除去 sign 字段, 其余按 key 排序拼接 key=value&...&key=商户密钥, MD5
function verifySign(params: Record<string, string>, key: string): boolean {
  const sign = params["sign"];
  if (!sign) return false;
  const sortedKeys = Object.keys(params).filter(k => k !== "sign" && params[k] !== undefined && params[k] !== "").sort();
  const str = sortedKeys.map(k => `${k}=${params[k]}`).join("&") + "&key=" + key;
  return md5(str).then(s => s.toLowerCase() === sign.toLowerCase());
}

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const PAYJS_KEY = Deno.env.get("PAYJS_KEY") || "";

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
  try {
    // 解析表单数据
    const formData = await req.formData();
    const params: Record<string, string> = {};
    formData.forEach((value, key) => { params[key] = String(value); });

    // 1. 验签
    if (!PAYJS_KEY) {
      console.error("[pay-notify] PAYJS_KEY 未配置");
      return new Response("fail", { status: 500 });
    }

    const signOk = await verifySign(params, PAYJS_KEY);
    if (!signOk) {
      console.error("[pay-notify] 验签失败", params);
      return new Response("fail", { status: 400 });
    }

    // 2. 校验支付成功
    if (params.return_code !== "1") {
      console.error("[pay-notify] 支付未成功", params.return_code);
      return new Response("fail", { status: 400 });
    }

    const outTradeNo = params.out_trade_no;
    const payjsOrderId = params.payjs_order_id;

    if (!outTradeNo) {
      console.error("[pay-notify] 缺少订单号");
      return new Response("fail", { status: 400 });
    }

    // 3. 调用支付授权 RPC (内部校验订单、金额、自动开通授权)
    const result = await callRpc("pay_authorize_user", {
      p_out_trade_no: outTradeNo,
      p_payjs_order_id: payjsOrderId,
    });

    if (result && result.success) {
      console.log("[pay-notify] 授权成功", outTradeNo, result);
      // PAYJS 要求返回 "success" (HTTP 200)
      return new Response("success", { status: 200 });
    } else {
      console.error("[pay-notify] 授权失败", outTradeNo, result);
      return new Response("fail", { status: 500 });
    }
  } catch (err) {
    console.error("[pay-notify] 异常", err);
    return new Response("fail", { status: 500 });
  }
});
