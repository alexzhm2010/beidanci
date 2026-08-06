/**
 * 管理员后台模块
 * 功能: 运营看板、用户管理(授权/吊销)、促销设置、留言管理
 * 依赖: App.DB (rpc), App.Auth (管理员鉴权), App.Utils, Chart.js
 */
window.App = window.App || {};
App.Admin = (function () {
  var charts = {};
  var cachedUsers = [];
  var cachedPromo = null;
  var cachedMessages = [];

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

  // ========== 主入口 show ==========

  async function show() {
    if (!checkAuth()) return;
    var container = getContainer();
    if (!container) return;

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

    // 并行加载各模块数据
    loadDashboardSection();
    loadUsersSection();
    loadPromoSection();
    loadMessagesSection();
  }

  function skeletonHtml() {
    var adminName = (App.Auth && App.Auth.getCurrentUser) ? App.Auth.getCurrentUser() : '管理员';
    return (
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">' +
        '<span style="font-size:14px;color:var(--color-text-light);">当前管理员: <b>' + App.Utils.escapeHtml(adminName) + '</b></span>' +
        '<button class="btn btn-danger btn-sm" id="btnAdminLogout">退出登录</button>' +
      '</div>' +
      '<div class="stats-section-title">运营看板</div>' +
      '<div id="adminDashboard"><div class="stats-empty"><p style="color:var(--color-text-lighter);">加载中...</p></div></div>' +
      '<div class="stats-section-title" style="margin-top:24px;">用户管理</div>' +
      '<div id="adminUsers"><div class="stats-empty"><p style="color:var(--color-text-lighter);">加载中...</p></div></div>' +
      '<div class="stats-section-title" style="margin-top:24px;">促销设置</div>' +
      '<div id="adminPromo"><div class="stats-empty"><p style="color:var(--color-text-lighter);">加载中...</p></div></div>' +
      '<div class="stats-section-title" style="margin-top:24px;">留言管理</div>' +
      '<div id="adminMessages"><div class="stats-empty"><p style="color:var(--color-text-lighter);">加载中...</p></div></div>'
    );
  }

  async function loadDashboardSection() {
    try {
      var data = await loadDashboard();
      renderDashboard(data);
    } catch (e) {
      showSectionError('adminDashboard', e.message);
    }
  }

  async function loadUsersSection() {
    try {
      var users = await loadUsers(0, 100);
      cachedUsers = users || [];
      renderUserManagement();
    } catch (e) {
      showSectionError('adminUsers', e.message);
    }
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

  function renderDashboard(data) {
    var el = document.getElementById('adminDashboard');
    if (!el) return;

    destroyCharts();

    var rev = (data && data.revenue) || {};
    var users = (data && data.users) || {};
    var expiry = (data && data.expiry) || {};
    var monthlyDon = (data && data.monthly_donations) || [];
    var monthlyNew = (data && data.monthly_new_users) || [];

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
      '</div>' +
      // 图表
      '<div class="stats-charts">' +
        '<div class="chart-card"><h3>月度收入趋势</h3><div class="chart-wrapper" style="height:200px;"><canvas id="adminRevenueChart"></canvas></div></div>' +
        '<div class="chart-card"><h3>月度新增用户</h3><div class="chart-wrapper" style="height:200px;"><canvas id="adminNewUsersChart"></canvas></div></div>' +
      '</div>' +
      '<div class="chart-card" style="margin-top:16px;"><h3>用户状态分布</h3><div class="chart-wrapper" style="height:200px;"><canvas id="adminStatusChart"></canvas></div></div>';

    el.innerHTML = html;

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

  function renderRevenueChart(monthlyDon) {
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

  function renderNewUsersChart(monthlyNew) {
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

  function renderStatusChart(users) {
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
    var el = document.getElementById('adminUsers');
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
        '<div id="adminUserList"></div>' +
      '</div>';

    el.innerHTML = html;

    renderUserList(cachedUsers);

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
      var filtered = cachedUsers.filter(function (u) {
        return (u.username || '').toLowerCase().indexOf(q) !== -1;
      });
      renderUserList(filtered);
    });
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
          '<button class="btn btn-danger btn-sm" id="btnAdminRevoke">吊销</button>' +
        '</div>' +
      '</div>';

    infoEl.innerHTML = html;

    document.getElementById('btnAdminAuthorize').addEventListener('click', function () {
      var note = document.getElementById('adminAuthNote').value || '';
      handleAuthorize(user.username, note, this);
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
      cachedUsers = await loadUsers(0, 100);
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
          '<div style="margin-top:8px;display:flex;gap:6px;">' +
            '<button class="btn btn-success btn-sm" data-act="authorize" data-user="' + escapeAttr(u.username) + '">授权</button>' +
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
          }
        });
      })(btns[j]);
    }
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
