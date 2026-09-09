-- ============================================
-- YunGouOS (云购支付) 集成 - 数据库脚本
-- 使用方法: 在 Supabase SQL Editor 中执行
-- 说明: 本脚本可重复执行 (幂等), 不会因重复运行而报错
-- ============================================

-- 1. 字段迁移: payjs_order_id -> order_no (仅当旧字段存在时执行)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'pay_orders' AND column_name = 'payjs_order_id'
  ) THEN
    ALTER TABLE pay_orders RENAME COLUMN payjs_order_id TO order_no;
  END IF;
END $$;

-- 2. 支付订单表 (如不存在则创建)
CREATE TABLE IF NOT EXISTS pay_orders (
  out_trade_no    TEXT PRIMARY KEY,                          -- 商户订单号 (用户名+时间戳)
  username        TEXT NOT NULL,                             -- 对应用户名
  total_fee       INTEGER NOT NULL,                          -- 金额(分)
  order_no        TEXT,                                      -- YunGouOS 系统订单号
  status          TEXT NOT NULL DEFAULT 'pending',           -- pending / paid / closed
  qrcode          TEXT,                                      -- 支付二维码URL
  attach          TEXT,                                      -- 附加数据
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at         TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_pay_orders_username ON pay_orders(username);
CREATE INDEX IF NOT EXISTS idx_pay_orders_status ON pay_orders(status);

-- 3. 支付回调专用授权函数 (无需管理员密码, 验证订单后自动开通)
--    注意: 旧版参数名为 p_payjs_order_id, PostgreSQL 不允许
--    CREATE OR REPLACE 更改参数名, 必须先 DROP 再 CREATE
DROP FUNCTION IF EXISTS pay_authorize_user(TEXT, TEXT);
CREATE FUNCTION pay_authorize_user(
  p_out_trade_no TEXT,
  p_order_no TEXT
) RETURNS JSON AS $$
DECLARE
  v_order       pay_orders%ROWTYPE;
  v_years       INT;
  v_amount      NUMERIC;
  v_expires     TIMESTAMPTZ;
BEGIN
  -- 3.1 查询订单
  SELECT * INTO v_order FROM pay_orders WHERE out_trade_no = p_out_trade_no;
  IF v_order IS NULL THEN
    RETURN json_build_object('success', false, 'error', '订单不存在');
  END IF;

  -- 3.2 已支付则直接返回成功 (幂等, 防止重复回调)
  IF v_order.status = 'paid' THEN
    RETURN json_build_object('success', true, 'message', '订单已处理');
  END IF;

  -- 3.3 校验金额 (从 admin_config 读取促销金额, 防止伪造)
  SELECT value::NUMERIC INTO v_amount FROM admin_config WHERE key = 'promo_amount';
  IF v_amount IS NULL THEN v_amount := 20; END IF;
  -- 金额以分为单位, 允许 ±1分浮动
  IF ABS(v_order.total_fee - (v_amount * 100)::INT) > 1 THEN
    RETURN json_build_object('success', false, 'error', '金额不匹配');
  END IF;

  -- 3.4 读取授权年限
  SELECT value::INT INTO v_years FROM admin_config WHERE key = 'promo_years';
  v_expires := CASE
    WHEN v_years IS NULL THEN NULL
    ELSE now() + make_interval(years => v_years)
  END;

  -- 3.5 记录捐赠 (复用 donations 表)
  INSERT INTO donations (username, amount, years, note, donated_at)
  VALUES (v_order.username, v_amount, v_years, 'YunGouOS在线支付', now());

  -- 3.6 更新授权 (已存在则续期)
  INSERT INTO authorizations (username, status, authorized_at, expires_at, note)
  VALUES (v_order.username, 'active', now(), v_expires, 'YunGouOS在线支付')
  ON CONFLICT (username) DO UPDATE SET
    status = 'active',
    authorized_at = now(),
    expires_at = v_expires,
    note = 'YunGouOS在线支付';

  -- 3.7 标记订单已支付
  UPDATE pay_orders SET
    status = 'paid',
    order_no = p_order_no,
    paid_at = now()
  WHERE out_trade_no = p_out_trade_no;

  RETURN json_build_object('success', true, 'expires_at', v_expires, 'amount', v_amount, 'years', v_years);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 4. 查询订单状态 (前端轮询用)
CREATE OR REPLACE FUNCTION get_pay_order_status(p_out_trade_no TEXT)
RETURNS JSON AS $$
DECLARE
  v_order pay_orders%ROWTYPE;
BEGIN
  SELECT * INTO v_order FROM pay_orders WHERE out_trade_no = p_out_trade_no;
  IF v_order IS NULL THEN
    RETURN json_build_object('success', false, 'error', '订单不存在');
  END IF;
  RETURN json_build_object(
    'success', true,
    'status', v_order.status,
    'paid_at', v_order.paid_at,
    'username', v_order.username
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 5. 记录支付订单 (Edge Function 创建订单时调用)
CREATE OR REPLACE FUNCTION create_pay_order(
  p_out_trade_no TEXT,
  p_username TEXT,
  p_total_fee INT,
  p_qrcode TEXT
) RETURNS JSON AS $$
BEGIN
  INSERT INTO pay_orders (out_trade_no, username, total_fee, qrcode)
  VALUES (p_out_trade_no, p_username, p_total_fee, p_qrcode)
  ON CONFLICT (out_trade_no) DO NOTHING;
  RETURN json_build_object('success', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 6. RLS: pay_orders 表只允许通过 RPC 访问
ALTER TABLE pay_orders ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON pay_orders FROM anon;

DO $$
BEGIN
  RAISE NOTICE 'YunGouOS 支付集成数据库脚本执行完成';
END $$;
