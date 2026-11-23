/* ============================================================
 * 背单词工具 前端逻辑
 * 两种运行模式：
 *  - 演示模式(demo)：用 window.DEMO_DATA，数据存 localStorage，双击即用
 *  - 在线模式：通过 Supabase REST API 上传图片、查词库，
 *              调用 Edge Function(scan-page) 完成 AI 拆解入库
 * ============================================================ */

const LS = {
  cfg:      'vocab_cfg',
  demo:     'vocab_demo_words',
  progress: 'vocab_scan_progress',   // { [book]: maxPageNo } 扫描进度记忆
  sync:     'vocab_sync',            // 当前同步码 { code, note, isSuper }
};

/* ---------------- 同步码状态 ---------------- */
const SUPER_CODE = 'bigbao';          // 内置超级码（v2.24.0 由 663798 改为 bigbao）
let sync = loadSync();               // { code, note, isSuper } | null
function loadSync() {
  try { const s = JSON.parse(localStorage.getItem(LS.sync) || 'null'); return s && s.code ? s : null; }
  catch (e) { return null; }
}
function saveSync(s) { localStorage.setItem(LS.sync, JSON.stringify(s)); }
function isSuper() { return !!(sync && (sync.code === SUPER_CODE || sync.isSuper)); }

/* ============================================================
 * 版本与更新日志（集中维护：每次改完功能，只需在这里加一条）
 * 最新一条放在数组最前面，首页会显示其版本号 + 更新要点。
 * ============================================================ */
const CHANGELOG = [
  { v: '2.24.0', date: '2026-11-23', items: [
    '超级码由 663798 改为 bigbao：以后统一用 bigbao 登录，学习进度已完整迁移，不会丢失',
    '同步切换前后端内置码常量，避免改名后进不了扫描页/设置页；历史数据预置脚本同步更新',
  ]},
  { v: '2.23.0', date: '2026-11-21', items: [
    '登录体验：修复每次刷新都弹出同步码输入框的问题——同步码其实早已记住，是门禁遮罩默认显示却没在已登录时关闭，现已自动关闭，真正做到登录一次长期免输',
    '消除浏览器「是否保存密码」骚扰：设置页 Supabase 公钥输入框由密码框改为普通文本框（公钥本就公开，无需打码），页面已无任何密码框',
  ]},
  { v: '2.22.0', date: '2026-11-18', items: [
    '修根因（写库层）：词性归一化只去末尾句点，导致重扫时 vt. & vi. 与 vt & vi 在写库层无法归组、生成重复义项（accelerate/accept 的真正源头），现写库归一化去全部句点+压缩空格，与前端一致，从源头杜绝重复义项入库',
    '增强健壮性：派生词多级嵌套且子词词序在母词前时，写入后统一二次回填 parent_word_id（只补空不覆盖），杜绝派生关系漏挂',
    '强化识别提示词：短词条（只有词头行）强制把核心释义写进 level_tag 并至少给一条义项，减少空壳词与字段错位',
  ]},
  { v: '2.21.4', date: '2026-11-18', items: [
    '修复重复义项显示：词性归一化只去末尾句点，导致 vt & vi 与 vt. & vi. 无法合并、同词出现两套相同释义和例句（如 accelerate/accept/about/above），现归一化去掉所有句点并压缩空格',
    '同步清理数据库中 22 组重扫残留的重复义项（保留带常考标/中文译文的完整版），全库义项去重、无内容丢失',
  ]},
  { v: '2.21.3', date: '2026-11-18', items: [
    '词库释义方案改进：核心释义与义项释义智能合并为一条，统一以右侧灰字展示，彻底去掉词头后的紫色核心释义标签',
    '合并规则：内容相同或互相包含取更完整者，两个不同义项则合并保留；展开词卡仍可看完整义项',
  ]},
  { v: '2.21.2', date: '2026-11-18', items: [
    '词库释义智能去重：词头后紫色核心释义与右侧灰色释义内容重复（相同或包含）时，不再重复显示右侧，词库行更清爽',
    '仅前端显示逻辑改动，数据库与识别规则不变，去重后可展开词卡查看完整义项',
  ]},
  { v: '2.21.1', date: '2026-11-18', items: [
    '修复词头带箭头/加号：如「▶ composer」「+compose」的派生/增补符号残留词头，现统一剥离到身份标签，词头恢复纯单词',
    '身份标签归一：cautiously(▶→派生)、及p78一组误认成实心圆●的词归位到增补⊕，前端标注更准确',
    '修根因：写库前符号剥离规则补全 ▶/▼/+ ，杜绝派生词再带箭头符号',
  ]},
  { v: '2.21.0', date: '2026-11-18', items: [
    '全库数据体检与订正：合并跨页重复词 as(P33/34)、blame(P55/56)，义项例句笔记完整归位、词库去重',
    '修复空壳词条：best-seller/best-selling/chant 从原始识别数据恢复释义；9个短词条补正式义项，词卡不再显示「无详细义项」',
    '归位错位内容：button 串到 buy 的例句已归位；清理14个纯空义项；20个缺词性义项补齐；修正 buy/believe 等错位',
    '修根因：识别时中文释义放错字段(word.chinese_def / sense.usage_label)的，写库前自动归位，杜绝短词条再次变空壳',
  ]},
  { v: '2.20.0', date: '2026-11-18', items: [
    '根治非法词头：词性标记(v/vt/vi/n/adj…)与栏目标签(高考链接/辨/同/反…)不再单独成词，写库前强制归位',
    '高考链接精确归类：按题干提示词/版面相邻词挂到对应单词的笔记里，不再独立成词条',
    '清理历史残留：v(P82)义项并入charge，两条高考链接归位combine/colo(u)rful，词库1193→1190',
  ]},
  { v: '2.19.0', date: '2026-11-18', items: [
    '修复词库只显示1000词：Supabase 单次查询硬上限1000条，现改为分页拉全，1193个词全部显示，P87~P100 不再缺失',
    '修复记录页「累计词条」虚高：不再累加各批次词数（重扫会重复计入），改为按词库真实词条数统计，现与词库页数字一致',
  ]},
  { v: '2.18.4', date: '2026-11-18', items: [
    '移除任务清单上方两个状态按钮（进行中/待验收、已验收归档），展示形式不变：仅显示未验收任务，已验收的归档后不再显示',
    '保留验收后刷新：点「确认验收」后下方页码清单立即更新，新页马上可见',
  ]},
  { v: '2.18.3', date: '2026-11-18', items: [
    '修复验收后页码清单不刷新：点「确认验收」后，下方记录页立即重拉，新页（如 P85）马上出现在页码清单里',
    '任务清单展示保持原样（已验收仍归档、不干扰进行中任务）',
  ]},
  { v: '2.18.1', date: '2026-11-18', items: [
    '细节修正：跳过的页直接显示跳过原因，不再误显示"等待云端执行"',
  ]},
  { v: '2.18.0', date: '2026-11-18', items: [
    '修复"两个同一页码"：连拍同一页时，若第一张云端解析中途被中断，页会永久卡在「解析中」；现已自动回收重扫（最多2次），多次失败转人工处理',
    '修根因：任务收尾前先检查是否仍有处理中的页，不再把卡住的任务提前标成完成',
    '本批数据订正：P58 那条卡死的重复页已标为「跳过」，同页已入库的词不受影响',
  ]},
  { v: '2.17.0', date: '2026-11-18', items: [
    '修复词头异常：剥离 * 星号到身份标签、栏目标签(辨/高考链接)归位到对应词、词性缩写(v.)义项并回主词',
    '数据修正：13个*词、辨/高考链接/v 共18条异常词已归类，0孤儿数据',
    '写库兜底+提示词强化：身份符号自动剥离，明确禁止把栏目标签/词性缩写当词头',
    '排序兜底：非拉丁/带符号词头不再排到 a 前',
  ]},
  { v: '2.16.3', date: '2026-11-18', items: [
    '修根因：云端任务不再产生"仅识别/0词"的僵尸批次，批次随入库同步更新为已入库并计入词数统计',
    '验收门禁：未验收任务产生的导入记录不再进入记录列表与统计，验收后才正式计入，避免错页数据污染',
    '回填历史：修正既有任务的批次状态、词数与批次关联',
  ]},
  { v: '2.16.2', date: '2026-11-18', items: [
    '任务清单逐页页码可手动修正：首字母页被误读成页码时，点页码填正确值，自动把该页词条精准迁移到新页码，不误伤同页其它词',
    '同步修正导入批次与跨页上下文的页码，修正记录留痕可追溯',
  ]},
  { v: '2.16.1', date: '2026-11-17', items: [
    '导入记录清单改为按页码倒序（大页码在前），最新扫描的页一眼可见',
  ]},
  { v: '2.16.0', date: '2026-11-17', items: [
    '云端任务队列：提交后浏览器可随时关闭/退后台，入库改由云端自动执行，回来随时看结果，不再依赖页面开着',
    '执行清单并入「记录」页：每个任务显示状态、进度条、每页识别词数与错误，逐页可展开核对，一目了然',
    '验收门禁：任务跑完停在「待验收」，点「确认验收」才归档；没验收的任务一直留在清单里，不会再出现起了不管、结果不明',
    '失败页可单独重试；任务按同步码隔离，换设备填同一个码就能看到同一批任务与结果',
  ]},
  { v: '2.15.0', date: '2026-11-17', items: [
    '恢复跨页握手池：修复清单对账改造后，跨页词被拆成两条的问题（如 access 在 P4/P5、accompany 在 P5/P6 各存一份）',
    '提示词强化：页尾词即使看起来完整也标 partial，页首延续词标 fragment_side，且不受"checkList 数量相等"铁律覆盖',
    '确定性兜底：扫描入库时若相邻页已有同词头且本页词无音标，自动判定为延续并合并义项，不依赖 AI 标记，彻底防拆词',
    '数据库梳理：合并了 access/accompany/acute/address 等 4 组历史跨页重复词，义项完整归位、词库恢复无重复',
  ]},
  { v: '2.14.0', date: '2026-11-17', items: [
    '新增「记录」页（与扫描/词库并列）：清单化管理每次导入，显示页码、词数、入库状态、时间，一目了然核对每页导得对不对',
    '分页管理：每页最多 20 条记录，支持翻页，最终几百页也不卡；顶部汇总导入批次、涉及页码、累计词条',
    '页码直达：输入页码一键跳到该页所有导入记录并高亮；点击任意记录展开该次导入的单词清单，点单词可跳词库核对',
    '修复长按操作条闪退：系统补发的右键菜单事件不再误把操作条收起；长按松手后三个按钮（已会/不会/进度）稳定停留',
    '修复长按偶发不触发：手指轻微抖动不再被当成滚动而取消长按，只有明显滑动才退出',
  ]},
  { v: '2.13.0', date: '2026-11-17', items: [
    '词库网状呈现：从已入库的派生/同义/反义/辨析关系自动构建词间关系网，不额外识别、不增加流量',
    '词卡底部新增关系区：派生、同义、同族、辨析、反义分类着色，库内词可点击直达，未收录词灰色标注',
    '点击关系词自动跳转：清除遮挡的搜索/筛选、滚动定位、展开词卡并高亮闪烁',
    '词库工具栏新增「书本列表 / 关系网」切换：关系网按词族聚簇布局，节点可拖动平移、滚轮缩放、点击查看词条',
  ]},
  { v: '2.12.0', date: '2026-11-17', items: [
    '解析逻辑重构：改为「先点名清单、再归位成树、逐条对账」——豆包图上看到的每个词头必须先进入清单，再落到词树，杜绝"看了没归位"导致的漏词',
    '大幅省流量：取消原来每页固定解析 2 次、偏少再补第 3 次的做法，改为单次主解析；仅当对账发现孤儿词时才定向补一次，6 页实测均 1 次调用完成',
    '清单对账：checkList 与 words 数量不一致时自动召回漏掉的孤儿词补建，并在回执里显示对账结果',
    '防脑补：词头必须图上真实存在，禁止按字母顺序把相邻页的词列进来',
  ]},
  { v: '2.11.0', date: '2026-11-17', items: [
    '修复重扫漏词：AI 视觉识别偶发不稳（同图 5 词/10 词波动），改为词数偏少时自动重试取最全结果',
    '重扫保护：若本次识别词数明显少于原有（<70%），拒绝覆盖并保留原数据，绝不再把整页词洗少',
  ]},
  { v: '2.10.0', date: '2026-11-17', items: [
    '修复长按体验：操作条出现后稳定停留，松手/上下滚动都不消失；仅点其他单词或再点该行才收起',
    '禁用长按选中文本，杜绝安卓系统自带的「复制/全选/翻译」弹框干扰',
    '新增会话状态记忆：切后台或切 App 再回来会自动恢复到离开时的页面、位置和筛选，减少重建感',
  ]},
  { v: '2.9.0', date: '2026-11-17', items: [
    '新增同步码：输入同步码进入，每人学习进度（已会/不会/进度）按码隔离保存，互不干扰',
    '超级码（现为 bigbao）可进入扫描页与设置页；普通同步码只能浏览词库与记录进度',
    '设置页新增同步码管理（仅超级码）：增删同步码、编辑备注、指定超级码',
    '修复多词性义项乱序：按词性归组、组内按序号排列，贴合原书版式（如 across 的 prep/adv）',
  ]},
  { v: '2.8.0', date: '2026-11-17', items: [
    '长按/右键单词改为行左滑：空出半行露出「已会 / 不会 / 进度」快捷按钮，移除意义不大的编辑框',
    '已会与不会互斥，点选即存云端；再点一次取消',
    '进度标签全局唯一（整本词库只有一个），标识当前学到哪里；设置新进度自动清除旧进度',
    'A-Z 侧边滑块在进度词所属字母上嵌入 📍 标记，点击该字母直达上次学习位置',
    '标签筛选条改为「全部 / 已会 / 不会 / 进度」新三态，彻底替换旧的不会/不熟/已掌握',
  ]},
  { v: '2.7.0', date: '2026-11-17', items: [
    '词库右侧新增 A-Z 索引滑块：上下拖动快速定位到对应字母的词条',
    '当前字母放大、左右邻字母按距离平滑缩放过渡，松手后自动淡出',
    '索引随搜索/标签过滤自动更新，无词字母自动就近跳转',
  ]},
  { v: '2.6.0', date: '2026-11-17', items: [
    '修复并列短语动词解析：act as / act on / act out 等各自独立成短语并保留中文释义',
    '短语例句按所属短语正确归位，不再全堆到最后一个短语下；括号同义短语（= act upon）存入注释',
    '修复短语释义被误当义项的问题；act as if 等普通例句不再误判为短语',
  ]},
  { v: '2.5.0', date: '2026-11-17', items: [
    '扫描页收敛为极简三步：拍摄框 → 已选列表 → 主按钮，去掉占据主流程的版本卡片',
    '版本更新日志移入「设置 → 版本记录」，可展开查看全部历史版本',
    '配色统一为蓝主色系：主按钮改蓝色渐变，去除装饰性红色/绿色/紫色，仅保留语义色（成功绿/失败红）',
    '「上次扫描进度」收窄为一行轻量提示，容器样式统一',
  ]},
  { v: '2.4.0', date: '2026-11-17', items: [
    '恢复「高考链接」蓝底框解析：作为标签框归入对应词条的 notes，不再整块跳过（ache/achievement 等可见）',
    '标签框展示改为通用：辨/注/同/反/句型/高考链接/常用词块等全部显示，新增标签无需改代码',
    '扫描列表每行新增入库回执：「新识别/已存在，本页XX个单词，已入库」，便于与书本比照',
  ]},
  { v: '2.3.0', date: '2026-11-17', items: [
    'UI 全面重设计：引用玻璃渐变淡蓝主题，令牌化配色与阴影',
    '桌面端新增左侧导航栏与多列词卡布局，手机端保留底部导航',
    '顶栏/搜索毛玻璃吸顶，触摸目标放大到 44px，补齐焦点环与安全区',
    '编辑弹框桌面居中、相机桌面窗口化，保留词库仿书本纸张质感',
  ]},
  { v: '2.2.2', date: '2026-11-17', items: [
    '修复漏词：AI 偶尔把多个单词嵌套进前一个词的结构里，导致只入库少数词；现自动打平提取全部词条',
    '实测第6页由 2 词恢复为 12 词，提示词同步强化「词条必须平级」',
  ]},
  { v: '2.2.1', date: '2026-11-17', items: [
    '新增「重扫此页」：已录入页漏词时用原页码重新识别并覆盖，不再误导改页码',
    '重扫先清该页旧词条再入库，页码不变、数据不错乱',
  ]},
  { v: '2.2.0', date: '2026-11-17', items: [
    '新增跨页「握手池」：残段常驻数据库，任意顺序/任意时间间隔录入都能自动补全',
    '先录后页再补前页：页首残段入池，前页录入后自动反向合并',
    '握手信息按「页码+头/尾」唯一存储，重复扫描不产生重复数据',
  ]},
  { v: '2.1.9', date: '2026-11-17', items: [
    '修复失败重试：网络超时实际已入库时自动纠正为成功，不再误报失败',
    '修复跨页词：重试/跳过失败页后，从数据库承接半截词并自动合并下一页',
  ]},
  { v: '2.1.8', date: '2026-11-17', items: [
    '修复重复解析：同一词重扫后词性带点/不带点生成两套义项，导致中文释义与例句重复',
    '词性归一合并义项，例句按英文去重，释义取更完整的一条',
  ]},
  { v: '2.1.7', date: '2026-11-17', items: [
    '版本卡片只显示当前版本，移除历史版本列表',
    '精简各页辅助说明文字，界面更清爽',
  ]},
  { v: '2.1.6', date: '2026-11-17', items: [
    '扫描页版本信息卡片移到页面最底部，顶部直接是拍摄/选图框',
  ]},
  { v: '2.1.5', date: '2026-11-17', items: [
    '修复词库 tab 角标位置：改为紧贴图标右上角，不再飘离',
  ]},
  { v: '2.1.4', date: '2026-11-17', items: [
    '页眉改为「维克多背单词」，只保留版本号',
    '滚动时页眉滑出、搜索框吸顶锁定，列表继续滚动',
  ]},
  { v: '2.1.3', date: '2026-11-17', items: [
    '搜索结果数改为分数形式（搜索数/总数），表头更简洁',
  ]},
  { v: '2.1.2', date: '2026-11-17', items: [
    '取消高考词频 Rⁿ 小标（识别不准且对背词意义不大）',
    '词库页排版压紧：字号缩小、间距收紧，一页显示更多单词',
    '表头精简：搜索框与统计合并一行，移除使用提示条',
  ]},
  { v: '2.1.1', date: '2026-11-17', items: [
    '移除词卡上的编辑笔按钮，统一用长按/右键编辑，界面更简洁',
  ]},
  { v: '2.1.0', date: '2026-11-17', items: [
    '录入重构：单页独立处理，失败可随时单独重试，不再卡全局',
    '浏览页改为仿书本单列排版，按 A–Z 无限滚动、自动预加载',
    '新增长按编辑：改音标/释义、打学习标签（不会/不熟/已掌握/自定义）',
    '新增标签彩色徽标与搜索框旁的标签快捷筛选',
  ]},
  { v: '2.0.0', date: '2026-11-17', items: [
    '按整书版式规则重写解析提示词，准确度大幅提升',
    '新增身份符号(课标外/增补/删减/派生)、高考词频Rⁿ识别',
    '新增义项级英文释义、义项深浅(常考/低频)标注',
    '新增「辨/注/同」标签框解析与展示',
    '▶派生词独立成词条并与母词建立关联',
  ]},
  { v: '1.8.0', date: '2026-11-16', items: [
    '首页只留一个「开始识别入库」按钮',
    '拍照改为可连续拍摄：拍完存队列、界面不退出，点完成才返回',
  ]},
  { v: '1.7.0', date: '2026-11-16', items: [
    '拍照/选图改为先存列表等待（最多15张），点按钮才统一提交解析',
  ]},
  { v: '1.6.0', date: '2026-11-16', items: [
    '新增「高考链接」真题方块自动跳过，不解析、不入库',
  ]},
  { v: '1.5.0', date: '2026-11-16', items: [
    '省流优化：上传前压缩图片、精简提示词、命中前缀缓存',
  ]},
  { v: '1.4.0', date: '2026-11-16', items: [
    '弹框简化为单个「开始」按钮',
    '识别页码后自动判断「前期已录入」并跳过，避免重复扫描',
  ]},
  { v: '1.3.0', date: '2026-11-16', items: [
    '进度缓存 + 网络重试，解决进度慢与 Failed to fetch 误报',
  ]},
  { v: '1.2.0', date: '2026-11-16', items: [
    '一键自动：识别页码→按序入库合并为一步',
    '业务表初始化，正式录入前数据清零',
  ]},
  { v: '1.1.0', date: '2026-11-16', items: [
    '页码改为从图片印刷页码识别入库（不再按拍照顺序累增）',
    '新增 detect-page 页码识别函数',
  ]},
  { v: '1.0.0', date: '2026-11-16', items: [
    '首版：拍照上传 → AI 扫描拆解入库 → 查询词库',
    '三层数据模型 words → senses → examples',
  ]},
];

function renderVersion() {
  const latest = CHANGELOG[0];
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  set('headerVersion', 'v' + latest.v);
  set('versionBadge', 'v' + latest.v);
  set('sideVersion', 'v' + latest.v);
  set('versionDate', latest.date + ' 更新');
  const latestBox = document.getElementById('versionLatest');
  if (latestBox) latestBox.innerHTML = latest.items.map(x => '<div class="vitem">• ' + esc(x) + '</div>').join('');
  // 设置页：历史版本列表（当前版本之外的全部记录）
  const histBox = document.getElementById('versionHistory');
  if (histBox) {
    histBox.innerHTML = CHANGELOG.slice(1).map(rel =>
      '<div class="vrel"><span class="vrel-v">v' + rel.v + '</span><span class="vrel-date">' + rel.date + '</span>' +
      '<div class="vrel-items">' + rel.items.map(x => '• ' + esc(x)).join('<br>') + '</div></div>'
    ).join('');
  }
}
function toggleChangelog() {
  const h = document.getElementById('versionHistory');
  const t = document.getElementById('versionToggle');
  if (!h) return;
  const open = h.classList.toggle('open');
  if (t) t.textContent = open ? '收起 ▴' : '历史版本 ▾';
}

let cfg = loadCfg();
let allWords = [];   // 当前词库列表
let lastMaxPage = 0;        // 上次扫描到的最大页码（权威来源：vw_scan_batches 表）
let expectedStartPage = null; // 弹框选的“接下来拍第几页”，仅作 AI 识别页码的软提示，绝不用于分配页码

/* ---------------- 配置 ---------------- */
function loadCfg() {
  try {
    return Object.assign(
      { url: 'https://gjtjivmxxelnousbqmok.supabase.co',
      key: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdqdGppdm14eGVsbm91c2JxbW9rIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODUzOTExOTAsImV4cCI6MjEwMDk2NzE5MH0.RjURzDQWye9V68YE9ngKejNmDrg-DQcFlwF_QbgFRsM',
      book: 'victor', demo: false },
      JSON.parse(localStorage.getItem(LS.cfg) || '{}')
    );
  } catch (e) { return { url: '', key: '', book: 'victor', demo: true }; }
}
function saveCfg() {
  localStorage.setItem(LS.cfg, JSON.stringify(cfg));
}
function saveSettings() {
  cfg.url  = document.getElementById('cfgUrl').value.trim().replace(/\/$/, '');
  cfg.key  = document.getElementById('cfgKey').value.trim();
  cfg.book = document.getElementById('cfgBook').value.trim() || 'victor';
  saveCfg();
  applyMode();
  setStatus('设置已保存', 'ok');
  toast('设置已保存');
  if (!cfg.demo) refreshWords();
  updateProgressDisplay();
}
function toggleDemo() {
  cfg.demo = !cfg.demo;
  document.getElementById('demoSwitch').classList.toggle('on', cfg.demo);
  saveCfg();
  applyMode();
  toast(cfg.demo ? '已切换到演示模式' : '已切换到在线模式');
  refreshWords();
  updateProgressDisplay();
}
function applyMode() {
  const badge = document.getElementById('modeBadge');
  if (badge) {
    badge.textContent = cfg.demo ? '演示模式' : '在线模式';
    badge.className = 'mode-badge' + (cfg.demo ? ' demo' : '');
  }
  const sub = document.getElementById('headerSub');
  if (sub) sub.textContent =
    cfg.demo ? '内置样例 · 数据存本机' : (cfg.url ? cfg.url.replace(/^https?:\/\//,'') : '未配置 Supabase');
  const hint = document.getElementById('scanHint');
  if (hint) hint.style.display = cfg.demo ? 'block' : 'none';
}
function setStatus(msg, type) {
  const el = document.getElementById('statusLine');
  el.textContent = msg;
  el.className = 'status-line' + (type ? ' ' + type : '');
}
async function testConnection() {
  // 先把输入框里的值读进来（即使未点保存也能测试）
  cfg.url  = document.getElementById('cfgUrl').value.trim().replace(/\/$/, '');
  cfg.key  = document.getElementById('cfgKey').value.trim();
  cfg.book = document.getElementById('cfgBook').value.trim() || 'victor';
  if (!cfg.url || !cfg.key) { setStatus('请先填写 URL 和 anon key', 'err'); return; }
  setStatus('正在连接…', '');
  try {
    const r = await fetch(`${cfg.url}/rest/v1/vw_books?select=id&limit=1`, {
      headers: { apikey: cfg.key, Authorization: `Bearer ${cfg.key}` }
    });
    if (r.ok) { setStatus('连接成功 ✓ 可切换到在线模式', 'ok'); applyMode(); }
    else {
      const t = await r.text();
      setStatus(`连接失败 ${r.status}：${t.slice(0,120)}`, 'err');
    }
  } catch (e) { setStatus('网络错误：' + e.message, 'err'); }
}

/* ============================================================
 * 会话状态持久化：WebView 切后台被回收重进时，尽量还原现场
 * 存 sessionStorage（标签页级），只记录轻量 UI 状态，不碰数据本身
 * ============================================================ */
const SS_UI = 'vocab_ui_session';
function saveUiState(opts) {
  opts = opts || {};
  try {
    const active = document.querySelector('.page.active');
    const prev = loadUiState();
    // 卸载钩子(unload)里 DOM 与滚动已进入过渡态不可信：page 沿用上次记录，仅更新数据字段
    const page = opts.unload
      ? (prev.page || 'words')
      : (active ? active.id.replace(/^page-/, '') : 'words');
    const qEl = document.getElementById('searchInput');
    sessionStorage.setItem(SS_UI, JSON.stringify({
      page,
      scrollY: opts.unload
        ? (prev.scrollY || 0)
        : Math.round(window.scrollY || window.pageYOffset || 0),
      activeTag,
      q: qEl ? qEl.value : (prev.q || ''),
      ts: Date.now(),
    }));
  } catch (e) {}
}
function loadUiState() {
  try { return JSON.parse(sessionStorage.getItem(SS_UI) || '{}'); } catch (e) { return {}; }
}
// 滚动时节流保存（仅词库页，避免滚动位置被其它页面覆盖）
let _scrollSaveTimer = null;
window.addEventListener('scroll', () => {
  if (!document.getElementById('page-words').classList.contains('active')) return;
  clearTimeout(_scrollSaveTimer);
  _scrollSaveTimer = setTimeout(saveUiState, 250);
}, { passive: true });
// 页面被隐藏/卸载前兜底保存（切后台、切 App）：只更新数据字段，不覆盖页面与滚动
window.addEventListener('pagehide', () => saveUiState({ unload: true }));
document.addEventListener('visibilitychange', () => { if (document.hidden) saveUiState({ unload: true }); });

/* ---------------- 导航（同步码门禁） ---------------- */
function switchPage(name) {
  // 普通同步码只能进词库页；扫描/设置页对普通码隐藏
  if (!isSuper() && (name === 'scan' || name === 'settings')) {
    toast('当前同步码无权访问该页面');
    name = 'words';
  }
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById('page-' + name).classList.add('active');
  document.querySelectorAll('nav button').forEach(b =>
    b.classList.toggle('active', b.dataset.page === name));
  updateAzVisibility();
  if (name === 'words') resetWordList();
  if (name === 'records') { loadRecords(); loadJobs(); }
  saveUiState();
}

/* ============================================================
 * 同步码门禁 + 管理
 *  - 普通码：仅词库页；超级码：全部页面 + 同步码管理
 *  - 演示模式跳过云端校验，本地用内置码
 * ============================================================ */
const SYNC_HEADERS = () => ({ apikey: cfg.key, Authorization: `Bearer ${cfg.key}` });

// 应用门禁：隐藏/显示扫描、设置导航；刷新页眉徽标
function applyGating() {
  const sup = isSuper();
  // 导航按钮（底栏 + 侧栏）—— 用 data-page 精确匹配，不误伤其它按钮
  document.querySelectorAll('.bottom-nav button[data-page], .side-nav button[data-page]').forEach(b => {
    const restricted = (b.dataset.page === 'scan' || b.dataset.page === 'settings');
    b.classList.toggle('hidden-soft', restricted && !sup);
  });
  // 页眉/侧栏同步码徽标
  const code = sync ? sync.code : '未设置';
  const set = (id, txt, superCls) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = txt;
    if (superCls !== undefined) el.classList.toggle('super', superCls);
  };
  set('syncChip', (sup ? '★' : '') + code, sup);
  set('sideSyncCode', code);
  // 设置页同步码管理区仅超级码可见
  const cm = document.getElementById('codeManage');
  if (cm) cm.classList.toggle('hidden-soft', !sup);
  // 若当前停在受限页，退回词库
  const active = document.querySelector('.page.active');
  if (!sup && active && (active.id === 'page-scan' || active.id === 'page-settings')) switchPage('words');
}

// 打开门禁弹框（switching=true 表示切换码，允许取消）
let _syncSwitching = false;
function openSyncGate(switching) {
  _syncSwitching = !!switching;
  const gate = document.getElementById('syncGate');
  const cancel = document.getElementById('syncGateCancel');
  const hint = document.getElementById('syncGateHint');
  document.getElementById('syncErr').textContent = '';
  document.getElementById('syncInput').value = '';
  document.getElementById('syncGateTitle').textContent = switching ? '切换同步码' : '输入同步码';
  document.getElementById('syncGateDesc').textContent = switching
    ? '输入新的同步码，切换到对应词库与学习进度。'
    : '输入你的同步码，进入属于你的词库与学习进度。';
  if (cancel) cancel.classList.toggle('hidden-soft', !switching);
  if (hint) hint.classList.toggle('hidden-soft', !!switching);
  gate.classList.add('show');
  setTimeout(() => { try { document.getElementById('syncInput').focus(); } catch (e) {} }, 50);
}
function closeSyncGate() {
  // 首次进入未设置同步码时不允许关闭
  if (!sync && !_syncSwitching) return;
  document.getElementById('syncGate').classList.remove('show');
}

// 提交同步码：校验存在 → 记住 → 应用门禁 → 重新加载该码的学习状态
async function submitSyncCode() {
  const inp = document.getElementById('syncInput');
  const code = (inp.value || '').trim();
  const errEl = document.getElementById('syncErr');
  const btn = document.getElementById('syncGateBtn');
  if (!code) { errEl.textContent = '请输入同步码'; return; }
  if (btn) { btn.disabled = true; btn.textContent = '校验中…'; }
  try {
    let rec = null;
    if (cfg.demo) {
      // 演示模式：任意码可用，SUPER_CODE(bigbao) 为超级码
      rec = { code, note: '演示', is_super: code === SUPER_CODE };
    } else {
      if (!cfg.url || !cfg.key) throw new Error('未配置 Supabase');
      const r = await fetchWithRetry(
        `${cfg.url}/rest/v1/vw_sync_codes?select=code,note,is_super&code=eq.${encodeURIComponent(code)}`,
        { headers: SYNC_HEADERS() }, { timeout: 12000, retries: 1, label: '校验同步码' });
      if (!r.ok) throw new Error('校验失败 ' + r.status);
      const rows = await r.json();
      rec = rows[0] || null;
    }
    if (!rec) { errEl.textContent = '同步码不存在，请检查后重试'; return; }
    sync = { code: rec.code, note: rec.note || '', isSuper: !!(rec.is_super || rec.code === SUPER_CODE) };
    saveSync(sync);
    document.getElementById('syncGate').classList.remove('show');
    applyGating();
    await refreshWords();          // 按新码加载学习状态
    if (isSuper()) loadSyncCodeList();
    toast(`已进入同步码 ${code}${sync.isSuper ? '（超级码）' : ''}`);
  } catch (e) {
    errEl.textContent = '校验出错：' + e.message;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '进入'; }
  }
}

// 读取当前码的学习状态：vw_user_states -> 写入各 word.tags
async function loadUserStates() {
  if (!sync) { allWords.forEach(w => w.tags = []); return; }
  if (cfg.demo) {
    // 演示模式：学习状态存本地 LS，按码隔离
    let map = {};
    try { map = JSON.parse(localStorage.getItem('vocab_user_states_' + sync.code) || '{}'); } catch (e) {}
    allWords.forEach(w => {
      const key = w.id != null ? String(w.id) : w.headword;
      w.tags = Array.isArray(map[key]) ? map[key] : [];
    });
    return;
  }
  if (!cfg.url || !cfg.key) { allWords.forEach(w => w.tags = []); return; }
  const r = await fetchWithRetry(
    `${cfg.url}/rest/v1/vw_user_states?select=word_id,tags&code=eq.${encodeURIComponent(sync.code)}`,
    { headers: SYNC_HEADERS() }, { timeout: 15000, retries: 1, label: '加载学习状态' });
  let map = {};
  if (r.ok) {
    (await r.json()).forEach(x => { map[x.word_id] = Array.isArray(x.tags) ? x.tags : []; });
  }
  allWords.forEach(w => { w.tags = map[w.id] || []; });
}

// 同步码管理列表（仅超级码）
async function loadSyncCodeList() {
  if (!isSuper()) return;
  const host = document.getElementById('codeList');
  if (!host) return;
  let rows = [];
  if (cfg.demo) {
    rows = [{ code: SUPER_CODE, note: '超级码（演示）', is_super: true }];
  } else {
    const r = await fetchWithRetry(
      `${cfg.url}/rest/v1/vw_sync_codes?select=code,note,is_super&order=is_super.desc,code`,
      { headers: SYNC_HEADERS() }, { timeout: 12000, retries: 1, label: '加载同步码' });
    if (r.ok) rows = await r.json();
  }
  host.innerHTML = rows.map(c => {
    const me = sync && c.code === sync.code;
    const badges = (c.is_super || c.code === SUPER_CODE ? '<span class="code-super">超级</span>' : '') +
                   (me ? '<span class="code-me">当前</span>' : '');
    const del = (c.code === SUPER_CODE)
      ? '' : `<button class="code-del" title="删除" onclick="deleteSyncCode('${esc(c.code)}')">×</button>`;
    return `<div class="code-row">
      <span class="code-val">${esc(c.code)}</span>
      <input class="code-note" value="${esc(c.note || '')}" placeholder="备注"
        onchange="updateSyncNote('${esc(c.code)}',this.value)" style="border:1px solid var(--line);border-radius:7px;padding:5px 8px;font-size:12px;font-family:inherit;min-width:0">
      ${badges}${del}</div>`;
  }).join('') || '<div class="code-desc">暂无同步码</div>';
}

function setCodeStatus(msg, type) {
  const el = document.getElementById('codeStatus');
  if (!el) return;
  el.textContent = msg;
  el.className = 'status-line' + (type ? ' ' + type : '');
}
async function addSyncCode() {
  const codeEl = document.getElementById('newCode');
  const noteEl = document.getElementById('newCodeNote');
  const superEl = document.getElementById('newCodeSuper');
  const code = (codeEl.value || '').trim();
  const note = (noteEl.value || '').trim();
  const sup = !!superEl.checked;
  if (!code) { setCodeStatus('请输入同步码', 'err'); return; }
  if (code === SUPER_CODE) { setCodeStatus('该码为内置超级码，无需添加', 'err'); return; }
  try {
    if (cfg.demo) { setCodeStatus('演示模式下不保存同步码', 'ok'); }
    else {
      const r = await fetchWithRetry(`${cfg.url}/rest/v1/vw_sync_codes`,
        { method: 'POST', headers: { ...SYNC_HEADERS(), 'Content-Type': 'application/json', Prefer: 'return=minimal' },
          body: JSON.stringify({ code, note, is_super: sup }) },
        { timeout: 12000, retries: 1, label: '添加同步码' });
      if (!r.ok) {
        const t = await r.text();
        throw new Error(r.status === 409 ? '同步码已存在' : ('添加失败 ' + r.status + ' ' + t.slice(0, 60)));
      }
    }
    codeEl.value = ''; noteEl.value = ''; superEl.checked = false;
    setCodeStatus('已添加同步码 ' + code, 'ok');
    loadSyncCodeList();
  } catch (e) { setCodeStatus(e.message, 'err'); }
}
async function updateSyncNote(code, note) {
  if (cfg.demo) return;
  try {
    const r = await fetchWithRetry(`${cfg.url}/rest/v1/vw_sync_codes?code=eq.${encodeURIComponent(code)}`,
      { method: 'PATCH', headers: { ...SYNC_HEADERS(), 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify({ note: note || '' }) },
      { timeout: 12000, retries: 1, label: '保存备注' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    setCodeStatus('备注已更新', 'ok');
  } catch (e) { setCodeStatus('备注保存失败：' + e.message, 'err'); }
}
async function deleteSyncCode(code) {
  if (code === SUPER_CODE) { setCodeStatus('超级码不可删除', 'err'); return; }
  if (sync && sync.code === code) { setCodeStatus('不能删除当前正在使用的同步码', 'err'); return; }
  if (!confirm('确定删除同步码 ' + code + ' 及其全部学习进度？此操作不可恢复。')) return;
  try {
    if (!cfg.demo) {
      // 先删该码的学习状态（外键也有 cascade，这里显式删除更稳妥）
      await fetchWithRetry(`${cfg.url}/rest/v1/vw_user_states?code=eq.${encodeURIComponent(code)}`,
        { method: 'DELETE', headers: SYNC_HEADERS() },
        { timeout: 12000, retries: 1, label: '删除学习状态' });
      const r = await fetchWithRetry(`${cfg.url}/rest/v1/vw_sync_codes?code=eq.${encodeURIComponent(code)}`,
        { method: 'DELETE', headers: SYNC_HEADERS() },
        { timeout: 12000, retries: 1, label: '删除同步码' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
    }
    setCodeStatus('已删除同步码 ' + code, 'ok');
    loadSyncCodeList();
  } catch (e) { setCodeStatus('删除失败：' + e.message, 'err'); }
}
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._t);
  t._t = setTimeout(() => t.classList.remove('show'), 3000);
}

/* ---------------- 网络请求：超时 + 自动重试 ---------------- */
// 手机网络下长时间请求易被中断（表现为 "Failed to fetch"）。
// 统一封装：每次请求带超时，网络类错误自动重试，最终失败给出可读中文提示。
async function fetchWithRetry(url, opts = {}, { timeout = 25000, retries = 2, label = '网络请求' } = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), timeout) : null;
    try {
      const r = await fetch(url, { ...opts, ...(ctrl ? { signal: ctrl.signal } : {}) });
      if (timer) clearTimeout(timer);
      return r;   // 拿到 HTTP 响应即返回（4xx/5xx 由调用方判断）
    } catch (e) {
      if (timer) clearTimeout(timer);
      lastErr = e;
      const isAbort = e && e.name === 'AbortError';
      // 网络层错误（Failed to fetch / 超时）才重试；主动中断不重试
      const retryable = !isAbort && /failed to fetch|network|load failed|timeout/i.test(String(e && e.message || e));
      if (attempt < retries && retryable) {
        await new Promise(res => setTimeout(res, 700 * (attempt + 1)));
        continue;
      }
      throw new Error(`${label}失败：${isAbort ? '请求超时，请检查网络' : (e && e.message || '网络连接中断')}`);
    }
  }
  throw new Error(`${label}失败：${lastErr && lastErr.message || '网络连接中断'}`);
}

/* ---------------- 扫描进度记忆（最大页码） ---------------- */
// 本地进度（按 book 区分），作为数据库查询失败时的兜底
function loadLocalProgress() {
  try {
    const all = JSON.parse(localStorage.getItem(LS.progress) || '{}');
    return all[cfg.book] || 0;
  } catch (e) { return 0; }
}
function saveLocalProgress(pageNo) {
  if (!pageNo || pageNo <= 0) return;
  try {
    const all = JSON.parse(localStorage.getItem(LS.progress) || '{}');
    all[cfg.book] = Math.max(all[cfg.book] || 0, pageNo);
    localStorage.setItem(LS.progress, JSON.stringify(all));
  } catch (e) {}
  lastMaxPage = Math.max(lastMaxPage, pageNo);
}
// 从「存储每页页码的表」vw_scan_batches 读取真实最大页码（权威来源，唯一依据）
// 会话内缓存：同一本书只查一次，避免页面初始化 + 每次点拍照都重复请求（进度慢的根因）
let _progressCache = { key: null, value: 0 };
async function fetchLastMaxPage(force = false) {
  const cacheKey = `${cfg.url}|${cfg.book}|${cfg.demo}`;
  if (!force && _progressCache.key === cacheKey) {
    lastMaxPage = _progressCache.value;
    return lastMaxPage;
  }
  if (cfg.demo || !cfg.url || !cfg.key) {
    lastMaxPage = 0; _progressCache = { key: cacheKey, value: 0 };
    return 0;
  }
  try {
    const r = await fetchWithRetry(
      `${cfg.url}/rest/v1/vw_scan_batches?book_id=eq.${encodeURIComponent(cfg.book)}&select=page_no&order=page_no.desc&limit=1`,
      { headers: { apikey: cfg.key, Authorization: `Bearer ${cfg.key}` } },
      { timeout: 12000, retries: 1, label: '读取扫描进度' }
    );
    if (r.ok) {
      const rows = await r.json();
      lastMaxPage = rows.length ? (rows[0].page_no || 0) : 0;
      _progressCache = { key: cacheKey, value: lastMaxPage };
      return lastMaxPage;
    }
  } catch (e) { console.warn(e.message); }
  // 查询失败也不能卡住弹框：返回上次已知值或 0
  return (_progressCache.key === cacheKey ? _progressCache.value : 0);
}
/* ---------------- 已录入页码查询（用于「前期已录入」标注与跳过） ---------------- */
// 以词表 vw_words 的 page_no 为准：该页存在词条即视为「前期已录入」
let _recordedCache = { key: null, set: null };
let _pageCountCache = new Map();   // page_no -> 该页词条数（供扫描行「本页XX个单词」回执用）
function getPageWordCount(pageNo) { return _pageCountCache.get(pageNo) || 0; }
async function fetchRecordedPages(force = false) {
  const cacheKey = `${cfg.url}|${cfg.book}|${cfg.demo}`;
  if (!force && _recordedCache.key === cacheKey && _recordedCache.set) return _recordedCache.set;
  if (cfg.demo) {
    let stored = [];
    try { stored = JSON.parse(localStorage.getItem(LS.demo) || '[]'); } catch (e) {}
    const set = new Set(stored.map(w => w.page_no).filter(n => n > 0));
    _pageCountCache = new Map();
    stored.forEach(w => { if (w.page_no > 0) _pageCountCache.set(w.page_no, (_pageCountCache.get(w.page_no) || 0) + 1); });
    _recordedCache = { key: cacheKey, set };
    return set;
  }
  if (!cfg.url || !cfg.key) {
    _recordedCache = { key: cacheKey, set: new Set() };
    return _recordedCache.set;
  }
  try {
    const r = await fetchWithRetry(
      `${cfg.url}/rest/v1/vw_words?book_id=eq.${encodeURIComponent(cfg.book)}&select=page_no`,
      { headers: { apikey: cfg.key, Authorization: `Bearer ${cfg.key}` } },
      { timeout: 15000, retries: 1, label: '查询已录入页码' }
    );
    if (r.ok) {
      const rows = await r.json();
      const set = new Set(rows.map(x => x.page_no).filter(n => n > 0));
      _pageCountCache = new Map();
      rows.forEach(x => { if (x.page_no > 0) _pageCountCache.set(x.page_no, (_pageCountCache.get(x.page_no) || 0) + 1); });
      _recordedCache = { key: cacheKey, set };
      return set;
    }
  } catch (e) { console.warn(e.message); }
  _recordedCache = { key: cacheKey, set: new Set() };
  return _recordedCache.set;
}
// 识别完页码后，给每张图标注「该页前期是否已录入」
async function markRecordedPages() {
  const recorded = await fetchRecordedPages();
  batchQueue.forEach(it => {
    it.recorded = it.pageNo > 0 && recorded.has(it.pageNo);
  });
}
// 入库成功后让缓存失效，下次读取会拉到最新页码 / 最新已录入集合
function invalidateProgressCache() { _progressCache.key = null; _recordedCache.key = null; }

// 假失败复查：网络超时/中断时，服务端可能已把词条写入再回传响应失败。
// 这里强制查一次词库该页是否已有词条，有则判定"其实已成功入库"。
async function isPageActuallyRecorded(pageNo) {
  if (!(pageNo > 0) || cfg.demo || !cfg.url || !cfg.key) return false;
  try {
    const r = await fetchWithRetry(
      `${cfg.url}/rest/v1/vw_words?book_id=eq.${encodeURIComponent(cfg.book)}&page_no=eq.${pageNo}&select=id&limit=1`,
      { headers: { apikey: cfg.key, Authorization: `Bearer ${cfg.key}` } },
      { timeout: 12000, retries: 1, label: '复查该页入库状态' }
    );
    if (!r.ok) return false;
    const data = await r.json();
    invalidateProgressCache();   // 允许下次 markRecordedPages 拿到最新集合
    return Array.isArray(data) && data.length > 0;
  } catch (e) { return false; }
}

// 从「握手池」读取某页页尾的 pending 残段，构造跨页上下文。
// 残段常驻 vw_page_handshakes，不依赖内存 nextContext，
// 因此即使上一页是很久前录的、失败重试补录的、中间隔了很多页，下一页仍能拿到半截词信息。
// （后端 scan-page 也会主动查同一张池表，这里传参是双保险。）
async function loadPageContext(pageNo) {
  if (!(pageNo > 0) || cfg.demo || !cfg.url || !cfg.key) return null;
  try {
    const r = await fetchWithRetry(
      `${cfg.url}/rest/v1/vw_page_handshakes?book_id=eq.${encodeURIComponent(cfg.book)}`
        + `&page_no=eq.${pageNo}&side=eq.tail&status=eq.pending`
        + `&select=page_no,headword,payload&order=id.desc`,
      { headers: { apikey: cfg.key, Authorization: `Bearer ${cfg.key}` } },
      { timeout: 12000, retries: 1, label: '读取跨页握手池' }
    );
    if (!r.ok) return null;
    const rows = await r.json();
    if (!Array.isArray(rows) || !rows.length) return null;
    const partial_words = rows
      .filter(x => x.headword)
      .map(x => ({ headword: x.headword, senses: Array.isArray(x.payload) ? x.payload : [] }));
    if (!partial_words.length) return null;
    return { page_no: pageNo, partial_words };
  } catch (e) { return null; }
}

// 重试某页成功后，若它产生页尾半截词、且下一页已在本次队列中，
// 自动用本页上下文重新解析下一页一次，把跨页词合并成一条（带防循环标志，不递归向下）。
let _repairingNext = false;
async function autoRepairNextPage(item, result) {
  if (_repairingNext || !result) return;
  const partials = result.partial_words || [];
  if (!partials.length || !(item.pageNo > 0)) return;
  const nextNo = item.pageNo + 1;
  const nextItem = batchQueue.find(x => x !== item && x.pageNo === nextNo);
  if (!nextItem) return;   // 下一页不在队列，无法自动补全；残段已在握手池，日后录入会自动合并
  if (nextItem.status === 'done' && !nextItem.error) return;  // 下一页已成功入库，幂等跳过（后端已按池合并）
  _repairingNext = true;
  try {
    const ctx = result.nextContext || { page_no: item.pageNo, partial_words: partials };
    await parseOnePage(nextItem, nextNo, ctx, batchQueue.indexOf(nextItem));
    invalidateProgressCache();
    toast(`第 ${item.pageNo} 页跨页词「${partials.join('、')}」已自动并入第 ${nextNo} 页`);
  } catch (e) {
    toast(`第 ${item.pageNo} 页跨页词未能自动合并，可重扫第 ${nextNo} 页：${e.message}`);
  } finally {
    _repairingNext = false;
  }
}
// 刷新扫描页常驻进度条
function updateProgressDisplay() {
  fetchLastMaxPage().then(() => {
    const el = document.getElementById('lastProgress');
    if (el) el.textContent = lastMaxPage > 0
      ? `📖 上次扫描到第 ${lastMaxPage} 页` : '📖 尚无扫描记录，将从第 1 页开始';
  });
}

/* ---------------- 扫描进度提示弹框 ---------------- */
let scanPromptSource = 'camera';   // 'camera' | 'file'

// 拍照/选图前先弹进度提示
async function openScanPrompt(source) {
  scanPromptSource = source;
  const mask = document.getElementById('scanPrompt');
  mask.classList.add('show');
  document.getElementById('spTitle').textContent = '读取扫描进度…';
  document.getElementById('spDesc').textContent = '正在查询上次扫描到的页码';
  document.getElementById('spChoices').innerHTML = '';
  const n = await fetchLastMaxPage();
  renderScanPrompt(n);
}
function renderScanPrompt(n) {
  const maxPage = n > 0 ? n : 0;
  const title = document.getElementById('spTitle');
  const desc = document.getElementById('spDesc');
  const choices = document.getElementById('spChoices');
  if (maxPage > 0) {
    title.innerHTML = `上次扫描到<span class="modal-highlight">第 ${maxPage} 页</span>`;
    desc.innerHTML = '选择或拍照上传后，页码会以每页<strong>实际印刷的页码</strong>为准自动识别；已录入过的页码会在清单里标注「前期已录入」并自动跳过。';
  } else {
    title.textContent = '开始第一次扫描';
    desc.innerHTML = '选择或拍照上传后，页码会从每页自动识别，识别后可在缩略图上校正。';
  }
  // 只有一个「开始」按钮：点击后进入选图/拍照，页码一律从图片识别，不再做页码选择
  choices.innerHTML = `
    <div class="modal-choice primary" onclick="proceedScan()">
      <span class="ci">▶️</span><span><b>开始</b><small>${scanPromptSource === 'camera' ? '进入相机，可连续拍多张后一起提交' : '从相册选多张图片，一起提交'}</small></span>
    </div>`;
}
function closeScanPrompt() {
  document.getElementById('scanPrompt').classList.remove('show');
}
function proceedScan() {
  closeScanPrompt();
  // 页码一律从图片上识别，不再用「上次页码」做软提示
  expectedStartPage = null;
  setTimeout(() => {
    if (scanPromptSource === 'camera') {
      openCamera();          // 自定义相机：可持续连拍，拍完不退出
    } else {
      document.getElementById('fileInput').click();   // 相册多选
    }
  }, 100);
}

/* ---------------- 自定义相机（连续拍照） ---------------- */
let camStream = null;      // 当前摄像头 MediaStream
let camShots = 0;          // 本次打开相机已拍张数

// 打开相机：持续取景，点快门抓帧入队，界面不退出，可连拍；点「完成」才关闭。
async function openCamera() {
  const modal = document.getElementById('cameraModal');
  const video = document.getElementById('camVideo');
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    // 不支持 getUserMedia（如非安全上下文），回退到系统相机
    toast('当前环境不支持连续拍照，已切换到系统相机');
    document.getElementById('cameraInput').click();
    return;
  }
  modal.classList.add('show');
  updateCamCount();
  try {
    camStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false,
    });
    video.srcObject = camStream;
    await video.play();
    document.getElementById('camStatus').textContent = '对准页面，点快门拍照；可连续拍';
  } catch (e) {
    // 权限拒绝/无摄像头：回退系统相机
    modal.classList.remove('show');
    toast('无法打开连续拍照，已切换到系统相机');
    document.getElementById('cameraInput').click();
  }
}

// 快门：从 video 抓一帧 → canvas → JPEG File → 入队（静默），界面保持打开
function snapPhoto() {
  const video = document.getElementById('camVideo');
  if (!video || !video.videoWidth) { toast('相机画面还没准备好'); return; }
  if (batchQueue.length >= MAX_BATCH) {
    toast(`最多只能排队 ${MAX_BATCH} 张，请点「完成」后提交`);
    return;
  }
  const canvas = document.createElement('canvas');
  // 长边限制 1920，与上传压缩一致，省 token
  const maxSide = 1920;
  const scale = Math.min(1, maxSide / Math.max(video.videoWidth, video.videoHeight));
  canvas.width = Math.round(video.videoWidth * scale);
  canvas.height = Math.round(video.videoHeight * scale);
  canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
  canvas.toBlob(blob => {
    if (!blob) { toast('拍照失败，请重试'); return; }
    const file = new File([blob], `camera_${Date.now()}_${camShots + 1}.jpg`, { type: 'image/jpeg' });
    const n = enqueueFiles([file], { silent: true });
    if (n > 0) {
      camShots += n;
      updateCamCount();
      flashShutter();           // 快门视觉反馈
      toast(`已存入第 ${camShots} 张，可继续拍`);
    }
  }, 'image/jpeg', 0.82);
}

function updateCamCount() {
  const el = document.getElementById('camCount');
  if (el) el.textContent = `本次已拍 ${camShots} 张 · 队列 ${batchQueue.length}/${MAX_BATCH}`;
}

function flashShutter() {
  const f = document.getElementById('camFlash');
  if (!f) return;
  f.classList.remove('flash');
  void f.offsetWidth;           // 触发重排以重启动画
  f.classList.add('flash');
}

// 完成：停止摄像头、关闭界面，回到主页（照片已在队列里）
function closeCamera() {
  const modal = document.getElementById('cameraModal');
  if (camStream) {
    camStream.getTracks().forEach(t => t.stop());
    camStream = null;
  }
  const video = document.getElementById('camVideo');
  if (video) video.srcObject = null;
  modal.classList.remove('show');
  camShots = 0;
  if (batchQueue.length) {
    toast(`共拍 ${batchQueue.length} 张已存列表，点「开始识别并入库」统一提交`);
  }
}

/* ---------------- 批量扫描 ---------------- */
const MAX_BATCH = 15;      // 一次最多排队 15 张
let batchQueue = [];   // [{id, file, thumb, status, result, error, pageNo, recorded}]
let batchRunning = false;

const fileInput = document.getElementById('fileInput');
const cameraInput = document.getElementById('cameraInput');
fileInput.addEventListener('change', e => addFiles(e.target.files));
cameraInput.addEventListener('change', e => addFiles(e.target.files));

// 把文件对象放进队列的核心逻辑；返回实际入队数量。
// opts.silent=true 时不弹 toast（连拍时由相机界面自己提示）。
function enqueueFiles(fileList, opts = {}) {
  const files = Array.from(fileList || []).filter(f => f.type.startsWith('image/'));
  if (!files.length) return 0;
  const room = MAX_BATCH - batchQueue.length;
  if (room <= 0) {
    if (!opts.silent) toast(`最多只能排队 ${MAX_BATCH} 张，请先提交或清空当前列表`);
    return 0;
  }
  const accepted = files.slice(0, room);   // 超出上限的部分丢弃
  for (const f of accepted) {
    batchQueue.push({
      id: 'q' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
      file: f,
      thumb: URL.createObjectURL(f),
      status: 'pending',
      result: null,
      error: null,
      pageNo: 0,        // 不猜、不累增；由 AI 从图片上识别真实印刷页码
      imageUrl: null,
      imagePath: null,
      batchId: null,
    });
  }
  document.getElementById('resultCard').classList.remove('show');
  renderBatch();
  const dropped = files.length - accepted.length;
  if (!opts.silent) {
    toast(`已保存 ${accepted.length} 张到列表${dropped ? `（超出上限，忽略 ${dropped} 张）` : ''}，点下方按钮一起提交`);
  }
  return accepted.length;
}

function addFiles(fileList) {
  const n = enqueueFiles(fileList);
  // 选图路径只存列表等待，不自动解析；由用户点「开始识别并入库」统一提交
  fileInput.value = '';
  cameraInput.value = '';
  return n;
}

// 页码输入框变更
function setPageNo(id, val) {
  const item = batchQueue.find(x => x.id === id);
  if (!item || item.running) return;
  const old = item.pageNo;
  item.pageNo = Math.max(0, parseInt(val, 10) || 0);
  // 页码被手动改动后，旧的「已录入」判断失效，需重新评估
  if (item.pageNo !== old) item.recorded = false;
  renderBatch();
}

function renderBatch() {
  const list = document.getElementById('batchList');
  const head = document.getElementById('batchHead');
  const actions = document.getElementById('batchActions');
  if (!batchQueue.length) {
    list.innerHTML = '';
    head.style.display = 'none';
    actions.style.display = 'none';
    return;
  }
  head.style.display = 'flex';
  document.getElementById('batchCount').textContent = `已选 ${batchQueue.length} 页`;
  actions.style.display = 'flex';
  const statusText = {
    pending: '待处理', uploading: '上传中…',
    detecting: '<span class="mini-spinner"></span> AI 识别页码中…',
    detected: '✓ 页码已识别', parsing: '<span class="mini-spinner"></span> AI 解析中…',
    done: '✓ 完成', error: '✗ 失败', retrying: '<span class="mini-spinner"></span> 重试中…',
    recorded: '◷ 前期已录入（跳过）',
  };
  list.innerHTML = batchQueue.map((it, i) => {
    const running = !!it.running;
    // 扫描回执：每页一行明确写「新识别/已存在，本页XX个单词，已入库」，方便与书本比照
    const pageWordCount = it.pageNo > 0 ? getPageWordCount(it.pageNo) : 0;
    // 前期已录入优先显示，不再走普通解析状态（带自定义 note 的完成项除外，用 note 说明）
    const hasNote = it.status === 'done' && it.result && it.result.note;
    const isRecorded = it.recorded && it.pageNo > 0 && it.status !== 'error' && !hasNote;
    const st = isRecorded ? statusText.recorded : (statusText[it.status] || it.status);
    let extra = '';
    if (hasNote) {
      extra = `<div class="boundary-note recorded">✅ ${esc(it.result.note)}</div>`;
    } else if (isRecorded) {
      extra = `<div class="boundary-note recorded">◷ 已存在，本页 ${pageWordCount} 个单词，已入库（第 ${it.pageNo} 页本次跳过；漏词可点右侧「重扫」覆盖）</div>`;
    } else if (it.status === 'detected' && it.pageNo > 0) {
      extra = `<div class="boundary-note">📖 从图片识别到第 ${it.pageNo} 页，可点左侧页码校正</div>`;
    }
    if (it.error && it.status === 'error') {
      extra += `<div class="boundary-note partial">${esc(it.error)}</div>`;
    }
    if (it.status === 'done' && it.result && !hasNote) {
      const doneCount = it.result.words_found != null ? it.result.words_found : pageWordCount;
      extra = `<div class="boundary-note done">✅ 新识别，本页 ${doneCount} 个单词，已入库${it.result.examples_found ? `（含 ${it.result.examples_found} 例句）` : ''}</div>`;
      if (it.result.resumed_words) {
        extra += `<div class="boundary-note">🔗 补全上一页半截词 ${it.result.resumed_words} 个</div>`;
      }
      const pw = it.result.partial_words || [];
      if (pw.length) {
        extra += `<div class="boundary-note partial">⏳ 页尾半截词「${pw.map(esc).join('、')}」已暂存，下页自动补全</div>`;
      }
    }
    const statusCls = isRecorded ? 'recorded' : (it.status === 'error' ? 'error' : it.status);
    const pageVal = it.pageNo || '';
    const pgInput = running
      ? `<span class="pg-tag">P${it.pageNo || '?'}</span>`
      : `<span class="pg-wrap">P<input class="pg-input" type="number" min="0" value="${pageVal}" placeholder="页码" onchange="setPageNo('${it.id}',this.value)" onclick="event.stopPropagation()"></span>`;
    // 单页操作按钮：失败可重试、未开始可单独启动、已录入可强制重扫。均不依赖全局 batchRunning。
    let runBtn = '';
    if (isRecorded && !running) {
      // 已录入页：给「重扫」按钮，用原页码重新识别并覆盖，不改页码、不错页
      runBtn = `<button class="batch-run retry" title="用原页码重新识别并覆盖本页" onclick="forceRescan('${it.id}')">重扫</button>`;
    } else if (!isRecorded) {
      if (it.status === 'error') {
        runBtn = `<button class="batch-run retry" onclick="runOnePage('${it.id}')" ${running ? 'disabled' : ''}>重试</button>`;
      } else if (it.status === 'pending' || it.status === 'detected') {
        runBtn = `<button class="batch-run" onclick="runOnePage('${it.id}')" ${running ? 'disabled' : ''}>▶</button>`;
      } else if (running) {
        runBtn = `<button class="batch-run" disabled>…</button>`;
      }
    }
    return `<div class="batch-item">
      <img class="batch-thumb" src="${it.thumb}" alt="">
      <div class="batch-info">
        <div class="batch-name">${pgInput} ${esc(it.file.name)}</div>
        <div class="batch-status ${statusCls}">${st}</div>
        ${extra}
      </div>
      ${runBtn}
      <button class="batch-del" onclick="removeOne('${it.id}')" ${running ? 'disabled' : ''}>×</button>
    </div>`;
  }).join('');
  const autoBtn = document.getElementById('autoBtn');
  if (autoBtn) {
    autoBtn.disabled = batchRunning;
    const recordedCount = batchQueue.filter(x => x.recorded && x.pageNo > 0).length;
    autoBtn.textContent = batchRunning ? '批量处理中…（失败页可单独重试）'
      : `🚀 开始识别并入库（${batchQueue.length}/${MAX_BATCH} 张${recordedCount ? `，${recordedCount} 张已录入将跳过` : ''}）`;
  }
}

function removeOne(id) {
  const it = batchQueue.find(x => x.id === id);
  if (it && it.running) return;   // 正在处理的页不允许删除；空闲/失败页随时可删
  batchQueue = batchQueue.filter(x => x.id !== id);
  renderBatch();
}
function clearBatch() {
  if (batchQueue.some(x => x.running)) { toast('有页面正在处理，请稍候再清空'); return; }
  batchQueue = [];
  renderBatch();
  document.getElementById('progressBox').classList.remove('show');
}

function setProgress(show, pct, label) {
  const box = document.getElementById('progressBox');
  box.classList.toggle('show', show);
  document.getElementById('progressBar').style.width = (pct || 0) + '%';
  if (label) document.getElementById('progressLabel').textContent = label;
}

/* ---- 省流①：上传前压缩图片，降低多模态图片输入 token ----
 * 词典页文字密集，不能压太狠；长边上限 1920px + JPEG 0.85 在“看清字”和“省 token”间取平衡。
 * detail:high 的图片 token 随分辨率上升，压缩后整页扫描 input token 明显下降。
 * 已足够小 / 压缩失败时回退原图，绝不影响可用性。
 */
const IMG_MAX_SIDE = 1920;
const IMG_QUALITY = 0.82;
function compressImage(file, maxSide = IMG_MAX_SIDE, quality = IMG_QUALITY) {
  return new Promise((resolve) => {
    if (!file || !file.type.startsWith('image/')) return resolve(file);
    const img = new Image();
    const objUrl = URL.createObjectURL(file);
    img.onload = () => {
      try {
        const { width, height } = img;
        const longest = Math.max(width, height);
        // GIF 直接保留（可能动图）；已够小且是 jpeg 也直接保留
        if (file.type === 'image/gif' || (longest <= maxSide && file.type === 'image/jpeg')) {
          URL.revokeObjectURL(objUrl);
          return resolve(file);
        }
        const scale = longest > maxSide ? maxSide / longest : 1;
        const w = Math.round(width * scale), h = Math.round(height * scale);
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, w, h);
        canvas.toBlob((blob) => {
          URL.revokeObjectURL(objUrl);
          if (!blob) return resolve(file);
          const out = new File([blob],
            file.name.replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' });
          resolve(out);
        }, 'image/jpeg', quality);
      } catch (e) {
        URL.revokeObjectURL(objUrl);
        resolve(file);
      }
    };
    img.onerror = () => { URL.revokeObjectURL(objUrl); resolve(file); };
    img.src = objUrl;
  });
}

/* ---- 阶段①：逐张上传 + AI 识别真实印刷页码 + 落库到 vw_scan_batches ---- */
async function uploadOne(item) {
  if (!cfg.url || !cfg.key) throw new Error('请先在设置中配置 Supabase');
  // 省流①：压缩后再上传，detect 与 scan 复用这张压缩图（只压一次，两处受益）
  const uploadFile = await compressImage(item.file);
  item.uploadBytes = uploadFile.size;
  const path = `vocab-pages/${cfg.book}/${Date.now()}_${uploadFile.name.replace(/[^\w.\-]/g, '_')}`;
  const up = await fetchWithRetry(`${cfg.url}/storage/v1/object/${path}`, {
    method: 'POST',
    headers: { apikey: cfg.key, Authorization: `Bearer ${cfg.key}`, 'Content-Type': uploadFile.type || 'image/jpeg' },
    body: uploadFile,
  }, { timeout: 60000, retries: 2, label: '图片上传' });
  if (!up.ok) throw new Error('图片上传失败 ' + up.status);
  return { path, imageUrl: `${cfg.url}/storage/v1/object/public/${path}` };
}

async function detectPageOne(item) {
  const fn = await fetchWithRetry(`${cfg.url}/functions/v1/detect-page`, {
    method: 'POST',
    headers: { apikey: cfg.key, Authorization: `Bearer ${cfg.key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      imageUrl: item.imageUrl, imagePath: item.imagePath,
      bookId: cfg.book, batchId: item.batchId || null,
      expectedPage: expectedStartPage,
    }),
  }, { timeout: 90000, retries: 1, label: '页码识别' });
  const text = await fn.text();
  let d;
  try { d = JSON.parse(text); } catch (e) { throw new Error('页码识别返回异常：' + text.slice(0, 150)); }
  if (!fn.ok || !d.ok) throw new Error(d.error || ('页码识别失败 ' + fn.status));
  return d;  // { ok, page_no, batch_id, raw }
}

/* ---- 阶段①核心：对单页上传 + AI 识别真实页码 ----
 * 传入单个 item，独立设置 running，失败抛错由调用方决定如何处理。
 */
async function detectOnePage(item) {
  if (item.imageUrl && item.pageNo > 0) return;   // 已识别过，跳过
  item.running = true;
  item.status = 'uploading';
  item.error = null;
  renderBatch();
  try {
    if (cfg.demo) {
      await new Promise(r => setTimeout(r, 300));
      item.pageNo = 100 + batchQueue.indexOf(item);  // 演示模式占位页码
      item.imageUrl = item.thumb;
      item.batchId = null;
    } else {
      const up = await uploadOne(item);
      item.imagePath = up.path;
      item.imageUrl = up.imageUrl;
      item.status = 'detecting';
      renderBatch();
      const d = await detectPageOne(item);
      item.pageNo = d.page_no || 0;
      item.batchId = d.batch_id || item.batchId || null;
      if (!d.page_no) throw new Error('未识别到页码，请在左侧手动填写页码');
    }
    item.status = 'detected';
  } finally {
    item.running = false;
  }
}

/* ---- 阶段①批量：逐张识别页码（调 detectOnePage）---- */
async function detectAllPages() {
  setProgress(true, 0, '准备识别页码…');
  const total = batchQueue.length;
  for (let i = 0; i < total; i++) {
    const item = batchQueue[i];
    setProgress(true, Math.round(i / total * 100), `第 ${i + 1}/${total} 张：识别页码…`);
    try {
      await detectOnePage(item);
    } catch (e) {
      item.status = 'error';
      item.error = e.message;
    }
    renderBatch();
  }
  batchQueue.sort((a, b) => (a.pageNo || 99999) - (b.pageNo || 99999));
  await markRecordedPages();
  renderBatch();
  const okCount = batchQueue.filter(x => x.pageNo > 0).length;
  return { okCount, total };
}

/* ---- 阶段②核心：对单页解析入库（独立 running），prevContext 为跨页上下文 ---- */
async function parseOnePage(item, pageNo, prevContext, index, force = false) {
  item.running = true;
  item.status = 'parsing';
  item.error = null;
  renderBatch();
  try {
    let result;
    if (cfg.demo) result = await demoScanOne(index || 0, prevContext);
    else result = await scanOneOnline(item, pageNo, prevContext, force);
    item.status = 'done';
    item.result = result;
    saveLocalProgress(pageNo);
    invalidateProgressCache();          // 页码已入库，缓存失效以便下次读取最新值
    return result;
  } finally {
    item.running = false;
  }
}

/* ---- 阶段②批量：按页码升序逐页扫描，跨页上下文传递；单页失败不阻塞后续 ---- */
async function scanAllPages() {
  batchQueue.sort((a, b) => (a.pageNo || 99999) - (b.pageNo || 99999));
  renderBatch();
  let nextContext = null;
  const summary = [];
  // 前期已录入的页跳过；页码没识别出来的也跳过
  const all = batchQueue.filter(x => x.pageNo > 0 && !x.recorded);
  const skippedRecorded = batchQueue.filter(x => x.pageNo > 0 && x.recorded).length;
  const total = all.length;
  setProgress(true, 0, '准备入库…');
  for (let i = 0; i < total; i++) {
    const item = all[i];
    const pageNo = item.pageNo;
    if (item.status === 'done' && item.result) {
      summary.push(item.result);
      nextContext = item.result.nextContext || nextContext;
      continue;
    }
    setProgress(true, Math.round(i / total * 100), `第 ${pageNo} 页（${i + 1}/${total}）：AI 解析入库中…`);
    try {
      // 上下文双来源：优先用同批次内存 nextContext，否则从握手池读上一页 pending 残段。
      // 这样即使上一页隔很久才录、或本批次不含相邻页，也能接上跨页词。
      let ctx = nextContext;
      if (!ctx || ctx.page_no !== pageNo - 1) {
        ctx = await loadPageContext(pageNo - 1) || ctx;
      }
      const result = await parseOnePage(item, pageNo, ctx, i);
      summary.push(result);
      if (result && result.nextContext) nextContext = result.nextContext;
    } catch (e) {
      // 识别不完整保护：后端主动拒收，明确展示原因，不走"假成功"复查
      if (/识别不完整|保留原数据/.test(e.message)) {
        item.status = 'error';
        item.error = e.message;
      }
      // 假失败复查：网络超时可能服务端已入库，若该页已有词则纠正为成功
      else if (await isPageActuallyRecorded(pageNo)) {
        item.status = 'done';
        item.error = null;
        item.result = { ok: true, words_found: null, note: '服务端已入库成功，仅为回传超时（无需重试）' };
      } else {
        item.status = 'error';
        item.error = e.message;
      }
    }
    renderBatch();
  }
  await refreshWords();
  const failed = all.filter(x => x.status === 'error').length;
  return { total, failed, summary, skippedRecorded };
}

// 收尾：进度、结果卡片、提示
function finishScanUI(total, failed, summary, skipped = 0, skippedRecorded = 0) {
  setProgress(true, 100, '全部完成');
  setTimeout(() => setProgress(false), 800);
  showBatchResult(summary);
  updateProgressDisplay();
  const parts = [];
  if (failed) parts.push(`${failed} 页失败（点状态可重试）`);
  if (skippedRecorded) parts.push(`${skippedRecorded} 页前期已录入被跳过`);
  if (skipped) parts.push(`${skipped} 页未识别出页码被跳过（手动补页码后重试）`);
  toast(parts.length ? `完成：${parts.join('，')}` : `全部 ${total} 页按页码顺序入库完成`);
}

/* ---- 入口①：仅识别页码（供手动校正）---- */
async function startDetectPages() {
  if (batchRunning || !batchQueue.length) return;
  batchRunning = true;
  renderBatch();
  try {
    const { okCount, total } = await detectAllPages();
    setProgress(true, 100, `页码识别完成 ${okCount}/${total}`);
    setTimeout(() => setProgress(false), 1200);
    updateProgressDisplay();
    toast(`已识别 ${okCount}/${total} 页页码，可校正后点“扫描入库”`);
  } catch (e) {
    setProgress(false);
    toast('识别异常：' + e.message);
  } finally {
    batchRunning = false;
    renderBatch();
  }
}

/* ---- 入口②：仅按已识别页码入库（手动校正路径）---- */
async function startBatchScan() {
  if (batchRunning || !batchQueue.length) return;
  if (!batchQueue.some(x => x.pageNo > 0)) { toast('请先识别每页页码'); return; }
  batchRunning = true;
  renderBatch();
  try {
    const { total, failed, summary, skippedRecorded } = await scanAllPages();
    finishScanUI(total, failed, summary, 0, skippedRecorded);
  } catch (e) {
    setProgress(false);
    toast('批量处理异常：' + e.message);
  } finally {
    batchRunning = false;
    renderBatch();
  }
}

/* ---- 入口③：一键自动 —— 识别页码 → 按页码排序 → 逐页扫描入库 ----
 * 批量运行中，若某页失败，用户可立即点该页「重试」按钮（runOnePage），
 * 不依赖 batchRunning，也不阻塞其它页继续处理。
 */
async function autoRunAll() {
  if (batchRunning || !batchQueue.length) return;
  // 演示模式：仍走本地串行（无云端任务队列）
  if (cfg.demo) { return autoRunAllLocal(); }
  if (!sync || !sync.code) { toast('请先设置同步码'); openSyncGate(true); return; }
  batchRunning = true;
  renderBatch();
  const total = batchQueue.length;
  try {
    // 阶段①：逐张上传图片到 Storage（Blob 只在浏览器，必须前端做；几秒即完成）
    const pages = [];
    for (let i = 0; i < total; i++) {
      const item = batchQueue[i];
      setProgress(true, Math.round((i / total) * 60), `上传图片 ${i + 1}/${total}…`);
      // 已上传过的复用，避免重复上传
      if (!item.imageUrl) {
        const up = await uploadOne(item);
        item.imagePath = up.path;
        item.imageUrl = up.imageUrl;
      }
      pages.push({ image_url: item.imageUrl, image_path: item.imagePath });
    }
    // 阶段②：把图片清单交给云端，创建任务。之后页面可随时关闭，云端自动执行。
    setProgress(true, 85, '提交云端任务…');
    const r = await fetchWithRetry(`${cfg.url}/functions/v1/job-worker`, {
      method: 'POST',
      headers: { ...SYNC_HEADERS(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'create', sync_code: sync.code, book_id: cfg.book, pages,
      }),
    }, { timeout: 30000, retries: 2, label: '提交云端任务' });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.ok) throw new Error(d.error || ('提交失败 HTTP ' + r.status));
    setProgress(true, 100, '任务已提交');
    setTimeout(() => setProgress(false), 900);

    // 提交成功：清空本地队列（任务已在云端），跳到记录页看执行清单
    batchQueue = [];
    renderBatch();
    toast(d.duplicated ? '这批图片已提交过，已带你查看任务' : `任务已提交（${total} 页），云端自动执行中，可关闭页面`);
    switchPage('records');
    loadJobs(true);
  } catch (e) {
    setProgress(false);
    toast('提交任务失败：' + e.message);
  } finally {
    batchRunning = false;
    renderBatch();
  }
}

// demo 模式的原本地串行流程（无云端队列）
async function autoRunAllLocal() {
  if (batchRunning || !batchQueue.length) return;
  batchRunning = true;
  renderBatch();
  try {
    const { okCount, total } = await detectAllPages();
    if (okCount === 0) { setProgress(false); toast('未能从图片识别出页码'); return; }
    setProgress(true, 100, `页码识别完成 ${okCount}/${total}，开始解析…`);
    const { total: scanned, failed, summary, skippedRecorded } = await scanAllPages();
    finishScanUI(scanned, failed, summary, total - okCount, skippedRecorded);
  } catch (e) { setProgress(false); toast('自动扫描异常：' + e.message); }
  finally { batchRunning = false; renderBatch(); }
}

/* ---- 单页全流程：只处理这一页（上传→识别页码→解析入库），随时可单独启动/重试 ----
 * 关键：不看 batchRunning，只看 item.running。因此批量处理中失败页也能立即重试。
 */
async function runOnePage(id) {
  const item = batchQueue.find(x => x.id === id);
  if (!item || item.running) return;
  item.error = null;
  try {
    setProgress(true, 0, `单独处理第 ${item.pageNo || '?'} 页…`);
    // 1) 页码未识别则先识别
    if (!(item.imageUrl && item.pageNo > 0)) {
      await detectOnePage(item);
    }
    // 2) 检查是否前期已录入（含"本次假失败其实已入库"的情况）
    await markRecordedPages();
    if (item.pageNo > 0 && item.recorded) {
      item.status = 'done';
      item.error = null;
      item.result = { ok: true, words_found: null, note: `已确认第 ${item.pageNo} 页词条已在词库中，无需重扫` };
      renderBatch();
      toast(`第 ${item.pageNo} 页已成功入库（此前失败提示为网络误报），已标记完成`);
      return;
    }
    if (!item.pageNo) throw new Error('未识别到页码，请在左侧手动填写页码');
    // 3) 解析入库。带上"上一页"的跨页上下文（从数据库读取，孤立重试也能正确承接页首词）
    const prevCtx = await loadPageContext(item.pageNo - 1);
    const result = await parseOnePage(item, item.pageNo, prevCtx, batchQueue.indexOf(item));
    item.result = result;
    // 4) 若本页产生页尾半截词，且下一页已在队列，自动重扫下一页合并跨页词
    await autoRepairNextPage(item, result);
    setProgress(true, 100, `第 ${item.pageNo} 页完成`);
    toast(`第 ${item.pageNo} 页处理完成：${result.words_found || 0} 词`);
  } catch (e) {
    // 假失败复查：若服务端其实已入库，纠正为成功而非失败
    if (await isPageActuallyRecorded(item.pageNo)) {
      item.status = 'done';
      item.error = null;
      item.result = { ok: true, words_found: null, note: '服务端已入库成功，仅为回传超时（无需重试）' };
      toast(`第 ${item.pageNo} 页其实已成功入库（网络误报），已标记完成`);
    } else {
      item.status = 'error';
      item.error = e.message;
      toast(`处理失败：${e.message}`);
    }
  } finally {
    item.running = false;
    renderBatch();
    await refreshWords();
    setTimeout(() => setProgress(false), 1200);
  }
}

/* ---- 强制重扫：已录入页发现漏词时，用原页码重新识别并覆盖本页 ----
 * 不改页码（避免数据错页），后端 force=1 会先清空该页旧词条再重新入库。
 */
async function forceRescan(id) {
  const item = batchQueue.find(x => x.id === id);
  if (!item || item.running) return;
  if (!(item.pageNo > 0)) { toast('该页还没有页码，无法重扫'); return; }
  item.error = null;
  try {
    setProgress(true, 0, `强制重扫第 ${item.pageNo} 页（原页码覆盖）…`);
    const prevCtx = await loadPageContext(item.pageNo - 1);
    const result = await parseOnePage(item, item.pageNo, prevCtx, batchQueue.indexOf(item), true);
    item.recorded = false;
    await autoRepairNextPage(item, result);
    setProgress(true, 100, `第 ${item.pageNo} 页重扫完成`);
    toast(`第 ${item.pageNo} 页已重扫覆盖：识别 ${result.words_found || 0} 词${result.force_cleared ? `（清除旧词 ${result.force_cleared} 条）` : ''}`);
  } catch (e) {
    item.status = 'error';
    item.error = e.message;
    toast(`重扫失败：${e.message}`);
  } finally {
    item.running = false;
    renderBatch();
    await refreshWords();
    setTimeout(() => setProgress(false), 1200);
  }
}

/* ---- 在线：解析一页（图片与页码已在阶段①上传/识别，批次已落库）---- */
async function scanOneOnline(item, pageNo, prevContext, force = false) {
  if (!cfg.url || !cfg.key) throw new Error('请先在设置中配置 Supabase');
  if (!item.imageUrl) throw new Error('图片尚未上传，请先执行“识别每页页码”');
  // 一页 AI 解析约 40 秒，超时放宽到 150 秒；网络中断自动重试 1 次（入库幂等，重试安全）
  // force=1 时后端会先清该页旧数据，因此网络重试也必须带 force，否则第二次重试会跳过清理
  const fn = await fetchWithRetry(`${cfg.url}/functions/v1/scan-page`, {
    method: 'POST',
    headers: { apikey: cfg.key, Authorization: `Bearer ${cfg.key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      imageUrl: item.imageUrl, bookId: cfg.book, pageNo,
      batchId: item.batchId, prevContext, force,
    }),
  }, { timeout: 150000, retries: 1, label: `第 ${pageNo} 页扫描` });
  const text = await fn.text();
  let result;
  try { result = JSON.parse(text); } catch (e) { throw new Error('函数返回异常：' + text.slice(0, 200)); }
  if (!fn.ok || !result.ok) throw new Error(result.error || ('扫描函数失败 ' + fn.status));
  return result;
}

/* ---- 演示模式：模拟单页，仍传递上下文 ---- */
async function demoScanOne(index, prevContext) {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  await wait(500);
  const demo = window.DEMO_DATA || { words: [] };
  let stored = [];
  try { stored = JSON.parse(localStorage.getItem(LS.demo) || '[]'); } catch (e) {}
  const map = new Map(stored.map(w => [w.headword, w]));
  let added = 0, senses = 0, examples = 0;
  for (const w of demo.words) {
    senses += (w.senses || []).length;
    for (const s of (w.senses || [])) {
      examples += (s.items || []).reduce((n, it) => n + 1 + (it.children ? it.children.length : 0), 0);
    }
    if (!map.has(w.headword)) added++;
    map.set(w.headword, Object.assign({}, w, { page_no: w.page_no || 123, book_id: cfg.book }));
  }
  localStorage.setItem(LS.demo, JSON.stringify(Array.from(map.values())));
  return {
    ok: true, words_found: demo.words.length, senses_found: senses,
    examples_found: examples, words: demo.words.map(w => w.headword),
    boundary: { tail: { word: 'day', note: '演示：day 义项延续到下一页' } },
    nextContext: { word: 'day', note: '演示上下文', senses: [] },
  };
}

/* ---- 单页重试（兼容旧调用）：统一走单页全流程，只重跑这一页 ---- */
function retryOne(id) {
  item_reset_for_retry(id);
  runOnePage(id);
}
function item_reset_for_retry(id) {
  const item = batchQueue.find(x => x.id === id);
  if (!item) return;
  item.status = 'pending';
  item.error = null;
  item.result = null;
  // 若页码是识别失败（0），清掉标记让 runOnePage 重新识别；手动填的页码(>0)保留
  if (!item.pageNo) { item.imageUrl = null; item.imagePath = null; }
  renderBatch();
}

/* ---- 批量结果汇总展示 ---- */
function showBatchResult(summary) {
  const card = document.getElementById('resultCard');
  card.classList.add('show');
  const wSet = new Set();
  let senses = 0, examples = 0, merged = 0, resumed = 0;
  const partials = [];
  summary.forEach(r => {
    (r.words || []).forEach(w => wSet.add(w));
    senses += r.senses_found || 0;
    examples += r.examples_found || 0;
    merged += r.merged_examples || 0;
    resumed += r.resumed_words || 0;
    (r.partial_words || []).forEach(p => partials.push(p));
  });
  document.getElementById('resultStats').innerHTML = `
    <span>处理 ${summary.length} 页</span>
    <span>去重词条 ${wSet.size}</span>
    <span>义项 ${senses}</span>
    <span>例句 ${examples}</span>
    ${merged ? `<span>合并去重 ${merged}</span>` : ''}
    ${resumed ? `<span>补全半截词 ${resumed}</span>` : ''}`;
  let bHtml = '';
  if (resumed) bHtml += `<div class="boundary-note">🔗 已用上一页上下文补全 ${resumed} 个半截词（义项例句并入原页）</div>`;
  if (partials.length) bHtml += `<div class="boundary-note partial">⏳ 页尾半截词「${Array.from(new Set(partials)).join('、')}」已暂存并标记，扫描下一页时会自动补全</div>`;
  document.getElementById('boundarySummary').innerHTML = bHtml;
  document.getElementById('resultChips').innerHTML =
    Array.from(wSet).map(w => `<span class="chip">${esc(w)}</span>`).join('');
}

/* ---------------- 词库查询 ---------------- */
// 词性归一化：去掉所有句点并压缩空格（vt. & vi. / vt & vi → vt & vi；adj. → adj）
// 复合词性的中间句点也必须去掉，否则 vt & vi 与 vt. & vi. 无法合并成同一组，导致重复义项显示
function normPosFront(p) { return String(p || '').trim().replace(/\./g, '').replace(/\s+/g, ' ').toLowerCase(); }
// 中文释义"纯度"评分：中文越多、英文越少越高，用于从重复义项里挑正确释义
function hanScore(s) {
  const str = String(s || '');
  if (!str.trim()) return -1;
  const han = (str.match(/[\u3400-\u9fff]/g) || []).length;
  const latin = (str.match(/[A-Za-z]/g) || []).length;
  return han - latin * 2;
}
// 显示层去重：同一词多次扫描会因词性带点/不带点产生重复义项（adj vs adj.），
// 按「归一化词性|义项号」合并：释义取中文最纯的、常考标取任一条、例句按英文去重合并
function dedupeSenses(senses) {
  if (!Array.isArray(senses)) return [];
  const groups = new Map();
  for (const s of senses) {
    const no = s.sense_no ?? s.no ?? 0;
    const key = normPosFront(s.pos) + '|' + no;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }
  const out = [];
  for (const arr of groups.values()) {
    // 主义项取 id 最大者（新批次提示词更准），保留其 id 供长按编辑写回
    let base = arr.reduce((a, b) => (Number(b.id) || 0) > (Number(a.id) || 0) ? b : a, arr[0]);
    base = Object.assign({}, base);
    // 中文释义取中文纯度最高的一条
    let best = arr[0];
    for (const s of arr) if (hanScore(s.chinese_def || s.def) > hanScore(best.chinese_def || best.def)) best = s;
    if (hanScore(best.chinese_def || best.def) >= 0) base.chinese_def = best.chinese_def || best.def || base.chinese_def;
    // 常考标：任一条为高频则保留
    if (arr.some(s => Number(s.sense_freq) === 1)) base.sense_freq = 1;
    // 补齐其它字段
    for (const f of ['countability', 'usage_label', 'english_def', 'antonym']) {
      if (!base[f]) { const hit = arr.find(s => s[f]); if (hit) base[f] = hit[f]; }
    }
    // 例句：跨重复义项按英文去重合并
    const seen = new Set(); const ex = [];
    for (const s of arr) {
      for (const e of (s.examples || s.items || [])) {
        const k = String(e.en || '').toLowerCase().replace(/[\s\p{P}]/gu, '');
        if (k && seen.has(k)) continue;
        if (k) seen.add(k);
        ex.push(e);
      }
    }
    base.examples = ex;
    out.push(base);
  }
  return out;
}

// 义项按词性归组、组内按义项号排序（贴合印刷版式）：
// 同一单词不同词性各有多个义项时，书上先按词性分节、每节内按 ①②③ 顺序排列。
// AI 输出/入库顺序可能交错（如 prep① prep③ adv② prep② adv①），
// 这里按「词性首次出现的先后」归组，组内按 sense_no 升序，恢复书上顺序。
function orderSenses(senses) {
  if (!Array.isArray(senses) || senses.length < 2) return senses || [];
  const groups = new Map();   // normPos -> { first, items }
  const posOrder = [];
  senses.forEach((s, i) => {
    const p = normPosFront(s.pos) || '_';
    if (!groups.has(p)) { groups.set(p, { first: i, items: [] }); posOrder.push(p); }
    groups.get(p).items.push(s);
  });
  const out = [];
  posOrder.forEach(p => {
    const g = groups.get(p);
    g.items.sort((a, b) => {
      const na = Number(a.sense_no ?? a.no ?? 0) || 0;
      const nb = Number(b.sense_no ?? b.no ?? 0) || 0;
      return na - nb;
    });
    out.push(...g.items);
  });
  return out;
}

/* ================= 词间关系网（从树派生，纯前端，不动识别/数据库） =================
   树保证"不漏"，网保证"不乱"。关系全部来自已入库结构：
   - 派生：derived_from / parent_word_id
   - 反义：sense.antonym
   - 同义/辨析/同族：notes 里 note_type ∈ {同,辨,反,同族词} 的 title 词清单
   只保留两端都在词库里的边（库内边），另有 external 记录库外关联词供展示。
*/
let relGraph = { nodes: [], edges: [], byId: new Map(), byNorm: new Map() };

function normHw(s) {
  return String(s || '').toLowerCase().replace(/^[*⊕⊖▶▼\s]+/, '').replace(/[^a-z]/g, '');
}
function splitWordList(s) {
  // "above, on, over" / "act, action, active" → ['above','on','over']
  return String(s || '').split(/[,，、;；\/]+/).map(x => x.trim().replace(/^(同族词|同|辨|反)[:：]?\s*/, '')).map(x => x.replace(/\s*\(.*?\)\s*/g, '').trim()).filter(x => /^[A-Za-z][A-Za-z\-' ]*$/.test(x) && x.length <= 30);
}
function buildRelationGraph() {
  const nodes = (allWords || []).map(w => ({
    id: w.id, hw: w.headword, norm: normHw(w.headword),
    page: w.page_no, tags: w.tags || []
  }));
  const byId = new Map(nodes.map(n => [String(n.id), n]));
  const byNorm = new Map();
  nodes.forEach(n => { if (n.norm && !byNorm.has(n.norm)) byNorm.set(n.norm, n); });

  const edgeMap = new Map();   // key -> edge（去重）
  const external = new Map();  // 库外关联词 → Set<词>
  const addEdge = (aId, bNorm, type, label) => {
    const a = byId.get(String(aId));
    if (!a) return;
    const b = byNorm.get(normHw(bNorm));
    if (!b || b.id === a.id) {
      // 库外词：记录 a → 该词（供词条显示"关联词未收录"）
      const ext = normHw(bNorm);
      if (ext && ext !== a.norm) {
        if (!external.has(a.id)) external.set(a.id, new Map());
        const m = external.get(a.id);
        if (!m.has(type)) m.set(type, new Set());
        m.get(type).add(String(bNorm).trim());
      }
      return;
    }
    const lo = Math.min(Number(a.id), Number(b.id)), hi = Math.max(Number(a.id), Number(b.id));
    const key = `${lo}|${hi}|${type}`;
    if (!edgeMap.has(key)) edgeMap.set(key, { a: lo, b: hi, type, label: label || '' });
  };

  for (const w of allWords || []) {
    // 派生：本词派生自谁
    if (w.derived_from) addEdge(w.id, w.derived_from, '派生', '派生自');
    // 派生：谁派生自本词（parent_word_id 反向）
    if (w.parent_word_id) addEdge(w.id, byId.get(String(w.parent_word_id))?.hw || '', '派生', '派生出');
    // 反义：义项里的 antonym（可能带"反"前缀）
    for (const s of (w.senses || [])) {
      if (s.antonym) {
        const parts = splitWordList(String(s.antonym).replace(/^反[:：]?\s*/, ''));
        parts.forEach(p => addEdge(w.id, p, '反义', '反'));
      }
    }
    // 同义/辨析/同族/反：notes 的 title 词清单
    for (const n of (w.notes || [])) {
      const t = String(n.note_type || '').trim();
      if (!['同', '辨', '反', '同族词'].includes(t)) continue;
      const type = t === '同族词' ? '同族' : (t === '辨' ? '辨析' : (t === '反' ? '反义' : '同义'));
      splitWordList(n.title).forEach(p => addEdge(w.id, p, type, t));
    }
  }

  // 邻接表
  const adj = new Map(nodes.map(n => [String(n.id), []]));
  const edges = Array.from(edgeMap.values());
  for (const e of edges) {
    adj.get(String(e.a))?.push({ id: e.b, type: e.type });
    adj.get(String(e.b))?.push({ id: e.a, type: e.type });
  }
  // external 转普通对象：{ wordId: { type: [词...] } }
  const extObj = {};
  external.forEach((m, id) => { extObj[id] = {}; m.forEach((set, type) => { extObj[id][type] = Array.from(set); }); });
  relGraph = { nodes, edges, byId, byNorm, adj, external: extObj };
  return relGraph;
}

// 取某词的关系摘要（供词卡渲染）：{ type: [{hw,id,inLib}] } + external
function relationsOf(wordId) {
  const g = relGraph;
  const out = {};
  const adj = g.adj?.get(String(wordId)) || [];
  for (const r of adj) {
    const n = g.byId.get(String(r.id));
    if (!n) continue;
    (out[r.type] = out[r.type] || []).push({ hw: n.hw, id: n.id, inLib: true });
  }
  const ext = g.external?.[String(wordId)] || {};
  for (const [type, arr] of Object.entries(ext)) {
    arr.forEach(hw => (out[type] = out[type] || []).push({ hw, inLib: false }));
  }
  // 每类去重
  for (const k of Object.keys(out)) {
    const seen = new Set();
    out[k] = out[k].filter(x => { const kk = normHw(x.hw); if (seen.has(kk)) return false; seen.add(kk); return true; });
  }
  return out;
}

async function refreshWords() {
  if (cfg.demo) {
    try { allWords = JSON.parse(localStorage.getItem(LS.demo) || '[]'); }
    catch (e) { allWords = []; }
  } else {
    if (!cfg.url || !cfg.key) { allWords = []; return; }
    // 嵌套查询：vw_words 带出 vw_senses(再带 vw_examples) 与 vw_notes
    const select = 'id,headword,phonetic,level_tag,page_no,partial,inline_def,identity_tag,derived_from,parent_word_id,tags,vw_senses(id,pos,sense_no,sense_freq,countability,usage_label,chinese_def,english_def,antonym,vw_examples(id,kind,parent_phrase,usage_label,en,zh,gloss,source)),vw_notes(id,note_type,title,content)';
    // 关键：Supabase REST 服务端硬上限每次最多返回 1000 条（content-range 0-999/*），
    // 即使写 limit=100000 也只给 1000。词库超过 1000 词时必须用 offset 分页拉全，
    // 否则词库页永远只显示前 1000 个词，后面的页（P87~P100）全部缺失。
    const PAGE = 1000;
    const rows = [];
    for (let offset = 0; ; offset += PAGE) {
      const r = await fetchWithRetry(`${cfg.url}/rest/v1/vw_words?book_id=eq.${encodeURIComponent(cfg.book)}&select=${encodeURIComponent(select)}&order=id&offset=${offset}&limit=${PAGE}`, {
        headers: { apikey: cfg.key, Authorization: `Bearer ${cfg.key}` }
      }, { timeout: 20000, retries: 1, label: '加载词库' + (offset ? `(${offset / PAGE + 1})` : '') });
      if (!r.ok) { console.warn('查询词库失败', await r.text()); allWords = []; return; }
      const part = await r.json();
      rows.push(...part);
      if (part.length < PAGE) break;   // 不足一页 = 已拉完
    }
    // Supabase 嵌套返回键为 vw_senses / vw_examples，归一化为前端统一结构
    allWords = rows.map(w => Object.assign({}, w, {
      tags: Array.isArray(w.tags) ? w.tags : [],
      senses: (w.vw_senses || []).map(s => Object.assign({}, s, {
        examples: s.vw_examples || []
      })),
      notes: w.vw_notes || []
    }));
  }
  // 按当前同步码加载学习状态，覆盖词库全局 tags（进度/已会/不会按码隔离）
  await loadUserStates();
  // 统一归一化：tags 收敛为新三态 + 义项去重 + 按词性归组排序（贴合印刷版式）
  allWords.forEach(w => {
    w.tags = Array.isArray(w.tags) ? w.tags.filter(t => t === '已会' || t === '不会' || t === '进度') : [];
    w.senses = orderSenses(dedupeSenses(w.senses));
  });
  // 按 A–Z 排序（忽略大小写），供仿书本顺序滚动
  // v2.17 兜底：头部带符号(*/⊕/⊖)或非拉丁字符(中文等)的异常词头排到字母词之后，
  // 绝不因 localeCompare 的码位规则抢到 a 前面。正常情况下写库已归类，这里是最后一道防线。
  const _sortKey = w => String(w.headword || '').replace(/^[^a-zA-Z]+/, '').toLowerCase();
  const _isLatin = w => /^[a-zA-Z]/.test(String(w.headword || '').replace(/^[^a-zA-Z]+/, ''));
  allWords.sort((a, b) => {
    const la = _isLatin(a), lb = _isLatin(b);
    if (la !== lb) return la ? -1 : 1;          // 拉丁字母词在前，异常词在后
    const ka = _sortKey(a), kb = _sortKey(b);
    const c = ka.localeCompare(kb);
    return c !== 0 ? c : String(a.headword || '').localeCompare(String(b.headword || ''));
  });
  buildRelationGraph();   // 词间关系网（v2.13）
  rebuildTagFilter();
  resetWordList();
  updateBadge();
}
function updateBadge() {
  const b = document.getElementById('navBadge');
  if (b) { b.textContent = allWords.length; b.classList.toggle('show', allWords.length > 0); }
  const sb = document.getElementById('sideBadge');
  if (sb) { sb.textContent = allWords.length; sb.classList.toggle('show', allWords.length > 0); }
}

/* ---------------- 词库浏览：仿书本 · 单列无限滚动 · 搜索 · 标签筛选 ---------------- */
const PAGE_RENDER = 30;                 // 每批渲染词条数（预加载 1~2 屏篇幅）
let filteredWords = [];                 // 当前搜索+标签过滤后的列表
let renderedCount = 0;                  // 已渲染条数
let activeTag = '__all__';              // 当前标签筛选
let _sentinelObserver = null;

// 搜索框输入（防抖）
let _searchTimer = null;
function onSearchChange() {
  clearTimeout(_searchTimer);
  _searchTimer = setTimeout(resetWordList, 180);
}

/* ---------------- 词库右侧 A-Z 索引滑块 ---------------- */
const AZ_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
let _azLetterEls = [];        // 26 个字母 DOM
let _azFirstIdx = {};         // 字母 -> filteredWords 中首个匹配下标
let _azProgressLetter = null; // 进度词所属字母（在字母上嵌 📍 标记）
let _azActive = -1;           // 当前激活字母下标（-1 无）
let _azDragging = false;
let _azBubbleTimer = null;

// 取单词的首字母（大写），忽略非字母前缀
function wordInitial(w) {
  const s = String((w && w.headword) || '').replace(/^[^a-zA-Z]+/, '').charAt(0);
  return s ? s.toUpperCase() : '';
}

// 依据当前 filteredWords 建立「字母 -> 首个词条下标」映射，并给字母标注可用性
function buildAzMap() {
  _azFirstIdx = {};
  filteredWords.forEach((w, i) => {
    const c = wordInitial(w);
    if (c && _azFirstIdx[c] == null) _azFirstIdx[c] = i;
  });
  _azLetterEls.forEach((el, k) => {
    el.classList.toggle('available', _azFirstIdx[AZ_LETTERS[k]] != null);
  });
  buildAzProgress();
}

// 找出进度词（全局唯一）所属字母，在 A-Z 对应字母上嵌 📍 标记
function buildAzProgress() {
  _azProgressLetter = null;
  const pw = allWords.find(w => Array.isArray(w.tags) && w.tags.includes('进度'));
  if (pw) {
    const c = wordInitial(pw);
    if (c) _azProgressLetter = c;
  }
  _azLetterEls.forEach((el, k) => {
    el.classList.toggle('has-progress', AZ_LETTERS[k] === _azProgressLetter);
  });
}

// 初始化索引条（只做一次）
function initAzIndex() {
  const host = document.getElementById('azLetters');
  if (!host || host.childElementCount) return;
  host.innerHTML = AZ_LETTERS.map((c, i) =>
    `<div class="az-letter" data-i="${i}">${c}</div>`).join('');
  _azLetterEls = Array.from(host.querySelectorAll('.az-letter'));

  const indexEl = document.getElementById('azIndex');
  const bubble = document.getElementById('azBubble');

  // 根据屏幕 Y 坐标算出落在哪个字母上
  const letterFromY = (clientY) => {
    if (!_azLetterEls.length) return -1;
    const r0 = _azLetterEls[0].getBoundingClientRect();
    const rL = _azLetterEls[_azLetterEls.length - 1].getBoundingClientRect();
    const top = r0.top, bottom = rL.bottom;
    const i = Math.round((clientY - top) / Math.max(1, (bottom - top) / 25));
    return Math.max(0, Math.min(25, i));
  };

  const activate = (i, jump = true) => {
    if (i < 0 || i === _azActive) { if (jump && i === _azActive) jumpToLetter(i); return; }
    _azActive = i;
    // 均匀过渡：当前最大，左右按距离线性衰减
    const MAX = 1.95, STEP = 0.27;
    _azLetterEls.forEach((el, k) => {
      const d = Math.abs(k - i);
      const scale = Math.max(1, MAX - d * STEP);
      el.style.transform = 'scale(' + scale.toFixed(3) + ')';
      el.classList.toggle('active', k === i);
      el.style.position = k === i ? 'relative' : '';
    });
    bubble.textContent = AZ_LETTERS[i];
    jumpToLetter(i);
  };

  const clearActive = () => {
    _azActive = -1;
    _azLetterEls.forEach(el => { el.style.transform = ''; el.classList.remove('active'); el.style.position = ''; });
  };

  // 跳转到该字母的首个词条（先补足无限滚动未渲染的部分）
  function jumpToLetter(i) {
    const letter = AZ_LETTERS[i];
    let idx = _azFirstIdx[letter];
    // 进度字母：优先直达进度词本身（快速回到上次学习位置）
    if (letter && letter === _azProgressLetter) {
      const pw = allWords.find(w => Array.isArray(w.tags) && w.tags.includes('进度'));
      if (pw) {
        const pi = filteredWords.findIndex(w => w.id != null ? w.id === pw.id : w.headword === pw.headword);
        if (pi >= 0) idx = pi;
      }
    }
    if (idx == null) {
      // 该字母无词：就近找下一个有词的字母（不必精确落空）
      for (let k = i + 1; k < 26; k++) { if (_azFirstIdx[AZ_LETTERS[k]] != null) { idx = _azFirstIdx[AZ_LETTERS[k]]; break; } }
      if (idx == null) for (let k = i - 1; k >= 0; k--) { if (_azFirstIdx[AZ_LETTERS[k]] != null) { idx = _azFirstIdx[AZ_LETTERS[k]]; break; } }
    }
    if (idx == null || !filteredWords[idx]) return;
    // 先把目标词条渲染出来（无限滚动分批）
    let guard = 0, didRender = false;
    while (renderedCount <= idx && guard++ < 200) { appendWords(); didRender = true; }
    const w = filteredWords[idx];
    const key = w.id != null ? ('id' + w.id) : ('hw' + esc(w.headword));
    // 补渲染会异步撑高页面，滚动可能被 clamp 到旧的滚动上限。
    // 用带重试的定位：连续几帧复查目标卡片位置，直到把它带到顶部附近。
    let tries = 0;
    const doScroll = () => {
      const card = document.getElementById('wc-' + key);
      if (card) {
        const y = card.getBoundingClientRect().top + window.pageYOffset - 8;
        window.scrollTo(0, y);
        // 若因高度未就绪被 clamp（卡片仍远离顶部），下一帧重试
        if (Math.abs(card.getBoundingClientRect().top - 8) > 4 && tries++ < 8) {
          requestAnimationFrame(doScroll);
        }
      }
    };
    requestAnimationFrame(doScroll);
  }

  const onDown = (e) => {
    _azDragging = true;
    clearTimeout(_azBubbleTimer);
    indexEl.classList.add('dragging');
    try { indexEl.setPointerCapture(e.pointerId); } catch (err) {}
    activate(letterFromY(e.clientY));
    e.preventDefault();
  };
  const onMove = (e) => { if (_azDragging) activate(letterFromY(e.clientY)); };
  const onUp = () => {
    if (!_azDragging) return;
    _azDragging = false;
    indexEl.classList.remove('dragging');
    // 松手后短暂保留高亮，再淡出
    _azBubbleTimer = setTimeout(clearActive, 650);
  };
  indexEl.addEventListener('pointerdown', onDown);
  indexEl.addEventListener('pointermove', onMove);
  indexEl.addEventListener('pointerup', onUp);
  indexEl.addEventListener('pointercancel', onUp);
  // 点击单个字母（pointerdown 已覆盖，这里兼容键盘/辅助点击）
  host.addEventListener('click', (e) => {
    const el = e.target.closest('.az-letter');
    if (el) activate(Number(el.dataset.i));
  });
}

// 显隐：仅词库页显示；过滤后无词则隐藏
function updateAzVisibility() {
  const el = document.getElementById('azIndex');
  if (!el) return;
  el.classList.toggle('show', viewMode === 'list' && document.getElementById('page-words').classList.contains('active') && filteredWords.length > 0);
}

/* ================= 关系网总览视图（v2.13） ================= */
let viewMode = 'list';       // 'list' | 'graph'
let _graphTransform = { x: 0, y: 0, k: 1 };
function setViewMode(mode) {
  viewMode = mode;
  document.querySelectorAll('#viewToggle .vt-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.view === mode));
  const listV = document.getElementById('listView');
  const graphV = document.getElementById('graphView');
  const tagF = document.getElementById('tagFilter');
  if (mode === 'graph') {
    listV.style.display = 'none';
    graphV.style.display = '';
    tagF.style.display = 'none';
    updateAzVisibility();         // A-Z 索引在关系网下隐藏
    renderGraph();
  } else {
    graphV.style.display = 'none';
    listV.style.display = '';
    tagF.style.display = '';
    updateAzVisibility();
  }
}

let _graphZoom = 1;
function renderGraph() {
  const host = document.getElementById('graphCanvas');
  if (!host) return;
  const g = relGraph;
  // 只画"有关系"的节点（至少一条边），孤立词不画，保证网清晰
  const degree = new Map();
  (g.edges || []).forEach(e => { degree.set(e.a, (degree.get(e.a)||0)+1); degree.set(e.b, (degree.get(e.b)||0)+1); });
  const nodes = (g.nodes || []).filter(n => degree.get(n.id));
  if (!nodes.length) {
    host.innerHTML = `<div class="graph-empty"><div style="font-size:30px">✳</div>
      <div>词库里还没有足够的关系可连线</div><div style="font-size:11px">多录几页后，派生/同义/反义关系会自动连成网</div></div>`;
    return;
  }
  const W = host.clientWidth || 800, H = host.clientHeight || 520;
  // 连通分量分组布局（v2.13）：有关系的词按"词族"聚成一簇，簇间网格排布。
  // 比纯力导向更稳定：不会贴边、不会挤成一团，派生链清晰可读。
  (function clusterLayout() {
    const parent = new Map(nodes.map(n => [n.id, n.id]));
    const find = x => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
    const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(rb, ra); };
    for (const e of (g.edges || [])) union(e.a, e.b);
    // 按根分组
    const groupsMap = new Map();
    nodes.forEach(n => { const r = find(n.id); if (!groupsMap.has(r)) groupsMap.set(r, []); groupsMap.get(r).push(n); });
    const groups = Array.from(groupsMap.values()).sort((a, b) => b.length - a.length);
    // 网格排布：列数按画布宽高比估算
    const cols = Math.max(1, Math.round(Math.sqrt(groups.length * (W / H) * 1.6)));
    const rows = Math.ceil(groups.length / cols);
    const cellW = W / cols, cellH = H / rows;
    groups.forEach((grp, gi) => {
      const gx = (gi % cols) * cellW, gy = Math.floor(gi / cols) * cellH;
      const ccx = gx + cellW / 2, ccy = gy + cellH / 2;
      if (grp.length === 1) {
        grp[0]._x = ccx; grp[0]._y = ccy;
      } else {
        // 簇内小环形排布，半径随簇大小自适应
        const r = Math.min(cellW, cellH) * (grp.length <= 4 ? 0.28 : 0.34);
        grp.forEach((n, i) => {
          const a = i / grp.length * Math.PI * 2 - Math.PI / 2;
          n._x = ccx + r * Math.cos(a);
          n._y = ccy + r * Math.sin(a);
        });
      }
    });
  })();
  const posOf = id => { const n = g.byId.get(String(id)); return n ? { x: n._x, y: n._y } : null; };
  const colorOfNode = n => {
    if ((n.tags || []).includes('进度')) return '#f59e0b';
    if ((n.tags || []).includes('已会')) return '#16a34a';
    if ((n.tags || []).includes('不会')) return '#dc2626';
    return '#2563eb';
  };
  const edgesSvg = (g.edges || []).map(e => {
    const p = posOf(e.a), q = posOf(e.b);
    if (!p || !q) return '';
    return `<line class="graph-edge ${esc(e.type)}" x1="${p.x}" y1="${p.y}" x2="${q.x}" y2="${q.y}"/>`;
  }).join('');
  const nodesSvg = nodes.map(n => `
    <g class="graph-node" onclick="graphNodeClick('${esc(n.hw)}')">
      <circle cx="${n._x}" cy="${n._y}" r="10" fill="${colorOfNode(n)}"><title>${esc(n.hw)}</title></circle>
      <text x="${n._x}" y="${n._y + 22}">${esc(n.hw)}</text>
    </g>`).join('');
  host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">
    <g id="graphZoomLayer">${edgesSvg}${nodesSvg}</g></svg>`;
  _graphTransform = { x: 0, y: 0, k: 1 };
  setupGraphPanZoom(host);
}
function graphNodeClick(hw) { jumpToWord(hw); }

function setupGraphPanZoom(host) {
  const svg = host.querySelector('svg');
  const layer = host.querySelector('#graphZoomLayer');
  if (!svg || !layer) return;
  const apply = () => layer.setAttribute('transform', `translate(${_graphTransform.x},${_graphTransform.y}) scale(${_graphTransform.k})`);
  let dragging = false, sx = 0, sy = 0, ox = 0, oy = 0, moved = 0;
  host.onpointerdown = e => { dragging = true; moved = 0; sx = e.clientX; sy = e.clientY; ox = _graphTransform.x; oy = _graphTransform.y; host.classList.add('dragging'); };
  window.onpointermove = e => {
    if (!dragging) return;
    const dx = e.clientX - sx, dy = e.clientY - sy;
    moved = Math.max(moved, Math.abs(dx) + Math.abs(dy));
    _graphTransform.x = ox + dx; _graphTransform.y = oy + dy; apply();
  };
  window.onpointerup = () => { dragging = false; host.classList.remove('dragging'); };
  host.onwheel = e => {
    e.preventDefault();
    const k = Math.min(3, Math.max(0.4, _graphTransform.k * (e.deltaY > 0 ? 0.9 : 1.1)));
    _graphTransform.k = k; apply();
  };
}

// 依据搜索词 + 当前标签，计算过滤后的列表
function computeFiltered() {
  const q = (document.getElementById('searchInput').value || '').trim().toLowerCase();
  return allWords.filter(w => {
    // 标签筛选
    if (activeTag !== '__all__' && !(w.tags || []).includes(activeTag)) return false;
    if (!q) return true;
    // 模糊搜索：英文单词 + 中文释义（含例句中文，容错）
    if ((w.headword || '').toLowerCase().includes(q)) return true;
    return (w.senses || []).some(s =>
      (s.chinese_def || s.def || '').includes(q) ||
      (s.examples || s.items || []).some(e => (e.en || '').toLowerCase().includes(q) || (e.zh || '').includes(q))
    );
  });
}

// 重新计算并从头渲染
function resetWordList() {
  filteredWords = computeFiltered();
  renderedCount = 0;
  const host = document.getElementById('wordList');
  host.innerHTML = '';
  const q = (document.getElementById('searchInput').value || '').trim();
  // 分数形式：分子 = 搜索/筛选后的数量，分母 = 全部数量
  document.getElementById('listSummary').innerHTML =
    `<b>${filteredWords.length}</b><span class="frac-sep">/</span>${allWords.length}`;
  buildAzMap();
  updateAzVisibility();
  const sentinel = document.getElementById('scrollSentinel');
  if (!filteredWords.length) {
    sentinel.classList.add('hidden');
    host.innerHTML = `<div class="empty">
      <svg viewBox="0 0 24 24" fill="none" stroke-width="1.5"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>
      <div>${q || activeTag !== '__all__' ? '没有匹配的单词' : '词库为空，先去扫描一页吧'}</div></div>`;
    return;
  }
  sentinel.classList.remove('hidden');
  appendWords();
  setupSentinelObserver();
}

// 追加下一批词条
function appendWords() {
  if (renderedCount >= filteredWords.length) {
    document.getElementById('scrollSentinel').classList.add('hidden');
    return;
  }
  const batch = filteredWords.slice(renderedCount, renderedCount + PAGE_RENDER);
  const host = document.getElementById('wordList');
  host.insertAdjacentHTML('beforeend', batch.map((w, k) => wordCardHtml(w, renderedCount + k)).join(''));
  renderedCount += batch.length;
  if (renderedCount >= filteredWords.length) {
    document.getElementById('scrollSentinel').textContent = '— 已显示全部 —';
  } else {
    document.getElementById('scrollSentinel').innerHTML = '<span class="mini-spinner"></span> 加载更多…';
  }
}

// 滚动到底自动加载（IntersectionObserver）
function setupSentinelObserver() {
  if (_sentinelObserver) { _sentinelObserver.disconnect(); _sentinelObserver = null; }
  if (typeof IntersectionObserver === 'undefined') return;   // 老浏览器兜底：用户可点哨兵
  const sentinel = document.getElementById('scrollSentinel');
  _sentinelObserver = new IntersectionObserver(entries => {
    entries.forEach(en => { if (en.isIntersecting) appendWords(); });
  }, { rootMargin: '200px' });
  _sentinelObserver.observe(sentinel);
}

// 重建学习状态筛选 chips（新三态：已会 / 不会 / 进度）
function rebuildTagFilter() {
  const PRESET = ['已会', '不会', '进度'];
  const counts = {};
  allWords.forEach(w => (w.tags || []).forEach(t => { counts[t] = (counts[t] || 0) + 1; }));
  if (activeTag !== '__all__' && !PRESET.includes(activeTag)) activeTag = '__all__';
  const dot = c => `<span class="dot" style="background:${c}"></span>`;
  const colorOf = t => t === '已会' ? '#16a34a' : t === '不会' ? '#dc2626' : '#d97706';
  const iconOf  = t => t === '已会' ? '✓' : t === '不会' ? '✕' : '📍';
  let html = `<button class="tag-chip ${activeTag === '__all__' ? 'active' : ''}" data-tag="__all__" onclick="setActiveTag('__all__')">全部</button>`;
  PRESET.forEach(t => {
    if (counts[t]) html += `<button class="tag-chip ${activeTag === t ? 'active' : ''}" data-tag="${t}" onclick="setActiveTag('${t}')">${dot(colorOf(t))}${iconOf(t)} ${t} ${counts[t]}</button>`;
  });
  document.getElementById('tagFilter').innerHTML = html;
}
function setActiveTag(tag) {
  activeTag = tag;
  rebuildTagFilter();
  resetWordList();
}

// 词卡：供 render 使用（保留原展示，附加标签徽标 + 长按/编辑按钮）
function wordCardHtml(w, i) {
  const senses = (w.senses || []).map(s => {
    // 兼容演示数据(no/usage/def)与在线数据(sense_no/usage_label/chinese_def)两套命名
    const senseNo    = s.sense_no ?? s.no ?? 0;
    const usageLabel = s.usage_label || s.usage || '';
    const defText    = s.chinese_def || s.def || '';
    const tags = [];
    if (s.countability) tags.push(`<span class="tag tag-count">${esc(s.countability)}</span>`);
    if (usageLabel)     tags.push(`<span class="tag tag-usage">${esc(usageLabel)}</span>`);
    if (s.antonym)      tags.push(`<span class="tag tag-anto">反 ${esc(s.antonym)}</span>`);
    // 义项频次：高频=实心深色序号 + "常考"标；低频=浅色
    const freq = Number(s.sense_freq || 0);
    const noCls = freq === 1 ? 'no no-high' : (freq === 2 ? 'no no-low' : 'no');
    const freqTag = freq === 1 ? '<span class="tag tag-freq">常考</span>' : '';
    const no = senseNo ? `<span class="${noCls}">${senseNo}</span>` : '';

    // 演示数据的 items 可能是嵌套结构（短语下挂 children 例句），先摊平
    const flatItems = [];
    const flatten = (arr, parent = '') => (arr || []).forEach(it => {
      flatItems.push(Object.assign({}, it, { _parent: parent }));
      if (it.children && it.children.length) flatten(it.children, it.en || parent);
    });
    flatten(s.examples || s.items || []);

    const items = flatItems.map(it => {
      const kind = it.kind === 'phrase'
        ? '<span class="kind">短语</span>' : '<span class="kind">例句</span>';
      const src = it.source ? `<span class="src">${esc(it.source)}</span>` : '';
      const gloss = it.gloss ? `<span class="gloss">${esc(it.gloss)}</span>` : '';
      const parent = (it.parent_phrase || it._parent || '')
        ? `<span class="gloss">↳ ${esc(it.parent_phrase || it._parent)}</span>` : '';
      return `<div class="item src-wrap">${kind}<span class="en">${esc(it.en || '')}</span><span class="zh">${esc(it.zh || '')}</span>${parent}${gloss}${src}</div>`;
    }).join('');

    const engDef = s.english_def ? `<div class="eng-def">${esc(s.english_def)}</div>` : '';
    return `<div class="sense"><div class="sense-hd">${no}
      <span class="pos">${esc(s.pos || '')}</span>
      <span class="def">${esc(defText)}</span>${freqTag}${tags.join('')}</div>
      ${engDef}${items}</div>`;
  }).join('');

  // v2.21.3 释义智能合并：核心释义(level_tag)与义项释义合并为一条，统一在右侧灰字展示，
  // 词头后不再显示紫色核心释义标签。归一化剥离词性/[C][U]/标点空白，只比中英文数字。
  const normDef = s => String(s || '').toLowerCase()
    .replace(/\[[^\]]*\]/g, '')
    .replace(/(?:n|v|vt|vi|adj|adv|prep|conj|pron|art|aux|int|abbr|phr)\.?\s*/gi, '')
    .replace(/[\s；;，,。:：/（）()\[\]「」·&…]/g, '');
  const coreRaw = (w.level_tag || '').trim();
  const sideRaw = (w.inline_def || (w.senses && w.senses[0] && (w.senses[0].chinese_def || w.senses[0].def)) || '').trim();
  const coreText = normDef(coreRaw), sideText = normDef(sideRaw);
  let mergedDef = '';
  if (coreRaw && sideRaw) {
    if (coreText === sideText) mergedDef = coreRaw.length >= sideRaw.length ? coreRaw : sideRaw; // 相同：取更完整
    else if (coreText.includes(sideText)) mergedDef = coreRaw;   // 核心含义项：取核心
    else if (sideText.includes(coreText)) mergedDef = sideRaw;   // 义项含核心：取义项
    else mergedDef = coreRaw + '；' + sideRaw;                    // 两个不同义项：合并保留
  } else {
    mergedDef = coreRaw || sideRaw;
  }
  const wordDefHtml = mergedDef ? `<span class="word-def">${esc(mergedDef)}</span>` : '';
  const page = w.page_no ? `<span style="font-size:11px;color:var(--muted)">P${w.page_no}</span>` : '';
  const partialTag = w.partial ? '<span class="partial-tag" title="页尾被截断，扫描下一页会自动补全">待补全</span>' : '';
  // 身份符号徽标
  const IDENTITY = { '*':'课标外', '⊕':'增补', '⊖':'删减', 'derived':'派生词' };
  let identityTag = '';
  if (w.identity_tag && IDENTITY[w.identity_tag]) {
    identityTag = `<span class="tag tag-identity id-${esc(w.identity_tag)}" title="${IDENTITY[w.identity_tag]}">${esc(w.identity_tag)}</span>`;
  }
  // 派生词来源
  const derivedTag = w.derived_from
    ? `<span class="tag tag-derived" title="派生自 ${esc(w.derived_from)}">派生自 ${esc(w.derived_from)}</span>` : '';
  // 蓝底标签框（辨/注/同/反/句型/高考链接/常用词块等）：直接显示原始类型，新增标签无需改代码
  const notesHtml = (w.notes || []).map(n => {
    const t = (n.note_type && String(n.note_type).trim()) || '注';
    const title = n.title ? `<div class="note-title">${esc(n.title)}</div>` : '';
    const content = (n.content || '').split(/\n+/).filter(Boolean)
      .map(line => `<div class="note-line">${esc(line).replace(/^•\s*/, '• ')}</div>`).join('');
    return `<div class="vw-note note-${esc(t)}"><span class="note-badge">${esc(t)}</span>${title}<div class="note-body">${content}</div></div>`;
  }).join('');
  // 词间关系网 chips（v2.13）：派生/同义/反义/辨析/同族，点击跳转对应词卡
  const relations = (cfg.demo || (w.id != null && relGraph.byId?.has(String(w.id)))) ? relationsOf(w.id) : {};
  const REL_META = {
    '派生': { cls: 'rel-derive', ico: '↳', label: '派生' },
    '同义': { cls: 'rel-syn',    ico: '≈', label: '同义' },
    '同族': { cls: 'rel-family', ico: '⁂', label: '同族' },
    '辨析': { cls: 'rel-diff',   ico: '⚖', label: '辨析' },
    '反义': { cls: 'rel-ant',    ico: '↔', label: '反义' },
  };
  let relationsHtml = '';
  const relParts = [];
  for (const [type, items] of Object.entries(relations)) {
    if (!items.length) continue;
    const meta = REL_META[type] || { cls: 'rel-other', ico: '·', label: type };
    const chips = items.map(it => it.inLib
      ? `<button class="rel-chip ${meta.cls}" onclick="jumpToWord('${esc(it.hw)}')" title="跳转到 ${esc(it.hw)}">${esc(it.hw)}</button>`
      : `<span class="rel-chip rel-ext" title="关联词，尚未收录">${esc(it.hw)}</span>`).join('');
    relParts.push(`<span class="rel-group"><span class="rel-label">${meta.ico} ${meta.label}</span>${chips}</span>`);
  }
  if (relParts.length) {
    relationsHtml = `<div class="word-relations">${relParts.join('')}</div>`;
  }
  const key = w.id != null ? ('id' + w.id) : ('hw' + esc(w.headword));
  // 新三态徽标：已会 / 不会 / 进度（互斥逻辑见 toggleStudyState）
  const tags = w.tags || [];
  const studyTags =
    (tags.includes('已会') ? '<span class="study-tag 已会">✓ 已会</span>' : '') +
    (tags.includes('不会') ? '<span class="study-tag 不会">✕ 不会</span>' : '') +
    (tags.includes('进度') ? '<span class="study-tag 进度">📍 进度</span>' : '');
  const isProgress = tags.includes('进度');
  return `<div class="word-card${isProgress ? ' is-progress' : ''}" id="wc-${key}" data-derived="${w.derived_from ? '1' : '0'}"
      oncontextmenu="event.preventDefault();revealRow('${key}')"
      ontouchstart="startLongPress('${key}',event)" ontouchend="cancelLongPress()" ontouchmove="onPressMove(event)"
      onmousedown="startLongPress('${key}',event)" onmouseup="cancelLongPress()" onmouseleave="cancelLongPress()">
    <div class="word-row">
      <div class="word-swipe">
        <div class="word-hd" onclick="toggleCard('${key}')">
          <svg class="arrow" viewBox="0 0 24 24" fill="none" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg>
          <span class="word-name">${esc(w.headword)}</span>
          <span class="word-ph">${esc(w.phonetic || '')}</span>
          ${studyTags}${identityTag}${derivedTag}${page}${partialTag}
          ${wordDefHtml}
        </div>
      </div>
      <div class="word-actions">
        <button class="act-btn${tags.includes('已会') ? ' sel-known' : ''}" onclick="toggleStudyState('${key}','已会')"><span class="ico">✓</span>已会</button>
        <button class="act-btn${tags.includes('不会') ? ' sel-wont' : ''}" onclick="toggleStudyState('${key}','不会')"><span class="ico">✕</span>不会</button>
        <button class="act-btn${isProgress ? ' sel-progress' : ''}" onclick="toggleStudyState('${key}','进度')"><span class="ico">📍</span>进度</button>
      </div>
    </div>
    <div class="word-body">
      ${senses || '<div style="font-size:13px;color:var(--muted);padding:8px 0">（无详细义项）</div>'}
      ${notesHtml}
      ${relationsHtml}
    </div>
  </div>`;
}
function toggleCard(key) {
  // 吞掉长按松开后紧随的那次 click：让操作条稳定留在屏上，不闪退
  if (_swallowNextClick) { _swallowNextClick = false; return; }
  const el = document.getElementById('wc-' + key);
  if (!el) return;
  if (_revealedKey) {
    if (_revealedKey === key) {
      // 点已展开的同一行词头 → 收起操作条，恢复正常
      collapseRevealed();
      return;
    }
    // 点其它单词 → 旧操作条退出，新词正常展开详情
    collapseRevealed();
    el.classList.toggle('open');
    return;
  }
  el.classList.toggle('open');
}

/* ---------------- 关系网跳转：定位→展开→高亮 ---------------- */
function jumpToWord(headword) {
  const norm = normHw(headword);
  const target = allWords.find(w => normHw(w.headword) === norm);
  if (!target) { toast(`词库中还没有「${headword}」`); return; }
  // 若目标被搜索/标签筛选隐藏，先清掉筛选让它出现
  const q = document.getElementById('searchInput');
  const qVal = (q && q.value || '').trim();
  const hiddenBySearch = qVal && !String(target.headword).toLowerCase().includes(qVal.toLowerCase())
    && !JSON.stringify(target.senses || []).toLowerCase().includes(qVal.toLowerCase());
  const hiddenByTag = activeTag !== '__all__' && !(target.tags || []).includes(activeTag);
  if (hiddenBySearch && q) q.value = '';
  if (hiddenByTag) activeTag = '__all__';
  if (hiddenBySearch || hiddenByTag) {
    rebuildTagFilter();
    resetWordList();
  }
  // 确保目标已渲染（无限滚动可能还没渲染到）
  let idx = filteredWords.findIndex(w => String(w.id) === String(target.id));
  if (idx < 0) idx = filteredWords.findIndex(w => normHw(w.headword) === norm);
  if (idx < 0) { toast(`未找到「${headword}」`); return; }
  let guard = 0;
  while (renderedCount <= idx && guard++ < 500) appendWords();
  const key = target.id != null ? ('id' + target.id) : ('hw' + esc(target.headword));
  const el = document.getElementById('wc-' + key);
  if (!el) { toast(`「${headword}」尚未加载`); return; }
  collapseRevealed();
  el.classList.add('open', 'jump-flash');
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  setTimeout(() => el.classList.remove('jump-flash'), 1600);
}

/* ---------------- 长按检测：左滑露出操作条 ---------------- */
let _pressTimer = null;
let _swallowNextClick = false;   // 长按松开后紧随的 click 需吞掉，避免误展开/收起
let _pressPoint = null;          // 按下起点，用于区分"微抖"与"真正滚动"
function startLongPress(key, ev) {
  cancelLongPress();
  _pressPoint = ev && ev.touches && ev.touches[0]
    ? { x: ev.touches[0].clientX, y: ev.touches[0].clientY }
    : (ev ? { x: ev.clientX, y: ev.clientY } : null);
  _pressTimer = setTimeout(() => {
    _pressTimer = null;
    _pressPoint = null;
    if (navigator.vibrate) { try { navigator.vibrate(30); } catch (e) {} }
    // 清除可能已被浏览器选中的文本，杜绝系统"复制/全选"菜单残留
    try { const s = window.getSelection(); if (s) s.removeAllRanges(); } catch (e) {}
    revealRow(key);
  }, 500);
}
function onPressMove(ev) {
  // 手指位移超过阈值才算滚动，才取消长按；轻微抖动不打断
  if (!_pressPoint || !_pressTimer) return;
  const p = ev && ev.touches && ev.touches[0] ? ev.touches[0] : ev;
  if (!p) return;
  const dx = (p.clientX || 0) - _pressPoint.x, dy = (p.clientY || 0) - _pressPoint.y;
  if (Math.hypot(dx, dy) > 12) cancelLongPress();
}
function cancelLongPress() {
  if (_pressTimer) { clearTimeout(_pressTimer); _pressTimer = null; }
  _pressPoint = null;
}

// 展开某行的操作条；再次触发同一行则收起；展开新行时收起旧行
let _revealedKey = null;
let _revealTs = 0;
function revealRow(key) {
  const el = document.getElementById('wc-' + key);
  if (!el) return;
  // 幂等：同一行已被长按唤出时，系统补发的 contextmenu / 重复事件不得把它收起。
  // （这正是"按钮一闪又缩回"的根因：定时器显示后 contextmenu 又调一次，旧逻辑当成"再点同一行"而收起。）
  if (_revealedKey === key) {
    el.classList.add('revealed');
    return;
  }
  // 展开新行前先收起旧行
  if (_revealedKey) {
    const prev = document.getElementById('wc-' + _revealedKey);
    if (prev) prev.classList.remove('revealed');
  }
  el.classList.add('revealed');
  _revealedKey = key;
  _revealTs = Date.now();
  // 长按结束后浏览器会补发一次 click，标记吞掉，避免操作条刚出现就闪退
  _swallowNextClick = true;
  setTimeout(() => { _swallowNextClick = false; }, 500);
}
function collapseRevealed() {
  if (!_revealedKey) return;
  const el = document.getElementById('wc-' + _revealedKey);
  if (el) el.classList.remove('revealed');
  _revealedKey = null;
}

/* ---------------- 词条 key → word 对象 ---------------- */
function findWordByKey(key) {
  if (key.startsWith('id')) return allWords.find(w => String(w.id) === key.slice(2));
  return allWords.find(w => ('hw' + esc(w.headword)) === key);
}

/* ============================================================
 * 学习状态：已会 / 不会（互斥） + 进度（全局唯一），存云端 tags
 * ============================================================ */
const STUDY_TAGS = ['已会', '不会', '进度'];

// 写入单个词的学习状态到「当前同步码」名下（vw_user_states），返回是否成功
async function persistStudyTags(w) {
  const newTags = Array.isArray(w.tags) ? w.tags.filter(t => STUDY_TAGS.includes(t)) : [];
  w.tags = newTags;
  if (!sync) return false;
  if (cfg.demo || w.id == null) {
    if (cfg.demo) {
      // 演示模式：按同步码存本地 LS
      const key = 'vocab_user_states_' + sync.code;
      let map = {};
      try { map = JSON.parse(localStorage.getItem(key) || '{}'); } catch (e) {}
      const wk = w.id != null ? String(w.id) : w.headword;
      map[wk] = newTags;
      localStorage.setItem(key, JSON.stringify(map));
    }
    return true;
  }
  const headers = { apikey: cfg.key, Authorization: `Bearer ${cfg.key}`, 'Content-Type': 'application/json',
    Prefer: 'resolution=merge-duplicates,return=minimal' };
  try {
    // upsert：主键 (code, word_id)，有则更新无则插入
    const r = await fetchWithRetry(`${cfg.url}/rest/v1/vw_user_states`, {
      method: 'POST', headers,
      body: JSON.stringify({ code: sync.code, word_id: w.id, tags: newTags, updated_at: new Date().toISOString() }),
    }, { timeout: 15000, retries: 1, label: '保存学习状态' });
    if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + (await r.text()).slice(0, 80));
    return true;
  } catch (e) { console.warn('保存学习状态失败', e); return false; }
}

// 点击操作按钮：已会/不会互斥，进度全局唯一（清掉其它词）
async function toggleStudyState(key, tag) {
  const w = findWordByKey(key);
  if (!w) return;
  if (!Array.isArray(w.tags)) w.tags = [];
  const had = w.tags.includes(tag);

  // 计算本次涉及的词：本身 +（进度时）被清除旧进度的词
  const affected = [];
  if (tag === '进度') {
    if (!had) {
      // 清掉其它词上的进度标记
      allWords.forEach(x => {
        if (x !== w && Array.isArray(x.tags) && x.tags.includes('进度')) {
          x.tags = x.tags.filter(t => t !== '进度');
          affected.push(x);
        }
      });
    }
    w.tags = had ? w.tags.filter(t => t !== '进度') : [...w.tags.filter(t => t !== '进度'), '进度'];
  } else {
    // 已会 / 不会互斥
    const other = tag === '已会' ? '不会' : '已会';
    w.tags = w.tags.filter(t => t !== other);          // 先移除对状态
    w.tags = had ? w.tags.filter(t => t !== tag)        // 再点同一状态 → 取消
                 : [...w.tags.filter(t => t !== tag), tag];
  }
  affected.push(w);

  // 乐观更新 UI（操作条保持展开，方便连续设置；不 collapseRevealed）
  buildAzProgress();
  rebuildTagFilter();
  refreshStudyBadges();
  if (activeTag !== '__all__') resetWordList();  // 筛选态下状态变化需重排列表

  // 云端写入
  let ok = true;
  for (const x of affected) { if (!await persistStudyTags(x)) ok = false; }
  if (!ok) toast('保存失败，请检查网络');
}

// 仅刷新已渲染词卡上的状态徽标/按钮选中态/进度高亮，避免整列表重排
function refreshStudyBadges() {
  allWords.forEach(w => {
    const key = w.id != null ? ('id' + w.id) : ('hw' + esc(w.headword));
    const el = document.getElementById('wc-' + key);
    if (!el) return;                       // 未渲染的词跳过（滚动到时按 tags 重新渲染）
    const tags = w.tags || [];
    el.classList.toggle('is-progress', tags.includes('进度'));
    const acts = el.querySelectorAll('.act-btn');
    if (acts[0]) acts[0].classList.toggle('sel-known', tags.includes('已会'));
    if (acts[1]) acts[1].classList.toggle('sel-wont', tags.includes('不会'));
    if (acts[2]) acts[2].classList.toggle('sel-progress', tags.includes('进度'));
    // 词头徽标区：找到 .word-hd 里的 study-tag 并重建
    const hd = el.querySelector('.word-hd');
    if (hd) {
      hd.querySelectorAll('.study-tag').forEach(n => n.remove());
      const ph = hd.querySelector('.word-ph');
      const html =
        (tags.includes('已会') ? '<span class="study-tag 已会">✓ 已会</span>' : '') +
        (tags.includes('不会') ? '<span class="study-tag 不会">✕ 不会</span>' : '') +
        (tags.includes('进度') ? '<span class="study-tag 进度">📍 进度</span>' : '');
      if (html) { const tmp = document.createElement('div'); tmp.innerHTML = html;
        while (tmp.firstChild) hd.insertBefore(tmp.firstChild, ph ? ph.nextSibling : hd.firstChild); }
    }
  });
}

// 操作条一经展开就保持，直到点其他单词/再次点该行才收起；滚动、松手都不影响。
// （旧的"点空白收起"逻辑已移除，避免长按松手时操作条一闪而过）

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, c =>
    ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' }[c]));
}

/* ============================================================
 * 导入记录（清单化管理）
 *  - 数据源 vw_scan_batches：每次识别入库一条记录
 *  - 列表不带 raw_result（省流量），展开某条时才按需拉取该页词表并缓存
 *  - 分页每页 20 条；支持按页码跳转定位
 * ============================================================ */
const REC_PAGE_SIZE = 20;
let recordRows = [];            // 全部记录（按页码降序、同页按时间降序）
let recordPage = 1;             // 当前分页
let recordFilterPage = null;    // 页码过滤（null=全部）
let recordRawCache = {};        // batch id -> words[]
let vocabTotal = 0;             // 词库真实词条总数，用于记录页统计，与词库页一致
const expandedRecords = new Set();

// 轻量查词库真实总数：只取 content-range，不拉词条数据体。
// 与词库页（分页拉全 allWords）指向同一真实数字，保证两处显示一致。
async function loadVocabCount() {
  if (cfg.demo) { vocabTotal = allWords.length; return; }
  if (!cfg.url || !cfg.key) { vocabTotal = 0; return; }
  try {
    const r = await fetchWithRetry(
      `${cfg.url}/rest/v1/vw_words?book_id=eq.${encodeURIComponent(cfg.book)}&select=id&limit=0`,
      { headers: { ...SYNC_HEADERS(), Prefer: 'count=exact' } },
      { timeout: 20000, retries: 1, label: '词库总数' });
    if (r.ok) {
      const m = /\/(\d+)\s*$/.exec(r.headers.get('content-range') || '');
      if (m) { vocabTotal = parseInt(m[1], 10); return; }
    }
  } catch (_) { /* 查询失败走兜底 */ }
  vocabTotal = allWords.length || vocabTotal;
}

/* ---- 云端任务执行清单（v2.16）---- */
let jobRows = [];               // 任务单列表（仅未验收：排队/执行中/待验收；已验收不展示）
let jobPages = {};              // job_id -> 明细页数组
let jobPollTimer = null;        // 有进行中任务时的轮询定时器
const expandedJobs = new Set();
let _jobEditingPage = null;     // 正在编辑页码的明细 id

/* ---------------- 云端任务执行清单（v2.16）---------------- */
function jobStatusMeta(st) {
  switch (st) {
    case 'queued':   return { cls: 'queued',   txt: '排队中' };
    case 'running':  return { cls: 'running',  txt: '执行中' };
    case 'done':     return { cls: 'done',     txt: '待验收' };
    case 'accepted': return { cls: 'accepted', txt: '已验收' };
    default:         return { cls: 'error',    txt: st || '未知' };
  }
}
function pageStatusMeta(st) {
  switch (st) {
    case 'pending': return { cls: 'pending', txt: '排队' };
    case 'running': return { cls: 'running', txt: '解析中' };
    case 'done':    return { cls: 'done',    txt: '完成' };
    case 'error':   return { cls: 'error',   txt: '失败' };
    case 'skipped': return { cls: 'pending', txt: '跳过' };
    default:        return { cls: 'pending', txt: st || '—' };
  }
}

async function loadJobs(silent) {
  const host = document.getElementById('jobList');
  if (!host) return;
  if (cfg.demo || !sync || !sync.code) {
    host.innerHTML = '<div class="job-empty">在线模式 + 同步码下可查看云端任务</div>';
    return;
  }
  if (!silent) host.innerHTML = '<div class="job-empty">加载任务清单…</div>';
  try {
    const codeQ = encodeURIComponent(sync.code);
    // 只展示未验收任务（排队/执行中/待验收）；已验收的归档后不在此列表显示。
    // tab 按钮已移除，展示形式保持原样，不再需要切换状态视图。
    const url = `${cfg.url}/rest/v1/vw_scan_jobs?sync_code=eq.${codeQ}&status=neq.accepted`
      + `&select=id,job_no,book_id,status,total_pages,done_pages,failed_pages,words_found,created_at,finished_at,accepted_at,error_msg`
      + `&order=created_at.desc&limit=60`;
    const r = await fetchWithRetry(url, { headers: SYNC_HEADERS() }, { timeout: 20000, retries: 1, label: '加载任务清单' });
    if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + (await r.text()).slice(0, 100));
    jobRows = await r.json();
    // 拉每个任务的明细页
    jobPages = {};
    await Promise.all(jobRows.map(async j => {
      try {
        const pu = `${cfg.url}/rest/v1/vw_scan_job_pages?job_id=eq.${j.id}`
          + `&select=id,seq,page_no,status,words_found,senses_found,api_calls,error_msg,finished_at`
          + `&order=seq.asc`;
        const pr = await fetchWithRetry(pu, { headers: SYNC_HEADERS() }, { timeout: 20000, retries: 1, label: '加载任务明细' });
        jobPages[j.id] = pr.ok ? await pr.json() : [];
      } catch (e) { jobPages[j.id] = []; }
    }));
    renderJobs();
    // 有进行中任务 → 自动轮询刷新（关掉页面也没关系，云端照跑；开着就实时看到进度）
    const busy = jobRows.some(j => j.status === 'running' || j.status === 'queued');
    if (busy) {
      if (!jobPollTimer) jobPollTimer = setInterval(() => {
        if (document.getElementById('page-records')?.classList.contains('active')) loadJobs(true);
        else { clearInterval(jobPollTimer); jobPollTimer = null; }
      }, 8000);
    } else if (jobPollTimer) { clearInterval(jobPollTimer); jobPollTimer = null; }
  } catch (e) {
    host.innerHTML = `<div class="job-empty">任务清单加载失败：${esc(e.message)} <button class="btn btn-ghost btn-sm" onclick="loadJobs()">重试</button></div>`;
  }
}

function renderJobs() {
  const host = document.getElementById('jobList');
  if (!host) return;
  if (!jobRows.length) {
    host.innerHTML = '<div class="job-empty">还没有任务。到「扫描」页选图提交后，任务会在这里显示。</div>';
    return;
  }
  host.innerHTML = jobRows.map(j => {
    const meta = jobStatusMeta(j.status);
    const total = Number(j.total_pages) || 0;
    const done = Number(j.done_pages) || 0;
    const failed = Number(j.failed_pages) || 0;
    const doneAll = done + failed;
    const pct = total ? Math.round(doneAll / total * 100) : 0;
    const open = expandedJobs.has(j.id) ? ' open' : '';
    const time = fmtRecTime(j.created_at);
    const pages = jobPages[j.id] || [];
    const canAccept = j.status === 'done';
    const detail = pages.map(p => {
      const pm = pageStatusMeta(p.status);
      const pg = p.page_no > 0 ? 'P' + String(p.page_no).padStart(3, '0') : '—';
      let info = '';
      if (p.status === 'done') info = `${p.words_found || 0} 词 · ${p.senses_found || 0} 义项${p.api_calls ? ' · ' + p.api_calls + ' 次识别' : ''}`;
      else if (p.status === 'error') info = esc(String(p.error_msg || '识别失败').slice(0, 40));
      else if (p.status === 'skipped') info = esc(String(p.error_msg || '该页已跳过').slice(0, 40));
      else if (p.status === 'running') info = '云端解析中…';
      else info = '等待云端执行';
      const retry = p.status === 'error'
        ? `<button class="job-retry" onclick="event.stopPropagation();retryJobPage(${p.id})">重试</button>` : '';
      // 页码可点开编辑（首字母页被误读成页码时手动修正）
      const pageCell = _jobEditingPage === p.id
        ? `<span class="job-pg-edit"><input type="number" id="jobPgInput_${p.id}" value="${p.page_no || ''}" min="1" inputmode="numeric"
             onkeydown="if(event.key==='Enter')submitJobPageNo(${p.id});if(event.key==='Escape')cancelJobPageEdit()">
           <button onclick="event.stopPropagation();submitJobPageNo(${p.id})">存</button>
           <button class="cancel" onclick="event.stopPropagation();cancelJobPageEdit()">×</button></span>`
        : `<span class="job-pg-no" title="点此修改页码" onclick="event.stopPropagation();startJobPageEdit(${p.id})">${pg}</span>`;
      return `<div class="job-page">
        ${pageCell}
        <span class="job-pg-st ${pm.cls}">${pm.txt}</span>
        <span class="job-pg-info" title="${esc(String(p.error_msg || info))}">${info}</span>
        ${retry}
      </div>`;
    }).join('');
    return `<div class="job-card${open}" id="job-${j.id}">
      <div class="job-card-head" onclick="toggleJob(${j.id})">
        <span class="job-badge ${meta.cls}">${meta.txt}</span>
        <div class="job-meta">
          <div class="job-no">${esc(j.job_no || '')} · ${time}</div>
          <div class="job-title">${total} 页 · 已入库 ${j.words_found || 0} 词${failed ? ` · ${failed} 页失败` : ''}</div>
          <div class="job-prog"><i style="width:${pct}%"></i></div>
        </div>
        ${canAccept ? `<button class="job-accept" onclick="event.stopPropagation();acceptJob(${j.id})">确认验收</button>` : ''}
        <span class="rec-arrow">›</span>
      </div>
      <div class="job-detail">
        <div class="rec-words-hd">逐页执行结果（每页识别详情）</div>
        ${detail || '<div class="job-empty">暂无明细</div>'}
      </div>
    </div>`;
  }).join('');
}

function toggleJob(id) {
  if (expandedJobs.has(id)) expandedJobs.delete(id);
  else expandedJobs.add(id);
  const el = document.getElementById('job-' + id);
  if (el) el.classList.toggle('open', expandedJobs.has(id));
}

async function acceptJob(id) {
  if (!sync || !sync.code) return;
  if (!confirm('确认验收这批任务？验收后将归档到「已验收」标签。')) return;
  try {
    const r = await fetchWithRetry(`${cfg.url}/functions/v1/job-worker`, {
      method: 'POST',
      headers: { ...SYNC_HEADERS(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'accept', job_id: id, sync_code: sync.code }),
    }, { timeout: 20000, retries: 1, label: '确认验收' });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.ok) throw new Error(d.error || '验收失败');
    toast('已验收，页码清单已更新');
    // 验收后门禁放行：这批页的批次现在应进入下方记录清单，必须重拉记录页，
    // 否则列表仍是旧的、看不到刚验收的页（如 P85）。同时刷新任务清单。
    loadRecords();
    loadJobs(true);
  } catch (e) { toast('验收失败：' + e.message); }
}

async function retryJobPage(pageId) {
  if (!sync || !sync.code) return;
  try {
    const r = await fetchWithRetry(`${cfg.url}/functions/v1/job-worker`, {
      method: 'POST',
      headers: { ...SYNC_HEADERS(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'retry', page_id: pageId, sync_code: sync.code }),
    }, { timeout: 20000, retries: 1, label: '重试该页' });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.ok) throw new Error(d.error || '重试失败');
    toast('已重新排队，云端会自动重试该页');
    loadJobs(true);
  } catch (e) { toast('重试失败：' + e.message); }
}

// 手动修正页码：首字母页被误读成页码时，点页码改正确值
function startJobPageEdit(pageId) {
  _jobEditingPage = pageId;
  renderJobs();
  const inp = document.getElementById('jobPgInput_' + pageId);
  if (inp) { inp.focus(); inp.select(); }
}
function cancelJobPageEdit() { _jobEditingPage = null; renderJobs(); }
async function submitJobPageNo(pageId) {
  if (!sync || !sync.code) return;
  const inp = document.getElementById('jobPgInput_' + pageId);
  const v = inp ? parseInt(inp.value, 10) : 0;
  if (!(v > 0)) { toast('请输入有效页码'); return; }
  const oldRow = Object.values(jobPages).flat().find(p => p.id === pageId);
  if (oldRow && oldRow.page_no === v) { _jobEditingPage = null; renderJobs(); return; }
  _jobEditingPage = null;
  toast('正在修正页码并迁移该页词条…');
  try {
    const r = await fetchWithRetry(`${cfg.url}/functions/v1/job-worker`, {
      method: 'POST',
      headers: { ...SYNC_HEADERS(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'setpage', page_id: pageId, sync_code: sync.code, new_page_no: v }),
    }, { timeout: 30000, retries: 1, label: '修正页码' });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.ok) throw new Error(d.error || '修正失败');
    toast(`页码已改为 P${String(v).padStart(3, '0')}，迁移 ${d.words_moved || 0} 个词条`);
    loadJobs(true);
    invalidateProgressCache();
    updateProgressDisplay();
  } catch (e) { toast('修正失败：' + e.message); loadJobs(true); }
}

function fmtRecTime(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);            // 转北京时间（UTC+8）
    const b = new Date(d.getTime() + 8 * 3600 * 1000);
    const p = n => String(n).padStart(2, '0');
    return `${b.getUTCFullYear()}-${p(b.getUTCMonth() + 1)}-${p(b.getUTCDate())} ${p(b.getUTCHours())}:${p(b.getUTCMinutes())}`;
  } catch (e) { return String(iso).slice(0, 16); }
}

async function loadRecords() {
  const listEl = document.getElementById('recordList');
  if (!listEl) return;
  if (cfg.demo) {
    recordRows = [];
    vocabTotal = allWords.length;
    renderRecords();
    return;
  }
  listEl.innerHTML = '<div class="rec-loading"><span class="mini-spinner"></span> 加载导入记录…</div>';
  try {
    // 词库真实总数（分页拉全口径），供下方"累计词条"显示，与词库页一致
    await loadVocabCount();
    // 验收门禁（v2.16.3）：未验收云端任务关联的批次不进入记录列表与统计。
    // 词已边跑边入库（沿用既定方案），但记录视为"待你核对"，验收后才正式计入。
    let pendingBatchIds = new Set();
    try {
      const jr = await fetchWithRetry(
        `${cfg.url}/rest/v1/vw_scan_jobs?book_id=eq.${encodeURIComponent(cfg.book)}&status=neq.accepted&select=id`,
        { headers: SYNC_HEADERS() }, { timeout: 20000, retries: 1, label: '门禁-未验收任务' });
      if (jr.ok) {
        const jobs = await jr.json();
        const ids = jobs.map(j => j.id);
        if (ids.length) {
          const pr = await fetchWithRetry(
            `${cfg.url}/rest/v1/vw_scan_job_pages?job_id=in.(${ids.join(',')})&select=batch_id`,
            { headers: SYNC_HEADERS() }, { timeout: 20000, retries: 1, label: '门禁-任务批次' });
          if (pr.ok) {
            (await pr.json()).forEach(p => { if (p.batch_id != null) pendingBatchIds.add(p.batch_id); });
          }
        }
      }
    } catch (_) { /* 门禁查询失败时保守放行，不阻断记录加载 */ }

    // 只取列表所需字段，不取 raw_result（展开时按需拉取）
    const sel = 'id,page_no,status,words_found,created_at,error_msg,prev_page_no,partial_words';
    const url = `${cfg.url}/rest/v1/vw_scan_batches?book_id=eq.${encodeURIComponent(cfg.book)}&select=${sel}&order=page_no.desc,created_at.desc`;
    const r = await fetchWithRetry(url, { headers: SYNC_HEADERS() }, { label: '加载导入记录' });
    if (!r.ok) {
      const t = await r.text();
      throw new Error(`HTTP ${r.status}: ${t.slice(0, 120)}`);
    }
    recordRows = (await r.json()).filter(b => !pendingBatchIds.has(b.id));
    recordPage = 1;
    recordFilterPage = null;
    const ji = document.getElementById('recJumpInput');
    if (ji) ji.value = '';
    renderRecords();
  } catch (e) {
    listEl.innerHTML = `<div class="rec-empty">导入记录加载失败：${esc(e.message)}<br><button class="btn btn-ghost btn-sm" onclick="loadRecords()">重试</button></div>`;
  }
}

function recFilteredRows() {
  return recordFilterPage == null
    ? recordRows
    : recordRows.filter(r => String(r.page_no) === String(recordFilterPage));
}

function renderRecords() {
  const statEl = document.getElementById('recStats');
  const listEl = document.getElementById('recordList');
  const pagerEl = document.getElementById('recPager');
  const hintEl = document.getElementById('recFilterHint');
  if (!listEl) return;

  // 统计：批次数 / 涉及页数 / 累计词条（取词库真实总数，与词库页一致）
  // 注意：不能用批次 words_found 累加——重扫/重复导入会让同一词被多次计入，导致虚高。
  const pages = new Set(recordRows.map(r => r.page_no).filter(p => p != null));
  const totalWords = vocabTotal || allWords.length;
  if (statEl) statEl.innerHTML =
    `<div class="rec-stat"><b>${recordRows.length}</b><span>导入批次</span></div>` +
    `<div class="rec-stat"><b>${pages.size}</b><span>涉及页码</span></div>` +
    `<div class="rec-stat"><b>${totalWords}</b><span>累计词条</span></div>`;

  const rows = recFilteredRows();
  const totalPages = Math.max(1, Math.ceil(rows.length / REC_PAGE_SIZE));
  if (recordPage > totalPages) recordPage = totalPages;
  if (recordPage < 1) recordPage = 1;

  if (hintEl) {
    hintEl.innerHTML = recordFilterPage == null
      ? `共 <b>${rows.length}</b> 条记录 · 每页 ${REC_PAGE_SIZE} 条，点条目查看该页导入的单词`
      : `已筛选第 <b>${recordFilterPage}</b> 页 · <b>${rows.length}</b> 条记录`;
  }

  if (!rows.length) {
    listEl.innerHTML = '<div class="rec-empty">' +
      (recordFilterPage != null ? `第 ${recordFilterPage} 页还没有导入记录` : '还没有导入记录，去扫描页导入后再来核对吧') + '</div>';
  } else {
    const start = (recordPage - 1) * REC_PAGE_SIZE;
    const slice = rows.slice(start, start + REC_PAGE_SIZE);
    listEl.innerHTML = slice.map(r => {
      const st = r.status || '';
      const badgeCls = st === 'done' ? 'done' : (st === 'detected' ? 'detected' : 'failed');
      const badgeTxt = st === 'done' ? '已入库' : (st === 'detected' ? '仅识别' : '失败');
      const open = expandedRecords.has(r.id) ? ' open' : '';
      const cnt = (st === 'done')
        ? `${Number(r.words_found) || 0} 个单词<em>已入库</em>`
        : (st === 'detected' ? '仅识别页码<em>未入库</em>' : esc((r.error_msg || '识别失败').slice(0, 24)));
      const pg = r.page_no != null ? `P${String(r.page_no).padStart(3, '0')}` : '未定页';
      return `<div class="rec-item${open}" id="rec-${r.id}" data-id="${r.id}">
        <div class="rec-head" onclick="toggleRecord('${r.id}')">
          <div class="rec-page">${pg}<small>页码</small></div>
          <div class="rec-meta">
            <div class="rec-count">${cnt}</div>
            <div class="rec-time">${fmtRecTime(r.created_at)}${r.prev_page_no ? ' · 承接 P' + String(r.prev_page_no).padStart(3, '0') : ''}</div>
          </div>
          <span class="rec-badge ${badgeCls}">${badgeTxt}</span>
          <span class="rec-arrow">›</span>
        </div>
        <div class="rec-words" style="display:${expandedRecords.has(r.id) ? 'block' : 'none'}">
          <div class="rec-words-hd">本页导入的单词（点词可跳转词库）</div>
          <div class="rec-words-body" id="recw-${r.id}"><span class="rec-word-none">加载中…</span></div>
        </div>
      </div>`;
    }).join('');

    // 展开的记录：确保词表已加载并渲染
    slice.forEach(r => { if (expandedRecords.has(r.id)) renderRecordWords(r.id); });
  }

  if (pagerEl) {
    if (recordFilterPage != null || rows.length <= REC_PAGE_SIZE) {
      pagerEl.innerHTML = '';
    } else {
      pagerEl.innerHTML =
        `<button onclick="recChangePage(-1)" ${recordPage <= 1 ? 'disabled' : ''}>‹ 上一页</button>` +
        `<span class="rec-pg">第 <b>${recordPage}</b> / ${totalPages} 页</span>` +
        `<button onclick="recChangePage(1)" ${recordPage >= totalPages ? 'disabled' : ''}>下一页 ›</button>`;
    }
  }
}

function recChangePage(delta) {
  recordPage += delta;
  renderRecords();
  const list = document.getElementById('recordList');
  if (list) list.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function toggleRecord(id) {
  if (expandedRecords.has(id)) {
    expandedRecords.delete(id);
    const item = document.getElementById('rec-' + id);
    if (item) {
      item.classList.remove('open');
      const body = item.querySelector('.rec-words');
      if (body) body.style.display = 'none';
    }
    return;
  }
  expandedRecords.add(id);
  const item = document.getElementById('rec-' + id);
  if (item) {
    item.classList.add('open');
    const body = item.querySelector('.rec-words');
    if (body) body.style.display = 'block';
  }
  await renderRecordWords(id);
}

async function renderRecordWords(id) {
  const host = document.getElementById('recw-' + id);
  if (!host) return;
  if (recordRawCache[id] == null) {
    try {
      const url = `${cfg.url}/rest/v1/vw_scan_batches?id=eq.${encodeURIComponent(id)}&select=raw_result`;
      const r = await fetchWithRetry(url, { headers: SYNC_HEADERS() }, { label: '加载该页词表' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const arr = await r.json();
      const rr = arr && arr[0] && arr[0].raw_result;
      recordRawCache[id] = (rr && Array.isArray(rr.words)) ? rr.words : [];
    } catch (e) {
      host.innerHTML = `<span class="rec-word-none">加载失败：${esc(e.message)} <button class="btn btn-ghost btn-sm" onclick="retryRecordWords('${id}')">重试</button></span>`;
      return;
    }
  }
  const words = recordRawCache[id];
  if (!words.length) {
    host.innerHTML = '<span class="rec-word-none">该条记录没有入库词条（仅识别页码或识别失败）</span>';
    return;
  }
  host.innerHTML = words.map(w => {
    const hw = w.headword || w.word || '';
    let def = '';
    const ss = w.senses || [];
    if (ss.length) {
      const s0 = ss[0] || {};
      def = s0.chinese_def || s0.def || s0.english_def || '';
    }
    if (!def && w.inline_def) def = w.inline_def;
    return `<div class="rec-word" onclick="recWordJump('${esc(hw).replace(/'/g, "\\'")}')" title="跳转到词库中的 ${esc(hw)}">
      <b>${esc(hw)}</b><span>${esc(String(def).slice(0, 22))}</span></div>`;
  }).join('');
}

function retryRecordWords(id) {
  delete recordRawCache[id];
  renderRecordWords(id);
}

function recWordJump(headword) {
  switchPage('words');
  setTimeout(() => { if (typeof jumpToWord === 'function') jumpToWord(headword); }, 120);
}

function jumpToRecordPage() {
  const inp = document.getElementById('recJumpInput');
  const v = (inp && inp.value || '').trim();
  if (!v || !/^\d+$/.test(v)) { toast('请输入有效的页码数字'); return; }
  const pg = Number(v);
  if (!recordRows.length) { toast('暂无导入记录'); return; }
  // 在全部记录里找该页第一条（列表按页码降序，同页第一条即最新导入）
  const idx = recordRows.findIndex(r => String(r.page_no) === String(pg));
  if (idx < 0) { toast(`第 ${pg} 页还没有导入记录`); return; }
  recordFilterPage = pg;
  recordPage = 1;
  const row = recordRows[idx];
  if (row.status === 'done') expandedRecords.add(row.id);
  renderRecords();
  setTimeout(() => {
    const item = document.getElementById('rec-' + row.id);
    if (item) {
      item.classList.add('focus-flash');
      item.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setTimeout(() => item.classList.remove('focus-flash'), 1800);
    }
  }, 80);
}

function resetRecordFilter() {
  recordFilterPage = null;
  recordPage = 1;
  const ji = document.getElementById('recJumpInput');
  if (ji) ji.value = '';
  renderRecords();
}

/* ---------------- 初始化 ---------------- */
(async function init() {
  // 回填设置表单
  document.getElementById('cfgUrl').value  = cfg.url;
  document.getElementById('cfgKey').value  = cfg.key;
  document.getElementById('cfgBook').value = cfg.book;
  document.getElementById('demoSwitch').classList.toggle('on', cfg.demo);
  applyMode();
  renderVersion();
  initAzIndex();

  if (sync) {
    // 已有同步码：先关掉 HTML 里默认 show 的门禁遮罩，避免每次刷新都弹输入框
    // （同步码早已记在 localStorage，这里只补上"遮罩关闭"这一步）
    document.getElementById('syncGate').classList.remove('show');
    applyGating();
    await refreshWords();
    if (isSuper()) loadSyncCodeList();
    restoreUiState();          // 恢复离开时的页面/筛选/搜索/滚动位置
  } else {
    // 无同步码：弹门禁框（首次进入），词库先留空
    applyGating();
    openSyncGate(false);
  }
  // 预取扫描进度（弹框弹出时可直接用），失败不影响
  updateProgressDisplay();
})();

// 恢复会话现场：页面 / 筛选 / 搜索词 / 滚动位置（词表已由 refreshWords 渲染好）
function restoreUiState() {
  const st = loadUiState();
  if (!st || !st.ts) return;
  // 恢复搜索词与筛选（需先于 resetWordList 生效）
  const qEl = document.getElementById('searchInput');
  if (qEl && typeof st.q === 'string') qEl.value = st.q;
  if (st.activeTag) activeTag = st.activeTag;
  // 恢复页面：无论目标是不是词库页，都先把 HTML 默认的 scan 页切到目标页
  const target = st.page && document.getElementById('page-' + st.page) ? st.page : 'words';
  if (target !== 'words') {
    switchPage(target);            // switchPage 内部会校验同步码权限
  } else {
    // 词库页：切页 + 按恢复的筛选/搜索重算列表（不经过 switchPage 以免重复 reset）
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.getElementById('page-words').classList.add('active');
    document.querySelectorAll('nav button').forEach(b =>
      b.classList.toggle('active', b.dataset.page === 'words'));
    activeTag = st.activeTag || '__all__';
    rebuildTagFilter();
    resetWordList();
    updateAzVisibility();
  }
  // 恢复滚动位置：无限滚动初次只渲染 30 条，需先补渲染到目标高度，再多帧重试
  if (target === 'words' && st.scrollY > 0) {
    let tries = 0;
    const doScroll = () => {
      let max = document.documentElement.scrollHeight - window.innerHeight;
      // 高度不够时主动补渲染下一批，直到够高或无更多词
      let guard = 0;
      while (max < st.scrollY + 40 && renderedCount < filteredWords.length && guard++ < 40) {
        appendWords();
        max = document.documentElement.scrollHeight - window.innerHeight;
      }
      const y = Math.min(st.scrollY, Math.max(0, max));
      window.scrollTo(0, y);
      if (Math.abs(window.scrollY - st.scrollY) > 8 && tries++ < 12) requestAnimationFrame(doScroll);
      else saveUiState();
    };
    requestAnimationFrame(doScroll);
  }
}
