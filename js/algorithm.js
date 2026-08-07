/**
 * 复习算法 (SM-2 遗忘曲线改进版)
 *
 * 核心思想:
 *   1. 每个已学单词维护一个"稳定度"(stability) = 当前记忆能维持的时长
 *   2. 下次到期时间 = 上次学习时间 + 稳定度
 *   3. 认识 → 稳定度变长 (越熟越久再见)
 *   4. 不认识 → 稳定度大幅缩短 (尽快重考)
 *   5. 选词: 优先到期词 + 超期兜底词 + 同优先级随机抽样, 避免死循环
 *
 * 字段:
 *   - stability (ms): 记忆稳定度, 即"再过多久该复习"
 *   - nextReviewAt (ms): 下次到期时间戳
 *   - lastLearnTime (ms): 上次学习时间戳
 *   - lastKnownTime (ms): 上次"认识"时间戳
 *   - knownCount / totalCount: 熟练度统计
 */
window.App = window.App || {};
App.Algorithm = (function () {
  var C = function () { return App.Config; };

  // ==================== 稳定度 & 间隔计算 ====================

  /**
   * 获取单词当前的稳定度 (ms)
   * 新词默认 0, 学过至少 1 次的取 word.stability
   */
  function getStability(word) {
    return word.stability || 0;
  }

  /**
   * 获取下次到期时间戳
   * - 未学过的新词: 立即可学 (返回 0)
   * - 已学过: lastLearnTime + stability
   */
  function getNextReviewAt(word) {
    if (!word.totalCount || word.totalCount === 0) return 0;
    if (word.nextReviewAt) return word.nextReviewAt;
    // 兼容老数据
    return (word.lastLearnTime || 0) + getStability(word);
  }

  /**
   * 判断是否到期 (该复习了)
   */
  function isDue(word) {
    return Date.now() >= getNextReviewAt(word);
  }

  /**
   * 计算超期程度 (0 = 刚到期, 越大越紧急)
   */
  function getOverdueScore(word) {
    var nextAt = getNextReviewAt(word);
    var overdue = Date.now() - nextAt;
    if (overdue <= 0) return 0;
    // 用对数压缩, 避免长期没学的词权重过大
    return Math.log10(overdue / 60000 + 1) + 1; // 1 分钟 → 1, 1 小时 ≈ 1.78, 1 天 ≈ 3.36
  }

  // ==================== 答题后更新稳定度 ====================

  /**
   * 学习一次后更新单词统计和稳定度
   * @param {Object} word - 单词对象
   * @param {boolean} isKnown - 是否认识
   * @returns {Object} 更新后的单词对象
   */
  function updateWordStats(word, isKnown) {
    var cfg = C();
    var now = Date.now();
    var oldStability = getStability(word);

    word.totalCount = (word.totalCount || 0) + 1;

    if (isKnown) {
      word.knownCount = (word.knownCount || 0) + 1;
      word.lastKnownTime = now;

      // 稳定度增长规则 (SM-2 思路):
      //   第一次认识: 用初始间隔
      //   之后每次认识: 旧稳定度 * 放大倍数
      //   若上次不认识导致稳定度被砍, 这次认识恢复一部分 (不会暴涨)
      var newStability;
      if (oldStability === 0) {
        newStability = cfg.REVIEW_INTERVAL_INIT;
      } else {
        newStability = oldStability * cfg.REVIEW_INTERVAL_FACTOR;
      }
      // 不超过上限
      if (newStability > cfg.REVIEW_INTERVAL_MAX) newStability = cfg.REVIEW_INTERVAL_MAX;
      word.stability = newStability;
    } else {
      // 不认识: 稳定度大幅衰减
      var decayed = oldStability * cfg.REVIEW_STABILITY_DECAY;
      // 不低于最小重考间隔, 让用户 1 分钟后再见
      if (decayed < cfg.REVIEW_INTERVAL_MIN_FAIL) decayed = cfg.REVIEW_INTERVAL_MIN_FAIL;
      word.stability = decayed;
    }

    // 下次到期 = 现在 + 新稳定度
    word.nextReviewAt = now + word.stability;
    word.lastLearnTime = now;
    word.updatedAt = now;
    return word;
  }

  // ==================== 选词逻辑 ====================

  /**
   * 从单词列表中选取新词 (未学习过的)
   * 按创建时间排序 (先添加的先学)
   */
  function selectNewWords(allWords, count) {
    var newWords = allWords
      .filter(function (w) { return !w.totalCount || w.totalCount === 0; })
      .sort(function (a, b) { return (a.createdAt || 0) - (b.createdAt || 0); });
    return newWords.slice(0, count);
  }

  /**
   * 从单词列表中选取复习词
   * 策略 (三层保障, 优先级从高到低):
   *   1. 强制兜底: 超过 N 天没学过的词, 优先占名额, 不参与抽样
   *      → 保证"长期轮不上"的词一定会出现
   *   2. 到期词: 按"超期程度"分桶 + 桶内随机抽样
   *      → 越紧急越优先, 同等紧急随机选, 避免固定顺序
   *   3. 未到期补足: 仍不够 count 时, 用"最接近到期"的词补齐
   *      → 让用户永远有词可复习
   */
  function selectReviewWords(allWords, count) {
    var cfg = C();
    var now = Date.now();
    var fallbackThreshold = now - cfg.REVIEW_FALLBACK_INTERVAL;

    // 只考虑已学过的词
    var learned = allWords.filter(function (w) {
      return w.totalCount && w.totalCount > 0;
    });

    // 分类: 强制兜底 / 到期 / 未到期
    var forceReview = [];   // 超过 N 天没学的, 一定进队列
    var dueWords = [];      // 已到期
    var notDueWords = [];   // 未到期, 候补

    learned.forEach(function (w) {
      var lastLearn = w.lastLearnTime || 0;
      var nextAt = getNextReviewAt(w);
      if (lastLearn < fallbackThreshold) {
        forceReview.push(w);
      } else if (now >= nextAt) {
        dueWords.push(w);
      } else {
        notDueWords.push(w);
      }
    });

    var result = [];

    // 1. 强制兜底词优先占名额 (随机抽取, 不参与抽样, 保证一定出现)
    if (forceReview.length > 0) {
      shuffle(forceReview);
      var forceTake = Math.min(forceReview.length, count);
      for (var i = 0; i < forceTake; i++) {
        result.push(forceReview[i]);
      }
    }

    // 2. 剩余名额从到期词中按优先级 + 随机抽样
    if (result.length < count && dueWords.length > 0) {
      var remaining = count - result.length;
      var dueCandidates;
      if (dueWords.length > remaining) {
        dueCandidates = sampleByPriority(dueWords, remaining);
      } else {
        dueCandidates = dueWords;
      }
      for (var j = 0; j < dueCandidates.length; j++) {
        result.push(dueCandidates[j]);
      }
    }

    // 3. 还不够, 用最接近到期的未到期词补足
    if (result.length < count && notDueWords.length > 0) {
      notDueWords.sort(function (a, b) {
        return getNextReviewAt(a) - getNextReviewAt(b);
      });
      for (var k = 0; k < notDueWords.length && result.length < count; k++) {
        result.push(notDueWords[k]);
      }
    }

    return result.slice(0, count);
  }

  /**
   * 按优先级分组 + 组内随机抽样
   * 把候选按超期分数分桶, 桶内打乱, 优先取高分组
   */
  function sampleByPriority(candidates, count) {
    var ratio = C().REVIEW_RANDOM_RATIO;
    // 分桶: 超期分四舍五入作为组别
    var buckets = {};
    candidates.forEach(function (w) {
      var score = getOverdueScore(w);
      var key = Math.floor(score); // 0,1,2,3...
      if (!buckets[key]) buckets[key] = [];
      buckets[key].push(w);
    });

    // 按组别从高到低处理
    var keys = Object.keys(buckets).sort(function (a, b) { return Number(b) - Number(a); });
    var result = [];
    for (var i = 0; i < keys.length; i++) {
      var bucket = buckets[keys[i]];
      shuffle(bucket);
      var remaining = count - result.length;
      var isLastBucket = (i === keys.length - 1);
      // 非最后桶: 限制每组最多取 count*ratio, 留名额给低优先级组
      // 最后桶: 不再限制 ratio, 兜底取够所需 (避免单桶时取不够)
      var take = isLastBucket
        ? Math.min(bucket.length, remaining)
        : Math.min(bucket.length, Math.ceil(count * ratio), remaining);
      for (var j = 0; j < take; j++) {
        result.push(bucket[j]);
      }
      if (result.length >= count) break;
    }
    return result;
  }

  function shuffle(arr) {
    for (var i = arr.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      arr[i] = arr[j] = arr[i], arr[j] = arr[j];
    }
  }

  // ==================== 展示辅助 ====================

  /**
   * 计算熟练度 (0~1)
   */
  function getProficiency(word) {
    if (!word || !word.totalCount || word.totalCount === 0) return 0;
    return word.knownCount / word.totalCount;
  }

  /**
   * 获取熟练度等级文本
   */
  function getProficiencyLabel(word) {
    var p = getProficiency(word);
    if (p === 0) return '未学';
    if (p < 0.4) return '生疏';
    if (p < 0.7) return '熟悉';
    if (p < 0.9) return '熟练';
    return '掌握';
  }

  // ==================== 导出 ====================

  return {
    getStability: getStability,
    getNextReviewAt: getNextReviewAt,
    isDue: isDue,
    getOverdueScore: getOverdueScore,
    updateWordStats: updateWordStats,
    selectNewWords: selectNewWords,
    selectReviewWords: selectReviewWords,
    getProficiency: getProficiency,
    getProficiencyLabel: getProficiencyLabel,
  };
})();
