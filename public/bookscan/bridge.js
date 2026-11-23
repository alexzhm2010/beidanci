/**
 * Victor-English 嵌入桥接脚本 (beidanci 集成 · v1.20.0)
 *
 * 作用: 让原版 app.js 无需改动即可在 beidanci 的 iframe 内运行。单个「Victor词库」tab
 * 承载 Victor 全部内容, 扫描/词库/记录/设置 各页由 Victor 自带导航在 iframe 内自由切换。
 *   1. 从 URL 参数读取 beidanci 传入的 uid (用户 UUID), 作为底层数据归属 code
 *   2. 预设 localStorage 的 vocab_sync (超级态) 与 vocab_cfg (在线模式),
 *      使 app.js 的 loadSync() 读到有效用户、isSuper() 恒 true、门禁不弹
 *   3. 仅隐藏同步码相关 UI (同步码概念已废弃); 保留 Victor 自带的顶部/侧栏/底部导航
 *   4. 不再强制定位内部页面: 由 app.js 的 restoreUiState() 恢复用户上次所在页
 *
 * 本脚本必须在 app.js 之前加载。
 */
(function () {
  'use strict';

  function getParam(name) {
    try {
      return new URLSearchParams(window.location.search).get(name) || '';
    } catch (e) {
      var m = new RegExp('[?&]' + name + '=([^&]*)').exec(window.location.search);
      return m ? decodeURIComponent(m[1]) : '';
    }
  }

  var uid = getParam('uid') || 'anonymous';

  // ---- 1) 预设同步态: 用 beidanci 的 uid 作为底层归属 code, 超级态 ----
  try {
    localStorage.setItem('vocab_sync', JSON.stringify({
      code: uid,
      note: 'beidanci 用户',
      isSuper: true
    }));
  } catch (e) {}

  // ---- 2) 预设配置为在线模式 (超链接 app.js 已内置 URL/anon key, 这里只确保 demo=off) ----
  try {
    var cfgRaw = localStorage.getItem('vocab_cfg');
    var cfg = cfgRaw ? JSON.parse(cfgRaw) : {};
    cfg.demo = false;
    localStorage.setItem('vocab_cfg', JSON.stringify(cfg));
  } catch (e) {}

  // ---- 3) 覆盖样式: 仅隐藏同步码相关 UI, 保留 Victor 自带全部导航 ----
  // 说明: Victor 的三页导航分两处 —— 手机底部 .bottom-nav (<768px) 与桌面左侧 .sidebar
  // (≥1024px)。v1.19.0 曾隐藏底部导航(由外层 tab 接管切页), v1.20.0 收敛为单 tab 后
  // 必须恢复, 否则手机端无法在 扫描/词库/记录 之间切换。
  var style = document.createElement('style');
  style.textContent = [
    '#syncChip, .sync-chip, #sideSync, .side-sync,',
    '#syncGate, .modal-mask#syncGate,',
    '.sync-code-badge',
    '{ display: none !important; }'
  ].join('\n');
  (document.head || document.documentElement).appendChild(style);

  // ---- 4) 不再强制定位内部页面 ----
  // v1.19.0 会按 URL 的 tab 参数改写 vocab_ui_state 并调用 switchPage 强制切页;
  // v1.20.0 外层只有一个 tab, 改由 app.js 的 restoreUiState() 恢复上次所在页,
  // 用户也能用 Victor 自带导航自由切换, 三页内容全部保留。
})();
