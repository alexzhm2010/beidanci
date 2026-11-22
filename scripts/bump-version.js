#!/usr/bin/env node
/**
 * 版本号统一升级脚本
 * 用法: node scripts/bump-version.js [patch|minor|major]
 * 默认 patch。会同步更新以下三处，确保版本号一致:
 *   1. package.json -> version
 *   2. package-lock.json -> version (顶层) 和 packages[""].version
 *   3. src/core/config.js -> APP_VERSION
 * 每次代码改动提交前先运行此脚本。
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pkgPath = path.join(root, 'package.json');
const lockPath = path.join(root, 'package-lock.json');
const cfgPath = path.join(root, 'src/core/config.js');

const bumpType = (process.argv[2] || 'patch').toLowerCase();

const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const cur = pkg.version;
if (!/^\d+\.\d+\.\d+$/.test(cur)) {
  console.error('当前版本号格式异常:', cur);
  process.exit(1);
}
let [major, minor, patch] = cur.split('.').map(Number);
if (bumpType === 'major') { major++; minor = 0; patch = 0; }
else if (bumpType === 'minor') { minor++; patch = 0; }
else { patch++; }
const next = `${major}.${minor}.${patch}`;

// 1. package.json (保持原有 2 空格缩进风格)
pkg.version = next;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

// 2. package-lock.json (只改顶层 version 与根 package 的 version, 不动依赖版本)
const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
lock.version = next;
if (lock.packages && lock.packages['']) lock.packages[''].version = next;
fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n');

// 3. config.js APP_VERSION
let cfg = fs.readFileSync(cfgPath, 'utf8');
const re = /(APP_VERSION:\s*)'[^']*'/;
if (!re.test(cfg)) {
  console.error('config.js 中未找到 APP_VERSION');
  process.exit(1);
}
cfg = cfg.replace(re, `$1'${next}'`);
fs.writeFileSync(cfgPath, cfg);

console.log(`版本号已升级 (${bumpType}): ${cur} -> ${next}`);
console.log('已同步: package.json / package-lock.json / src/core/config.js');
