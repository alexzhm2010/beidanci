# PAYJS 支付集成 - Edge Functions 部署指南

## 1. 配置环境变量

在 Supabase Dashboard > Edge Functions > 选择函数 > Settings 中配置：

| 环境变量 | 说明 | 示例 |
|---|---|---|
| `PAYJS_MCHID` | PAYJS 商户号 | `123456789` |
| `PAYJS_KEY` | PAYJS 通信密钥 | `xxxxxxxxxxxxxxxx` |
| `PAYJS_NOTIFY_URL` | 回调地址（pay-notify 函数的 URL） | `https://xxxxx.supabase.co/functions/v1/pay-notify` |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service_role key | `eyJhbGc...` |

## 2. 执行数据库脚本

在 Supabase SQL Editor 中执行 `sql/setup_payjs.sql`，创建 `pay_orders` 表和相关 RPC 函数。

## 3. 部署 Edge Functions

```bash
# 安装 Supabase CLI
npm install -g supabase

# 登录
supabase login

# 部署两个函数
supabase functions deploy create-pay-order
supabase functions deploy pay-notify
```

部署后会得到函数 URL：
- `https://<project-ref>.supabase.co/functions/v1/create-pay-order`
- `https://<project-ref>.supabase.co/functions/v1/pay-notify`

## 4. 配置前端

在 `js/config.js` 的 `PAYJS` 配置项中填入 `create-pay-order` 的 URL。

## 5. 验证

1. 打开应用，使用试用账号登录
2. 试用到期后进入捐赠页面
3. 点击"在线支付"按钮，应显示 PAYJS 二维码
4. 扫码支付后，应自动开通授权并进入应用
