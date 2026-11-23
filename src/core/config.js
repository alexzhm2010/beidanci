/**
 * 全局配置 & 工具函数 (v1.11.0 ES Module 重构)
 *
 * 重构说明 (v1.11.0):
 *   - 从 IIFE 改为 ES Module, 由 main.js 静态 import 加载 (首屏必需)
 *   - 保留 window.App.X 命名空间, 业务模块内部 App.Config/App.Utils 引用不变
 *   - 此文件为所有模块的基础依赖, 必须最先加载
 */
window.App = window.App || {};

// ========== 工具函数 (最先加载, 供所有模块使用) ==========
App.Utils = {
  /** HTML转义, 防止XSS */
  escapeHtml: function (text) {
    if (text == null) return '';
    var div = document.createElement('div');
    div.textContent = String(text);
    return div.innerHTML;
  },

  /** 防抖 */
  debounce: function (fn, delay) {
    var timer = null;
    return function () {
      var ctx = this, args = arguments;
      clearTimeout(timer);
      timer = setTimeout(function () { fn.apply(ctx, args); }, delay);
    };
  },

  /** 格式化日期 YYYY-MM-DD */
  formatDate: function (timestamp) {
    if (!timestamp) return '';
    var d = new Date(timestamp);
    return d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0');
  },

  /** 获取今天 0 点的时间戳 */
  todayStart: function () {
    var d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  },

  /** 获取N天前 0 点的时间戳 */
  daysAgoStart: function (n) {
    var d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - n);
    return d.getTime();
  },

  /** SHA-256 哈希 (异步, 返回 Promise) */
  sha256: async function (text) {
    var encoder = new TextEncoder();
    var data = encoder.encode(text);
    var hashBuffer = await crypto.subtle.digest('SHA-256', data);
    var hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
  },

  /**
   * v1.22.0: 渲染 Victor 富内容快照 (学习页 + 词库页共用)
   * detail 结构见 sql/victor_sync_rpc.sql: senses / notes / phonetic 等
   * 所有字段经 escapeHtml 转义, 防 XSS
   */
  renderRichDetail: function (detail) {
    if (!detail || typeof detail !== 'object') return '';
    var esc = App.Utils.escapeHtml;
    var html = '<div class="rich-detail">';
    var senses = Array.isArray(detail.senses) ? detail.senses : [];
    if (senses.length) {
      html += '<ol class="rd-senses">';
      senses.forEach(function (s) {
        var freq = Number(s.sense_freq || 0);
        var freqTag = freq === 1 ? '<span class="rd-freq">常考</span>' : '';
        var tags = '';
        if (s.countability) tags += '<span class="rd-tag">' + esc(s.countability) + '</span>';
        if (s.usage_label) tags += '<span class="rd-tag">' + esc(s.usage_label) + '</span>';
        if (s.antonym) tags += '<span class="rd-tag">反 ' + esc(s.antonym) + '</span>';
        var examples = Array.isArray(s.examples) ? s.examples : [];
        var exHtml = '';
        examples.forEach(function (e) {
          var kind = e.kind === 'phrase' ? '短语' : '例句';
          exHtml += '<div class="rd-example"><span class="rd-kind">' + kind + '</span>' +
            '<span class="rd-en">' + esc(e.en || '') + '</span>' +
            (e.zh ? '<span class="rd-zh">' + esc(e.zh) + '</span>' : '') + '</div>';
        });
        html += '<li class="rd-sense">' +
          (s.pos ? '<span class="rd-pos">' + esc(s.pos) + '</span>' : '') +
          '<span class="rd-def">' + esc(s.chinese_def || '') + '</span>' +
          freqTag + tags +
          (s.english_def ? '<div class="rd-eng">' + esc(s.english_def) + '</div>' : '') +
          exHtml + '</li>';
      });
      html += '</ol>';
    }
    var notes = Array.isArray(detail.notes) ? detail.notes : [];
    notes.forEach(function (n) {
      var lines = String(n.content || '').split(/\n+/).filter(Boolean).map(function (line) {
        return '<div>' + esc(line) + '</div>';
      }).join('');
      html += '<div class="rd-note"><span class="rd-note-type">' + esc(n.note_type || '注') + '</span>' +
        (n.title ? '<b>' + esc(n.title) + '</b>' : '') +
        '<div class="rd-note-body">' + lines + '</div></div>';
    });
    html += '</div>';
    return html;
  },

  /**
   * v1.24.0: 一比一复刻 Victor app.js wordCardHtml —— 数据结构也对齐 Victor。
   * 数据源为 uw_* 四表的嵌套查询结果 (headword/senses/examples/notes 与 Victor 底座完全同名),
   * 不再读 detail JSONB 快照, 富内容信息零丢失。
   * 保留 Victor 词卡 DOM 全部元素 (含 word-actions 三态按钮/长按事件属性),
   * 仅三态徽标按用户要求换成熟练度徽标; 三态持久化/A-Z/关系网/长按交互不接逻辑。
   */
  renderVictorCard: function (w) {
    var esc = App.Utils.escapeHtml;
    var senses = Array.isArray(w.senses) ? w.senses : [];
    var notes = Array.isArray(w.notes) ? w.notes : [];

    // ---- 义项 (复刻 Victor: 实心序号 + 词性 + 标签 + 英释 + 例句/短语) ----
    var sensesHtml = senses.map(function (s) {
      var senseNo = s.sense_no || s.no || 0;
      var usageLabel = s.usage_label || s.usage || '';
      var defText = s.chinese_def || s.def || '';
      var tags = [];
      if (s.countability) tags.push('<span class="tag tag-count">' + esc(s.countability) + '</span>');
      if (usageLabel) tags.push('<span class="tag tag-usage">' + esc(usageLabel) + '</span>');
      if (s.antonym) tags.push('<span class="tag tag-anto">反 ' + esc(s.antonym) + '</span>');
      var freq = Number(s.sense_freq || 0);
      var noCls = freq === 1 ? 'no no-high' : (freq === 2 ? 'no no-low' : 'no');
      var freqTag = freq === 1 ? '<span class="tag tag-freq">常考</span>' : '';
      var no = senseNo ? '<span class="' + noCls + '">' + senseNo + '</span>' : '';

      // 摊平嵌套 children (短语下挂例句)
      var flatItems = [];
      var flatten = function (arr, parent) {
        (arr || []).forEach(function (it) {
          var copy = {};
          for (var k in it) if (Object.prototype.hasOwnProperty.call(it, k)) copy[k] = it[k];
          copy._parent = parent || '';
          flatItems.push(copy);
          if (it.children && it.children.length) flatten(it.children, it.en || parent || '');
        });
      };
      flatten(s.examples || s.items || [], '');

      var items = flatItems.map(function (it) {
        var kind = it.kind === 'phrase'
          ? '<span class="kind">短语</span>' : '<span class="kind">例句</span>';
        var src = it.source ? '<span class="src">' + esc(it.source) + '</span>' : '';
        var gloss = it.gloss ? '<span class="gloss">' + esc(it.gloss) + '</span>' : '';
        var parent = (it.parent_phrase || it._parent)
          ? '<span class="gloss">↳ ' + esc(it.parent_phrase || it._parent) + '</span>' : '';
        return '<div class="item src-wrap">' + kind +
          '<span class="en">' + esc(it.en || '') + '</span>' +
          '<span class="zh">' + esc(it.zh || '') + '</span>' + parent + gloss + src + '</div>';
      }).join('');

      var engDef = s.english_def ? '<div class="eng-def">' + esc(s.english_def) + '</div>' : '';
      return '<div class="sense"><div class="sense-hd">' + no +
        '<span class="pos">' + esc(s.pos || '') + '</span>' +
        '<span class="def">' + esc(defText) + '</span>' + freqTag + tags.join('') + '</div>' +
        engDef + items + '</div>';
    }).join('');

    // ---- 核心释义智能合并 (复刻 Victor) ----
    var normDef = function (s) {
      return String(s || '').toLowerCase()
        .replace(/\[[^\]]*\]/g, '')
        .replace(/(?:n|v|vt|vi|adj|adv|prep|conj|pron|art|aux|int|abbr|phr)\.?\s*/gi, '')
        .replace(/[\s；;，,。:：/（）()\[\]「」·&…]/g, '');
    };
    var coreRaw = (w.level_tag || '').trim();
    var sideRaw = (w.inline_def || (senses[0] && (senses[0].chinese_def || senses[0].def)) || '').trim();
    var coreText = normDef(coreRaw), sideText = normDef(sideRaw);
    var mergedDef = '';
    if (coreRaw && sideRaw) {
      if (coreText === sideText) mergedDef = coreRaw.length >= sideRaw.length ? coreRaw : sideRaw;
      else if (coreText.indexOf(sideText) !== -1) mergedDef = coreRaw;
      else if (sideText.indexOf(coreText) !== -1) mergedDef = sideRaw;
      else mergedDef = coreRaw + '；' + sideRaw;
    } else {
      mergedDef = coreRaw || sideRaw;
    }
    // 无富内容时, 右侧灰字回退到中文释义
    if (!mergedDef && w.chineseMeaning) mergedDef = w.chineseMeaning;
    var wordDefHtml = mergedDef ? '<span class="word-def">' + esc(mergedDef) + '</span>' : '';
    var page = w.page_no ? '<span style="font-size:11px;color:var(--muted)">P' + esc(w.page_no) + '</span>' : '';
    var partialTag = w.partial ? '<span class="partial-tag" title="页尾被截断，扫描下一页会自动补全">待补全</span>' : '';

    var IDENTITY = { '*': '课标外', '⊕': '增补', '⊖': '删减', 'derived': '派生词' };
    var identityTag = '';
    if (w.identity_tag && IDENTITY[w.identity_tag]) {
      identityTag = '<span class="tag tag-identity id-' + esc(w.identity_tag) + '" title="' + IDENTITY[w.identity_tag] + '">' + esc(w.identity_tag) + '</span>';
    }
    var derivedTag = w.derived_from
      ? '<span class="tag tag-derived" title="派生自 ' + esc(w.derived_from) + '">派生自 ' + esc(w.derived_from) + '</span>' : '';

    // ---- 蓝底标签框 (辨/注/同/反/高考链接 ...) ----
    var notesHtml = notes.map(function (n) {
      var t = (n.note_type && String(n.note_type).trim()) || '注';
      var title = n.title ? '<div class="note-title">' + esc(n.title) + '</div>' : '';
      var content = String(n.content || '').split(/\n+/).filter(Boolean)
        .map(function (line) { return '<div class="note-line">' + esc(line).replace(/^•\s*/, '• ') + '</div>'; }).join('');
      return '<div class="vw-note note-' + esc(t) + '"><span class="note-badge">' + esc(t) + '</span>' + title + '<div class="note-body">' + content + '</div></div>';
    }).join('');

    // ---- 熟练度徽标 (替代 Victor 三态) ----
    var level = App.Algorithm.getProficiencyLevel(w);
    var profText = w.totalCount > 0
      ? Math.round((w.knownCount / w.totalCount) * 100) + '%' : '-';
    var profTag = '<span class="study-tag custom" title="熟练度">' + esc(level.label + ' ' + profText) + '</span>';

    // v1.24.0: 一比一复刻 Victor wordCardHtml —— 所有词卡都可点击展开,
    // 无富内容时 body 显示一行中文释义。
    var bodyHtml = (sensesHtml || notesHtml)
      ? (sensesHtml + notesHtml)
      : '<div style="font-size:13px;color:var(--muted);padding:8px 0">' +
          (w.chineseMeaning ? esc(w.chineseMeaning) : '（无详细义项）') + '</div>';

    var key = w.id != null ? ('id' + w.id) : ('hw' + esc(w.headword));
    var isProgress = w.totalCount > 0 && (w.knownCount / w.totalCount) >= 0.8;
    // Victor 原版 word-actions 三态按钮 DOM (保留视觉, 交互逻辑按用户要求不接)
    var actionsHtml = '<div class="word-actions">' +
      '<button class="act-btn" type="button" tabindex="-1"><span class="ico">✓</span>已会</button>' +
      '<button class="act-btn" type="button" tabindex="-1"><span class="ico">✕</span>不会</button>' +
      '<button class="act-btn" type="button" tabindex="-1"><span class="ico">📍</span>进度</button>' +
      '</div>';
    return '<div class="word-card' + (isProgress ? ' is-progress' : '') + '"' +
      ' id="wc-' + key + '" data-word-id="' + esc(w.id) + '"' +
      ' data-derived="' + (w.derived_from ? '1' : '0') + '">' +
      '<div class="word-row"><div class="word-swipe">' +
        '<div class="word-hd" data-expandable="1" data-key="' + key + '" role="button" aria-expanded="false" tabindex="0">' +
          '<svg class="arrow" viewBox="0 0 24 24" fill="none" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg>' +
          '<span class="word-name">' + esc(w.headword) + '</span>' +
          '<span class="word-ph">' + esc(w.phonetic || '') + '</span>' +
          profTag + identityTag + derivedTag + page + partialTag +
          wordDefHtml +
        '</div>' + actionsHtml +
      '</div></div>' +
      '<div class="word-body">' + bodyHtml + '</div>' +
    '</div>';
  },
};

App.Config = {
  // 应用信息
  APP_NAME: '背单词',
  APP_VERSION: '1.26.1',

  // IndexedDB 配置
  DB_NAME: 'BeidanciDB',
  DB_VERSION: 1,

  // Object Store 名称
  STORE_WORDS: 'words',
  STORE_RECORDS: 'records',

  // localStorage 键
  KEY_SYNC_CODE: 'beidanci_sync_code',   // 历史用户名 (显示用, 兼容旧 badge)
  KEY_LAST_TAB: 'beidanci_last_tab',
  KEY_USERNAME: 'beidanci_username',     // 用户名 (展示 + 假邮箱前缀)
  KEY_PWD_HASH: 'beidanci_pwd_hash',     // 旧 SHA-256 哈希 (迁移校验兜底)
  KEY_UID: 'beidanci_uid',               // Supabase Auth user_id (RLS 强隔离核心)
  KEY_ACCESS_TOKEN: 'beidanci_access_token',   // JWT (业务请求 Authorization 头)
  KEY_REFRESH_TOKEN: 'beidanci_refresh_token', // 刷新令牌 (access_token 过期后换新)

  // 默认用户名 (内部同步码字段)
  DEFAULT_SYNC_CODE: 'default',

  // ========== 授权系统配置 ==========
  AUTH: {
    TRIAL_DAYS: 7,                    // 试用期天数
    ADMIN_CODE: 'beidanci_admin',     // 管理员用户名（仅用于后台权限校验，非超级密钥）
    APP_SALT: 'bx_word_2026_salt_k3y',// 密码哈希加盐（仅用于本地哈希计算，即使暴露也无法单独解密密码）
    EMAIL_DOMAIN: 'beidanci.local',   // 假邮箱域 (username → username@beidanci.local, 不发真实邮件)
    WECHAT_ID: '',                    // 捐赠联系微信 (稍后填写)
    WECHAT_QR: '',                    // 微信收款码图片路径 (稍后填写)
  },

  // YunGouOS (云购支付) 在线支付配置
  YUNGOU: {
    // create-pay-order Edge Function 的 URL, 留空则只显示微信收款码(人工开通)
    CREATE_ORDER_URL: 'https://gjtjivmxxelnousbqmok.supabase.co/functions/v1/create-pay-order',
  },

  // Edge Functions (v1.9.0 安全加固: Supabase Auth 迁移相关, 持有 service_role)
  EDGE_FUNCTIONS: {
    // 老用户首次登录自动迁移 (校验旧哈希 → 建 Auth 账号 → 回填 user_id)
    MIGRATE_USER_URL: 'https://gjtjivmxxelnousbqmok.supabase.co/functions/v1/migrate-user',
    // 改密/找回密码 (同步更新 Supabase Auth bcrypt + user_auth 哈希)
    UPDATE_PASSWORD_URL: 'https://gjtjivmxxelnousbqmok.supabase.co/functions/v1/update-password',
    // 词典导入 v1.16.0: 百度 OCR 云端识别 (API Key/Secret Key 配在 Supabase Secrets)
    BAIDU_OCR_URL: 'https://gjtjivmxxelnousbqmok.supabase.co/functions/v1/baidu-ocr',
    // v1.21.0: Victor 词库后端同步任务 (服务端分批执行, 进度写库, 不依赖浏览器常驻)
    VICTOR_SYNC_URL: 'https://gjtjivmxxelnousbqmok.supabase.co/functions/v1/victor-sync',
  },

  // 密保问题选项
  SEC_QUESTIONS: [
    '你的小学名称是什么？',
    '你最喜欢的书叫什么？',
    '你的宠物叫什么名字？',
    '你出生的城市是？',
    '你母亲的生日是几月几号？',
  ],

  // 新词学习数量选项
  NEW_WORD_OPTIONS: [20, 40, 60],

  // 智能复习数量选项
  REVIEW_OPTIONS: [30, 60, 90],

  // 词库搜索初始展示行数 (滚动加载更多)
  SEARCH_MAX_ROWS: 30,
  // 词库每页加载数量 (滚动到底部时加载)
  SEARCH_PAGE_SIZE: 30,

  // ========== 复习算法参数 (SM-2 遗忘曲线改进版) ==========
  // 新词优先按词库顺序学, 已学词按"到期时间"复习
  // 认识 → 下次复习间隔变长 (越熟越久再见)
  // 不认识 → 间隔缩短 + 尽快重考

  // 初始复习间隔 (毫秒) — 第一次学完认识后的下次复习时间
  REVIEW_INTERVAL_INIT: 30 * 60 * 1000,          // 30 分钟
  // 认识后间隔放大倍数 — 每次认识, 间隔 *= 该倍数
  REVIEW_INTERVAL_FACTOR: 2.5,
  // 间隔上限 — 避免熟词彻底消失, 最久 60 天后再见一面
  REVIEW_INTERVAL_MAX: 60 * 24 * 60 * 60 * 1000,
  // 不认识后间隔下限 — 至少隔这么久才重考, 避免立刻又出现
  REVIEW_INTERVAL_MIN_FAIL: 10 * 60 * 1000,        // 10 分钟
  // 不认识后稳定度衰减 — 每次不认识, 稳定度 (历史间隔) 乘以该系数
  REVIEW_STABILITY_DECAY: 0.5,

  // 兜底: 距上次学习超过该时长未到期的词, 强制加入复习队列
  REVIEW_FALLBACK_INTERVAL: 14 * 24 * 60 * 60 * 1000,  // 7 天

  // 随机抽样比例 — 选词时从到期词中按此比例抽样, 避免每次都是固定顺序
  REVIEW_RANDOM_RATIO: 0.5,

  // ========== "会拼写"熟悉态参数 (v1.18.0) ==========
  // 用户点"会拼写"后, 该词进入熟悉冻结期, 任何复习入口都不再出现
  // 冻结期 = FAMILIAR_MIN_DAYS ~ (FAMILIAR_MIN_DAYS + FAMILIAR_RANDOM_DAYS) 天之间随机取一天复现
  FAMILIAR_MIN_DAYS: 7,        // 最少冻结 7 天
  FAMILIAR_RANDOM_DAYS: 7,     // 额外随机 0~7 天 (即 7~14 天后随机复现)
  FAMILIAR_KNOWN_BONUS: 2,     // 点"会拼写"时 knownCount 增量 ("会"是 1, 这里快一倍 = 2)

  // 词典API (有道公开接口,可能受CORS限制,失败时手动填写)
  DICT_API_YOUDAO: 'https://dict.youdao.com/jsonapi?q=',
  DICT_API_FREE: 'https://api.dictionaryapi.dev/api/v2/entries/en/',

  // MyMemory 翻译API — 填入邮箱可将免费额度从 5000字符/天 提升到 50000字符/天
  // 留空则匿名调用 (按IP限额)
  // ⚠️ 请勿将个人邮箱提交到仓库, 在本地填写后不要 git add config.js
  TRANSLATE_API_EMAIL: '',

  // ====== Supabase 配置 (在此填写你的项目信息) ======
  // 1. 登录 supabase.com 创建项目
  // 2. 执行 supabase.sql 建表
  // 3. 在 Settings > API 中复制 URL 和 anon key 填入下方
  SUPABASE_URL: 'https://gjtjivmxxelnousbqmok.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_BM_REPSHCEDqbVGD2hrblA_EtMq_9RN',
};

// ========== Supabase 连接配置 (读取 App.Config) ==========
App.DBConfig = {
  getUrl: function () { return App.Config.SUPABASE_URL || ''; },
  getKey: function () { return App.Config.SUPABASE_ANON_KEY || ''; },
  isConfigured: function () {
    var url = this.getUrl();
    var key = this.getKey();
    return !!(url && key && url.startsWith('http') && !url.includes('your-project'));
  },
  getRestUrl: function () {
    return this.getUrl().replace(/\/+$/, '') + '/rest/v1/';
  },
};

// ES Module 导出 (供 main.js 显式 import, 同时 window.App.* 命名空间保留供业务模块使用)
export default App.Config;
export const Utils = App.Utils;
export const DBConfig = App.DBConfig;
