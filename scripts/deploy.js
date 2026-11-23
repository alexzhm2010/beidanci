#!/usr/bin/env node
/**
 * 提交并部署辅助脚本 (沙箱 git push 被代理拦截时使用)
 * 流程: 收集改动文件 -> 校验版本号三处一致 -> 提交 commit -> 通过 GitHub API 更新 main
 * 用法: node scripts/deploy.js "提交说明"
 * 前置: 从 ~/.github_token 或环境变量 GITHUB_TOKEN 读取凭证
 */
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const owner = 'alexzhm2010';
const repo = 'beidanci';
const branch = 'main';

const token = (() => {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  const tokenFile = path.join(process.env.HOME || '/root', '.github_token');
  if (fs.existsSync(tokenFile)) return fs.readFileSync(tokenFile, 'utf8').trim();
  console.error('未找到 GitHub 凭证');
  process.exit(1);
})();

const message = process.argv[2] || 'chore: update';
const API = 'https://api.github.com';
const HEADERS = {
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'beidanci-deploy-script',
};

function apiGet(url) {
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const out = execFileSync('curl', ['-sS', '--max-time', '60', '-H', `Authorization: Bearer ${token}`,
        '-H', 'Accept: application/vnd.github+json', '-H', 'User-Agent: beidanci-deploy-script', url],
        { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
      return JSON.parse(out);
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

function apiWrite(url, method, payload) {
  const args = ['-sS', '--max-time', '120', '-X', method, '-H', `Authorization: Bearer ${token}`,
    '-H', 'Accept: application/vnd.github+json', '-H', 'Content-Type: application/json',
    '-H', 'User-Agent: beidanci-deploy-script'];
  // 通过 stdin 传 JSON 而非命令行参数, 避免大文件(如 158KB 的 app.js)超过 ARG_MAX
  let input;
  if (payload) {
    args.push('--data-binary', '@-');
    input = JSON.stringify(payload);
  }
  args.push(url);
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const out = execFileSync('curl', args, { encoding: 'utf8', input, maxBuffer: 32 * 1024 * 1024 });
      return out ? JSON.parse(out) : {};
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

// ---- 校验版本号三处一致 ----
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
const cfg = fs.readFileSync(path.join(root, 'src/core/config.js'), 'utf8');
const cfgVer = (cfg.match(/APP_VERSION:\s*'([^']+)'/) || [])[1];
const versions = { 'package.json': pkg.version, 'package-lock.json': lock.version, 'config.js': cfgVer };
const uniq = new Set(Object.values(versions));
console.log('版本号检查:', JSON.stringify(versions));
if (uniq.size !== 1) {
  console.error('版本号不一致，请先运行 node scripts/bump-version.js');
  process.exit(1);
}

// ---- 收集本地相对 HEAD 的改动文件 ----
const changed = execFileSync('git', ['diff', '--name-only', 'HEAD'], { cwd: root, encoding: 'utf8' })
  .trim().split('\n').filter(Boolean);
const untrackedRaw = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' });
const untracked = untrackedRaw.trim().split('\n').filter(Boolean).filter(f => !f.includes('node_modules') && !f.includes('dist/'));
const files = [...new Set([...changed, ...untracked])];
if (files.length === 0) {
  console.log('没有需要提交的改动');
  process.exit(0);
}
console.log('待提交文件:', files.join(', '));

// ---- 通过 GitHub API 创建 commit ----
const ref = apiGet(`${API}/repos/${owner}/${repo}/git/ref/heads/${branch}`);
const baseCommit = apiGet(`${API}/repos/${owner}/${repo}/git/commits/${ref.object.sha}`);
const baseTreeSha = baseCommit.tree.sha;

const tree = files.map(file => {
  const content = fs.readFileSync(path.join(root, file));
  // 根据扩展名决定 encoding: 二进制文件用 base64
  const isBinary = /\.(png|jpg|jpeg|gif|gz|zip|ico|webp)$/i.test(file);
  const blob = apiWrite(`${API}/repos/${owner}/${repo}/git/blobs`, 'POST', {
    content: isBinary ? content.toString('base64') : content.toString('utf8'),
    encoding: isBinary ? 'base64' : 'utf-8',
  });
  return { path: file, mode: '100644', type: 'blob', sha: blob.sha };
});

const newTree = apiWrite(`${API}/repos/${owner}/${repo}/git/trees`, 'POST', {
  base_tree: baseTreeSha,
  tree,
});
const newCommit = apiWrite(`${API}/repos/${owner}/${repo}/git/commits`, 'POST', {
  message,
  tree: newTree.sha,
  parents: [ref.object.sha],
});
apiWrite(`${API}/repos/${owner}/${repo}/git/refs/heads/${branch}`, 'PATCH', { sha: newCommit.sha, force: false });

console.log(`已提交: ${newCommit.sha.slice(0, 12)}`);
console.log(`版本: ${pkg.version}`);
console.log(`GitHub Pages 将自动部署，约 1-2 分钟后可访问`);
// 同步本地 HEAD (fetch + reset 需要 git 走代理可能失败，仅提示)
console.log('提示: 如本地 git 状态不同步，运行 git fetch origin && git reset --hard origin/main');
