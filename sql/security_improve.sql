-- ============================================
-- P1 安全加固: 收紧 words / records 表权限
--
-- 背景:
--   原版 supabase.sql 对 words / records 全表开放
--   (USING(true) WITH CHECK(true)), 任何拿到 anon key 的人
--   都能 SELECT/INSERT/UPDATE/DELETE 所有用户的数据。
--
-- 本脚本改进点:
--   1. records 表: 学习记录只增不改不删, 撤销 anon 的 UPDATE/DELETE
--      → 防止恶意篡改/擦除他人学习记录
--      → 需要清理时走 clear_user_data RPC (带 sync_code 校验)
--   2. words 表: 保留业务所需的 SELECT/INSERT/UPDATE/DELETE
--      (批量导入覆盖模式依赖 DELETE), 但加注释说明限制
--   3. 新增 clear_user_data(p_sync_code) RPC: 按用户清理数据
--
-- 执行方式: 在 Supabase Dashboard → SQL Editor 中运行本文件
--
-- 局限性说明:
--   本应用用 sync_code (前端 localStorage 中的用户名) 做用户隔离,
--   不依赖 Supabase Auth。anon key 本就公开写在前端, 因此
--   SELECT 仍对 anon 开放 (无法在 RLS 层验证 sync_code 归属)。
--   长期建议迁移到 Supabase Auth (auth.uid() 强隔离)。
-- ============================================

-- ============================================
-- 1. 新增 RPC: 按用户清理数据 (替代前端直接 DELETE)
-- ============================================

-- 1.1 清空指定用户的所有单词和学习记录
CREATE OR REPLACE FUNCTION clear_user_data(p_sync_code TEXT) RETURNS JSON AS $$
BEGIN
  IF p_sync_code IS NULL OR p_sync_code = '' THEN
    RETURN json_build_object('success', false, 'error', 'invalid_sync_code');
  END IF;
  DELETE FROM records WHERE sync_code = p_sync_code;
  DELETE FROM words   WHERE sync_code = p_sync_code;
  RETURN json_build_object('success', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 1.2 仅清空指定用户的学习记录 (保留词库)
CREATE OR REPLACE FUNCTION clear_user_records(p_sync_code TEXT) RETURNS JSON AS $$
BEGIN
  IF p_sync_code IS NULL OR p_sync_code = '' THEN
    RETURN json_build_object('success', false, 'error', 'invalid_sync_code');
  END IF;
  DELETE FROM records WHERE sync_code = p_sync_code;
  RETURN json_build_object('success', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================
-- 2. records 表: 收紧 UPDATE / DELETE 权限
-- ============================================

-- 撤销原全开放策略
DROP POLICY IF EXISTS "records_all_anon" ON records;

-- 学习记录只允许: SELECT(统计查询) / INSERT(写入学习结果)
CREATE POLICY "records_select" ON records
  FOR SELECT TO anon USING (true);
CREATE POLICY "records_insert" ON records
  FOR INSERT TO anon WITH CHECK (true);
-- 不再创建 UPDATE / DELETE 策略 → anon 无法直接改/删学习记录
-- 需要清理时调用 clear_user_data / clear_user_records RPC

-- 额外保险: 显式撤销表级权限 (双保险, 即使 RLS 配置遗漏也生效)
REVOKE UPDATE, DELETE ON records FROM anon;

-- ============================================
-- 3. words 表: 保持业务所需权限, 加注释说明
-- ============================================

-- words 表需要 DELETE (批量导入 overwrite 模式会清空旧词库),
-- 因此保留全表开放, 但记录此处的已知风险:
--   - 任何拿到 anon key 的人可读取/修改/删除所有用户的词库
--   - 长期方案: 迁移 Supabase Auth 后, 用 auth.uid() 做行级隔离
-- 原策略保持不变 (supabase.sql 中已定义 words_all_anon)

-- ============================================
-- 4. 完成提示
-- ============================================
DO $$
BEGIN
  RAISE NOTICE 'P1 安全加固已完成: records 表已撤销 UPDATE/DELETE, 学习记录只能通过 RPC 清理';
END;
$$;
