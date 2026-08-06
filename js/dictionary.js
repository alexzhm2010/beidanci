/**
 * 词典API模块
 * 策略: 先查免费词典API(音标/词性/例句), 再查翻译API(中文释义)
 * 注意: 纯前端受CORS限制, 部分接口可能不可用, 失败时用户手动填写
 *
 * API限制说明:
 *   - dictionaryapi.dev: 无明确限流, fair use
 *   - MyMemory翻译: 匿名5000字符/天/IP, 带email 50000字符/天, 建议每分钟≤10次
 * 防护措施:
 *   - 并发降到 3 (每批最多 3 个词 = 6 个请求, 低于建议频率)
 *   - 429/5xx 指数退避重试 (最多 2 次)
 *   - 连续 3 次限流则提前终止, 避免继续轰炸
 *   - 失败词列表返回给调用方, 便于用户知晓
 */
window.App = window.App || {};
App.Dictionary = (function () {

  var FREE_DICT_API = 'https://api.dictionaryapi.dev/api/v2/entries/en/';
  var TRANSLATE_API = 'https://api.mymemory.translated.net/get';
  var MAX_RETRY = 2;           // 429/5xx 最多重试次数
  var RATE_LIMIT_THRESHOLD = 3; // 连续限流次数达到此值则终止

  // 词性英文→缩写映射
  var POS_MAP = {
    'noun': 'n.',
    'verb': 'v.',
    'adjective': 'adj.',
    'adverb': 'adv.',
    'pronoun': 'pron.',
    'preposition': 'prep.',
    'conjunction': 'conj.',
    'interjection': 'interj.',
    'determiner': 'det.',
    'exclamation': 'excl.',
  };

  /**
   * 带 429/5xx 重试的 fetch
   * @returns {Promise<Response|null>} 限流终止时返回 null
   */
  async function fetchWithRetry(url, signal) {
    var backoff = 1000; // 首次退避 1s
    for (var attempt = 0; attempt <= MAX_RETRY; attempt++) {
      try {
        var resp = await fetch(url, { signal: signal });
        // 429 或 5xx: 退避重试
        if (resp.status === 429 || resp.status >= 500) {
          if (attempt < MAX_RETRY) {
            await sleep(backoff);
            backoff *= 2; // 指数退避: 1s → 2s
            continue;
          }
        }
        return resp;
      } catch (e) {
        // 网络错误: 重试
        if (attempt < MAX_RETRY) {
          await sleep(backoff);
          backoff *= 2;
          continue;
        }
        throw e;
      }
    }
    return null;
  }

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  /**
   * 查询单个单词, 返回 { word, phonetic, partOfSpeech, chineseMeaning, exampleSentence }
   */
  async function lookup(word, signal) {
    var result = {
      word: word,
      phonetic: '',
      partOfSpeech: '',
      chineseMeaning: '',
      exampleSentence: '',
    };

    // 策略1: 免费词典API — 音标、词性、例句
    try {
      var resp = await fetchWithRetry(FREE_DICT_API + encodeURIComponent(word.toLowerCase()), signal);
      if (resp && resp.ok) {
        var data = await resp.json();
        if (Array.isArray(data) && data.length > 0) {
          var posSet = [];
          var exampleFound = '';

          for (var ei = 0; ei < data.length; ei++) {
            var entry = data[ei];

            if (!result.phonetic) {
              if (entry.phonetic) {
                result.phonetic = entry.phonetic;
              } else if (entry.phonetics && entry.phonetics.length > 0) {
                var ph = entry.phonetics.find(function (p) { return p.text; });
                if (ph && ph.text) result.phonetic = ph.text;
              }
            }

            if (entry.meanings && entry.meanings.length > 0) {
              for (var mi = 0; mi < entry.meanings.length; mi++) {
                var m = entry.meanings[mi];
                if (m.partOfSpeech) {
                  var posAbbr = POS_MAP[m.partOfSpeech] || m.partOfSpeech;
                  if (posSet.indexOf(posAbbr) === -1) posSet.push(posAbbr);
                }
                if (!exampleFound && m.definitions && m.definitions.length > 0) {
                  for (var di = 0; di < m.definitions.length; di++) {
                    if (m.definitions[di].example) {
                      exampleFound = m.definitions[di].example;
                      break;
                    }
                  }
                }
              }
            }
          }

          if (posSet.length > 0) result.partOfSpeech = posSet.join(' / ');
          if (exampleFound) result.exampleSentence = exampleFound;
        }
      }
    } catch (e) {
      // 词典API失败不影响翻译, 静默继续
    }

    // 策略2: 中文释义 — 优先有道词典(多释义), 降级 MyMemory(取多候选)
    // 先试有道: 返回 web_trans 包含多个翻译候选
    try {
      var ydResp = await fetchWithRetry('https://dict.youdao.com/jsonapi?q=' + encodeURIComponent(word), signal);
      if (ydResp && ydResp.ok) {
        var ydData = await ydResp.json();
        // 从 web_trans 提取多释义
        if (ydData.web_trans && ydData.web_trans['web-translation']) {
          var wtList = ydData.web_trans['web-translation'];
          var meanings = [];
          for (var wi = 0; wi < wtList.length && meanings.length < 5; wi++) {
            var wt = wtList[wi];
            // 只取 key 等于原词的翻译组 (跳过短语)
            if (wt.key && wt.key.toLowerCase() === word.toLowerCase() && wt.trans) {
              for (var ti = 0; ti < wt.trans.length && meanings.length < 5; ti++) {
                var val = wt.trans[ti].value;
                // 过滤: 包含中文、不等于原词、去重
                if (val && /[\u4e00-\u9fa5]/.test(val) && meanings.indexOf(val) === -1) {
                  meanings.push(val);
                }
              }
            }
          }
          if (meanings.length > 0) {
            result.chineseMeaning = meanings.join('；');
          }
        }
      }
    } catch (e) {
      // 有道失败 (可能CORS), 降级到 MyMemory
    }

    // 有道没拿到释义, 用 MyMemory 多候选
    if (!result.chineseMeaning) {
      try {
        var params = new URLSearchParams({ q: word, langpair: 'en|zh-CN' });
        var email = App.Config.TRANSLATE_API_EMAIL;
        if (email) params.set('de', email);
        var resp2 = await fetchWithRetry(TRANSLATE_API + '?' + params.toString(), signal);
        if (resp2 && resp2.ok) {
          var data2 = await resp2.json();
          // 从 matches 数组提取多个翻译候选 (去重, 取前3)
          var translations = [];
          if (data2.matches && Array.isArray(data2.matches)) {
            for (var mi2 = 0; mi2 < data2.matches.length && translations.length < 3; mi2++) {
              var t = data2.matches[mi2].translation;
              if (t && t !== word && /[\u4e00-\u9fa5]/.test(t) && translations.indexOf(t) === -1) {
                translations.push(t);
              }
            }
          }
          // 兜底: 用 responseData.translatedText
          if (translations.length === 0 && data2.responseData && data2.responseData.translatedText) {
            var t0 = data2.responseData.translatedText;
            if (t0 && t0 !== word && /[\u4e00-\u9fa5]/.test(t0)) translations.push(t0);
          }
          if (translations.length > 0) {
            result.chineseMeaning = translations.join('；');
          }
        }
      } catch (e) {
        // 翻译API失败, 静默继续
      }
    }

    return result;
  }

  /**
   * 批量查询, 有限并发 + 进度回调 + 限流保护
   * 策略:
   *   - 每批 CONCURRENCY 个单词并发, 批间小延迟 (避免触发限流)
   *   - 检测连续限流, 达到阈值提前终止
   *   - 返回 { results, failed, aborted }
   * @param {string[]} words
   * @param {function} onProgress - (current, total, failed) => void
   * @returns {Promise<{results: Array, failed: string[], aborted: boolean}>}
   */
  var CONCURRENCY = 3;          // 并发数: 3 词 × 2 API = 6 请求/批, 低于 MyMemory 建议 10次/分
  var BATCH_DELAY = 300;       // 批间延迟 ms

  async function lookupBatch(words, onProgress) {
    var results = new Array(words.length);
    var failed = [];
    var consecutiveRateLimited = 0;
    var aborted = false;

    for (var i = 0; i < words.length; i += CONCURRENCY) {
      // 限流保护: 连续多次限流则终止
      if (aborted) break;

      var batch = [];
      for (var j = 0; j < CONCURRENCY && i + j < words.length; j++) {
        batch.push(processWord(words, results, failed, i + j));
      }
      await Promise.all(batch);

      // 检查本批是否有限流 (通过 results 中的空值判断)
      var batchEnd = Math.min(i + CONCURRENCY, words.length);
      for (var k = i; k < batchEnd; k++) {
        var r = results[k];
        var isEmpty = r && !r.phonetic && !r.partOfSpeech && !r.chineseMeaning && !r.exampleSentence;
        if (isEmpty) {
          consecutiveRateLimited++;
          if (consecutiveRateLimited >= RATE_LIMIT_THRESHOLD) {
            aborted = true;
            break;
          }
        } else {
          consecutiveRateLimited = 0;
        }
      }

      var completed = Math.min(i + CONCURRENCY, words.length);
      if (onProgress) onProgress(completed, words.length, failed.length);

      // 批间小延迟, 减少限流风险
      if (i + CONCURRENCY < words.length && !aborted) {
        await sleep(BATCH_DELAY);
      }
    }

    // 未处理的词标记为失败
    for (var m = 0; m < results.length; m++) {
      if (!results[m]) {
        failed.push(words[m]);
        results[m] = {
          word: words[m],
          phonetic: '',
          partOfSpeech: '',
          chineseMeaning: '',
          exampleSentence: '',
        };
      }
    }

    return { results: results, failed: failed, aborted: aborted };
  }

  // 查询单个单词并写入 results 对应位置
  async function processWord(words, results, failed, index) {
    try {
      results[index] = await lookup(words[index]);
      // 检查是否完全空 (所有字段都为空视为失败)
      var r = results[index];
      var isEmpty = !r.phonetic && !r.partOfSpeech && !r.chineseMeaning && !r.exampleSentence;
      if (isEmpty) failed.push(words[index]);
    } catch (e) {
      results[index] = {
        word: words[index],
        phonetic: '',
        partOfSpeech: '',
        chineseMeaning: '',
        exampleSentence: '',
      };
      failed.push(words[index]);
    }
  }

  return { lookup: lookup, lookupBatch: lookupBatch };
})();
