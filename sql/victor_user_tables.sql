-- ============================================================
-- Victor 词库数据表 100% 照搬为 beidanci 用户私有表 (v1.24.0)
-- 废弃 detail JSONB 快照: 富内容改为结构化四表存储, 与 Victor 底座 vw_* 字段完全一致。
-- 同步时把 vw_* 整份复制到 uw_* (按 sync_code 用户归属), 每用户一份拷贝。
-- 复合主键 (sync_code, id): 底座 id 原样保留, 多用户互不冲突。
-- 复合外键维持 vw_words -> vw_senses -> vw_examples / vw_notes 的父子关系,
--   PostgREST 据此自动支持嵌套查询 (uw_words(...,uw_senses(...,uw_examples(...)),uw_notes(...)))。
-- 幂等可重复执行。
-- ============================================================

-- ---------- 1. 词条表 (照搬 vw_words 全部字段) ----------
CREATE TABLE IF NOT EXISTS public.uw_words (
  sync_code      TEXT NOT NULL,
  id             BIGINT NOT NULL,
  book_id        TEXT,
  headword       TEXT NOT NULL,
  phonetic       TEXT,
  audio          BOOLEAN DEFAULT FALSE,
  level_tag      TEXT,
  inline_def     TEXT,
  countability   TEXT,
  source         TEXT,
  page_no        INTEGER,
  batch_id       BIGINT,
  created_at     TIMESTAMPTZ DEFAULT now(),
  partial        BOOLEAN DEFAULT FALSE,
  identity_tag   TEXT,
  freq_level     SMALLINT,
  derived_from   TEXT,
  parent_word_id BIGINT,
  tags           TEXT[] DEFAULT '{}',
  PRIMARY KEY (sync_code, id)
);
CREATE INDEX IF NOT EXISTS idx_uw_words_headword ON public.uw_words (sync_code, headword);
CREATE INDEX IF NOT EXISTS idx_uw_words_book ON public.uw_words (sync_code, book_id);

-- ---------- 2. 义项表 (照搬 vw_senses 全部字段) ----------
CREATE TABLE IF NOT EXISTS public.uw_senses (
  sync_code    TEXT NOT NULL,
  id           BIGINT NOT NULL,
  word_id      BIGINT NOT NULL,
  pos          TEXT,
  sense_no     INTEGER,
  countability TEXT,
  usage_label  TEXT,
  chinese_def  TEXT,
  antonym      TEXT,
  english_def  TEXT,
  sense_freq   SMALLINT,
  PRIMARY KEY (sync_code, id),
  FOREIGN KEY (sync_code, word_id) REFERENCES public.uw_words(sync_code, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_uw_senses_word ON public.uw_senses (sync_code, word_id);

-- ---------- 3. 例句/搭配表 (照搬 vw_examples 全部字段) ----------
CREATE TABLE IF NOT EXISTS public.uw_examples (
  sync_code     TEXT NOT NULL,
  id            BIGINT NOT NULL,
  sense_id      BIGINT NOT NULL,
  parent_phrase TEXT,
  kind          TEXT DEFAULT 'sentence',
  usage_label   TEXT,
  en            TEXT,
  zh            TEXT,
  gloss         TEXT,
  source        TEXT,
  PRIMARY KEY (sync_code, id),
  FOREIGN KEY (sync_code, sense_id) REFERENCES public.uw_senses(sync_code, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_uw_examples_sense ON public.uw_examples (sync_code, sense_id);

-- ---------- 4. 蓝底标签框表 (照搬 vw_notes 全部字段) ----------
CREATE TABLE IF NOT EXISTS public.uw_notes (
  sync_code  TEXT NOT NULL,
  id         BIGINT NOT NULL,
  word_id    BIGINT NOT NULL,
  note_type  TEXT NOT NULL,
  title      TEXT,
  content    TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (sync_code, id),
  FOREIGN KEY (sync_code, word_id) REFERENCES public.uw_words(sync_code, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_uw_notes_word ON public.uw_notes (sync_code, word_id);

-- ---------- 5. RLS: 开放读取 (前端按 sync_code 过滤, 与现有 words 表模式一致) ----------
ALTER TABLE public.uw_words    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.uw_senses   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.uw_examples ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.uw_notes    ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "uw public read words" ON public.uw_words;
DROP POLICY IF EXISTS "uw public read senses" ON public.uw_senses;
DROP POLICY IF EXISTS "uw public read examples" ON public.uw_examples;
DROP POLICY IF EXISTS "uw public read notes" ON public.uw_notes;
CREATE POLICY "uw public read words"    ON public.uw_words    FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "uw public read senses"   ON public.uw_senses   FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "uw public read examples" ON public.uw_examples FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "uw public read notes"    ON public.uw_notes    FOR SELECT TO anon, authenticated USING (true);

-- 完成
