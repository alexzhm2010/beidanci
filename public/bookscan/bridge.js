/**
 * Victor-English 嵌入桥接脚本 (beidanci 集成)
 *
 * 作用: 让原版 app.js 无需改动即可在 beidanci 的 iframe 内运行:
 *   1. 从 URL 参数读取 beidanci 传入的 uid (用户 UUID), 作为底层归属 code
 *   2. 预设 localStorage 的 vocab_sync (超级态) 与 vocab_cfg (在线模式),
 *      使 app.js 的 loadSync() 读到有效用户、isSuper() 恒 true、门禁不弹
 *   3. 覆盖样式隐藏 Victor 自带的顶部同步码/侧栏同步码/底部导航/设置入口
 *   4. 按 URL 的 tab 参数定位到扫描/词库/记录页; 外层 tab 切换时父页面重载 iframe
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
  var tab = getParam('tab') || 'scan';

  // 只接受 扫描/词库/记录 三页, 其余回退
  if (['scan', 'words', 'records'].indexOf(tab) === -1) tab = 'scan';

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
    // app.js 的 loadCfg 默认值已含 url/key/book; 只需关掉演示模式
    cfg.demo = false;
    localStorage.setItem('vocab_cfg', JSON.stringify(cfg));
  } catch (e) {}

  // ---- 3) 覆盖样式: 隐藏同步码相关 UI 与 Victor 自带导航 (外层 beidanci tab 接管) ----
  var style = document.createElement('style');
  style.textContent = [
    '#syncChip, .sync-chip, #sideSync, .side-sync,',
    'nav.bottom-nav, .bottom-nav,',
    '#syncGate, .modal-mask#syncGate,',
    '.sync-code-badge',
    '{ display: none !important; }',
    /* 设置页入口也隐藏(用户只需要扫描/词库/记录三页) */
    'button[data-page="settings"] { display: none !important; }',
    /* 嵌入 iframe 时去掉底部留白 */
    'body { padding-bottom: 0 !important; }'
  ].join('\n');
  (document.head || document.documentElement).appendChild(style);

  // ---- 4) tab 参数定位: app.js 的 init() 会按 vocab_ui_state 恢复页面,
  //         这里直接清掉旧的 ui_state 并写入目标页, 保证外层 tab 说了算 ----
  try {
    localStorage.setItem('vocab_ui_state', JSON.stringify({ ts: Date.now(), page: tab }));
  } catch (e) {}

  // app.js 的 restoreUiState 会把 HTML 默认的 scan 页切到目标页; 为保险起见,
  // 在 DOM 就绪后再主动切一次(此时 app.js 的函数已定义为全局函数)。
  window.addEventListener('load', function () {
    setTimeout(function () {
      try {
        if (typeof window.switchPage === 'function') window.switchPage(tab);
      } catch (e) {}
    }, 50);
  });
})();
