/**
 * Supabase 数据层
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
      sync_code: w.syncCode || getSyncCode(),
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
      syncCode: r.sync_code,
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
      sync_code: rec.syncCode || getSyncCode(),
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
      syncCode: r.sync_code,
      wordId: r.word_id,
      word: r.word,
      direction: r.direction,
      isKnown: r.is_known,
      sessionType: r.session_type,
      timestamp: r.timestamp,
    };
  }

  // ========== Supabase REST 请求封装 ==========

  async function api(method, table, query, body, options) {
    var url = App.DBConfig.getRestUrl() + table;
    if (query) url += '?' + query;

    var headers = {
      'apikey': App.DBConfig.getKey(),
      'Authorization': 'Bearer ' + App.DBConfig.getKey(),
      'Content-Type': 'application/json',
    };

    // 构建 Prefer 头 (支持 return, resolution, count)
    var preferParts = [];
    if (body) {
      preferParts.push('return=representation');
      if (options && options.upsert) {
        preferParts.push('resolution=merge-duplicates');
      }
    }
    if (options && options.count) {
      preferParts.push('count=' + options.count);
    }
    if (preferParts.length > 0) {
      headers['Prefer'] = preferParts.join(', ');
    }

    // HEAD 请求需要通过 Range 头来获取计数
    if (method === 'HEAD' && options && options.count) {
      headers['Range'] = '0-0';
    }

    var resp = await fetch(url, {
      method: method,
      headers: headers,
      body: body ? JSON.stringify(body) : undefined,
    });

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

    // 返回完整响应 (供外部读取 Content-Range 等 headers)
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
    // 格式: "0-0/3800" 或 "*/3800" 或 "0-0/*"
    var parts = range.split('/');
    if (parts.length >= 2) {
      var total = parseInt(parts[1], 10);
      return isNaN(total) ? 0 : total;
    }
    return 0;
  }

  /** 分页计数 (后备方案: 当 Content-Range 不可用时使用) */
  async function countByPaging(filter) {
    var sc = getSyncCode();
    var base = 'sync_code=eq.' + encodeURIComponent(sc);
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
    // 不做主动连接测试, 首次查询时自然验证
  }

  // ========== 用户名 (同步码) ==========

  function getSyncCode() {
    return localStorage.getItem(App.Config.KEY_SYNC_CODE) || App.Config.DEFAULT_SYNC_CODE;
  }

  function setSyncCode(code) {
    if (!code || !code.trim()) return;
    localStorage.setItem(App.Config.KEY_SYNC_CODE, code.trim());
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

  /** 获取当前用户名下所有单词 (分页拉取, 每页 1000) */
  async function getAllWords() {
    var sc = getSyncCode();
    var base = 'sync_code=eq.' + encodeURIComponent(sc) + '&order=created_at.asc';
    var PAGE = 1000;
    var all = [];
    var offset = 0;
    while (true) {
      var rows = await api('GET', 'words', base + '&limit=' + PAGE + '&offset=' + offset);
      if (!rows || rows.length === 0) break;
      all = all.concat(rows);
      if (rows.length < PAGE) break;
      offset += PAGE;
    }
    return all.map(rowToWord);
  }

  /** 获取新词 (未学习过的, 从不同位置随机抽取) */
  async function getNewWords(count) {
    var sc = getSyncCode();
    var scEnc = encodeURIComponent(sc);
    var baseFilter = 'sync_code=eq.' + scEnc + '&total_count=eq.0';

    // 1. 获取新词总数
    var total = 0;
    try {
      var countResp = await api('GET', 'words',
        baseFilter + '&select=id&limit=1',
        null, { returnResponse: true, count: 'exact' });
      total = extractTotalFromRange(countResp);
    } catch (e) {}
    if (!total) {
      total = await countByPaging('total_count=eq.0');
    }
    if (total === 0) return [];

    // 2. 新词不多时全部拉取并洗牌
    if (total <= count * 3) {
      var rows = await api('GET', 'words', baseFilter + '&order=created_at.asc&limit=' + total);
      if (!rows) return [];
      var words = rows.map(rowToWord);
      shuffleArray(words);
      return words.slice(0, count);
    }

    // 3. 从 4 个随机位置并行拉取, 确保字母分布分散
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

    // 4. 合并去重
    var allWords = [];
    var seen = {};
    for (var r = 0; r < results.length; r++) {
      if (!results[r]) continue;
      for (var i = 0; i < results[r].length; i++) {
        var w = rowToWord(results[r][i]);
        if (!seen[w.id]) {
          seen[w.id] = true;
          allWords.push(w);
        }
      }
    }
    if (allWords.length === 0) return [];

    // 5. 洗牌后截取
    shuffleArray(allWords);
    return allWords.slice(0, count);
  }

  /** Fisher-Yates 洗牌 */
  function shuffleArray(arr) {
    for (var i = arr.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
    }
  }

  /** 获取复习候选词 (已学习过的, 按下次复习时间排序) */
  async function getReviewCandidates(count) {
    var sc = getSyncCode();
    // 多拉 2 倍, 供算法筛选
    var limit = Math.min(count * 3, 500);
    // 注: next_review_at 是计算字段, 不存在于数据库
    // 先拉取已学单词, 再在 JS 中排序
    var params = 'sync_code=eq.' + encodeURIComponent(sc) +
      '&total_count=gt.0' +
      '&order=last_learn_time.asc.nullsfirst' +
      '&limit=' + limit;
    var rows = await api('GET', 'words', params);
    if (!rows) return [];

    // 前端按下次复习时间排序
    var words = rows.map(rowToWord);
    // 计算每个单词的 nextReviewAt 并排序 (越紧急越靠前)
    words.sort(function (a, b) {
      var nextA = getNextReviewTime(a);
      var nextB = getNextReviewTime(b);
      return nextA - nextB;
    });
    return words;
  }

  /** 计算单词的下次复习时间 — 直接委托给 algorithm.js, 消除重复逻辑 */
  function getNextReviewTime(word) {
    // algorithm.js 在本文件之后加载, 但本函数在运行期(用户点击复习)才调用,
    // 此时 App.Algorithm 已就绪
    if (App.Algorithm && App.Algorithm.getNextReviewAt) {
      return App.Algorithm.getNextReviewAt(word);
    }
    // 极简兜底 (algorithm.js 加载异常时)
    if (!word.totalCount || word.totalCount === 0) return 0;
    if (word.nextReviewAt && word.nextReviewAt > 0) return word.nextReviewAt;
    return (word.lastLearnTime || 0) + (word.stability || 0);
  }

  /** 获取单词总数 (Prefer: count=exact + 后备分页计数) */
  async function getWordCount() {
    var sc = getSyncCode();
    try {
      var resp = await api('GET', 'words',
        'sync_code=eq.' + encodeURIComponent(sc) + '&limit=1',
        null, { returnResponse: true, count: 'exact' });
      var total = extractTotalFromRange(resp);
      if (total > 0) return total;
    } catch (e) {}
    // 后备: 分页计数
    return await countByPaging('');
  }

  /** 获取新词数量 (total_count=0) */
  async function getNewWordCount() {
    var sc = getSyncCode();
    try {
      var resp = await api('GET', 'words',
        'sync_code=eq.' + encodeURIComponent(sc) + '&total_count=eq.0&limit=1',
        null, { returnResponse: true, count: 'exact' });
      var total = extractTotalFromRange(resp);
      if (total > 0) return total;
    } catch (e) {}
    return await countByPaging('total_count=eq.0');
  }

  /** 获取已学习单词数量 (total_count>0) */
  async function getLearnedWordCount() {
    var sc = getSyncCode();
    try {
      var resp = await api('GET', 'words',
        'sync_code=eq.' + encodeURIComponent(sc) + '&total_count=gt.0&limit=1',
        null, { returnResponse: true, count: 'exact' });
      var total = extractTotalFromRange(resp);
      if (total > 0) return total;
    } catch (e) {}
    return await countByPaging('total_count=gt.0');
  }

  /** 获取已掌握单词数量 (熟练度>=85%) */
  async function getMasteredWordCount() {
    var sc = getSyncCode();
    // 需要计算 known_count/total_count >= 0.85, 分页拉取统计字段
    var params = 'sync_code=eq.' + encodeURIComponent(sc) +
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
        if (r.known_count && r.total_count && r.known_count / r.total_count >= 0.85) {
          count++;
        }
      }
      if (rows.length < PAGE) break;
      offset += PAGE;
    }
    return count;
  }

  /** 获取已学习的单词 (total_count > 0), 用于统计和熟练度复习 */
  async function getLearnedWords(limit) {
    var sc = getSyncCode();
    limit = limit || 1000;
    var params = 'sync_code=eq.' + encodeURIComponent(sc) +
      '&total_count=gt.0' +
      '&order=last_learn_time.desc' +
      '&limit=' + limit;
    var rows = await api('GET', 'words', params);
    if (!rows) return [];
    return rows.map(rowToWord);
  }

  /** 搜索单词 (空查询时按熟练度升序, 支持分页) */
  async function searchWords(query, offset, limit) {
    var q = (query || '').trim().toLowerCase();
    offset = offset || 0;
    limit = limit || App.Config.SEARCH_MAX_ROWS;

    if (!q) {
      // 空查询: 用 Prefer: count=exact 获取真实总数, 再拉取数据供前端排序
      var sc = getSyncCode();
      var FETCH_BATCH = 500;

      // 1. 获取真实总数 (Content-Range + 后备分页计数)
      var total = 0;
      try {
        var countResp = await api('GET', 'words',
          'sync_code=eq.' + encodeURIComponent(sc) + '&limit=1',
          null, { returnResponse: true, count: 'exact' });
        total = extractTotalFromRange(countResp);
      } catch (e) {}
      if (!total) {
        total = await countByPaging('');
      }

      // 2. 拉取部分数据供前端排序 (最多 500 条)
      var params = 'sync_code=eq.' + encodeURIComponent(sc) +
        '&order=total_count.asc.nullsfirst,created_at.asc' +
        '&limit=' + FETCH_BATCH;
      var rows = await api('GET', 'words', params);
      if (!rows) return { words: [], total: total };

      // 3. 前端按熟练度精细排序
      var words = rows.map(rowToWord);
      words.sort(function (a, b) {
        var pa = a.totalCount > 0 ? a.knownCount / a.totalCount : 0;
        var pb = b.totalCount > 0 ? b.knownCount / b.totalCount : 0;
        if (pa !== pb) return pa - pb;
        return (a.createdAt || 0) - (b.createdAt || 0);
      });

      // 4. 分页切片
      var sliced = words.slice(offset, offset + limit);
      return { words: sliced, total: total };
    }

    // 有查询: 用 PostgREST or + ilike 在数据库层过滤, 避免全量拉取
    // (原实现 getAllWords() 会把整个词库拉到前端再 filter, 词库一大就慢)
    var sc = getSyncCode();
    var qEnc = encodeURIComponent(q);
    // * 是 PostgREST ilike 的通配符; 同时匹配 word 和 chinese_meaning
    var orFilter = 'or=(word.ilike.*' + qEnc + '*,chinese_meaning.ilike.*' + qEnc + '*)';

    // 1. 获取匹配总数 (Prefer: count=exact)
    var total = 0;
    try {
      var countResp = await api('GET', 'words',
        'sync_code=eq.' + encodeURIComponent(sc) + '&' + orFilter + '&limit=1',
        null, { returnResponse: true, count: 'exact' });
      total = extractTotalFromRange(countResp);
    } catch (e) {}
    if (!total) return { words: [], total: 0 };

    // 2. 拉取匹配数据 (上限 500, 供前端熟练度精细排序)
    //    注: PostgREST 无法按 known_count/total_count 比值排序, 故前端再排一次
    var FETCH_MAX = 500;
    var params = 'sync_code=eq.' + encodeURIComponent(sc) +
      '&' + orFilter +
      '&order=total_count.asc.nullsfirst,created_at.asc' +
      '&limit=' + FETCH_MAX;
    var rows = await api('GET', 'words', params);
    if (!rows) return { words: [], total: total };

    // 3. 前端按熟练度精细排序 (与空查询分支保持一致)
    var words = rows.map(rowToWord);
    words.sort(function (a, b) {
      var pa = a.totalCount > 0 ? a.knownCount / a.totalCount : 0;
      var pb = b.totalCount > 0 ? b.knownCount / b.totalCount : 0;
      if (pa !== pb) return pa - pb;
      return (a.createdAt || 0) - (b.createdAt || 0);
    });

    // 4. 分页切片
    return { words: words.slice(offset, offset + limit), total: total };
  }

  /** 批量导入: mode = 'overwrite' | 'incremental' */
  async function addWordsBatch(words, mode) {
    var sc = getSyncCode();

    if (mode === 'overwrite') {
      // 清空现有词库和记录 (走 RPC, records 表已撤销 anon DELETE 权限)
      await rpc('clear_user_data', { p_sync_code: sc });
    }

    // 增量模式: 只拉取已有单词的 word + id + 统计字段 (减少传输量)
    var existingMap = {};
    if (mode === 'incremental') {
      var scEnc = encodeURIComponent(sc);
      var PAGE = 1000;
      var offset = 0;
      while (true) {
        // 只选取去重和保留统计所需的字段 (含 stability 和 next_review_at)
        var rows = await api('GET', 'words',
          'sync_code=eq.' + scEnc +
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

    // 构建写入行
    var rowsToWrite = words.map(function (w) {
      var key = (w.word || '').toLowerCase();
      var old = existingMap[key];
      if (old) {
        // 已存在: 更新5个字段, 保留学习统计和 id
        return {
          id: old.id,
          sync_code: sc,
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
      // 新增
      return wordToRow(w);
    });

    // 批量 upsert (每批 500 条, 用 merge-duplicates 避免主键冲突)
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
    var sc = getSyncCode();
    var query = 'sync_code=eq.' + encodeURIComponent(sc);
    if (startDate) query += '&timestamp=gte.' + startDate;
    if (endDate) query += '&timestamp=lt.' + endDate;
    var rows = await api('GET', 'records', query + '&order=timestamp.desc');
    return rows.map(rowToRecord);
  }

  async function getAllRecords() {
    var sc = getSyncCode();
    var rows = await api('GET', 'records', 'sync_code=eq.' + encodeURIComponent(sc) + '&order=timestamp.desc');
    return rows.map(rowToRecord);
  }

  // ========== 清空操作 ==========

  async function clearWords() {
    // 走 RPC: records 表已撤销 anon DELETE, 必须通过 SECURITY DEFINER 函数清理
    await rpc('clear_user_data', { p_sync_code: getSyncCode() });
  }

  async function clearAll() {
    // clear_user_data 同时清空 words 和 records
    await rpc('clear_user_data', { p_sync_code: getSyncCode() });
  }

  /** 按单词文本精确查找 (不区分大小写) */
  async function findWordByText(wordText) {
    var sc = getSyncCode();
    var params = 'sync_code=eq.' + encodeURIComponent(sc) +
      '&word=ilike.' + encodeURIComponent(wordText.trim());
    var rows = await api('GET', 'words', params);
    if (!rows || rows.length === 0) return null;
    return rowToWord(rows[0]);
  }

  // ========== 导出 ==========

  async function exportAll() {
    return {
      syncCode: getSyncCode(),
      words: await getAllWords(),
      records: await getAllRecords(),
      exportedAt: Date.now(),
    };
  }

  // ========== 授权系统数据库操作 ==========

  /** 调用 Supabase RPC 函数 */
  async function rpc(funcName, params) {
    var url = App.DBConfig.getRestUrl() + 'rpc/' + funcName;
    var headers = {
      'apikey': App.DBConfig.getKey(),
      'Authorization': 'Bearer ' + App.DBConfig.getKey(),
      'Content-Type': 'application/json',
    };
    var resp = await fetch(url, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(params || {}),
    });
    if (!resp.ok) {
      var text = await resp.text();
      throw new Error(text || ('RPC ' + funcName + ' failed: HTTP ' + resp.status));
    }
    var body = await resp.text();
    if (!body) return null;
    try { return JSON.parse(body); } catch (e) { return body; }
  }

  /** 注册用户 (RPC, 不暴露表数据) */
  async function registerUser(username, passwordHash, secQuestion, secAnswerHash) {
    var result = await rpc('register_user', {
      p_username: username,
      p_pwd_hash: passwordHash,
      p_sec_question: secQuestion,
      p_sec_answer_hash: secAnswerHash,
    });
    if (!result || !result.success) {
      var err = (result && result.error === 'exists') ? '用户名已存在' : '注册失败';
      throw new Error(err);
    }
  }

  /** 验证登录 (RPC, 只返回 true/false, 不返回哈希) */
  async function verifyLogin(username, passwordHash) {
    var result = await rpc('verify_login', {
      p_username: username,
      p_pwd_hash: passwordHash,
    });
    return result || { success: false, error: 'unknown' };
  }

  /** 检查用户名是否存在 (RPC) */
  async function usernameExists(username) {
    return await rpc('username_exists', { p_username: username });
  }

  /** 获取密保问题 (RPC, 不返回哈希) */
  async function getSecQuestion(username) {
    return await rpc('get_sec_question', { p_username: username });
  }

  /** 验证密保答案 (RPC) */
  async function verifySecAnswer(username, answerHash) {
    return await rpc('verify_sec_answer', {
      p_username: username,
      p_sec_answer_hash: answerHash,
    });
  }

  /** 重置密码 (RPC, 需密保答案验证) */
  async function resetPassword(username, newPasswordHash, secAnswerHash) {
    var result = await rpc('reset_password', {
      p_username: username,
      p_new_pwd_hash: newPasswordHash,
      p_sec_answer_hash: secAnswerHash,
    });
    if (!result || !result.success) {
      var err = (result && result.error === 'invalid_answer') ? '密保答案错误' : '重置失败';
      throw new Error(err);
    }
  }

  /** 获取用户信息 (RPC, Profile 展示用, 不返回哈希) */
  async function getUserAuthInfo(username) {
    return await rpc('get_user_auth_info', { p_username: username });
  }

  /** 修改密码 (RPC, 需原密码验证) */
  async function changePassword(username, oldPwdHash, newPwdHash) {
    var result = await rpc('change_password', {
      p_username: username,
      p_old_pwd_hash: oldPwdHash,
      p_new_pwd_hash: newPwdHash,
    });
    if (!result || !result.success) {
      var err = (result && result.error === 'wrong_password') ? '原密码错误' : '修改失败';
      throw new Error(err);
    }
  }

  /** 修改密保问题 (RPC, 需密码验证) */
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

  /** 获取授权状态 (RPC, 替代直接查询 authorizations 表) */
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

  /** 读取促销配置 */
  async function getPromoConfig() {
    var rows = await api('GET', 'admin_config',
      'key=in.(promo_amount,promo_years,promo_text)');
    var config = {};
    if (rows) {
      rows.forEach(function (r) { config[r.key] = r.value; });
    }
    return {
      amount: config.promo_amount || '20',
      years: config.promo_years || '1',
      text: config.promo_text || '捐赠20元得1年使用权',
    };
  }

  /** 获取未读留言 */
  async function getUnreadMessages(username) {
    // 先获取已读留言ID
    var readRows = await api('GET', 'user_read_messages',
      'username=eq.' + encodeURIComponent(username) + '&select=message_id');
    var readIds = (readRows || []).map(function (r) { return r.message_id; });

    // 获取所有active留言
    var allMessages = await api('GET', 'admin_messages',
      'status=eq.active&order=created_at.desc');
    if (!allMessages) return [];

    // 过滤未读
    return allMessages.filter(function (m) {
      return readIds.indexOf(m.id) === -1;
    }).map(function (m) {
      return { id: m.id, title: m.title, content: m.content, createdAt: m.created_at };
    });
  }

  /** 标记留言为已读 */
  async function markMessageRead(username, messageId) {
    var body = { username: username, message_id: messageId };
    await api('POST', 'user_read_messages', null, body);
  }

  return {
    init: init,
    getSyncCode: getSyncCode,
    setSyncCode: setSyncCode,
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
    addRecord: addRecord,
    getRecords: getRecords,
    getAllRecords: getAllRecords,
    clearWords: clearWords,
    clearAll: clearAll,
    exportAll: exportAll,
    // 授权系统 (全部通过 RPC, 不直接访问表)
    rpc: rpc,
    registerUser: registerUser,
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
    getUnreadMessages: getUnreadMessages,
    markMessageRead: markMessageRead,
  };
})();
