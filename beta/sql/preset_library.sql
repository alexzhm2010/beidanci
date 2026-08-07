-- ============================================================
-- 预置词库功能 - 数据库脚本
-- 目标: 控制数据库规模膨胀, 所有用户共享全局词库
-- 执行: Supabase SQL Editor
-- ============================================================

-- 1. 全局共享词库表 (所有用户共用, ~4500 行固定)
CREATE TABLE IF NOT EXISTS word_library (
    word TEXT PRIMARY KEY,
    phonetic TEXT DEFAULT '',
    part_of_speech TEXT DEFAULT '',
    chinese_meaning TEXT NOT NULL DEFAULT '',
    example_sentence TEXT DEFAULT '',
    tags TEXT[] NOT NULL DEFAULT '{}',
    created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT * 1000
);

-- 按标签查询索引
CREATE INDEX IF NOT EXISTS idx_word_library_tags ON word_library USING GIN(tags);

-- 2. 扩展 words 表: 增加 source 字段区分预置/自定义词
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name='words' AND column_name='source'
    ) THEN
        ALTER TABLE words ADD COLUMN source TEXT DEFAULT 'custom';
    END IF;
END $$;

-- source 字段索引
CREATE INDEX IF NOT EXISTS idx_words_source ON words(source);
CREATE INDEX IF NOT EXISTS idx_words_sync_source ON words(sync_code, source);

-- ============================================================
-- RPC 函数
-- ============================================================

-- 3. 按标签获取预置词 (带用户已学进度信息)
CREATE OR REPLACE FUNCTION get_preset_words_by_tag(
    p_tag TEXT,
    p_limit INT,
    p_sync_code TEXT
) RETURNS SETOF jsonb
LANGUAGE plpgsql
AS $$
DECLARE
    v_offset INT;
    v_total INT;
BEGIN
    -- 统计该标签词总数
    SELECT COUNT(*) INTO v_total
    FROM word_library
    WHERE tags @> ARRAY[p_tag]::TEXT[];

    IF v_total = 0 THEN
        RETURN;
    END IF;

    -- 随机偏移 (避免每次都是同样的词)
    v_offset := FLOOR(RANDOM() * GREATEST(v_total - p_limit, 0))::INT;

    RETURN QUERY
    SELECT jsonb_build_object(
        'word', wl.word,
        'phonetic', COALESCE(wl.phonetic, ''),
        'partOfSpeech', COALESCE(wl.part_of_speech, ''),
        'meaning', COALESCE(wl.chinese_meaning, ''),
        'chineseMeaning', COALESCE(wl.chinese_meaning, ''),
        'exampleSentence', COALESCE(wl.example_sentence, ''),
        'tags', wl.tags,
        'source', 'preset',
        'totalCount', COALESCE(w.total_count, 0),
        'knownCount', COALESCE(w.known_count, 0),
        'stability', COALESCE(w.stability, 0),
        'nextReviewAt', COALESCE(w.next_review_at, 0),
        'lastLearnTime', COALESCE(w.last_learn_time, null),
        'lastKnownTime', COALESCE(w.last_known_time, null),
        'wordId', w.id
    )
    FROM word_library wl
    LEFT JOIN words w
        ON w.word = wl.word
        AND w.sync_code = p_sync_code
    WHERE wl.tags @> ARRAY[p_tag]::TEXT[]
    ORDER BY wl.word
    LIMIT p_limit
    OFFSET v_offset;
END;
$$;

-- 4. 保存单词进度 (预置词只存进度到 words 表, 不重复存文本)
CREATE OR REPLACE FUNCTION save_word_with_source(
    p_sync_code TEXT,
    p_word TEXT,
    p_source TEXT DEFAULT 'preset',
    p_phonetic TEXT DEFAULT '',
    p_part_of_speech TEXT DEFAULT '',
    p_chinese_meaning TEXT DEFAULT '',
    p_example_sentence TEXT DEFAULT '',
    p_total_count INT DEFAULT 0,
    p_known_count INT DEFAULT 0,
    p_last_known_time BIGINT DEFAULT NULL,
    p_last_learn_time BIGINT DEFAULT NULL,
    p_stability BIGINT DEFAULT 0,
    p_next_review_at BIGINT DEFAULT 0
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
    v_id TEXT;
    v_now BIGINT;
    v_result jsonb;
BEGIN
    v_now := EXTRACT(EPOCH FROM NOW())::BIGINT * 1000;

    -- 查找该用户是否已有此词的进度记录
    SELECT id INTO v_id
    FROM words
    WHERE sync_code = p_sync_code AND word = p_word;

    IF v_id IS NOT NULL THEN
        -- 更新已有进度
        UPDATE words SET
            total_count = p_total_count,
            known_count = p_known_count,
            last_known_time = p_last_known_time,
            last_learn_time = p_last_learn_time,
            stability = p_stability,
            next_review_at = p_next_review_at,
            updated_at = v_now
        WHERE id = v_id;
    ELSE
        -- 新增记录
        v_id := gen_random_uuid()::TEXT;

        IF p_source = 'preset' THEN
            -- 预置词: 不存中文文本, 仅存进度 + source 标记
            INSERT INTO words (
                id, sync_code, word, phonetic, part_of_speech,
                chinese_meaning, example_sentence,
                total_count, known_count, last_known_time, last_learn_time,
                stability, next_review_at, source, created_at, updated_at
            ) VALUES (
                v_id, p_sync_code, p_word, '', '', '', '',
                p_total_count, p_known_count, p_last_known_time, p_last_learn_time,
                p_stability, p_next_review_at, 'preset', v_now, v_now
            );
        ELSE
            -- 自定义词: 存完整文本
            INSERT INTO words (
                id, sync_code, word, phonetic, part_of_speech,
                chinese_meaning, example_sentence,
                total_count, known_count, last_known_time, last_learn_time,
                stability, next_review_at, source, created_at, updated_at
            ) VALUES (
                v_id, p_sync_code, p_word,
                COALESCE(p_phonetic, ''),
                COALESCE(p_part_of_speech, ''),
                COALESCE(p_chinese_meaning, ''),
                COALESCE(p_example_sentence, ''),
                p_total_count, p_known_count, p_last_known_time, p_last_learn_time,
                p_stability, p_next_review_at, 'custom', v_now, v_now
            );
        END IF;
    END IF;

    SELECT jsonb_build_object(
        'id', v_id,
        'word', p_word,
        'source', p_source,
        'totalCount', p_total_count,
        'knownCount', p_known_count,
        'stability', p_stability,
        'nextReviewAt', p_next_review_at
    ) INTO v_result;

    RETURN v_result;
END;
$$;

-- 5. 获取指定词库级别的学习统计
CREATE OR REPLACE FUNCTION get_library_stats(
    p_tag TEXT,
    p_sync_code TEXT
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
    v_total INT;
    v_learned INT;
    v_due INT;
    v_now BIGINT;
BEGIN
    v_now := EXTRACT(EPOCH FROM NOW())::BIGINT * 1000;

    -- 该词库总词数
    SELECT COUNT(*) INTO v_total
    FROM word_library
    WHERE tags @> ARRAY[p_tag]::TEXT[];

    -- 用户已学 (total_count > 0)
    SELECT COUNT(*) INTO v_learned
    FROM word_library wl
    INNER JOIN words w ON w.word = wl.word AND w.sync_code = p_sync_code
    WHERE wl.tags @> ARRAY[p_tag]::TEXT[]
      AND w.total_count > 0;

    -- 到期待复习 (next_review_at <= now 且已学过)
    SELECT COUNT(*) INTO v_due
    FROM word_library wl
    INNER JOIN words w ON w.word = wl.word AND w.sync_code = p_sync_code
    WHERE wl.tags @> ARRAY[p_tag]::TEXT[]
      AND w.total_count > 0
      AND (w.next_review_at IS NULL OR w.next_review_at <= v_now);

    RETURN jsonb_build_object(
        'total', COALESCE(v_total, 0),
        'learned', COALESCE(v_learned, 0),
        'due', COALESCE(v_due, 0),
        'level', p_tag
    );
END;
$$;

-- ============================================================
-- RLS 行级安全 (保持与现有策略一致)
-- ============================================================
ALTER TABLE word_library ENABLE ROW LEVEL SECURITY;

-- 所有人可读 word_library (全局共享)
DROP POLICY IF EXISTS "word_library readable by all" ON word_library;
CREATE POLICY "word_library readable by all"
    ON word_library FOR SELECT
    USING (true);

-- 打印完成提示
DO $$
BEGIN
    RAISE NOTICE '预置词库数据库脚本执行完成!';
    RAISE NOTICE '请在 word_library 表中导入预置词数据 (tags: primary/junior/senior/cet4)';
END $$;
