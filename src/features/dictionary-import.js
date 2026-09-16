/**
 * 词典导入模块 (v1.14.0) — AI 视觉直接解析, 彻底删除 Tesseract
 *
 * v1.14.0 重大架构变更:
 *   v1.13.x 方案: Tesseract.js → OCR 文本 → 前端正则解析 → 词条
 *   依赖链: pako + tesseract-core.asm.js (5.4MB) + tessdata (11MB) + Emscripten runtime
 *   → 9 步链路, 每步在 ArkWeb 上都有坑, 最终无法稳定运行
 *
 *   v1.14.0 方案: 前端上传图片 → Supabase Edge Function → Google Gemini Vision
 *   → 直接返回结构化 JSON (OCR + 解析一步到位)
 *   → 零本地依赖, 任何浏览器都能跑, 链路从 9 步缩短到 1 步
 *
 * 流程:
 *   1. 上传 (拍照/相册, 最多10张)
 *   2. AI 解析 (图片 base64 → Edge Function → Gemini → 结构化词条 JSON)
 *   3. 保存批次到 dictionary_imports + dictionary_pages + dictionary_entries
 *   4. 审核 (admin 逐条确认/拒绝)
 *   5. 发布 (accepted 词条写入 words 表)
 */
window.App = window.App || {};
App.DictImport = (function () {

  var MAX_PAGES = 10;

  // ========== Step 1: 上传界面 ==========

  function init() {
    showUpload();
  }

  function showUpload() {
    var container = document.getElementById('dictImportContainer');
    if (!container) return;
    container.innerHTML = (
      '<div style="max-width:600px;margin:0 auto;">' +
        '<div style="text-align:center;margin-bottom:24px;">' +
          '<div style="font-size:48px;margin-bottom:12px;">📖</div>' +
          '<h3>词典导入</h3>' +
          '<p style="color:var(--color-text-light);font-size:13px;margin-top:8px;">拍照词典页面, AI 自动识别并提取词条</p>' +
          '<div style="margin-top:8px;font-size:11px;color:var(--color-muted);">v' + ((window.App && window.App.VERSION) || '?') + ' · AI 视觉解析</div>' +
        '</div>' +
        '<div style="display:flex;gap:12px;justify-content:center;flex-wrap:wrap;margin-bottom:20px;">' +
          '<button class="btn btn-primary" id="btnCamera">📷 拍照</button>' +
          '<button class="btn btn-outline" id="btnAlbum">🖼 相册选择</button>' +
          '<button class="btn btn-outline" id="btnHistory">📋 历史批次</button>' +
        '</div>' +
        '<input type="file" id="fileCamera" accept="image/*" capture="environment" multiple style="display:none;">' +
        '<input type="file" id="fileAlbum" accept="image/*" multiple style="display:none;">' +
        '<div id="previewArea" style="display:none;margin-top:16px;"></div>' +
        '<div id="dictImportActions" style="display:none;gap:12px;margin-top:20px;">' +
          '<button class="btn btn-danger btn-sm" id="btnReset">重新选择</button>' +
          '<button class="btn btn-primary" id="btnStartParse">开始 AI 识别 →</button>' +
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
    document.getElementById('btnHistory').addEventListener('click', showHistory);
  }

  var selectedFiles = [];

  function onFileSelected(e) {
    var files = Array.from(e.target.files || []);
    if (files.length === 0) return;

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
        '已选 ' + selectedFiles.length + ' 张, 点击"开始 AI 识别"进行解析' +
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

  // ========== Step 2: AI 视觉解析 ==========

  async function startParse() {
    var container = document.getElementById('dictImportContainer');
    container.innerHTML = (
      '<div style="text-align:center;padding:40px 20px;">' +
        '<div style="font-size:16px;font-weight:600;margin-bottom:12px;">正在 AI 识别词典页面...</div>' +
        '<div id="parseProgress" style="color:var(--color-text-light);font-size:13px;">准备中...</div>' +
        '<div id="parseBar" style="width:100%;max-width:400px;height:6px;background:var(--color-border);border-radius:3px;margin:16px auto 0;overflow:hidden;">' +
          '<div id="parseBarFill" style="height:100%;background:var(--color-primary);border-radius:3px;width:0%;transition:width 0.3s;"></div>' +
        '</div>' +
      '</div>'
    );

    try {
      // 创建批次
      var importRec = await App.DB.dictCreateImport('camera');

      var allEntries = [];
      var pageNumbers = [];
      var totalWords = 0;
      var totalPhrases = 0;
      var startTime = Date.now();

      // 把图片转成 base64 数组
      var progress = document.getElementById('parseProgress');
      var barFill = document.getElementById('parseBarFill');

      progress.textContent = '正在转换图片...';
      var imagesBase64 = [];
      for (var i = 0; i < selectedFiles.length; i++) {
        var b64 = await fileToBase64(selectedFiles[i]);
        imagesBase64.push({ data: b64, mimeType: selectedFiles[i].type || 'image/jpeg' });
      }

      // 调 Edge Function (一次性发送所有图片, 减少请求次数)
      progress.textContent = '正在调用 AI 识别 (' + selectedFiles.length + ' 张)...';
      if (barFill) barFill.style.width = '20%';

      var token = localStorage.getItem('beidanci_access_token') || '';
      var resp = await fetch(App.Config.EDGE_FUNCTIONS.DICT_OCR_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + token,
        },
        body: JSON.stringify({ images: imagesBase64 }),
      });

      if (!resp.ok) {
        var errBody = await resp.json().catch(function() { return { error: 'HTTP ' + resp.status }; });
        throw new Error(errBody.error || 'AI 识别请求失败 (HTTP ' + resp.status + ')');
      }

      var result = await resp.json();
      var pages = result.pages || [];

      if (barFill) barFill.style.width = '70%';

      // 处理每页解析结果
      for (var pi = 0; pi < pages.length; pi++) {
        var pageData = pages[pi];
        var pageNumber = pageData.pageNumber || (pi + 1);
        var words = pageData.words || [];
        var phrases = pageData.phrases || [];

        totalWords += words.length;
        totalPhrases += (phrases ? phrases.length : 0);
        pageNumbers.push(pageNumber);

        // 创建 page 行
        var pageRow = await App.DB.dictAddPages(importRec.id, [{
          page_number: pageNumber,
          ocr_raw_text: JSON.stringify(pageData, null, 2),
          first_headword: words[0] ? words[0].word : null,
          last_headword: words[words.length - 1] ? words[words.length - 1].word : null,
          parse_duration_ms: 0,
        }]);
        var pageId = pageRow[0] ? pageRow[0].id : (pageRow.id || null);

        // 收集 word entries
        words.forEach(function (w, ri) {
          allEntries.push({
            page_id: pageId,
            import_id: importRec.id,
            entry_type: 'word',
            word: w.word,
            phonetic: w.phonetic || null,
            part_of_speech: w.pos || null,
            meanings: w.meanings || [],
            derivatives: w.derivatives || [],
            phrases: w.phrases || [],
            special_examples: w.examples || [],
            row_order: ri * 2,
          });
        });

        // 收集 phrase entries
        if (phrases && phrases.length > 0) {
          phrases.forEach(function (p, idx) {
            allEntries.push({
              page_id: pageId,
              import_id: importRec.id,
              entry_type: 'phrase',
              word: p.phrase || p.word || '',
              phonetic: null,
              part_of_speech: p.pos || null,
              meanings: p.meanings || [],
              derivatives: [],
              phrases: [],
              special_examples: [],
              row_order: words.length * 2 + idx * 2 + 1,
            });
          });
        }
      }

      if (barFill) barFill.style.width = '90%';

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
        pages: pages.length,
        words: totalWords,
        phrases: totalPhrases,
        page_numbers: pageNumbers,
      };
      await App.DB.dictFinalizeImport(importRec.id, totalWords, totalPhrases, pageNumbers, summary);

      progress.textContent = '完成!';
      if (barFill) barFill.style.width = '100%';

      // 自动 accepted (审核环节在详情页可手动调整)
      await App.DB.api('PATCH', 'dictionary_entries',
        { review_status: 'accepted' },
        'import_id=eq.' + encodeURIComponent(importRec.id));

      showSummary(importRec.id, summary);

    } catch (e) {
      console.error('[DictImport] AI 识别失败', e);
      container.innerHTML = (
        '<div style="text-align:center;padding:40px 20px;">' +
          '<div style="font-size:16px;font-weight:600;margin-bottom:12px;color:var(--color-danger);">识别失败</div>' +
          '<div style="color:var(--color-text-light);font-size:13px;margin-bottom:20px;line-height:1.6;max-width:400px;margin:0 auto 20px;">' + App.Utils.escapeHtml(e.message) + '</div>' +
          '<button class="btn btn-primary" onclick="App.DictImport.retry()">重试</button>' +
        '</div>'
      );
      window._dictRetry = showUpload;
      App.showToast('识别失败: ' + e.message, 'error', 5000);
    }
  }

  function retry() {
    if (window._dictRetry) { window._dictRetry(); window._dictRetry = null; }
  }

  /** 图片文件转 base64 (去掉 data:xxx;base64, 前缀) */
  function fileToBase64(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () {
        var result = reader.result;
        var comma = result.indexOf(',');
        resolve(comma >= 0 ? result.substring(comma + 1) : result);
      };
      reader.onerror = function () { reject(new Error('图片读取失败')); };
      reader.readAsDataURL(file);
    });
  }

  // ========== Step 3: 总结页 ==========

  async function showSummary(importId, summary) {
    var container = document.getElementById('dictImportContainer');

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
    showHistory: showHistory,
    retry: function () { window._dictRetry ? window._dictRetry() : showUpload(); },
  };
})();

// ES Module 导出
export default App.DictImport;
