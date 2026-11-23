/**
 * 学习模块
 * 功能: 英译中/中译英、新词学习、智能复习
 *
 * v1.11.0 ES Module 重构:
 *   - 从 IIFE-on-window.App 改为 ES Module, 由 main.js 动态 import 加载 (按需懒加载)
 *   - 保留 window.App.Learning 命名空间, 业务模块内部 App.Learning 引用不变
 *   - 原 index.html 中 #view-learning 的静态 HTML 迁移为本模块的 HTML_TEMPLATE, init() 时注入
 */
window.App = window.App || {};
App.Learning = (function () {
  // #view-learning 的内部 HTML (迁移自 index.html, init() 首次挂载时注入)
  const HTML_TEMPLATE = `
        <div class="settings-panel">
          <div class="setting-group">
            <label class="setting-label">学习模式</label>
            <div class="btn-group" id="modeGroup">
              <button class="btn-toggle active" data-mode="en2cn">英译中</button>
              <button class="btn-toggle" data-mode="cn2en">中译英</button>
            </div>
          </div>
          <div class="setting-group">
            <label class="setting-label">新词数量</label>
            <div class="btn-group" id="newCountGroup">
              <button class="btn-toggle active" data-count="20">20</button>
              <button class="btn-toggle" data-count="40">40</button>
              <button class="btn-toggle" data-count="60">60</button>
            </div>
          </div>
          <div class="setting-group">
            <label class="setting-label">复习数量</label>
            <div class="btn-group" id="reviewCountGroup">
              <button class="btn-toggle active" data-count="30">30</button>
              <button class="btn-toggle" data-count="60">60</button>
              <button class="btn-toggle" data-count="90">90</button>
            </div>
          </div>
        </div>

        <div class="action-buttons">
          <button class="btn btn-primary btn-large" id="btnNewWords">新词学习</button>
          <button class="btn btn-secondary btn-large" id="btnReview">智能复习</button>
        </div>

        <div class="proficiency-section">
          <label class="setting-label">按熟练度复习</label>
          <div class="btn-group proficiency-group" id="proficiencyGroup">
            <button class="btn-toggle" data-range="0-40">&lt;40%</button>
            <button class="btn-toggle" data-range="40-60">40~60%</button>
            <button class="btn-toggle" data-range="60-80">60~80%</button>
            <button class="btn-toggle" data-range="80-100">80~100%</button>
          </div>
        </div>

        <div class="letter-stats-section">
          <label class="setting-label">字母分布 <span class="letter-stats-hint">（未掌握/总数量）</span></label>
          <div class="letter-grid" id="letterGrid">
            <div class="letter-loading">加载中...</div>
          </div>
        </div>

        <div id="learningOverlay" class="learning-overlay hidden">
          <div id="learningCard" class="learning-card"></div>
        </div>
      `;

  var state = {
    mode: 'en2cn',         // en2cn | cn2en
    newWordCount: 20,
    reviewCount: 30,
    session: null,         // { type, words, index, results, revealed }
  };

  // ========== 保存队列 (防止大量并发请求导致卡死) ==========
  // 用户快速点击"会/不会"时, saveAnswer/saveProfAnswer 会被连续调用.
  // 如果每个都直接发起 HTTP 请求, 几十个并发请求可能导致浏览器卡死.
  // 解决方案: 串行队列, 一次只执行一个保存任务, 其余排队等待.
  var _saveQueue = [];
  var _saveQueueRunning = false;

  /** 将保存任务加入队列, 串行执行 */
  function enqueueSave(task) {
    _saveQueue.push(task);
    if (!_saveQueueRunning) runSaveQueue();
  }

  async function runSaveQueue() {
    if (_saveQueueRunning) return;
    _saveQueueRunning = true;
    while (_saveQueue.length > 0) {
      var task = _saveQueue.shift();
      try {
        await task();
      } catch (e) {
        console.error('[SaveQueue] 任务执行失败:', e);
      }
    }
    _saveQueueRunning = false;
  }

  function init() {
    // 注入 HTML 模板 (首次挂载时)
    var view = document.getElementById('view-learning');
    if (!view.dataset.mounted) {
      view.innerHTML = HTML_TEMPLATE;
      view.dataset.mounted = '1';
    }

    // 模式切换
    bindToggleGroup('modeGroup', function (val) { state.mode = val; });
    bindToggleGroup('newCountGroup', function (val) { state.newWordCount = parseInt(val); });
    bindToggleGroup('reviewCountGroup', function (val) { state.reviewCount = parseInt(val); });

    document.getElementById('btnNewWords').addEventListener('click', startNewWords);
    document.getElementById('btnReview').addEventListener('click', startReview);

    // 熟练度区间按钮
    var profGroup = document.getElementById('proficiencyGroup');
    profGroup.addEventListener('click', function (e) {
      var btn = e.target.closest('.btn-toggle');
      if (!btn) return;
      var range = btn.dataset.range;
      startProficiencyReview(range);
    });

    // 字母方块点击 -> 进入该字母未掌握单词复习
    var letterGrid = document.getElementById('letterGrid');
    if (letterGrid) {
      letterGrid.addEventListener('click', function (e) {
        var block = e.target.closest('.letter-block');
        if (!block) return;
        var letter = block.dataset.letter;
        if (!letter) return;
        startLetterReview(letter);
      });
    }
  }

  function bindToggleGroup(groupId, callback) {
    var group = document.getElementById(groupId);
    group.addEventListener('click', function (e) {
      var btn = e.target.closest('.btn-toggle');
      if (!btn) return;
      group.querySelectorAll('.btn-toggle').forEach(function (b) { b.classList.remove('active'); });
      btn.classList.add('active');
      callback(btn.dataset.mode || btn.dataset.count);
    });
  }

  // ========== 字母分布统计 ==========

  /** 切到学习页时刷新字母分布 (与统计页"已掌握">=80%口径一致) */
  async function show() {
    await renderLetterStats();
  }

  async function renderLetterStats() {
    var grid = document.getElementById('letterGrid');
    if (!grid) return;
    try {
      // v1.11.2: 改用服务端聚合 getLetterDistribution (RPC 返回 27 桶, 仅几十字节)
      //   替代 getLearnedWords 全量拉取 + 前端分桶, 大幅降低学习页加载耗时
      //   RPC 未部署时 db.js 内部降级到客户端聚合, 行为不变
      var dist = await App.DB.getLetterDistribution();

      // 26 个字母初始化 (A-Z) + "#其他" 兜底非 A-Z 开头的词
      // v1.18.2: actionable = 可作答的未掌握词 (排除会拼写锁定词), 方块分子/百分比/颜色均用它
      var stats = {};
      for (var i = 0; i < 26; i++) {
        stats[String.fromCharCode(65 + i)] = { total: 0, mastered: 0, unmastered: 0, actionable: 0 };
      }
      stats['#'] = { total: 0, mastered: 0, unmastered: 0, actionable: 0 };

      // 合并 RPC 返回的桶 (只含 total > 0 的字母, 其余保留零值)
      if (Array.isArray(dist)) {
        dist.forEach(function (b) {
          if (stats[b.letter]) {
            stats[b.letter].total = b.total || 0;
            stats[b.letter].mastered = b.mastered || 0;
            stats[b.letter].unmastered = b.unmastered || 0;
            // 兼容旧 RPC 无 actionable 字段: 回退到 unmastered
            var act = (b.actionable != null) ? b.actionable : b.unmastered;
            stats[b.letter].actionable = act || 0;
          }
        });
      }

      // 渲染顺序: A-Z, 最后追加"#其他" (仅当存在非 A-Z 词时)
      var keys = Object.keys(stats).filter(function (k) { return k !== '#'; });
      if (stats['#'].total > 0) keys.push('#');

      // 颜色渐变: 按"可作答占比" actionable/total 做 min-max 归一化 (v1.18.2)
      // 保证无论数据分布如何, 占比最高的字母=红(0°), 最低的=绿(120°), 拉开区分度
      var ratios = [];
      keys.forEach(function (k) {
        var s = stats[k];
        if (s.total > 0) ratios.push(s.actionable / s.total);
      });
      var rMin = ratios.length ? Math.min.apply(null, ratios) : 0;
      var rMax = ratios.length ? Math.max.apply(null, ratios) : 0;
      var rRange = rMax - rMin;

      function hueFor(actionable, total) {
        if (total === 0) return 120;
        var r = actionable / total;
        var norm = rRange > 0 ? (r - rMin) / rRange : 0; // 0=最好, 1=最差
        return (1 - norm) * 120; // 最差->0°红, 最好->120°绿
      }

      var html = '';
      keys.forEach(function (ch) {
        var s = stats[ch];
        var cls = 'letter-block';
        var style = '';
        var pctText = '';
        if (s.total === 0) {
          cls += ' is-empty';
        } else {
          var hue = hueFor(s.actionable, s.total);
          style = ' style="background:hsl(' + hue + ',75%,90%);border-color:hsl(' + hue + ',70%,50%);"';
          var pct = Math.round((s.actionable / s.total) * 100);
          pctText = ' <span class="letter-pct">(' + pct + '%)</span>';
        }
        html +=
          '<div class="' + cls + '" data-letter="' + ch + '"' + style + '>' +
            '<div class="letter-head">' + ch + pctText + '</div>' +
            '<div class="letter-count">' + s.actionable + '/' + s.total + '</div>' +
          '</div>';
      });
      grid.innerHTML = html;
    } catch (e) {
      grid.innerHTML = '<div class="letter-error">加载失败: ' + App.Utils.escapeHtml(e.message) + '</div>';
    }
  }

  // ========== 开始学习 ==========

  async function startNewWords() {
    try {
      var words = await App.DB.getNewWords(state.newWordCount);
      if (words.length === 0) {
        App.showToast('词库中已没有新词，请先导入更多单词！', 'warning');
        return;
      }
      if (words.length < state.newWordCount) {
        App.showToast('新词不足，仅有 ' + words.length + ' 个新词可供学习', 'warning');
      }
      startSession('new', words);
    } catch (e) {
      App.showToast('加载新词失败: ' + e.message, 'error');
    }
  }

  async function startReview() {
    try {
      var candidates = await App.DB.getReviewCandidates(state.reviewCount);
      console.log('[Review] 候选词数:', candidates.length, '目标数:', state.reviewCount);
      var words = App.Algorithm.selectReviewWords(candidates, state.reviewCount);
      console.log('[Review] 选出词数:', words.length);
      if (words.length === 0) {
        App.showToast('暂无需要复习的单词，先学习一些新词吧！', 'warning');
        return;
      }
      if (words.length < state.reviewCount) {
        App.showToast('已学单词不足，仅有 ' + words.length + ' 个单词可供复习', 'warning');
      }
      startSession('review', words);
    } catch (e) {
      console.error('[Review] 失败:', e);
      App.showToast('加载复习单词失败: ' + e.message, 'error');
    }
  }

  // ========== 熟练度区间复习 ==========

  /** 按熟练度区间启动复习 (全屏列表模式) */
  async function startProficiencyReview(range) {
    try {
      var parts = range.split('-');
      var minP = parseInt(parts[0]) / 100;
      var maxP = parseInt(parts[1]) / 100;

      // 拉取已学习的单词 (不传limit, 获取全部已学词, 与统计页面熟练度分布口径一致)
      var allWords = await App.DB.getLearnedWords();

      // 筛选指定熟练度区间的单词 (排除未学习的)
      // v1.18.1: 不再排除冻结词 —— 冻结词仍在区间内, 由弹窗排到底部并标记锁定
      var filtered = allWords.filter(function (w) {
        if (!w.totalCount || w.totalCount === 0) return false;
        var prof = w.knownCount / w.totalCount;
        // 80-100 区间包含 1.0
        if (maxP === 1) return prof >= minP && prof <= maxP;
        return prof >= minP && prof < maxP;
      });

      if (filtered.length === 0) {
        App.showToast('该熟练度区间暂无单词', 'warning');
        return;
      }

      // 按熟练度从低到高排序
      filtered.sort(function (a, b) {
        var pa = a.knownCount / a.totalCount;
        var pb = b.knownCount / b.totalCount;
        return pa - pb;
      });

      await openProficiencyWindow(filtered, range);
    } catch (e) {
      App.showToast('加载单词失败: ' + e.message, 'error');
    }
  }

  /** 按首字母启动未掌握单词复习 (复用熟练度复习弹窗) */
  async function startLetterReview(letter) {
    try {
      var allWords = await App.DB.getLearnedWords();

      var filtered = allWords.filter(function (w) {
        if (!w.totalCount || w.totalCount === 0) return false;
        // v1.18.1: 不再排除冻结词 —— 与字母方块"未掌握数"口径保持一致, 冻结词由弹窗排底部标记
        var first = w.word.charAt(0).toUpperCase();
        // letter === '#' 表示非 A-Z 开头
        var match = letter === '#' ? !/[A-Z]/.test(first) : first === letter;
        return match && w.knownCount / w.totalCount < 0.80;
      });

      if (filtered.length === 0) {
        App.showToast('该字母暂无未掌握单词', 'warning');
        return;
      }

      // 按熟练度从低到高排序 (与熟练度区间复习一致)
      filtered.sort(function (a, b) {
        var pa = a.knownCount / a.totalCount;
        var pb = b.knownCount / b.totalCount;
        return pa - pb;
      });

      var label = letter === '#' ? '#其他' : '字母 ' + letter;
      await openProficiencyWindow(filtered, null, label + ' 未掌握', renderLetterStats);
    } catch (e) {
      App.showToast('加载单词失败: ' + e.message, 'error');
    }
  }

  // ========== v1.28.0: 复习列表词条下拉详情 (复用词库词卡富内容) ==========

  /** 按需确保 Library 富内容词库已就绪 (学习页独立入口, 可能词库模块尚未加载) */
  async function ensureRichLibrary() {
    try {
      if (!App.Library || typeof App.Library.getEnrichedWords !== 'function') {
        await import('./library.js');
      }
      if (App.Library && typeof App.Library.getEnrichedWords === 'function') {
        return await App.Library.getEnrichedWords();
      }
    } catch (e) {
      console.warn('[ReviewDetail] 富内容词库加载失败, 详情将降级为普通释义', e);
    }
    return [];
  }

  /** 把富内容词库按词头建立索引 (小写归一), 供复习词条 O(1) 匹配 */
  function buildRichIndex(richWords) {
    var idx = {};
    (richWords || []).forEach(function (r) {
      var key = String(r.headword || r.word || '').trim().toLowerCase();
      if (key && !idx[key]) idx[key] = r;
    });
    return idx;
  }

  /** 取某复习词对应的富内容对象 (带 senses/notes/relations), 找不到返回 null */
  function richOf(word, richIdx) {
    var key = String(word.word || '').trim().toLowerCase();
    return richIdx[key] || null;
  }

  /** 打开全屏熟练度复习窗口
   * @param words    单词列表
   * @param range    熟练度区间标识 (用于默认标题)
   * @param customTitle 可选, 覆盖默认标题
   * @param onClose  可选, 弹窗关闭后的回调
   */
  async function openProficiencyWindow(words, range, customTitle, onClose) {
    var rangeLabels = {
      '0-40': '熟练度<40%',
      '40-60': '熟练度40~60%',
      '60-80': '熟练度60~80%',
      '80-100': '熟练度80~100%',
    };

    var overlay = document.createElement('div');
    overlay.className = 'proficiency-overlay';
    overlay.id = 'proficiencyOverlay';

    var esc = App.Utils.escapeHtml;

    // v1.28.0: 加载词库富内容(带 senses/notes/relations), 供词条下拉详情原样复用
    var richIdx = buildRichIndex(await ensureRichLibrary());

    // v1.18.1: 把"会拼写"冻结词稳定分区到列表末尾 (组内保留原有熟练度升序)
    var activeWords = [];
    var lockedWords = [];
    words.forEach(function (w) {
      if (App.Algorithm.isFamiliarFrozen(w)) lockedWords.push(w);
      else activeWords.push(w);
    });
    var orderedWords = activeWords.concat(lockedWords);
    var answerableCount = activeWords.length; // 可答题数 (锁定词不计入进度分母)

    var listHTML = orderedWords.map(function (w, idx) {
      var prof = w.totalCount > 0 ? Math.round((w.knownCount / w.totalCount) * 100) : 0;
      var profColor = prof < 40 ? '#e74c3c' : prof < 60 ? '#f39c12' : prof < 80 ? '#3498db' : '#27ae60';
      var frozen = App.Algorithm.isFamiliarFrozen(w);
      var remainDays = frozen ? Math.max(1, Math.ceil((w.familiarNextAt - Date.now()) / 86400000)) : 0;
      var rightHTML = frozen
        ? '<div class="prof-word-locked">🔒 锁定期内 · 约 ' + remainDays + ' 天后可复习</div>'
        : '<div class="prof-word-actions">' +
            '<button class="btn btn-danger btn-sm prof-btn-no" data-word-id="' + w.id + '" data-idx="' + idx + '">不认识</button>' +
            '<button class="btn btn-success btn-sm prof-btn-yes" data-word-id="' + w.id + '" data-idx="' + idx + '">认识</button>' +
            '<button class="btn btn-familiar btn-sm prof-btn-familiar" data-word-id="' + w.id + '" data-idx="' + idx + '">会拼写</button>' +
          '</div>';
      // v1.28.0: 词头区域可点击展开详情 (复用词库词卡富内容, 派生跳转不集成)
      var hasRich = !!richOf(w, richIdx);
      var wordMain = '<div class="prof-word-main prof-word-expand' + (hasRich ? ' has-rich' : '') + '"' +
        ' data-detail-toggle="' + idx + '" role="button" aria-expanded="false" tabindex="0">' +
        '<svg class="prof-expand-arrow" viewBox="0 0 24 24" fill="none" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg>' +
        '<div class="prof-word-text">' + esc(w.word) + '</div>' +
        '<div class="prof-word-phonetic">' + esc(w.phonetic || '') + '</div>' +
        (hasRich ? '<span class="prof-detail-hint">详情</span>' : '') +
      '</div>';
      return '<div class="prof-word-item' + (frozen ? ' is-locked' : '') + '" data-idx="' + idx + '" data-word-id="' + w.id + '">' +
        '<div class="prof-word-top">' +
          wordMain +
          '<div class="prof-word-cn hidden">' + esc(w.chineseMeaning || '') + '</div>' +
        '</div>' +
        '<div class="prof-word-detail victor-wordlist" data-detail-body="' + idx + '" hidden></div>' +
        '<div class="prof-word-bottom">' +
          '<div class="prof-word-prof" style="color:' + profColor + ';">' + prof + '%</div>' +
          rightHTML +
        '</div>' +
      '</div>';
    }).join('');

    var title = customTitle || rangeLabels[range] || '熟练度复习';

    overlay.innerHTML =
      '<div class="proficiency-window">' +
        '<div class="proficiency-header">' +
          '<div class="proficiency-title">' + title + ' (' + orderedWords.length + '词' + (lockedWords.length ? '，' + lockedWords.length + '个锁定' : '') + ')</div>' +
          '<button class="proficiency-close" id="profCloseBtn">&times;</button>' +
        '</div>' +
        '<div class="proficiency-progress">' +
          '<span id="profProgressText">0 / ' + answerableCount + '</span>' +
          '<div class="progress-track"><div class="progress-fill" id="profProgressFill" style="width:0%"></div></div>' +
        '</div>' +
        '<div class="proficiency-list" id="proficiencyList">' + listHTML + '</div>' +
        '<div class="proficiency-footer hidden" id="profFooter">' +
          '<div class="proficiency-summary" id="profSummary"></div>' +
          '<button class="btn btn-primary btn-large" id="profFinishBtn">完成</button>' +
        '</div>' +
      '</div>';

    document.body.appendChild(overlay);
    document.body.style.overflow = 'hidden';

    // 存储状态 (words 用重排后的顺序, idx 与之对应; answerableCount 为进度分母)
    var profState = {
      words: orderedWords,
      answerableCount: answerableCount,
      answered: 0,
      known: 0,
      unknown: 0,
      familiar: 0,
      results: [],
    };

    // 关闭按钮
    document.getElementById('profCloseBtn').addEventListener('click', function () {
      closeProficiencyWindow();
    });

    // 不认识/认识/会拼写 按钮 + 词条详情展开 (事件委托)
    var listEl = document.getElementById('proficiencyList');

    // v1.28.0: 展开/收起词条详情 (惰性渲染, 首次展开才生成富内容 DOM)
    function toggleDetail(idx) {
      var main = listEl.querySelector('.prof-word-expand[data-detail-toggle="' + idx + '"]');
      var body = listEl.querySelector('.prof-word-detail[data-detail-body="' + idx + '"]');
      if (!main || !body) return;
      var willOpen = body.hasAttribute('hidden');
      if (willOpen) {
        if (!body.dataset.rendered) {
          var w = profState.words[idx];
          var rich = richOf(w, richIdx);
          // 与词库页同款渲染; 派生跳转不集成(noJump 由 renderVictorBody 内部处理)
          body.innerHTML = rich
            ? App.Utils.renderVictorBody(rich)
            : '<div style="font-size:13px;color:var(--muted);padding:8px 0">' +
                (w.chineseMeaning ? esc(w.chineseMeaning) : '（无详细义项）') + '</div>';
          body.dataset.rendered = '1';
        }
        body.removeAttribute('hidden');
        main.classList.add('expanded');
        main.setAttribute('aria-expanded', 'true');
      } else {
        body.setAttribute('hidden', '');
        main.classList.remove('expanded');
        main.setAttribute('aria-expanded', 'false');
      }
    }

    listEl.addEventListener('click', function (e) {
      // 详情展开优先 (词头区域)
      var toggle = e.target.closest('.prof-word-expand[data-detail-toggle]');
      if (toggle) {
        toggleDetail(parseInt(toggle.dataset.detailToggle));
        return;
      }
      var btn = e.target.closest('.prof-btn-yes, .prof-btn-no, .prof-btn-familiar');
      if (!btn) return;
      var idx = parseInt(btn.dataset.idx);
      var wordId = btn.dataset.wordId;
      var answer = btn.classList.contains('prof-btn-familiar') ? 'familiar'
        : btn.classList.contains('prof-btn-yes') ? 'known' : 'unknown';
      handleProfAnswer(idx, wordId, answer, profState);
    });
    // 键盘可达: 词头回车/空格展开
    listEl.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      var toggle = e.target.closest('.prof-word-expand[data-detail-toggle]');
      if (!toggle) return;
      e.preventDefault();
      toggleDetail(parseInt(toggle.dataset.detailToggle));
    });

    // 边界: 若全部词都在锁定期 (无可答题), 直接显示总结, 避免用户卡在无按钮界面
    if (answerableCount === 0) {
      showProfSummary(profState);
    }

    function handleProfAnswer(idx, wordId, answer, profState) {
      var item = listEl.querySelector('[data-idx="' + idx + '"]');
      if (!item || item.classList.contains('answered')) return;
      item.classList.add('answered');
      item.classList.add(answer === 'familiar' ? 'answered-familiar' : answer === 'known' ? 'answered-yes' : 'answered-no');

      // 显示中文释义
      var cnEl = item.querySelector('.prof-word-cn');
      if (cnEl) cnEl.classList.remove('hidden');

      // 隐藏按钮
      var actionsEl = item.querySelector('.prof-word-actions');
      if (actionsEl) actionsEl.classList.add('hidden');

      // 显示结果标记 (放到底部区域)
      var isKnown = answer === 'known' || answer === 'familiar';
      var bottomEl = item.querySelector('.prof-word-bottom');
      var resultEl = document.createElement('div');
      resultEl.className = 'prof-word-result ' + (answer === 'familiar' ? 'result-familiar' : isKnown ? 'result-yes' : 'result-no');
      resultEl.textContent = answer === 'familiar' ? '★ 会拼写' : isKnown ? '✓ 认识' : '✗ 不认识';
      if (bottomEl) bottomEl.appendChild(resultEl);
      else item.appendChild(resultEl);

      // 更新单词统计
      var w = profState.words[idx];
      App.Algorithm.updateWordStats(w, answer);
      saveProfAnswer(w, answer);

      // 即时刷新熟练度显示
      var newProf = w.totalCount > 0 ? Math.round((w.knownCount / w.totalCount) * 100) : 0;
      var newProfColor = newProf < 40 ? '#e74c3c' : newProf < 60 ? '#f39c12' : newProf < 80 ? '#3498db' : '#27ae60';
      var profEl = item.querySelector('.prof-word-prof');
      if (profEl) {
        profEl.textContent = newProf + '%';
        profEl.style.color = newProfColor;
      }

      // 更新计数
      profState.answered++;
      if (answer === 'familiar') profState.familiar++;
      if (isKnown) profState.known++;
      else profState.unknown++;
      profState.results.push({ wordId: wordId, isKnown: isKnown, answer: answer });

      // 更新进度条 (分母为可答题数, 锁定词不计入)
      var totalAnswerable = profState.answerableCount;
      var progress = totalAnswerable > 0 ? (profState.answered / totalAnswerable) * 100 : 100;
      document.getElementById('profProgressText').textContent = profState.answered + ' / ' + totalAnswerable;
      document.getElementById('profProgressFill').style.width = progress + '%';

      // 全部答完显示总结
      if (profState.answered >= totalAnswerable) {
        showProfSummary(profState);
      }
    }

    function showProfSummary(profState) {
      var total = profState.answered;
      var known = profState.known;
      var unknown = profState.unknown;
      var accuracy = total > 0 ? Math.round((known / total) * 100) : 0;
      var accuracyColor = accuracy >= 80 ? '#27AE60' : accuracy >= 50 ? '#F39C12' : '#E74C3C';

      var familiar = profState.familiar || 0;
      var summary = document.getElementById('profSummary');
      summary.innerHTML =
        '<div class="summary-stats">' +
          '<div class="summary-stat"><span class="num">' + total + '</span><span class="label">总词数</span></div>' +
          '<div class="summary-stat"><span class="num" style="color:#6c5ce7">' + familiar + '</span><span class="label">会拼写</span></div>' +
          '<div class="summary-stat"><span class="num" style="color:#27AE60">' + (known - familiar) + '</span><span class="label">认识</span></div>' +
          '<div class="summary-stat"><span class="num" style="color:#E74C3C">' + unknown + '</span><span class="label">不认识</span></div>' +
          '<div class="summary-stat"><span class="num" style="color:' + accuracyColor + '">' + accuracy + '%</span><span class="label">正确率</span></div>' +
        '</div>';

      document.getElementById('profFooter').classList.remove('hidden');
      document.getElementById('profFinishBtn').addEventListener('click', closeProficiencyWindow);
    }

    async function closeProficiencyWindow() {
      // 等待保存队列完成, 确保熟练度已持久化
      if (_saveQueue.length > 0 || _saveQueueRunning) {
        App.showToast('正在保存...', 'info');
        await new Promise(function (resolve) {
          enqueueSave(async function () { resolve(); });
        });
      }
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      document.body.style.overflow = '';
      if (typeof onClose === 'function') onClose();
    }
  }

  /** 保存熟练度复习记录 (加入串行队列, 避免并发请求卡死) */
  function saveProfAnswer(word, answer) {
    var isKnown = answer === 'known' || answer === 'familiar';
    enqueueSave(async function () {
      try {
        var updated = await App.DB.updateWord(word);
        if (!updated || !updated.id) {
          console.warn('[ProfReview] updateWord 返回空, 单词:', word.word, '可能 user_id 不匹配被 RLS 拒绝');
        }
        await App.DB.addRecord({
          wordId: word.id,
          word: word.word,
          // 熟练度/字母复习窗口固定展示"英文+音标 → 中文释义", 即 en2cn, 与界面一致
          direction: 'en2cn',
          isKnown: isKnown,
          sessionType: answer === 'familiar' ? 'familiar' : 'review',
        });
      } catch (e) {
        console.error('保存复习记录失败:', e.message);
        App.showToast('保存失败: ' + word.word + ' (' + e.message + ')', 'error', 3000);
      }
    });
  }

  function startSession(type, words) {
    state.session = {
      type: type,
      mode: state.mode, // 固定当前学习方向, 供 saveAnswer 写记录用 (避免 s.mode 为 undefined)
      words: words,
      index: 0,
      results: [],
      revealed: false,
    };
    // 隐藏设置面板和按钮, 显示学习卡片弹窗
    document.querySelector('.settings-panel').classList.add('hidden');
    document.querySelector('.action-buttons').classList.add('hidden');
    document.getElementById('learningOverlay').classList.remove('hidden');
    renderCard();
  }

  async function endSession() {
    // 等待保存队列中的任务全部完成, 确保数据已持久化
    if (_saveQueue.length > 0 || _saveQueueRunning) {
      App.showToast('正在保存学习记录...', 'info');
      // 把一个空任务加入队列尾部, 等它执行完说明前面的都完成了
      await new Promise(function (resolve) {
        enqueueSave(async function () { resolve(); });
      });
    }
    state.session = null;
    document.getElementById('learningOverlay').classList.add('hidden');
    document.querySelector('.settings-panel').classList.remove('hidden');
    document.querySelector('.action-buttons').classList.remove('hidden');
    // 会话结束刷新字母分布, 反映最新熟练度
    renderLetterStats();
  }

  // v1.22.0: 富内容渲染已提取到 App.Utils.renderRichDetail (学习页/词库页共用)
  function renderRichDetail(detail, esc) {
    return App.Utils.renderRichDetail(detail);
  }

  // ========== 渲染卡片 ==========

  function renderCard() {
    var s = state.session;
    if (!s) return;
    var w = s.words[s.index];
    var progress = ((s.index) / s.words.length) * 100;
    var card = document.getElementById('learningCard');

    var esc = App.Utils.escapeHtml;
    var questionHTML, answerHTML;

    if (state.mode === 'en2cn') {
      // 英译中: 先显示英文+音标
      questionHTML =
        '<div class="word-text">' + esc(w.word) + '</div>' +
        '<div class="word-phonetic">' + esc(w.phonetic) + '</div>';
      answerHTML =
        '<div class="word-meaning">' +
          (w.partOfSpeech ? '<span class="word-pos">' + esc(w.partOfSpeech) + '</span>' : '') +
          esc(w.chineseMeaning) +
        '</div>' +
        (w.exampleSentence ? '<div class="word-example">' + esc(w.exampleSentence) + '</div>' : '') +
        (w.detail ? renderRichDetail(w.detail, esc) : '');
    } else {
      // 中译英: 先显示中文
      questionHTML =
        '<div class="word-translation-prompt">' + esc(w.chineseMeaning) + '</div>';
      answerHTML =
        '<div class="word-text" style="font-size:32px;">' + esc(w.word) + '</div>' +
        '<div class="word-phonetic">' + esc(w.phonetic) + '</div>' +
        (w.partOfSpeech ? '<div style="margin-top:8px;"><span class="word-pos">' + esc(w.partOfSpeech) + '</span></div>' : '') +
        (w.exampleSentence ? '<div class="word-example">' + esc(w.exampleSentence) + '</div>' : '');
    }

    card.innerHTML =
      '<div class="progress-bar">' +
        '<div class="progress-track"><div class="progress-fill" style="width:' + progress + '%"></div></div>' +
        '<span class="progress-text">' + s.index + '/' + s.words.length + '</span>' +
      '</div>' +
      '<div class="word-display">' + questionHTML + '</div>' +
      '<div class="word-answer hidden" id="wordAnswer">' + answerHTML + '</div>' +
      '<div class="word-actions" id="wordActions">' +
        '<button class="btn btn-danger" id="btnUnknown">不认识</button>' +
        '<button class="btn btn-success" id="btnKnown">认识</button>' +
        '<button class="btn btn-familiar" id="btnFamiliar">会拼写</button>' +
      '</div>' +
      '<div class="word-next hidden" id="wordNext">' +
        '<button class="btn btn-primary" id="btnNext">' +
          (s.index < s.words.length - 1 ? '下一个' : '查看结果') +
        '</button>' +
      '</div>';

    document.getElementById('btnKnown').addEventListener('click', function () { handleAnswer('known'); });
    document.getElementById('btnUnknown').addEventListener('click', function () { handleAnswer('unknown'); });
    document.getElementById('btnFamiliar').addEventListener('click', function () { handleAnswer('familiar'); });
    document.getElementById('btnNext').addEventListener('click', handleNext);
  }

  // ========== 答题逻辑 ==========

  function handleAnswer(answer) {
    var s = state.session;
    if (!s || s.revealed) return;
    s.revealed = true;

    var w = s.words[s.index];
    // 会拼写视同"掌握"参与正确率统计; 记录原始 answer 供展示
    var isKnown = answer === 'known' || answer === 'familiar';
    s.results.push({ wordId: w.id, word: w.word, isKnown: isKnown, answer: answer });

    // 更新单词统计 (纯内存操作, 无延迟)
    App.Algorithm.updateWordStats(w, answer);

    // 立即揭示答案 (UI 先响应, 不等网络)
    document.getElementById('wordAnswer').classList.remove('hidden');
    document.getElementById('wordActions').classList.add('hidden');
    document.getElementById('wordNext').classList.remove('hidden');

    // 更新进度条
    var progress = ((s.index + 1) / s.words.length) * 100;
    document.querySelector('.progress-fill').style.width = progress + '%';
    document.querySelector('.progress-text').textContent = (s.index + 1) + '/' + s.words.length;

    // 异步保存到数据库 (不阻塞 UI)
    saveAnswer(w, answer);
  }

  /** 保存学习记录 (加入串行队列, 避免并发请求卡死) */
  function saveAnswer(word, answer) {
    var s = state.session;
    // 会拼写按"认识"计入记录 (统计正确率时算掌握)
    var isKnown = answer === 'known' || answer === 'familiar';
    enqueueSave(async function () {
      try {
        var updated = await App.DB.updateWord(word);
        if (!updated || !updated.id) {
          console.warn('[Learning] updateWord 返回空, 单词:', word.word, '可能 user_id 不匹配被 RLS 拒绝');
        }
        await App.DB.addRecord({
          wordId: word.id,
          word: word.word,
          direction: (s && s.mode) || state.mode || 'en2cn',
          isKnown: isKnown,
          sessionType: answer === 'familiar' ? 'familiar' : (s ? s.type : 'review'),
        });
      } catch (e) {
        console.error('保存学习记录失败:', e.message);
        App.showToast('保存失败: ' + word.word + ' (' + e.message + ')', 'error', 3000);
      }
    });
  }

  function handleNext() {
    var s = state.session;
    if (!s) return;
    s.index++;
    s.revealed = false;

    if (s.index >= s.words.length) {
      showSummary();
    } else {
      renderCard();
    }
  }

  // ========== 学习总结 ==========

  function showSummary() {
    var s = state.session;
    var total = s.results.length;
    var known = s.results.filter(function (r) { return r.isKnown; }).length;
    var unknown = total - known;
    var accuracy = total > 0 ? Math.round((known / total) * 100) : 0;

    var card = document.getElementById('learningCard');
    var accuracyColor = accuracy >= 80 ? '#27AE60' : accuracy >= 50 ? '#F39C12' : '#E74C3C';

    var msg = '';
    if (accuracy >= 80) msg = '表现出色，继续保持！';
    else if (accuracy >= 50) msg = '不错，多复习几遍就更好了！';
    else msg = '别灰心，多练几次就会进步！';

    card.innerHTML =
      '<div class="word-summary">' +
        '<h3>' + (s.type === 'new' ? '新词学习' : '智能复习') + '完成!</h3>' +
        '<p style="color:var(--color-text-light);margin-bottom:20px;">' + msg + '</p>' +
        '<div class="summary-stats">' +
          '<div class="summary-stat"><span class="num">' + total + '</span><span class="label">总词数</span></div>' +
          '<div class="summary-stat"><span class="num" style="color:#27AE60">' + known + '</span><span class="label">认识</span></div>' +
          '<div class="summary-stat"><span class="num" style="color:#E74C3C">' + unknown + '</span><span class="label">不认识</span></div>' +
          '<div class="summary-stat"><span class="num" style="color:' + accuracyColor + '">' + accuracy + '%</span><span class="label">正确率</span></div>' +
        '</div>' +
        '<button class="btn btn-primary btn-large" id="btnFinish" style="margin-top:10px;">完成</button>' +
      '</div>';

    document.getElementById('btnFinish').addEventListener('click', endSession);
  }

  return { init: init, show: show, endSession: endSession };
})();

// ES Module 导出 (供 main.js 动态 import, 同时 window.App.Learning 命名空间保留供业务模块使用)
export default App.Learning;
