# YunGouOS (云购支付) 集成 - Edge Functions 部署指南

## 1. 执行数据库脚本

在 Supabase SQL Editor 中执行 `sql/setup_yungou.sql`。

> 如果之前已执行过 `setup_payjs.sql`, 此脚本会自动迁移字段名 (`payjs_order_id` → `order_no`)。

## 2. 配置环境变量 (Secrets)

在 Supabase Dashboard > **Edge Functions** > **Secrets** 中添加：

| Secret Name | 说明 | 示例 |
|---|---|---|
| `YUNGOU_MCH_ID` | YunGouOS 微信支付商户号 | `123456789` |
| `YUNGOU_KEY` | YunGouOS 支付密钥 (payKey) | `xxxxxxxxxxxxxxxx` |
| `YUNGOU_NOTIFY_URL` | 回调地址 (pay-notify 函数 URL) | `https://gjtjivmxxelnousbqmok.supabase.co/functions/v1/pay-notify` |

> `SUPABASE_URL` 和 `SUPABASE_SERVICE_ROLE_KEY` 由 Supabase 默认提供, 无需配置。

## 3. 部署 Edge Functions

```bash
# 安装并登录 Supabase CLI
npm install -g supabase
supabase login

# 部署两个函数
supabase functions deploy create-pay-order
supabase functions deploy pay-notify
```

## 4. 配置前端

`js/config.js` 的 `YUNGOU.CREATE_ORDER_URL` 已填入:
```
https://gjtjivmxxelnousbqmok.supabase.co/functions/v1/create-pay-order
```

## 5. 验证

1. 打开应用，使用试用账号登录
2. 试用到期后进入捐赠页面
3. 点击"在线支付 (微信)"按钮，应显示支付二维码
4. 扫码支付后，应自动开通授权并进入应用

## YunGouOS 与 PAYJS 的主要差异

| 对比项 | PAYJS | YunGouOS |
|---|---|---|
| 金额单位 | 分 | 元 |
| 成功状态码 | `return_code=1` | `code=0` (下单) / `code=1` (回调) |
| 二维码字段 | `qrcode` | `data` |
| 回调返回值 | `success` (小写) | `SUCCESS` (大写) |
| 签名大小写 | MD5 小写 | MD5 **大写** |
| 回调字段命名 | snake_case | camelCase |
| 回调验签字段 | 所有非空字段 | 仅 `code`/`orderNo`/`outTradeNo`/`payNo`/`money`/`mchId` |
