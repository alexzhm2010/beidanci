-- ============================================================
-- Victor 词库整份复制 RPC (v1.24.0)
-- victor_copy_batch(p_sync_code, p_offset, p_limit):
--   把底座 vw_* 的一批词条连同 senses/examples/notes 整份复制到用户私有 uw_*。
--   复合主键 (sync_code, id), 底座 id 原样保留; 先删后插保证幂等。
--   返回 processed = 本批处理的词条数。
-- 由 Edge Function victor-sync 循环调用, 直到 processed < limit。
-- ============================================================

CREATE OR REPLACE FUNCTION public.victor_copy_batch(
  p_sync_code TEXT, p_offset INT, p_limit INT
)
RETURNS TABLE(processed INT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_processed INT := 0;
BEGIN
  -- 批次底座词条 id (按 id 稳定排序, offset 分页)
  CREATE TEMP TABLE _copy_words ON COMMIT DROP AS
    SELECT id FROM vw_words ORDER BY id OFFSET p_offset LIMIT p_limit;

  SELECT count(*) INTO v_processed FROM _copy_words;
  IF v_processed = 0 THEN
    RETURN QUERY SELECT 0;
    RETURN;
  END IF;

  -- 1) 先删该用户这批词的旧数据 (外键级联清掉 senses/examples/notes)
  DELETE FROM uw_words w
    USING _copy_words c
    WHERE w.sync_code = p_sync_code AND w.id = c.id;

  -- 2) 复制词条 (字段 100% 照搬 vw_words)
  INSERT INTO uw_words (
    sync_code, id, book_id, headword, phonetic, audio, level_tag, inline_def,
    countability, source, page_no, batch_id, created_at, partial,
    identity_tag, freq_level, derived_from, parent_word_id, tags
  )
  SELECT
    p_sync_code, w.id, w.book_id, w.headword, w.phonetic, w.audio, w.level_tag, w.inline_def,
    w.countability, w.source, w.page_no, w.batch_id, w.created_at, w.partial,
    w.identity_tag, w.freq_level, w.derived_from, w.parent_word_id, w.tags
  FROM vw_words w
  JOIN _copy_words c ON c.id = w.id;

  -- 3) 复制义项 (只复制本批词下属的 senses)
  INSERT INTO uw_senses (
    sync_code, id, word_id, pos, sense_no, countability, usage_label,
    chinese_def, antonym, english_def, sense_freq
  )
  SELECT
    p_sync_code, s.id, s.word_id, s.pos, s.sense_no, s.countability, s.usage_label,
    s.chinese_def, s.antonym, s.english_def, s.sense_freq
  FROM vw_senses s
  JOIN _copy_words c ON c.id = s.word_id;

  -- 4) 复制例句 (本批 senses 下属的 examples)
  INSERT INTO uw_examples (
    sync_code, id, sense_id, parent_phrase, kind, usage_label, en, zh, gloss, source
  )
  SELECT
    p_sync_code, e.id, e.sense_id, e.parent_phrase, e.kind, e.usage_label, e.en, e.zh, e.gloss, e.source
  FROM vw_examples e
  JOIN vw_senses s ON s.id = e.sense_id
  JOIN _copy_words c ON c.id = s.word_id;

  -- 5) 复制蓝底标签框 (本批词下属的 notes)
  INSERT INTO uw_notes (
    sync_code, id, word_id, note_type, title, content, created_at
  )
  SELECT
    p_sync_code, n.id, n.word_id, n.note_type, n.title, n.content, n.created_at
  FROM vw_notes n
  JOIN _copy_words c ON c.id = n.word_id;

  RETURN QUERY SELECT v_processed;
END;
$$;

GRANT EXECUTE ON FUNCTION public.victor_copy_batch(TEXT, INT, INT) TO anon, authenticated;
