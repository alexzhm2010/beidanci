-- ============================================================
-- 背单词 v1.6.0 一键修复脚本：认证RPC函数 + 授权系统
-- 顺序: 建表(IF NOT EXISTS) → 补 admin_config 正确值 → 所有 RPC 函数 → RLS 收紧
-- 幂等: 可重复执行, 不会报错
-- 执行位置: Supabase Dashboard → SQL Editor → 新建查询 → 全选粘贴 → Run
-- ============================================================
SET client_min_messages = NOTICE;

-- ============================================================
-- 1. 建表（如果不存在）
-- ============================================================

-- 用户认证表 (用户名+密码+密保)
CREATE TABLE IF NOT EXISTS user_auth (
  username        TEXT PRIMARY KEY,
  password_hash   TEXT NOT NULL,
  sec_question    TEXT NOT NULL,
  sec_answer_hash TEXT NOT NULL,
  created_at      TIMESTAMPTZ DEFAULT now()
);

-- 授权表 (当前授权状态)
CREATE TABLE IF NOT EXISTS authorizations (
  username       TEXT PRIMARY KEY,
  status         TEXT DEFAULT 'active',
  authorized_at  TIMESTAMPTZ DEFAULT now(),
  expires_at     TIMESTAMPTZ,
  note           TEXT
);

-- 捐赠记录表 (历史记录, 用于营业额统计)
CREATE TABLE IF NOT EXISTS donations (
  id          SERIAL PRIMARY KEY,
  username    TEXT NOT NULL,
  amount      NUMERIC NOT NULL,
  years       INT,
  note        TEXT,
  donated_at  TIMESTAMPTZ DEFAULT now()
);

-- 管理员配置表
CREATE TABLE IF NOT EXISTS admin_config (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- 管理员留言表
CREATE TABLE IF NOT EXISTS admin_messages (
  id          SERIAL PRIMARY KEY,
  title       TEXT NOT NULL,
  content     TEXT NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT now(),
  status      TEXT DEFAULT 'active'
);

-- 用户已读留言记录
CREATE TABLE IF NOT EXISTS user_read_messages (
  username    TEXT,
  message_id  INT,
  read_at     TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (username, message_id)
);

-- ============================================================
-- 2. 初始配置数据（修正占位符 REDACTED_ 为真实值）
-- ============================================================

-- 管理员用户名必须是 'beidanci_admin' (前端 auth.js 里的 AUTH.ADMIN_CODE)
INSERT INTO admin_config (key, value) VALUES
  ('admin_username', 'beidanci_admin'),
  ('promo_amount', '20'),
  ('promo_years', '1'),
  ('promo_text', '捐赠20元得1年使用权')
ON CONFLICT (key) DO UPDATE SET
  value = CASE
    WHEN admin_config.key = 'admin_username' AND EXCLUDED.value IN ('REDACTED_ADMIN_USERNAME','','<...>')
      THEN 'beidanci_admin'
    ELSE EXCLUDED.value
  END;

-- 如果 admin_username 被误存成占位符, 强制修回
UPDATE admin_config SET value = 'beidanci_admin'
WHERE key = 'admin_username' AND value IN ('REDACTED_ADMIN_USERNAME','','<...>');

-- ============================================================
-- 3. RPC 函数：认证操作 (全部幂等, CREATE OR REPLACE)
-- ============================================================

-- 3.1 注册用户
CREATE OR REPLACE FUNCTION register_user(
  p_username TEXT,
  p_pwd_hash TEXT,
  p_sec_question TEXT,
  p_sec_answer_hash TEXT
) RETURNS JSON AS $$
DECLARE
  exists_count INT;
BEGIN
  SELECT COUNT(*) INTO exists_count FROM user_auth WHERE username = p_username;
  IF exists_count > 0 THEN
    RETURN json_build_object('success', false, 'error', 'exists');
  END IF;
  INSERT INTO user_auth (username, password_hash, sec_question, sec_answer_hash)
    VALUES (p_username, p_pwd_hash, p_sec_question, p_sec_answer_hash);
  RETURN json_build_object('success', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 3.2 验证登录 (只返回 true/false, 不返回哈希)
CREATE OR REPLACE FUNCTION verify_login(
  p_username TEXT,
  p_pwd_hash TEXT
) RETURNS JSON AS $$
DECLARE
  stored_hash TEXT;
BEGIN
  SELECT password_hash INTO stored_hash FROM user_auth WHERE username = p_username;
  IF stored_hash IS NULL THEN
    RETURN json_build_object('success', false, 'error', 'user_not_found');
  END IF;
  IF stored_hash = p_pwd_hash THEN
    RETURN json_build_object('success', true);
  ELSE
    RETURN json_build_object('success', false, 'error', 'wrong_password');
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 3.3 检查用户名是否存在
CREATE OR REPLACE FUNCTION username_exists(p_username TEXT) RETURNS BOOLEAN AS $$
BEGIN
  RETURN EXISTS(SELECT 1 FROM user_auth WHERE username = p_username);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 3.4 获取密保问题
CREATE OR REPLACE FUNCTION get_sec_question(p_username TEXT) RETURNS JSON AS $$
DECLARE
  q TEXT;
  created_ts TIMESTAMPTZ;
BEGIN
  SELECT sec_question, created_at INTO q, created_ts
    FROM user_auth WHERE username = p_username;
  IF q IS NULL THEN
    RETURN json_build_object('success', false);
  END IF;
  RETURN json_build_object('success', true, 'question', q, 'created_at', created_ts);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 3.5 验证密保答案
CREATE OR REPLACE FUNCTION verify_sec_answer(
  p_username TEXT,
  p_sec_answer_hash TEXT
) RETURNS BOOLEAN AS $$
DECLARE
  stored_hash TEXT;
BEGIN
  SELECT sec_answer_hash INTO stored_hash FROM user_auth WHERE username = p_username;
  RETURN stored_hash IS NOT NULL AND stored_hash = p_sec_answer_hash;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 3.6 重置密码 (需验证密保答案)
CREATE OR REPLACE FUNCTION reset_password(
  p_username TEXT,
  p_new_pwd_hash TEXT,
  p_sec_answer_hash TEXT
) RETURNS JSON AS $$
DECLARE
  stored_hash TEXT;
BEGIN
  SELECT sec_answer_hash INTO stored_hash FROM user_auth WHERE username = p_username;
  IF stored_hash IS NULL THEN
    RETURN json_build_object('success', false, 'error', 'user_not_found');
  END IF;
  IF stored_hash != p_sec_answer_hash THEN
    RETURN json_build_object('success', false, 'error', 'invalid_answer');
  END IF;
  UPDATE user_auth SET password_hash = p_new_pwd_hash WHERE username = p_username;
  RETURN json_build_object('success', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 3.7 获取用户信息 (Profile 页面展示用)
CREATE OR REPLACE FUNCTION get_user_auth_info(p_username TEXT) RETURNS JSON AS $$
DECLARE
  q TEXT;
  created_ts TIMESTAMPTZ;
BEGIN
  SELECT sec_question, created_at INTO q, created_ts
    FROM user_auth WHERE username = p_username;
  IF q IS NULL THEN RETURN NULL; END IF;
  RETURN json_build_object(
    'username', p_username,
    'sec_question', q,
    'created_at', created_ts
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 3.8 修改密码 (需验证原密码)
CREATE OR REPLACE FUNCTION change_password(
  p_username TEXT,
  p_old_pwd_hash TEXT,
  p_new_pwd_hash TEXT
) RETURNS JSON AS $$
DECLARE
  stored_hash TEXT;
BEGIN
  SELECT password_hash INTO stored_hash FROM user_auth WHERE username = p_username;
  IF stored_hash IS NULL THEN
    RETURN json_build_object('success', false, 'error', 'user_not_found');
  END IF;
  IF stored_hash != p_old_pwd_hash THEN
    RETURN json_build_object('success', false, 'error', 'wrong_password');
  END IF;
  UPDATE user_auth SET password_hash = p_new_pwd_hash WHERE username = p_username;
  RETURN json_build_object('success', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 3.9 修改密保问题 (需验证密码)
CREATE OR REPLACE FUNCTION change_sec_question(
  p_username TEXT,
  p_pwd_hash TEXT,
  p_sec_question TEXT,
  p_sec_answer_hash TEXT
) RETURNS JSON AS $$
DECLARE
  stored_hash TEXT;
BEGIN
  SELECT password_hash INTO stored_hash FROM user_auth WHERE username = p_username;
  IF stored_hash IS NULL THEN
    RETURN json_build_object('success', false, 'error', 'user_not_found');
  END IF;
  IF stored_hash != p_pwd_hash THEN
    RETURN json_build_object('success', false, 'error', 'wrong_password');
  END IF;
  UPDATE user_auth
    SET sec_question = p_sec_question, sec_answer_hash = p_sec_answer_hash
    WHERE username = p_username;
  RETURN json_build_object('success', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 3.10 获取用户授权状态
CREATE OR REPLACE FUNCTION get_user_authorization(p_username TEXT) RETURNS JSON AS $$
DECLARE
  r RECORD;
BEGIN
  SELECT * INTO r FROM authorizations WHERE username = p_username LIMIT 1;
  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN json_build_object(
    'username', r.username,
    'status', r.status,
    'authorized_at', r.authorized_at,
    'expires_at', r.expires_at,
    'note', r.note
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 3.11 管理员授权用户 (自动读取当前促销配置)
CREATE OR REPLACE FUNCTION admin_authorize(
  p_admin_pwd_hash TEXT,
  p_username TEXT,
  p_note TEXT
) RETURNS JSON AS $$
DECLARE
  v_admin_name TEXT;
  v_stored_hash TEXT;
  v_years INT;
  v_amount NUMERIC;
  v_expires TIMESTAMPTZ;
BEGIN
  SELECT value INTO v_admin_name FROM admin_config WHERE key = 'admin_username';
  SELECT password_hash INTO v_stored_hash FROM user_auth WHERE username = v_admin_name;

  IF v_stored_hash IS NULL OR p_admin_pwd_hash IS DISTINCT FROM v_stored_hash THEN
    RETURN json_build_object('success', false, 'error', '管理员验证失败');
  END IF;

  SELECT value::INT INTO v_years FROM admin_config WHERE key = 'promo_years';
  SELECT value::NUMERIC INTO v_amount FROM admin_config WHERE key = 'promo_amount';

  v_expires := CASE
    WHEN v_years IS NULL THEN NULL
    ELSE now() + make_interval(years => v_years)
  END;

  INSERT INTO donations (username, amount, years, note, donated_at)
  VALUES (p_username, v_amount, v_years, p_note, now());

  INSERT INTO authorizations (username, status, authorized_at, expires_at, note)
  VALUES (p_username, 'active', now(), v_expires, p_note)
  ON CONFLICT (username) DO UPDATE SET
    status = 'active',
    authorized_at = now(),
    expires_at = v_expires,
    note = p_note;

  RETURN json_build_object('success', true, 'expires_at', v_expires, 'amount', v_amount, 'years', v_years);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 3.12 管理员吊销用户
CREATE OR REPLACE FUNCTION admin_revoke(
  p_admin_pwd_hash TEXT,
  p_username TEXT
) RETURNS JSON AS $$
DECLARE
  v_admin_name TEXT;
  v_stored_hash TEXT;
BEGIN
  SELECT value INTO v_admin_name FROM admin_config WHERE key = 'admin_username';
  SELECT password_hash INTO v_stored_hash FROM user_auth WHERE username = v_admin_name;
  IF v_stored_hash IS NULL OR p_admin_pwd_hash IS DISTINCT FROM v_stored_hash THEN
    RETURN json_build_object('success', false, 'error', '管理员验证失败');
  END IF;
  UPDATE authorizations SET status = 'revoked' WHERE username = p_username;
  RETURN json_build_object('success', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 3.13 管理员查看用户列表 (含授权+捐赠汇总)
CREATE OR REPLACE FUNCTION admin_list_users(
  p_admin_pwd_hash TEXT,
  p_offset INT DEFAULT 0,
  p_limit INT DEFAULT 50
) RETURNS JSON AS $$
DECLARE
  v_admin_name TEXT;
  v_stored_hash TEXT;
BEGIN
  SELECT value INTO v_admin_name FROM admin_config WHERE key = 'admin_username';
  SELECT password_hash INTO v_stored_hash FROM user_auth WHERE username = v_admin_name;
  IF v_stored_hash IS NULL OR p_admin_pwd_hash IS DISTINCT FROM v_stored_hash THEN
    RETURN json_build_object('success', false, 'error', '管理员验证失败');
  END IF;
  RETURN json_build_object(
    'success', true,
    'users', COALESCE((
      SELECT json_agg(t) FROM (
        SELECT
          u.username,
          u.created_at,
          COALESCE(a.status, 'none') AS auth_status,
          a.authorized_at,
          a.expires_at,
          a.note,
          COALESCE(SUM(d.amount), 0) AS total_donated,
          COUNT(d.id) AS donation_count
        FROM user_auth u
        LEFT JOIN authorizations a ON u.username = a.username
        LEFT JOIN donations d ON u.username = d.username
        WHERE u.username != v_admin_name
        GROUP BY u.username, u.created_at, a.status, a.authorized_at, a.expires_at, a.note
        ORDER BY u.created_at DESC
        OFFSET p_offset LIMIT p_limit
      ) t
    ), '[]'::json)
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 3.14 管理员统计看板数据
CREATE OR REPLACE FUNCTION admin_dashboard(
  p_admin_pwd_hash TEXT
) RETURNS JSON AS $$
DECLARE
  v_admin_name TEXT;
  v_stored_hash TEXT;
  v_month_start TIMESTAMPTZ;
  v_quarter_start TIMESTAMPTZ;
  v_year_start TIMESTAMPTZ;
BEGIN
  SELECT value INTO v_admin_name FROM admin_config WHERE key = 'admin_username';
  SELECT password_hash INTO v_stored_hash FROM user_auth WHERE username = v_admin_name;
  IF v_stored_hash IS NULL OR p_admin_pwd_hash IS DISTINCT FROM v_stored_hash THEN
    RETURN json_build_object('success', false, 'error', '管理员验证失败');
  END IF;
  v_month_start := date_trunc('month', now());
  v_quarter_start := date_trunc('quarter', now());
  v_year_start := date_trunc('year', now());
  RETURN json_build_object(
    'success', true,
    'revenue', json_build_object(
      'month', COALESCE((SELECT SUM(amount) FROM donations WHERE donated_at >= v_month_start), 0),
      'quarter', COALESCE((SELECT SUM(amount) FROM donations WHERE donated_at >= v_quarter_start), 0),
      'year', COALESCE((SELECT SUM(amount) FROM donations WHERE donated_at >= v_year_start), 0),
      'total', COALESCE((SELECT SUM(amount) FROM donations), 0)
    ),
    'users', json_build_object(
      'total', (SELECT COUNT(*) FROM user_auth WHERE username != v_admin_name),
      'authorized', (SELECT COUNT(*) FROM authorizations WHERE status = 'active' AND (expires_at IS NULL OR expires_at > now())),
      'trial', (SELECT COUNT(*) FROM user_auth u WHERE u.username != v_admin_name AND u.created_at > now() - interval '7 days' AND NOT EXISTS (SELECT 1 FROM authorizations a WHERE a.username = u.username)),
      'expired', (SELECT COUNT(*) FROM authorizations WHERE expires_at < now() AND status = 'active'),
      'revoked', (SELECT COUNT(*) FROM authorizations WHERE status = 'revoked'),
      'new_this_month', (SELECT COUNT(*) FROM user_auth WHERE username != v_admin_name AND created_at >= v_month_start)
    ),
    'expiry', json_build_object(
      'this_month', (SELECT COUNT(*) FROM authorizations WHERE expires_at >= v_month_start AND expires_at < v_month_start + interval '1 month' AND status = 'active'),
      'next_month', (SELECT COUNT(*) FROM authorizations WHERE expires_at >= v_month_start + interval '1 month' AND expires_at < v_month_start + interval '2 months' AND status = 'active'),
      'expired_not_renewed', (SELECT COUNT(*) FROM authorizations WHERE expires_at < now() AND status = 'active')
    ),
    'monthly_donations', COALESCE((
      SELECT json_agg(t) FROM (
        SELECT
          to_char(date_trunc('month', d.donated_at), 'YYYY-MM') AS month,
          SUM(d.amount) AS amount,
          COUNT(*) AS count
        FROM donations d
        WHERE d.donated_at >= now() - interval '12 months'
        GROUP BY date_trunc('month', d.donated_at)
        ORDER BY date_trunc('month', d.donated_at)
      ) t
    ), '[]'::json),
    'monthly_new_users', COALESCE((
      SELECT json_agg(t) FROM (
        SELECT
          to_char(date_trunc('month', u.created_at), 'YYYY-MM') AS month,
          COUNT(*) AS count
        FROM user_auth u
        WHERE u.username != v_admin_name AND u.created_at >= now() - interval '12 months'
        GROUP BY date_trunc('month', u.created_at)
        ORDER BY date_trunc('month', u.created_at)
      ) t
    ), '[]'::json)
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 3.15 更新促销设置
CREATE OR REPLACE FUNCTION admin_update_promo(
  p_admin_pwd_hash TEXT,
  p_amount TEXT,
  p_years TEXT,
  p_text TEXT
) RETURNS JSON AS $$
DECLARE
  v_admin_name TEXT;
  v_stored_hash TEXT;
BEGIN
  SELECT value INTO v_admin_name FROM admin_config WHERE key = 'admin_username';
  SELECT password_hash INTO v_stored_hash FROM user_auth WHERE username = v_admin_name;
  IF v_stored_hash IS NULL OR p_admin_pwd_hash IS DISTINCT FROM v_stored_hash THEN
    RETURN json_build_object('success', false, 'error', '管理员验证失败');
  END IF;
  UPDATE admin_config SET value = p_amount WHERE key = 'promo_amount';
  UPDATE admin_config SET value = p_years WHERE key = 'promo_years';
  UPDATE admin_config SET value = p_text WHERE key = 'promo_text';
  RETURN json_build_object('success', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 3.16 发布留言
CREATE OR REPLACE FUNCTION admin_publish_message(
  p_admin_pwd_hash TEXT,
  p_title TEXT,
  p_content TEXT
) RETURNS JSON AS $$
DECLARE
  v_admin_name TEXT;
  v_stored_hash TEXT;
  v_new_id INT;
BEGIN
  SELECT value INTO v_admin_name FROM admin_config WHERE key = 'admin_username';
  SELECT password_hash INTO v_stored_hash FROM user_auth WHERE username = v_admin_name;
  IF v_stored_hash IS NULL OR p_admin_pwd_hash IS DISTINCT FROM v_stored_hash THEN
    RETURN json_build_object('success', false, 'error', '管理员验证失败');
  END IF;
  INSERT INTO admin_messages (title, content, created_at)
  VALUES (p_title, p_content, now())
  RETURNING id INTO v_new_id;
  RETURN json_build_object('success', true, 'id', v_new_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 3.17 归档留言
CREATE OR REPLACE FUNCTION admin_archive_message(
  p_admin_pwd_hash TEXT,
  p_message_id INT
) RETURNS JSON AS $$
DECLARE
  v_admin_name TEXT;
  v_stored_hash TEXT;
BEGIN
  SELECT value INTO v_admin_name FROM admin_config WHERE key = 'admin_username';
  SELECT password_hash INTO v_stored_hash FROM user_auth WHERE username = v_admin_name;
  IF v_stored_hash IS NULL OR p_admin_pwd_hash IS DISTINCT FROM v_stored_hash THEN
    RETURN json_build_object('success', false, 'error', '管理员验证失败');
  END IF;
  UPDATE admin_messages SET status = 'archived' WHERE id = p_message_id;
  RETURN json_build_object('success', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 3.18 管理员查看留言列表
CREATE OR REPLACE FUNCTION admin_list_messages(
  p_admin_pwd_hash TEXT
) RETURNS JSON AS $$
DECLARE
  v_admin_name TEXT;
  v_stored_hash TEXT;
BEGIN
  SELECT value INTO v_admin_name FROM admin_config WHERE key = 'admin_username';
  SELECT password_hash INTO v_stored_hash FROM user_auth WHERE username = v_admin_name;
  IF v_stored_hash IS NULL OR p_admin_pwd_hash IS DISTINCT FROM v_stored_hash THEN
    RETURN json_build_object('success', false, 'error', '管理员验证失败');
  END IF;
  RETURN json_build_object(
    'success', true,
    'messages', COALESCE((
      SELECT json_agg(t) FROM (
        SELECT id, title, content, created_at, status
        FROM admin_messages
        ORDER BY created_at DESC
      ) t
    ), '[]'::json)
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================
-- 4. RLS：先 DROP IF EXISTS，再重新启用+创建策略
-- ============================================================

-- 4.1 user_auth：只保留 RPC 可访问
ALTER TABLE user_auth ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "user_auth_select" ON user_auth;
DROP POLICY IF EXISTS "user_auth_insert" ON user_auth;
DROP POLICY IF EXISTS "user_auth_update" ON user_auth;

-- 4.2 authorizations：只保留 RPC 可访问
ALTER TABLE authorizations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "auth_select" ON authorizations;

-- 4.3 donations：只保留 RPC 可访问
ALTER TABLE donations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "donations_select" ON donations;

-- 4.4 admin_config：anon 只许读取促销配置
ALTER TABLE admin_config ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "config_select" ON admin_config;
CREATE POLICY "config_select" ON admin_config FOR SELECT TO anon USING (true);

-- 4.5 admin_messages：anon 只许读取 active 状态
ALTER TABLE admin_messages ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "messages_select" ON admin_messages;
CREATE POLICY "messages_select" ON admin_messages FOR SELECT TO anon USING (status = 'active');

-- 4.6 user_read_messages：允许读+写
ALTER TABLE user_read_messages ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "read_msgs_select" ON user_read_messages;
DROP POLICY IF EXISTS "read_msgs_insert" ON user_read_messages;
CREATE POLICY "read_msgs_select" ON user_read_messages FOR SELECT TO anon USING (true);
CREATE POLICY "read_msgs_insert" ON user_read_messages FOR INSERT TO anon WITH CHECK (true);

-- ============================================================
-- 5. 表级权限：撤销 anon 直接 INSERT/UPDATE/DELETE 高敏感表
-- ============================================================
REVOKE INSERT, UPDATE, DELETE ON user_auth FROM anon;
REVOKE INSERT, UPDATE, DELETE ON authorizations FROM anon;
REVOKE INSERT, UPDATE, DELETE ON donations FROM anon;
REVOKE INSERT, UPDATE, DELETE ON admin_config FROM anon;
REVOKE INSERT, UPDATE, DELETE ON admin_messages FROM anon;

-- ============================================================
-- 完成提示
-- ============================================================
DO $$
BEGIN
  RAISE NOTICE '✅ 一键修复已完成：所有认证RPC函数(verify_login等18个)已补齐，RLS已收紧，admin_config已校正';
  RAISE NOTICE '现在可以在前端尝试登录，首次登录前请强制刷新(Ctrl+Shift+R)清理缓存';
END;
$$;
