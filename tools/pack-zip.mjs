// 一键打发布包：把本仓库（面板本体）打成可上传 Cloudflare / 也能直接解压查看的 zip
// 用法：node tools/pack-zip.mjs [--out <路径>]
//
// 设计要点：
//   · 不依赖任何第三方包（用的是面板自己的 src/ext-zip.js，零依赖）
//   · 排除清单和 .gitignore 一致：个人笔记、依赖目录、本地缓存、构建产物都不进包
//   · 文件名带版本号（daily-checkin-panel-v2.10.0.zip），发布页一眼能对上
//   · 打完打印 SHA-256，方便在 Release 说明里贴出来做完整性校验
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildZip } from '../src/ext-zip.js';
import { PANEL_VERSION } from '../src/version.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// 不进发布包的东西。凡是写在这里的，都必须是「本机/个人」私有物，
// 否则开源用户下载后会缺文件（比如 .dev.vars.example 要留，.dev.vars 不留）。
const EXCLUDE = new Set([
  'node_modules', '.git', '.wrangler', '.DS_Store', 'dist', '.dev.vars', '.env',
  '项目文档-记忆与踩坑.md', // 个人开发笔记（大量线上调试历史），只留本地
  '_tmp', 'release',
]);
const EXCLUDE_EXT = ['.zip', '.log'];

const files = [];
function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (EXCLUDE.has(name)) continue;
    if (EXCLUDE_EXT.some((e) => name.endsWith(e))) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else files.push({ name: relative(root, p).split('\\').join('/'), data: readFileSync(p) });
  }
}
walk(root);
files.sort((a, b) => a.name.localeCompare(b.name));

const zip = buildZip(files);
const outArg = process.argv.indexOf('--out');
const out = outArg > -1 && process.argv[outArg + 1]
  ? resolve(process.argv[outArg + 1])
  : join(root, 'release', `daily-checkin-panel-v${PANEL_VERSION}.zip`);
mkdirSync(dirname(out), { recursive: true }); // release/ 可能还不存在（单独跑本脚本时）
writeFileSync(out, zip);

const sha = createHash('sha256').update(zip).digest('hex');
console.log(`已打包 daily-checkin-panel v${PANEL_VERSION}`);
console.log(`  文件数：${files.length}`);
console.log(`  大小：${(zip.length / 1024).toFixed(1)} KB`);
console.log(`  SHA-256：${sha}`);
console.log(`  输出：${out}`);
for (const f of files) console.log('  · ' + f.name);
