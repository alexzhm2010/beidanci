-- ============================================================
-- 背单词 v1.10.0 Admin 运营后台：预置词库 + 用户详情 + 授权增强
--
-- 目标:
--   1. 新增 preset_words 表 (预置词库, 单表扁平结构, stage 标识学段)
--   2. sync_preset_words RPC: 普通用户按学段同步预置词到私有 words 表
--   3. admin 预置词 CRUD RPC (内联鉴权, 与现有 admin_* 一致)
--   4. admin_get_user_detail RPC: 查询用户学习数据详情
--   5. admin_authorize 增强可选参数 p_expires_at (指定到期日, 不走促销)
--
-- 鉴权模式: 与 setup_auth_rpc_fix.sql 一致, 每个函数内联校验
--   SELECT value INTO v_admin_name FROM admin_config WHERE key = 'admin_username';
--   SELECT password_hash INTO v_stored_hash FROM user_auth WHERE username = v_admin_name;
--   IF v_stored_hash IS NULL OR p_admin_pwd_hash IS DISTINCT FROM v_stored_hash THEN ...
--
-- 幂等: 可重复执行
-- 执行位置: Supabase Dashboard → SQL Editor → 全选粘贴 → Run
-- ============================================================
SET client_min_messages = NOTICE;

-- ============================================================
-- 1. 预置词库表 preset_words
-- ============================================================

CREATE TABLE IF NOT EXISTS preset_words (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  word TEXT NOT NULL,
  phonetic TEXT DEFAULT '',
  part_of_speech TEXT DEFAULT '',
  chinese_meaning TEXT DEFAULT '',
  example_sentence TEXT DEFAULT '',
  stage TEXT NOT NULL CHECK (stage IN ('小学','初中','高中','大学','考研','其他')),
  stage_order INT NOT NULL,  -- 小学=1, 初中=2, 高中=3, 大学=4, 考研=5, 其他=99
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- 同单词同词性唯一约束 (防止 admin 误录重复词)
CREATE UNIQUE INDEX IF NOT EXISTS preset_words_word_pos_uq
  ON preset_words(word, part_of_speech);

-- 按学段查询索引
CREATE INDEX IF NOT EXISTS preset_words_stage_order_idx ON preset_words(stage_order);

-- updated_at 自动维护触发器 (复用现有 update_updated_at_column 函数, 若不存在则建)
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS preset_words_updated_at ON preset_words;
CREATE TRIGGER preset_words_updated_at
  BEFORE UPDATE ON preset_words
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- 2. RLS: preset_words 只 RPC 可访问 (无任何直查策略)
-- ============================================================

ALTER TABLE preset_words ENABLE ROW LEVEL SECURITY;
ALTER TABLE preset_words FORCE ROW LEVEL SECURITY;
-- 不建 anon/authenticated 策略, 所有访问走 SECURITY DEFINER RPC
REVOKE SELECT, INSERT, UPDATE, DELETE ON preset_words FROM anon;
REVOKE SELECT, INSERT, UPDATE, DELETE ON preset_words FROM authenticated;

-- ============================================================
-- 3. RPC: 普通用户同步预置词库到私有 words 表
--    递进模型: stage_order <= 用户选学段 (含以下所有学段)
--    "其他"为独立补充包, 通过 p_include_other 勾选才同步
--    按 word 去重, 已存在跳过, 不覆盖用户学习进度
-- ============================================================

CREATE OR REPLACE FUNCTION sync_preset_words(
  p_stage TEXT,
  p_include_other BOOLEAN DEFAULT FALSE
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_stage_order INT;
  v_inserted INT := 0;
  v_skipped INT := 0;
BEGIN
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
  END IF;

  -- 学段名转 order (其他不在此映射, 走 p_include_other 旁路)
  v_stage_order := CASE p_stage
    WHEN '小学' THEN 1
    WHEN '初中' THEN 2
    WHEN '高中' THEN 3
    WHEN '大学' THEN 4
    WHEN '考研' THEN 5
    ELSE NULL
  END;

  IF v_stage_order IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_stage');
  END IF;

  -- 复制预置词到用户私有 words 表, 按 word 去重跳过已存在
  INSERT INTO words (id, user_id, word, phonetic, part_of_speech, chinese_meaning,
                     example_sentence, total_count, known_count, created_at, updated_at)
  SELECT gen_random_uuid(), v_user_id, p.word, p.phonetic, p.part_of_speech,
         p.chinese_meaning, p.example_sentence, 0, 0, now(), now()
  FROM preset_words p
  WHERE (p.stage_order <= v_stage_order OR (p_include_other AND p.stage = '其他'))
    AND NOT EXISTS (
      SELECT 1 FROM words w
      WHERE w.user_id = v_user_id AND w.word = p.word
    );
  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  -- 统计跳过数 (已存在的同范围词)
  SELECT COUNT(*) INTO v_skipped FROM preset_words p
  WHERE (p.stage_order <= v_stage_order OR (p_include_other AND p.stage = '其他'))
    AND EXISTS (SELECT 1 FROM words w WHERE w.user_id = v_user_id AND w.word = p.word);

  RETURN jsonb_build_object(
    'success', true,
    'inserted', v_inserted,
    'skipped', v_skipped
  );
END;
$$;

-- ============================================================
-- 4. RPC: admin 预置词库管理 (CRUD + 批量导入 + 列表)
--    鉴权模式与现有 admin_* 一致 (内联比对 admin_config.admin_username)
-- ============================================================

-- 4.1 admin 列出预置词 (按学段过滤, 分页)
CREATE OR REPLACE FUNCTION admin_list_preset_words(
  p_admin_pwd_hash TEXT,
  p_stage TEXT DEFAULT NULL,      -- NULL=全部, 指定学段则过滤
  p_offset INT DEFAULT 0,
  p_limit INT DEFAULT 100
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_admin_name TEXT;
  v_stored_hash TEXT;
BEGIN
  SELECT value INTO v_admin_name FROM admin_config WHERE key = 'admin_username';
  SELECT password_hash INTO v_stored_hash FROM user_auth WHERE username = v_admin_name;
  IF v_stored_hash IS NULL OR p_admin_pwd_hash IS DISTINCT FROM v_stored_hash THEN
    RETURN jsonb_build_object('success', false, 'error', '管理员验证失败');
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'words', COALESCE((
      SELECT jsonb_agg(t) FROM (
        SELECT id, word, phonetic, part_of_speech, chinese_meaning,
               example_sentence, stage, stage_order, created_at, updated_at
        FROM preset_words
        WHERE (p_stage IS NULL OR stage = p_stage)
        ORDER BY stage_order ASC, word ASC
        OFFSET p_offset LIMIT p_limit
      ) t
    ), '[]'::jsonb),
    'total', (SELECT COUNT(*) FROM preset_words WHERE (p_stage IS NULL OR stage = p_stage))
  );
END;
$$;

-- 4.2 admin 单条新增预置词
CREATE OR REPLACE FUNCTION admin_add_preset_word(
  p_admin_pwd_hash TEXT,
  p_word TEXT,
  p_phonetic TEXT,
  p_part_of_speech TEXT,
  p_chinese_meaning TEXT,
  p_example_sentence TEXT,
  p_stage TEXT
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_admin_name TEXT;
  v_stored_hash TEXT;
  v_order INT;
  v_new_id UUID;
BEGIN
  SELECT value INTO v_admin_name FROM admin_config WHERE key = 'admin_username';
  SELECT password_hash INTO v_stored_hash FROM user_auth WHERE username = v_admin_name;
  IF v_stored_hash IS NULL OR p_admin_pwd_hash IS DISTINCT FROM v_stored_hash THEN
    RETURN jsonb_build_object('success', false, 'error', '管理员验证失败');
  END IF;

  v_order := CASE p_stage
    WHEN '小学' THEN 1 WHEN '初中' THEN 2 WHEN '高中' THEN 3
    WHEN '大学' THEN 4 WHEN '考研' THEN 5 ELSE 99
  END;

  INSERT INTO preset_words(word, phonetic, part_of_speech, chinese_meaning,
                           example_sentence, stage, stage_order)
  VALUES (p_word, p_phonetic, p_part_of_speech, p_chinese_meaning,
          p_example_sentence, p_stage, v_order)
  RETURNING id INTO v_new_id;

  RETURN jsonb_build_object('success', true, 'id', v_new_id);
END;
$$;

-- 4.3 admin 更新预置词
CREATE OR REPLACE FUNCTION admin_update_preset_word(
  p_admin_pwd_hash TEXT,
  p_word_id UUID,
  p_word TEXT,
  p_phonetic TEXT,
  p_part_of_speech TEXT,
  p_chinese_meaning TEXT,
  p_example_sentence TEXT,
  p_stage TEXT
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_admin_name TEXT;
  v_stored_hash TEXT;
  v_order INT;
BEGIN
  SELECT value INTO v_admin_name FROM admin_config WHERE key = 'admin_username';
  SELECT password_hash INTO v_stored_hash FROM user_auth WHERE username = v_admin_name;
  IF v_stored_hash IS NULL OR p_admin_pwd_hash IS DISTINCT FROM v_stored_hash THEN
    RETURN jsonb_build_object('success', false, 'error', '管理员验证失败');
  END IF;

  v_order := CASE p_stage
    WHEN '小学' THEN 1 WHEN '初中' THEN 2 WHEN '高中' THEN 3
    WHEN '大学' THEN 4 WHEN '考研' THEN 5 ELSE 99
  END;

  UPDATE preset_words
  SET word = p_word, phonetic = p_phonetic, part_of_speech = p_part_of_speech,
      chinese_meaning = p_chinese_meaning, example_sentence = p_example_sentence,
      stage = p_stage, stage_order = v_order
  WHERE id = p_word_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'word_not_found');
  END IF;
  RETURN jsonb_build_object('success', true);
END;
$$;

-- 4.4 admin 删除预置词
CREATE OR REPLACE FUNCTION admin_delete_preset_word(
  p_admin_pwd_hash TEXT,
  p_word_id UUID
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_admin_name TEXT;
  v_stored_hash TEXT;
BEGIN
  SELECT value INTO v_admin_name FROM admin_config WHERE key = 'admin_username';
  SELECT password_hash INTO v_stored_hash FROM user_auth WHERE username = v_admin_name;
  IF v_stored_hash IS NULL OR p_admin_pwd_hash IS DISTINCT FROM v_stored_hash THEN
    RETURN jsonb_build_object('success', false, 'error', '管理员验证失败');
  END IF;

  DELETE FROM preset_words WHERE id = p_word_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'word_not_found');
  END IF;
  RETURN jsonb_build_object('success', true);
END;
$$;

-- 4.5 admin 批量导入预置词 (配合前端 xlsx 解析)
--     入参 p_words: JSON 数组 [{word, phonetic, part_of_speech, chinese_meaning, example_sentence, stage}, ...]
--     重复词 (word+part_of_speech 冲突) 跳过 (ON CONFLICT DO NOTHING)
CREATE OR REPLACE FUNCTION admin_batch_add_preset_words(
  p_admin_pwd_hash TEXT,
  p_words JSONB
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_admin_name TEXT;
  v_stored_hash TEXT;
  v_count INT := 0;
BEGIN
  SELECT value INTO v_admin_name FROM admin_config WHERE key = 'admin_username';
  SELECT password_hash INTO v_stored_hash FROM user_auth WHERE username = v_admin_name;
  IF v_stored_hash IS NULL OR p_admin_pwd_hash IS DISTINCT FROM v_stored_hash THEN
    RETURN jsonb_build_object('success', false, 'error', '管理员验证失败');
  END IF;

  INSERT INTO preset_words(word, phonetic, part_of_speech, chinese_meaning,
                           example_sentence, stage, stage_order)
  SELECT
    w->>'word',
    COALESCE(w->>'phonetic', ''),
    COALESCE(w->>'part_of_speech', ''),
    COALESCE(w->>'chinese_meaning', ''),
    COALESCE(w->>'example_sentence', ''),
    w->>'stage',
    CASE w->>'stage'
      WHEN '小学' THEN 1 WHEN '初中' THEN 2 WHEN '高中' THEN 3
      WHEN '大学' THEN 4 WHEN '考研' THEN 5 ELSE 99
    END
  FROM jsonb_array_elements(p_words) AS w
  ON CONFLICT (word, part_of_speech) DO NOTHING;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN jsonb_build_object('success', true, 'inserted', v_count);
END;
$$;

-- 4.6 admin 学段统计 (各学段词数概览)
CREATE OR REPLACE FUNCTION admin_preset_word_stats(
  p_admin_pwd_hash TEXT
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_admin_name TEXT;
  v_stored_hash TEXT;
BEGIN
  SELECT value INTO v_admin_name FROM admin_config WHERE key = 'admin_username';
  SELECT password_hash INTO v_stored_hash FROM user_auth WHERE username = v_admin_name;
  IF v_stored_hash IS NULL OR p_admin_pwd_hash IS DISTINCT FROM v_stored_hash THEN
    RETURN jsonb_build_object('success', false, 'error', '管理员验证失败');
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'stats', COALESCE((
      SELECT jsonb_agg(t) FROM (
        SELECT stage, stage_order, COUNT(*) AS count
        FROM preset_words
        GROUP BY stage, stage_order
        ORDER BY stage_order ASC
      ) t
    ), '[]'::jsonb),
    'total', (SELECT COUNT(*) FROM preset_words)
  );
END;
$$;

-- ============================================================
-- 5. RPC: admin_get_user_detail 查询用户学习数据详情
--    (words/records 有 RLS, 但 SECURITY DEFINER 绕过, 可查任意用户)
--    需要先通过 user_auth.username 找到 user_id, 再查 words/records
-- ============================================================

CREATE OR REPLACE FUNCTION admin_get_user_detail(
  p_admin_pwd_hash TEXT,
  p_username TEXT
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_admin_name TEXT;
  v_stored_hash TEXT;
  v_uid UUID;
  v_word_total INT;
  v_word_known INT;
  v_records_total INT;
  v_last_active TIMESTAMPTZ;
  v_recent_records JSONB;
BEGIN
  SELECT value INTO v_admin_name FROM admin_config WHERE key = 'admin_username';
  SELECT password_hash INTO v_stored_hash FROM user_auth WHERE username = v_admin_name;
  IF v_stored_hash IS NULL OR p_admin_pwd_hash IS DISTINCT FROM v_stored_hash THEN
    RETURN jsonb_build_object('success', false, 'error', '管理员验证失败');
  END IF;

  -- 取用户 user_id (迁移后才有, 未迁移为 NULL)
  SELECT user_id INTO v_uid FROM user_auth WHERE username = p_username;
  IF v_uid IS NULL THEN
    -- 未迁移用户, 学习数据查不到 (sync_code 时代的数据可能还在, 但 user_id 为空)
    RETURN jsonb_build_object(
      'success', true,
      'username', p_username,
      'migrated', false,
      'word_total', 0,
      'word_known', 0,
      'records_total', 0,
      'last_active', NULL,
      'recent_records', '[]'::jsonb
    );
  END IF;

  SELECT COUNT(*) INTO v_word_total FROM words WHERE user_id = v_uid;
  SELECT COUNT(*) INTO v_word_known FROM words WHERE user_id = v_uid AND known_count > 0;
  SELECT COUNT(*) INTO v_records_total FROM records WHERE user_id = v_uid;
  SELECT MAX(timestamp) INTO v_last_active FROM records WHERE user_id = v_uid;

  -- 最近 10 条复习记录
  SELECT COALESCE(jsonb_agg(t), '[]'::jsonb) INTO v_recent_records
  FROM (
    SELECT word, direction, is_known, session_type, timestamp
    FROM records WHERE user_id = v_uid
    ORDER BY timestamp DESC
    LIMIT 10
  ) t;

  RETURN jsonb_build_object(
    'success', true,
    'username', p_username,
    'user_id', v_uid,
    'migrated', true,
    'word_total', v_word_total,
    'word_known', v_word_known,
    'records_total', v_records_total,
    'last_active', v_last_active,
    'recent_records', v_recent_records
  );
END;
$$;

-- ============================================================
-- 6. admin_authorize 增强: 加可选参数 p_expires_at
--    - 不传 p_expires_at (NULL): 保持原逻辑, 按促销配置算到期日 + 插 donations
--    - 传 p_expires_at: 指定到期日, 不走促销, donations 记 amount=0 years=NULL
--    兼容现有调用 (前 3 参数顺序不变, 第 4 参数有默认值)
-- ============================================================

CREATE OR REPLACE FUNCTION admin_authorize(
  p_admin_pwd_hash TEXT,
  p_username TEXT,
  p_note TEXT,
  p_expires_at TIMESTAMPTZ DEFAULT NULL
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

  IF p_expires_at IS NOT NULL THEN
    -- 指定到期日模式: 不走促销, donations 记 amount=0 years=NULL
    v_years := NULL;
    v_amount := 0;
    v_expires := p_expires_at;
  ELSE
    -- 原逻辑: 按促销配置算
    SELECT value::INT INTO v_years FROM admin_config WHERE key = 'promo_years';
    SELECT value::NUMERIC INTO v_amount FROM admin_config WHERE key = 'promo_amount';
    v_expires := CASE
      WHEN v_years IS NULL THEN NULL
      ELSE now() + make_interval(years => v_years)
    END;
  END IF;

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

-- ============================================================
-- 7. 完成提示
-- ============================================================
DO $$
BEGIN
  RAISE NOTICE '✅ v1.10.0 Admin 运营后台 SQL 已执行:';
  RAISE NOTICE '   - preset_words 表已建 (含 stage/stage_order + 唯一约束 + updated_at 触发器)';
  RAISE NOTICE '   - preset_words RLS 收紧: 只 RPC 可访问, anon/authenticated 均无直查权';
  RAISE NOTICE '   - sync_preset_words RPC: 普通用户按学段递进同步, 其他作独立补充包';
  RAISE NOTICE '   - admin 预置词 CRUD: admin_list/add/update/delete/batch_add/stats';
  RAISE NOTICE '   - admin_get_user_detail: 查询用户学习数据 (绕过 RLS)';
  RAISE NOTICE '   - admin_authorize 增强: 新增可选 p_expires_at (向后兼容)';
  RAISE NOTICE '⚠️ 部署顺序: 1)本SQL  2)发布前端 v1.10.0 (app.js/admin.js/library.js/db.js)';
END;
$$;
