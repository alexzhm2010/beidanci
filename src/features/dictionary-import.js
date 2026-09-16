/**
 * 词典导入模块 (v1.12.0)
 * Admin 专属功能: 从词典拍照 → OCR → 结构化解析 → 审核 → 发布
 *
 * 流程:
 *   1. 上传 (拍照/相册, 最多10张)
 *   2. OCR (Tesseract.js, 本地免费)
 *   3. 解析 (按词典排版规则切分 headword/义项/派生词/词组)
 *   4. 保存批次到 dictionary_imports + dictionary_pages + dictionary_entries
 *   5. 审核 (admin 逐条确认/拒绝)
 *   6. 发布 (accepted 词条写入 words 表)
 */
window.App = window.App || {};
App.DictImport = (function () {

  var MAX_PAGES = 10;
  var ocrWorker = null;

  // ========== HTML 模板 ==========
  function containerHtml() {
    return (
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">' +
        '<h3 style="margin:0;">词典导入</h3>' +
        '<button class="btn btn-outline btn-sm" id="btnShowHistory">历史批次</button>' +
      '</div>' +
      '<div id="dictImportContainer"></div>'
    );
  }

  // ========== 入口 ==========
  function init() {
    var adminContainer = document.getElementById('adminTabContent');
    if (!adminContainer) return;
    adminContainer.innerHTML = containerHtml();
    var historyBtn = document.getElementById('btnShowHistory');
    if (historyBtn) historyBtn.addEventListener('click', showHistory);
    showUpload();
  }

  // ========== Step 1: 上传 ==========
  function showUpload() {
    var container = document.getElementById('dictImportContainer');
    container.innerHTML = (
      '<div class="dict-upload">' +
        '<div class="dict-upload-hint">' +
          '<p style="margin:0 0 8px;font-weight:600;">上传词典页面照片</p>' +
          '<p style="margin:0;color:var(--color-text-light);font-size:13px;line-height:1.6;">' +
            '支持拍照或从相册选择, 一次最多 ' + MAX_PAGES + ' 张。<br>' +
            '请确保页面完整清晰, 页码在页眉/页脚可见, 方便系统自动识别。' +
          '</p>' +
        '</div>' +
        '<div style="display:flex;gap:12px;margin:16px 0;flex-wrap:wrap;">' +
          '<button class="btn btn-primary" id="btnCamera" style="flex:1;min-width:180px;">📷 拍照上传</button>' +
          '<button class="btn btn-outline" id="btnAlbum" style="flex:1;min-width:180px;">🖼 从相册选择</button>' +
        '</div>' +
        '<input type="file" id="fileCamera" accept="image/*" capture="environment" multiple style="display:none;">' +
        '<input type="file" id="fileAlbum" accept="image/*" multiple style="display:none;">' +
        '<div id="previewArea" style="display:none;margin-top:16px;"></div>' +
        '<div id="dictImportActions" style="display:none;gap:12px;margin-top:20px;">' +
          '<button class="btn btn-danger btn-sm" id="btnReset">重新选择</button>' +
          '<button class="btn btn-primary" id="btnStartParse">开始识别解析 →</button>' +
        '</div>' +
      '</div>'
    );

    document.getElementById('btnCamera').addEventListener('click', function () {
      document.getElementById('fileCamera').click();
    });
    document.getElementById('btnAlbum').addEventListener('click', function () {
      document.getElementById('fileAlbum').click();
    });
    document.getElementById('fileCamera').addEventListener('change', onFileSelected);
    document.getElementById('fileAlbum').addEventListener('change', onFileSelected);
    document.getElementById('btnReset').addEventListener('click', showUpload);
    document.getElementById('btnStartParse').addEventListener('click', startParse);
  }

  var selectedFiles = [];

  function onFileSelected(e) {
    var files = Array.from(e.target.files || []);
    if (files.length === 0) return;

    // 最多 10 张
    selectedFiles = files.slice(0, MAX_PAGES);
    if (files.length > MAX_PAGES) {
      App.showToast('已自动截取前 ' + MAX_PAGES + ' 张, 多余的被忽略', 'info');
    }

    renderPreview();
  }

  function renderPreview() {
    var area = document.getElementById('previewArea');
    var actions = document.getElementById('dictImportActions');
    area.style.display = 'block';
    actions.style.display = 'flex';

    area.innerHTML = (
      '<div style="font-size:13px;color:var(--color-text-light);margin-bottom:8px;">' +
        '已选 ' + selectedFiles.length + ' 张, 点击"开始识别解析"进行 OCR 和结构化处理' +
      '</div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;">' +
        selectedFiles.map(function (f, i) {
          var url = URL.createObjectURL(f);
          return (
            '<div style="width:80px;height:100px;border:1px solid var(--color-border);border-radius:6px;overflow:hidden;font-size:11px;color:var(--color-text-light);text-align:center;">' +
              '<img src="' + url + '" style="width:100%;height:80px;object-fit:cover;display:block;">' +
              (i + 1) +
            '</div>'
          );
        }).join('') +
      '</div>'
    );
  }

  // ========== Step 2: OCR + 解析 ==========
  async function startParse() {
    var container = document.getElementById('dictImportContainer');
    container.innerHTML = (
      '<div style="text-align:center;padding:40px 20px;">' +
        '<div style="font-size:16px;font-weight:600;margin-bottom:12px;">正在识别词典页面...</div>' +
        '<div id="parseProgress" style="color:var(--color-text-light);font-size:13px;">准备中...</div>' +
        '<div id="parseBar" style="width:100%;max-width:400px;height:6px;background:var(--color-border);border-radius:3px;margin:16px auto 0;overflow:hidden;">' +
          '<div id="parseBarFill" style="height:100%;background:var(--color-primary);border-radius:3px;width:0%;transition:width 0.3s;"></div>' +
        '</div>' +
      '</div>'
    );

    try {
      // 创建批次
      var importRec = await App.DB.dictCreateImport('camera');

      var pages = [];
      var allEntries = [];
      var pageNumbers = [];
      var totalWords = 0;
      var totalPhrases = 0;
      var startTime = Date.now();

      for (var i = 0; i < selectedFiles.length; i++) {
        var file = selectedFiles[i];
        var progress = document.getElementById('parseProgress');
        var barFill = document.getElementById('parseBarFill');
        progress.textContent = 'OCR 识别第 ' + (i + 1) + ' / ' + selectedFiles.length + ' 张...';
        if (barFill) barFill.style.width = ((i / selectedFiles.length) * 100) + '%';

        // OCR
        var ocrStart = Date.now();
        var ocrText = await ocrImage(file);
        var ocrDur = Date.now() - ocrStart;

        // 解析
        var parsed = parseDictionaryPage(ocrText);
        totalWords += parsed.words.length;
        totalPhrases += parsed.phrases.length;
        pageNumbers.push(parsed.pageNumber);

        // 创建 page 行
        var pageRow = await App.DB.dictAddPages(importRec.id, [{
          page_number: parsed.pageNumber || (i + 1),
          ocr_raw_text: ocrText,
          first_headword: parsed.words[0] ? parsed.words[0].word : null,
          last_headword: parsed.words[parsed.words.length - 1] ? parsed.words[parsed.words.length - 1].word : null,
          parse_duration_ms: ocrDur,
        }]);
        var pageId = pageRow[0] ? pageRow[0].id : (pageRow.id || null);
        pages.push({ number: parsed.pageNumber, entries: parsed.words.length + parsed.phrases.length });

        // 收集 entries
        parsed.words.forEach(function (w, ri) {
          allEntries.push({
            page_id: pageId,
            import_id: importRec.id,
            entry_type: 'word',
            word: w.word,
            phonetic: w.phonetic,
            part_of_speech: w.pos,
            meanings: w.meanings,
            derivatives: w.derivatives,
            phrases: w.phrases,
            special_examples: w.special_examples,
            row_order: ri * 2,
          });
        });
        parsed.phrases.forEach(function (p, pi) {
          allEntries.push({
            page_id: pageId,
            import_id: importRec.id,
            entry_type: 'phrase',
            word: p.phrase,
            phonetic: null,
            part_of_speech: p.pos,
            meanings: p.meanings,
            derivatives: [],
            phrases: [],
            special_examples: [],
            row_order: parsed.words.length * 2 + pi * 2 + 1,
          });
        });
      }

      // 写入 entries (分批)
      if (allEntries.length > 0) {
        var BATCH = 50;
        for (var bi = 0; bi < allEntries.length; bi += BATCH) {
          await App.DB.dictAddEntries(importRec.id, allEntries.slice(bi, bi + BATCH));
        }
      }

      // 排序页码 + 完成批次
      pageNumbers.sort(function (a, b) { return a - b; });
      var summary = {
        total_ms: Date.now() - startTime,
        pages: selectedFiles.length,
        words: totalWords,
        phrases: totalPhrases,
        page_numbers: pageNumbers,
      };
      await App.DB.dictFinalizeImport(importRec.id, totalWords, totalPhrases, pageNumbers, summary);

      progress.textContent = '完成!';
      if (barFill) barFill.style.width = '100%';

      // 跳过审核直接进入总结页 (v1.12: 自动 accepted, 审核环节可在历史批次中手动调整)
      await App.DB.api('PATCH', 'dictionary_entries',
        { review_status: 'accepted' },
        'import_id=eq.' + encodeURIComponent(importRec.id));

      showSummary(importRec.id, summary);

    } catch (e) {
      console.error('[DictImport] 解析失败', e);
      container.innerHTML = (
        '<div style="text-align:center;padding:40px 20px;">' +
          '<div style="font-size:16px;font-weight:600;margin-bottom:12px;color:var(--color-danger);">识别失败</div>' +
          '<div style="color:var(--color-text-light);font-size:13px;margin-bottom:20px;">' + App.Utils.escapeHtml(e.message) + '</div>' +
          '<button class="btn btn-primary" onclick="App.DictImport.retry()">重试</button>' +
        '</div>'
      );
      window._dictRetry = showUpload;
      App.showToast('识别失败: ' + e.message, 'error');
    }
  }

  function retry() {
    if (window._dictRetry) { window._dictRetry(); window._dictRetry = null; }
  }

  // ========== Step 2a: OCR (Tesseract.js) ==========
  async function ocrImage(file) {
    var Tesseract = await ensureTesseract();
    if (typeof Tesseract === 'undefined') throw new Error('Tesseract.js 加载失败');
    if (!ocrWorker) {
      ocrWorker = await Tesseract.createWorker('eng', 1, {
        logger: function () { /* 静默 */ },
      });
    }
    var result = await ocrWorker.recognize(file);
    return result.data.text || '';
  }

  async function ensureTesseract() {
    if (window.Tesseract) return window.Tesseract;
    await new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.0/dist/tesseract.min.js';
      s.onload = resolve;
      s.onerror = function () { reject(new Error('Tesseract.js 加载失败')); };
      document.head.appendChild(s);
    });
    return window.Tesseract;
  }

  // ========== Step 2b: 词典解析 (排版规则) ==========
  /**
   * 从 OCR 原始文本解析词典结构
   * 返回 { pageNumber, words:[{word, phonetic, pos, meanings, derivatives, phrases, special_examples}], phrases:[...] }
   *
   * 排版识别规则 (基于样例图):
   *   - 页眉: 页码数字在右上角 + 当前 header word (蓝色条)
   *   - Headword 标记: ● ⊕ ▶ ■ ⊖ + 加粗词 + /phonetic/ + pos
   *   - 义项: ①②③④⑤ 圆圈编号 + 英文释义 + 中文翻译 + 例句
   *   - 派生词: ▶ 前缀 + 新词 /phonetic/ pos
   *   - 词组: 缩进的短语 + 释义 (在义项内)
   *   - 例句: 英文完整句 + 破折号或换行 + 中文翻译
   */
  function parseDictionaryPage(ocrText) {
    var words = [];
    var phrases = [];

    if (!ocrText || ocrText.trim().length < 5) {
      return { pageNumber: null, words: words, phrases: phrases };
    }

    var lines = ocrText.split(/\r?\n/);

    // 1. 识别页码: 页眉区域的小数字 (词典页码通常 1-300, 独立一行或紧挨 header word)
    var pageNumber = extractPageNumber(lines);

    // 2. 检测 headword 行的起始标记
    //    词典 headword 通常以 ● ⊕ ▶ ■ ⊖ 开头, 或行首是粗体英文词后跟 /phonetic/
    var headwordPatterns = [
      /^[●⊕▶■⊖\u25cf\u25a0\u25b6\u25c6\u2726\u2766\u00b7]\s*([a-zA-Z][a-zA-Z\-']*)\s*\/([^\/]+)\//,  // 符号 + word + /phonetic/
      /^[a-zA-Z][a-zA-Z\-']*\s*\/([^\/]+)\//,                                                    // 纯 word + /phonetic/
    ];
    var posPattern = /\s+(n|v|vt|vi|adj|adv|prep|art|conj|pron|num|int|aux|det|prep\.|pron\.|adj\.|adv\.|n\.|v\.|vt\.|vi\.|int\.|conj\.|prep\.|art\.|det\.|aux\.|num\.)\b/i;
    var meaningMarker = /^[①②③④⑤⑥⑦⑧⑨⑩\u2460-\u24ff]/;  // 圆圈数字
    var derivativeMarker = /^▶|^►|^⊕/;
    var phrasePattern = /(?:^|\s)(be |in |at |on |by |for |to |from |with |of |up |down |out |off|over |under |about |after |before |above |below )[a-zA-Z]/i;

    var currentWord = null;
    var currentPhrase = null;
    var currentMeaning = null;
    var buffer = [];

    function flushCurrentWord() {
      if (currentWord) {
        // 合并 buffered lines
        currentWord.meaning = currentWord.meaning || '';
        if (buffer.length > 0) {
          currentWord.meaning += '\n' + buffer.join(' ');
          buffer = [];
        }
        if (currentMeaning) {
          if (buffer.length > 0) {
            currentMeaning.zh_def += '\n' + buffer.join(' ');
            buffer = [];
          }
        }
        words.push(currentWord);
        currentWord = null;
        currentPhrase = null;
        currentMeaning = null;
      }
    }

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line) continue;

      // 跳过页眉页码行 (纯数字短行)
      if (/^\d{1,3}$/.test(line) && currentWord === null) continue;
      // 跳过 ABC 字母索引大标题
      if (/^[A-Za-z]{1,3}\s*$/.test(line) && line.length <= 3) continue;
      // 跳过高考链接/辨/注/同族词等蓝色块标题
      if (/高考链接|同族词|辨|注/.test(line) && line.length < 15) continue;

      // 检测 headword 行
      var headwordMatch = null;
      for (var pi = 0; pi < headwordPatterns.length; pi++) {
        headwordMatch = line.match(headwordPatterns[pi]);
        if (headwordMatch) break;
      }

      if (headwordMatch) {
        // 新 headword — 先 flush 上一个
        flushCurrentWord();

        var wordText = headwordMatch[1];
        var phonetic = headwordMatch[2] || '';
        // 提取 pos
        var posMatch = line.match(posPattern);
        var pos = posMatch ? posMatch[1].replace(/\.$/, '').toLowerCase() : '';

        currentWord = {
          word: wordText.toLowerCase(),
          phonetic: phonetic.trim(),
          pos: pos,
          meanings: [],
          derivatives: [],
          phrases: [],
          special_examples: [],
        };
        continue;
      }

      // 如果还没进入任何 headword, 跳过
      if (!currentWord) continue;

      // 检测派生词 ▶
      if (derivativeMarker.test(line)) {
        flushCurrentWord();
        // 派生词条目, 作为独立 headword
        var derivMatch = line.replace(derivativeMarker, '').trim();
        var derivWord = derivMatch.match(/^([a-zA-Z][a-zA-Z\-']*)\s*\/([^\/]+)\//);
        if (derivWord) {
          currentWord = {
            word: derivWord[1].toLowerCase(),
            phonetic: derivWord[2].trim(),
            pos: '',
            meanings: [],
            derivatives: [],
            phrases: [],
            special_examples: [],
          };
        } else {
          currentWord = { word: derivMatch.toLowerCase(), phonetic: '', pos: '', meanings: [], derivatives: [], phrases: [], special_examples: [] };
        }
        continue;
      }

      // 检测义项编号 ①②③...
      if (meaningMarker.test(line)) {
        // 保存上一个义项
        if (currentMeaning) {
          if (buffer.length > 0) {
            currentMeaning.zh_def += '\n' + buffer.join(' ');
            buffer = [];
          }
          currentWord.meanings.push(currentMeaning);
        }
        var cleanLine = line.replace(meaningMarker, '').trim();
        // 尝试拆分成 "英文释义 + 中文释义" — 破折号或冒号分隔
        var parts = splitEnZh(cleanLine);
        currentMeaning = {
          idx: currentWord.meanings.length + 1,
          en_def: parts.en,
          zh_def: parts.zh || '',
          examples: [],
        };
        buffer = [];

        // 如果同一行里有例句 (英文完整句 + 中文)
        var exMatch = cleanLine.match(/([A-Z][^.?!]{10,}[.?!])\s+([^A-Z].{5,})/);
        if (exMatch && currentMeaning) {
          currentMeaning.examples.push({ en: exMatch[1].trim(), zh: exMatch[2].trim() });
        }
        continue;
      }

      // 例句: 英文完整句 (大写开头, 句尾标点) + 中文翻译
      var exampleMatch = line.match(/^([A-Z][a-zA-Z.,'"\-\s]{15,}[.!?])\s*([\u4e00-\u9fa5\s，。；！？、"'（）]{5,})$/);
      if (exampleMatch && currentMeaning) {
        currentMeaning.examples.push({ en: exampleMatch[1].trim(), zh: exampleMatch[2].trim() });
        continue;
      }

      // 词组检测: 缩进短语 (在义项后, 以介词/动词开头)
      if (phrasePattern.test(line) && currentWord && !currentMeaning) {
        var phraseText = line.trim();
        phrases.push({ phrase: phraseText, pos: '', meanings: [] });
        continue;
      }

      // 累加当前行
      buffer.push(line);
    }

    flushCurrentWord();

    // 后处理: 过滤掉太短/无效的词条
    words = words.filter(function (w) { return w.word && w.word.length >= 2 && !/^\d+$/.test(w.word); });
    phrases = phrases.filter(function (p) { return p.phrase && p.phrase.length >= 3; });

    return { pageNumber: pageNumber, words: words, phrases: phrases };
  }

  function extractPageNumber(lines) {
    // 词典页码通常在页眉右上角, 是一行独立的小数字
    for (var i = 0; i < Math.min(lines.length, 15); i++) {
      var line = lines[i].trim();
      var m = line.match(/^(\d{1,3})\s*$/);
      if (m) return parseInt(m[1], 10);
    }
    return null;
  }

  // 把一行 "英文释义 + 中文翻译" 拆开
  function splitEnZh(line) {
    // 模式1: 破折号或 em-dash
    var dash = line.match(/^(.+?)\s*[—–-]\s*(.+)$/);
    if (dash && /[\u4e00-\u9fa5]/.test(dash[2])) {
      return { en: dash[1].trim(), zh: dash[2].trim() };
    }
    // 模式2: 中文在最后 (检测第一个中文字符位置)
    var zhIdx = -1;
    for (var j = 0; j < line.length; j++) {
      if (/[\u4e00-\u9fa5]/.test(line[j])) { zhIdx = j; break; }
    }
    if (zhIdx > 3) {
      return { en: line.substring(0, zhIdx).trim(), zh: line.substring(zhIdx).trim() };
    }
    return { en: line.trim(), zh: '' };
  }

  // ========== Step 3: 总结页 ==========
  async function showSummary(importId, summary) {
    var container = document.getElementById('dictImportContainer');

    // 检测缺页
    var missingPages = findMissingPages(summary.page_numbers);

    container.innerHTML = (
      '<div style="max-width:600px;margin:0 auto;">' +
        '<h3 style="text-align:center;margin-bottom:20px;">✅ 导入完成</h3>' +
        '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:20px;">' +
          summaryCard('处理页数', summary.pages + ' 张') +
          summaryCard('识别单词', summary.words + ' 个') +
          summaryCard('识别词组', summary.phrases + ' 个') +
        '</div>' +
        '<div style="background:var(--color-card);border:1px solid var(--color-border);border-radius:8px;padding:16px;margin-bottom:16px;">' +
          '<div style="font-weight:600;margin-bottom:8px;">页码覆盖情况</div>' +
          '<div style="font-size:13px;color:var(--color-text-light);">' +
            '已采集页码: ' + (summary.page_numbers && summary.page_numbers.length > 0 ? summary.page_numbers.join(', ') : '无') +
          '</div>' +
          (missingPages.length > 0
            ? '<div style="font-size:13px;color:var(--color-danger);margin-top:6px;">⚠ 可能缺页: ' + missingPages.join(', ') + '</div>'
            : '<div style="font-size:13px;color:var(--color-success);margin-top:6px;">✓ 页码连续, 无缺页</div>') +
        '</div>' +
        '<div style="display:flex;gap:12px;justify-content:center;flex-wrap:wrap;">' +
          '<button class="btn btn-primary" id="btnViewDetail">查看解析结果</button>' +
          '<button class="btn btn-outline" id="btnPublishNow">直接发布到词库</button>' +
          '<button class="btn btn-outline" id="btnNewImport">继续导入</button>' +
        '</div>' +
      '</div>'
    );

    document.getElementById('btnViewDetail').addEventListener('click', function () {
      showImportDetail(importId);
    });
    document.getElementById('btnPublishNow').addEventListener('click', async function () {
      try {
        App.showToast('正在发布...', 'info');
        var result = await App.DB.dictPublishImport(importId);
        App.showToast('发布成功: ' + result.published + ' 个新词' + (result.merged > 0 ? ', ' + result.merged + ' 个已存在跳过' : ''), 'success');
        showHistory();
      } catch (e) {
        App.showToast('发布失败: ' + e.message, 'error');
      }
    });
    document.getElementById('btnNewImport').addEventListener('click', showUpload);
  }

  function summaryCard(label, value) {
    return (
      '<div style="background:var(--color-card);border:1px solid var(--color-border);border-radius:8px;padding:16px;text-align:center;">' +
        '<div style="font-size:24px;font-weight:700;color:var(--color-primary);">' + value + '</div>' +
        '<div style="font-size:12px;color:var(--color-text-light);margin-top:4px;">' + label + '</div>' +
      '</div>'
    );
  }

  function findMissingPages(nums) {
    if (!nums || nums.length < 2) return [];
    var sorted = nums.slice().sort(function (a, b) { return a - b; });
    var missing = [];
    for (var i = 1; i < sorted.length; i++) {
      if (sorted[i] - sorted[i - 1] > 1) {
        for (var g = sorted[i - 1] + 1; g < sorted[i]; g++) missing.push(g);
      }
    }
    return missing;
  }

  // ========== Step 4: 历史批次列表 ==========
  async function showHistory() {
    var container = document.getElementById('dictImportContainer');
    container.innerHTML = '<div style="text-align:center;padding:40px;color:var(--color-text-light);">加载中...</div>';

    try {
      var imports = await App.DB.dictGetImports();
      if (!imports || imports.length === 0) {
        container.innerHTML = (
          '<div style="text-align:center;padding:40px;">' +
            '<div style="color:var(--color-text-light);margin-bottom:16px;">暂无导入记录</div>' +
            '<button class="btn btn-primary" onclick="App.DictImport.retry()">开始第一次导入</button>' +
          '</div>'
        );
        window._dictRetry = showUpload;
        return;
      }

      container.innerHTML = (
        '<div style="margin-bottom:16px;">' +
          '<button class="btn btn-outline btn-sm" onclick="App.DictImport.retry()">← 返回上传</button>' +
        '</div>' +
        '<div style="display:flex;flex-direction:column;gap:8px;">' +
          imports.map(function (imp) {
            var statusBadge = statusBadgeHtml(imp.status);
            var time = imp.created_at ? new Date(imp.created_at).toLocaleString() : '';
            return (
              '<div style="background:var(--color-card);border:1px solid var(--color-border);border-radius:8px;padding:12px;display:flex;justify-content:space-between;align-items:center;">' +
                '<div>' +
                  '<div style="font-weight:600;">批次 #' + imp.id.slice(0, 8) + ' ' + statusBadge + '</div>' +
                  '<div style="font-size:12px;color:var(--color-text-light);margin-top:4px;">' +
                    imp.total_pages + ' 页 · ' + imp.total_entries + ' 词条 · ' + imp.total_phrases + ' 词组 · ' + time +
                  '</div>' +
                  (imp.page_numbers && imp.page_numbers.length > 0
                    ? '<div style="font-size:11px;color:var(--color-text-subtle);margin-top:2px;">页码: ' + imp.page_numbers.join(', ') + '</div>'
                    : '') +
                '</div>' +
                '<div style="display:flex;gap:8px;">' +
                  (imp.status === 'review'
                    ? '<button class="btn btn-primary btn-sm" data-publish="' + imp.id + '">发布</button>'
                    : '') +
                  (imp.status !== 'published' && imp.status !== 'discarded'
                    ? '<button class="btn btn-outline btn-sm" data-detail="' + imp.id + '">查看</button>'
                    : '') +
                  (imp.status !== 'published' && imp.status !== 'discarded'
                    ? '<button class="btn btn-danger btn-sm" data-discard="' + imp.id + '">丢弃</button>'
                    : '') +
                '</div>' +
              '</div>'
            );
          }).join('') +
        '</div>'
      );

      container.querySelectorAll('[data-detail]').forEach(function (btn) {
        btn.addEventListener('click', function () { showImportDetail(btn.dataset.detail); });
      });
      container.querySelectorAll('[data-publish]').forEach(function (btn) {
        btn.addEventListener('click', async function () {
          try {
            var result = await App.DB.dictPublishImport(btn.dataset.publish);
            App.showToast('发布成功: ' + result.published + ' 新词', 'success');
            showHistory();
          } catch (e) {
            App.showToast('发布失败: ' + e.message, 'error');
          }
        });
      });
      container.querySelectorAll('[data-discard]').forEach(function (btn) {
        btn.addEventListener('click', async function () {
          App.showConfirm('确定丢弃此批次?', async function () {
            await App.DB.dictDiscardImport(btn.dataset.discard);
            App.showToast('已丢弃', 'success');
            showHistory();
          });
        });
      });
      window._dictRetry = showUpload;

    } catch (e) {
      container.innerHTML = '<div style="color:var(--color-danger);padding:20px;">加载失败: ' + App.Utils.escapeHtml(e.message) + '</div>';
    }
  }

  function statusBadgeHtml(status) {
    var map = {
      parsing:  { text: '解析中', cls: 't-warn' },
      review:   { text: '待审核', cls: 't-accent' },
      published:{ text: '已发布', cls: 't-success' },
      discarded:{ text: '已丢弃', cls: 't-muted' },
      failed:   { text: '失败', cls: 't-danger' },
    };
    var s = map[status] || { text: status, cls: 't-muted' };
    return '<span style="display:inline-block;font-size:11px;padding:1px 7px;border-radius:999px;margin-left:6px;background:var(--color-border);">' + s.text + '</span>';
  }

  // ========== Step 5: 批次详情 / 审核 ==========
  async function showImportDetail(importId) {
    var container = document.getElementById('dictImportContainer');
    container.innerHTML = '<div style="text-align:center;padding:40px;color:var(--color-text-light);">加载中...</div>';

    try {
      var detail = await App.DB.dictGetImportDetail(importId);
      var entries = detail.entries || [];
      var pageMap = {};
      (detail.pages || []).forEach(function (p) { pageMap[p.id] = p.page_number; });

      container.innerHTML = (
        '<div style="margin-bottom:16px;display:flex;gap:8px;">' +
          '<button class="btn btn-outline btn-sm" onclick="App.DictImport.showHistory()">← 历史批次</button>' +
          '<button class="btn btn-outline btn-sm" onclick="App.DictImport.retry()">← 上传</button>' +
          '<span style="flex:1;"></span>' +
          '<button class="btn btn-primary btn-sm" id="btnPublish">发布已审核词条</button>' +
        '</div>' +
        '<div style="display:flex;gap:16px;margin-bottom:16px;font-size:13px;color:var(--color-text-light);">' +
          '<span>共 ' + entries.length + ' 条</span>' +
          '<span>单词 ' + entries.filter(function (e) { return e.entry_type === 'word'; }).length + '</span>' +
          '<span>词组 ' + entries.filter(function (e) { return e.entry_type === 'phrase'; }).length + '</span>' +
          '<span>已接受 ' + entries.filter(function (e) { return e.review_status === 'accepted'; }).length + '</span>' +
        '</div>' +
        '<div style="max-height:60vh;overflow-y:auto;border:1px solid var(--color-border);border-radius:8px;">' +
          entries.map(function (e) {
            var pageNum = pageMap[e.page_id] || '?';
            var mFirst = (Array.isArray(e.meanings) && e.meanings[0]) ? e.meanings[0].zh_def : '';
            var accepted = e.review_status === 'accepted';
            var rejected = e.review_status === 'rejected';
            return (
              '<div style="padding:12px;border-bottom:1px solid var(--color-border);display:flex;gap:12px;align-items:flex-start;' +
                (rejected ? 'opacity:0.4;' : '') + '">' +
                '<div style="min-width:48px;font-size:11px;color:var(--color-text-subtle);">P' + pageNum + '</div>' +
                '<div style="flex:1;">' +
                  '<div style="font-weight:600;' + (e.entry_type === 'phrase' ? 'color:var(--color-accent);' : '') + '">' +
                    App.Utils.escapeHtml(e.word) +
                    (e.phonetic ? ' <span style="font-weight:400;color:var(--color-text-light);font-size:13px;">/' + App.Utils.escapeHtml(e.phonetic) + '/</span>' : '') +
                    (e.part_of_speech ? ' <span style="font-size:12px;color:var(--color-text-light);">' + App.Utils.escapeHtml(e.part_of_speech) + '</span>' : '') +
                    (e.entry_type === 'phrase' ? ' <span style="font-size:11px;color:var(--color-accent);">[词组]</span>' : '') +
                  '</div>' +
                  (mFirst ? '<div style="font-size:13px;color:var(--color-text-light);margin-top:2px;">' + App.Utils.escapeHtml(mFirst) + '</div>' : '') +
                '</div>' +
                '<div style="display:flex;gap:4px;">' +
                  '<button class="btn btn-sm ' + (accepted ? 'btn-primary' : 'btn-outline') + '" data-acc="' + e.id + '">✓</button>' +
                  '<button class="btn btn-sm ' + (rejected ? 'btn-danger' : 'btn-outline') + '" data-rej="' + e.id + '">✕</button>' +
                '</div>' +
              '</div>'
            );
          }).join('') +
        '</div>'
      );

      container.querySelectorAll('[data-acc]').forEach(function (btn) {
        btn.addEventListener('click', async function () {
          await App.DB.dictUpdateEntryStatus(btn.dataset.acc, 'accepted');
          showImportDetail(importId);
        });
      });
      container.querySelectorAll('[data-rej]').forEach(function (btn) {
        btn.addEventListener('click', async function () {
          await App.DB.dictUpdateEntryStatus(btn.dataset.rej, 'rejected');
          showImportDetail(importId);
        });
      });
      document.getElementById('btnPublish').addEventListener('click', async function () {
        try {
          var result = await App.DB.dictPublishImport(importId);
          App.showToast('发布成功: ' + result.published + ' 新词' + (result.merged > 0 ? ', ' + result.merged + ' 已存在跳过' : ''), 'success');
          showHistory();
        } catch (e) {
          App.showToast('发布失败: ' + e.message, 'error');
        }
      });
      window._dictRetry = showUpload;

    } catch (e) {
      container.innerHTML = '<div style="color:var(--color-danger);padding:20px;">加载失败: ' + App.Utils.escapeHtml(e.message) + '</div>';
    }
  }

  return {
    init: init,
    retry: function () { window._dictRetry ? window._dictRetry() : showUpload(); },
  };
})();

// ES Module 导出
export default App.DictImport;
