# Admin 运营后台技术方案

> 版本: v1.0 (配套前端 v1.9.x) · 状态: 待确认

## 1. 设计原则与决策锁定

| 决策项 | 选择 | 说明 |
|---|---|---|
| 导航改造 | admin 登录后隐藏 学习/统计, 改为 看板/词库/用户/设置 四页 | 不污染普通用户视图 |
| 阶段划分 | 按学段: 小学/初中/高中/大学/考研 + 其他 | 学段是递进模型 |
| stage 语义 | "该单词的最高掌握学段" | 选大学必含高中以下词 |
| 同步语义 | 一次性复制到私有 words 表, 后续预置库变更不影响已同步用户 | 学习进度归用户所有 |
| 去重规则 | 同步时按 `word` 字段去重, 已存在跳过, 不覆盖用户学习进度 | 避免重复同步覆盖 |
| "其他"处理 | 方案A: 独立补充包, 默认不同步, 用户可选勾选 | 避免无法归类词塞给所有用户 |

## 2. 页面与交互

### 2.1 导航路由 (app.js / index.html 改造)

普通用户导航保持 `学习/词库/统计/我的`。
admin 登录后 (识别 `username === ADMIN_CODE`) 主导航替换为:

```
看板 | 词库 | 用户 | 设置
```

- [app.js](file:///workspace/js/app.js): `switchTab` 增加身份判断, admin 调 `App.Admin.show(tab)`, 普通用户走原逻辑
- [index.html](file:///workspace/index.html#L26-L32): nav 区按身份渲染不同按钮组 (运行时 JS 动态注入, 不改 HTML 静态结构)

### 2.2 页面1: 运营看板 (现有增强)

现状: [admin.js renderDashboard](file:///workspace/js/admin.js#L282) 已实现收入/用户/到期/月度图表。

增强项:
- 活跃度健康度: 日活、7日留存、人均复习词数 (扩 `admin_dashboard` RPC 返回)
- 到期提醒加快捷续费按钮 (直接按当前促销续期, 复用现有 `admin_authorize` RPC)
- 图表时间范围切换: 本月/本季/本年 (前端切换 + 传参给 RPC)

### 2.3 页面2: 词库管理 (全新, 核心)

#### 2.3.1 预置词库维护 (admin)

页面区块:
- **学段筛选**: tab 切换 小学/初中/高中/大学/考研/其他, 当前学段单词列表
- **单词列表**: 表格展示 word/phonetic/part_of_speech/chinese_meaning/stage, 支持编辑/删除
- **单个新增**: 表单录入 (word, phonetic, part_of_speech, chinese_meaning, example_sentence, stage)
- **批量导入**: 复用现有 [library.js xlsx 导入](file:///workspace/js/library.js) 逻辑, 解析 Excel 后批量插入 `preset_words`
- **学段统计**: 每学段单词数概览

#### 2.3.2 普通用户同步入口 (词库页, 非admin)

普通用户在词库页 (现有 [library toolbar](file:///workspace/index.html#L89-L118)) 新增按钮「同步预置词库」, 点击弹窗:
- 学段选择 (小学/初中/高中/大学/考研)
- 勾选项: 「同时同步"其他"词汇 (无法归类的补充包)」
- 确认后调 `sync_preset_words` RPC, 提示同步数量

### 2.4 页面3: 用户管理 (现有增强)

现状: [admin.js renderUserManagement](file:///workspace/js/admin.js#L426) 有授权/吊销/列表/搜索。

增强项:
- **用户详情抽屉**: 点击用户展开, 显示学习数据 (总词数、掌握度、最近活跃、最近复习记录), 需扩 `admin_list_users` 或新增 `admin_get_user_detail` RPC
- **续费/改期**: 除现有"按促销授权"外, 支持指定到期日 (扩 `admin_authorize` 增 `p_expires_at` 参数)
- **账号运维**: 重置用户密码 (走 [update-password Edge Function](file:///workspace/supabase/functions/update-password/index.ts), admin 模式需 service_role)
- **分页与筛选**: 用户列表加分页 (现有 limit=100, 改为分页), 增状态筛选 (已授权/已过期/已吊销)

### 2.5 页面4: 运营设置 (合并整合)

合并现有促销+留言, 再加功能开关与系统信息:
- **促销配置**: 现有 [renderPromoSettings](file:///workspace/js/admin.js#L629) 保留
- **留言管理**: 现有 [renderMessageManagement](file:///workspace/js/admin.js#L694) 保留, 历史留言加编辑功能 (非仅归档)
- **功能开关**: 开关试用、捐赠入口、扫词功能等 (新增 `feature_flags` 表)
- **系统信息**: 当前版本号 ([config.js APP_VERSION](file:///workspace/js/config.js)), Edge Function 部署状态提示, 数据库迁移版本

## 3. 数据库设计

### 3.1 新增表: preset_words

```sql
-- 预置词库 (admin 维护, 普通用户通过 RPC 只读同步)
CREATE TABLE IF NOT EXISTS preset_words (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  word TEXT NOT NULL,
  phonetic TEXT DEFAULT '',
  part_of_speech TEXT DEFAULT '',
  chinese_meaning TEXT DEFAULT '',
  example_sentence TEXT DEFAULT '',
  stage TEXT NOT NULL CHECK (stage IN ('小学','初中','高中','大学','考研','其他')),
  stage_order INT NOT NULL,  -- 小学=1, 初中=2, 高中=3, 大学=4, 考研=5, 其他=99
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- 同单词同词性唯一约束 (防止 admin 录入重复词)
CREATE UNIQUE INDEX IF NOT EXISTS preset_words_word_pos_uq
  ON preset_words(word, part_of_speech);

-- 按学段查询索引
CREATE INDEX IF NOT EXISTS preset_words_stage_order_idx ON preset_words(stage_order);

-- 自动维护 updated_at
CREATE OR REPLACE TRIGGER preset_words_updated_at
BEFORE UPDATE ON preset_words
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
```

### 3.2 新增表: feature_flags (可选, 后续)

```sql
-- 功能开关 (admin 维护, 普通用户只读)
CREATE TABLE IF NOT EXISTS feature_flags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  flag_key TEXT NOT NULL UNIQUE,  -- 如 'enable_trial', 'enable_donate', 'enable_scan_word'
  flag_value BOOLEAN NOT NULL DEFAULT true,
  description TEXT DEFAULT '',
  updated_at TIMESTAMPTZ DEFAULT now()
);
```

### 3.3 RLS 策略

```sql
-- preset_words: admin 可写 (通过 RPC SECURITY DEFINER), 普通用户不可直查 (只能通过 sync RPC)
ALTER TABLE preset_words ENABLE ROW LEVEL SECURITY;
ALTER TABLE preset_words FORCE ROW LEVEL SECURITY;
-- 不建任何直查策略, 所有访问走 RPC (SECURITY DEFINER 绕过 RLS)

-- feature_flags: 普通用户只读
ALTER TABLE feature_flags ENABLE ROW LEVEL SECURITY;
CREATE POLICY feature_flags_read ON feature_flags
  FOR SELECT TO authenticated USING (true);
-- 写操作走 admin RPC (SECURITY DEFINER)
```

### 3.4 新增 RPC 清单

```sql
-- 1. 普通用户: 同步预置词库到私有 words 表
CREATE OR REPLACE FUNCTION sync_preset_words(
  p_stage TEXT,                  -- 学段名: 小学/初中/高中/大学/考研
  p_include_other BOOLEAN DEFAULT FALSE  -- 是否同时同步"其他"词汇
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_stage_order INT;
  v_inserted INT := 0;
  v_skipped INT := 0;
BEGIN
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
  END IF;

  -- 学段名转 order
  v_stage_order := CASE p_stage
    WHEN '小学' THEN 1 WHEN '初中' THEN 2 WHEN '高中' THEN 3
    WHEN '大学' THEN 4 WHEN '考研' THEN 5 ELSE NULL
  END;

  IF v_stage_order IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_stage');
  END IF;

  -- 复制预置词到用户私有 words 表, 按 word 去重跳过已存在
  INSERT INTO words (id, user_id, word, phonetic, part_of_speech, chinese_meaning,
                     example_sentence, total_count, known_count, created_at, updated_at)
  SELECT gen_random_uuid(), v_user_id, p.word, p.phonetic, p.part_of_speech,
         p.chinese_meaning, p.example_sentence, 0, 0, now(), now()
  FROM preset_words p
  WHERE (p.stage_order <= v_stage_order OR (p_include_other AND p.stage = '其他'))
    AND NOT EXISTS (
      SELECT 1 FROM words w
      WHERE w.user_id = v_user_id AND w.word = p.word
    );
  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  SELECT count(*) INTO v_skipped FROM preset_words p
  WHERE (p.stage_order <= v_stage_order OR (p_include_other AND p.stage = '其他'))
    AND EXISTS (SELECT 1 FROM words w WHERE w.user_id = v_user_id AND w.word = p.word);

  RETURN jsonb_build_object(
    'success', true,
    'inserted', v_inserted,
    'skipped', v_skipped
  );
END;
$$;

-- 2. admin: 预置词 CRUD (单条增改删, 走 admin 鉴权)
--    复用现有 admin_*_pwd_hash 鉴权模式
CREATE OR REPLACE FUNCTION admin_add_preset_word(
  p_admin_pwd_hash TEXT,
  p_word TEXT, p_phonetic TEXT, p_part_of_speech TEXT,
  p_chinese_meaning TEXT, p_example_sentence TEXT, p_stage TEXT
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_admin_ok BOOLEAN; v_order INT;
BEGIN
  SELECT verify_admin(p_admin_pwd_hash) INTO v_admin_ok;
  IF NOT v_admin_ok THEN RETURN jsonb_build_object('success', false, 'error', 'unauthorized'); END IF;
  v_order := CASE p_stage WHEN '小学' THEN 1 WHEN '初中' THEN 2 WHEN '高中' THEN 3
                          WHEN '大学' THEN 4 WHEN '考研' THEN 5 ELSE 99 END;
  INSERT INTO preset_words(word, phonetic, part_of_speech, chinese_meaning, example_sentence, stage, stage_order)
  VALUES (p_word, p_phonetic, p_part_of_speech, p_chinese_meaning, p_example_sentence, p_stage, v_order);
  RETURN jsonb_build_object('success', true);
END; $$;

-- 同理 admin_update_preset_word / admin_delete_preset_word / admin_list_preset_words
-- (省略, 结构与 admin_add 一致, 加 p_word_id 参数)

-- 3. admin: 批量导入预置词 (配合 xlsx 批量插入)
CREATE OR REPLACE FUNCTION admin_batch_add_preset_words(
  p_admin_pwd_hash TEXT,
  p_words JSONB  -- [{word, phonetic, part_of_speech, chinese_meaning, example_sentence, stage}, ...]
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_admin_ok BOOLEAN; v_count INT := 0; v_dup INT := 0;
BEGIN
  SELECT verify_admin(p_admin_pwd_hash) INTO v_admin_ok;
  IF NOT v_admin_ok THEN RETURN jsonb_build_object('success', false, 'error', 'unauthorized'); END IF;

  INSERT INTO preset_words(word, phonetic, part_of_speech, chinese_meaning, example_sentence, stage, stage_order)
  SELECT w->>'word', w->>'phonetic', w->>'part_of_speech', w->>'chinese_meaning',
         w->>'example_sentence', w->>'stage',
         CASE w->>'stage' WHEN '小学' THEN 1 WHEN '初中' THEN 2 WHEN '高中' THEN 3
                          WHEN '大学' THEN 4 WHEN '考研' THEN 5 ELSE 99 END
  FROM jsonb_array_elements(p_words) AS w
  ON CONFLICT (word, part_of_speech) DO NOTHING;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN jsonb_build_object('success', true, 'inserted', v_count);
END; $$;
```

> 注: 假设 `verify_admin(pwd_hash)` 函数已存在 (现有 admin RPC 都依赖它, 复用即可)。若实际名为 `admin_verify` 等, 实施时按现有名称对齐。

### 3.5 现有表/函数调整

- `admin_authorize` RPC: 增可选参数 `p_expires_at` (TIMESTAMPTZ), 传则按指定日期授权, 不传则按促销
- `admin_dashboard` RPC: 返回结构增加 `activity` 字段 (日活、7日留存、人均复习词数)

## 4. 前端代码改造

### 4.1 admin.js 重构 (多 tab 路由)

现状 [admin.js show()](file:///workspace/js/admin.js#L109) 一次性渲染 4 个区块塞进 profile 容器。改为:

- `show(tab)`: 接收 tab 参数 (dashboard/wordbook/users/settings), 只渲染当前 tab 对应区块
- 顶部加 admin 专属 tab 导航栏 (4 个按钮, 切换互斥)
- 各 `renderXxx` 函数保持, 改为按 tab 按需调用
- 新增 `renderWordbookManage()` 函数: 预置词库 CRUD 界面

### 4.2 app.js 改造 (身份分流导航)

现状 [app.js](file:///workspace/js/app.js) 在"我的"页判断 admin。改为:
- `initNav()`: 启动时检查身份, admin 注入专属 nav HTML, 普通用户用原 nav
- `switchTab(tab)`: admin 调 `App.Admin.show(tab)`, 普通用户走原 `switchView`

### 4.3 library.js 改造 (普通用户同步入口)

现状 [library.js](file:///workspace/js/library.js) 是私有词库管理。增加:
- toolbar 新增「同步预置词库」按钮
- 点击弹窗 (复用现有 modal): 学段单选 + "其他"勾选 + 确认
- 调 `App.DB.rpc('sync_preset_words', {p_stage, p_include_other})`, 提示结果

### 4.4 db.js 改造 (新增 RPC 调用封装)

现状 [db.js](file:///workspace/js/db.js) `rpc()` 函数已通用, 无需改核心。新增封装:
- `syncPresetWords(stage, includeOther)`: 调 sync_preset_words
- admin 相关 RPC 调用在 admin.js 内部封装即可, 不污染 db.js

## 5. 实施清单与顺序

| 序号 | 任务 | 依赖 | 备注 |
|---|---|---|---|
| 1 | SQL: 建 preset_words 表 + RLS + sync_preset_words RPC | 无 | 用 Supabase CLI 部署 |
| 2 | SQL: 建 admin_*_preset_word 系列 RPC | 1 | 同批部署 |
| 3 | SQL: 调整 admin_authorize / admin_dashboard | 无 | 可与 1 同批 |
| 4 | 前端: app.js 身份分流导航 + index.html 不改 | 3 | 改 app.js |
| 5 | 前端: admin.js 重构多 tab 路由 | 4 | 大改, 保留现有 4 区块逻辑 |
| 6 | 前端: admin.js 新增 renderWordbookManage | 2, 5 | 新页面 |
| 7 | 前端: library.js 同步预置词库入口 | 1 | 普通用户侧 |
| 8 | 前端: db.js RPC 封装 (syncPresetWords) | 1 | 小改 |
| 9 | 版本号: config.js + index.html 升 v1.10.0 | 全部完成 | minor 版本 |

## 6. 范围控制

本方案只覆盖 admin 后台四页 + 预置词库同步。以下不在本期范围:
- feature_flags 表与功能开关 UI (列为后续, 表先建好)
- 用户密码重置 Edge Function admin 模式 (复用现有 update-password, 后续再加 admin 旁路)
- 学习数据详情的复杂分析 (本期只展示基础字段)
