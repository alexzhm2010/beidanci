/**
 * 学习模块
 * 功能: 英译中/中译英、新词学习、智能复习
 */
window.App = window.App || {};
App.Learning = (function () {
  var state = {
    mode: 'en2cn',         // en2cn | cn2en
    newWordCount: 20,
    reviewCount: 30,
    session: null,         // { type, words, index, results, revealed }
  };

  function init() {
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

      // 拉取已学习的单词 (不能用searchWords, 它按total_count升序只返回新词)
      var allWords = await App.DB.getLearnedWords(1000);

      // 筛选指定熟练度区间的单词 (排除未学习的)
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

      openProficiencyWindow(filtered, range);
    } catch (e) {
      App.showToast('加载单词失败: ' + e.message, 'error');
    }
  }

  /** 打开全屏熟练度复习窗口 */
  function openProficiencyWindow(words, range) {
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
    var listHTML = words.map(function (w, idx) {
      var prof = w.totalCount > 0 ? Math.round((w.knownCount / w.totalCount) * 100) : 0;
      var profColor = prof < 40 ? '#e74c3c' : prof < 60 ? '#f39c12' : prof < 80 ? '#3498db' : '#27ae60';
      return '<div class="prof-word-item" data-idx="' + idx + '" data-word-id="' + w.id + '">' +
        '<div class="prof-word-main">' +
          '<div class="prof-word-text">' + esc(w.word) + '</div>' +
          '<div class="prof-word-phonetic">' + esc(w.phonetic || '') + '</div>' +
        '</div>' +
        '<div class="prof-word-cn hidden">' + esc(w.chineseMeaning || '') + '</div>' +
        '<div class="prof-word-prof" style="color:' + profColor + ';">' + prof + '%</div>' +
        '<div class="prof-word-actions">' +
          '<button class="btn btn-danger btn-sm prof-btn-no" data-word-id="' + w.id + '" data-idx="' + idx + '">不会</button>' +
          '<button class="btn btn-success btn-sm prof-btn-yes" data-word-id="' + w.id + '" data-idx="' + idx + '">会</button>' +
        '</div>' +
      '</div>';
    }).join('');

    overlay.innerHTML =
      '<div class="proficiency-window">' +
        '<div class="proficiency-header">' +
          '<div class="proficiency-title">' + (rangeLabels[range] || '熟练度复习') + ' (' + words.length + '词)</div>' +
          '<button class="proficiency-close" id="profCloseBtn">&times;</button>' +
        '</div>' +
        '<div class="proficiency-progress">' +
          '<span id="profProgressText">0 / ' + words.length + '</span>' +
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

    // 存储状态
    var profState = {
      words: words,
      answered: 0,
      known: 0,
      unknown: 0,
      results: [],
    };

    // 关闭按钮
    document.getElementById('profCloseBtn').addEventListener('click', function () {
      closeProficiencyWindow();
    });

    // 会/不会按钮 (事件委托)
    var listEl = document.getElementById('proficiencyList');
    listEl.addEventListener('click', function (e) {
      var btn = e.target.closest('.prof-btn-yes, .prof-btn-no');
      if (!btn) return;
      var idx = parseInt(btn.dataset.idx);
      var wordId = btn.dataset.wordId;
      var isKnown = btn.classList.contains('prof-btn-yes');
      handleProfAnswer(idx, wordId, isKnown, profState);
    });

    function handleProfAnswer(idx, wordId, isKnown, profState) {
      var item = listEl.querySelector('[data-idx="' + idx + '"]');
      if (!item || item.classList.contains('answered')) return;
      item.classList.add('answered');
      item.classList.add(isKnown ? 'answered-yes' : 'answered-no');

      // 显示中文释义
      var cnEl = item.querySelector('.prof-word-cn');
      if (cnEl) cnEl.classList.remove('hidden');

      // 隐藏按钮
      var actionsEl = item.querySelector('.prof-word-actions');
      if (actionsEl) actionsEl.classList.add('hidden');

      // 显示结果标记
      var resultEl = document.createElement('div');
      resultEl.className = 'prof-word-result ' + (isKnown ? 'result-yes' : 'result-no');
      resultEl.textContent = isKnown ? '✓ 会' : '✗ 不会';
      item.appendChild(resultEl);

      // 更新单词统计
      var w = profState.words[idx];
      App.Algorithm.updateWordStats(w, isKnown);
      saveProfAnswer(w, isKnown);

      // 更新计数
      profState.answered++;
      if (isKnown) profState.known++;
      else profState.unknown++;
      profState.results.push({ wordId: wordId, isKnown: isKnown });

      // 更新进度条
      var progress = (profState.answered / profState.words.length) * 100;
      document.getElementById('profProgressText').textContent = profState.answered + ' / ' + profState.words.length;
      document.getElementById('profProgressFill').style.width = progress + '%';

      // 全部答完显示总结
      if (profState.answered >= profState.words.length) {
        showProfSummary(profState);
      }
    }

    function showProfSummary(profState) {
      var total = profState.answered;
      var known = profState.known;
      var unknown = profState.unknown;
      var accuracy = total > 0 ? Math.round((known / total) * 100) : 0;
      var accuracyColor = accuracy >= 80 ? '#27AE60' : accuracy >= 50 ? '#F39C12' : '#E74C3C';

      var summary = document.getElementById('profSummary');
      summary.innerHTML =
        '<div class="summary-stats">' +
          '<div class="summary-stat"><span class="num">' + total + '</span><span class="label">总词数</span></div>' +
          '<div class="summary-stat"><span class="num" style="color:#27AE60">' + known + '</span><span class="label">会</span></div>' +
          '<div class="summary-stat"><span class="num" style="color:#E74C3C">' + unknown + '</span><span class="label">不会</span></div>' +
          '<div class="summary-stat"><span class="num" style="color:' + accuracyColor + '">' + accuracy + '%</span><span class="label">正确率</span></div>' +
        '</div>';

      document.getElementById('profFooter').classList.remove('hidden');
      document.getElementById('profFinishBtn').addEventListener('click', closeProficiencyWindow);
    }

    function closeProficiencyWindow() {
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      document.body.style.overflow = '';
    }
  }

  /** 异步保存熟练度复习记录 */
  async function saveProfAnswer(word, isKnown) {
    try {
      await App.DB.updateWord(word);
      await App.DB.addRecord({
        wordId: word.id,
        word: word.word,
        direction: 'en2cn',
        isKnown: isKnown,
        sessionType: 'review',
      });
    } catch (e) {
      console.error('保存复习记录失败:', e);
    }
  }

  function startSession(type, words) {
    state.session = {
      type: type,
      words: words,
      index: 0,
      results: [],
      revealed: false,
    };
    // 隐藏设置面板和按钮
    document.querySelector('.settings-panel').classList.add('hidden');
    document.querySelector('.action-buttons').classList.add('hidden');
    renderCard();
  }

  function endSession() {
    state.session = null;
    document.getElementById('learningCard').classList.add('hidden');
    document.querySelector('.settings-panel').classList.remove('hidden');
    document.querySelector('.action-buttons').classList.remove('hidden');
  }

  // ========== 渲染卡片 ==========

  function renderCard() {
    var s = state.session;
    if (!s) return;
    var w = s.words[s.index];
    var progress = ((s.index) / s.words.length) * 100;
    var card = document.getElementById('learningCard');
    card.classList.remove('hidden');

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
        (w.exampleSentence ? '<div class="word-example">' + esc(w.exampleSentence) + '</div>' : '');
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
      '</div>' +
      '<div class="word-next hidden" id="wordNext">' +
        '<button class="btn btn-primary" id="btnNext">' +
          (s.index < s.words.length - 1 ? '下一个' : '查看结果') +
        '</button>' +
      '</div>';

    document.getElementById('btnKnown').addEventListener('click', function () { handleAnswer(true); });
    document.getElementById('btnUnknown').addEventListener('click', function () { handleAnswer(false); });
    document.getElementById('btnNext').addEventListener('click', handleNext);
  }

  // ========== 答题逻辑 ==========

  function handleAnswer(isKnown) {
    var s = state.session;
    if (!s || s.revealed) return;
    s.revealed = true;

    var w = s.words[s.index];
    s.results.push({ wordId: w.id, word: w.word, isKnown: isKnown });

    // 更新单词统计 (纯内存操作, 无延迟)
    App.Algorithm.updateWordStats(w, isKnown);

    // 立即揭示答案 (UI 先响应, 不等网络)
    document.getElementById('wordAnswer').classList.remove('hidden');
    document.getElementById('wordActions').classList.add('hidden');
    document.getElementById('wordNext').classList.remove('hidden');

    // 更新进度条
    var progress = ((s.index + 1) / s.words.length) * 100;
    document.querySelector('.progress-fill').style.width = progress + '%';
    document.querySelector('.progress-text').textContent = (s.index + 1) + '/' + s.words.length;

    // 异步保存到数据库 (不阻塞 UI)
    saveAnswer(w, isKnown);
  }

  /** 异步保存学习记录到数据库 */
  async function saveAnswer(word, isKnown) {
    var s = state.session;
    try {
      await App.DB.updateWord(word);
      await App.DB.addRecord({
        wordId: word.id,
        word: word.word,
        direction: s.mode,
        isKnown: isKnown,
        sessionType: s.type,
      });
    } catch (e) {
      console.error('保存学习记录失败:', e);
    }
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

  return { init: init, endSession: endSession };
})();
