/**
 * Supabase 数据层 (v1.9.0 安全加固版)
 *
 * v1.9.0 变更:
 *   - 用户隔离从 "sync_code 前端软隔离" 升级为 "Supabase Auth JWT + RLS auth.uid()=user_id 强隔离"
 *   - 所有业务请求 (words/records) 带 access_token 让 RLS 生效, anon key 仅用于未登录的 RPC
 *   - access_token 过期自动刷新 (401 → refresh → 重试)
 *
 * 通过 REST API (PostgREST) 操作云端数据库
 * 对外 API 与 IndexedDB 版本完全一致, 其他模块无需修改
 */
window.App = window.App || {};
App.DB = (function () {

  // ========== UUID 生成 (兼容非 HTTPS 环境) ==========
  function _uuid() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }

  // ========== 字段名转换 (camelCase <-> snake_case) ==========

  function wordToRow(w) {
    return {
      id: w.id || _uuid(),
      user_id: w.userId || getUserId(),   // v1.9.0: sync_code → user_id
      word: w.word || '',
      phonetic: w.phonetic || '',
      part_of_speech: w.partOfSpeech || '',
      chinese_meaning: w.chineseMeaning || '',
      example_sentence: w.exampleSentence || '',
      total_count: w.totalCount || 0,
      known_count: w.knownCount || 0,
      last_known_time: w.lastKnownTime || null,
      last_learn_time: w.lastLearnTime || null,
      stability: w.stability || 0,
      next_review_at: w.nextReviewAt || 0,
      created_at: w.createdAt || Date.now(),
      updated_at: Date.now(),
    };
  }

  function rowToWord(r) {
    if (!r) return null;
    return {
      id: r.id,
      userId: r.user_id,                    // v1.9.0: user_id (sync_code 兼容字段保留为旧值)
      syncCode: r.sync_code,               // 向后兼容 (历史字段, 新数据不再写)
      word: r.word,
      phonetic: r.phonetic || '',
      partOfSpeech: r.part_of_speech || '',
      chineseMeaning: r.chinese_meaning || '',
      exampleSentence: r.example_sentence || '',
      totalCount: r.total_count || 0,
      knownCount: r.known_count || 0,
      lastKnownTime: r.last_known_time || null,
      lastLearnTime: r.last_learn_time || null,
      stability: r.stability || 0,
      nextReviewAt: r.next_review_at || 0,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  function recordToRow(rec) {
    return {
      id: rec.id || _uuid(),
      user_id: rec.userId || getUserId(),   // v1.9.0: sync_code → user_id
      word_id: rec.wordId || null,
      word: rec.word || '',
      direction: rec.direction || '',
      is_known: rec.isKnown,
      session_type: rec.sessionType || '',
      timestamp: rec.timestamp || Date.now(),
    };
  }

  function rowToRecord(r) {
    if (!r) return null;
    return {
      id: r.id,
      userId: r.user_id,
      syncCode: r.sync_code,                // 向后兼容
      wordId: r.word_id,
      word: r.word,
      direction: r.direction,
      isKnown: r.is_known,
      sessionType: r.session_type,
      timestamp: r.timestamp,
    };
  }

  // ========== Supabase Auth 会话管理 (v1.9.0 新增) ==========

  /** 当前登录用户的 Supabase Auth uid (RLS 强隔离核心) */
  function getUserId() {
    return localStorage.getItem(App.Config.KEY_UID) || null;
  }

  function getAccessToken() {
    return localStorage.getItem(App.Config.KEY_ACCESS_TOKEN) || null;
  }

  function getRefreshToken() {
    return localStorage.getItem(App.Config.KEY_REFRESH_TOKEN) || null;
  }

  /** 登录成功后存储会话 (auth.js 调用) */
  function setAuthSession(uid, accessToken, refreshToken) {
    if (uid) localStorage.setItem(App.Config.KEY_UID, uid);
    if (accessToken) localStorage.setItem(App.Config.KEY_ACCESS_TOKEN, accessToken);
    if (refreshToken) localStorage.setItem(App.Config.KEY_REFRESH_TOKEN, refreshToken);
  }

  /** 退出登录时清除会话 (auth.js 调用) */
  function clearAuthSession() {
    localStorage.removeItem(App.Config.KEY_UID);
    localStorage.removeItem(App.Config.KEY_ACCESS_TOKEN);
    localStorage.removeItem(App.Config.KEY_REFRESH_TOKEN);
  }

  // access_token 刷新锁 (并发 401 只刷新一次, 其他请求等待)
  var _refreshingPromise = null;

  /**
   * 用 refresh_token 换新的 access_token
   * @returns {Promise<boolean>} 刷新是否成功
   */
  async function _refreshAccessToken() {
    // 已有正在进行的刷新, 复用其 Promise
    if (_refreshingPromise) return _refreshingPromise;

    var refreshToken = getRefreshToken();
    if (!refreshToken) return false;

    _refreshingPromise = (async function () {
      try {
        var resp = await fetch(
          App.DBConfig.getUrl().replace(/\/+$/, '') + '/auth/v1/token?grant_type=refresh_token',
          {
            method: 'POST',
            headers: {
              'apikey': App.DBConfig.getKey(),
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ refresh_token: refreshToken }),
          }
        );
        if (!resp.ok) return false;
        var data = await resp.json();
        if (data && data.access_token) {
          localStorage.setItem(App.Config.KEY_ACCESS_TOKEN, data.access_token);
          if (data.refresh_token) localStorage.setItem(App.Config.KEY_REFRESH_TOKEN, data.refresh_token);
          if (data.user && data.user.id) localStorage.setItem(App.Config.KEY_UID, data.user.id);
          return true;
        }
        return false;
      } catch (e) {
        console.error('[DB] 刷新 access_token 失败:', e);
        return false;
      } finally {
        _refreshingPromise = null;
      }
    })();
    return _refreshingPromise;
  }

  // ========== Supabase REST 请求封装 ==========

  /** 当前请求应使用的 Bearer token: 登录后用 access_token (RLS 生效), 未登录用 anon key (RPC 场景) */
  function _bearerToken() {
    return getAccessToken() || App.DBConfig.getKey();
  }

  /**
   * 业务请求封装 (words/records 直查, 受 RLS 约束)
   * 401 时自动刷新 token 并重试一次; 刷新失败抛错由上层处理登出
   */
  async function api(method, table, query, body, options) {
    var url = App.DBConfig.getRestUrl() + table;
    if (query) url += '?' + query;

    function buildHeaders() {
      var headers = {
        'apikey': App.DBConfig.getKey(),
        'Authorization': 'Bearer ' + _bearerToken(),
        'Content-Type': 'application/json',
      };
      var preferParts = [];
      if (body) {
        preferParts.push('return=representation');
        if (options && options.upsert) preferParts.push('resolution=merge-duplicates');
      }
      if (options && options.count) preferParts.push('count=' + options.count);
      if (preferParts.length > 0) headers['Prefer'] = preferParts.join(', ');
      if (method === 'HEAD' && options && options.count) headers['Range'] = '0-0';
      return headers;
    }

    async function doFetch() {
      var resp = await fetch(url, {
        method: method,
        headers: buildHeaders(),
        body: body ? JSON.stringify(body) : undefined,
      });

      // 401 → 刷新 token 并重试一次
      if (resp.status === 401 && getRefreshToken()) {
        var refreshed = await _refreshAccessToken();
        if (refreshed) {
          // 重建请求头 (含新 token) 重试一次
          var resp2 = await fetch(url, {
            method: method,
            headers: buildHeaders(),
            body: body ? JSON.stringify(body) : undefined,
          });
          return resp2;
        }
        // 刷新失败: 清会话, 由上层引导重新登录
        clearAuthSession();
        throw new Error('登录已过期, 请重新登录');
      }
      return resp;
    }

    var resp = await doFetch();

    if (!resp.ok) {
      var err = {};
      try {
        var text = await resp.text();
        err = text ? JSON.parse(text) : {};
      } catch (e) {
        err = { message: 'HTTP ' + resp.status };
      }
      throw new Error(err.message || ('HTTP ' + resp.status));
    }

    if (options && options.returnResponse) return resp;
    if (method === 'HEAD') return resp;
    if (resp.status === 204) return null;

    var text = await resp.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch (e) {
      throw new Error('Invalid JSON response');
    }
  }

  /** 从响应的 Content-Range 头中提取总数 */
  function extractTotalFromRange(resp) {
    if (!resp || !resp.headers) return 0;
    var range = resp.headers.get('content-range') || '';
    var parts = range.split('/');
    if (parts.length >= 2) {
      var total = parseInt(parts[1], 10);
      return isNaN(total) ? 0 : total;
    }
    return 0;
  }

  /**
   * 并发分页拉取 (先用 count=exact 拿总数, 再并发拉取所有页)
   * 相比串行 while 循环, 可将 N 页的等待时间从 N×T 降到约 ceil(N/concurrency)×T
   */
  async function fetchAllPages(table, base, rowMapper, pageSize, concurrency) {
    pageSize = pageSize || 1000;
    concurrency = concurrency || 5;

    var firstResp = await api('GET', table, base + '&limit=' + pageSize + '&offset=0',
      null, { returnResponse: true, count: 'exact' });
    var firstRows = await firstResp.json();
    var total = extractTotalFromRange(firstResp);
    var all = [];
    for (var i = 0; i < firstRows.length; i++) all.push(rowMapper(firstRows[i]));

    if (total <= pageSize || firstRows.length < pageSize) return all;

    var totalPages = Math.ceil(total / pageSize);
    var offsets = [];
    for (var p = 1; p < totalPages; p++) offsets.push(p * pageSize);

    for (var b = 0; b < offsets.length; b += concurrency) {
      var batch = offsets.slice(b, b + concurrency);
      var batchResults = await Promise.all(batch.map(function (off) {
        return api('GET', table, base + '&limit=' + pageSize + '&offset=' + off);
      }));
      batchResults.forEach(function (rows) {
        if (rows) {
          for (var j = 0; j < rows.length; j++) all.push(rowMapper(rows[j]));
        }
      });
    }
    return all;
  }

  /** 分页计数 (后备方案: 当 Content-Range 不可用时使用) */
  async function countByPaging(filter) {
    var uid = getUserId();
    if (!uid) return 0;
    var base = 'user_id=eq.' + encodeURIComponent(uid);
    if (filter) base += '&' + filter;
    base += '&select=id';
    var PAGE = 1000;
    var count = 0;
    var offset = 0;
    while (true) {
      var rows = await api('GET', 'words', base + '&limit=' + PAGE + '&offset=' + offset);
      if (!rows || rows.length === 0) break;
      count += rows.length;
      if (rows.length < PAGE) break;
      offset += PAGE;
    }
    return count;
  }

  // ========== 初始化 ==========

  async function init() {
    if (!App.DBConfig.isConfigured()) {
      var err = new Error('SUPABASE_NOT_CONFIGURED');
      err.code = 'SUPABASE_NOT_CONFIGURED';
      throw err;
    }
  }

  // ========== 用户名 (展示用, 兼容旧 badge) ==========

  /** 返回当前用户名 (展示用, 非隔离凭证) */
  function getSyncCode() {
    return localStorage.getItem(App.Config.KEY_USERNAME)
      || localStorage.getItem(App.Config.KEY_SYNC_CODE)
      || App.Config.DEFAULT_SYNC_CODE;
  }

  function setSyncCode(code) {
    if (!code || !code.trim()) return;
    localStorage.setItem(App.Config.KEY_SYNC_CODE, code.trim());
    localStorage.setItem(App.Config.KEY_USERNAME, code.trim());
  }

  // ========== 单词操作 ==========

  /** 添加或覆盖单个单词 */
  async function addWord(word) {
    var row = wordToRow(word);
    var result = await api('POST', 'words', null, [row]);
    return rowToWord(result[0]);
  }

  /** 更新单词 */
  async function updateWord(word) {
    word.updatedAt = Date.now();
    var row = wordToRow(word);
    var result = await api('PATCH', 'words', 'id=eq.' + encodeURIComponent(word.id), row);
    return rowToWord(result[0]);
  }

  /** 删除单词 */
  async function deleteWord(id) {
    await api('DELETE', 'words', 'id=eq.' + encodeURIComponent(id));
  }

  /** 按ID获取单词 */
  async function getWord(id) {
    var rows = await api('GET', 'words', 'id=eq.' + encodeURIComponent(id));
    return rowToWord(rows[0]);
  }

  /** 获取当前用户名下所有单词 (并发分页) */
  async function getAllWords() {
    var uid = getUserId();
    var base = 'user_id=eq.' + encodeURIComponent(uid) + '&order=created_at.asc';
    return await fetchAllPages('words', base, rowToWord);
  }

  /** 获取新词 (未学习过的, 从不同位置随机抽取) */
  async function getNewWords(count) {
    var uid = getUserId();
    var uidEnc = encodeURIComponent(uid);
    var baseFilter = 'user_id=eq.' + uidEnc + '&total_count=eq.0';

    var total = 0;
    try {
      var countResp = await api('GET', 'words',
        baseFilter + '&select=id&limit=1',
        null, { returnResponse: true, count: 'exact' });
      total = extractTotalFromRange(countResp);
    } catch (e) {}
    if (!total) total = await countByPaging('total_count=eq.0');
    if (total === 0) return [];

    if (total <= count * 3) {
      var rows = await api('GET', 'words', baseFilter + '&order=created_at.asc&limit=' + total);
      if (!rows) return [];
      var words = rows.map(rowToWord);
      shuffleArray(words);
      return words.slice(0, count);
    }

    var BATCHES = 4;
    var perBatch = Math.max(Math.ceil(count / BATCHES) + 3, 8);
    var promises = [];
    for (var b = 0; b < BATCHES; b++) {
      var fetchSize = Math.min(perBatch, total);
      var maxOffset = Math.max(total - fetchSize, 1);
      var offset = Math.floor(Math.random() * maxOffset);
      var params = baseFilter + '&order=created_at.asc&limit=' + fetchSize + '&offset=' + offset;
      promises.push(api('GET', 'words', params).catch(function () { return null; }));
    }
    var results = await Promise.all(promises);

    var allWords = [];
    var seen = {};
    for (var r = 0; r < results.length; r++) {
      if (!results[r]) continue;
      for (var i = 0; i < results[r].length; i++) {
        var w = rowToWord(results[r][i]);
        if (!seen[w.id]) { seen[w.id] = true; allWords.push(w); }
      }
    }
    if (allWords.length === 0) return [];

    shuffleArray(allWords);
    return allWords.slice(0, count);
  }

  function shuffleArray(arr) {
    for (var i = arr.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
    }
  }

  /** 获取复习候选词 (已学习过的, 按下次复习时间排序) */
  async function getReviewCandidates(count) {
    var uid = getUserId();
    var limit = Math.min(count * 3, 500);
    var params = 'user_id=eq.' + encodeURIComponent(uid) +
      '&total_count=gt.0' +
      '&order=next_review_at.asc.nullsfirst' +
      '&limit=' + limit;
    var rows = await api('GET', 'words', params);
    if (!rows) return [];

    var words = rows.map(rowToWord);
    words.sort(function (a, b) {
      return getNextReviewTime(a) - getNextReviewTime(b);
    });
    return words;
  }

  function getNextReviewTime(word) {
    if (App.Algorithm && App.Algorithm.getNextReviewAt) {
      return App.Algorithm.getNextReviewAt(word);
    }
    if (!word.totalCount || word.totalCount === 0) return 0;
    if (word.nextReviewAt && word.nextReviewAt > 0) return word.nextReviewAt;
    return (word.lastLearnTime || 0) + (word.stability || 0);
  }

  /** 获取单词总数 */
  async function getWordCount() {
    var uid = getUserId();
    try {
      var resp = await api('GET', 'words',
        'user_id=eq.' + encodeURIComponent(uid) + '&limit=1',
        null, { returnResponse: true, count: 'exact' });
      var total = extractTotalFromRange(resp);
      if (total > 0) return total;
    } catch (e) {}
    return await countByPaging('');
  }

  async function getNewWordCount() {
    var uid = getUserId();
    try {
      var resp = await api('GET', 'words',
        'user_id=eq.' + encodeURIComponent(uid) + '&total_count=eq.0&limit=1',
        null, { returnResponse: true, count: 'exact' });
      var total = extractTotalFromRange(resp);
      if (total > 0) return total;
    } catch (e) {}
    return await countByPaging('total_count=eq.0');
  }

  async function getLearnedWordCount() {
    var uid = getUserId();
    try {
      var resp = await api('GET', 'words',
        'user_id=eq.' + encodeURIComponent(uid) + '&total_count=gt.0&limit=1',
        null, { returnResponse: true, count: 'exact' });
      var total = extractTotalFromRange(resp);
      if (total > 0) return total;
    } catch (e) {}
    return await countByPaging('total_count=gt.0');
  }

  async function getMasteredWordCount() {
    var uid = getUserId();
    var params = 'user_id=eq.' + encodeURIComponent(uid) +
      '&total_count=gt.0' +
      '&select=known_count,total_count';
    var PAGE = 1000;
    var count = 0;
    var offset = 0;
    while (true) {
      var rows = await api('GET', 'words', params + '&limit=' + PAGE + '&offset=' + offset);
      if (!rows || rows.length === 0) break;
      for (var i = 0; i < rows.length; i++) {
        var r = rows[i];
        if (r.known_count && r.total_count && r.known_count / r.total_count >= 0.85) count++;
      }
      if (rows.length < PAGE) break;
      offset += PAGE;
    }
    return count;
  }

  /** 获取已学习的单词 (total_count > 0) */
  async function getLearnedWords(limit) {
    var uid = getUserId();
    var base = 'user_id=eq.' + encodeURIComponent(uid) +
      '&total_count=gt.0' +
      '&order=last_learn_time.desc';

    if (!limit) return await fetchAllPages('words', base, rowToWord);

    var PAGE = 1000;
    var offset = 0;
    var all = [];
    var hardCap = limit;
    while (all.length < hardCap) {
      var take = Math.min(PAGE, hardCap - all.length);
      var rows = await api('GET', 'words', base + '&limit=' + take + '&offset=' + offset);
      if (!rows || rows.length === 0) break;
      for (var i = 0; i < rows.length; i++) all.push(rowToWord(rows[i]));
      if (rows.length < take) break;
      offset += take;
    }
    return all;
  }

  /** 搜索单词 (空查询时按熟练度升序, 支持分页) */
  async function searchWords(query, offset, limit) {
    var q = (query || '').trim().toLowerCase();
    offset = offset || 0;
    limit = limit || App.Config.SEARCH_MAX_ROWS;

    if (!q) {
      var uid = getUserId();
      var base = 'user_id=eq.' + encodeURIComponent(uid);
      var words = await fetchAllPages('words', base, rowToWord);
      words.sort(function (a, b) {
        var pa = a.totalCount > 0 ? a.knownCount / a.totalCount : 0;
        var pb = b.totalCount > 0 ? b.knownCount / b.totalCount : 0;
        if (pa !== pb) return pa - pb;
        return (a.createdAt || 0) - (b.createdAt || 0);
      });
      return { words: words.slice(offset, offset + limit), total: words.length };
    }

    var uid = getUserId();
    var qEnc = encodeURIComponent(q);
    var orFilter = 'or=(word.ilike.*' + qEnc + '*,chinese_meaning.ilike.*' + qEnc + '*)';
    var base = 'user_id=eq.' + encodeURIComponent(uid) + '&' + orFilter;

    var words = await fetchAllPages('words', base, rowToWord);
    words.sort(function (a, b) {
      var pa = a.totalCount > 0 ? a.knownCount / a.totalCount : 0;
      var pb = b.totalCount > 0 ? b.knownCount / b.totalCount : 0;
      if (pa !== pb) return pa - pb;
      return (a.createdAt || 0) - (b.createdAt || 0);
    });
    return { words: words.slice(offset, offset + limit), total: words.length };
  }

  /** 批量导入: mode = 'overwrite' | 'incremental' */
  async function addWordsBatch(words, mode) {
    var uid = getUserId();

    if (mode === 'overwrite') {
      // clear_user_data 现基于 auth.uid() (RPC 内部取 JWT uid, 不再传 sync_code)
      await rpc('clear_user_data', {});
    }

    var existingMap = {};
    if (mode === 'incremental') {
      var uidEnc = encodeURIComponent(uid);
      var PAGE = 1000;
      var offset = 0;
      while (true) {
        var rows = await api('GET', 'words',
          'user_id=eq.' + uidEnc +
          '&select=id,word,total_count,known_count,last_known_time,last_learn_time,stability,next_review_at,created_at' +
          '&order=created_at.asc&limit=' + PAGE + '&offset=' + offset);
        if (!rows || rows.length === 0) break;
        for (var r = 0; r < rows.length; r++) {
          existingMap[rows[r].word.toLowerCase()] = rows[r];
        }
        if (rows.length < PAGE) break;
        offset += PAGE;
      }
    }

    var rowsToWrite = words.map(function (w) {
      var key = (w.word || '').toLowerCase();
      var old = existingMap[key];
      if (old) {
        return {
          id: old.id,
          user_id: uid,
          word: w.word,
          phonetic: w.phonetic || '',
          part_of_speech: w.partOfSpeech || '',
          chinese_meaning: w.chineseMeaning || '',
          example_sentence: w.exampleSentence || '',
          total_count: old.total_count || 0,
          known_count: old.known_count || 0,
          last_known_time: old.last_known_time || null,
          last_learn_time: old.last_learn_time || null,
          stability: old.stability || 0,
          next_review_at: old.next_review_at || 0,
          created_at: old.created_at,
          updated_at: Date.now(),
        };
      }
      return wordToRow(w);
    });

    var BATCH = 500;
    for (var i = 0; i < rowsToWrite.length; i += BATCH) {
      var batch = rowsToWrite.slice(i, i + BATCH);
      await api('POST', 'words', null, batch, { upsert: true });
    }
    return rowsToWrite.length;
  }

  // ========== 学习记录 ==========

  async function addRecord(record) {
    var row = recordToRow(record);
    await api('POST', 'records', null, [row]);
    return rowToRecord(row);
  }

  async function getRecords(startDate, endDate) {
    var uid = getUserId();
    var base = 'user_id=eq.' + encodeURIComponent(uid);
    if (startDate) base += '&timestamp=gte.' + startDate;
    if (endDate) base += '&timestamp=lt.' + endDate;
    base += '&order=timestamp.desc';
    return await fetchAllPages('records', base, rowToRecord);
  }

  async function getAllRecords() {
    var uid = getUserId();
    var base = 'user_id=eq.' + encodeURIComponent(uid) + '&order=timestamp.desc';
    return await fetchAllPages('records', base, rowToRecord);
  }

  // ========== 清空操作 (RPC: clear_user_data 基于 auth.uid()) ==========

  async function clearWords() {
    await rpc('clear_user_data', {});
  }

  async function clearAll() {
    await rpc('clear_user_data', {});
  }

  /** 按单词文本精确查找 (不区分大小写) */
  async function findWordByText(wordText) {
    var uid = getUserId();
    var params = 'user_id=eq.' + encodeURIComponent(uid) +
      '&word=ilike.' + encodeURIComponent(wordText.trim());
    var rows = await api('GET', 'words', params);
    if (!rows || rows.length === 0) return null;
    return rowToWord(rows[0]);
  }

  // ========== 导出 ==========

  async function exportAll() {
    return {
      username: getSyncCode(),
      userId: getUserId(),
      words: await getAllWords(),
      records: await getAllRecords(),
      exportedAt: Date.now(),
    };
  }

  // ========== 授权系统数据库操作 (全部 RPC, 不直接访问表) ==========

  /** 调用 Supabase RPC 函数 (SECURITY DEFINER, 不受 RLS 限制); 401 自动刷新重试 */
  async function rpc(funcName, params) {
    var url = App.DBConfig.getRestUrl() + 'rpc/' + funcName;
    function buildHeaders() {
      return {
        'apikey': App.DBConfig.getKey(),
        'Authorization': 'Bearer ' + _bearerToken(),
        'Content-Type': 'application/json',
      };
    }
    var resp = await fetch(url, {
      method: 'POST',
      headers: buildHeaders(),
      body: JSON.stringify(params || {}),
    });
    // 401 → 刷新 token 重试一次 (与 api() 一致, 保证 RPC 在 token 过期时自愈)
    if (resp.status === 401 && getRefreshToken()) {
      var refreshed = await _refreshAccessToken();
      if (refreshed) {
        resp = await fetch(url, {
          method: 'POST',
          headers: buildHeaders(),
          body: JSON.stringify(params || {}),
        });
      } else {
        clearAuthSession();
        throw new Error('登录已过期, 请重新登录');
      }
    }
    if (!resp.ok) {
      var text = await resp.text();
      throw new Error(text || ('RPC ' + funcName + ' failed: HTTP ' + resp.status));
    }
    var body = await resp.text();
    if (!body) return null;
    try { return JSON.parse(body); } catch (e) { return body; }
  }

  /** 注册用户 (先 supabase signUp 拿 uid, 再调此 RPC 存密保 + 绑 user_id) */
  async function registerUser(username, passwordHash, secQuestion, secAnswerHash, userId) {
    var result = await rpc('register_user', {
      p_username: username,
      p_pwd_hash: passwordHash,
      p_sec_question: secQuestion,
      p_sec_answer_hash: secAnswerHash,
      p_user_id: userId || null,
    });
    if (!result || !result.success) {
      var err = (result && result.error === 'exists') ? '用户名已存在' : '注册失败';
      throw new Error(err);
    }
  }

  /** 绑定 user_auth.user_id (注册第二步, 失败可重试) */
  async function linkUserId(username, userId) {
    var result = await rpc('link_user_id', { p_username: username, p_user_id: userId });
    if (!result || !result.success) {
      throw new Error((result && result.error) || '绑定 user_id 失败');
    }
  }

  /** 查询用户是否已迁移到 Supabase Auth (登录流程用) */
  async function getMigrationStatus(username) {
    var result = await rpc('get_user_migration_status', { p_username: username });
    return result || { success: false, migrated: false };
  }

  async function verifyLogin(username, passwordHash) {
    var result = await rpc('verify_login', { p_username: username, p_pwd_hash: passwordHash });
    return result || { success: false, error: 'unknown' };
  }

  async function usernameExists(username) {
    return await rpc('username_exists', { p_username: username });
  }

  async function getSecQuestion(username) {
    return await rpc('get_sec_question', { p_username: username });
  }

  async function verifySecAnswer(username, answerHash) {
    return await rpc('verify_sec_answer', {
      p_username: username,
      p_sec_answer_hash: answerHash,
    });
  }

  /**
   * 重置密码 (v1.9.0: 改走 update-password Edge Function, 同步更新 bcrypt + 旧哈希)
   * @param username 用户名
   * @param newPassword 新密码明文
   * @param newPwdHash 新密码 SHA-256(username+pwd+salt)
   * @param secAnswerHash 密保答案 SHA-256 (找回密码校验用)
   */
  async function resetPassword(username, newPassword, newPwdHash, secAnswerHash) {
    var result = await callEdgeFunction('UPDATE_PASSWORD_URL', {
      username: username,
      new_password: newPassword,
      new_pwd_hash: newPwdHash,
      verify_type: 'sec_answer',
      verify_value: secAnswerHash,
    });
    if (!result || !result.success) {
      var err = (result && result.error && result.error.indexOf('sec_answer') >= 0) ? '密保答案错误' : '重置失败';
      throw new Error(err);
    }
  }

  /** 获取用户信息 (RPC, Profile 展示用) */
  async function getUserAuthInfo(username) {
    var result = await rpc('get_user_auth_info', { p_username: username });
    if (!result) return null;
    return {
      username: result.username,
      secQuestion: result.sec_question,
      createdAt: result.created_at,
    };
  }

  /**
   * 修改密码 (v1.9.0: 改走 update-password Edge Function, 同步更新 bcrypt + 旧哈希)
   * @param username 用户名
   * @param oldPassword 旧密码明文
   * @param newPassword 新密码明文
   * @param oldPwdHash 旧密码 SHA-256 (校验用)
   * @param newPwdHash 新密码 SHA-256 (写入 user_auth)
   */
  async function changePassword(username, oldPassword, newPassword, oldPwdHash, newPwdHash) {
    var result = await callEdgeFunction('UPDATE_PASSWORD_URL', {
      username: username,
      new_password: newPassword,
      new_pwd_hash: newPwdHash,
      verify_type: 'password',
      verify_value: oldPwdHash,
    });
    if (!result || !result.success) {
      var err = (result && result.error && (result.error.indexOf('wrong') >= 0 || result.error.indexOf('原密码') >= 0)) ? '原密码错误' : '修改失败';
      throw new Error(err);
    }
  }

  /** 修改密保问题 (RPC, 需密码验证; 仅改 user_auth, 不涉及 bcrypt) */
  async function changeSecQuestion(username, pwdHash, secQuestion, secAnswerHash) {
    var result = await rpc('change_sec_question', {
      p_username: username,
      p_pwd_hash: pwdHash,
      p_sec_question: secQuestion,
      p_sec_answer_hash: secAnswerHash,
    });
    if (!result || !result.success) {
      var err = (result && result.error === 'wrong_password') ? '密码错误' : '修改失败';
      throw new Error(err);
    }
  }

  async function getAuthorization(username) {
    var result = await rpc('get_user_authorization', { p_username: username });
    if (!result) return null;
    return {
      username: result.username,
      status: result.status,
      authorizedAt: result.authorized_at,
      expiresAt: result.expires_at,
      note: result.note,
    };
  }

  async function getPromoConfig() {
    var rows = await api('GET', 'admin_config',
      'key=in.(promo_amount,promo_years,promo_text)');
    var config = {};
    if (rows) rows.forEach(function (r) { config[r.key] = r.value; });
    return {
      amount: config.promo_amount || '20',
      years: config.promo_years || '1',
      text: config.promo_text || '捐赠20元得1年使用权',
    };
  }

  async function getPayOrderStatus(outTradeNo) {
    return await rpc('get_pay_order_status', { p_out_trade_no: outTradeNo });
  }

  async function getUnreadMessages(username) {
    var readRows = await api('GET', 'user_read_messages',
      'username=eq.' + encodeURIComponent(username) + '&select=message_id');
    var readIds = (readRows || []).map(function (r) { return r.message_id; });

    var allMessages = await api('GET', 'admin_messages',
      'status=eq.active&order=created_at.desc');
    if (!allMessages) return [];

    return allMessages.filter(function (m) {
      return readIds.indexOf(m.id) === -1;
    }).map(function (m) {
      return { id: m.id, title: m.title, content: m.content, createdAt: m.created_at };
    });
  }

  async function markMessageRead(username, messageId) {
    var body = { username: username, message_id: messageId };
    await api('POST', 'user_read_messages', null, body);
  }

  // ========== Edge Function 调用 (v1.9.0: migrate-user / update-password) ==========

  /** 调用 Edge Function (config.js EDGE_FUNCTIONS 里的 key) */
  async function callEdgeFunction(configKey, payload) {
    var url = (App.Config.EDGE_FUNCTIONS && App.Config.EDGE_FUNCTIONS[configKey]) || '';
    if (!url) throw new Error('Edge Function 未配置: ' + configKey);
    var resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {}),
    });
    var text = await resp.text();
    var data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
    if (!resp.ok) {
      var msg = (data && data.error) ? data.error : ('HTTP ' + resp.status);
      throw new Error(msg);
    }
    return data;
  }

  /** 老用户迁移 (前端登录流程调用: 建 Supabase Auth 账号 + 回填 user_id) */
  async function migrateUser(username, password, pwdHash) {
    return await callEdgeFunction('MIGRATE_USER_URL', {
      username: username,
      password: password,
      pwd_hash: pwdHash,
    });
  }

  // ========== 导出 ==========

  return {
    init: init,
    // 会话 (v1.9.0)
    getUserId: getUserId,
    getAccessToken: getAccessToken,
    setAuthSession: setAuthSession,
    clearAuthSession: clearAuthSession,
    refreshAccessToken: _refreshAccessToken,
    // 用户名 (展示用)
    getSyncCode: getSyncCode,
    setSyncCode: setSyncCode,
    // 单词
    addWord: addWord,
    addWordsBatch: addWordsBatch,
    updateWord: updateWord,
    deleteWord: deleteWord,
    getWord: getWord,
    findWordByText: findWordByText,
    getAllWords: getAllWords,
    getNewWords: getNewWords,
    getReviewCandidates: getReviewCandidates,
    getLearnedWords: getLearnedWords,
    searchWords: searchWords,
    getWordCount: getWordCount,
    getNewWordCount: getNewWordCount,
    getLearnedWordCount: getLearnedWordCount,
    getMasteredWordCount: getMasteredWordCount,
    // 记录
    addRecord: addRecord,
    getRecords: getRecords,
    getAllRecords: getAllRecords,
    clearWords: clearWords,
    clearAll: clearAll,
    exportAll: exportAll,
    // 授权系统 (RPC + Edge Function)
    rpc: rpc,
    callEdgeFunction: callEdgeFunction,
    migrateUser: migrateUser,
    registerUser: registerUser,
    linkUserId: linkUserId,
    getMigrationStatus: getMigrationStatus,
    verifyLogin: verifyLogin,
    usernameExists: usernameExists,
    getSecQuestion: getSecQuestion,
    verifySecAnswer: verifySecAnswer,
    resetPassword: resetPassword,
    getUserAuthInfo: getUserAuthInfo,
    changePassword: changePassword,
    changeSecQuestion: changeSecQuestion,
    getAuthorization: getAuthorization,
    getPromoConfig: getPromoConfig,
    getPayOrderStatus: getPayOrderStatus,
    getUnreadMessages: getUnreadMessages,
    markMessageRead: markMessageRead,
  };
})();
