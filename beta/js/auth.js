/**
 * 用户认证 & 授权模块
 * 功能: 登录/注册/找回密码、授权检查、捐赠引导、管理员留言
 *
 * 集成说明:
 *   在 app.js 的 DOMContentLoaded 中, 将 `App.initializeApp()` 替换为 `App.Auth.init()`
 *   本模块会在授权通过后自动调用 App.initializeApp() 加载主应用
 *   需要在 index.html 中添加: <div id="authOverlay" class="hidden"></div>
 */
window.App = window.App || {};
App.Auth = (function () {

  var CFG = App.Config;
  var AUTH = CFG.AUTH;
  var _appStarted = false; // 防止重复初始化主应用

  // ========== 内部工具 ==========

  function _esc(text) {
    return App.Utils.escapeHtml(text);
  }

  function _showOverlay(html) {
    var overlay = document.getElementById('authOverlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'authOverlay';
      document.body.appendChild(overlay);
    }
    overlay.innerHTML = html;
    overlay.classList.remove('hidden');
    overlay.style.display = 'flex';
  }

  function _hideOverlay() {
    var overlay = document.getElementById('authOverlay');
    if (!overlay) return;
    overlay.classList.add('hidden');
    overlay.style.display = 'none';
    overlay.innerHTML = '';
  }

  /** 在授权遮罩层中渲染一个卡片 (注册/找回密码等复用) */
  function _showAuthCard(title, subtitle, bodyHtml) {
    var html =
      '<div style="position:fixed;top:0;left:0;width:100%;height:100%;' +
        'background:linear-gradient(135deg,#4A90D9,#357ABD);display:flex;align-items:center;' +
        'justify-content:center;z-index:9999;padding:20px;box-sizing:border-box;">' +
        '<div style="background:#fff;border-radius:12px;padding:28px 24px;' +
          'width:100%;max-width:360px;box-shadow:0 8px 32px rgba(0,0,0,0.2);max-height:90vh;overflow-y:auto;">' +
          '<h2 style="text-align:center;font-size:22px;color:#333;margin-bottom:6px;">' + _esc(title) + '</h2>' +
          (subtitle ? '<p style="text-align:center;font-size:13px;color:#999;margin-bottom:20px;">' + _esc(subtitle) + '</p>' : '') +
          bodyHtml +
        '</div>' +
      '</div>';
    _showOverlay(html);
  }

  function _clearAuthStorage() {
    localStorage.removeItem(CFG.KEY_USERNAME);
    localStorage.removeItem(CFG.KEY_PWD_HASH);
    localStorage.removeItem(CFG.KEY_SYNC_CODE);
  }

  function _startApp() {
    if (_appStarted) return;
    _appStarted = true;
    if (typeof App.initializeApp === 'function') {
      App.initializeApp();
    }
  }

  /** 登录成功后的统一流程: 检查授权 → 进入应用或显示捐赠页 */
  async function _afterLoginSuccess(username) {
    var status = await checkAuth(username);
    if (status === 'authorized' || status === 'admin' || status === 'trial') {
      _hideOverlay();
      _startApp();
      // 异步检查未读留言 (不阻塞应用加载)
      showMessagesPopup(username);
    } else {
      // expired 或 none: 显示捐赠页
      showDonationPage();
    }
  }

  // ========== 1. init ==========

  async function init() {
    if (isLoggedIn()) {
      var username = localStorage.getItem(CFG.KEY_USERNAME);
      var pwdHash = localStorage.getItem(CFG.KEY_PWD_HASH);
      try {
        var result = await App.DB.verifyLogin(username, pwdHash);
        if (result.success) {
          // 登录有效, 检查授权
          await _afterLoginSuccess(username);
          return;
        }
      } catch (e) {
        console.error('[Auth] init 验证失败:', e);
      }
      // 登录无效或出错, 清除本地状态
      _clearAuthStorage();
    }
    showLoginPage();
  }

  // ========== 2. hashPassword ==========

  function hashPassword(username, password) {
    return App.Utils.sha256(username + password + AUTH.APP_SALT);
  }

  // ========== 3. showLoginPage ==========

  function showLoginPage() {
    var html =
      '<div class="auth-overlay" style="position:fixed;top:0;left:0;width:100%;height:100%;' +
        'background:linear-gradient(135deg,#4A90D9,#357ABD);display:flex;align-items:center;' +
        'justify-content:center;z-index:9999;padding:20px;box-sizing:border-box;">' +
        '<div class="auth-card" style="background:#fff;border-radius:12px;padding:32px 24px;' +
          'width:100%;max-width:340px;box-shadow:0 8px 32px rgba(0,0,0,0.2);">' +
          '<h2 style="text-align:center;font-size:24px;color:#333;margin-bottom:6px;">背单词</h2>' +
          '<p style="text-align:center;font-size:13px;color:#999;margin-bottom:24px;">登录以开始学习</p>' +
          '<div class="auth-form">' +
            '<div style="margin-bottom:14px;">' +
              '<input type="text" id="loginUsername" class="auth-input" placeholder="用户名" autocomplete="off" ' +
                'style="width:100%;padding:12px 14px;font-size:15px;border:1px solid #E0E0E0;border-radius:6px;box-sizing:border-box;">' +
            '</div>' +
            '<div style="margin-bottom:20px;">' +
              '<input type="password" id="loginPassword" class="auth-input" placeholder="密码" ' +
                'style="width:100%;padding:12px 14px;font-size:15px;border:1px solid #E0E0E0;border-radius:6px;box-sizing:border-box;">' +
            '</div>' +
            '<button id="btnLogin" class="auth-btn" ' +
              'style="width:100%;padding:12px;background:#4A90D9;color:#fff;border:none;border-radius:6px;font-size:16px;font-weight:500;cursor:pointer;">' +
              '登录</button>' +
            '<div style="display:flex;justify-content:space-between;margin-top:16px;font-size:13px;">' +
              '<a href="#" id="linkRegister" style="color:#4A90D9;text-decoration:none;">注册新账户</a>' +
              '<a href="#" id="linkForgot" style="color:#4A90D9;text-decoration:none;">忘记密码</a>' +
            '</div>' +
          '</div>' +
        '</div>' +
      '</div>';

    _showOverlay(html);

    document.getElementById('btnLogin').addEventListener('click', _handleLogin);
    document.getElementById('loginPassword').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') _handleLogin();
    });
    document.getElementById('linkRegister').addEventListener('click', function (e) {
      e.preventDefault();
      showRegisterPage();
    });
    document.getElementById('linkForgot').addEventListener('click', function (e) {
      e.preventDefault();
      showForgotPasswordPage();
    });

    setTimeout(function () {
      var u = document.getElementById('loginUsername');
      if (u) u.focus();
    }, 100);
  }

  async function _handleLogin() {
    var username = document.getElementById('loginUsername').value.trim();
    var password = document.getElementById('loginPassword').value;

    if (!username || !password) {
      App.showToast('请输入用户名和密码', 'error');
      return;
    }

    var btn = document.getElementById('btnLogin');
    btn.disabled = true;
    btn.textContent = '登录中...';

    try {
      var ok = await login(username, password);
      if (ok) {
        App.showToast('登录成功', 'success');
        await _afterLoginSuccess(username);
      }
    } catch (e) {
      App.showToast('登录失败: ' + e.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = '登录';
    }
  }

  // ========== 4. showRegisterPage ==========

  function showRegisterPage() {
    var options = '';
    for (var i = 0; i < CFG.SEC_QUESTIONS.length; i++) {
      options += '<option value="' + i + '">' + _esc(CFG.SEC_QUESTIONS[i]) + '</option>';
    }

    var body =
      '<div class="form-group">' +
        '<label>用户名</label>' +
        '<input type="text" id="regUsername" placeholder="请输入用户名" autocomplete="off">' +
        '<p class="form-hint">用户名用于云端同步学习数据, 请妥善保管</p>' +
      '</div>' +
      '<div class="form-group">' +
        '<label>密码</label>' +
        '<input type="password" id="regPassword" placeholder="请输入密码">' +
      '</div>' +
      '<div class="form-group">' +
        '<label>确认密码</label>' +
        '<input type="password" id="regPassword2" placeholder="再次输入密码">' +
      '</div>' +
      '<div class="form-group">' +
        '<label>密保问题</label>' +
        '<select id="regSecQuestion">' + options + '</select>' +
      '</div>' +
      '<div class="form-group">' +
        '<label>密保答案</label>' +
        '<input type="text" id="regSecAnswer" placeholder="请输入密保答案" autocomplete="off">' +
        '<p class="form-hint">用于找回密码, 不区分大小写</p>' +
      '</div>' +
      '<div class="form-actions">' +
        '<button class="btn btn-outline" id="btnRegBack">返回登录</button>' +
        '<button class="btn btn-primary" id="btnRegSubmit">注册</button>' +
      '</div>';

    _showAuthCard('注册新账户', null, body);

    document.getElementById('btnRegBack').addEventListener('click', showLoginPage);
    document.getElementById('btnRegSubmit').addEventListener('click', _handleRegister);
  }

  async function _handleRegister() {
    var username = document.getElementById('regUsername').value.trim();
    var password = document.getElementById('regPassword').value;
    var password2 = document.getElementById('regPassword2').value;
    var secQIdx = parseInt(document.getElementById('regSecQuestion').value, 10);
    var secAnswer = document.getElementById('regSecAnswer').value.trim();

    if (!username) { App.showToast('请输入用户名', 'error'); return; }
    if (!password) { App.showToast('请输入密码', 'error'); return; }
    if (password !== password2) { App.showToast('两次密码不一致', 'error'); return; }
    if (!secAnswer) { App.showToast('请输入密保答案', 'error'); return; }

    // 管理员用户名检查: 仅允许在管理员不存在时注册
    if (username === AUTH.ADMIN_CODE) {
      try {
        var adminExists = await App.DB.usernameExists(AUTH.ADMIN_CODE);
        if (adminExists) {
          App.showToast('该用户名已被保留', 'error');
          return;
        }
      } catch (e) {
        App.showToast('验证失败: ' + e.message, 'error');
        return;
      }
    }

    var btn = document.getElementById('btnRegSubmit');
    btn.disabled = true;
    btn.textContent = '注册中...';

    try {
      // 用户名唯一性检查
      var exists = await App.DB.usernameExists(username);
      if (exists) {
        App.showToast('用户名已存在', 'error');
        return;
      }

      // 哈希密码和密保答案
      var pwdHash = await hashPassword(username, password);
      var secAnswerHash = await App.Utils.sha256(secAnswer.toLowerCase());
      var secQuestion = CFG.SEC_QUESTIONS[secQIdx];

      // 写入数据库
      await App.DB.registerUser(username, pwdHash, secQuestion, secAnswerHash);

      // 自动登录: 写入 localStorage, 设置用户名
      localStorage.setItem(CFG.KEY_USERNAME, username);
      localStorage.setItem(CFG.KEY_PWD_HASH, pwdHash);
      App.DB.setSyncCode(username);

      App.showToast('注册成功, 欢迎使用!', 'success');

      // 新用户默认在试用期内, 直接进入应用
      await _afterLoginSuccess(username);
    } catch (e) {
      App.showToast('注册失败: ' + e.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = '注册';
    }
  }

  // ========== 5. showForgotPasswordPage ==========

  function showForgotPasswordPage() {
    _forgotStep1();
  }

  function _forgotStep1() {
    var body =
      '<div class="form-group">' +
        '<label>用户名</label>' +
        '<input type="text" id="forgotUsername" placeholder="请输入用户名" autocomplete="off">' +
      '</div>' +
      '<div class="form-actions">' +
        '<button class="btn btn-outline" id="btnForgotBack">返回登录</button>' +
        '<button class="btn btn-primary" id="btnForgotNext">下一步</button>' +
      '</div>';

    _showAuthCard('找回密码 (1/3)', '通过密保问题重置密码', body);

    document.getElementById('btnForgotBack').addEventListener('click', showLoginPage);
    document.getElementById('btnForgotNext').addEventListener('click', _forgotStep1Next);
  }

  async function _forgotStep1Next() {
    var username = document.getElementById('forgotUsername').value.trim();
    if (!username) { App.showToast('请输入用户名', 'error'); return; }

    var btn = document.getElementById('btnForgotNext');
    btn.disabled = true;
    btn.textContent = '查询中...';

    try {
      var result = await App.DB.getSecQuestion(username);
      if (!result || !result.success) {
        App.showToast('用户名不存在', 'error');
        return;
      }
      _forgotStep2(username, result.question);
    } catch (e) {
      App.showToast('查询失败: ' + e.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = '下一步';
    }
  }

  function _forgotStep2(username, question) {
    var body =
      '<div class="form-group">' +
        '<label>密保问题</label>' +
        '<p style="padding:10px 12px;background:var(--color-border-light);border-radius:4px;font-size:14px;color:#333;">' +
          _esc(question) + '</p>' +
      '</div>' +
      '<div class="form-group">' +
        '<label>密保答案</label>' +
        '<input type="text" id="forgotAnswer" placeholder="请输入密保答案" autocomplete="off">' +
      '</div>' +
      '<div class="form-actions">' +
        '<button class="btn btn-outline" id="btnForgotPrev">上一步</button>' +
        '<button class="btn btn-primary" id="btnForgotVerify">验证</button>' +
      '</div>';

    _showAuthCard('找回密码 (2/3)', '请回答密保问题', body);

    document.getElementById('btnForgotPrev').addEventListener('click', function () {
      _forgotStep1();
      // 回填用户名
      var u = document.getElementById('forgotUsername');
      if (u) u.value = username;
    });
    document.getElementById('btnForgotVerify').addEventListener('click', function () {
      _forgotStep2Verify(username);
    });
  }

  async function _forgotStep2Verify(username) {
    var answer = document.getElementById('forgotAnswer').value.trim();
    if (!answer) { App.showToast('请输入密保答案', 'error'); return; }

    var btn = document.getElementById('btnForgotVerify');
    btn.disabled = true;
    btn.textContent = '验证中...';

    try {
      var answerHash = await App.Utils.sha256(answer.toLowerCase());
      var ok = await App.DB.verifySecAnswer(username, answerHash);
      if (!ok) {
        App.showToast('密保答案错误', 'error');
        return;
      }
      _forgotStep3(username, answerHash);
    } catch (e) {
      App.showToast('验证失败: ' + e.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = '验证';
    }
  }

  function _forgotStep3(username) {
    var body =
      '<div class="form-group">' +
        '<label>新密码</label>' +
        '<input type="password" id="forgotNewPwd" placeholder="请输入新密码">' +
      '</div>' +
      '<div class="form-group">' +
        '<label>确认新密码</label>' +
        '<input type="password" id="forgotNewPwd2" placeholder="再次输入新密码">' +
      '</div>' +
      '<div class="form-actions">' +
        '<button class="btn btn-primary" id="btnForgotReset">重置密码</button>' +
      '</div>';

    _showAuthCard('找回密码 (3/3)', '设置新密码', body);

    document.getElementById('btnForgotReset').addEventListener('click', function () {
      _forgotStep3Reset(username);
    });
  }

  async function _forgotStep3Reset(username) {
    var pwd = document.getElementById('forgotNewPwd').value;
    var pwd2 = document.getElementById('forgotNewPwd2').value;

    if (!pwd) { App.showToast('请输入新密码', 'error'); return; }
    if (pwd !== pwd2) { App.showToast('两次密码不一致', 'error'); return; }

    var btn = document.getElementById('btnForgotReset');
    btn.disabled = true;
    btn.textContent = '重置中...';

    try {
      var pwdHash = await hashPassword(username, pwd);
      await App.DB.updatePassword(username, pwdHash);
      App.showToast('密码重置成功, 请重新登录', 'success');
      showLoginPage();
    } catch (e) {
      App.showToast('重置失败: ' + e.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = '重置密码';
    }
  }

  // ========== 6. login ==========

  async function login(username, password) {
    if (!username || !password) {
      App.showToast('请输入用户名和密码', 'error');
      return false;
    }
    try {
      var pwdHash = await hashPassword(username, password);
      var result = await App.DB.verifyLogin(username, pwdHash);
      if (!result.success) {
        App.showToast(result.error === 'user_not_found' ? '用户名不存在' : '密码错误', 'error');
        return false;
      }
      // 登录成功: 保存到 localStorage, 设置用户名
      localStorage.setItem(CFG.KEY_USERNAME, username);
      localStorage.setItem(CFG.KEY_PWD_HASH, pwdHash);
      App.DB.setSyncCode(username);
      return true;
    } catch (e) {
      App.showToast('登录失败: ' + e.message, 'error');
      return false;
    }
  }

  // ========== 7. checkAuth ==========

  async function checkAuth(username) {
    // 管理员直接放行
    if (username === AUTH.ADMIN_CODE) return 'admin';

    try {
      var auth = await App.DB.getAuthorization(username);
      if (!auth) {
        // 无授权记录: 检查是否在试用期内
        var userInfo = await App.DB.getUserAuthInfo(username);
        if (userInfo && userInfo.created_at) {
          var createdMs = new Date(userInfo.created_at).getTime();
          var trialEnd = createdMs + AUTH.TRIAL_DAYS * 24 * 60 * 60 * 1000;
          if (Date.now() < trialEnd) return 'trial';
        }
        return 'none';
      }
      // 有授权记录
      if (auth.status === 'revoked') return 'expired';
      if (auth.expiresAt && new Date(auth.expiresAt).getTime() < Date.now()) return 'expired';
      return 'authorized';
    } catch (e) {
      console.error('[Auth] checkAuth error:', e);
      return 'none';
    }
  }

  // ========== 8. showDonationPage ==========

  function showDonationPage() {
    var username = getCurrentUser() || '';

    // 先用默认文案渲染, 异步加载促销配置后更新
    _renderDonationPage(username, null);

    App.DB.getPromoConfig().then(function (promo) {
      _renderDonationPage(username, promo);
    }).catch(function (e) {
      console.error('[Auth] 加载促销配置失败:', e);
    });
  }

  function _renderDonationPage(username, promo) {
    var qrHtml;
    if (AUTH.WECHAT_QR) {
      qrHtml = '<img src="' + _esc(AUTH.WECHAT_QR) + '" alt="微信收款码" ' +
        'style="width:200px;height:200px;border-radius:8px;border:1px solid #E0E0E0;display:block;margin:0 auto;">';
    } else {
      qrHtml = '<div style="width:200px;height:200px;border:2px dashed #ccc;border-radius:8px;display:flex;' +
        'align-items:center;justify-content:center;color:#999;font-size:13px;text-align:center;margin:0 auto;' +
        'padding:20px;box-sizing:border-box;">微信收款码<br>待配置</div>';
    }

    var promoText = (promo && promo.text) ? promo.text : '捐赠20元得1年使用权';
    var contactHtml = AUTH.WECHAT_ID
      ? '<p style="font-size:14px;color:#666;margin-top:14px;">捐赠后请联系微信: ' +
        '<b style="color:#333;">' + _esc(AUTH.WECHAT_ID) + '</b></p>'
      : '';

    var html =
      '<div class="auth-overlay" style="position:fixed;top:0;left:0;width:100%;height:100%;' +
        'background:linear-gradient(135deg,#4A90D9,#357ABD);display:flex;align-items:center;' +
        'justify-content:center;z-index:9999;padding:20px;box-sizing:border-box;overflow-y:auto;">' +
        '<div class="auth-card" style="background:#fff;border-radius:12px;padding:32px 24px;' +
          'width:100%;max-width:360px;box-shadow:0 8px 32px rgba(0,0,0,0.2);text-align:center;">' +
          '<h2 style="font-size:22px;color:#333;margin-bottom:6px;">支持背单词</h2>' +
          '<p style="font-size:13px;color:#999;margin-bottom:18px;">当前账户: ' + _esc(username) + '</p>' +
          '<p style="font-size:15px;color:#333;margin-bottom:16px;font-weight:500;">' + _esc(promoText) + '</p>' +
          qrHtml +
          contactHtml +
          '<p style="font-size:13px;color:#999;margin-top:16px;line-height:1.6;">' +
            '捐赠后请联系管理员开通授权<br>开通后点击下方刷新按钮' +
          '</p>' +
          '<button id="btnRefreshAuth" class="auth-btn" ' +
            'style="width:100%;padding:12px;background:#4A90D9;color:#fff;border:none;border-radius:6px;' +
            'font-size:16px;font-weight:500;cursor:pointer;margin-top:20px;">刷新</button>' +
          '<button id="btnDonationLogout" ' +
            'style="width:100%;padding:10px;background:transparent;color:#999;border:none;font-size:14px;' +
            'cursor:pointer;margin-top:8px;">退出登录</button>' +
        '</div>' +
      '</div>';

    _showOverlay(html);

    document.getElementById('btnRefreshAuth').addEventListener('click', _refreshAuth);
    document.getElementById('btnDonationLogout').addEventListener('click', logout);
  }

  async function _refreshAuth() {
    var username = getCurrentUser();
    if (!username) {
      showLoginPage();
      return;
    }
    var btn = document.getElementById('btnRefreshAuth');
    if (btn) { btn.disabled = true; btn.textContent = '检查中...'; }
    try {
      var status = await checkAuth(username);
      if (status === 'authorized' || status === 'admin' || status === 'trial') {
        App.showToast('授权有效, 即将进入应用', 'success');
        _hideOverlay();
        _startApp();
        showMessagesPopup(username);
      } else {
        App.showToast('授权尚未开通, 请捐赠后联系管理员', 'error');
      }
    } catch (e) {
      App.showToast('检查失败: ' + e.message, 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '刷新'; }
    }
  }

  // ========== 9. showMessagesPopup ==========

  async function showMessagesPopup(username) {
    if (!username) return;
    try {
      var messages = await App.DB.getUnreadMessages(username);
      if (!messages || messages.length === 0) return;

      var listHtml = '';
      for (var i = 0; i < messages.length; i++) {
        var m = messages[i];
        listHtml +=
          '<div class="msg-card" data-card-id="' + m.id + '" ' +
            'style="border:1px solid #E0E0E0;border-radius:8px;padding:16px;margin-bottom:12px;">' +
            '<h3 style="font-size:16px;color:#333;margin-bottom:8px;">' + _esc(m.title) + '</h3>' +
            '<div style="font-size:14px;color:#666;line-height:1.6;white-space:pre-wrap;">' + _esc(m.content) + '</div>' +
            '<button class="btn btn-sm btn-outline" data-msg-id="' + m.id + '" style="margin-top:10px;">已读</button>' +
          '</div>';
      }

      var body =
        '<div style="max-height:60vh;overflow-y:auto;">' + listHtml + '</div>' +
        '<div class="form-actions">' +
          '<button class="btn btn-primary" id="btnMarkAllRead">全部已读</button>' +
        '</div>';

      App.showModal('系统留言 (' + messages.length + ' 条)', body);

      // 单条已读: 标记并移除该卡片
      var buttons = document.querySelectorAll('[data-msg-id]');
      for (var j = 0; j < buttons.length; j++) {
        buttons[j].addEventListener('click', function () {
          var msgId = parseInt(this.getAttribute('data-msg-id'), 10);
          var card = this.closest('[data-card-id]');
          var self = this;
          App.DB.markMessageRead(username, msgId).then(function () {
            if (card) card.remove();
            var remaining = document.querySelectorAll('[data-msg-id]');
            if (remaining.length === 0) {
              App.hideModal();
            }
          }).catch(function () {
            App.showToast('标记失败', 'error');
          });
        });
      }

      // 全部已读
      document.getElementById('btnMarkAllRead').addEventListener('click', function () {
        var promises = [];
        for (var k = 0; k < messages.length; k++) {
          promises.push(App.DB.markMessageRead(username, messages[k].id));
        }
        Promise.all(promises).then(function () {
          App.hideModal();
          App.showToast('已全部标记为已读', 'success');
        }).catch(function () {
          App.showToast('部分标记失败', 'error');
        });
      });
    } catch (e) {
      console.error('[Auth] showMessagesPopup error:', e);
    }
  }

  // ========== 10. logout ==========

  function logout() {
    _clearAuthStorage();
    _appStarted = false; // 允许重新登录后再次初始化应用
    showLoginPage();
  }

  // ========== 11. isLoggedIn ==========

  function isLoggedIn() {
    return !!(localStorage.getItem(CFG.KEY_USERNAME) && localStorage.getItem(CFG.KEY_PWD_HASH));
  }

  // ========== 12. getCurrentUser ==========

  function getCurrentUser() {
    return localStorage.getItem(CFG.KEY_USERNAME) || null;
  }

  // ========== 13. getAdminPwdHash ==========

  function getAdminPwdHash() {
    return localStorage.getItem(CFG.KEY_PWD_HASH) || '';
  }

  // ========== 14. changePasswordForm ==========

  function changePasswordForm() {
    var username = getCurrentUser();
    if (!username) {
      App.showToast('请先登录', 'error');
      return;
    }

    var body =
      '<div class="form-group">' +
        '<label>原密码</label>' +
        '<input type="password" id="chgOldPwd" placeholder="请输入原密码">' +
      '</div>' +
      '<div class="form-group">' +
        '<label>新密码</label>' +
        '<input type="password" id="chgNewPwd" placeholder="请输入新密码">' +
      '</div>' +
      '<div class="form-group">' +
        '<label>确认新密码</label>' +
        '<input type="password" id="chgNewPwd2" placeholder="再次输入新密码">' +
      '</div>' +
      '<div class="form-actions">' +
        '<button class="btn btn-outline" id="btnChgPwdCancel">取消</button>' +
        '<button class="btn btn-primary" id="btnChgPwdSubmit">确认修改</button>' +
      '</div>';

    App.showModal('修改密码', body);

    document.getElementById('btnChgPwdCancel').addEventListener('click', App.hideModal);
    document.getElementById('btnChgPwdSubmit').addEventListener('click', function () {
      _handleChangePassword(username);
    });
  }

  async function _handleChangePassword(username) {
    var oldPwd = document.getElementById('chgOldPwd').value;
    var newPwd = document.getElementById('chgNewPwd').value;
    var newPwd2 = document.getElementById('chgNewPwd2').value;

    if (!oldPwd) { App.showToast('请输入原密码', 'error'); return; }
    if (!newPwd) { App.showToast('请输入新密码', 'error'); return; }
    if (newPwd !== newPwd2) { App.showToast('两次新密码不一致', 'error'); return; }

    var btn = document.getElementById('btnChgPwdSubmit');
    btn.disabled = true;
    btn.textContent = '修改中...';

    try {
      // 验证原密码
      var oldHash = await hashPassword(username, oldPwd);
      var user = await App.DB.getUserAuth(username);
      if (!user || user.passwordHash !== oldHash) {
        App.showToast('原密码错误', 'error');
        return;
      }
      // 更新密码
      var newHash = await hashPassword(username, newPwd);
      await App.DB.updatePassword(username, newHash);
      // 同步更新 localStorage
      localStorage.setItem(CFG.KEY_PWD_HASH, newHash);
      App.showToast('密码修改成功', 'success');
      App.hideModal();
    } catch (e) {
      App.showToast('修改失败: ' + e.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = '确认修改';
    }
  }

  // ========== 15. changeSecQuestionForm ==========

  function changeSecQuestionForm() {
    var username = getCurrentUser();
    if (!username) {
      App.showToast('请先登录', 'error');
      return;
    }

    var options = '';
    for (var i = 0; i < CFG.SEC_QUESTIONS.length; i++) {
      options += '<option value="' + i + '">' + _esc(CFG.SEC_QUESTIONS[i]) + '</option>';
    }

    var body =
      '<div class="form-group">' +
        '<label>密码验证</label>' +
        '<input type="password" id="chgSecPwd" placeholder="请输入当前密码">' +
      '</div>' +
      '<div class="form-group">' +
        '<label>新密保问题</label>' +
        '<select id="chgSecQuestion">' + options + '</select>' +
      '</div>' +
      '<div class="form-group">' +
        '<label>新密保答案</label>' +
        '<input type="text" id="chgSecAnswer" placeholder="请输入新密保答案" autocomplete="off">' +
      '</div>' +
      '<div class="form-actions">' +
        '<button class="btn btn-outline" id="btnChgSecCancel">取消</button>' +
        '<button class="btn btn-primary" id="btnChgSecSubmit">确认修改</button>' +
      '</div>';

    App.showModal('修改密保问题', body);

    document.getElementById('btnChgSecCancel').addEventListener('click', App.hideModal);
    document.getElementById('btnChgSecSubmit').addEventListener('click', function () {
      _handleChangeSecQuestion(username);
    });
  }

  async function _handleChangeSecQuestion(username) {
    var pwd = document.getElementById('chgSecPwd').value;
    var secQIdx = parseInt(document.getElementById('chgSecQuestion').value, 10);
    var secAnswer = document.getElementById('chgSecAnswer').value.trim();

    if (!pwd) { App.showToast('请输入密码', 'error'); return; }
    if (!secAnswer) { App.showToast('请输入密保答案', 'error'); return; }

    var btn = document.getElementById('btnChgSecSubmit');
    btn.disabled = true;
    btn.textContent = '修改中...';

    try {
      // 验证密码
      var pwdHash = await hashPassword(username, pwd);
      var user = await App.DB.getUserAuth(username);
      if (!user || user.passwordHash !== pwdHash) {
        App.showToast('密码错误', 'error');
        return;
      }
      // 更新密保
      var secAnswerHash = await App.Utils.sha256(secAnswer.toLowerCase());
      var secQuestion = CFG.SEC_QUESTIONS[secQIdx];
      await App.DB.updateSecQuestion(username, secQuestion, secAnswerHash);
      App.showToast('密保问题修改成功', 'success');
      App.hideModal();
    } catch (e) {
      App.showToast('修改失败: ' + e.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = '确认修改';
    }
  }

  // ========== 导出 ==========

  return {
    init: init,
    hashPassword: hashPassword,
    showLoginPage: showLoginPage,
    showRegisterPage: showRegisterPage,
    showForgotPasswordPage: showForgotPasswordPage,
    login: login,
    checkAuth: checkAuth,
    showDonationPage: showDonationPage,
    showMessagesPopup: showMessagesPopup,
    logout: logout,
    isLoggedIn: isLoggedIn,
    getCurrentUser: getCurrentUser,
    getAdminPwdHash: getAdminPwdHash,
    changePasswordForm: changePasswordForm,
    changeSecQuestionForm: changeSecQuestionForm,
  };
})();
