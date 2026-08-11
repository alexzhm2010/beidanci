-- ============================================
-- 背单词应用 - Supabase 建表脚本
-- 使用方法:
--   1. 登录 https://supabase.com 创建免费项目
--   2. 进入 SQL Editor
--   3. 粘贴此脚本并执行
--   4. 在项目 Settings > API 中获取 URL 和 anon key
--   5. 在应用的"设置"中填入这两个值
-- ============================================

-- 单词表
CREATE TABLE IF NOT EXISTS words (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sync_code         TEXT NOT NULL DEFAULT 'default',
  word              TEXT NOT NULL,
  phonetic          TEXT DEFAULT '',
  part_of_speech    TEXT DEFAULT '',
  chinese_meaning   TEXT DEFAULT '',
  example_sentence  TEXT DEFAULT '',
  total_count       INTEGER NOT NULL DEFAULT 0,
  known_count       INTEGER NOT NULL DEFAULT 0,
  last_known_time   BIGINT,
  last_learn_time   BIGINT,
  stability         BIGINT NOT NULL DEFAULT 0,
  next_review_at    BIGINT NOT NULL DEFAULT 0,
  created_at        BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
  updated_at        BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
);

-- 给已有数据库添加新列 (已存在则跳过)
ALTER TABLE words ADD COLUMN IF NOT EXISTS stability BIGINT NOT NULL DEFAULT 0;
ALTER TABLE words ADD COLUMN IF NOT EXISTS next_review_at BIGINT NOT NULL DEFAULT 0;

-- 学习记录表
CREATE TABLE IF NOT EXISTS records (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sync_code     TEXT NOT NULL DEFAULT 'default',
  word_id       TEXT,
  word          TEXT,
  direction     TEXT,
  is_known      BOOLEAN,
  session_type  TEXT,
  timestamp     BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_words_sync_code ON words(sync_code);
CREATE INDEX IF NOT EXISTS idx_records_sync_code ON records(sync_code);
CREATE INDEX IF NOT EXISTS idx_records_timestamp ON records(timestamp);

-- ============================================
-- RLS (行级安全) 策略
-- 此应用使用 sync_code 区分用户, 不依赖 Supabase Auth
-- 因此开放 anon key 的全部访问权限
-- ============================================

ALTER TABLE words ENABLE ROW LEVEL SECURITY;
ALTER TABLE records ENABLE ROW LEVEL SECURITY;

-- 允许 anon 角色的全部操作
CREATE POLICY "words_all_anon" ON words
  FOR ALL TO anon
  USING (true) WITH CHECK (true);

CREATE POLICY "records_all_anon" ON records
  FOR ALL TO anon
  USING (true) WITH CHECK (true);
