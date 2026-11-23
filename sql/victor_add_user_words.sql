-- ============================================================
-- Victor 独有词补入用户词表 RPC (v1.25.0)
-- victor_add_user_words(p_user_id UUID):
--   把底座 vw_words 中「该用户 words 表尚不存在」的词头 (按小写去重匹配)
--   补进用户自己的 words 表, 归属 p_user_id, 带基础中文释义 (取 vw_senses 首条)。
--
-- 设计要点:
--   - 清单主体始终是用户自己的 words 表 (原词一个不动、不删)
--   - 匹配上的词 (用户已有): 不动 words 行, 富内容由 uw_* 按词头 join 提供
--   - 底座独有的词 (用户没有): 新增 words 行, 这样词库列表能看到它们
--   - 小写去重: 底座存在大小写重复的 3 个词头, distinct on 取一条
--   - 幂等: 反复调用只会补缺失的, 已存在的不再插入
-- 返回 inserted = 本次新增词条数。
-- ============================================================

CREATE OR REPLACE FUNCTION public.victor_add_user_words(p_user_id UUID)
RETURNS TABLE(inserted INT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_inserted INT := 0;
BEGIN
  -- 校验用户
  IF p_user_id IS NULL THEN
    RETURN QUERY SELECT 0;
    RETURN;
  END IF;

  INSERT INTO words (
    id, user_id, sync_code, word, phonetic, part_of_speech, chinese_meaning,
    total_count, known_count, stability, next_review_at,
    familiar_at, familiar_next_at, created_at, updated_at,
    base_word_id, enriched_at
  )
  SELECT
    gen_random_uuid(), p_user_id, 'default',
    v.headword, COALESCE(v.phonetic, ''),
    '',
    COALESCE(
      (SELECT s.chinese_def FROM vw_senses s
        WHERE s.word_id = v.id AND COALESCE(s.chinese_def, '') <> ''
        ORDER BY s.sense_no, s.id LIMIT 1),
      COALESCE(v.inline_def, '')
    ),
    0, 0, 0, 0, 0, 0,
    (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
    (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
    v.id,
    (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
  FROM (
    -- 底座词头按小写去重, 取 id 最小的一条
    SELECT DISTINCT ON (lower(headword)) id, headword, phonetic, inline_def
    FROM vw_words
    ORDER BY lower(headword), id
  ) v
  WHERE NOT EXISTS (
    SELECT 1 FROM words w
    WHERE w.user_id = p_user_id AND lower(w.word) = lower(v.headword)
  );

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RETURN QUERY SELECT v_inserted;
END;
$$;

GRANT EXECUTE ON FUNCTION public.victor_add_user_words(UUID) TO anon, authenticated;
