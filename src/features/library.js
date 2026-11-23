/**
 * 词库模块
 * 功能: 搜索、批量导入、单个新增、导出备份、编辑/删除
 *
 * v1.11.0 ES Module 重构:
 *   - 从 IIFE-on-window.App 改为 ES Module, 由 main.js 动态 import 加载 (按需懒加载)
 *   - 保留 window.App.Library 命名空间, 业务模块内部 App.Library 引用不变
 *   - 原 index.html 中 #view-library 的静态 HTML 迁移为本模块的 HTML_TEMPLATE, init() 时注入
 *   - 第三方库改为按需懒加载: XLSX 走 ESM 动态 import('xlsx'), Tesseract.js 走动态 script 标签
 */
// 词典模块随词库页一起加载 (添加/批量导入时查词用)
import './dictionary.js';
window.App = window.App || {};
App.Library = (function () {
  // #view-library 的内部 HTML (迁移自 index.html, init() 首次挂载时注入)
  const HTML_TEMPLATE = `
        <!-- v1.23.0: 词库工具栏沿用 beidanci 功能按钮, 列表主体一比一复刻 Victor 词库页 -->
        <div class="words-toolbar">
          <div class="search-wrap">
            <svg viewBox="0 0 24 24" fill="none" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4-4"/></svg>
            <input type="text" id="searchInput" placeholder="搜索英文单词或中文释义…" autocomplete="off">
            <div class="toolbar-buttons">
              <button class="btn btn-outline btn-sm" id="btnImport">批量导入</button>
              <button class="btn btn-outline btn-sm" id="btnAddWord" style="display:none;">单个新增</button>
              <button class="btn btn-outline btn-sm" id="btnScanWord">扫词</button>
              <button class="btn btn-outline btn-sm" id="btnSyncVictor">同步 Victor</button>
              <button class="btn btn-outline btn-sm" id="btnExport">导出</button>
              <button class="btn btn-primary btn-sm" id="btnSyncPreset">同步预置词库</button>
            </div>
          </div>
          <div class="list-summary" id="listSummary"><b>0</b><span class="frac-sep">/</span>0</div>
        </div>
        <div id="listView">
          <div id="wordCardList" class="victor-wordlist book-list"></div>
          <div id="scrollSentinel" class="scroll-sentinel"><span class="mini-spinner"></span> 加载更多…</div>
        </div>
      `;

  // ========== 第三方库按需懒加载 ==========
  // XLSX (npm 包) — 走 ESM 动态 import, 首次使用时加载并缓存
  var _XLSX = null;
  async function ensureXLSX() {
    if (_XLSX) return _XLSX;
    var mod = await import('xlsx');
    _XLSX = mod.default || mod;
    return _XLSX;
  }

  // Tesseract.js v5 UMD — 无 ESM 构建, 走动态 script 标签加载
  var _Tesseract = null;
  async function ensureTesseract() {
    if (_Tesseract) return _Tesseract;
    // Tesseract.js v5 UMD — load via dynamic script tag (no ESM build available)
    await new Promise(function (resolve, reject) {
      if (window.Tesseract) { resolve(); return; }
      var s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.0/dist/tesseract.min.js';
      s.onload = resolve;
      s.onerror = function () { reject(new Error('Tesseract.js 加载失败')); };
      document.head.appendChild(s);
    });
    _Tesseract = window.Tesseract;
    return _Tesseract;
  }

  // v1.23.0: 一比一复刻 Victor 词库列表引擎 (全量加载 + A-Z 排序 + 无限滚动)
  var currentQuery = '';
  var allWords = [];          // 当前用户词库全量词 (映射成 Victor 词对象结构)
  var filteredWords = [];     // 搜索过滤后的列表
  var renderedCount = 0;      // 已渲染条数
  var PAGE_RENDER = 30;       // 每批渲染词条数 (与 Victor 一致)
  var _sentinelObserver = null;
  var isLoading = false;

  // Excel表头 → 字段名 映射
  var HEADER_MAP = {
    '单词/词组': 'word', '单词': 'word', '词组': 'word', 'word': 'word', 'Word': 'word',
    '音标': 'phonetic', 'phonetic': 'phonetic', 'Phonetic': 'phonetic',
    '词性': 'partOfSpeech', 'partOfSpeech': 'partOfSpeech', 'pos': 'partOfSpeech',
    '中文译意': 'chineseMeaning', '中文释义': 'chineseMeaning', '中文': 'chineseMeaning',
    'chineseMeaning': 'chineseMeaning', 'meaning': 'chineseMeaning', '释义': 'chineseMeaning',
    '例句': 'exampleSentence', 'exampleSentence': 'exampleSentence', 'example': 'exampleSentence',
  };

  function init() {
    // 注入 HTML 模板 (首次挂载时)
    var view = document.getElementById('view-library');
    if (!view.dataset.mounted) {
      view.innerHTML = HTML_TEMPLATE;
      view.dataset.mounted = '1';
    }

    // 搜索 (防抖) — 复刻 Victor onSearchChange, 本地过滤后重建列表
    var debouncedSearch = App.Utils.debounce(function () {
      currentQuery = document.getElementById('searchInput').value || '';
      resetWordList();
    }, 180);
    document.getElementById('searchInput').addEventListener('input', debouncedSearch);

    // 工具栏按钮
    document.getElementById('btnImport').addEventListener('click', showImportModal);
    document.getElementById('btnAddWord').addEventListener('click', function () { showWordModal(); });
    document.getElementById('btnScanWord').addEventListener('click', showCameraScan);
    document.getElementById('btnSyncVictor').addEventListener('click', showSyncVictorModal);
    document.getElementById('btnExport').addEventListener('click', showExportModal);
    document.getElementById('btnSyncPreset').addEventListener('click', showSyncPresetModal);

    // 事件委托: 点词头展开/收起 (复刻 Victor toggleCard; 所有词卡均可展开)
    document.getElementById('wordCardList').addEventListener('click', function (e) {
      var head = e.target.closest('.word-hd[data-expandable="1"]');
      if (head) toggleCard(head.getAttribute('data-key'));
    });
    // 键盘可达: 词头回车/空格展开
    document.getElementById('wordCardList').addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      var head = e.target.closest('.word-hd[data-expandable="1"]');
      if (!head) return;
      e.preventDefault();
      toggleCard(head.getAttribute('data-key'));
    });
  }

  // v1.23.0: 复刻 Victor toggleCard —— 点击词头展开/收起 word-body
  function toggleCard(key) {
    var card = document.getElementById('wc-' + key);
    if (!card) return;
    var open = card.classList.toggle('open');
    var head = card.querySelector('.word-hd');
    if (head) head.setAttribute('aria-expanded', open ? 'true' : 'false');
  }


  async function show() {
    document.getElementById('searchInput').value = currentQuery;
    // 每次进入词库页都重新拉全量, 保证与外部(同步/学习)改动一致
    await loadWords(currentQuery);
  }

  // ========== 搜索 & 渲染 (v1.23.0: 复刻 Victor 全量 + A-Z + 无限滚动) ==========

  // 对外入口: 重新拉取全量词库并重建列表
  async function loadWords(query) {
    currentQuery = query || '';
    var listEl = document.getElementById('wordCardList');
    listEl.innerHTML = '<div class="vcard-placeholder">加载中…</div>';
    isLoading = true;
    try {
      // v1.25.0 正确模型: 清单主体 = 用户自己的 words 表 (4034+ 词, 零丢失),
      // 富内容 = Victor 四表(uw_*), 按小写词头 join 到用户词上。
      // 匹配上 -> 完整 Victor 卡片; 匹配不上 -> 仅中文释义一行。
      var userWords = await App.DB.getAllWords();
      var richById = {};
      try {
        var richWords = await App.DB.getVictorWords();
        richWords.forEach(function (r) {
          var k = String(r.headword || '').trim().toLowerCase();
          if (k && !richById[k]) richById[k] = r;
        });
      } catch (richErr) {
        // 富内容拉取失败不应导致词库整体空白: 降级为全部只显示中文释义
        if (window.console) console.warn('富内容加载失败, 降级为纯中文释义', richErr);
      }

      allWords = userWords.map(function (w) {
        var key = String(w.word || '').trim().toLowerCase();
        var rich = richById[key];
        return {
          id: w.id,
          headword: w.word || '',
          word: w.word || '',
          phonetic: (w.phonetic || (rich && rich.phonetic) || ''),
          chineseMeaning: w.chineseMeaning || '',
          level_tag: rich ? rich.level_tag : '',
          inline_def: rich ? rich.inline_def : '',
          identity_tag: rich ? rich.identity_tag : '',
          derived_from: rich ? rich.derived_from : '',
          page_no: rich ? rich.page_no : null,
          partial: rich ? !!rich.partial : false,
          senses: rich ? rich.senses : [],
          notes: rich ? rich.notes : [],
          totalCount: w.totalCount || 0,
          knownCount: w.knownCount || 0,
        };
      });
      // 按 A–Z 排序 (忽略大小写与符号前缀), 贴合 Victor 书本式顺序
      allWords.sort(function (a, b) {
        var ka = String(a.headword || '').replace(/^[^a-zA-Z]+/, '').toLowerCase();
        var kb = String(b.headword || '').replace(/^[^a-zA-Z]+/, '').toLowerCase();
        var c = ka.localeCompare(kb);
        return c !== 0 ? c : String(a.headword || '').localeCompare(String(b.headword || ''));
      });
      resetWordList();

      // 搜索无结果且查询词非空: 自动弹出查词弹窗 (沿用 beidanci 行为)
      if (filteredWords.length === 0 && currentQuery.trim() && /[a-zA-Z]/.test(currentQuery.trim())) {
        var term = currentQuery.trim();
        App.showToast('词库中未找到"' + term + '"，正在为您查词...', 'info', 3000);
        showWordModalWithCheck(term);
      }
    } catch (e) {
      listEl.innerHTML = '<div class="vcard-placeholder">加载失败: ' + App.Utils.escapeHtml(e.message) + '</div>';
      App.showToast('加载词库失败: ' + e.message, 'error');
    } finally {
      isLoading = false;
    }
  }

  // 增删改后刷新: 重新拉全量并重建 (保持搜索词)
  async function reloadCurrentPage() {
    await loadWords(currentQuery);
  }

  // 依据搜索词过滤 (复刻 Victor computeFiltered: 英文词头 + 中文释义)
  function computeFiltered() {
    var q = (currentQuery || '').trim().toLowerCase();
    if (!q) return allWords;
    return allWords.filter(function (w) {
      if ((w.headword || '').toLowerCase().indexOf(q) !== -1) return true;
      if ((w.chineseMeaning || '').indexOf(q) !== -1) return true;
      // 结构化富内容 (uw_* 四表): 义项中文释义 / 例句英文
      var senses = Array.isArray(w.senses) ? w.senses : [];
      for (var i = 0; i < senses.length; i++) {
        if ((senses[i].chinese_def || '').indexOf(q) !== -1) return true;
        var exs = Array.isArray(senses[i].examples) ? senses[i].examples : [];
        for (var j = 0; j < exs.length; j++) {
          if ((exs[j].en || '').toLowerCase().indexOf(q) !== -1) return true;
        }
      }
      return false;
    });
  }

  // 重新计算并从头渲染 (复刻 Victor resetWordList)
  function resetWordList() {
    filteredWords = computeFiltered();
    renderedCount = 0;
    var host = document.getElementById('wordCardList');
    host.innerHTML = '';
    var q = (currentQuery || '').trim();
    // 分数形式: 分子=过滤后数量, 分母=全部数量 (与 Victor listSummary 一致)
    var summary = document.getElementById('listSummary');
    if (summary) summary.innerHTML = '<b>' + filteredWords.length + '</b><span class="frac-sep">/</span>' + allWords.length;
    var sentinel = document.getElementById('scrollSentinel');
    if (!filteredWords.length) {
      sentinel.classList.add('hidden');
      host.innerHTML = '<div class="empty">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke-width="1.5"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>' +
        '<div>' + (q ? '没有匹配的单词' : '词库为空，点击"批量导入"或"同步 Victor"添加单词') + '</div></div>';
      return;
    }
    sentinel.classList.remove('hidden');
    appendWords();
    setupSentinelObserver();
  }

  // 追加下一批词条 (复刻 Victor appendWords)
  function appendWords() {
    if (renderedCount >= filteredWords.length) {
      var s0 = document.getElementById('scrollSentinel');
      if (s0) s0.classList.add('hidden');
      return;
    }
    var batch = filteredWords.slice(renderedCount, renderedCount + PAGE_RENDER);
    var host = document.getElementById('wordCardList');
    host.insertAdjacentHTML('beforeend', batch.map(function (w, k) {
      return renderCard(w);
    }).join(''));
    renderedCount += batch.length;
    var sentinel = document.getElementById('scrollSentinel');
    if (renderedCount >= filteredWords.length) {
      sentinel.textContent = '— 已显示全部 ' + filteredWords.length + ' 词 —';
    } else {
      sentinel.innerHTML = '<span class="mini-spinner"></span> 加载更多…';
    }
  }

  // 滚动到底自动加载 (复刻 Victor setupSentinelObserver; root 以词库滚动容器为准)
  function setupSentinelObserver() {
    if (_sentinelObserver) { _sentinelObserver.disconnect(); _sentinelObserver = null; }
    if (typeof IntersectionObserver === 'undefined') return;
    var sentinel = document.getElementById('scrollSentinel');
    var scroller = document.getElementById('wordCardList');
    _sentinelObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) { if (en.isIntersecting) appendWords(); });
    }, { root: scroller, rootMargin: '200px' });
    _sentinelObserver.observe(sentinel);
  }

  // 渲染单词卡片 (委托到公共渲染函数)
  function renderCard(w) {
    return App.Utils.renderVictorCard(w);
  }

  // v1.11.1 性能优化: 局部更新某一卡片 (编辑后), 避免全表 reload
  // v1.22.1: 表格改卡片, 直接整体替换卡片节点
  function updateRowInPlace(word) {
    var oldCard = document.querySelector('.word-card[data-word-id="' + CSS.escape(word.id) + '"]');
    if (!oldCard) return false;
    var tmp = document.createElement('div');
    tmp.innerHTML = renderCard(word);
    var newCard = tmp.firstElementChild;
    if (newCard) {
      oldCard.replaceWith(newCard);
    }
    return true;
  }


  // ========== 批量导入 ==========

  function showImportModal() {
    var body =
      '<div class="import-options">' +
        '<div class="import-option selected" data-mode="incremental">' +
          '<div class="option-title">增量导入</div>' +
          '<div class="option-desc">保留现有词库，新增和更新单词</div>' +
        '</div>' +
        '<div class="import-option" data-mode="overwrite">' +
          '<div class="option-title">覆盖词库</div>' +
          '<div class="option-desc">清空现有词库后导入（学习记录也会清除）</div>' +
        '</div>' +
      '</div>' +
      '<div class="file-upload-area" id="uploadArea">' +
        '<p style="font-size:16px;color:var(--color-text-light);">点击选择或拖拽文件到此处</p>' +
        '<p class="form-hint">支持 .xlsx / .xls / .csv 格式，表头需含: 单词/词组、音标、词性、中文译意、例句</p>' +
        '<input type="file" id="importFile" accept=".xlsx,.xls,.csv" style="display:none;">' +
      '</div>' +
      '<div class="form-group" style="margin-top:16px;">' +
        '<label style="display:flex;align-items:center;gap:8px;cursor:pointer;">' +
          '<input type="checkbox" id="autoFillCheck"> ' +
          '<span>只提供了单词时，自动从词典API获取其他字段（较慢，每个单词约0.5秒）</span>' +
        '</label>' +
      '</div>' +
      '<div id="importPreview"></div>' +
      '<div class="form-actions">' +
        '<button class="btn btn-outline" id="btnDownloadTemplate">下载导入模板</button>' +
        '<button class="btn btn-primary" id="btnDoImport" disabled>开始导入</button>' +
      '</div>';

    App.showModal('批量导入单词', body);

    var importMode = 'incremental';
    var parsedWords = null;

    // 导入模式选择
    document.querySelectorAll('.import-option').forEach(function (opt) {
      opt.addEventListener('click', function () {
        document.querySelectorAll('.import-option').forEach(function (o) { o.classList.remove('selected'); });
        opt.classList.add('selected');
        importMode = opt.dataset.mode;
      });
    });

    // 文件上传
    var uploadArea = document.getElementById('uploadArea');
    var fileInput = document.getElementById('importFile');
    uploadArea.addEventListener('click', function () { fileInput.click(); });
    fileInput.addEventListener('change', function () {
      if (fileInput.files.length > 0) handleFile(fileInput.files[0]);
    });
    uploadArea.addEventListener('dragover', function (e) {
      e.preventDefault();
      uploadArea.style.borderColor = 'var(--color-primary)';
      uploadArea.style.background = 'rgba(74,144,217,0.05)';
    });
    uploadArea.addEventListener('dragleave', function () {
      uploadArea.style.borderColor = '';
      uploadArea.style.background = '';
    });
    uploadArea.addEventListener('drop', function (e) {
      e.preventDefault();
      uploadArea.style.borderColor = '';
      uploadArea.style.background = '';
      if (e.dataTransfer.files.length > 0) handleFile(e.dataTransfer.files[0]);
    });

    async function handleFile(file) {
      try {
        parsedWords = await parseExcel(file);
        var preview = document.getElementById('importPreview');
        if (parsedWords.length === 0) {
          preview.innerHTML = '<div class="auto-fill-status error">文件中未找到有效单词数据</div>';
          document.getElementById('btnDoImport').disabled = true;
          return;
        }
        var needAutoFill = parsedWords.filter(function (w) {
          return !w.phonetic && !w.chineseMeaning;
        }).length;

        preview.innerHTML =
          '<div class="auto-fill-status success">' +
            '解析成功：共 ' + parsedWords.length + ' 个单词' +
            (needAutoFill > 0 ? '，其中 ' + needAutoFill + ' 个缺少释义，可自动补全' : '') +
          '</div>';
        document.getElementById('btnDoImport').disabled = false;
      } catch (e) {
        document.getElementById('importPreview').innerHTML =
          '<div class="auto-fill-status error">文件解析失败: ' + e.message + '</div>';
        document.getElementById('btnDoImport').disabled = true;
      }
    }

    // 下载模板
    document.getElementById('btnDownloadTemplate').addEventListener('click', downloadTemplate);

    // 执行导入
    document.getElementById('btnDoImport').addEventListener('click', async function () {
      if (!parsedWords) return;
      var btn = this;
      btn.disabled = true;
      btn.textContent = '导入中...';

      try {
        var autoFill = document.getElementById('autoFillCheck').checked;

        // 自动补全缺少释义的单词
        if (autoFill) {
          var needFill = parsedWords.filter(function (w) { return !w.chineseMeaning; });
          if (needFill.length > 0) {
            btn.textContent = '补全中 (0/' + needFill.length + ')...';
            var batchResult = await App.Dictionary.lookupBatch(
              needFill.map(function (w) { return w.word; }),
              function (current, total, failedCount) {
                btn.textContent = '补全中 (' + current + '/' + total + (failedCount > 0 ? ', 失败' + failedCount : '') + ')...';
              }
            );
            // 回填补全结果
            batchResult.results.forEach(function (r, i) {
              needFill[i].phonetic = needFill[i].phonetic || r.phonetic;
              needFill[i].partOfSpeech = needFill[i].partOfSpeech || r.partOfSpeech;
              needFill[i].chineseMeaning = needFill[i].chineseMeaning || r.chineseMeaning;
              needFill[i].exampleSentence = needFill[i].exampleSentence || r.exampleSentence;
            });
            // 限流终止提示
            if (batchResult.aborted) {
              App.showToast('API 限流, ' + batchResult.failed.length + ' 个词未补全, 可稍后重试导入', 'warning', 5000);
            }
          }
        }

        btn.textContent = '保存中...';
        var count = await App.DB.addWordsBatch(parsedWords, importMode);
        App.hideModal();
        var msg = '成功导入 ' + count + ' 个单词！';
        App.showToast(msg, 'success');
        await loadWords(currentQuery);
      } catch (e) {
        btn.disabled = false;
        btn.textContent = '开始导入';
        App.showToast('导入失败: ' + e.message, 'error');
      }
    });
  }

  async function parseExcel(file) {
    var XLSX = await ensureXLSX();
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function (e) {
        try {
          var data = new Uint8Array(e.target.result);
          var workbook = XLSX.read(data, { type: 'array', cellDates: false, cellNF: false });
          if (!workbook.SheetNames || workbook.SheetNames.length === 0) {
            throw new Error('Excel 文件中没有工作表');
          }
          var sheet = workbook.Sheets[workbook.SheetNames[0]];
          if (!sheet) throw new Error('工作表为空');
          var json = XLSX.utils.sheet_to_json(sheet, {
            defval: '',
            raw: false,
          });

          var words = [];
          for (var i = 0; i < json.length; i++) {
            var row = json[i];
            var word = { word: '', phonetic: '', partOfSpeech: '', chineseMeaning: '', exampleSentence: '' };
            var keys = Object.keys(row);
            for (var j = 0; j < keys.length; j++) {
              var key = keys[j];
              var val = row[key];
              var fieldName = HEADER_MAP[key.trim()] || HEADER_MAP[key];
              if (fieldName && val !== null && val !== undefined) {
                word[fieldName] = String(val).trim();
              }
            }
            if (word.word) words.push(word);
          }

          resolve(words);
        } catch (e) {
          reject(new Error('文件格式不正确: ' + (e.message || String(e))));
        }
      };
      reader.onerror = function () { reject(new Error('文件读取失败')); };
      try {
        reader.readAsArrayBuffer(file);
      } catch (e) {
        reject(new Error('文件读取失败: ' + e.message));
      }
    });
  }

  async function downloadTemplate() {
    var XLSX = await ensureXLSX();
    var data = [{
      '单词/词组': 'apple',
      '音标': '/ˈæp.əl/',
      '词性': 'n.',
      '中文译意': '苹果',
      '例句': 'I eat an apple every day.',
    }, {
      '单词/词组': 'growth',
      '音标': '/ɡroʊθ/',
      '词性': 'n. / adj.',
      '中文译意': '增长；发展 / 发展的；增长的',
      '例句': 'Growth was dampened by the economy.',
    }, {
      '单词/词组': 'run',
      '音标': '/rʌn/',
      '词性': 'v. / n.',
      '中文译意': '跑；运行；经营；流动 / 跑步；运行',
      '例句': 'He runs every morning.',
    }];
    var ws = XLSX.utils.json_to_sheet(data);
    // 设置列宽
    ws['!cols'] = [{ wch: 15 }, { wch: 15 }, { wch: 15 }, { wch: 30 }, { wch: 30 }];
    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '词库');
    XLSX.writeFile(wb, '词库导入模板.xlsx');
  }

  // ========== 单个新增 / 编辑 / 查词 ==========

  /**
   * 带查重的弹窗: 先查词库, 已存在则只读展示, 不存在则联网补全
   * @param {string} wordText - 要查的单词
   * @param {boolean} fromScan - 是否来自扫词 (影响标题)
   */
  async function showWordModalWithCheck(wordText, fromScan) {
    wordText = (wordText || '').trim();
    console.log('[OCR] showWordModalWithCheck 被调用, wordText="' + wordText + '", fromScan=' + fromScan);
    if (!wordText) { 
      console.log('[OCR] wordText为空, 调用 showWordModal()');
      showWordModal(); 
      return; 
    }

    // 1. 查词库
    var statusDiv = document.createElement('div');
    App.showModal(fromScan ? '扫词结果' : '查词', '<div style="text-align:center;padding:30px 10px;color:var(--color-text-light);">正在查询词库...</div>');
    console.log('[OCR] 显示查询中弹窗, 正在查词库...');

    try {
      var existing = await App.DB.findWordByText(wordText);
      console.log('[OCR] 查词库结果: ' + (existing ? '已存在 (ID=' + existing.id + ')' : '不存在'));
      if (existing) {
        // 词库中已存在: 只读展示
        console.log('[OCR] 调用 showWordModal(existing, viewOnly=true)');
        showWordModal(existing, { viewOnly: true });
        return;
      }
      // 词库中不存在: 预填单词并联网补全
      console.log('[OCR] 调用 showWordModal(null, prefillWord="' + wordText + '", autoFill=true)');
      showWordModal(null, { prefillWord: wordText, autoFill: true });
    } catch (e) {
      console.log('[OCR] 查词库异常: ' + e.message + ', 退回到普通新增');
      // 查询失败, 退回到普通新增
      showWordModal(null, { prefillWord: wordText });
    }
  }

  /**
   * 单词弹窗 (新增/编辑/只读)
   * @param {object|null} word - 编辑时传入, 新增时为null
   * @param {object} options - { prefillWord, autoFill, viewOnly }
   */
  function showWordModal(word, options) {
    options = options || {};
    var isEdit = !!word;
    var isViewOnly = !!options.viewOnly;
    var prefillWord = options.prefillWord || '';
    var shouldAutoFill = !!options.autoFill;
    console.log('[OCR] showWordModal 被调用, isEdit=' + isEdit + ', isViewOnly=' + isViewOnly + ', prefillWord="' + prefillWord + '", autoFill=' + shouldAutoFill);
    var esc = App.Utils.escapeHtml;
    var title = isViewOnly ? '单词详情' : (isEdit ? '编辑单词' : '新增单词');

    var body =
      '<div class="form-group">' +
        '<label>单词/词组 *</label>' +
        '<input type="text" id="wordInput" placeholder="输入英文单词或词组" value="' + esc(word ? word.word : prefillWord) + '"' + (isViewOnly ? ' readonly' : '') + '>' +
        '<span id="wordExistBadge" style="display:none;margin-top:4px;font-size:13px;color:#E74C3C;">⚠ 该单词已存在于词库中</span>' +
      '</div>' +
      '<div class="form-group" id="autoFillGroup"' + (isViewOnly ? ' style="display:none;"' : '') + '>' +
        '<button class="btn btn-outline" id="btnAutoFill">自动补全</button>' +
        '<span id="autoFillStatus" style="margin-left:12px;font-size:13px;color:var(--color-text-light);"></span>' +
      '</div>' +
      '<div class="form-group">' +
        '<label>音标</label>' +
        '<input type="text" id="phoneticInput" placeholder="如 /ˈæp.əl/" value="' + esc(word ? word.phonetic : '') + '"' + (isViewOnly ? ' readonly' : '') + '>' +
      '</div>' +
      '<div class="form-group">' +
        '<label>词性 <span style="color:#999;font-weight:normal;font-size:12px;">多词性用 / 隔开</span></label>' +
        '<input type="text" id="posInput" placeholder="如 n. / v. / adj." value="' + esc(word ? word.partOfSpeech : '') + '"' + (isViewOnly ? ' readonly' : '') + '>' +
      '</div>' +
      '<div class="form-group">' +
        '<label>中文释义 <span style="color:#999;font-weight:normal;font-size:12px;">同词性多释义用；隔开，不同词性用 / 隔开</span></label>' +
        '<input type="text" id="meaningInput" placeholder="如 增长；发展 / 发育；生长" value="' + esc(word ? word.chineseMeaning : '') + '"' + (isViewOnly ? ' readonly' : '') + '>' +
      '</div>' +
      '<div class="form-group">' +
        '<label>例句</label>' +
        '<textarea id="exampleInput" placeholder="如 I eat an apple every day."' + (isViewOnly ? ' readonly' : '') + '>' + esc(word ? word.exampleSentence : '') + '</textarea>' +
      '</div>' +
      '<div class="form-actions">' +
        '<button class="btn btn-outline" id="btnCancelWord">关闭</button>' +
        (isViewOnly
          ? '<button class="btn btn-secondary" id="btnEditExisting">编辑此单词</button>'
          : '<button class="btn btn-primary" id="btnSaveWord">' + (isEdit ? '保存修改' : '保存') + '</button>') +
      '</div>';

    App.showModal(title, body);
    document.getElementById('btnCancelWord').addEventListener('click', App.hideModal);

    // 只读模式: 切换到编辑模式
    if (isViewOnly) {
      document.getElementById('btnEditExisting').addEventListener('click', function () {
        App.hideModal();
        showWordModal(word); // 以编辑模式重新打开
      });
      return;
    }

    // 自动补全
    document.getElementById('btnAutoFill').addEventListener('click', function () {
      autoFillWord();
    });

    // 单词输入框失焦时查重 (仅新增模式)
    if (!isEdit) {
      document.getElementById('wordInput').addEventListener('blur', function () {
        checkWordExists();
      });
    }

    // 自动触发补全
    if (shouldAutoFill) {
      setTimeout(function () { autoFillWord(); }, 300);
    }

    // --- 内部函数 ---

    /** 联网自动补全 */
    async function autoFillWord() {
      var wordText = document.getElementById('wordInput').value.trim();
      if (!wordText) {
        App.showToast('请先输入单词', 'warning');
        return;
      }
      var status = document.getElementById('autoFillStatus');
      var btn = document.getElementById('btnAutoFill');
      btn.disabled = true;
      status.innerHTML = '<span style="color:#F39C12;">查询中...</span>';

      try {
        var result = await App.Dictionary.lookup(wordText);
        document.getElementById('phoneticInput').value = result.phonetic || '';
        document.getElementById('posInput').value = result.partOfSpeech || '';
        document.getElementById('meaningInput').value = result.chineseMeaning || '';
        document.getElementById('exampleInput').value = result.exampleSentence || '';

        var filled = [result.phonetic, result.partOfSpeech, result.chineseMeaning, result.exampleSentence]
          .filter(function (v) { return v; }).length;
        if (filled === 0) {
          status.innerHTML = '<span style="color:#E74C3C;">未查询到信息，请手动填写</span>';
        } else {
          status.innerHTML = '<span style="color:#27AE60;">已补全 ' + filled + ' 个字段</span>';
        }
      } catch (e) {
        status.innerHTML = '<span style="color:#E74C3C;">查询失败，请手动填写</span>';
      } finally {
        btn.disabled = false;
      }
    }

    /** 查重: 检查词库中是否已存在 */
    async function checkWordExists() {
      var wordText = document.getElementById('wordInput').value.trim();
      if (!wordText || isEdit) return;
      var badge = document.getElementById('wordExistBadge');
      var saveBtn = document.getElementById('btnSaveWord');
      if (!saveBtn) return;

      try {
        var existing = await App.DB.findWordByText(wordText);
        if (existing) {
          badge.style.display = 'block';
          saveBtn.disabled = true;
          saveBtn.textContent = '已存在，无法重复添加';
        } else {
          badge.style.display = 'none';
          saveBtn.disabled = false;
          saveBtn.textContent = '保存';
        }
      } catch (e) { /* 查询失败不阻塞 */ }
    }

    // 保存
    document.getElementById('btnSaveWord').addEventListener('click', async function () {
      var wordText = document.getElementById('wordInput').value.trim();
      if (!wordText) {
        App.showToast('请输入单词', 'warning');
        return;
      }

      var wordData = {
        word: wordText,
        phonetic: document.getElementById('phoneticInput').value.trim(),
        partOfSpeech: document.getElementById('posInput').value.trim(),
        chineseMeaning: document.getElementById('meaningInput').value.trim(),
        exampleSentence: document.getElementById('exampleInput').value.trim(),
      };

      if (isEdit) {
        wordData.id = word.id;
        wordData.totalCount = word.totalCount;
        wordData.knownCount = word.knownCount;
        wordData.lastKnownTime = word.lastKnownTime;
        wordData.lastLearnTime = word.lastLearnTime;
        wordData.createdAt = word.createdAt;
      }

      try {
        await App.DB.addWord(wordData);
        App.hideModal();
        App.showToast(isEdit ? '修改成功！' : '添加成功！', 'success');
        // v1.11.1 性能优化: 编辑已存在行, 走局部更新; 新增仍需 reload (因排序可能不在当前页)
        if (isEdit) {
          // addWord 已把 wordData 完整存入, id 不变, 直接用其更新行
          if (!updateRowInPlace(wordData)) {
            // 行不在当前视图中 (翻页/搜索), 兜底 reload
            await loadWords(currentQuery);
          }
        } else {
          await loadWords(currentQuery);
        }
      } catch (e) {
        App.showToast('保存失败: ' + e.message, 'error');
      }
    });
  }

  // ========== 摄像头扫词 ==========

  function showCameraScan() {
    // 检查浏览器支持
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      App.showToast('您的浏览器不支持摄像头功能', 'error');
      return;
    }

    // 预检查 Tesseract.js 是否加载, 未加载则动态加载
    if (typeof Tesseract === 'undefined') {
      App.showModal('加载OCR引擎', '<div style="text-align:center;padding:30px 10px;"><div class="camera-spinner" style="margin:0 auto 16px;"></div><p style="color:var(--color-text-light);">正在加载OCR引擎，请稍候...</p></div>');
      loadTesseractAsync().then(function () {
        App.hideModal();
        openCameraUI();
      }).catch(function (e) {
        App.hideModal();
        App.showConfirm('OCR 引擎加载失败：' + e.message + '\n是否改用手动输入单词？', function () {
          showWordModal();
        });
      });
    } else {
      openCameraUI();
    }
  }

  /** 动态加载 Tesseract.js */
  function loadTesseractAsync() {
    return new Promise(function (resolve, reject) {
      var script = document.createElement('script');
      script.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.0/dist/tesseract.min.js';
      script.onload = function () {
        if (typeof Tesseract !== 'undefined') resolve();
        else reject(new Error('脚本已加载但 Tesseract 未定义'));
      };
      script.onerror = function () {
        reject(new Error('CDN 加载失败，请检查网络'));
      };
      document.head.appendChild(script);
    });
  }

  /** 打开摄像头界面 */
  function openCameraUI() {

    // 创建摄像头覆盖层
    var overlay = document.createElement('div');
    overlay.id = 'cameraOverlay';
    overlay.className = 'camera-overlay';
    overlay.innerHTML =
      '<div class="camera-container">' +
        '<div class="camera-header">' +
          '<button class="btn btn-outline btn-sm" id="btnCloseCamera">关闭</button>' +
          '<span class="camera-title">扫词加词</span>' +
          '<span style="width:50px;"></span>' +
        '</div>' +
        '<div class="camera-preview-wrap">' +
          '<video id="cameraVideo" autoplay playsinline muted></video>' +
          '<div class="camera-guide-box"></div>' +
        '</div>' +
        '<div class="camera-controls">' +
          '<p class="camera-hint">将单词对准框内，点击拍照识别</p>' +
          '<button class="btn btn-primary btn-large" id="btnCapture">拍照识别</button>' +
        '</div>' +
        '<canvas id="captureCanvas" style="display:none;"></canvas>' +
        '<div class="camera-loading hidden" id="cameraLoading">' +
          '<div class="camera-loading-inner">' +
            '<div class="camera-spinner"></div>' +
            '<p id="cameraLoadingText">正在识别中...</p>' +
          '</div>' +
        '</div>' +
      '</div>';

    document.body.appendChild(overlay);
    overlay.classList.add('active');

    var video = document.getElementById('cameraVideo');
    var stream = null;
    var isProcessing = false;

    // 启动摄像头 (优先后置)
    navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' } },
      audio: false
    }).then(function (s) {
      stream = s;
      video.srcObject = s;
    }).catch(function (e) {
      // 后置失败, 尝试任意摄像头
      navigator.mediaDevices.getUserMedia({ video: true, audio: false })
        .then(function (s) {
          stream = s;
          video.srcObject = s;
        }).catch(function (e2) {
          App.showToast('无法访问摄像头: ' + e2.message, 'error');
          closeCamera();
        });
    });

    function closeCamera() {
      if (stream) {
        stream.getTracks().forEach(function (t) { t.stop(); });
        stream = null;
      }
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    }

    document.getElementById('btnCloseCamera').addEventListener('click', closeCamera);

    // 拍照识别
    document.getElementById('btnCapture').addEventListener('click', async function () {
      if (isProcessing) return;
      if (!stream) {
        App.showToast('摄像头未就绪，请稍候', 'warning');
        return;
      }

      isProcessing = true;
      var btn = this;
      btn.disabled = true;
      var loading = document.getElementById('cameraLoading');
      var loadingText = document.getElementById('cameraLoadingText');
      loading.classList.remove('hidden');
      loadingText.textContent = '正在识别中...';

      // 超时保护 (首次60秒, 后续30秒)
      var timeoutMs = ocrWorker ? 30000 : 60000;
      var timeoutId = setTimeout(function () {
        loading.classList.add('hidden');
        isProcessing = false;
        btn.disabled = false;
        App.showToast('操作超时，请检查网络后重试，或使用"单个新增"手动输入', 'error', 5000);
      }, timeoutMs);

      try {
        var canvas = document.getElementById('captureCanvas');
        var ctx = canvas.getContext('2d');

        // 获取视频实际分辨率
        var videoW = video.videoWidth || 640;
        var videoH = video.videoHeight || 480;

        // 获取视频元素在页面上的显示尺寸
        var displayRect = video.getBoundingClientRect();
        var displayW = displayRect.width;
        var displayH = displayRect.height;

        // 计算 object-fit: cover 的映射关系
        var videoAspect = videoW / videoH;
        var containerAspect = displayW / displayH;
        var coverScale, coverOffsetX, coverOffsetY;

        if (videoAspect > containerAspect) {
          coverScale = displayH / videoH;
          coverOffsetX = (videoW * coverScale - displayW) / 2;
          coverOffsetY = 0;
        } else {
          coverScale = displayW / videoW;
          coverOffsetX = 0;
          coverOffsetY = (videoH * coverScale - displayH) / 2;
        }

        // 获取取景框在视频元素内的位置 (CSS像素)
        var guideBox = document.querySelector('.camera-guide-box');
        var guideRect = guideBox.getBoundingClientRect();
        var guideLeft = guideRect.left - displayRect.left;
        var guideTop = guideRect.top - displayRect.top;
        var guideWidth = guideRect.width;
        var guideHeight = guideRect.height;

        // 将取景框CSS坐标映射到视频帧坐标
        var cropX = Math.floor((guideLeft + coverOffsetX) / coverScale);
        var cropY = Math.floor((guideTop + coverOffsetY) / coverScale);
        var cropW = Math.floor(guideWidth / coverScale);
        var cropH = Math.floor(guideHeight / coverScale);

        // 边界保护
        cropX = Math.max(0, Math.min(cropX, videoW - 1));
        cropY = Math.max(0, Math.min(cropY, videoH - 1));
        cropW = Math.min(cropW, videoW - cropX);
        cropH = Math.min(cropH, videoH - cropY);

        // 先截取完整视频帧到临时canvas
        var tempCanvas = document.createElement('canvas');
        tempCanvas.width = videoW;
        tempCanvas.height = videoH;
        var tempCtx = tempCanvas.getContext('2d');
        tempCtx.drawImage(video, 0, 0);

        // 从临时canvas裁剪取景框区域并放大
        var targetW = 1200;
        var outScale = Math.max(1, targetW / cropW);
        canvas.width = Math.floor(cropW * outScale);
        canvas.height = Math.floor(cropH * outScale);
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(tempCanvas, cropX, cropY, cropW, cropH, 0, 0, canvas.width, canvas.height);

        console.log('[OCR] 取景框映射: displayRect=' + Math.round(displayW) + 'x' + Math.round(displayH) +
          ', guideBox=' + Math.round(guideWidth) + 'x' + Math.round(guideHeight) +
          ', cropFrame: x=' + cropX + ', y=' + cropY + ', w=' + cropW + ', h=' + cropH +
          ', output=' + canvas.width + 'x' + canvas.height);

        loadingText.textContent = ocrWorker ? '正在识别中...' : '首次加载OCR引擎，请稍候（约10-30秒）...';
        // OCR 识别
        var wordText = await runOCR(canvas, function (status, progress) {
          // 进度回调
          var pct = Math.round((progress || 0) * 100);
          var statusMap = {
            'loading tesseract core': '加载OCR核心',
            'initializing tesseract': '初始化OCR引擎',
            'loading language traineddata': '加载语言包',
            'initializing api': '初始化API',
            'recognizing text': '识别文字中'
          };
          var label = statusMap[status] || status || '处理中';
          loadingText.textContent = label + '... ' + pct + '%';
        });
        clearTimeout(timeoutId);
        console.log('[OCR] 识别完成, 识别结果: "' + wordText + '"');

        if (!wordText) {
          console.log('[OCR] 无有效单词, 提示用户');
          App.showToast('未识别到英文单词，请重新对准单词后再试', 'warning');
          loading.classList.add('hidden');
          isProcessing = false;
          btn.disabled = false;
          return;
        }

        // 关闭摄像头, 显示候选词选择弹窗
        console.log('[OCR] 关闭摄像头, 准备显示候选词');
        closeCamera();
        
        // 显示识别结果弹窗 (用户可编辑)
        showOCRResultModal([], wordText);
      } catch (e) {
        clearTimeout(timeoutId);
        loading.classList.add('hidden');
        isProcessing = false;
        btn.disabled = false;
        App.showToast('识别失败: ' + e.message + '，可手动输入单词', 'error', 5000);
      }
    });
  }

  // OCR Worker 复用 (页面期间只创建一次)
  var ocrWorker = null;
  var ocrInitError = null;
  var tessdataUrlCache = null;

  /** 获取 tessdata 的最佳 URL (本地优先, 否则 CDN) */
  async function getTessdataUrl(onProgress) {
    if (tessdataUrlCache) return tessdataUrlCache;

    var candidates = [
      { url: './tessdata', desc: '本地' },
      { url: 'https://cdn.jsdelivr.net/gh/naptha/tessdata@gh-pages/4.0.0', desc: 'CDN镜像' },
      { url: 'https://tessdata.projectnaptha.com/4.0.0', desc: '官方源' }
    ];

    for (var i = 0; i < candidates.length; i++) {
      try {
        console.log('[OCR] 检查 tessdata 来源: ' + candidates[i].desc + ' (' + candidates[i].url + ')');
        onProgress && onProgress('检查' + candidates[i].desc + 'OCR语言包...', 0);
        
        var testResp = await fetch(candidates[i].url + '/eng.traineddata.gz', { method: 'HEAD' });
        if (testResp.ok) {
          console.log('[OCR] 使用 tessdata 来源: ' + candidates[i].desc);
          tessdataUrlCache = candidates[i].url;
          return tessdataUrlCache;
        }
      } catch (e) {
        console.log('[OCR] 来源不可用: ' + candidates[i].desc, e.message);
      }
    }

    throw new Error('所有OCR语言包来源均不可用，请检查网络连接');
  }

  /** 图像预处理: 灰度化 + 对比度增强 + 二值化, 提升OCR识别率 */
  function preprocessImage(canvas) {
    var w = canvas.width;
    var h = canvas.height;
    var srcCtx = canvas.getContext('2d');
    var imageData = srcCtx.getImageData(0, 0, w, h);
    var data = imageData.data;

    // 1. 灰度化
    var gray = new Uint8ClampedArray(w * h);
    for (var i = 0, j = 0; i < data.length; i += 4, j++) {
      gray[j] = Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
    }

    // 2. 对比度增强 (计算平均亮度, 拉伸动态范围)
    var sum = 0;
    for (var k = 0; k < gray.length; k++) sum += gray[k];
    var avg = sum / gray.length;
    var contrast = 1.8;
    for (var m = 0; m < gray.length; m++) {
      gray[m] = Math.max(0, Math.min(255, Math.round((gray[m] - avg) * contrast + avg)));
    }

    // 3. 二值化 (自适应阈值: 以平均亮度为基准)
    var threshold = avg * 0.7;
    var out = srcCtx.createImageData(w, h);
    var outData = out.data;
    for (var n = 0; n < gray.length; n++) {
      var val = gray[n] > threshold ? 255 : 0;
      outData[n * 4] = val;
      outData[n * 4 + 1] = val;
      outData[n * 4 + 2] = val;
      outData[n * 4 + 3] = 255;
    }

    // 写回canvas
    srcCtx.putImageData(out, 0, 0);
    return canvas;
  }

  /** 使用 Tesseract.js 进行 OCR (自动选择 tessdata 来源 + 多策略识别) */
  async function runOCR(canvas, onProgress) {
    var Tesseract = await ensureTesseract();
    if (typeof Tesseract === 'undefined') {
      throw new Error('OCR 引擎未加载，请检查网络');
    }
    // 首次调用时创建 Worker, 后续复用
    if (!ocrWorker) {
      ocrInitError = null;
      try {
        console.log('[OCR] 开始创建 Worker...');
        
        // 获取 tessdata URL (本地优先, 否则 CDN)
        var langPath = await getTessdataUrl(onProgress);
        console.log('[OCR] 使用 tessdata 路径: ' + langPath);
        
        ocrWorker = await Tesseract.createWorker('eng', 1, {
          langPath: langPath,
          logger: function (m) {
            var progress = m.progress || 0;
            var statusMap = {
              'loading tesseract core': '加载OCR核心',
              'initializing tesseract': '初始化OCR引擎',
              'loading language traineddata': '加载语言包',
              'initializing api': '初始化API',
              'recognizing text': '识别文字中'
            };
            var label = statusMap[m.status] || m.status || '处理中';
            console.log('[OCR] ' + label + ': ' + Math.round(progress * 100) + '%');
            if (onProgress) onProgress(label, progress);
          }
        });
        console.log('[OCR] Worker 创建成功');
      } catch (e) {
        ocrInitError = e;
        console.error('[OCR] Worker 创建失败:', e);
        throw new Error('OCR引擎初始化失败: ' + (e.message || e));
      }
    }
    // 图像预处理: 灰度化+对比度增强+二值化
    preprocessImage(canvas);
    console.log('[OCR] 图像预处理完成');

    // 多策略识别: 原图 + 预处理图, 不同PSM模式
    var allWords = [];

    // 策略1: 预处理后的图像 (PSM 6: 统一文本块)
    var result1 = await ocrWorker.recognize(canvas, { tessedit_pageseg_mode: '6' });
    var text1 = (result1.data.text || '').trim();
    console.log('[OCR] PSM6识别: "' + text1 + '"');
    extractWordsFromText(text1, allWords);

    // 策略2: 预处理后的图像 (PSM 7: 单行文本)
    var result2 = await ocrWorker.recognize(canvas, { tessedit_pageseg_mode: '7' });
    var text2 = (result2.data.text || '').trim();
    console.log('[OCR] PSM7识别: "' + text2 + '"');
    extractWordsFromText(text2, allWords);

    // 去重并按长度排序
    var seen = {};
    var unique = [];
    for (var i = 0; i < allWords.length; i++) {
      var w = allWords[i].toLowerCase();
      if (!seen[w]) {
        seen[w] = true;
        unique.push(w);
      }
    }
    unique.sort(function (a, b) { return b.length - a.length; });
    console.log('[OCR] 识别候选词: ' + JSON.stringify(unique.slice(0, 10)));

    // 返回最长的有效单词 (OCR识别成什么就是什么, 不做纠正)
    // 后续由 showWordModalWithCheck 负责: 精确查词库 → 有则展示, 无则新增
    return unique.length > 0 ? unique[0] : '';
  }

  /** 从文本中提取所有有效单词, 加入候选列表 */
  function extractWordsFromText(text, candidates) {
    if (!text) return;
    var words = text.match(/[a-zA-Z]{2,}[a-zA-Z'-]*/g);
    if (!words) return;
    for (var i = 0; i < words.length; i++) {
      var w = words[i].toLowerCase();
      // 过滤太短或全是辅音的无意义词
      if (w.length >= 2 && !/^[bcdfghjklmnpqrstvwxyz]+$/.test(w)) {
        candidates.push(w);
      }
    }
  }

  /** 显示 OCR 识别结果弹窗, 让用户选择或修正 */
  function showOCRResultModal(candidates, bestWord) {
    var body = 
      '<div style="padding:10px 5px;">' +
        '<div style="margin-bottom:12px;">' +
          '<label style="display:block;font-size:13px;margin-bottom:6px;color:var(--color-text);">单词（可编辑）</label>' +
          '<input type="text" id="ocrWordInput" value="' + App.Utils.escapeHtml(bestWord) + '" ' +
            'style="width:100%;padding:10px 12px;border:1.5px solid #e0e0e0;border-radius:8px;font-size:16px;' +
            'box-sizing:border-box;font-family:monospace;" />' +
        '</div>' +
        '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px;">' +
          '<button class="btn btn-primary" id="ocrConfirmBtn" style="flex:1;min-width:120px;">确认添加</button>' +
          '<button class="btn btn-outline" id="ocrCancelBtn" style="flex:1;min-width:80px;">取消</button>' +
        '</div>' +
        '<p style="color:var(--color-text-light);font-size:12px;margin:0;text-align:center;">' +
          '提示：保持手机稳定、光线充足时识别效果最佳' +
        '</p>' +
      '</div>';
    
    App.showModal('扫词识别结果', body);
    
    setTimeout(function () {
      var input = document.getElementById('ocrWordInput');
      if (input) input.focus();
      
      document.getElementById('ocrConfirmBtn').addEventListener('click', function () {
        var word = (document.getElementById('ocrWordInput').value || '').trim();
        App.hideModal();
        if (word) {
          console.log('[OCR] 用户确认单词: ' + word);
          showWordModalWithCheck(word, true);
        }
      });
      
      document.getElementById('ocrCancelBtn').addEventListener('click', function () {
        App.hideModal();
      });
      
      // 回车确认
      if (input) {
        input.addEventListener('keydown', function (e) {
          if (e.key === 'Enter') {
            document.getElementById('ocrConfirmBtn').click();
          }
        });
      }
    }, 100);
  }

  async function editWord(wordId) {
    try {
      var word = await App.DB.getWord(wordId);
      if (word) showWordModal(word);
    } catch (e) {
      App.showToast('加载单词失败: ' + e.message, 'error');
    }
  }

  async function deleteWord(wordId) {
    App.showConfirm('确定要删除这个单词吗？删除后无法恢复。', async function () {
      try {
        await App.DB.deleteWord(wordId);
        App.showToast('删除成功', 'success');
        // v1.23.0: 删除后重新拉全量并重建列表
        await reloadCurrentPage();
      } catch (e) {
        App.showToast('删除失败: ' + e.message, 'error');
      }
    });
  }

  // ========== 导出备份 ==========

  function showExportModal() {
    var body =
      '<div class="form-group">' +
        '<label>导出格式</label>' +
        '<div class="btn-group" id="exportFormatGroup">' +
          '<button class="btn-toggle active" data-format="xlsx">Excel (.xlsx)</button>' +
          '<button class="btn-toggle" data-format="csv">CSV (.csv)</button>' +
        '</div>' +
      '</div>' +
      '<p class="form-hint">导出词库中全部单词的5个字段信息（单词/词组、音标、词性、中文释义、例句），可用于备份或恢复。</p>' +
      '<div class="form-actions">' +
        '<button class="btn btn-outline" id="btnCancelExport">取消</button>' +
        '<button class="btn btn-primary" id="btnDoExport">导出</button>' +
      '</div>';

    App.showModal('导出备份', body);

    var format = 'xlsx';
    document.getElementById('exportFormatGroup').addEventListener('click', function (e) {
      var btn = e.target.closest('.btn-toggle');
      if (!btn) return;
      this.querySelectorAll('.btn-toggle').forEach(function (b) { b.classList.remove('active'); });
      btn.classList.add('active');
      format = btn.dataset.format;
    });

    document.getElementById('btnCancelExport').addEventListener('click', App.hideModal);
    document.getElementById('btnDoExport').addEventListener('click', async function () {
      try {
        var XLSX = await ensureXLSX();
        var words = await App.DB.getAllWords();
        if (words.length === 0) {
          App.showToast('词库为空，无可导出数据', 'warning');
          return;
        }

        var data = words.map(function (w) {
          return {
            '单词/词组': w.word || '',
            '音标': w.phonetic || '',
            '词性': w.partOfSpeech || '',
            '中文译意': w.chineseMeaning || '',
            '例句': w.exampleSentence || '',
          };
        });

        var ws = XLSX.utils.json_to_sheet(data);
        var wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, '词库');

        var filename = '词库备份_' + App.Utils.formatDate(Date.now()) + '.' + format;
        XLSX.writeFile(wb, filename, { bookType: format });

        App.hideModal();
        App.showToast('已导出 ' + words.length + ' 个单词', 'success');
      } catch (e) {
        App.showToast('导出失败: ' + e.message, 'error');
      }
    });
  }

  // ========== v1.21.0 同步 Victor 词库 (后端任务, 进度持久化) ==========
  var _victorPollTimer = null;

  function statusText(s) {
    if (!s) return '尚未同步';
    if (s.status === 'running' || s.status === 'pending') {
      var pct = s.total > 0 ? Math.round((s.processed / s.total) * 100) : 0;
      return '同步中 ' + (s.processed || 0) + ' / ' + (s.total || 0) + '（' + pct + '%）';
    }
    if (s.status === 'done') {
      return '上次同步完成：新增 ' + (s.added || 0) + ' 词，富化 ' + (s.enriched || 0) + ' 词';
    }
    if (s.status === 'failed') {
      return '上次同步失败：' + (s.error || '未知错误');
    }
    return '尚未同步';
  }

  function showSyncVictorModal() {
    var body =
      '<div style="line-height:1.8;font-size:14px;">' +
        '<p style="margin:0 0 10px;">一键把 <b>Victor 共享词库</b> 同步到你的私有词库：</p>' +
        '<ul style="margin:0 0 12px;padding-left:20px;color:var(--color-text-light);">' +
          '<li>已存在的词：用 Victor 富文本覆盖释义（<b>保留你的学习进度</b>）</li>' +
          '<li>Victor 独有的词：直接新增</li>' +
          '<li>你自己独有的词：不改动</li>' +
        '</ul>' +
        '<p style="margin:0 0 12px;font-size:12px;color:var(--color-text-light);">' +
          '同步在后台执行，关闭页面也不中断；再次打开可继续查看进度。</p>' +
        '<div id="victorSyncStatus" style="padding:12px;background:var(--color-bg);border-radius:8px;' +
          'margin-bottom:14px;font-weight:600;">正在查询同步状态...</div>' +
      '</div>' +
      '<div class="form-actions">' +
        '<button class="btn btn-outline" id="victorSyncCancel">关闭</button>' +
        '<button class="btn btn-primary" id="victorSyncStart">开始同步</button>' +
      '</div>';
    App.showModal('同步 Victor 词库', body);

    var statusEl = document.getElementById('victorSyncStatus');
    var startBtn = document.getElementById('victorSyncStart');
    document.getElementById('victorSyncCancel').addEventListener('click', function () {
      if (_victorPollTimer) { clearInterval(_victorPollTimer); _victorPollTimer = null; }
      App.hideModal();
    });

    function renderStatus(s) {
      if (!statusEl) return;
      statusEl.textContent = statusText(s);
      // 同步中禁用开始按钮, 防止重复触发
      if (startBtn) {
        var busy = s && (s.status === 'running' || s.status === 'pending');
        startBtn.disabled = !!busy;
        startBtn.textContent = busy ? '同步进行中...' : '开始同步';
      }
    }

    function poll() {
      App.DB.victorSyncStatus().then(function (rows) {
        var s = Array.isArray(rows) ? rows[0] : rows;
        renderStatus(s);
        if (s && (s.status === 'running' || s.status === 'pending')) {
          // 继续轮询; 注意页面关闭时 interval 自然停止, 服务端任务不受影响
          if (!_victorPollTimer) {
            _victorPollTimer = setInterval(poll, 1500);
          }
        } else {
          if (_victorPollTimer) { clearInterval(_victorPollTimer); _victorPollTimer = null; }
          if (s && s.status === 'done') loadWords(''); // 完成后刷新词库
        }
      }).catch(function (e) {
        if (statusEl) statusEl.textContent = '查询状态失败：' + e.message;
      });
    }

    // 打开即查一次 (重进页面能看到上次进度/结果)
    poll();

    startBtn.addEventListener('click', function () {
      startBtn.disabled = true; startBtn.textContent = '正在启动...';
      App.DB.syncVictor()
        .then(function () {
          statusEl.textContent = '已启动，后台同步中...';
          if (_victorPollTimer) clearInterval(_victorPollTimer);
          _victorPollTimer = null;
          poll();
        })
        .catch(function (e) {
          statusEl.textContent = '启动失败：' + e.message;
          startBtn.disabled = false; startBtn.textContent = '开始同步';
        });
    });
  }

  // v1.10.0 同步预置词库弹窗 (普通用户选学段 → 调 sync_preset_words RPC)
  function showSyncPresetModal() {
    var stages = ['小学', '初中', '高中', '大学', '考研'];
    var stageOptions = stages.map(function (s) {
      return '<option value="' + s + '">' + s + '</option>';
    }).join('');

    var body =
      '<div class="form-group"><label>选择学段 (含该学段及以下所有词)</label>' +
        '<select id="syncStage" style="width:100%;padding:10px 12px;font-size:14px;border:1px solid var(--color-border);border-radius:var(--radius-sm);background:var(--color-card);">' + stageOptions + '</select>' +
      '</div>' +
      '<div class="form-group">' +
        '<label style="display:flex;align-items:center;gap:8px;cursor:pointer;">' +
          '<input type="checkbox" id="syncOther" style="width:18px;height:18px;">' +
          '<span>同时同步"其他"词汇 (无法归类的补充包)</span>' +
        '</label>' +
      '</div>' +
      '<div class="form-group">' +
        '<p style="font-size:13px;color:var(--color-text-light);line-height:1.6;">' +
          '说明: 同步后单词会复制到你的私有词库，可在词库中自由增删改。<br>' +
          '已存在的单词会跳过，不会覆盖你的学习进度。' +
        '</p>' +
      '</div>' +
      '<div class="form-actions">' +
        '<button class="btn btn-outline" id="syncCancel">取消</button>' +
        '<button class="btn btn-primary" id="syncConfirm">同步</button>' +
      '</div>';

    App.showModal('同步预置词库', body);

    document.getElementById('syncCancel').addEventListener('click', App.hideModal);
    document.getElementById('syncConfirm').addEventListener('click', function () {
      var stage = document.getElementById('syncStage').value;
      var includeOther = document.getElementById('syncOther').checked;
      var btn = this;
      btn.disabled = true; btn.textContent = '同步中...';

      App.DB.syncPresetWords(stage, includeOther)
        .then(function (res) {
          if (!res || !res.success) {
            throw new Error((res && res.error) || '同步失败');
          }
          var msg = '同步成功: 新增 ' + res.inserted + ' 词';
          if (res.skipped > 0) msg += '，跳过已存在 ' + res.skipped + ' 词';
          App.showToast(msg, 'success');
          App.hideModal();
          loadWords(''); // 刷新词库列表
        })
        .catch(function (e) {
          App.showToast('同步失败: ' + e.message, 'error');
        })
        .then(function () {
          btn.disabled = false; btn.textContent = '同步';
        });
    });
  }

  return {
    init: init,
    show: show,
    loadWords: loadWords,
    toggleCard: toggleCard,
  };
})();

// ES Module 导出 (供 main.js 动态 import, 同时 window.App.Library 命名空间保留供业务模块使用)
export default App.Library;
