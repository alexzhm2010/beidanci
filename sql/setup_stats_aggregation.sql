-- ============================================================
-- 统计聚合 RPC (v1.11.2 性能优化)
--
-- 问题: 学习页"字母分布" 和 统计页"熟练度饼图" 原先都通过 getLearnedWords()
--       把用户全部已学习词拉到前端再聚合, 词量大时加载很慢。
-- 方案: 用 PostgreSQL RPC 在服务端直接返回聚合结果, 前端只拿几十字节。
--
-- 使用方法:
--   1. 在 Supabase SQL Editor 中执行本脚本
--   2. 前端 db.js 调用 App.DB.getLetterDistribution() / getProficiencyStats()
--   3. 若 RPC 未部署, 前端自动降级到客户端聚合 (兼容旧部署)
-- ============================================================

-- 1. 字母分布: 按首字母 (A-Z + #其他) 统计 total / mastered / unmastered
--    mastered  = known_count / total_count >= 0.80 (与前端 renderLetterStats 口径一致)
--    返回 JSON 数组: [{letter, total, mastered, unmastered}, ...]
CREATE OR REPLACE FUNCTION get_letter_distribution()
RETURNS JSON AS $$
DECLARE
  uid UUID := auth.uid();
  result JSON;
BEGIN
  IF uid IS NULL THEN
    RETURN json_build_object('error', 'not_authenticated');
  END IF;

  SELECT json_agg(row_to_json(t)) INTO result
  FROM (
    SELECT
      letter,
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE ratio >= 0.80) AS mastered,
      COUNT(*) FILTER (WHERE ratio < 0.80) AS unmastered
    FROM (
      SELECT
        CASE
          WHEN word ~ '^[A-Za-z]' THEN UPPER(SUBSTRING(word FROM 1 FOR 1))
          ELSE '#'
        END AS letter,
        CASE
          WHEN total_count > 0 THEN known_count::FLOAT / total_count
          ELSE 0
        END AS ratio
      FROM words
      WHERE user_id = uid
        AND total_count > 0
    ) sub
    GROUP BY letter
    ORDER BY letter
  ) t;

  RETURN COALESCE(result, '[]'::JSON);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 2. 熟练度统计: total / new / learned / mastered 四个计数 + 4 档熟练度分布
--    new       = total_count = 0 (未学习)
--    learned   = total_count > 0 (已学习, 含已掌握)
--    mastered  = known_count / total_count >= 0.80 (已掌握, 学习页字母分布口径 0.80)
--    prof_dist = 4 档分布: [0, 40, 60, 80] 对应 <40%, 40-60%, 60-80%, >=80%
--    返回 JSON: {total, new, learned, mastered, prof_dist: {"0":n, "40":n, "60":n, "80":n}}
CREATE OR REPLACE FUNCTION get_proficiency_stats()
RETURNS JSON AS $$
DECLARE
  uid UUID := auth.uid();
  v_total INT;
  v_new INT;
  v_learned INT;
  v_mastered INT;
  v_p0 INT := 0;
  v_p40 INT := 0;
  v_p60 INT := 0;
  v_p80 INT := 0;
  rec RECORD;
BEGIN
  IF uid IS NULL THEN
    RETURN json_build_object('error', 'not_authenticated');
  END IF;

  SELECT COUNT(*) INTO v_total FROM words WHERE user_id = uid;

  SELECT COUNT(*) INTO v_new
  FROM words WHERE user_id = uid AND total_count = 0;

  SELECT COUNT(*) INTO v_learned
  FROM words WHERE user_id = uid AND total_count > 0;

  SELECT COUNT(*) INTO v_mastered
  FROM words
  WHERE user_id = uid
    AND total_count > 0
    AND known_count::FLOAT / total_count >= 0.80;

  -- 单次扫描统计 4 档熟练度分布 (仅已学习词)
  FOR rec IN
    SELECT known_count, total_count
    FROM words
    WHERE user_id = uid AND total_count > 0
  LOOP
    DECLARE ratio FLOAT;
    BEGIN
      ratio := rec.known_count::FLOAT / rec.total_count;
      IF ratio < 0.4 THEN v_p0 := v_p0 + 1;
      ELSIF ratio < 0.6 THEN v_p40 := v_p40 + 1;
      ELSIF ratio < 0.8 THEN v_p60 := v_p60 + 1;
      ELSE v_p80 := v_p80 + 1;
      END IF;
    END;
  END LOOP;

  RETURN json_build_object(
    'total', v_total,
    'new', v_new,
    'learned', v_learned,
    'mastered', v_mastered,
    'prof_dist', json_build_object('0', v_p0, '40', v_p40, '60', v_p60, '80', v_p80)
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================
-- 索引建议 (可选, 词量大时提升聚合速度)
-- CREATE INDEX IF NOT EXISTS idx_words_user_total ON words(user_id, total_count);
-- ============================================================
