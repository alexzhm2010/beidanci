-- ============================================================
-- 词典导入功能 (v1.12.0)
-- 主从表结构: imports (批次) → pages (页面) → entries (词条)
-- 独立存储, admin 审核后发布到 words 表
-- ============================================================

-- 1. 导入批次 (主表)
CREATE TABLE IF NOT EXISTS dictionary_imports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.uid(),
  source TEXT NOT NULL CHECK (source IN ('camera', 'album', 'mixed')),
  total_pages INT NOT NULL DEFAULT 0,
  total_entries INT NOT NULL DEFAULT 0,
  total_phrases INT NOT NULL DEFAULT 0,
  -- 该批次已覆盖的页码集合 (如 [1,2,5,6]), 用于排查缺页
  page_numbers INT[] DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'parsing'
    CHECK (status IN ('parsing', 'review', 'published', 'discarded', 'failed')),
  summary JSONB, -- {pages:N, words:N, phrases:N, duration_ms:N, warnings:[...]}
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ
);

-- 2. 导入页面 (从表: 每上传一张图一行)
CREATE TABLE IF NOT EXISTS dictionary_pages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  import_id UUID NOT NULL REFERENCES dictionary_imports(id) ON DELETE CASCADE,
  page_number INT NOT NULL,
  image_url TEXT, -- Supabase Storage 路径, 便于后续重解析/审计
  ocr_raw_text TEXT, -- Tesseract 原始输出, 保留用于调参
  parsed_at TIMESTAMPTZ,
  parse_duration_ms INT,
  parse_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (parse_status IN ('pending', 'parsing', 'parsed', 'failed')),
  parse_error TEXT,
  -- 解析出的首词/末词 (用于排查跨页断词)
  first_headword TEXT,
  last_headword TEXT,
  UNIQUE(import_id, page_number)
);

-- 3. 词典条目 (从表: 每个 headword 或 phrase 一行)
--    entry_type 区分单词 / 词组, 同层存储
--    meanings 用 JSONB 存多义项 (结构灵活, 覆盖词典复杂格式)
CREATE TABLE IF NOT EXISTS dictionary_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id UUID NOT NULL REFERENCES dictionary_pages(id) ON DELETE CASCADE,
  import_id UUID NOT NULL REFERENCES dictionary_imports(id) ON DELETE CASCADE,
  entry_type TEXT NOT NULL CHECK (entry_type IN ('word', 'phrase')),
  word TEXT NOT NULL, -- headword / 词组文本
  phonetic TEXT, -- IPA 音标 (可为空, 词组通常无)
  part_of_speech TEXT, -- pos: n / v / adj / adv / prep / vt / vi / art / ...
  -- 义项列表, 每项 {idx, en_def, zh_def, examples:[{en, zh, source}]}
  meanings JSONB DEFAULT '[]',
  -- 派生词: [{word, phonetic, pos, zh_meaning}]
  derivatives JSONB DEFAULT '[]',
  -- 附属词组/短语 (从释义内提取): [{phrase, context}]
  phrases JSONB DEFAULT '[]',
  -- 蓝色块标记的例句: [{en, zh, source, type:'gaokao'|'zhushi'|'zhengming'}]
  special_examples JSONB DEFAULT '[]',
  row_order INT NOT NULL DEFAULT 0, -- 页面内顺序, 重建时保序
  review_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (review_status IN ('pending', 'accepted', 'rejected')),
  merged_to_word_id UUID REFERENCES words(id), -- 发布后关联 words 表
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ========== 索引 ==========
CREATE INDEX IF NOT EXISTS idx_dict_imports_user ON dictionary_imports(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_dict_pages_import ON dictionary_pages(import_id, page_number);
CREATE INDEX IF NOT EXISTS idx_dict_entries_page ON dictionary_entries(page_id, row_order);
CREATE INDEX IF NOT EXISTS idx_dict_entries_import ON dictionary_entries(import_id);
CREATE INDEX IF NOT EXISTS idx_dict_entries_word ON dictionary_entries(word);

-- ========== RLS ==========
ALTER TABLE dictionary_imports ENABLE ROW LEVEL SECURITY;
ALTER TABLE dictionary_pages ENABLE ROW LEVEL SECURITY;
ALTER TABLE dictionary_entries ENABLE ROW LEVEL SECURITY;

-- 用户只能看到自己的批次
CREATE POLICY dict_imports_select ON dictionary_imports
  FOR SELECT USING (user_id = auth.uid());
CREATE POLICY dict_imports_insert ON dictionary_imports
  FOR INSERT WITH CHECK (user_id = auth.uid());
CREATE POLICY dict_imports_update ON dictionary_imports
  FOR UPDATE USING (user_id = auth.uid());

CREATE POLICY dict_pages_select ON dictionary_pages
  FOR SELECT USING (import_id IN (
    SELECT id FROM dictionary_imports WHERE user_id = auth.uid()
  ));
CREATE POLICY dict_pages_insert ON dictionary_pages
  FOR INSERT WITH CHECK (import_id IN (
    SELECT id FROM dictionary_imports WHERE user_id = auth.uid()
  ));
CREATE POLICY dict_pages_update ON dictionary_pages
  FOR UPDATE USING (import_id IN (
    SELECT id FROM dictionary_imports WHERE user_id = auth.uid()
  ));

CREATE POLICY dict_entries_select ON dictionary_entries
  FOR SELECT USING (import_id IN (
    SELECT id FROM dictionary_imports WHERE user_id = auth.uid()
  ));
CREATE POLICY dict_entries_insert ON dictionary_entries
  FOR INSERT WITH CHECK (import_id IN (
    SELECT id FROM dictionary_imports WHERE user_id = auth.uid()
  ));
CREATE POLICY dict_entries_update ON dictionary_entries
  FOR UPDATE USING (import_id IN (
    SELECT id FROM dictionary_imports WHERE user_id = auth.uid()
  ));
