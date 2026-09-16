/**
 * 词典导入模块 (v1.16.0) — 改用百度 OCR 云端识别
 * Admin 专属功能: 从词典拍照 → 百度 OCR → 结构化解析 → 审核 → 发布
 *
 * v1.13.x → v1.15.x 历程 (本地 Tesseract 路线, 最终放弃):
 *   v1.13.0: 改用 tesseract-core.asm.js + pako + tessdata, 主线程跑
 *   v1.15.1: 下载提速 (Promise.all + 预分配 Uint8Array)
 *   v1.15.2: 真 race 多 CDN + 跳过 pako 解压 + 速度诊断
 *   v1.15.3: AbortController 取消慢源, 修卡死根因
 *   问题: ArkWeb 上 Worker/WASM 死路一条, 5.4MB+11MB 下载体验差,
 *         LSTM 初始化仍卡死, 已穷尽本地优化
 *
 * v1.16.0 改用百度 OCR (云端正解):
 *   流程: 前端拍照 → 上传 base64 → Supabase Edge Function → 百度通用文字识别 → 返回文本
 *   优势:
 *   1. 前端零本地依赖 (删 5.4MB asm.js + 11MB tessdata + 46KB pako)
 *   2. ArkWeb 兼容性问题彻底消失 (无 Worker/WASM/大文件下载)
 *   3. 国内访问无障碍 (vs Gemini 被墙), 百度 OCR 精度比 Tesseract 好
 *   4. 前端代码量从 1490 行降到 ~940 行 (删 720 行 Tesseract 代码)
 *
 * 安全:
 *   - API Key / Secret Key 配在 Supabase Secrets, 不进 git 仓库
 *   - Edge Function 用 Deno.env.get() 读取, 不硬编码
 *   - 鉴权: 必须管理员登录 (检查 user_auth.is_admin)
 *
 * 配额: 通用文字识别标准版 1000 次/月 (适合词典英文)
 *
 * 流程:
 *   1. 上传 (拍照/相册, 最多10张)
 *   2. OCR (前端 base64 → Edge Function → 百度 → 返回文本)
 *   3. 解析 (按词典排版规则切分 headword/义项/派生词/词组, 复用 v1.13.x 逻辑)
 *   4. 保存批次到 dictionary_imports + dictionary_pages + dictionary_entries
 *   5. 审核 (admin 逐条确认/拒绝)
 *   6. 发布 (accepted 词条写入 words 表)
 */
window.App = window.App || {};
App.DictImport = (function () {

  var MAX_PAGES = 10;

  // ========== 调试日志系统 (手机可见, 可复制) ==========
  // 收集所有日志, 在 UI 调试面板显示 + console.log
  var debugLogs = [];
  var debugPanelEl = null;

  /**
   * 记录日志, 同时:
   *   1. console.log (PC 调试)
   *   2. 推入 debugLogs 数组
   *   3. 如果调试面板已挂载, 实时更新显示
   * @param {string} icon - 图标 emoji
   * @param {string} tag - 模块标签 (OCR/UPLOAD/EDGE...)
   * @param {string} msg - 消息
   * @param {*} detail - 可选详情 (对象会 JSON 序列化, 字符串超 200 截断)
   */
  function addLog(icon, tag, msg, detail) {
    var ts = new Date();
    var hh = String(ts.getHours()).padStart(2, '0');
    var mm = String(ts.getMinutes()).padStart(2, '0');
    var ss = String(ts.getSeconds()).padStart(2, '0');
    var ms = String(ts.getMilliseconds()).padStart(3, '0');
    var line = '[' + hh + ':' + mm + ':' + ss + '.' + ms + '] ' + icon + ' [' + tag + '] ' + msg;
    if (detail !== undefined) {
      var detailStr = typeof detail === 'string' ? detail : JSON.stringify(detail);
      if (detailStr && detailStr.length > 500) detailStr = detailStr.slice(0, 500) + '...(' + (typeof detail === 'string' ? detail.length : JSON.stringify(detail).length) + '字符)';
      line += '\n  └─ ' + detailStr;
    }
    debugLogs.push(line);
    if (debugLogs.length > 200) debugLogs.shift(); // 上限 200 行, 防内存膨胀
    console.log('[DictImport]', line);
    if (debugPanelEl) {
      debugPanelEl.textContent = debugLogs.join('\n') + '\n\n(实时日志, 滑到底部查看最新)';
      debugPanelEl.scrollTop = debugPanelEl.scrollHeight;
    }
  }

  /** 渲染调试面板 (含复制按钮) */
  function renderDebugPanel() {
    var html =
      '<div style="margin-top:12px;border:1px dashed var(--color-border);border-radius:8px;overflow:hidden;">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;padding:6px 10px;background:var(--color-bg);border-bottom:1px solid var(--color-border);">' +
          '<span style="font-size:12px;font-weight:600;color:var(--color-text-light);">🔍 调试日志 (实时)</span>' +
          '<div>' +
            '<button class="btn btn-outline btn-sm" id="btnCopyLog" style="font-size:11px;padding:2px 8px;">📋 复制</button>' +
            '<button class="btn btn-outline btn-sm" id="btnClearLog" style="font-size:11px;padding:2px 8px;margin-left:4px;">🗑 清空</button>' +
          '</div>' +
        '</div>' +
        '<pre id="debugLogPre" style="margin:0;padding:8px 10px;font-family:monospace;font-size:11px;line-height:1.5;max-height:240px;overflow-y:auto;background:#fafafa;color:#333;white-space:pre-wrap;word-break:break-all;">(暂无日志)</pre>' +
      '</div>';
    return html;
  }

  /** 挂载调试面板并绑定按钮 */
  function mountDebugPanel() {
    var existing = document.getElementById('debugLogPre');
    if (existing) {
      debugPanelEl = existing;
      debugPanelEl.textContent = debugLogs.join('\n') + '\n\n(实时日志, 滑到底部查看最新)';
      debugPanelEl.scrollTop = debugPanelEl.scrollHeight;
      bindDebugButtons();
      return;
    }
    // 在上传页 actions 之后插入
    var actions = document.getElementById('dictImportActions');
    var container = document.getElementById('dictImportContainer');
    var mountAt = actions || container;
    if (!mountAt) return;
    // 创建 wrapper div
    var wrapper = document.createElement('div');
    wrapper.innerHTML = renderDebugPanel();
    mountAt.parentNode.insertBefore(wrapper.firstChild, mountAt.nextSibling);
    debugPanelEl = document.getElementById('debugLogPre');
    if (debugPanelEl) {
      debugPanelEl.textContent = debugLogs.join('\n') + '\n\n(实时日志, 滑到底部查看最新)';
      debugPanelEl.scrollTop = debugPanelEl.scrollHeight;
    }
    bindDebugButtons();
  }

  function bindDebugButtons() {
    var copyBtn = document.getElementById('btnCopyLog');
    var clearBtn = document.getElementById('btnClearLog');
    if (copyBtn && !copyBtn._bound) {
      copyBtn._bound = true;
      copyBtn.onclick = function () {
        var text = debugLogs.join('\n');
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(function () {
            copyBtn.textContent = '✅ 已复制'; setTimeout(function () { copyBtn.textContent = '📋 复制'; }, 2000);
          }).catch(function () { fallbackCopy(text, copyBtn); });
        } else { fallbackCopy(text, copyBtn); }
      };
    }
    if (clearBtn && !clearBtn._bound) {
      clearBtn._bound = true;
      clearBtn.onclick = function () {
        debugLogs = [];
        if (debugPanelEl) debugPanelEl.textContent = '(已清空)';
      };
    }
  }

  function fallbackCopy(text, btn) {
    var ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.left = '-9999px';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); btn.textContent = '✅ 已复制'; }
    catch (e) { btn.textContent = '❌ 复制失败, 请手动长按选中'; }
    setTimeout(function () { btn.textContent = '📋 复制'; }, 2000);
    document.body.removeChild(ta);
  }

  // ========== OCR 引擎: v1.16.0 改用百度 OCR (Edge Function) ==========
  //   v1.13.x 问题: Tesseract.js 在 ArkWeb 上 Worker/WASM 有坑, 5.4MB 下载慢,
  //                 LSTM 初始化卡死, 11MB tessdata race 后还卡死
  //   v1.16.0 方案: 前端只负责拍照 + 上传 base64 → Edge Function → 百度 OCR → 文本
  //                 前端零大文件, 零本地 OCR 依赖, ArkWeb 兼容性问题彻底消失
  //                 百度 OCR 国内访问无障碍, 精度比 Tesseract 好

  /**
   * File → base64 (不带 data:image/xxx;base64, 前缀, 百度接口要裸 base64)
   * 同时做图片压缩 (Canvas + 等比缩放到 maxEdge), 减小传输体积
   */
  function fileToBase64(file, maxEdge) {
    maxEdge = maxEdge || 2400;
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onerror = function () { reject(new Error('图片读取失败')); };
      reader.onload = function () {
        var img = new Image();
        img.onerror = function () { reject(new Error('图片解码失败')); };
        img.onload = function () {
          var w = img.naturalWidth, h = img.naturalHeight;
          var scale = Math.min(1, maxEdge / Math.max(w, h));
          var canvas = document.createElement('canvas');
          canvas.width = Math.round(w * scale);
          canvas.height = Math.round(h * scale);
          var ctx = canvas.getContext('2d');
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          // 转 JPEG 体积小 (百度 OCR 接受 jpeg/png/bmp), 质量 0.85
          var dataUrl = canvas.toDataURL('image/jpeg', 0.85);
          // 去掉 "data:image/jpeg;base64," 前缀
          var base64 = dataUrl.split(',')[1];
          resolve({ data: base64, mimeType: 'image/jpeg' });
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  /**
   * 调用百度 OCR Edge Function (单张图片)
   * Edge Function 在 supabase/functions/baidu-ocr/index.ts
   * 流程: 前端 base64 → Edge Function → 换百度 token → 调通用文字识别 → 返回文本
   */
  async function ocrImage(file, onProgress) {
    var t0 = Date.now();
    addLog('⏱', 'OCR', '开始处理图片', '文件: ' + (file.name || '(unnamed)') + ', 大小: ' + (file.size / 1024).toFixed(1) + ' KB, type: ' + file.type);
    onProgress && onProgress('准备图片...', 10);

    addLog('🖼', 'OCR', 'fileToBase64 开始 (Canvas 压缩到 2400px)');
    try {
      var imgData = await fileToBase64(file, 2400);
      addLog('✅', 'OCR', '图片已就绪 (base64)', 'base64 长度: ' + imgData.data.length + ' (' + (imgData.data.length / 1024).toFixed(1) + ' KB), mimeType: ' + imgData.mimeType);
    } catch (e) {
      addLog('❌', 'OCR', 'fileToBase64 失败', e.message);
      throw e;
    }
    onProgress && onProgress('图片已就绪, 上传到百度 OCR...', 30);

    var token = localStorage.getItem('beidanci_access_token') || '';
    if (!token) {
      addLog('❌', 'AUTH', '未登录 (localStorage 无 beidanci_access_token)');
      throw new Error('未登录, 请先登录');
    }
    addLog('🔑', 'AUTH', 'Token 已从 localStorage 取出', '长度: ' + token.length + ', 前10字符: ' + token.slice(0, 10) + '...');

    var url = App.Config.EDGE_FUNCTIONS.BAIDU_OCR_URL;
    addLog('🌐', 'EDGE', '准备调 Edge Function', 'URL: ' + url);

    var resp;
    var lastErr = null;
    var attempt = 0;
    // 重试 2 次 (网络抖动 / Edge Function 冷启动)
    for (attempt = 0; attempt < 3; attempt++) {
      var tFetch = Date.now();
      try {
        addLog('📤', 'EDGE', '第 ' + (attempt + 1) + ' 次尝试 fetch', 'method: POST, body: ' + (imgData.data.length + 30) + ' bytes');
        onProgress && onProgress('上传中 (第 ' + (attempt + 1) + ' 次尝试)...', 40 + attempt * 15);
        resp = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + token,
          },
          body: JSON.stringify({ images: [imgData] }),
        });
        addLog('📥', 'EDGE', 'fetch 返回', 'HTTP ' + resp.status + ' ' + resp.statusText + ', 耗时 ' + (Date.now() - tFetch) + 'ms');
        if (resp.ok) {
          addLog('✅', 'EDGE', 'HTTP 2xx 成功');
          onProgress && onProgress('百度 OCR 识别中...', 80);
          break;
        }
        // HTTP 非 2xx, 不重试某些错误
        var errText = '';
        try { errText = await resp.text(); } catch (e2) { errText = '(读响应失败)'; }
        addLog('⚠️', 'EDGE', 'HTTP 非 2xx', 'status=' + resp.status + ', body 前 500: ' + errText.slice(0, 500));
        if (resp.status === 401) throw new Error('未登录或登录已过期, 请重新登录');
        if (resp.status === 403) throw new Error('无权限, 仅管理员可使用词典导入');
        // 404 表示 Edge Function 没部署
        if (resp.status === 404) {
          addLog('❌', 'EDGE', 'Edge Function 未部署 (HTTP 404)', '需要先在 Supabase 部署 baidu-ocr 函数');
          throw new Error('Edge Function 未部署 (404), 请先在 Supabase 部署 baidu-ocr');
        }
        lastErr = new Error('服务器返回 HTTP ' + resp.status + ': ' + errText.slice(0, 200));
      } catch (e) {
        addLog('❌', 'EDGE', 'fetch 异常', e.name + ': ' + e.message + ', 耗时 ' + (Date.now() - tFetch) + 'ms');
        lastErr = e;
        // 网络错误继续重试, 鉴权错误直接抛
        if (e.message.indexOf('未登录') >= 0 || e.message.indexOf('无权限') >= 0 || e.message.indexOf('未部署') >= 0) throw e;
      }
    }
    if (!resp || !resp.ok) {
      addLog('💀', 'OCR', '重试 3 次全失败, 抛出错误', lastErr ? lastErr.message : '未知');
      throw new Error('上传失败: ' + (lastErr ? lastErr.message : '未知错误') + ' (请检查网络)');
    }

    onProgress && onProgress('解析返回结果...', 95);
    addLog('📖', 'EDGE', '读取 JSON 响应');
    var result;
    try {
      result = await resp.json();
      addLog('✅', 'EDGE', 'JSON 解析成功', 'keys: ' + Object.keys(result).join(',') + ', reqId: ' + (result.reqId || '(无)') + ', totalMs: ' + (result.totalMs ?? '(无)'));
    } catch (e) {
      addLog('❌', 'EDGE', 'JSON 解析失败', e.message);
      throw new Error('服务器返回非 JSON: ' + e.message);
    }

    if (result.error) {
      addLog('❌', 'EDGE', '服务器返回 error', result.error + (result.detail ? ' / detail: ' + result.detail : '') + (result.hint ? ' / hint: ' + result.hint : ''));
      throw new Error('百度 OCR 错误: ' + result.error + (result.hint ? ' (' + result.hint + ')' : ''));
    }

    var page = (result.pages && result.pages[0]) || { text: '' };
    if (page.error) {
      addLog('❌', 'OCR', '该页识别失败', page.error);
      throw new Error(page.error);
    }

    var text = page.text || '';
    addLog('✅', 'OCR', '识别完成, 共 ' + text.length + ' 字符, ' + (text.match(/\n/g) || []).length + ' 行', '前 200 字符:\n' + text.slice(0, 200));
    onProgress && onProgress('识别完成', 100);
    addLog('⏱', 'OCR', '本张耗时 ' + (Date.now() - t0) + 'ms');
    return text;
  }

  /** 批次结束释放内存 (v1.16.0 改百度 OCR 后, 此函数保留为空壳, 兼容 startParse 调用) */
  function closeOcrWorker() {
    // 百度 OCR 是无状态服务, 前端没有需要释放的资源
  }

  /** File → Canvas (等比缩放, 手机大图安全) — 保留, 预览图片用 */
  function fileToCanvas(file, maxEdge) {
    maxEdge = maxEdge || 2400;
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onerror = function () { reject(new Error('图片读取失败')); };
      reader.onload = function () {
        var img = new Image();
        img.onerror = function () { reject(new Error('图片解码失败')); };
        img.onload = function () {
          var w = img.naturalWidth, h = img.naturalHeight;
          var scale = Math.min(1, maxEdge / Math.max(w, h));
          var canvas = document.createElement('canvas');
          canvas.width = Math.round(w * scale);
          canvas.height = Math.round(h * scale);
          var ctx = canvas.getContext('2d');
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          resolve(canvas);
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  /** 图像预处理: 灰度化 + 对比度增强 + 二值化 (提升词典印刷体识别率) — 保留, 预览时可用 */
  function preprocessImage(canvas) {
    var w = canvas.width, h = canvas.height;
    var ctx = canvas.getContext('2d');
    var imageData = ctx.getImageData(0, 0, w, h);
    var data = imageData.data;
    var gray = new Uint8ClampedArray(w * h);
    var sum = 0;
    for (var i = 0, j = 0; i < data.length; i += 4, j++) {
      gray[j] = Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
      sum += gray[j];
    }
    var avg = sum / gray.length;
    var contrast = 1.8;
    var out = ctx.createImageData(w, h);
    var outData = out.data;
    var threshold = avg * 0.7;
    for (var n = 0; n < gray.length; n++) {
      var val = gray[n] > threshold ? 255 : 0;
      outData[n * 4] = val; outData[n * 4 + 1] = val; outData[n * 4 + 2] = val; outData[n * 4 + 3] = 255;
    }
    ctx.putImageData(out, 0, 0);
    return canvas;
  }

  // 占位函数 - 替换原 Tesseract 诊断面板入口, 已不再需要
  function runDiagnostics() {
    var panel = document.getElementById('diagPanel');
    if (panel) {
      panel.style.display = 'block';
      panel.textContent = 'OCR 诊断已弃用 (v1.16.0 改用百度 OCR, 无本地依赖)';
    }
  }

  function showDiagResult() {}

  // ===== 删除以下 v1.13.x Tesseract 相关代码 (720 行) =====
  //   - getOcrAssetUrl, openIDB, idbGet, idbPut (IndexedDB 缓存)
  //   - TESSDATA_SOURCES, raceDownload (多 CDN race)
  //   - loadScript, withTimeout, fetchWithProgress (下载逻辑)
  //   - initDirectOcr (Tesseract 初始化 + MEMFS + TessBaseAPI.Init)
  //   - 旧 ocrImage (本地 OCR 主线程调用)
  //   - runDiagnostics 完整诊断面板 (Tesseract 专用)
  //   上述函数已被上方百度 OCR 实现替代
  // ===== 删除结束 =====

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
        '<div style="margin-bottom:12px;padding:10px 12px;background:var(--color-bg);border-radius:8px;font-size:12px;color:var(--color-text-light);line-height:1.6;">' +
          '☁️ v1.16.0 · 百度 OCR 云端识别 (无需本地下载, 无 ArkWeb 兼容问题)' +
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
    // 挂载调试面板 (上传页就显示, 方便看初始日志)
    mountDebugPanel();
    addLog('🚀', 'INIT', '词典导入模块 v' + ((window.App && window.App.VERSION) || '?') + ' 已就绪');
    addLog('📋', 'INIT', 'EDGE_FUNCTIONS.BAIDU_OCR_URL', App.Config && App.Config.EDGE_FUNCTIONS && App.Config.EDGE_FUNCTIONS.BAIDU_OCR_URL);
    addLog('📋', 'INIT', 'localStorage token 状态', (localStorage.getItem('beidanci_access_token') ? '已存在 (长度 ' + localStorage.getItem('beidanci_access_token').length + ')' : '❌不存在'));
  }

  var selectedFiles = [];

  function onFileSelected(e) {
    var files = Array.from(e.target.files || []);
    if (files.length === 0) {
      addLog('⚠️', 'UPLOAD', '文件选择为空');
      return;
    }
    addLog('📁', 'UPLOAD', '选中 ' + files.length + ' 个文件', files.map(function (f) { return f.name + '(' + (f.size / 1024).toFixed(1) + 'KB,' + f.type + ')'; }).join(', '));

    // 最多 10 张
    selectedFiles = files.slice(0, MAX_PAGES);
    if (files.length > MAX_PAGES) {
      addLog('✂️', 'UPLOAD', '超过 ' + MAX_PAGES + ' 张, 截取前 ' + MAX_PAGES + ' 张');
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
    addLog('🎬', 'PARSE', 'startParse 被触发, 共 ' + selectedFiles.length + ' 张图');
    var container = document.getElementById('dictImportContainer');
    container.innerHTML = (
      '<div style="text-align:center;padding:30px 20px 10px;">' +
        '<div style="font-size:16px;font-weight:600;margin-bottom:12px;">正在识别词典页面...</div>' +
        '<div id="parseProgress" style="color:var(--color-text-light);font-size:13px;">准备中...</div>' +
        '<div id="parseBar" style="width:100%;max-width:400px;height:6px;background:var(--color-border);border-radius:3px;margin:16px auto 0;overflow:hidden;">' +
          '<div id="parseBarFill" style="height:100%;background:var(--color-primary);border-radius:3px;width:0%;transition:width 0.3s;"></div>' +
        '</div>' +
      '</div>' +
      renderDebugPanel()
    );
    // 重新挂载调试面板 (上面的 innerHTML 替换掉了, 需要重新拿到 element)
    debugPanelEl = document.getElementById('debugLogPre');
    bindDebugButtons();
    if (debugPanelEl) {
      debugPanelEl.textContent = debugLogs.join('\n') + '\n\n(实时日志, 滑到底部查看最新)';
      debugPanelEl.scrollTop = debugPanelEl.scrollHeight;
    }

    try {
      // 创建批次
      addLog('💾', 'DB', '创建导入批次 dictCreateImport(camera)');
      var importRec = await App.DB.dictCreateImport('camera');
      addLog('✅', 'DB', '批次创建成功', 'import_id: ' + (importRec && importRec.id));

      var pages = [];
      var allEntries = [];
      var pageNumbers = [];
      var totalWords = 0;
      var totalPhrases = 0;
      var startTime = Date.now();

      for (var i = 0; i < selectedFiles.length; i++) {
        var file = selectedFiles[i];
        addLog('📄', 'PARSE', '===== 开始第 ' + (i + 1) + ' / ' + selectedFiles.length + ' 张 =====');
        var progress = document.getElementById('parseProgress');
        var barFill = document.getElementById('parseBarFill');
        progress.textContent = '准备识别第 ' + (i + 1) + ' / ' + selectedFiles.length + ' 张...';
        if (barFill) barFill.style.width = ((i / selectedFiles.length) * 100) + '%';

        var onOcrProgress = (function (idx, total) {
          return function (label, p) {
            // p 是 0-100 整数 (统一约定)
            var pInt = Math.min(100, Math.max(0, Math.round(p || 0)));
            progress.textContent = '第 ' + (idx + 1) + ' / ' + total + ' 张 · ' + (label || '处理中') + ' ' + pInt + '%';
            // 进度条: (已完成张数/total + 当前张的进度/100/total) * 100 = idx*100/total + pInt/total
            var barPct = Math.min(100, Math.round(((idx / total) + (pInt / 100 / total)) * 100));
            if (barFill) barFill.style.width = barPct + '%';
          };
        })(i, selectedFiles.length);

        // OCR
        var ocrStart = Date.now();
        var ocrText = await ocrImage(file, onOcrProgress);
        var ocrDur = Date.now() - ocrStart;

        // 解析
        addLog('🔍', 'PARSE', '开始解析第 ' + (i + 1) + ' 张 (parseDictionaryPage)');
        var parsed = parseDictionaryPage(ocrText);
        addLog('✅', 'PARSE', '解析完成 第 ' + (i + 1) + ' 张', 'words: ' + parsed.words.length + ', phrases: ' + parsed.phrases.length + ', pageNumber: ' + parsed.pageNumber);
        totalWords += parsed.words.length;
        totalPhrases += parsed.phrases.length;
        pageNumbers.push(parsed.pageNumber);

        // 创建 page 行
        addLog('💾', 'DB', '保存 page 行到 dictionary_pages', 'page_number: ' + (parsed.pageNumber || (i + 1)) + ', first_headword: ' + (parsed.words[0] ? parsed.words[0].word : '(无)'));
        var pageRow = await App.DB.dictAddPages(importRec.id, [{
          page_number: parsed.pageNumber || (i + 1),
          ocr_raw_text: ocrText,
          first_headword: parsed.words[0] ? parsed.words[0].word : null,
          last_headword: parsed.words[parsed.words.length - 1] ? parsed.words[parsed.words.length - 1].word : null,
          parse_duration_ms: ocrDur,
        }]);
        var pageId = pageRow[0] ? pageRow[0].id : (pageRow.id || null);
        addLog('✅', 'DB', 'page 保存成功', 'page_id: ' + pageId);
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
        addLog('✅', 'PARSE', '===== 第 ' + (i + 1) + ' 张处理完成, 累计 entries: ' + allEntries.length + ' =====');
      }

      // 写入 entries (分批)
      addLog('💾', 'DB', '写入 entries 到 dictionary_entries, 总计 ' + allEntries.length + ' 条 (分批 50/批)');
      if (allEntries.length > 0) {
        var BATCH = 50;
        for (var bi = 0; bi < allEntries.length; bi += BATCH) {
          await App.DB.dictAddEntries(importRec.id, allEntries.slice(bi, bi + BATCH));
          addLog('  ', 'DB', '批次 ' + (Math.floor(bi / BATCH) + 1) + ' 写入 ' + Math.min(BATCH, allEntries.length - bi) + ' 条');
        }
      }
      addLog('✅', 'DB', '全部 entries 写入完成');

      // 排序页码 + 完成批次
      pageNumbers.sort(function (a, b) { return a - b; });
      var summary = {
        total_ms: Date.now() - startTime,
        pages: selectedFiles.length,
        words: totalWords,
        phrases: totalPhrases,
        page_numbers: pageNumbers,
      };
      addLog('💾', 'DB', '完成批次 dictFinalizeImport', 'totalWords: ' + totalWords + ', totalPhrases: ' + totalPhrases);
      await App.DB.dictFinalizeImport(importRec.id, totalWords, totalPhrases, pageNumbers, summary);
      addLog('✅', 'DB', '批次完成');

      progress.textContent = '完成!';
      if (barFill) barFill.style.width = '100%';
      addLog('🎉', 'PARSE', '全部完成! 总耗时 ' + (Date.now() - startTime) + 'ms, ' + totalWords + ' 词, ' + totalPhrases + ' 词组');

      // 跳过审核直接进入总结页 (v1.12: 自动 accepted, 审核环节可在历史批次中手动调整)
      addLog('📝', 'PARSE', '自动 mark 所有 entries 为 accepted');
      await App.DB.api('PATCH', 'dictionary_entries',
        { review_status: 'accepted' },
        'import_id=eq.' + encodeURIComponent(importRec.id));

      showSummary(importRec.id, summary);

    } catch (e) {
      addLog('💀', 'PARSE', '识别失败, 进入 catch', e.name + ': ' + e.message + '\nstack: ' + (e.stack || '(无)').slice(0, 500));
      console.error('[DictImport] 解析失败', e);
      container.innerHTML = (
        '<div style="text-align:center;padding:30px 20px 10px;">' +
          '<div style="font-size:16px;font-weight:600;margin-bottom:12px;color:var(--color-danger);">识别失败</div>' +
          '<div style="color:var(--color-text-light);font-size:13px;margin-bottom:20px;line-height:1.6;">' + App.Utils.escapeHtml(e.message) + '</div>' +
          '<div style="color:var(--color-muted);font-size:12px;margin-bottom:16px;">' +
            (navigator.userAgent && /Mobile|Android|iPhone|iPad/.test(navigator.userAgent)
              ? '提示: 手机端建议使用较新的 Chrome/Safari 浏览器, 确保相册图片清晰且光线充足'
              : '提示: 请确认词典图片清晰且光线充足') +
          '</div>' +
          '<button class="btn btn-primary" onclick="App.DictImport.retry()">重试</button>' +
        '</div>' +
        renderDebugPanel()
      );
      // 失败后也挂上调试面板, 用户可以复制日志
      debugPanelEl = document.getElementById('debugLogPre');
      bindDebugButtons();
      if (debugPanelEl) {
        debugPanelEl.textContent = debugLogs.join('\n') + '\n\n(实时日志, 滑到底部查看最新)';
        debugPanelEl.scrollTop = debugPanelEl.scrollHeight;
      }
      window._dictRetry = showUpload;
      App.showToast('识别失败: ' + e.message, 'error', 5000);
    } finally {
      await closeOcrWorker();
    }
  }

  function retry() {
    if (window._dictRetry) { window._dictRetry(); window._dictRetry = null; }
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
