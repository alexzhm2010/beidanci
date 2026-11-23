-- ============================================================
-- 清理历史重复词 (v1.26.0) —— 按「精确词头」合并, 大小写敏感
--
-- 背景: 8月4日批量导入的词表源里, 7 个多义词各占两行(不同义项),
--       导入逻辑无批内去重, 于同一秒写入两条完全同名记录。
--       AD/ad、March/march 是大小写不同的两个独立词, 精确分组不会命中, 自动保留。
--
-- merge_duplicate_words(p_user_id):
--   对每个精确词头重复组:
--     - 保留"学习进度最强"的一条 (stability 最大, 次 total_count 最大, 次最早创建)
--     - 中文释义 = 组内所有不同释义用 '；' 拼接
--     - 其余学习字段沿用保留条 (进度不丢失)
--     - 删除同组其它记录 (含其学习记录关联由前端按 word 文本记录, 不受影响)
-- 幂等: 无重复组时 merged=0。
-- ============================================================

CREATE OR REPLACE FUNCTION public.merge_duplicate_words(p_user_id UUID)
RETURNS TABLE(merged_groups INT, deleted_rows INT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  r RECORD;
  v_keep_id UUID;
  v_meanings TEXT;
  v_deleted INT;
  v_groups INT := 0;
  v_total_deleted INT := 0;
BEGIN
  FOR r IN
    SELECT word FROM words
    WHERE user_id = p_user_id
    GROUP BY word HAVING count(*) > 1
  LOOP
    -- 保留条: 学习进度最强 (stability desc, total_count desc, created_at asc 取最早)
    SELECT id INTO v_keep_id
    FROM words
    WHERE user_id = p_user_id AND word = r.word
    ORDER BY stability DESC, total_count DESC, created_at ASC
    LIMIT 1;

    -- 合并释义: 组内所有非空且不重复的中文释义, 用 '；' 拼接
    SELECT string_agg(DISTINCT chinese_meaning, '；' ORDER BY chinese_meaning)
    INTO v_meanings
    FROM words
    WHERE user_id = p_user_id AND word = r.word
      AND COALESCE(chinese_meaning, '') <> '';

    UPDATE words
    SET chinese_meaning = COALESCE(v_meanings, chinese_meaning),
        updated_at = (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
    WHERE id = v_keep_id;

    DELETE FROM words
    WHERE user_id = p_user_id AND word = r.word AND id <> v_keep_id;
    GET DIAGNOSTICS v_deleted = ROW_COUNT;

    v_groups := v_groups + 1;
    v_total_deleted := v_total_deleted + v_deleted;
  END LOOP;

  RETURN QUERY SELECT v_groups, v_total_deleted;
END;
$$;

GRANT EXECUTE ON FUNCTION public.merge_duplicate_words(UUID) TO anon, authenticated;
