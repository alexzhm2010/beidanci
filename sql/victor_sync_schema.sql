-- ============================================================
-- Victor 词库合并 - 数据库结构 (v1.21.0)
-- 1. words 表加富内容字段 (base_word_id / detail / enriched_at)
-- 2. sync_jobs 后端同步任务进度表
-- 3. 进度查询 RPC (供前端轮询, 绕开 RLS)
-- 设计: 底座 vw_* 只读; 用户词库 words 为私有; 富内容以快照形式落在 detail
-- ============================================================

-- ---------- 1. words 加富内容字段 ----------
ALTER TABLE words ADD COLUMN IF NOT EXISTS base_word_id BIGINT;      -- 指向 vw_words.id, NULL=用户自有
ALTER TABLE words ADD COLUMN IF NOT EXISTS detail JSONB;             -- Victor 富内容快照 (senses/examples/notes)
ALTER TABLE words ADD COLUMN IF NOT EXISTS enriched_at BIGINT;       -- 富化时间戳(ms)

CREATE INDEX IF NOT EXISTS idx_words_base_word_id ON words (base_word_id);

-- ---------- 2. 同步任务进度表 ----------
CREATE TABLE IF NOT EXISTS sync_jobs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sync_code     TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending',   -- pending/running/done/failed
  total         INTEGER NOT NULL DEFAULT 0,
  processed     INTEGER NOT NULL DEFAULT 0,
  added         INTEGER NOT NULL DEFAULT 0,
  enriched      INTEGER NOT NULL DEFAULT 0,
  error         TEXT,
  created_at    BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
  updated_at    BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
);
CREATE INDEX IF NOT EXISTS idx_sync_jobs_code ON sync_jobs (sync_code, created_at DESC);

ALTER TABLE sync_jobs ENABLE ROW LEVEL SECURITY;
-- 前端不直接读表, 统一走 RPC; service_role 绕过 RLS

-- ---------- 3. 进度查询 RPC ----------
-- 返回某用户最近一条同步任务; 前端轮询它显示进度 (退出重进仍可查)
CREATE OR REPLACE FUNCTION public.victor_sync_status(p_sync_code TEXT)
RETURNS TABLE (
  id UUID, status TEXT, total INTEGER, processed INTEGER,
  added INTEGER, enriched INTEGER, error TEXT,
  created_at BIGINT, updated_at BIGINT
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT id, status, total, processed, added, enriched, error, created_at, updated_at
  FROM sync_jobs
  WHERE sync_code = p_sync_code
  ORDER BY created_at DESC
  LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION public.victor_sync_status(TEXT) TO anon, authenticated;
