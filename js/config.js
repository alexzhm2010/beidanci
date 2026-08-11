/**
 * 全局配置 & 工具函数
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
};

App.Config = {
  // 应用信息
  APP_NAME: '背单词',
  APP_VERSION: '2.0.0-beta.8',

  // IndexedDB 配置
  DB_NAME: 'BeidanciDB',
  DB_VERSION: 1,

  // Object Store 名称
  STORE_WORDS: 'words',
  STORE_RECORDS: 'records',

  // localStorage 键
  KEY_SYNC_CODE: 'beidanci_sync_code',
  KEY_LAST_TAB: 'beidanci_last_tab',
  KEY_USERNAME: 'beidanci_username',
  KEY_PWD_HASH: 'beidanci_pwd_hash',
  KEY_LIBRARY_LEVEL: 'beidanci_library_level',

  // 默认用户名 (内部同步码字段)
  DEFAULT_SYNC_CODE: 'default',

  // 默认词库级别 (cet4=四级)
  DEFAULT_LIBRARY_LEVEL: 'cet4',

  // 预置词库级别选项
  LIBRARY_LEVELS: [
    { key: 'primary',  label: '小学',  desc: '约 800 词' },
    { key: 'junior',   label: '初中',  desc: '约 2000 词' },
    { key: 'senior',   label: '高中',  desc: '约 3500 词' },
    { key: 'cet4',     label: '四级',  desc: '约 4500 词, 默认' },
  ],

  // ========== 授权系统配置 ==========
  AUTH: {
    TRIAL_DAYS: 7,                    // 试用期天数
    ADMIN_CODE: 'beidanci_admin',     // 管理员用户名
    APP_SALT: 'bx_word_2026_salt_k3y',// 密码加密盐
    WECHAT_ID: '',                    // 捐赠联系微信 (稍后填写)
    WECHAT_QR: '',                    // 微信收款码图片路径 (稍后填写)
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

  // 词典API (有道公开接口,可能受CORS限制,失败时手动填写)
  DICT_API_YOUDAO: 'https://dict.youdao.com/jsonapi?q=',
  DICT_API_FREE: 'https://api.dictionaryapi.dev/api/v2/entries/en/',

  // MyMemory 翻译API — 填入邮箱可将免费额度从 5000字符/天 提升到 50000字符/天
  // 留空则匿名调用 (按IP限额)
  TRANSLATE_API_EMAIL: 'alexzhm@126.com',

  // ====== Supabase 配置 ======
  // 正式环境 (主线 https://alexzhm2010.github.io/beidanci/)
  SUPABASE_URL: 'https://gjtjivmxxelnousbqmok.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_BM_REPSHCEDqbVGD2hrblA_EtMq_9RN',

  // Beta 测试环境 (独立 Supabase 项目, 与正式环境完全隔离)
  // 部署在 /beta/ 路径时自动使用此配置
  // 1. 在 Supabase 创建新项目 (与正式项目独立的数据库)
  // 2. 依次执行 supabase.sql + sql/preset_library.sql 建表
  // 3. 在 Settings > API 中复制 URL 和 anon key 填入下方
  BETA_SUPABASE_URL: 'https://xcljhedqvaqxofvorexu.supabase.co',
  BETA_SUPABASE_ANON_KEY: 'sb_publishable_LW0e_50RMKFOl6TbxDkwdw_PI-iKRa6',
};

// ========== Supabase 连接配置 (根据部署路径自动切换环境) ==========
App.DBConfig = {
  // 检测当前是否为 beta 测试环境 (URL 路径包含 /beta/)
  isBeta: function () {
    return window.location.pathname.indexOf('/beta/') !== -1;
  },
  getUrl: function () {
    if (this.isBeta()) return App.Config.BETA_SUPABASE_URL || '';
    return App.Config.SUPABASE_URL || '';
  },
  getKey: function () {
    if (this.isBeta()) return App.Config.BETA_SUPABASE_ANON_KEY || '';
    return App.Config.SUPABASE_ANON_KEY || '';
  },
  isConfigured: function () {
    var url = this.getUrl();
    var key = this.getKey();
    return !!(url && key && url.startsWith('http') && !url.includes('your-project'));
  },
  getRestUrl: function () {
    return this.getUrl().replace(/\/+$/, '') + '/rest/v1/';
  },
};
