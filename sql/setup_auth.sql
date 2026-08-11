-- ============================================================
-- 背单词 v1.6.0 授权系统初始化脚本
-- 在 Supabase Dashboard > SQL Editor 中执行此脚本
-- ============================================================

-- ============================================================
-- 1. 建表
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
-- 2. 初始配置数据
-- ============================================================

INSERT INTO admin_config (key, value) VALUES
  ('admin_username', 'REDACTED_ADMIN_USERNAME'),
  ('promo_amount', '20'),
  ('promo_years', '1'),
  ('promo_text', '捐赠20元得1年使用权')
ON CONFLICT (key) DO NOTHING;

-- ============================================================
-- 3. RPC 函数 (SECURITY DEFINER 绕过 RLS)
-- ============================================================

-- 检查管理员密钥: p_admin_pwd_hash 须匹配 user_auth 中管理员的 password_hash
-- 管理员用户名从 admin_config.admin_username 读取

-- 3.1 管理员授权用户 (自动读取当前促销配置)
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

  -- 记录捐赠
  INSERT INTO donations (username, amount, years, note, donated_at)
  VALUES (p_username, v_amount, v_years, p_note, now());

  -- 更新授权
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

-- 3.2 管理员吊销用户
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

-- 3.3 管理员查看用户列表 (含授权+捐赠汇总)
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

-- 3.4 管理员统计看板数据
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

-- 3.5 更新促销设置
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

-- 3.6 发布留言
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

-- 3.7 归档留言
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

-- 3.8 管理员查看留言列表
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
-- 4. RLS 策略
-- ============================================================

-- user_auth: 允许读取(登录校验)、插入(注册)、更新(改密码/改密保)
ALTER TABLE user_auth ENABLE ROW LEVEL SECURITY;
CREATE POLICY "user_auth_select" ON user_auth FOR SELECT TO anon USING (true);
CREATE POLICY "user_auth_insert" ON user_auth FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "user_auth_update" ON user_auth FOR UPDATE TO anon USING (true) WITH CHECK (true);

-- authorizations: 允许读取(授权校验), 不允许直接写入(仅RPC)
ALTER TABLE authorizations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "auth_select" ON authorizations FOR SELECT TO anon USING (true);

-- donations: 不允许直接访问(仅RPC)
ALTER TABLE donations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "donations_select" ON donations FOR SELECT TO anon USING (false);

-- admin_config: 允许读取(促销信息), 不允许直接写入(仅RPC)
ALTER TABLE admin_config ENABLE ROW LEVEL SECURITY;
CREATE POLICY "config_select" ON admin_config FOR SELECT TO anon USING (true);

-- admin_messages: 允许读取active状态(用户查看留言)
ALTER TABLE admin_messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY "messages_select" ON admin_messages FOR SELECT TO anon USING (status = 'active');

-- user_read_messages: 允许读取和插入(用户标记已读)
ALTER TABLE user_read_messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY "read_msgs_select" ON user_read_messages FOR SELECT TO anon USING (true);
CREATE POLICY "read_msgs_insert" ON user_read_messages FOR INSERT TO anon WITH CHECK (true);

-- ============================================================
-- 5. 安全: 撤销表上的额外权限 (确保只有RPC能修改)
-- ============================================================
REVOKE INSERT, UPDATE, DELETE ON authorizations FROM anon;
REVOKE INSERT, UPDATE, DELETE ON donations FROM anon;
REVOKE INSERT, UPDATE, DELETE ON admin_config FROM anon;
REVOKE INSERT, UPDATE, DELETE ON admin_messages FROM anon;
