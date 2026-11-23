-- ============================================================
-- Victor 词库合并 - 富化批处理 RPC (v1.21.0)
-- victor_sync_batch: 处理底座 vw_words 的一批 (offset/limit),
--   聚合 vw_senses/vw_examples/vw_notes 生成 detail 快照, 返回本批统计。
--   重复词(同 sync_code 且规范化 word 一致) → 只覆盖内容字段, 保留 SM-2 学习进度
--   底座独有 → 新增到用户词库 (带完整富内容)
-- 由 Edge Function victor-sync 循环调用, 直到 processed < limit。
-- ============================================================

CREATE OR REPLACE FUNCTION public.victor_sync_batch(
  p_sync_code TEXT, p_offset INT, p_limit INT
)
RETURNS TABLE(processed INT, added INT, enriched INT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_now BIGINT := (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT;
  v_processed INT := 0;
  v_added INT := 0;
  v_enriched INT := 0;
BEGIN
  -- 批次富化结果暂存 (会话级临时表)
  CREATE TEMP TABLE _victor_batch ON COMMIT DROP AS
  SELECT
    b.id AS base_id,
    b.headword,
    b.phonetic,
    b.level_tag,
    -- 中文释义: senses.chinese_def 按义项序拼接, 不含例句/短语; 无则回退 inline_def/level_tag
    COALESCE(
      NULLIF(string_agg(s.chinese_def, '；' ORDER BY s.sense_no, s.id)
             FILTER (WHERE s.chinese_def IS NOT NULL AND btrim(s.chinese_def) <> ''), ''),
      NULLIF(btrim(b.inline_def), ''),
      NULLIF(btrim(b.level_tag), ''),
      ''
    ) AS meaning,
    -- 词性: senses.pos 去重拼接
    COALESCE(
      NULLIF(string_agg(DISTINCT s.pos, ' ' ORDER BY s.pos)
             FILTER (WHERE s.pos IS NOT NULL AND btrim(s.pos) <> ''), ''),
      ''
    ) AS pos_text,
    -- 富内容快照 (结构对齐前端 wordCardHtml)
    jsonb_build_object(
      'headword',    b.headword,
      'phonetic',    b.phonetic,
      'level_tag',   b.level_tag,
      'inline_def',  b.inline_def,
      'identity_tag', b.identity_tag,
      'derived_from', b.derived_from,
      'page_no',     b.page_no,
      'senses', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'pos',           ss.pos,
          'sense_no',      ss.sense_no,
          'sense_freq',    ss.sense_freq,
          'countability',  ss.countability,
          'usage_label',   ss.usage_label,
          'chinese_def',   ss.chinese_def,
          'english_def',   ss.english_def,
          'antonym',       ss.antonym,
          'examples', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
              'kind',           e.kind,
              'en',             e.en,
              'zh',             e.zh,
              'gloss',          e.gloss,
              'source',         e.source,
              'parent_phrase',  e.parent_phrase,
              'usage_label',    e.usage_label
            ) ORDER BY e.id)
            FROM vw_examples e WHERE e.sense_id = ss.id
          ), '[]'::jsonb)
        ) ORDER BY ss.sense_no, ss.id)
        FROM vw_senses ss WHERE ss.word_id = b.id
      ), '[]'::jsonb),
      'notes', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'note_type', n.note_type, 'title', n.title, 'content', n.content
        ) ORDER BY n.id)
        FROM vw_notes n WHERE n.word_id = b.id
      ), '[]'::jsonb)
    ) AS detail
  FROM (
    SELECT * FROM vw_words
    ORDER BY id
    OFFSET p_offset LIMIT p_limit
  ) b
  LEFT JOIN vw_senses s ON s.word_id = b.id
  GROUP BY b.id, b.headword, b.phonetic, b.level_tag, b.inline_def,
           b.identity_tag, b.derived_from, b.page_no;

  SELECT count(*) INTO v_processed FROM _victor_batch;

  -- 重复词: 已有用户词 → 只覆盖内容字段, 保留 SM-2 学习进度
  UPDATE words uw
     SET detail       = vb.detail,
         chinese_meaning = CASE WHEN vb.meaning <> '' THEN vb.meaning ELSE uw.chinese_meaning END,
         part_of_speech  = CASE WHEN vb.pos_text <> '' THEN vb.pos_text ELSE uw.part_of_speech END,
         phonetic     = CASE WHEN COALESCE(vb.phonetic,'') <> '' THEN vb.phonetic ELSE uw.phonetic END,
         base_word_id = vb.base_id,
         enriched_at  = v_now,
         updated_at   = v_now
    FROM (
      SELECT DISTINCT ON (lower(btrim(headword))) *
      FROM _victor_batch
      ORDER BY lower(btrim(headword)), base_id
    ) vb
   WHERE uw.sync_code = p_sync_code
     AND lower(btrim(uw.word)) = lower(btrim(vb.headword));
  GET DIAGNOSTICS v_enriched = ROW_COUNT;

  -- 底座独有: 用户词库没有 → 新增 (带完整富内容, SM-2 从 0 开始)
  INSERT INTO words (
    sync_code, word, phonetic, part_of_speech, chinese_meaning,
    detail, base_word_id, enriched_at,
    total_count, known_count, stability, next_review_at,
    familiar_at, familiar_next_at, created_at, updated_at
  )
  SELECT
    p_sync_code, vb.headword, COALESCE(vb.phonetic,''), COALESCE(vb.pos_text,''),
    COALESCE(vb.meaning,''), vb.detail, vb.base_id, v_now,
    0, 0, 0, 0, 0, 0, v_now, v_now
  FROM (
    SELECT DISTINCT ON (lower(btrim(headword))) *
    FROM _victor_batch
    ORDER BY lower(btrim(headword)), base_id
  ) vb
  WHERE NOT EXISTS (
    SELECT 1 FROM words uw
    WHERE uw.sync_code = p_sync_code
      AND lower(btrim(uw.word)) = lower(btrim(vb.headword))
  );
  GET DIAGNOSTICS v_added = ROW_COUNT;

  RETURN QUERY SELECT v_processed, v_added, v_enriched;
END;
$$;

GRANT EXECUTE ON FUNCTION public.victor_sync_batch(TEXT, INT, INT) TO anon, authenticated;
