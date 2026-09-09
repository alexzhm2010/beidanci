-- ============================================================
-- 背单词 v1.9.0 安全加固：迁移到 Supabase Auth 强隔离
--
-- 目标:
--   把 words / records 表从"前端 sync_code 软隔离 + anon 全表开放"
--   升级为"Supabase Auth JWT + RLS auth.uid() = user_id 强隔离"。
--
-- 前置条件:
--   1. Supabase 项目 Auth 已启用 (默认启用)
--   2. 已执行过 supabase.sql / setup_auth_rpc_fix.sql / security_improve.sql
--
-- 幂等: 可重复执行, 不会报错
-- 执行位置: Supabase Dashboard → SQL Editor → 全选粘贴 → Run
--
-- 配套部署 (本脚本只改数据库, 还需):
--   A. 部署两个 Edge Function: migrate-user / update-password
--      (源码见 supabase/functions/migrate-user/index.ts
--             supabase/functions/update-password/index.ts)
--   B. 前端发布 js/auth.js / js/db.js / js/config.js v1.9.0
-- ============================================================
SET client_min_messages = NOTICE;

-- ============================================================
-- 1. 表结构: 加 user_id 字段 (关联 auth.users.id)
-- ============================================================

-- 1.1 words 表: 新增 user_id, 关联当前 auth 用户
ALTER TABLE words ADD COLUMN IF NOT EXISTS user_id UUID;
ALTER TABLE words ALTER COLUMN sync_code SET DEFAULT 'default';
COMMENT ON COLUMN words.user_id IS 'Supabase Auth 用户 ID (auth.users.id), RLS 强隔离用';

-- 1.2 records 表: 同上
ALTER TABLE records ADD COLUMN IF NOT EXISTS user_id UUID;
COMMENT ON COLUMN records.user_id IS 'Supabase Auth 用户 ID (auth.users.id), RLS 强隔离用';

-- 1.3 user_auth 表: 新增 user_id, 关联 Supabase Auth 账号
--     (password_hash 保留: 用于老用户首次登录迁移时的旧哈希校验, 防止账号劫持)
ALTER TABLE user_auth ADD COLUMN IF NOT EXISTS user_id UUID;
COMMENT ON COLUMN user_auth.user_id IS 'Supabase Auth 用户 ID, 与 username 一一对应 (迁移后回填)';

-- ============================================================
-- 2. 索引: 加速 user_id 过滤 (取代原 sync_code 索引)
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_words_user_id ON words(user_id);
CREATE INDEX IF NOT EXISTS idx_records_user_id ON records(user_id);
CREATE INDEX IF NOT EXISTS idx_user_auth_user_id ON user_auth(user_id);

-- ============================================================
-- 3. RPC: 注册时绑定 user_id
--    (前端流程: 先 supabase auth signUp 拿 uid → 再调 register_user 带 uid)
--    幂等: 已存在则更新 user_id (重试安全)
-- ============================================================
CREATE OR REPLACE FUNCTION register_user(
  p_username TEXT,
  p_pwd_hash TEXT,
  p_sec_question TEXT,
  p_sec_answer_hash TEXT,
  p_user_id UUID DEFAULT NULL
) RETURNS JSON AS $$
DECLARE
  exists_count INT;
BEGIN
  SELECT COUNT(*) INTO exists_count FROM user_auth WHERE username = p_username;
  IF exists_count > 0 THEN
    -- 已存在: 若传了 user_id, 补绑 (重试场景)
    IF p_user_id IS NOT NULL THEN
      UPDATE user_auth SET user_id = p_user_id WHERE username = p_username AND user_id IS NULL;
    END IF;
    RETURN json_build_object('success', false, 'error', 'exists');
  END IF;
  INSERT INTO user_auth (username, password_hash, sec_question, sec_answer_hash, user_id)
    VALUES (p_username, p_pwd_hash, p_sec_question, p_sec_answer_hash, p_user_id);
  RETURN json_build_object('success', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 3.1 绑定/更新 user_auth.user_id (注册第二步单独调用, 失败重试用)
CREATE OR REPLACE FUNCTION link_user_id(
  p_username TEXT,
  p_user_id UUID
) RETURNS JSON AS $$
BEGIN
  IF p_user_id IS NULL THEN
    RETURN json_build_object('success', false, 'error', 'invalid_user_id');
  END IF;
  UPDATE user_auth SET user_id = p_user_id WHERE username = p_username;
  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'error', 'user_not_found');
  END IF;
  RETURN json_build_object('success', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 3.2 查询某 username 是否已迁移 (前端登录流程用, 判断是否触发 migrate-user)
CREATE OR REPLACE FUNCTION get_user_migration_status(p_username TEXT) RETURNS JSON AS $$
DECLARE
  uid UUID;
BEGIN
  SELECT user_id INTO uid FROM user_auth WHERE username = p_username;
  IF uid IS NULL THEN
    RETURN json_build_object('success', true, 'migrated', false);
  END IF;
  RETURN json_build_object('success', true, 'migrated', true, 'user_id', uid);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================
-- 4. RPC: clear_user_data / clear_user_records 改用 auth.uid()
--    (迁移前用 p_sync_code, 谁都能传; 迁移后用调用者 JWT 的 uid, 不可伪造)
--    保留 p_sync_code 参数仅为向后兼容, 实际以 auth.uid() 为准
-- ============================================================
CREATE OR REPLACE FUNCTION clear_user_data(p_sync_code TEXT DEFAULT NULL) RETURNS JSON AS $$
DECLARE
  uid UUID := auth.uid();
BEGIN
  IF uid IS NULL THEN
    RETURN json_build_object('success', false, 'error', 'not_authenticated');
  END IF;
  DELETE FROM records WHERE user_id = uid;
  DELETE FROM words   WHERE user_id = uid;
  RETURN json_build_object('success', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION clear_user_records(p_sync_code TEXT DEFAULT NULL) RETURNS JSON AS $$
DECLARE
  uid UUID := auth.uid();
BEGIN
  IF uid IS NULL THEN
    RETURN json_build_object('success', false, 'error', 'not_authenticated');
  END IF;
  DELETE FROM records WHERE user_id = uid;
  RETURN json_build_object('success', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================
-- 5. RLS 重写: words / records 基于 auth.uid() = user_id 强隔离
--
--    迁移后:
--    - anon (无 JWT) 完全无法访问 words/records → 即便 anon key 泄露也读不到任何数据
--    - authenticated (带 JWT) 只能访问 user_id = 自己 uid 的行
--    - RPC (SECURITY DEFINER) 不受 RLS 限制, 仍可被 anon 调用 (注册/登录/迁移/admin)
-- ============================================================

-- 5.1 words 表
ALTER TABLE words ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "words_all_anon" ON words;
DROP POLICY IF EXISTS "words_owner" ON words;
CREATE POLICY "words_owner" ON words
  FOR ALL TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- 5.2 records 表
ALTER TABLE records ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "records_all_anon" ON records;
DROP POLICY IF EXISTS "records_select" ON records;
DROP POLICY IF EXISTS "records_insert" ON records;
DROP POLICY IF EXISTS "records_owner" ON records;
CREATE POLICY "records_owner" ON records
  FOR ALL TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- 5.3 双保险: 显式撤销 anon 对 words/records 的写权限
--    (SELECT 也撤销, 因 RLS 已无 anon 策略, anon 拿不到任何行)
REVOKE SELECT, INSERT, UPDATE, DELETE ON words FROM anon;
REVOKE SELECT, INSERT, UPDATE, DELETE ON records FROM anon;

-- ============================================================
-- 6. user_auth 表 RLS 收紧 (原本就只 RPC 可访问, 此处补齐)
-- ============================================================
ALTER TABLE user_auth ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "user_auth_select" ON user_auth;
DROP POLICY IF EXISTS "user_auth_insert" ON user_auth;
DROP POLICY IF EXISTS "user_auth_update" ON user_auth;
-- 不创建任何 anon/authenticated 策略 → 只能通过 SECURITY DEFINER RPC 访问
REVOKE SELECT, INSERT, UPDATE, DELETE ON user_auth FROM anon;
REVOKE SELECT, INSERT, UPDATE, DELETE ON user_auth FROM authenticated;

-- ============================================================
-- 7. authorizations / donations 表: 保持 username 主键
--    (支付链路 pay_authorize_user 用 username 开通, 不依赖 user_id)
--    仅 RPC 可访问, 已在 setup_auth_rpc_fix.sql 收紧, 此处不重复
-- ============================================================

-- ============================================================
-- 8. 完成提示
-- ============================================================
DO $$
BEGIN
  RAISE NOTICE '✅ v1.9.0 安全加固 SQL 已执行:';
  RAISE NOTICE '   - words/records/user_auth 已加 user_id 字段 + 索引';
  RAISE NOTICE '   - register_user 加 p_user_id 参数; 新增 link_user_id / get_user_migration_status';
  RAISE NOTICE '   - clear_user_data 改用 auth.uid() 强校验';
  RAISE NOTICE '   - words/records RLS 收紧为 auth.uid()=user_id, anon 完全无权';
  RAISE NOTICE '   - user_auth 表撤销 anon/authenticated 直接权限, 只 RPC 可访问';
  RAISE NOTICE '⚠️ 老用户数据回填由 migrate-user Edge Function 在首次登录时自动完成';
  RAISE NOTICE '⚠️ 部署顺序: 1)本SQL  2)部署 migrate-user + update-password Edge Function  3)发布前端 v1.9.0';
END;
$$;
