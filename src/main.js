/**
 * 主控制器 & 入口 (v1.11.0 ES Module 重构)
 *
 * 重构说明 (v1.11.0):
 *   - 从 app.js 改为 main.js, 作为 Vite 入口 (index.html <script type="module" src="/src/main.js">)
 *   - 核心层 (config/algorithm/db/auth) 静态 import, 首屏即加载, 设置 window.App.*
 *   - 功能页 (learning/library/stats/admin) 动态 import, 切到对应 tab 才加载, 实现按需加载
 *   - Profile 保留在入口 (登录后立即需要, 不做懒加载)
 *   - 第三方库 (Chart.js/XLSX/Tesseract) 由各功能模块自行动态加载, 不再走 index.html 全局 <script>
 *
 * 功能: 应用初始化、路由切换、弹窗/提示工具函数、我的页面
 */

// ========== 核心层静态加载 (首屏必需, 设置 window.App.Config/Utils/DBConfig/Algorithm/DB/Auth) ==========
import './core/config.js';
import './core/algorithm.js';
import './core/db.js';
import './core/auth.js';

// 样式 (Vite 处理, 产出合并到 dist/assets/)
import '../css/style.css';

window.App = window.App || {};

// ========== 共享工具函数 ==========

App.showModal = function (title, bodyHTML) {
  document.getElementById('modalTitle').textContent = title;
  document.getElementById('modalBody').innerHTML = bodyHTML;
  document.getElementById('modalOverlay').classList.remove('hidden');
};

App.hideModal = function () {
  document.getElementById('modalOverlay').classList.add('hidden');
  document.getElementById('modalBody').innerHTML = '';
};

App.showToast = function (message, type) {
  var toast = document.getElementById('toast');
  toast.textContent = message;
  toast.className = 'toast ' + (type || '');
  toast.classList.remove('hidden');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(function () {
    toast.classList.add('hidden');
  }, 3000);
};

App.showConfirm = function (message, onConfirm) {
  var body =
    '<p style="margin-bottom:20px;font-size:15px;">' + App.Utils.escapeHtml(message) + '</p>' +
    '<div class="form-actions">' +
      '<button class="btn btn-outline" id="btnConfirmCancel">取消</button>' +
      '<button class="btn btn-danger" id="btnConfirmOk">确定</button>' +
    '</div>';
  App.showModal('确认操作', body);
  document.getElementById('btnConfirmCancel').addEventListener('click', App.hideModal);
  document.getElementById('btnConfirmOk').addEventListener('click', function () {
    App.hideModal();
    if (onConfirm) onConfirm();
  });
};

App.updateSyncCodeBadge = function () {
  var code = App.DB.getSyncCode();
  var ver = App.Config.APP_VERSION;
  document.getElementById('syncCodeBadge').textContent = '用户名: ' + code + '  |  v' + ver;
};

// v1.10.0 admin 身份判断 (复用 auth.js 的 ADMIN_CODE 识别)
App.isAdmin = function () {
  var username = App.Auth.getCurrentUser();
  return username === App.Config.AUTH.ADMIN_CODE;
};

// v1.10.0 admin 专属导航 (4 页: 看板/词库/用户/设置, 替代 学习/词库/统计/我的)
App.initAdminNav = function () {
  var nav = document.querySelector('.app-nav');
  if (!nav) return;
  nav.innerHTML =
    '<button class="nav-btn active" data-tab="dashboard">看板</button>' +
    '<button class="nav-btn" data-tab="wordbook">词库</button>' +
    '<button class="nav-btn" data-tab="users">用户</button>' +
    '<button class="nav-btn" data-tab="settings">设置</button>';
  nav.querySelectorAll('.nav-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      App.switchTab(btn.dataset.tab);
    });
  });
};

// ========== v1.11.0 按需懒加载功能页 ==========
// 已加载的功能模块缓存 (避免重复 import/init)
var _loadedFeatures = {};

/**
 * 按需加载功能模块 (首次切到某 tab 时动态 import, 之后走缓存)
 * 核心层 (config/db/auth/algorithm) 已静态加载, 此处只处理功能页
 */
async function ensureFeature(tab) {
  if (_loadedFeatures[tab]) return;
  _loadedFeatures[tab] = true; // 标记加载中, 防止并发重复 import
  try {
    switch (tab) {
      case 'learning':
        await import('./features/learning.js');
        if (App.Learning && typeof App.Learning.init === 'function') App.Learning.init();
        break;
      case 'library':
        await import('./features/library.js'); // library.js 内部 import './dictionary.js'
        if (App.Library && typeof App.Library.init === 'function') App.Library.init();
        break;
      case 'stats':
        await import('./features/stats.js');
        if (App.Stats && typeof App.Stats.init === 'function') App.Stats.init();
        break;
      case 'dashboard':
      case 'wordbook':
      case 'users':
      case 'settings':
        // admin 4 个 tab 共用 admin.js, 只加载一次
        if (!App.Admin) {
          await import('./features/admin.js');
        }
        break;
      // profile 不懒加载 (定义在本文件, 登录后立即需要)
    }
  } catch (e) {
    _loadedFeatures[tab] = false; // 加载失败允许重试
    console.error('[ensureFeature] 加载失败', tab, e);
    App.showToast('页面加载失败: ' + (e && e.message ? e.message : String(e)), 'error');
  }
}

App.switchTab = async function (tabName) {
  document.querySelectorAll('.nav-btn').forEach(function (btn) {
    btn.classList.toggle('active', btn.dataset.tab === tabName);
  });
  document.querySelectorAll('.view').forEach(function (view) {
    view.classList.remove('active');
  });

  // v1.10.0: admin 走专属四页, 复用 profile 容器
  if (App.isAdmin()) {
    var adminContainer = document.getElementById('view-profile');
    if (adminContainer) adminContainer.classList.add('active');
    localStorage.setItem(App.Config.KEY_LAST_TAB, tabName);
    // 按需加载 admin 模块 (首次切到任意 admin tab 时)
    await ensureFeature(tabName);
    if (App.Admin && typeof App.Admin.show === 'function') {
      App.Admin.show(tabName);
    }
    return;
  }

  // v1.10.0: 普通用户兜底 — lastTab 可能残留 admin 专属 tab (wordbook/users/settings),
  // 这些 view 不存在, 会致页面空白。非法 tab 统一回退到 learning
  var validUserTabs = ['learning', 'library', 'stats', 'profile'];
  if (validUserTabs.indexOf(tabName) === -1) tabName = 'learning';

  var view = document.getElementById('view-' + tabName);
  if (view) view.classList.add('active');

  localStorage.setItem(App.Config.KEY_LAST_TAB, tabName);

  // 按需加载功能模块 (首次切到该 tab 时动态 import + init)
  await ensureFeature(tabName);

  if (tabName === 'learning' && App.Learning) App.Learning.show();
  else if (tabName === 'library' && App.Library) App.Library.show();
  else if (tabName === 'stats' && App.Stats) App.Stats.show();
  else if (tabName === 'profile' && App.Auth) App.Profile.showProfile();
};

// ========== 应用初始化 ==========

App.initializeApp = async function () {
  // 检查协议: file:// 下 Web Worker 和 OCR 无法工作
  if (location.protocol === 'file:') {
    App.showModal('⚠️ 警告',
      '<div style="padding:20px 10px;line-height:1.8;">' +
      '<p style="color:#E74C3C;font-weight:bold;margin-bottom:10px;">您正在使用 file:// 协议打开页面</p>' +
      '<p style="color:#666;margin-bottom:10px;">扫词OCR功能需要通过 HTTP 服务器访问。</p>' +
      '<p style="color:#666;margin-bottom:10px;">请使用浏览器访问：</p>' +
      '<p style="background:#f5f5f5;padding:10px;border-radius:6px;font-family:monospace;color:#333;font-weight:bold;">' +
      'http://localhost:8000' +
      '</p>' +
      '<p style="color:#999;margin-top:10px;font-size:12px;">点击确定后应用会加载，但OCR功能不可用</p>' +
      '</div>'
    );
  }

  try {
    await App.DB.init();
    App.updateSyncCodeBadge();

    // v1.10.0: admin 登录后走专属四页, 普通用户恢复原导航
    var lastTab = localStorage.getItem(App.Config.KEY_LAST_TAB) || 'learning';
    if (App.isAdmin()) {
      // admin: 导航由 Profile.showProfile 注入, 这里触发
      App.Profile.showProfile();
    } else {
      // 普通用户: 确保导航是原 4 页 (admin 退出后可能残留)
      await App.switchTab(lastTab);
    }

    console.log('背单词应用初始化完成 v' + App.Config.APP_VERSION);
  } catch (e) {
    console.error('初始化失败:', e);
    if (e.code === 'SUPABASE_NOT_CONFIGURED') {
      document.getElementById('app').innerHTML =
        '<div style="padding:60px 20px;text-align:center;">' +
        '<h2 style="color:#E74C3C;margin-bottom:12px;">数据库未配置</h2>' +
        '<p style="color:#666;line-height:1.8;">请在 <b>src/core/config.js</b> 中填写 Supabase 配置信息：</p>' +
        '<p style="color:#999;margin-top:8px;font-size:13px;line-height:1.8;">' +
          '1. 登录 supabase.com 创建项目<br>' +
          '2. 执行 supabase.sql 建表脚本<br>' +
          '3. 在 Settings > API 复制 URL 和 anon key<br>' +
          '4. 填入 config.js 的 SUPABASE_URL 和 SUPABASE_ANON_KEY' +
        '</p>' +
        '</div>';
    } else {
      App.showToast('数据库连接失败: ' + e.message, 'error');
    }
  }
};

// ========== 我的页面 (保留在入口, 登录后立即需要) ==========

App.Profile = (function () {
  async function showProfile() {
    var username = App.Auth.getCurrentUser();
    if (!username) return;

    // 管理员 → 切换到 admin 专属导航 + 显示管理后台
    if (username === App.Config.AUTH.ADMIN_CODE) {
      App.initAdminNav();
      // 恢复上次 admin tab, 默认看板
      var lastTab = localStorage.getItem(App.Config.KEY_LAST_TAB) || 'dashboard';
      if (['dashboard', 'wordbook', 'users', 'settings'].indexOf(lastTab) === -1) {
        lastTab = 'dashboard';
      }
      App.switchTab(lastTab);
      return;
    }

    var container = document.querySelector('#view-profile .profile-content');
    if (!container) return;

    try {
      // 普通用户 → 显示账户信息
      var authStatus = await App.Auth.checkAuth(username);
      var authInfo = await App.DB.getAuthorization(username);
      var userAuth = await App.DB.getUserAuthInfo(username);

      var statusText, statusClass;
      if (authStatus === 'authorized') {
        if (authInfo && authInfo.expiresAt) {
          var expDate = new Date(authInfo.expiresAt);
          var daysLeft = Math.ceil((expDate - Date.now()) / (24 * 60 * 60 * 1000));
          statusText = '已授权 (至 ' + App.Utils.formatDate(expDate.getTime()) + '，剩余' + daysLeft + '天)';
          statusClass = 'success';
        } else {
          statusText = '已授权 (永久)';
          statusClass = 'success';
        }
      } else if (authStatus === 'trial') {
        var createdDate = userAuth ? new Date(userAuth.createdAt) : new Date();
        var trialEnd = createdDate.getTime() + App.Config.AUTH.TRIAL_DAYS * 24 * 60 * 60 * 1000;
        var trialDaysLeft = Math.ceil((trialEnd - Date.now()) / (24 * 60 * 60 * 1000));
        statusText = '试用中 (剩余' + trialDaysLeft + '天)';
        statusClass = 'warning';
      } else if (authStatus === 'expired') {
        statusText = '授权已过期';
        statusClass = 'danger';
      } else {
        statusText = '未授权';
        statusClass = 'danger';
      }

      var regDate = userAuth ? App.Utils.formatDate(new Date(userAuth.createdAt).getTime()) : '-';

      var html =
        '<div class="profile-section">' +
          '<div class="stats-section-title">账户信息</div>' +
          '<div class="chart-card">' +
            '<div class="profile-row"><span class="profile-label">用户名</span><span class="profile-value">' + App.Utils.escapeHtml(username) + '</span></div>' +
            '<div class="profile-row"><span class="profile-label">注册时间</span><span class="profile-value">' + regDate + '</span></div>' +
            '<div class="profile-row"><span class="profile-label">授权状态</span><span class="profile-value ' + statusClass + '">' + statusText + '</span></div>' +
            '<div class="profile-row"><span class="profile-label">密保问题</span><span class="profile-value">' + (userAuth ? App.Utils.escapeHtml(userAuth.secQuestion) : '-') + '</span></div>' +
          '</div>' +
        '</div>' +
        '<div class="profile-section">' +
          '<div class="stats-section-title">账户管理</div>' +
          '<div class="chart-card">' +
            '<button class="btn btn-outline profile-btn" id="btnChgPwd">修改密码</button>' +
            '<button class="btn btn-outline profile-btn" id="btnChgSec">修改密保问题</button>' +
            '<button class="btn btn-outline profile-btn" id="btnDonation">捐赠支持</button>' +
            '<button class="btn btn-danger profile-btn" id="btnLogout">退出登录</button>' +
          '</div>' +
        '</div>' +
        '<div class="profile-section">' +
          '<div class="stats-section-title">关于</div>' +
          '<div class="chart-card" style="text-align:center;">' +
            '<p style="font-size:16px;font-weight:600;color:var(--color-primary);margin-bottom:4px;">背单词</p>' +
            '<p style="font-size:13px;color:var(--color-text-light);">v' + App.Config.APP_VERSION + '</p>' +
          '</div>' +
        '</div>';

      container.innerHTML = html;

      // 绑定事件
      var btnChgPwd = document.getElementById('btnChgPwd');
      if (btnChgPwd) btnChgPwd.addEventListener('click', function () { App.Auth.changePasswordForm(); });
      var btnChgSec = document.getElementById('btnChgSec');
      if (btnChgSec) btnChgSec.addEventListener('click', function () { App.Auth.changeSecQuestionForm(); });
      var btnDonation = document.getElementById('btnDonation');
      if (btnDonation) btnDonation.addEventListener('click', function () { App.Auth.showDonationPage(); });
      var btnLogout = document.getElementById('btnLogout');
      if (btnLogout) btnLogout.addEventListener('click', function () {
        App.showConfirm('确定要退出登录吗？', function () { App.Auth.logout(); });
      });
    } catch (e) {
      console.error('[Profile.showProfile] 加载失败:', e);
      container.innerHTML =
        '<div class="profile-section">' +
          '<div class="chart-card" style="text-align:center;padding:30px;">' +
            '<p style="color:var(--color-danger);margin-bottom:8px;">加载失败</p>' +
            '<p style="color:var(--color-text-light);font-size:13px;">' + (e && e.message ? e.message : String(e)) + '</p>' +
            '<button class="btn btn-outline" style="margin-top:16px;" onclick="App.Profile.showProfile()">重试</button>' +
          '</div>' +
        '</div>';
    }
  }

  return { showProfile: showProfile };
})();

// ========== DOM 就绪 ==========

document.addEventListener('DOMContentLoaded', function () {
  // 0. vConsole 已禁用 (需要调试时取消注释下方代码)
  // if (typeof VConsole !== 'undefined') {
  //   window.vConsole = new VConsole();
  //   console.log('[Debug] vConsole 已启动');
  // }

  // 0.1 清理 AxureShow 可能注入的浮层元素
  function cleanAxureFloats() {
    var selectors = [
      '[class*="axure"]', '[id*="axure"]',
      '[class*="report-btn"]', '[id*="report-btn"]',
      '[class*="jubao"]', '[id*="jubao"]',
      '[class*="float-btn"]', '[id*="float-btn"]',
      '[class*="toolbar-feedback"]', '[id*="toolbar-feedback"]',
      'iframe[src*="axure"]',
    ];
    selectors.forEach(function (sel) {
      document.querySelectorAll(sel).forEach(function (el) {
        // 排除应用自身的元素 (以防误伤)
        if (!el.closest('#app')) {
          el.style.display = 'none';
          el.remove();
        }
      });
    });
  }
  cleanAxureFloats();
  // 定期清理 (AxureShow 可能在页面加载后延迟注入)
  setInterval(cleanAxureFloats, 2000);

  // 0.2 移动端自动全屏引导
  function isMobile() {
    return /Android|iPhone|iPad|iPod|HarmonyOS|Mobile/i.test(navigator.userAgent);
  }
  function enterFullscreen() {
    var el = document.documentElement;
    if (el.requestFullscreen) el.requestFullscreen();
    else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
    else if (el.webkitEnterFullscreen) el.webkitEnterFullscreen();
  }
  if (isMobile()) {
    // 创建全屏引导遮罩
    var overlay = document.createElement('div');
    overlay.id = 'fsGuide';
    overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.7);z-index:99999;display:flex;align-items:center;justify-content:center;';
    overlay.innerHTML =
      '<div style="background:#fff;border-radius:16px;padding:28px 24px;text-align:center;max-width:300px;width:85%;">' +
        '<div style="font-size:40px;margin-bottom:12px;">📱</div>' +
        '<p style="font-size:17px;font-weight:600;color:#333;margin-bottom:8px;">全屏浏览体验更佳</p>' +
        '<p style="font-size:13px;color:#888;margin-bottom:20px;">点击下方按钮进入全屏模式，获得更好的学习体验</p>' +
        '<button id="fsBtn" style="width:100%;padding:12px;background:#4A90D9;color:#fff;border:none;border-radius:8px;font-size:16px;font-weight:500;">进入全屏</button>' +
        '<button id="fsSkip" style="width:100%;padding:8px;background:transparent;color:#999;border:none;font-size:13px;margin-top:8px;">跳过</button>' +
      '</div>';
    document.body.appendChild(overlay);
    document.getElementById('fsBtn').addEventListener('click', function () {
      enterFullscreen();
      overlay.remove();
    });
    document.getElementById('fsSkip').addEventListener('click', function () {
      overlay.remove();
    });
  }

  // 1. 导航事件 (v1.11.0: 不再预初始化各功能模块, 切到 tab 时按需加载)
  document.querySelectorAll('.nav-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      App.switchTab(btn.dataset.tab);
    });
  });

  // 2. 弹窗关闭
  document.getElementById('modalClose').addEventListener('click', App.hideModal);
  document.getElementById('modalOverlay').addEventListener('click', function (e) {
    if (e.target === this) App.hideModal();
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') App.hideModal();
  });

  // 3. 启动授权系统 (Auth.init 内部会在授权通过后调用 initializeApp)
  if (App.Auth && typeof App.Auth.init === 'function') {
    App.Auth.init();
  } else {
    App.initializeApp();
  }
});
