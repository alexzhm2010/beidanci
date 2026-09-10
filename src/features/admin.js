/**
 * 管理员后台模块 (v1.10.0 多 tab 重构)
 * 功能: 运营看板、词库管理(预置词库CRUD)、用户管理、运营设置(促销+留言+系统信息)
 * 依赖: App.DB (rpc), App.Auth (管理员鉴权), App.Utils, Chart.js
 */
window.App = window.App || {};
App.Admin = (function () {
  var charts = {};
  var cachedUsers = [];
  var cachedPromo = null;
  var cachedMessages = [];
  var currentTab = 'dashboard';
  var cachedPresetWords = [];
  var cachedPresetStats = null;
  // v1.10.0 用户管理增强: 分页 + 状态筛选
  var userPage = 0;
  var userPageSize = 50;
  var userHasMore = false;
  var userStatusFilter = 'all';

  // v1.11.0 ES Module 重构: Chart.js 按需动态加载 (取代 index.html 全局 <script>)
  // v1.11.1 性能优化: 改用 ./chart-setup.js 包装模块 (static named imports 让 Rollup tree-shake)
  var _Chart = null;
  async function ensureChart() {
    if (_Chart) return _Chart;
    var mod = await import('./chart-setup.js');
    _Chart = mod.default;
    return _Chart;
  }

  // v1.11.0: XLSX 按需动态加载 (handlePresetBatchImport 批量导入预置词时使用)
  var _XLSX = null;
  async function ensureXLSX() {
    if (_XLSX) return _XLSX;
    var mod = await import('xlsx');
    _XLSX = mod.default || mod;
    return _XLSX;
  }

  // ========== 容器与鉴权 ==========

  function getContainer() {
    var el = document.querySelector('#view-profile .profile-content');
    if (!el) el = document.getElementById('statsContent');
    return el;
  }

  function getAdminHash() {
    if (App.Auth && typeof App.Auth.getAdminPwdHash === 'function') {
      return App.Auth.getAdminPwdHash();
    }
    return null;
  }

  function checkAuth() {
    var hash = getAdminHash();
    if (!hash) {
      var c = getContainer();
      if (c) {
        c.innerHTML = '<div class="stats-empty"><h3>无管理员权限</h3><p>请先以管理员身份登录</p></div>';
      }
      return false;
    }
    return true;
  }

  // ========== 工具函数 ==========

  /** 紧凑仪表盘单元格 (复用 stats.js 样式) */
  function cell(value, label, colorClass) {
    return '<div class="stat-cell ' + (colorClass || '') + '">' +
      '<span class="stat-cell-num">' + value + '</span>' +
      '<span class="stat-cell-text">' + label + '</span>' +
    '</div>';
  }

  function money(amount) {
    var n = Number(amount || 0);
    if (isNaN(n)) n = 0;
    return '¥' + n.toLocaleString('zh-CN');
  }

  /** 格式化时间戳或 ISO 字符串为 YYYY-MM-DD, null 视为永久 */
  function formatTs(value) {
    if (value === null || value === undefined || value === '') return '永久';
    var ts = typeof value === 'number' ? value : new Date(value).getTime();
    if (isNaN(ts)) return '-';
    return App.Utils.formatDate(ts);
  }

  /** 根据授权状态与到期时间推断显示信息 */
  function statusInfo(status, expiresAt) {
    if (status === 'revoked') {
      return { text: '已吊销', color: '#999', bg: '#F0F0F0' };
    }
    if (status === 'active') {
      if (expiresAt === null || expiresAt === undefined || expiresAt === '') {
        return { text: '永久授权', color: '#27AE60', bg: '#E8F5E9' };
      }
      var ts = typeof expiresAt === 'number' ? expiresAt : new Date(expiresAt).getTime();
      if (!isNaN(ts) && ts < Date.now()) {
        return { text: '已过期', color: '#E74C3C', bg: '#FDECEA' };
      }
      return { text: '已授权', color: '#27AE60', bg: '#E8F5E9' };
    }
    return { text: '未授权', color: '#666', bg: '#F0F0F0' };
  }

  function badge(status, expiresAt) {
    var s = statusInfo(status, expiresAt);
    return '<span style="display:inline-block;padding:2px 8px;border-radius:10px;' +
      'font-size:12px;color:' + s.color + ';background:' + s.bg + ';">' + s.text + '</span>';
  }

  /** 转义属性值 (额外处理引号) */
  function escapeAttr(s) {
    return App.Utils.escapeHtml(s).replace(/"/g, '&quot;');
  }

  function showSectionError(containerId, message) {
    var el = document.getElementById(containerId);
    if (el) {
      el.innerHTML = '<div class="stats-empty"><h3>加载失败</h3><p>' +
        App.Utils.escapeHtml(message) + '</p></div>';
    }
  }

  function destroyCharts() {
    Object.keys(charts).forEach(function (k) {
      if (charts[k]) { charts[k].destroy(); delete charts[k]; }
    });
  }

  // ========== 主入口 show (v1.10.0 多 tab 路由) ==========

  async function show(tab) {
    if (!checkAuth()) return;
    var container = getContainer();
    if (!container) return;

    currentTab = tab || 'dashboard';

    container.innerHTML = skeletonHtml();

    // 退出登录按钮
    var btnLogout = document.getElementById('btnAdminLogout');
    if (btnLogout) {
      btnLogout.addEventListener('click', function () {
        App.showConfirm('确定要退出登录吗？', function () {
          if (App.Auth) App.Auth.logout();
        });
      });
    }

    // v1.10.0: tab 切换由顶部 .app-nav 统一处理 (App.switchTab → Admin.show)
    // 这里只渲染当前 tab 内容, 不再画冗余的 .admin-tabs
    renderTabContent(currentTab);
  }

  async function renderTabContent(tab) {
    destroyCharts();
    if (tab === 'dashboard') loadDashboardSection();
    else if (tab === 'wordbook') loadWordbookSection();
    else if (tab === 'users') loadUsersSection();
    else if (tab === 'settings') loadSettingsSection();
  }

  function skeletonHtml() {
    var adminName = (App.Auth && App.Auth.getCurrentUser) ? App.Auth.getCurrentUser() : '管理员';
    return (
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">' +
        '<span style="font-size:14px;color:var(--color-text-light);">当前管理员: <b>' + App.Utils.escapeHtml(adminName) + '</b></span>' +
        '<button class="btn btn-danger btn-sm" id="btnAdminLogout">退出登录</button>' +
      '</div>' +
      '<div id="adminTabContent"><div class="stats-empty"><p style="color:var(--color-text-lighter);">加载中...</p></div></div>'
    );
  }

  async function loadDashboardSection() {
    var c = document.getElementById('adminTabContent');
    if (!c) return;
    c.innerHTML = '<div class="stats-empty"><p style="color:var(--color-text-lighter);">加载中...</p></div>';
    try {
      var data = await loadDashboard();
      // v1.10.0 看板增强: 同时拉取用户列表用于"即将到期"快捷续费
      var users = [];
      try {
        users = await loadUsers(0, 200);
      } catch (e2) { /* 用户列表加载失败不阻塞看板 */ }
      renderDashboard(data, users);
    } catch (e) {
      showSectionError('adminTabContent', e.message);
    }
  }

  async function loadUsersSection() {
    var c = document.getElementById('adminTabContent');
    if (!c) return;
    c.innerHTML = '<div class="stats-empty"><p style="color:var(--color-text-lighter);">加载中...</p></div>';
    userPage = 0;
    userStatusFilter = 'all';
    try {
      await loadUsersPage(0);
      renderUserManagement();
    } catch (e) {
      showSectionError('adminTabContent', e.message);
    }
  }

  // v1.10.0 用户管理增强: 分页加载 (用 limit+1 检测是否有下一页)
  async function loadUsersPage(page) {
    var offset = page * userPageSize;
    var users = await loadUsers(offset, userPageSize + 1);
    users = users || [];
    userHasMore = users.length > userPageSize;
    if (userHasMore) users = users.slice(0, userPageSize);
    cachedUsers = users;
    userPage = page;
  }

  // v1.10.0 用户管理增强: 客户端状态筛选 (在当前页数据上过滤)
  function filterUsersByStatus(users) {
    if (userStatusFilter === 'all') return users;
    return users.filter(function (u) {
      var st = deriveUserStatus(u);
      return st === userStatusFilter;
    });
  }

  // 把 auth_status + expires_at 推导成业务状态: active/trial/expired/revoked/none
  function deriveUserStatus(u) {
    var st = u.auth_status || 'none';
    if (st === 'revoked') return 'revoked';
    if (st === 'active') {
      var exp = u.expires_at;
      if (exp === null || exp === undefined || exp === '') return 'active';
      var ts = typeof exp === 'number' ? exp : new Date(exp).getTime();
      if (!isNaN(ts) && ts < Date.now()) return 'expired';
      return 'active';
    }
    if (st === 'none') {
      // 无授权记录 = 试用中 (试用期由注册时间 + TRIAL_DAYS 判定, 这里简化为 trial)
      return 'trial';
    }
    return 'none';
  }

  // v1.10.0 settings 页: 合并促销 + 留言 + 系统信息
  async function loadSettingsSection() {
    var c = document.getElementById('adminTabContent');
    if (!c) return;
    c.innerHTML =
      '<div id="adminPromo"><div class="stats-empty"><p style="color:var(--color-text-lighter);">加载中...</p></div></div>' +
      '<div id="adminMessages" style="margin-top:24px;"><div class="stats-empty"><p style="color:var(--color-text-lighter);">加载中...</p></div></div>' +
      '<div id="adminSystemInfo" style="margin-top:24px;"></div>';
    loadPromoSection();
    loadMessagesSection();
    renderSystemInfo();
  }

  async function loadPromoSection() {
    try {
      cachedPromo = await App.DB.getPromoConfig();
      renderPromoSettings();
    } catch (e) {
      showSectionError('adminPromo', e.message);
    }
  }

  async function loadMessagesSection() {
    try {
      cachedMessages = await loadMessages();
      renderMessageManagement();
    } catch (e) {
      showSectionError('adminMessages', e.message);
    }
  }

  function renderSystemInfo() {
    var el = document.getElementById('adminSystemInfo');
    if (!el) return;
    var ver = (App.Config && App.Config.APP_VERSION) ? App.Config.APP_VERSION : '-';
    el.innerHTML =
      '<div class="stats-section-title">系统信息</div>' +
      '<div class="chart-card">' +
        '<div class="profile-row"><span class="profile-label">应用版本</span><span class="profile-value">v' + App.Utils.escapeHtml(ver) + '</span></div>' +
        '<div class="profile-row"><span class="profile-label">预置词库</span><span class="profile-value">v1.10.0 已部署</span></div>' +
        '<div class="profile-row"><span class="profile-label">认证方式</span><span class="profile-value">Supabase Auth + RLS</span></div>' +
      '</div>';
  }

  // ========== 数据加载 (RPC) ==========

  async function loadDashboard() {
    var hash = getAdminHash();
    if (!hash) throw new Error('无管理员权限');
    var res = await App.DB.rpc('admin_dashboard', { p_admin_pwd_hash: hash });
    if (!res || !res.success) throw new Error((res && res.error) || '加载看板失败');
    return res;
  }

  async function loadUsers(offset, limit) {
    var hash = getAdminHash();
    if (!hash) throw new Error('无管理员权限');
    offset = offset || 0;
    limit = limit || 50;
    var res = await App.DB.rpc('admin_list_users', {
      p_admin_pwd_hash: hash,
      p_offset: offset,
      p_limit: limit,
    });
    if (!res || !res.success) throw new Error((res && res.error) || '加载用户列表失败');
    return res.users || [];
  }

  async function authorizeUser(username, note) {
    var hash = getAdminHash();
    if (!hash) throw new Error('无管理员权限');
    var res = await App.DB.rpc('admin_authorize', {
      p_admin_pwd_hash: hash,
      p_username: username,
      p_note: note || '',
    });
    if (!res || !res.success) throw new Error((res && res.error) || '授权失败');
    App.showToast('授权成功，到期：' + formatTs(res.expires_at), 'success');
    return res;
  }

  async function revokeUser(username) {
    var hash = getAdminHash();
    if (!hash) throw new Error('无管理员权限');
    var res = await App.DB.rpc('admin_revoke', {
      p_admin_pwd_hash: hash,
      p_username: username,
    });
    if (!res || !res.success) throw new Error((res && res.error) || '吊销失败');
    return res;
  }

  async function savePromo(amount, years, text) {
    var hash = getAdminHash();
    if (!hash) throw new Error('无管理员权限');
    var res = await App.DB.rpc('admin_update_promo', {
      p_admin_pwd_hash: hash,
      p_amount: String(amount),
      p_years: years === null ? null : String(years),
      p_text: text || '',
    });
    if (!res || !res.success) throw new Error((res && res.error) || '保存失败');
    return res;
  }

  async function publishMessage(title, content) {
    var hash = getAdminHash();
    if (!hash) throw new Error('无管理员权限');
    var res = await App.DB.rpc('admin_publish_message', {
      p_admin_pwd_hash: hash,
      p_title: title,
      p_content: content,
    });
    if (!res || !res.success) throw new Error((res && res.error) || '发布失败');
    return res;
  }

  async function archiveMessage(messageId) {
    var hash = getAdminHash();
    if (!hash) throw new Error('无管理员权限');
    var res = await App.DB.rpc('admin_archive_message', {
      p_admin_pwd_hash: hash,
      p_message_id: messageId,
    });
    if (!res || !res.success) throw new Error((res && res.error) || '归档失败');
    return res;
  }

  async function loadMessages() {
    var hash = getAdminHash();
    if (!hash) throw new Error('无管理员权限');
    var res = await App.DB.rpc('admin_list_messages', { p_admin_pwd_hash: hash });
    if (!res || !res.success) throw new Error((res && res.error) || '加载留言失败');
    return res.messages || [];
  }

  // ========== 渲染: 运营看板 ==========

  async function renderDashboard(data, usersData) {
    var Chart = await ensureChart();
    var el = document.getElementById('adminTabContent');
    if (!el) return;

    destroyCharts();

    var rev = (data && data.revenue) || {};
    var users = (data && data.users) || {};
    var expiry = (data && data.expiry) || {};
    var monthlyDon = (data && data.monthly_donations) || [];
    var monthlyNew = (data && data.monthly_new_users) || [];

    // v1.10.0 即将到期列表 (30天内到期 或 已过期未续费), 含快捷续费按钮
    var expiringList = renderExpiryList(usersData || []);

    var html =
      // 营业额
      '<div class="stats-dashboard">' +
        cell(money(rev.month), '本月收入', 'success') +
        cell(money(rev.quarter), '本季收入', 'info') +
        cell(money(rev.year), '本年收入', '') +
        cell(money(rev.total), '累计收入', 'warning') +
      '</div>' +
      // 用户统计
      '<div class="stats-dashboard" style="margin-top:12px;">' +
        cell(users.total, '总用户', '') +
        cell(users.authorized, '已授权', 'success') +
        cell(users.trial, '试用中', 'info') +
        cell(users.expired, '已过期', 'danger') +
        cell(users.revoked, '已吊销', '') +
        cell(users.new_this_month, '本月新增', 'warning') +
      '</div>' +
      // 到期提醒
      '<div class="chart-card" style="margin-top:12px;">' +
        '<h3>到期提醒</h3>' +
        '<div class="stats-dashboard">' +
          cell(expiry.this_month, '本月到期', 'warning') +
          cell(expiry.next_month, '下月到期', 'info') +
          cell(expiry.expired_not_renewed, '过期未续费', 'danger') +
        '</div>' +
        // 即将到期用户清单 + 快捷续费
        '<div id="adminExpiryList" style="margin-top:12px;">' + expiringList + '</div>' +
      '</div>' +
      // 图表
      '<div class="stats-charts">' +
        '<div class="chart-card"><h3>月度收入趋势</h3><div class="chart-wrapper" style="height:200px;"><canvas id="adminRevenueChart"></canvas></div></div>' +
        '<div class="chart-card"><h3>月度新增用户</h3><div class="chart-wrapper" style="height:200px;"><canvas id="adminNewUsersChart"></canvas></div></div>' +
      '</div>' +
      '<div class="chart-card" style="margin-top:16px;"><h3>用户状态分布</h3><div class="chart-wrapper" style="height:200px;"><canvas id="adminStatusChart"></canvas></div></div>';

    el.innerHTML = html;

    // 绑定快捷续费按钮
    el.querySelectorAll('button[data-quickrenew]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var uname = btn.getAttribute('data-quickrenew');
        handleQuickRenew(uname, btn);
      });
    });

    if (typeof Chart !== 'undefined') {
      renderRevenueChart(monthlyDon);
      renderNewUsersChart(monthlyNew);
      renderStatusChart(users);
    } else {
      var note = '<p style="text-align:center;color:var(--color-text-lighter);padding:40px 0;">图表库未加载</p>';
      ['adminRevenueChart', 'adminNewUsersChart', 'adminStatusChart'].forEach(function (id) {
        var c = document.getElementById(id);
        if (c && c.parentElement) c.parentElement.innerHTML = note;
      });
    }
  }

  // v1.10.0 即将到期用户清单 (30天内 或 已过期未吊销), 含快捷续费按钮 (按当前促销续期)
  function renderExpiryList(usersData) {
    var now = Date.now();
    var in30 = now + 30 * 24 * 60 * 60 * 1000;
    var expiring = [];
    for (var i = 0; i < usersData.length; i++) {
      var u = usersData[i];
      var st = u.auth_status;
      if (st !== 'active') continue;
      var exp = u.expires_at;
      if (exp === null || exp === undefined || exp === '') continue; // 永久授权不提醒
      var ts = typeof exp === 'number' ? exp : new Date(exp).getTime();
      if (isNaN(ts)) continue;
      if (ts <= in30) { // 30天内到期 或 已过期
        expiring.push({ username: u.username, expiresAt: ts, expired: ts < now });
      }
    }
    expiring.sort(function (a, b) { return a.expiresAt - b.expiresAt; });
    if (expiring.length === 0) {
      return '<p style="color:var(--color-text-lighter);font-size:13px;text-align:center;padding:12px 0;">暂无 30 天内到期的用户</p>';
    }
    var html = '<div style="max-height:240px;overflow-y:auto;">';
    for (var j = 0; j < expiring.length; j++) {
      var e = expiring[j];
      var tag = e.expired ? '已过期' : (Math.ceil((e.expiresAt - now) / (24 * 60 * 60 * 1000)) + '天后到期');
      var tagColor = e.expired ? '#E74C3C' : '#F39C12';
      html +=
        '<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--color-border-light);">' +
          '<span style="font-size:13px;">' + App.Utils.escapeHtml(e.username) +
            ' <span style="color:' + tagColor + ';font-size:12px;">(' + tag + ')</span></span>' +
          '<button class="btn btn-success btn-sm" data-quickrenew="' + escapeAttr(e.username) + '">快捷续费</button>' +
        '</div>';
    }
    html += '</div>';
    return html;
  }

  // v1.10.0 快捷续费: 按当前促销配置直接续期 (调 admin_authorize, 不传 p_expires_at)
  function handleQuickRenew(username, btn) {
    App.showConfirm('确认按当前促销配置为 ' + username + ' 续期？', function () {
      var orig = btn.textContent;
      btn.disabled = true; btn.textContent = '处理中...';
      authorizeUser(username, '看板快捷续费')
        .then(function () { return loadDashboardSection(); })
        .catch(function (e) { App.showToast(e.message, 'error'); })
        .then(function () { btn.disabled = false; btn.textContent = orig; });
    });
  }

  async function renderRevenueChart(monthlyDon) {
    var Chart = await ensureChart();
    var canvas = document.getElementById('adminRevenueChart');
    if (!canvas) return;
    var labels = monthlyDon.map(function (m) { return m.month; });
    var amounts = monthlyDon.map(function (m) { return Number(m.amount || 0); });
    charts.revenue = new Chart(canvas.getContext('2d'), {
      type: 'bar',
      data: {
        labels: labels,
        datasets: [{
          label: '收入(元)',
          data: amounts,
          backgroundColor: '#4A90D9',
          borderRadius: 4,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { position: 'bottom' } },
        scales: { y: { beginAtZero: true, ticks: { precision: 0 } } },
      },
    });
  }

  async function renderNewUsersChart(monthlyNew) {
    var Chart = await ensureChart();
    var canvas = document.getElementById('adminNewUsersChart');
    if (!canvas) return;
    var labels = monthlyNew.map(function (m) { return m.month; });
    var counts = monthlyNew.map(function (m) { return Number(m.count || 0); });
    charts.newUsers = new Chart(canvas.getContext('2d'), {
      type: 'line',
      data: {
        labels: labels,
        datasets: [{
          label: '新增用户',
          data: counts,
          borderColor: '#27AE60',
          backgroundColor: 'rgba(39,174,96,0.1)',
          borderWidth: 2,
          fill: true,
          tension: 0.3,
          pointRadius: 3,
          pointBackgroundColor: '#27AE60',
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { position: 'bottom' } },
        scales: { y: { beginAtZero: true, ticks: { precision: 0 } } },
      },
    });
  }

  async function renderStatusChart(users) {
    var Chart = await ensureChart();
    var canvas = document.getElementById('adminStatusChart');
    if (!canvas) return;
    charts.status = new Chart(canvas.getContext('2d'), {
      type: 'doughnut',
      data: {
        labels: ['已授权', '试用中', '已过期', '已吊销'],
        datasets: [{
          data: [
            users.authorized || 0,
            users.trial || 0,
            users.expired || 0,
            users.revoked || 0,
          ],
          backgroundColor: ['#27AE60', '#3498DB', '#E74C3C', '#BDC3C9'],
          borderWidth: 2,
          borderColor: '#fff',
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { position: 'bottom' } },
      },
    });
  }

  // ========== 渲染: 用户管理 ==========

  function renderUserManagement() {
    var el = document.getElementById('adminTabContent');
    if (!el) return;

    var html =
      // 授权/吊销操作区
      '<div class="chart-card">' +
        '<h3>授权操作</h3>' +
        '<div class="form-group">' +
          '<label>用户名</label>' +
          '<div style="display:flex;gap:8px;">' +
            '<input type="text" id="adminAuthUsername" placeholder="输入用户名" style="flex:1;padding:10px 12px;font-size:14px;border:1px solid var(--color-border);border-radius:var(--radius-sm);background:var(--color-card);">' +
            '<button class="btn btn-outline" id="btnAdminQuery">查询</button>' +
          '</div>' +
        '</div>' +
        '<div id="adminUserInfo"></div>' +
      '</div>' +
      // 用户列表
      '<div class="chart-card" style="margin-top:12px;">' +
        '<h3>用户列表</h3>' +
        '<div class="form-group">' +
          '<input type="text" id="adminUserSearch" placeholder="搜索用户名..." style="width:100%;padding:10px 12px;font-size:14px;border:1px solid var(--color-border);border-radius:var(--radius-sm);background:var(--color-card);">' +
        '</div>' +
        // v1.10.0 状态筛选
        '<div class="form-group">' +
          '<label>状态筛选</label>' +
          '<select id="adminUserStatusFilter" style="width:100%;padding:10px 12px;font-size:14px;border:1px solid var(--color-border);border-radius:var(--radius-sm);background:var(--color-card);">' +
            '<option value="all"' + (userStatusFilter === 'all' ? ' selected' : '') + '>全部</option>' +
            '<option value="active"' + (userStatusFilter === 'active' ? ' selected' : '') + '>已授权</option>' +
            '<option value="trial"' + (userStatusFilter === 'trial' ? ' selected' : '') + '>试用中</option>' +
            '<option value="expired"' + (userStatusFilter === 'expired' ? ' selected' : '') + '>已过期</option>' +
            '<option value="revoked"' + (userStatusFilter === 'revoked' ? ' selected' : '') + '>已吊销</option>' +
            '<option value="none"' + (userStatusFilter === 'none' ? ' selected' : '') + '>未授权</option>' +
          '</select>' +
        '</div>' +
        '<div id="adminUserList"></div>' +
        // v1.10.0 分页控件
        '<div id="adminUserPager" style="display:flex;justify-content:center;align-items:center;gap:12px;margin-top:16px;"></div>' +
      '</div>';

    el.innerHTML = html;

    renderUserList(filterUsersByStatus(cachedUsers));
    renderUserPager();

    document.getElementById('btnAdminQuery').addEventListener('click', function () {
      var username = (document.getElementById('adminAuthUsername').value || '').trim();
      handleQueryUser(username);
    });
    document.getElementById('adminAuthUsername').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        handleQueryUser((this.value || '').trim());
      }
    });
    document.getElementById('adminUserSearch').addEventListener('input', function () {
      var q = (this.value || '').trim().toLowerCase();
      var filtered = filterUsersByStatus(cachedUsers).filter(function (u) {
        return (u.username || '').toLowerCase().indexOf(q) !== -1;
      });
      renderUserList(filtered);
    });
    document.getElementById('adminUserStatusFilter').addEventListener('change', function () {
      userStatusFilter = this.value;
      var q = (document.getElementById('adminUserSearch').value || '').trim().toLowerCase();
      var filtered = filterUsersByStatus(cachedUsers);
      if (q) {
        filtered = filtered.filter(function (u) {
          return (u.username || '').toLowerCase().indexOf(q) !== -1;
        });
      }
      renderUserList(filtered);
    });
  }

  // v1.10.0 分页控件渲染
  function renderUserPager() {
    var pager = document.getElementById('adminUserPager');
    if (!pager) return;
    var hasPrev = userPage > 0;
    var html =
      '<button class="btn btn-outline btn-sm" id="btnUserPrev" ' + (hasPrev ? '' : 'disabled style="opacity:0.4;cursor:not-allowed;"') + '>上一页</button>' +
      '<span style="font-size:13px;color:var(--color-text-light);">第 ' + (userPage + 1) + ' 页</span>' +
      '<button class="btn btn-outline btn-sm" id="btnUserNext" ' + (userHasMore ? '' : 'disabled style="opacity:0.4;cursor:not-allowed;"') + '>下一页</button>';
    pager.innerHTML = html;
    var prevBtn = document.getElementById('btnUserPrev');
    var nextBtn = document.getElementById('btnUserNext');
    if (prevBtn && hasPrev) {
      prevBtn.addEventListener('click', function () { gotoUserPage(userPage - 1, prevBtn); });
    }
    if (nextBtn && userHasMore) {
      nextBtn.addEventListener('click', function () { gotoUserPage(userPage + 1, nextBtn); });
    }
  }

  async function gotoUserPage(page, btn) {
    var origText = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = '加载中...'; }
    try {
      await loadUsersPage(page);
      renderUserManagement();
    } catch (e) {
      App.showToast('翻页失败: ' + e.message, 'error');
      if (btn) { btn.disabled = false; btn.textContent = origText; }
    }
  }

  function handleQueryUser(username) {
    var infoEl = document.getElementById('adminUserInfo');
    if (!username) {
      App.showToast('请输入用户名', 'error');
      return;
    }
    var user = findUserInCache(username);
    if (!user) {
      if (infoEl) {
        infoEl.innerHTML = '<div class="auto-fill-status error">未找到用户 ' +
          App.Utils.escapeHtml(username) + '，可尝试刷新用户列表</div>';
      }
      return;
    }
    renderUserInfoCard(user);
  }

  function findUserInCache(username) {
    var target = (username || '').toLowerCase();
    for (var i = 0; i < cachedUsers.length; i++) {
      if ((cachedUsers[i].username || '').toLowerCase() === target) {
        return cachedUsers[i];
      }
    }
    return null;
  }

  function renderUserInfoCard(user) {
    var infoEl = document.getElementById('adminUserInfo');
    if (!infoEl) return;
    var promo = cachedPromo || { amount: '', years: '' };
    var yearsText = (!promo.years || promo.years === '') ? '永久' : (promo.years + '年');

    var html =
      '<div style="margin-top:12px;padding:12px;border:1px solid var(--color-border);' +
        'border-radius:var(--radius-sm);background:var(--color-border-light);">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;' +
          'margin-bottom:8px;flex-wrap:wrap;gap:6px;">' +
          '<span style="font-weight:600;font-size:15px;">' + App.Utils.escapeHtml(user.username) + '</span>' +
          badge(user.auth_status, user.expires_at) +
        '</div>' +
        '<div style="font-size:13px;color:var(--color-text-light);line-height:1.8;">' +
          '<div>注册日期：' + formatTs(user.created_at) + '</div>' +
          '<div>授权到期：' + formatTs(user.expires_at) + '</div>' +
          '<div>累计捐赠：' + money(user.total_donated) + ' (' + (user.donation_count || 0) + '次)</div>' +
          '<div>当前促销：' + money(promo.amount) + ' / ' + yearsText + '</div>' +
        '</div>' +
        '<div class="form-group" style="margin-top:10px;">' +
          '<label>备注 (可选)</label>' +
          '<input type="text" id="adminAuthNote" placeholder="如：微信转账20元" ' +
            'style="width:100%;padding:10px 12px;font-size:14px;border:1px solid var(--color-border);' +
            'border-radius:var(--radius-sm);background:var(--color-card);">' +
        '</div>' +
        '<div class="form-actions">' +
          '<button class="btn btn-success btn-sm" id="btnAdminAuthorize">授权</button>' +
          '<button class="btn btn-primary btn-sm" id="btnAdminRenew">续费/改期</button>' +
          '<button class="btn btn-outline btn-sm" id="btnAdminDetail">详情</button>' +
          '<button class="btn btn-danger btn-sm" id="btnAdminRevoke">吊销</button>' +
        '</div>' +
      '</div>';

    infoEl.innerHTML = html;

    document.getElementById('btnAdminAuthorize').addEventListener('click', function () {
      var note = document.getElementById('adminAuthNote').value || '';
      handleAuthorize(user.username, note, this);
    });
    document.getElementById('btnAdminRenew').addEventListener('click', function () {
      showRenewModal(user.username);
    });
    document.getElementById('btnAdminDetail').addEventListener('click', function () {
      showUserDetailModal(user.username);
    });
    document.getElementById('btnAdminRevoke').addEventListener('click', function () {
      handleRevoke(user.username, this);
    });
  }

  function handleAuthorize(username, note, btn) {
    App.showConfirm('确认授权用户 ' + username + '？将按当前促销配置开通。', function () {
      var orig = btn ? btn.textContent : '';
      if (btn) { btn.disabled = true; btn.textContent = '处理中...'; }
      authorizeUser(username, note)
        .then(function () { return refreshUsers(); })
        .catch(function (e) { App.showToast(e.message, 'error'); })
        .then(function () { if (btn) { btn.disabled = false; btn.textContent = orig; } });
    });
  }

  function handleRevoke(username, btn) {
    App.showConfirm('确认吊销用户 ' + username + ' 的授权？', function () {
      var orig = btn ? btn.textContent : '';
      if (btn) { btn.disabled = true; btn.textContent = '处理中...'; }
      revokeUser(username)
        .then(function () {
          App.showToast('已吊销 ' + username, 'success');
          return refreshUsers();
        })
        .catch(function (e) { App.showToast(e.message, 'error'); })
        .then(function () { if (btn) { btn.disabled = false; btn.textContent = orig; } });
    });
  }

  async function refreshUsers() {
    try {
      await loadUsersPage(userPage);
      renderUserManagement();
      // 授权状态变化也影响看板, 一并刷新
      loadDashboardSection();
    } catch (e) {
      App.showToast('刷新用户列表失败: ' + e.message, 'error');
    }
  }

  function renderUserList(users) {
    var listEl = document.getElementById('adminUserList');
    if (!listEl) return;
    if (!users || users.length === 0) {
      listEl.innerHTML = '<div class="stats-empty"><p>暂无用户</p></div>';
      return;
    }

    var html = '';
    for (var i = 0; i < users.length; i++) {
      var u = users[i];
      html +=
        '<div style="padding:12px;border:1px solid var(--color-border);border-radius:var(--radius);' +
          'margin-bottom:8px;background:var(--color-card);">' +
          '<div style="display:flex;justify-content:space-between;align-items:center;' +
            'margin-bottom:6px;flex-wrap:wrap;gap:6px;">' +
            '<span style="font-weight:600;font-size:14px;">' + App.Utils.escapeHtml(u.username) + '</span>' +
            badge(u.auth_status, u.expires_at) +
          '</div>' +
          '<div style="font-size:12px;color:var(--color-text-light);line-height:1.7;">' +
            '<div>注册：' + formatTs(u.created_at) + ' | 到期：' + formatTs(u.expires_at) + '</div>' +
            '<div>捐赠：' + money(u.total_donated) + ' (' + (u.donation_count || 0) + '次)</div>' +
          '</div>' +
          '<div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap;">' +
            '<button class="btn btn-outline btn-sm" data-act="detail" data-user="' + escapeAttr(u.username) + '">详情</button>' +
            '<button class="btn btn-success btn-sm" data-act="authorize" data-user="' + escapeAttr(u.username) + '">授权</button>' +
            '<button class="btn btn-primary btn-sm" data-act="renew" data-user="' + escapeAttr(u.username) + '">续费/改期</button>' +
            '<button class="btn btn-danger btn-sm" data-act="revoke" data-user="' + escapeAttr(u.username) + '">吊销</button>' +
          '</div>' +
        '</div>';
    }
    listEl.innerHTML = html;

    var btns = listEl.querySelectorAll('button[data-act]');
    for (var j = 0; j < btns.length; j++) {
      (function (b) {
        b.addEventListener('click', function () {
          var act = b.getAttribute('data-act');
          var uname = b.getAttribute('data-user');
          if (act === 'authorize') {
            handleAuthorize(uname, '', b);
          } else if (act === 'revoke') {
            handleRevoke(uname, b);
          } else if (act === 'detail') {
            showUserDetailModal(uname);
          } else if (act === 'renew') {
            showRenewModal(uname);
          }
        });
      })(btns[j]);
    }
  }

  // ========== v1.10.0 用户详情 + 续费/改期 ==========

  // 调 admin_get_user_detail RPC 查询用户学习数据 (绕过 RLS, SECURITY DEFINER)
  async function loadUserDetail(username) {
    var hash = getAdminHash();
    if (!hash) throw new Error('无管理员权限');
    var res = await App.DB.rpc('admin_get_user_detail', {
      p_admin_pwd_hash: hash,
      p_username: username,
    });
    if (!res || !res.success) throw new Error((res && res.error) || '加载用户详情失败');
    return res;
  }

  // 用户详情弹窗: 展示词数/掌握度/复习记录/最近活跃
  function showUserDetailModal(username) {
    var body =
      '<div id="userDetailContent" class="stats-empty"><p style="color:var(--color-text-lighter);">加载中...</p></div>' +
      '<div class="form-actions" style="margin-top:12px;">' +
        '<button class="btn btn-outline" id="detailClose">关闭</button>' +
      '</div>';
    App.showModal('用户详情: ' + username, body);
    document.getElementById('detailClose').addEventListener('click', App.hideModal);

    loadUserDetail(username)
      .then(function (d) { renderUserDetailContent(d); })
      .catch(function (e) {
        var el = document.getElementById('userDetailContent');
        if (el) el.innerHTML = '<div class="stats-empty"><p style="color:var(--color-danger);">加载失败: ' +
          App.Utils.escapeHtml(e.message) + '</p></div>';
      });
  }

  function renderUserDetailContent(d) {
    var el = document.getElementById('userDetailContent');
    if (!el) return;
    var migrated = d.migrated !== false;
    var knownRate = (d.word_total > 0)
      ? Math.round((d.word_known / d.word_total) * 100) + '%'
      : '0%';
    var lastActive = d.last_active ? formatTs(d.last_active) : '无记录';
    var records = d.recent_records || [];

    var recordsHtml = '';
    if (records.length === 0) {
      recordsHtml = '<p style="color:var(--color-text-lighter);font-size:13px;">暂无复习记录</p>';
    } else {
      recordsHtml = '<div style="max-height:200px;overflow-y:auto;">';
      for (var i = 0; i < records.length; i++) {
        var r = records[i];
        var mark = r.is_known ? '✓' : '✗';
        var color = r.is_known ? '#27AE60' : '#E74C3C';
        recordsHtml +=
          '<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--color-border-light);font-size:13px;">' +
            '<span>' + mark + ' ' + App.Utils.escapeHtml(r.word) +
              ' <span style="color:var(--color-text-lighter);">(' + App.Utils.escapeHtml(r.direction || '') + ')</span></span>' +
            '<span style="color:' + color + ';">' + formatTs(r.timestamp) + '</span>' +
          '</div>';
      }
      recordsHtml += '</div>';
    }

    var html =
      '<div class="chart-card">' +
        '<div class="profile-row"><span class="profile-label">迁移状态</span><span class="profile-value">' +
          (migrated ? '已迁移至 Supabase Auth' : '未迁移 (旧账号)') + '</span></div>' +
        (d.user_id ? '<div class="profile-row"><span class="profile-label">用户ID</span><span class="profile-value" style="font-size:11px;word-break:break-all;">' + App.Utils.escapeHtml(d.user_id) + '</span></div>' : '') +
      '</div>' +
      '<div class="stats-dashboard" style="margin-top:12px;">' +
        cell(d.word_total || 0, '词库总数', '') +
        cell(d.word_known || 0, '已掌握', 'success') +
        cell(knownRate, '掌握度', 'info') +
        cell(d.records_total || 0, '复习次数', 'warning') +
      '</div>' +
      '<div class="chart-card" style="margin-top:12px;">' +
        '<div class="profile-row"><span class="profile-label">最近活跃</span><span class="profile-value">' + lastActive + '</span></div>' +
      '</div>' +
      '<div class="chart-card" style="margin-top:12px;">' +
        '<h3>最近 10 条复习记录</h3>' +
        recordsHtml +
      '</div>';

    el.innerHTML = html;
  }

  // 续费/改期弹窗: 选到期日 → 调 admin_authorize(p_expires_at)
  function showRenewModal(username) {
    // 默认建议: 当前到期日 + 1 年, 或今天 + 1 年
    var user = findUserInCache(username);
    var suggestDate = new Date();
    if (user && user.expires_at) {
      var curExp = new Date(user.expires_at);
      if (!isNaN(curExp.getTime())) suggestDate = curExp;
    }
    suggestDate.setFullYear(suggestDate.getFullYear() + 1);
    var suggestVal = suggestDate.toISOString().slice(0, 10);

    var body =
      '<div class="form-group">' +
        '<label>用户名</label>' +
        '<p style="font-weight:600;font-size:15px;margin:4px 0;">' + App.Utils.escapeHtml(username) + '</p>' +
      '</div>' +
      '<div class="form-group">' +
        '<label>到期日期 (留空 = 永久授权)</label>' +
        '<input type="date" id="renewDate" value="' + suggestVal + '" style="width:100%;padding:10px 12px;font-size:14px;border:1px solid var(--color-border);border-radius:var(--radius-sm);background:var(--color-card);">' +
        '<p style="font-size:12px;color:var(--color-text-lighter);margin-top:4px;">指定到期日后, 将不走促销配置直接授权至该日期。</p>' +
      '</div>' +
      '<div class="form-group">' +
        '<label>备注 (可选)</label>' +
        '<input type="text" id="renewNote" placeholder="如: 微信转账续费1年" style="width:100%;padding:10px 12px;font-size:14px;border:1px solid var(--color-border);border-radius:var(--radius-sm);background:var(--color-card);">' +
      '</div>' +
      '<div class="form-actions">' +
        '<button class="btn btn-outline" id="renewCancel">取消</button>' +
        '<button class="btn btn-primary" id="renewConfirm">确认续费</button>' +
      '</div>';
    App.showModal('续费/改期: ' + username, body);

    document.getElementById('renewCancel').addEventListener('click', App.hideModal);
    document.getElementById('renewConfirm').addEventListener('click', function () {
      var dateStr = document.getElementById('renewDate').value;
      var note = document.getElementById('renewNote').value || '';
      var btn = this;
      handleRenew(username, dateStr, note, btn);
    });
  }

  function handleRenew(username, dateStr, note, btn) {
    var expiresAt = null;
    if (dateStr) {
      // 日期字符串转 ISO 时间戳 (当天 23:59:59)
      var d = new Date(dateStr + 'T23:59:59');
      if (isNaN(d.getTime())) {
        App.showToast('日期格式无效', 'error');
        return;
      }
      expiresAt = d.toISOString();
    }
    var orig = btn.textContent;
    btn.disabled = true; btn.textContent = '处理中...';
    authorizeWithExpiry(username, expiresAt, note)
      .then(function (res) {
        App.showToast('续费成功，到期：' + formatTs(res.expires_at), 'success');
        App.hideModal();
        return refreshUsers();
      })
      .catch(function (e) { App.showToast(e.message, 'error'); })
      .then(function () { btn.disabled = false; btn.textContent = orig; });
  }

  // v1.10.0 调 admin_authorize 带 p_expires_at (指定到期日, 不走促销)
  async function authorizeWithExpiry(username, expiresAt, note) {
    var hash = getAdminHash();
    if (!hash) throw new Error('无管理员权限');
    var res = await App.DB.rpc('admin_authorize', {
      p_admin_pwd_hash: hash,
      p_username: username,
      p_note: note || '',
      p_expires_at: expiresAt,
    });
    if (!res || !res.success) throw new Error((res && res.error) || '续费失败');
    return res;
  }

  // ========== 渲染: 促销设置 ==========

  function renderPromoSettings() {
    var el = document.getElementById('adminPromo');
    if (!el) return;
    var p = cachedPromo || { amount: '', years: '1', text: '' };
    var yearsVal = (p.years === null || p.years === undefined || p.years === '') ? '' : String(p.years);

    var html =
      '<div class="chart-card">' +
        '<div class="form-group">' +
          '<label>捐赠金额 (元)</label>' +
          '<input type="number" id="promoAmount" value="' + escapeAttr(p.amount) + '" min="0" step="1" ' +
            'style="width:100%;padding:10px 12px;font-size:14px;border:1px solid var(--color-border);' +
            'border-radius:var(--radius-sm);background:var(--color-card);">' +
        '</div>' +
        '<div class="form-group">' +
          '<label>授权时长</label>' +
          '<select id="promoYears" style="width:100%;padding:10px 12px;font-size:14px;border:1px solid var(--color-border);' +
            'border-radius:var(--radius-sm);background:var(--color-card);">' +
            '<option value="1"' + (yearsVal === '1' ? ' selected' : '') + '>1年</option>' +
            '<option value="2"' + (yearsVal === '2' ? ' selected' : '') + '>2年</option>' +
            '<option value="3"' + (yearsVal === '3' ? ' selected' : '') + '>3年</option>' +
            '<option value=""' + (yearsVal === '' ? ' selected' : '') + '>永久</option>' +
          '</select>' +
        '</div>' +
        '<div class="form-group">' +
          '<label>促销文案</label>' +
          '<textarea id="promoText" rows="2" style="width:100%;padding:10px 12px;font-size:14px;' +
            'border:1px solid var(--color-border);border-radius:var(--radius-sm);background:var(--color-card);">' +
            escapeAttr(p.text) + '</textarea>' +
        '</div>' +
        '<div class="form-actions">' +
          '<button class="btn btn-primary" id="btnSavePromo">保存</button>' +
        '</div>' +
      '</div>';

    el.innerHTML = html;

    document.getElementById('btnSavePromo').addEventListener('click', function () {
      var amount = document.getElementById('promoAmount').value;
      var yearsRaw = document.getElementById('promoYears').value;
      var text = document.getElementById('promoText').value;
      var years = yearsRaw === '' ? null : yearsRaw;
      handleSavePromo(amount, years, text, this);
    });
  }

  function handleSavePromo(amount, years, text, btn) {
    if (!amount || Number(amount) < 0) {
      App.showToast('请输入有效金额', 'error');
      return;
    }
    var orig = btn.textContent;
    btn.disabled = true; btn.textContent = '保存中...';
    savePromo(amount, years, text)
      .then(function () {
        App.showToast('促销设置已保存', 'success');
        return App.DB.getPromoConfig();
      })
      .then(function (cfg) { cachedPromo = cfg; })
      .catch(function (e) { App.showToast(e.message, 'error'); })
      .then(function () { btn.disabled = false; btn.textContent = orig; });
  }

  // ========== 渲染: 留言管理 ==========

  function renderMessageManagement() {
    var el = document.getElementById('adminMessages');
    if (!el) return;

    var html =
      '<div class="chart-card">' +
        '<h3>发布新留言</h3>' +
        '<div class="form-group">' +
          '<label>标题</label>' +
          '<input type="text" id="msgTitle" placeholder="留言标题" ' +
            'style="width:100%;padding:10px 12px;font-size:14px;border:1px solid var(--color-border);' +
            'border-radius:var(--radius-sm);background:var(--color-card);">' +
        '</div>' +
        '<div class="form-group">' +
          '<label>内容</label>' +
          '<textarea id="msgContent" rows="3" placeholder="留言内容..." ' +
            'style="width:100%;padding:10px 12px;font-size:14px;border:1px solid var(--color-border);' +
            'border-radius:var(--radius-sm);background:var(--color-card);"></textarea>' +
        '</div>' +
        '<div class="form-actions">' +
          '<button class="btn btn-primary" id="btnPublishMsg">发布</button>' +
        '</div>' +
      '</div>' +
      '<div class="chart-card" style="margin-top:12px;">' +
        '<h3>历史留言</h3>' +
        '<div id="adminMsgList"></div>' +
      '</div>';

    el.innerHTML = html;

    renderMessageList(cachedMessages);

    document.getElementById('btnPublishMsg').addEventListener('click', function () {
      var title = document.getElementById('msgTitle').value.trim();
      var content = document.getElementById('msgContent').value.trim();
      handlePublishMessage(title, content, this);
    });
  }

  function renderMessageList(messages) {
    var listEl = document.getElementById('adminMsgList');
    if (!listEl) return;
    if (!messages || messages.length === 0) {
      listEl.innerHTML = '<div class="stats-empty"><p>暂无留言</p></div>';
      return;
    }
    var html = '';
    for (var i = 0; i < messages.length; i++) {
      var m = messages[i];
      var isActive = m.status === 'active';
      var statusTxt = isActive ? '生效中' : '已归档';
      var statusColor = isActive ? '#27AE60' : '#999';
      html +=
        '<div style="padding:12px;border:1px solid var(--color-border);border-radius:var(--radius);' +
          'margin-bottom:8px;background:var(--color-card);">' +
          '<div style="display:flex;justify-content:space-between;align-items:center;' +
            'margin-bottom:6px;flex-wrap:wrap;gap:6px;">' +
            '<span style="font-weight:600;font-size:14px;">' + App.Utils.escapeHtml(m.title) + '</span>' +
            '<span style="font-size:12px;color:' + statusColor + ';">' + statusTxt + '</span>' +
          '</div>' +
          '<div style="font-size:13px;color:var(--color-text);line-height:1.7;' +
            'white-space:pre-wrap;word-break:break-word;">' + App.Utils.escapeHtml(m.content) + '</div>' +
          '<div style="font-size:12px;color:var(--color-text-lighter);margin-top:6px;">' +
            formatTs(m.created_at) + '</div>' +
          (isActive ? '<div style="margin-top:8px;"><button class="btn btn-outline btn-sm" ' +
            'data-act="archive" data-id="' + m.id + '">归档</button></div>' : '') +
        '</div>';
    }
    listEl.innerHTML = html;

    var btns = listEl.querySelectorAll('button[data-act="archive"]');
    for (var j = 0; j < btns.length; j++) {
      (function (b) {
        b.addEventListener('click', function () {
          var id = parseInt(b.getAttribute('data-id'), 10);
          handleArchiveMessage(id, b);
        });
      })(btns[j]);
    }
  }

  function handlePublishMessage(title, content, btn) {
    if (!title) { App.showToast('请输入标题', 'error'); return; }
    if (!content) { App.showToast('请输入内容', 'error'); return; }
    var orig = btn.textContent;
    btn.disabled = true; btn.textContent = '发布中...';
    publishMessage(title, content)
      .then(function () {
        App.showToast('留言已发布', 'success');
        var t = document.getElementById('msgTitle');
        var c = document.getElementById('msgContent');
        if (t) t.value = '';
        if (c) c.value = '';
        return loadMessages();
      })
      .then(function (msgs) {
        cachedMessages = msgs;
        renderMessageList(cachedMessages);
      })
      .catch(function (e) { App.showToast(e.message, 'error'); })
      .then(function () { btn.disabled = false; btn.textContent = orig; });
  }

  function handleArchiveMessage(messageId, btn) {
    App.showConfirm('确认归档此留言？归档后用户将不再看到。', function () {
      var orig = btn.textContent;
      btn.disabled = true; btn.textContent = '处理中...';
      archiveMessage(messageId)
        .then(function () {
          App.showToast('已归档', 'success');
          return loadMessages();
        })
        .then(function (msgs) {
          cachedMessages = msgs;
          renderMessageList(cachedMessages);
        })
        .catch(function (e) { App.showToast(e.message, 'error'); })
        .then(function () { btn.disabled = false; btn.textContent = orig; });
    });
  }

  // ========== v1.10.0 词库管理 (预置词库 CRUD + 批量导入) ==========

  var STAGES = ['小学', '初中', '高中', '大学', '考研', '其他'];
  var currentPresetStage = '小学';

  async function loadWordbookSection() {
    var c = document.getElementById('adminTabContent');
    if (!c) return;
    c.innerHTML = '<div class="stats-empty"><p style="color:var(--color-text-lighter);">加载中...</p></div>';
    try {
      // 并行加载: 学段统计 + 当前学段词列表
      await loadPresetStats();
      await loadPresetWords(currentPresetStage);
      renderWordbookManage();
    } catch (e) {
      showSectionError('adminTabContent', e.message);
    }
  }

  async function loadPresetStats() {
    var hash = getAdminHash();
    if (!hash) throw new Error('无管理员权限');
    var res = await App.DB.rpc('admin_preset_word_stats', { p_admin_pwd_hash: hash });
    if (!res || !res.success) throw new Error((res && res.error) || '加载统计失败');
    cachedPresetStats = res;
  }

  async function loadPresetWords(stage) {
    var hash = getAdminHash();
    if (!hash) throw new Error('无管理员权限');
    var res = await App.DB.rpc('admin_list_preset_words', {
      p_admin_pwd_hash: hash,
      p_stage: stage,
      p_offset: 0,
      p_limit: 500,
    });
    if (!res || !res.success) throw new Error((res && res.error) || '加载预置词失败');
    cachedPresetWords = res.words || [];
  }

  async function addPresetWord(word, phonetic, pos, meaning, example, stage) {
    var hash = getAdminHash();
    if (!hash) throw new Error('无管理员权限');
    var res = await App.DB.rpc('admin_add_preset_word', {
      p_admin_pwd_hash: hash,
      p_word: word, p_phonetic: phonetic, p_part_of_speech: pos,
      p_chinese_meaning: meaning, p_example_sentence: example, p_stage: stage,
    });
    if (!res || !res.success) throw new Error((res && res.error) || '新增失败');
    return res;
  }

  async function updatePresetWord(id, word, phonetic, pos, meaning, example, stage) {
    var hash = getAdminHash();
    if (!hash) throw new Error('无管理员权限');
    var res = await App.DB.rpc('admin_update_preset_word', {
      p_admin_pwd_hash: hash, p_word_id: id,
      p_word: word, p_phonetic: phonetic, p_part_of_speech: pos,
      p_chinese_meaning: meaning, p_example_sentence: example, p_stage: stage,
    });
    if (!res || !res.success) throw new Error((res && res.error) || '更新失败');
    return res;
  }

  async function deletePresetWord(id) {
    var hash = getAdminHash();
    if (!hash) throw new Error('无管理员权限');
    var res = await App.DB.rpc('admin_delete_preset_word', {
      p_admin_pwd_hash: hash, p_word_id: id,
    });
    if (!res || !res.success) throw new Error((res && res.error) || '删除失败');
    return res;
  }

  async function batchAddPresetWords(words) {
    var hash = getAdminHash();
    if (!hash) throw new Error('无管理员权限');
    var res = await App.DB.rpc('admin_batch_add_preset_words', {
      p_admin_pwd_hash: hash,
      p_words: words,
    });
    if (!res || !res.success) throw new Error((res && res.error) || '批量导入失败');
    return res;
  }

  function renderWordbookManage() {
    var el = document.getElementById('adminTabContent');
    if (!el) return;

    // 学段统计
    var stats = (cachedPresetStats && cachedPresetStats.stats) || [];
    var total = (cachedPresetStats && cachedPresetStats.total) || 0;
    var statsHtml = '';
    for (var i = 0; i < STAGES.length; i++) {
      var s = STAGES[i];
      var found = null;
      for (var j = 0; j < stats.length; j++) {
        if (stats[j].stage === s) { found = stats[j]; break; }
      }
      var cnt = found ? found.count : 0;
      var isActive = s === currentPresetStage;
      statsHtml +=
        '<button class="btn ' + (isActive ? 'btn-primary' : 'btn-outline') + ' btn-sm preset-stage-btn" data-stage="' + s + '" style="margin:4px;">' +
          s + ' (' + cnt + ')' +
        '</button>';
    }

    var html =
      '<div class="stats-section-title">预置词库管理</div>' +
      // 学段统计 + 切换
      '<div class="chart-card">' +
        '<div style="margin-bottom:8px;font-size:13px;color:var(--color-text-light);">学段切换 (当前: <b>' + currentPresetStage + '</b>，总计 <b>' + total + '</b> 词)</div>' +
        '<div>' + statsHtml + '</div>' +
      '</div>' +
      // 操作区
      '<div class="chart-card" style="margin-top:12px;">' +
        '<h3>单词管理</h3>' +
        '<div class="form-actions" style="margin-bottom:12px;">' +
          '<button class="btn btn-primary btn-sm" id="btnPresetAdd">单个新增</button>' +
          '<button class="btn btn-outline btn-sm" id="btnPresetBatchImport">批量导入 (Excel)</button>' +
        '</div>' +
        // 词列表
        '<div id="presetWordList"></div>' +
      '</div>';

    el.innerHTML = html;

    renderPresetWordList();

    // 学段切换
    el.querySelectorAll('.preset-stage-btn').forEach(function (btn) {
      btn.addEventListener('click', async function () {
        currentPresetStage = btn.getAttribute('data-stage');
        try {
          await loadPresetWords(currentPresetStage);
          renderWordbookManage();
        } catch (e) {
          App.showToast(e.message, 'error');
        }
      });
    });

    document.getElementById('btnPresetAdd').addEventListener('click', function () {
      showPresetWordModal(null);
    });
    document.getElementById('btnPresetBatchImport').addEventListener('click', showPresetBatchImportModal);
  }

  function renderPresetWordList() {
    var listEl = document.getElementById('presetWordList');
    if (!listEl) return;
    if (!cachedPresetWords || cachedPresetWords.length === 0) {
      listEl.innerHTML = '<div class="stats-empty"><p>该学段暂无预置词</p></div>';
      return;
    }

    var html =
      '<div class="word-table-container" style="max-height:400px;overflow-y:auto;">' +
        '<table class="word-table">' +
          '<thead><tr><th>单词</th><th>音标</th><th>词性</th><th>中文释义</th><th>学段</th><th>操作</th></tr></thead>' +
          '<tbody>';
    for (var i = 0; i < cachedPresetWords.length; i++) {
      var w = cachedPresetWords[i];
      html +=
        '<tr data-word-id="' + w.id + '">' +
          '<td>' + App.Utils.escapeHtml(w.word) + '</td>' +
          '<td>' + App.Utils.escapeHtml(w.phonetic || '') + '</td>' +
          '<td>' + App.Utils.escapeHtml(w.part_of_speech || '') + '</td>' +
          '<td>' + App.Utils.escapeHtml(w.chinese_meaning || '') + '</td>' +
          '<td>' + App.Utils.escapeHtml(w.stage) + '</td>' +
          '<td>' +
            '<button class="btn btn-outline btn-sm btn-preset-edit">编辑</button> ' +
            '<button class="btn btn-danger btn-sm btn-preset-del">删除</button>' +
          '</td>' +
        '</tr>';
    }
    html += '</tbody></table></div>';
    listEl.innerHTML = html;

    // 编辑/删除事件
    listEl.querySelectorAll('tr[data-word-id]').forEach(function (tr) {
      var id = tr.getAttribute('data-word-id');
      tr.querySelector('.btn-preset-edit').addEventListener('click', function () {
        var w = findPresetWordById(id);
        if (w) showPresetWordModal(w);
      });
      tr.querySelector('.btn-preset-del').addEventListener('click', function () {
        handleDeletePresetWord(id);
      });
    });
  }

  function findPresetWordById(id) {
    for (var i = 0; i < cachedPresetWords.length; i++) {
      if (cachedPresetWords[i].id === id) return cachedPresetWords[i];
    }
    return null;
  }

  function showPresetWordModal(word) {
    var isEdit = !!word;
    var w = word || { word: '', phonetic: '', part_of_speech: '', chinese_meaning: '', example_sentence: '', stage: currentPresetStage };
    var stageOptions = STAGES.map(function (s) {
      return '<option value="' + s + '"' + (s === w.stage ? ' selected' : '') + '>' + s + '</option>';
    }).join('');

    var body =
      '<div class="form-group"><label>单词/词组</label>' +
        '<input type="text" id="pmWord" value="' + escapeAttr(w.word) + '" style="width:100%;padding:10px 12px;font-size:14px;border:1px solid var(--color-border);border-radius:var(--radius-sm);background:var(--color-card);"></div>' +
      '<div class="form-group"><label>音标</label>' +
        '<input type="text" id="pmPhonetic" value="' + escapeAttr(w.phonetic || '') + '" style="width:100%;padding:10px 12px;font-size:14px;border:1px solid var(--color-border);border-radius:var(--radius-sm);background:var(--color-card);"></div>' +
      '<div class="form-group"><label>词性</label>' +
        '<input type="text" id="pmPos" value="' + escapeAttr(w.part_of_speech || '') + '" style="width:100%;padding:10px 12px;font-size:14px;border:1px solid var(--color-border);border-radius:var(--radius-sm);background:var(--color-card);"></div>' +
      '<div class="form-group"><label>中文释义</label>' +
        '<input type="text" id="pmMeaning" value="' + escapeAttr(w.chinese_meaning || '') + '" style="width:100%;padding:10px 12px;font-size:14px;border:1px solid var(--color-border);border-radius:var(--radius-sm);background:var(--color-card);"></div>' +
      '<div class="form-group"><label>例句</label>' +
        '<textarea id="pmExample" rows="2" style="width:100%;padding:10px 12px;font-size:14px;border:1px solid var(--color-border);border-radius:var(--radius-sm);background:var(--color-card);">' + escapeAttr(w.example_sentence || '') + '</textarea></div>' +
      '<div class="form-group"><label>学段</label>' +
        '<select id="pmStage" style="width:100%;padding:10px 12px;font-size:14px;border:1px solid var(--color-border);border-radius:var(--radius-sm);background:var(--color-card);">' + stageOptions + '</select></div>' +
      '<div class="form-actions">' +
        '<button class="btn btn-outline" id="pmCancel">取消</button>' +
        '<button class="btn btn-primary" id="pmSave">' + (isEdit ? '保存' : '新增') + '</button>' +
      '</div>';

    App.showModal(isEdit ? '编辑预置词' : '新增预置词', body);

    document.getElementById('pmCancel').addEventListener('click', App.hideModal);
    document.getElementById('pmSave').addEventListener('click', function () {
      var word2 = document.getElementById('pmWord').value.trim();
      var phonetic = document.getElementById('pmPhonetic').value.trim();
      var pos = document.getElementById('pmPos').value.trim();
      var meaning = document.getElementById('pmMeaning').value.trim();
      var example = document.getElementById('pmExample').value.trim();
      var stage = document.getElementById('pmStage').value;

      if (!word2) { App.showToast('请输入单词', 'error'); return; }
      if (!meaning) { App.showToast('请输入中文释义', 'error'); return; }

      var btn = this;
      btn.disabled = true; btn.textContent = '保存中...';
      var p;
      if (isEdit) {
        p = updatePresetWord(w.id, word2, phonetic, pos, meaning, example, stage);
      } else {
        p = addPresetWord(word2, phonetic, pos, meaning, example, stage);
      }
      p.then(function () {
        App.showToast(isEdit ? '已更新' : '已新增', 'success');
        App.hideModal();
        return refreshPresetWords();
      })
      .catch(function (e) { App.showToast(e.message, 'error'); })
      .then(function () { btn.disabled = false; btn.textContent = isEdit ? '保存' : '新增'; });
    });
  }

  function handleDeletePresetWord(id) {
    var w = findPresetWordById(id);
    var name = w ? w.word : id;
    App.showConfirm('确认删除预置词 "' + name + '"？', function () {
      deletePresetWord(id)
        .then(function () {
          App.showToast('已删除', 'success');
          return refreshPresetWords();
        })
        .catch(function (e) { App.showToast(e.message, 'error'); });
    });
  }

  async function refreshPresetWords() {
    await loadPresetStats();
    await loadPresetWords(currentPresetStage);
    renderWordbookManage();
  }

  function showPresetBatchImportModal() {
    var body =
      '<div class="form-group"><label>选择学段 (导入的词将归入此学段)</label>' +
        '<select id="pmBatchStage" style="width:100%;padding:10px 12px;font-size:14px;border:1px solid var(--color-border);border-radius:var(--radius-sm);background:var(--color-card);">' +
          STAGES.map(function (s) {
            return '<option value="' + s + '"' + (s === currentPresetStage ? ' selected' : '') + '>' + s + '</option>';
          }).join('') +
        '</select></div>' +
      '<div class="form-group"><label>选择 Excel 文件</label>' +
        '<input type="file" id="pmBatchFile" accept=".xlsx,.xls,.csv" style="width:100%;padding:10px;font-size:14px;"></div>' +
      '<div class="form-group"><label>列说明 (表头需包含)</label>' +
        '<p style="font-size:13px;color:var(--color-text-light);line-height:1.8;">' +
          '单词: <b>单词/词组/word</b><br>' +
          '音标: <b>音标/phonetic</b> (可选)<br>' +
          '词性: <b>词性/partOfSpeech</b> (可选)<br>' +
          '中文: <b>中文释义/中文/chineseMeaning</b><br>' +
          '例句: <b>例句/example</b> (可选)' +
        '</p></div>' +
      '<div class="form-actions">' +
        '<button class="btn btn-outline" id="pmBatchCancel">取消</button>' +
        '<button class="btn btn-primary" id="pmBatchUpload">导入</button>' +
      '</div>';

    App.showModal('批量导入预置词', body);

    document.getElementById('pmBatchCancel').addEventListener('click', App.hideModal);
    document.getElementById('pmBatchUpload').addEventListener('click', function () {
      var stage = document.getElementById('pmBatchStage').value;
      var fileInput = document.getElementById('pmBatchFile');
      if (!fileInput.files || !fileInput.files[0]) {
        App.showToast('请选择文件', 'error');
        return;
      }
      var btn = this;
      btn.disabled = true; btn.textContent = '导入中...';
      handlePresetBatchImport(fileInput.files[0], stage)
        .then(function () { App.hideModal(); return refreshPresetWords(); })
        .catch(function (e) { App.showToast(e.message, 'error'); })
        .then(function () { btn.disabled = false; btn.textContent = '导入'; });
    });
  }

  async function handlePresetBatchImport(file, stage) {
    var XLSX = await ensureXLSX();
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function (e) {
        try {
          var data = new Uint8Array(e.target.result);
          var workbook = XLSX.read(data, { type: 'array' });
          var sheet = workbook.Sheets[workbook.SheetNames[0]];
          var rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

          if (rows.length === 0) {
            reject(new Error('文件无数据'));
            return;
          }

          // 复用 library.js 的表头映射
          var HEADER_MAP = {
            '单词/词组': 'word', '单词': 'word', '词组': 'word', 'word': 'word', 'Word': 'word',
            '音标': 'phonetic', 'phonetic': 'phonetic', 'Phonetic': 'phonetic',
            '词性': 'part_of_speech', 'partOfSpeech': 'part_of_speech', 'pos': 'part_of_speech',
            '中文译意': 'chinese_meaning', '中文释义': 'chinese_meaning', '中文': 'chinese_meaning',
            'chineseMeaning': 'chinese_meaning', 'meaning': 'chinese_meaning', '释义': 'chinese_meaning',
            '例句': 'example_sentence', 'exampleSentence': 'example_sentence', 'example': 'example_sentence',
          };

          var words = [];
          for (var i = 0; i < rows.length; i++) {
            var row = rows[i];
            var obj = { stage: stage };
            var keys = Object.keys(row);
            for (var j = 0; j < keys.length; j++) {
              var mapped = HEADER_MAP[keys[j]];
              if (mapped) obj[mapped] = String(row[keys[j]] || '').trim();
            }
            if (obj.word && obj.chinese_meaning) {
              words.push(obj);
            }
          }

          if (words.length === 0) {
            reject(new Error('未找到有效数据 (需含单词和中文释义列)'));
            return;
          }

          batchAddPresetWords(words)
            .then(function (res) {
              App.showToast('导入成功: 新增 ' + res.inserted + ' 词 (重复已跳过)', 'success');
              resolve();
            })
            .catch(function (e) { reject(e); });
        } catch (err) {
          reject(new Error('解析文件失败: ' + err.message));
        }
      };
      reader.onerror = function () { reject(new Error('读取文件失败')); };
      reader.readAsArrayBuffer(file);
    });
  }

  return {
    show: show,
    renderDashboard: renderDashboard,
    renderUserManagement: renderUserManagement,
    renderPromoSettings: renderPromoSettings,
    renderMessageManagement: renderMessageManagement,
    loadDashboard: loadDashboard,
    loadUsers: loadUsers,
    authorizeUser: authorizeUser,
    revokeUser: revokeUser,
    savePromo: savePromo,
    publishMessage: publishMessage,
    archiveMessage: archiveMessage,
    loadMessages: loadMessages,
  };
})();

export default App.Admin;
