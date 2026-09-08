/**
 * YunGouOS (云购支付) 创建支付订单 Edge Function
 * 前端调用: POST { username: string }
 * 返回: { success, qrcode, out_trade_no, total_fee }
 *
 * 环境变量 (在 Supabase Dashboard > Edge Functions > Secrets 中配置):
 *   YUNGOU_MCH_ID  - YunGouOS 微信支付商户号
 *   YUNGOU_KEY     - YunGouOS 支付密钥 (payKey)
 *   YUNGOU_NOTIFY_URL - 回调地址
 *   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY - 默认提供, 无需配置
 */

import { crypto } from "https://deno.land/std@0.208.0/crypto/mod.ts";
import { encodeHex } from "https://deno.land/std@0.208.0/encoding/hex.ts";

async function md5(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("MD5", data);
  return encodeHex(new Uint8Array(hash));
}

/**
 * YunGouOS 签名算法 (与微信官方一致):
 * 1. 非空参数按 key 字典序排序
 * 2. 拼接 key1=value1&key2=value2
 * 3. 末尾追加 &key=支付密钥
 * 4. MD5 后转大写
 */
async function sign(params: Record<string, string>, key: string): Promise<string> {
  const sortedKeys = Object.keys(params)
    .filter(k => k !== "sign" && params[k] !== undefined && params[k] !== "")
    .sort();
  const str = sortedKeys.map(k => `${k}=${params[k]}`).join("&") + "&key=" + key;
  return (await md5(str)).toUpperCase();
}

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const YUNGOU_MCH_ID = Deno.env.get("YUNGOU_MCH_ID") || "";
const YUNGOU_KEY = Deno.env.get("YUNGOU_KEY") || "";
const NOTIFY_URL = Deno.env.get("YUNGOU_NOTIFY_URL") || "";

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

    if (!YUNGOU_MCH_ID || !YUNGOU_KEY || !NOTIFY_URL) {
      return new Response(JSON.stringify({ success: false, error: "YunGouOS 未配置" }), {
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
    let amount = 20;
    if (amountData && amountData.length > 0 && amountData[0].value) {
      amount = parseInt(amountData[0].value, 10) || 20;
    }
    const totalFeeFen = amount * 100; // 数据库存分
    const totalFeeYuan = String(amount); // YunGouOS 接口用元

    // 2. 生成订单号
    const outTradeNo = `${username}_${Date.now()}`;

    // 3. 调用 YunGouOS native 扫码支付接口
    //    仅必传参数参与签名: out_trade_no, total_fee, mch_id, body
    const signParams: Record<string, string> = {
      out_trade_no: outTradeNo,
      total_fee: totalFeeYuan,
      mch_id: YUNGOU_MCH_ID,
      body: `背单词授权 - ${username}`,
    };
    const signValue = await sign(signParams, YUNGOU_KEY);

    // 组装完整请求参数 (可选参数不参与签名, 但随请求发送)
    const requestParams: Record<string, string> = {
      ...signParams,
      type: "2",              // 2=直接返回二维码地址
      attach: username,
      notify_url: NOTIFY_URL,
      sign: signValue,
    };

    const yungouResp = await fetch("https://api.pay.yungouos.com/api/pay/wxpay/nativePay", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(requestParams).toString(),
    });
    const yungouResult = await yungouResp.json();

    // YunGouOS: code=0 成功, data=二维码地址
    if (yungouResult.code !== 0) {
      return new Response(JSON.stringify({ success: false, error: yungouResult.msg || "创建订单失败" }), {
        status: 500,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }

    const qrcode = yungouResult.data;

    // 4. 记录订单到数据库
    await callRpc("create_pay_order", {
      p_out_trade_no: outTradeNo,
      p_username: username,
      p_total_fee: totalFeeFen,
      p_qrcode: qrcode,
    });

    return new Response(JSON.stringify({
      success: true,
      qrcode: qrcode,
      out_trade_no: outTradeNo,
      total_fee: totalFeeFen,
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
