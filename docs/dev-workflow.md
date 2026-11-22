# 开发流程约定（版本号 + 提交 + 部署）

> 目标：保证「代码版本 = 仓库版本 = 线上部署版本」三者始终一致，杜绝"改了代码但线上还是旧版"或"版本号对不上"的问题。

## 核心原则

**版本号升级、代码改动、提交必须在同一个动作里完成，然后一次性推送，由 GitHub Actions 自动部署。**

不要"先部署再升级版本号"——那样仓库版本号会领先线上版本，反而对不上。

## 版本号定义位置（共 3 处，必须一致）

| 文件 | 字段 |
|---|---|
| `package.json` | `version` |
| `package-lock.json` | 顶层 `version` + `packages[""].version` |
| `src/core/config.js` | `APP_VERSION` |

> 历史上曾出现过只改前两处、漏掉 `package-lock.json` 的情况（1.17.1 时 lock 文件还停在 1.17.0）。现已由脚本统一处理。

版本号规则：语义化 `MAJOR.MINOR.PATCH`
- 小修复/小改动 → `patch`（默认）
- 新增功能 → `minor`
- 重大重构/不兼容 → `major`

## 每次修改的标准流程

```bash
cd /workspace/beidanci

# 1. 改代码（正常编辑文件）

# 2. 升级版本号（三处一起同步；不传参数默认 patch）
node scripts/bump-version.js          # 或 minor / major

# 3. 提交 + 推送 + 触发部署（一条命令搞定）
node scripts/deploy.js "本次改动说明"

# 4. 同步本地仓库（deploy 脚本走 API，本地 git 需手动对齐）
git fetch origin main && git reset --hard origin/main
```

`deploy.js` 会自动：
1. 校验三处版本号一致（不一致直接报错退出）
2. 收集所有改动文件（含新增）
3. 通过 GitHub API 创建提交并更新 `main`
4. 触发 GitHub Pages 自动部署

## 部署验证

提交后约 1-2 分钟，用以下命令确认部署成功：

```bash
TOKEN=$(cat ~/.github_token)
curl -sS -H "Authorization: Bearer $TOKEN" \
  "https://api.github.com/repos/alexzhm2010/beidanci/actions/runs?per_page=1" \
  | python3 -c "import sys,json; r=json.load(sys.stdin)['workflow_runs'][0]; print(r['status'], r.get('conclusion'), r['head_sha'][:12])"
```

看到 `completed success` 且 `head_sha` 与本次提交一致，即为部署成功。

## 环境说明

- 本地直连 `github.com` 被代理劫持返回 502，已在 `/etc/hosts` 写入 GitHub 真实 IP 绕过
- 凭证存于 `~/.github_token`（权限 600），`deploy.js` 会自动读取
- `git push` 通道不稳定，`deploy.js` 改用 GitHub REST API 提交，更可靠
- 若 hosts 被重置导致 git 操作失败，重新写入：
  ```
  140.82.112.5 api.github.com
  140.82.112.3 github.com
  140.82.113.3 www.github.com
  185.199.108.133 raw.githubusercontent.com
  140.82.112.9 codeload.github.com
  ```
