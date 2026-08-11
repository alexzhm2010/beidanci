/**
 * 词库模块
 * 功能: 搜索、批量导入、单个新增、导出备份、编辑/删除
 */
window.App = window.App || {};
App.Library = (function () {
  var currentQuery = '';
  var displayedCount = 0;
  var totalCount = 0;
  var isLoading = false;
  var hasMore = true;

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
    // 搜索 (防抖)
    var debouncedSearch = App.Utils.debounce(function () {
      loadWords(document.getElementById('searchInput').value);
    }, 800);
    document.getElementById('searchInput').addEventListener('input', debouncedSearch);

    // 工具栏按钮
    document.getElementById('btnImport').addEventListener('click', showImportModal);
    document.getElementById('btnAddWord').addEventListener('click', function () { showWordModal(); });
    document.getElementById('btnScanWord').addEventListener('click', showCameraScan);
    document.getElementById('btnExport').addEventListener('click', showExportModal);

    // 表格事件委托 (编辑)
    document.getElementById('wordTableBody').addEventListener('click', function (e) {
      var btn = e.target.closest('button');
      if (!btn) return;
      var row = btn.closest('tr');
      var wordId = row.dataset.wordId;
      if (btn.classList.contains('btn-edit')) editWord(wordId);
    });

    // 滚动加载更多
    var container = document.querySelector('.word-table-container');
    if (container) {
      container.addEventListener('scroll', handleScroll);
    }
    // 移动端: 监听窗口滚动
    window.addEventListener('scroll', function () {
      var view = document.getElementById('view-library');
      if (!view || !view.classList.contains('active')) return;
      handleScroll();
    });
  }

  function handleScroll() {
    if (isLoading || !hasMore) return;
    var scrollContainer = document.querySelector('.word-table-container');
    var scrollTop, scrollHeight, clientHeight;

    if (scrollContainer) {
      scrollTop = scrollContainer.scrollTop;
      scrollHeight = scrollContainer.scrollHeight;
      clientHeight = scrollContainer.clientHeight;
    } else {
      scrollTop = window.scrollY || document.documentElement.scrollTop;
      scrollHeight = document.documentElement.scrollHeight;
      clientHeight = window.innerHeight;
    }

    // 距底部 50px 内触发加载
    if (scrollTop + clientHeight >= scrollHeight - 50) {
      loadMore();
    }
  }

  async function show() {
    document.getElementById('searchInput').value = currentQuery;
    await loadWords(currentQuery);
  }

  // ========== 搜索 & 渲染 ==========

  async function loadWords(query) {
    currentQuery = query || '';
    displayedCount = 0;
    totalCount = 0;
    hasMore = true;
    var tbody = document.getElementById('wordTableBody');
    tbody.innerHTML = '<tr><td colspan="5" class="empty-row">加载中...</td></tr>';

    isLoading = true;
    try {
      var result = await App.DB.searchWords(currentQuery, 0, App.Config.SEARCH_MAX_ROWS);
      totalCount = result.total;
      displayedCount = result.words.length;
      hasMore = displayedCount < totalCount;
      renderTable(result.words, true);
      updateInfo();

      // 搜索无结果且查询词非空: 自动弹出新增弹窗
      if (result.words.length === 0 && currentQuery.trim()) {
        var searchTerm = currentQuery.trim();
        // 判断是否像英文单词 (含字母)
        if (/[a-zA-Z]/.test(searchTerm)) {
          App.showToast('词库中未找到"' + searchTerm + '"，正在为您查词...', 'info', 3000);
          showWordModalWithCheck(searchTerm);
        }
      }
    } catch (e) {
      tbody.innerHTML = '<tr><td colspan="5" class="empty-row">加载失败: ' + App.Utils.escapeHtml(e.message) + '</td></tr>';
      App.showToast('加载词库失败: ' + e.message, 'error');
    } finally {
      isLoading = false;
    }
  }

  async function loadMore() {
    if (isLoading || !hasMore) return;
    isLoading = true;

    // 显示加载指示器
    var tbody = document.getElementById('wordTableBody');
    var loadingRow = document.createElement('tr');
    loadingRow.className = 'loading-row';
    loadingRow.innerHTML = '<td colspan="5" class="empty-row">加载中...</td>';
    tbody.appendChild(loadingRow);

    try {
      var nextOffset = displayedCount;
      var result = await App.DB.searchWords(currentQuery, nextOffset, App.Config.SEARCH_PAGE_SIZE);
      totalCount = result.total;

      // 移除加载指示器
      tbody.removeChild(loadingRow);

      if (result.words.length > 0) {
        displayedCount += result.words.length;
        hasMore = displayedCount < totalCount;
        renderTable(result.words, false);
      } else {
        hasMore = false;
      }
      updateInfo();
    } catch (e) {
      try { tbody.removeChild(loadingRow); } catch (e2) {}
      App.showToast('加载更多失败: ' + e.message, 'error');
    } finally {
      isLoading = false;
    }
  }

  function updateInfo() {
    var info = document.getElementById('libraryWordCount');
    var searchInfo = document.getElementById('librarySearchInfo');
    info.textContent = displayedCount + ' / ' + totalCount;
    searchInfo.textContent = currentQuery ? '搜索: "' + currentQuery + '"' : '按熟练度排序';
  }

  function renderTable(words, isReset) {
    var tbody = document.getElementById('wordTableBody');
    var esc = App.Utils.escapeHtml;

    if (isReset) {
      if (words.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" class="empty-row">暂无单词数据，点击"单个新增"或"批量导入"添加单词</td></tr>';
        return;
      }
      tbody.innerHTML = words.map(function (w) { return renderRow(w); }).join('');
    } else {
      // 追加模式
      if (words.length === 0) return;
      var html = words.map(function (w) { return renderRow(w); }).join('');
      tbody.insertAdjacentHTML('beforeend', html);
    }

    // 底部提示 (仅在加载过更多数据后显示)
    if (!hasMore && displayedCount > App.Config.SEARCH_MAX_ROWS) {
      var endRow = document.createElement('tr');
      endRow.innerHTML = '<td colspan="5" class="empty-row" style="padding:20px;color:var(--color-text-lighter);">没有更多了</td>';
      tbody.appendChild(endRow);
    }
  }

  function renderRow(w) {
    var esc = App.Utils.escapeHtml;
    var level = App.Algorithm.getProficiencyLevel(w);
    var proficiency = w.totalCount > 0
      ? Math.round((w.knownCount / w.totalCount) * 100) + '%'
      : '-';

    return '' +
      '<tr data-word-id="' + esc(w.id) + '">' +
        '<td class="col-word">' + esc(w.word) + '</td>' +
        '<td class="col-phonetic">' + esc(w.phonetic) + '</td>' +
        '<td class="col-meaning">' + esc(w.chineseMeaning) + '</td>' +
        '<td class="col-proficiency">' +
          '<span class="proficiency-badge" style="background:' + level.color + '20;color:' + level.color + '">' +
            level.label + ' ' + proficiency + '</span>' +
        '</td>' +
        '<td class="col-actions">' +
          '<button class="btn btn-outline btn-sm btn-edit">编辑</button>' +
        '</td>' +
      '</tr>';
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

  function parseExcel(file) {
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

  function downloadTemplate() {
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
        await loadWords(currentQuery);
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
        await loadWords(currentQuery);
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

  return {
    init: init,
    show: show,
    loadWords: loadWords,
  };
})();
