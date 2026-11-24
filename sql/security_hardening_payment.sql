-- ============================================================
-- 安全加固: 支付 RPC 越权 + 用户ID改绑越权 (v1.28.5 审查发现)
-- 执行方式: Supabase Dashboard → SQL Editor 运行; 可重复执行(幂等)
-- 前端不自动执行本脚本; 需人工审阅后在对应环境运行
-- ============================================================
--
-- 【背景与影响面核实】(2026-11-24)
-- 正常支付链路: 前端 → create-pay-order Edge Function → (service_role) create_pay_order RPC
--               支付网关回调 → pay-notify Edge Function → (service_role) pay_authorize_user RPC
-- 前端只调用 get_pay_order_status 轮询, 从不直接调用 create_pay_order / pay_authorize_user。
-- 两个 Edge Function 均使用 SUPABASE_SERVICE_ROLE_KEY, service_role 不受 EXECUTE REVOKE 影响。
-- 因此下面收回 anon/authenticated 的 EXECUTE 不会破坏正常支付。
--
-- 【漏洞】
-- 1) setup_yungou.sql / setup_payjs.sql 中 create_pay_order、pay_authorize_user 为
--    SECURITY DEFINER, PostgREST 默认对 PUBLIC 授予 EXECUTE。攻击者可:
--      create_pay_order(自填订单号, 自己用户名, 促销金额, 任意qrcode)
--      → pay_authorize_user(订单号, 任意order_no) → 金额校验通过 → 白嫖授权。
-- 2) migrate_to_supabase_auth.sql 的 link_user_id(p_username, p_user_id) 为
--    SECURITY DEFINER 且无调用者校验, 可将任意用户(含管理员)的 user_id 改绑给自己,
--    配合 RLS 读取他人数据。
-- ============================================================

-- ---------- 1. 收回支付/授权 RPC 的 PUBLIC 执行权, 仅留 service_role ----------
-- 先显式撤销 (REVOKE ... FROM PUBLIC 覆盖 anon/authenticated 的默认继承)
REVOKE ALL ON FUNCTION public.create_pay_order(TEXT, TEXT, INT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_pay_order(TEXT, TEXT, INT, TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.create_pay_order(TEXT, TEXT, INT, TEXT) FROM authenticated;

REVOKE ALL ON FUNCTION public.pay_authorize_user(TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pay_authorize_user(TEXT, TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.pay_authorize_user(TEXT, TEXT) FROM authenticated;

-- get_pay_order_status 前端轮询需要, 保留 anon/authenticated EXECUTE;
-- 但补 search_path 加固 (新建同名函数会覆盖, 见第 2 节)
-- 注: 若订单号可预测存在信息泄露, 属低危; 真正确认支付以 pay_authorize_user 为准。

-- ---------- 2. SECURITY DEFINER 函数统一 search_path (防 search_path 劫持) ----------
-- 重建函数以追加 SET search_path = public (CREATE OR REPLACE 不改返回类型即可直接替换)

-- 2.1 create_pay_order
CREATE OR REPLACE FUNCTION public.create_pay_order(
  p_out_trade_no TEXT, p_username TEXT, p_total_fee INT, p_qrcode TEXT
) RETURNS JSON AS $$
BEGIN
  INSERT INTO public.pay_orders (out_trade_no, username, total_fee, qrcode)
  VALUES (p_out_trade_no, p_username, p_total_fee, p_qrcode)
  ON CONFLICT (out_trade_no) DO NOTHING;
  RETURN json_build_object('success', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- 2.2 pay_authorize_user (逻辑与 setup_yungou.sql 完全一致, 仅加 search_path)
CREATE OR REPLACE FUNCTION public.pay_authorize_user(
  p_out_trade_no TEXT, p_order_no TEXT
) RETURNS JSON AS $$
DECLARE
  v_order       public.pay_orders%ROWTYPE;
  v_years       INT;
  v_amount      NUMERIC;
  v_expires     TIMESTAMPTZ;
BEGIN
  SELECT * INTO v_order FROM public.pay_orders WHERE out_trade_no = p_out_trade_no;
  IF v_order IS NULL THEN
    RETURN json_build_object('success', false, 'error', '订单不存在');
  END IF;
  IF v_order.status = 'paid' THEN
    RETURN json_build_object('success', true, 'message', '订单已处理');
  END IF;
  SELECT value::NUMERIC INTO v_amount FROM public.admin_config WHERE key = 'promo_amount';
  IF v_amount IS NULL THEN v_amount := 20; END IF;
  IF ABS(v_order.total_fee - (v_amount * 100)::INT) > 1 THEN
    RETURN json_build_object('success', false, 'error', '金额不匹配');
  END IF;
  SELECT value::INT INTO v_years FROM public.admin_config WHERE key = 'promo_years';
  v_expires := CASE WHEN v_years IS NULL THEN NULL ELSE now() + make_interval(years => v_years) END;
  INSERT INTO public.donations (username, amount, years, note, donated_at)
  VALUES (v_order.username, v_amount, v_years, 'YunGouOS在线支付', now());
  INSERT INTO public.authorizations (username, status, authorized_at, expires_at, note)
  VALUES (v_order.username, 'active', now(), v_expires, 'YunGouOS在线支付')
  ON CONFLICT (username) DO UPDATE SET
    status = 'active', authorized_at = now(), expires_at = v_expires, note = 'YunGouOS在线支付';
  UPDATE public.pay_orders SET status = 'paid', order_no = p_order_no, paid_at = now()
  WHERE out_trade_no = p_out_trade_no;
  RETURN json_build_object('success', true, 'expires_at', v_expires, 'amount', v_amount, 'years', v_years);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- 2.3 get_pay_order_status (加 search_path, 保持前端可调用)
CREATE OR REPLACE FUNCTION public.get_pay_order_status(p_out_trade_no TEXT)
RETURNS JSON AS $$
DECLARE
  v_order public.pay_orders%ROWTYPE;
BEGIN
  SELECT * INTO v_order FROM public.pay_orders WHERE out_trade_no = p_out_trade_no;
  IF v_order IS NULL THEN
    RETURN json_build_object('success', false, 'error', '订单不存在');
  END IF;
  RETURN json_build_object(
    'success', true, 'status', v_order.status, 'paid_at', v_order.paid_at, 'username', v_order.username
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- 注意: CREATE OR REPLACE 会重新应用默认权限 (PUBLIC EXECUTE)。
-- 因此 2.1/2.2 重建后必须再次 REVOKE, 顺序不能颠倒。
REVOKE ALL ON FUNCTION public.create_pay_order(TEXT, TEXT, INT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.pay_authorize_user(TEXT, TEXT) FROM PUBLIC, anon, authenticated;

-- ---------- 3. link_user_id 越权修复 ----------
-- 该函数由 migrate-user Edge Function (service_role) 调用, 前端不应直接调用。
-- 3.1 收回 PUBLIC 执行权
REVOKE ALL ON FUNCTION public.link_user_id(TEXT, UUID) FROM PUBLIC, anon, authenticated;
-- 3.2 加 search_path + 调用者归属校验:
--     仅 service_role 可绕过 auth.uid() 校验; anon/authenticated 即便有 EXECUTE 也只能改自己
CREATE OR REPLACE FUNCTION public.link_user_id(p_username TEXT, p_user_id UUID)
RETURNS JSON AS $$
DECLARE
  v_caller UUID;
BEGIN
  v_caller := auth.uid();
  -- service_role 调用时 auth.uid() 为 NULL, 放行(由服务端 Edge Function 保证合法性)
  IF p_user_id IS NULL THEN
    RETURN json_build_object('success', false, 'error', 'invalid_user_id');
  END IF;
  IF v_caller IS NOT NULL AND v_caller <> p_user_id THEN
    RETURN json_build_object('success', false, 'error', 'forbidden');
  END IF;
  UPDATE public.user_auth SET user_id = p_user_id WHERE username = p_username;
  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'error', 'user_not_found');
  END IF;
  RETURN json_build_object('success', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION public.link_user_id(TEXT, UUID) FROM PUBLIC, anon, authenticated;

-- ============================================================
-- 验证 (执行后人工核对)
-- 1) 匿名调用应失败:
--    SELECT public.create_pay_order('hack_'||now()::text, 'victim', 2000, '');
--    预期: permission denied for function create_pay_order
-- 2) 正常支付回归: 走一遍前端下单 → 支付回调 → 授权开通流程, 确认成功
-- 3) 迁移回归: 用一个老用户登录触发 migrate-user, 确认 user_id 回填成功
-- ============================================================
DO $$
BEGIN
  RAISE NOTICE '支付/改绑 RPC 安全加固完成; 请按注释验证支付与迁移回归';
END $$;
