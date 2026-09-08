/**
 * YunGouOS (云购支付) 支付回调 Edge Function
 * YunGouOS 支付成功后 POST 到此函数
 * 处理: 验签 -> 校验订单 -> 自动授权用户 -> 返回 "SUCCESS"
 *
 * 环境变量:
 *   YUNGOU_KEY  - YunGouOS 支付密钥 (验签用)
 *   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY - 默认提供
 */

import { crypto } from "https://deno.land/std@0.208.0/crypto/mod.ts";
import { encodeHex } from "https://deno.land/std@0.208.0/encoding/hex.ts";

async function md5(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("MD5", data);
  return encodeHex(new Uint8Array(hash));
}

/**
 * YunGouOS 回调验签:
 * 仅参与签名的字段: code, orderNo, outTradeNo, payNo, money, mchId
 * 算法: 按字典序排序 -> key=value&... -> 追加 &key=支付密钥 -> MD5 大写
 */
async function verifySign(params: Record<string, string>, key: string): Promise<boolean> {
  const signValue = params["sign"];
  if (!signValue) return false;

  // 仅参与签名的字段 (来自 YunGouOS 回调文档)
  const signFields = ["code", "orderNo", "outTradeNo", "payNo", "money", "mchId"];
  const signParams: Record<string, string> = {};
  for (const field of signFields) {
    if (params[field] !== undefined && params[field] !== "") {
      signParams[field] = params[field];
    }
  }

  const sortedKeys = Object.keys(signParams).sort();
  const str = sortedKeys.map(k => `${k}=${signParams[k]}`).join("&") + "&key=" + key;
  const computed = (await md5(str)).toUpperCase();
  return computed === signValue.toUpperCase();
}

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const YUNGOU_KEY = Deno.env.get("YUNGOU_KEY") || "";

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
    // 解析回调数据 (YunGouOS 可能发送 JSON 或表单数据)
    let params: Record<string, string> = {};
    const contentType = req.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      const json = await req.json();
      Object.keys(json).forEach(k => { params[k] = String(json[k]); });
    } else {
      const formData = await req.formData();
      formData.forEach((value, key) => { params[key] = String(value); });
    }

    // 1. 验签
    if (!YUNGOU_KEY) {
      console.error("[pay-notify] YUNGOU_KEY 未配置");
      return new Response("FAIL", { status: 500 });
    }

    const signOk = await verifySign(params, YUNGOU_KEY);
    if (!signOk) {
      console.error("[pay-notify] 验签失败", params);
      return new Response("FAIL", { status: 400 });
    }

    // 2. 校验支付成功 (YunGouOS 回调: code=1 成功, code=0 失败)
    if (params.code !== "1") {
      console.error("[pay-notify] 支付未成功", params.code);
      return new Response("FAIL", { status: 400 });
    }

    const outTradeNo = params.outTradeNo;
    const orderNo = params.orderNo;

    if (!outTradeNo) {
      console.error("[pay-notify] 缺少订单号");
      return new Response("FAIL", { status: 400 });
    }

    // 3. 调用支付授权 RPC (内部校验订单、金额、自动开通授权)
    const result = await callRpc("pay_authorize_user", {
      p_out_trade_no: outTradeNo,
      p_order_no: orderNo,
    });

    if (result && result.success) {
      console.log("[pay-notify] 授权成功", outTradeNo, result);
      // YunGouOS 要求返回大写 "SUCCESS"
      return new Response("SUCCESS", { status: 200 });
    } else {
      console.error("[pay-notify] 授权失败", outTradeNo, result);
      return new Response("FAIL", { status: 500 });
    }
  } catch (err) {
    console.error("[pay-notify] 异常", err);
    return new Response("FAIL", { status: 500 });
  }
});
