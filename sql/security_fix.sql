-- ============================================
-- P0 安全修复: 锁定 user_auth / authorizations 表
-- 所有认证操作改为通过 RPC (SECURITY DEFINER) 完成
-- 前端不再能直接读写 user_auth 表
--
-- 执行方式: 在 Supabase Dashboard → SQL Editor 中运行本文件
-- ============================================

-- ============================================
-- 1. RPC 函数: 认证操作 (SECURITY DEFINER 绕过 RLS)
-- ============================================

-- 1.1 注册用户 (检查用户名唯一性, 不返回哈希)
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

-- 1.2 验证登录 (只返回 true/false, 不返回哈希)
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

-- 1.3 检查用户名是否存在
CREATE OR REPLACE FUNCTION username_exists(p_username TEXT) RETURNS BOOLEAN AS $$
BEGIN
  RETURN EXISTS(SELECT 1 FROM user_auth WHERE username = p_username);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 1.4 获取密保问题 (仅返回问题文本和注册时间, 不返回哈希)
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

-- 1.5 验证密保答案
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

-- 1.6 重置密码 (需验证密保答案)
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

-- 1.7 获取用户信息 (Profile 页面展示用, 不返回哈希)
CREATE OR REPLACE FUNCTION get_user_auth_info(p_username TEXT) RETURNS JSON AS $$
DECLARE
  q TEXT;
  created_ts TIMESTAMPTZ;
BEGIN
  SELECT sec_question, created_at INTO q, created_ts
    FROM user_auth WHERE username = p_username;
  IF q IS NULL THEN
    RETURN NULL;
  END IF;
  RETURN json_build_object(
    'username', p_username,
    'sec_question', q,
    'created_at', created_ts
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 1.8 修改密码 (需验证原密码)
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

-- 1.9 修改密保问题 (需验证密码)
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

-- 1.10 获取用户授权状态 (替代直接查询 authorizations 表)
CREATE OR REPLACE FUNCTION get_user_authorization(p_username TEXT) RETURNS JSON AS $$
DECLARE
  r RECORD;
BEGIN
  SELECT * INTO r FROM authorizations WHERE username = p_username LIMIT 1;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  RETURN json_build_object(
    'username', r.username,
    'status', r.status,
    'authorized_at', r.authorized_at,
    'expires_at', r.expires_at,
    'note', r.note
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================
-- 2. RLS 策略: 锁定 user_auth / authorizations 表
-- ============================================

-- 2.1 user_auth: 撤销所有 anon 直接访问
DROP POLICY IF EXISTS "user_auth_select" ON user_auth;
DROP POLICY IF EXISTS "user_auth_insert" ON user_auth;
DROP POLICY IF EXISTS "user_auth_update" ON user_auth;
-- 不创建新策略 → anon 角色无法直接读写, 只能通过 RPC (SECURITY DEFINER) 访问

-- 2.2 authorizations: 撤销 anon 直接访问
DROP POLICY IF EXISTS "auth_select" ON authorizations;
-- 不创建新策略 → anon 角色无法直接读写, 只能通过 RPC 访问

-- ============================================
-- 完成提示
-- ============================================
DO $$
BEGIN
  RAISE NOTICE 'P0 安全修复已完成: user_auth 和 authorizations 表已锁定, 所有认证操作改为 RPC 调用';
END;
$$;
