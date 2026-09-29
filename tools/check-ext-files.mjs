// 自检：src/ext-files.js 必须与 public/ext-src/ 下的真实文件逐字节一致。
//
// 为什么必须有这条：面板的「下载扩展」不是读磁盘文件，而是读 src/ext-files.js 里
// 嵌入的字符串（见 src/ext-zip.js）。改完 public/ext-src/ 却忘了跑
// `node tools/gen-ext-files.mjs` 时，本地测试全绿、页面上也看不出任何异常，
// 但用户下载到的还是**旧版扩展** —— 线上就是这么出现「面板说扩展要 2.8、
// 装出来的却是 2.2」这类对不上的。这条自检把这类漏跑直接变成红色。
//
// 用法（仓库根目录）：node tools/check-ext-files.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { EXT_FILES } from '../src/ext-files.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = join(root, 'public', 'ext-src');

const problems = [];
let checked = 0;
for (const [key, value] of Object.entries(EXT_FILES)) {
  const isBin = key.startsWith('@b64:');
  const name = isBin ? key.slice('@b64:'.length) : key;
  let onDisk;
  try {
    onDisk = readFileSync(join(srcDir, name));
  } catch {
    problems.push(`public/ext-src/${name} 不存在（ext-files.js 里却有它）`);
    continue;
  }
  const embedded = isBin ? Buffer.from(String(value), 'base64') : Buffer.from(String(value), 'utf8');
  checked++;
  if (!onDisk.equals(embedded)) {
    problems.push(`${name} 不一致（磁盘 ${onDisk.length} 字节 / 嵌入 ${embedded.length} 字节）`);
  }
}
// 反方向：磁盘上有、嵌入里没有（新加的文件忘了重新生成）
for (const name of ['manifest.json', 'popup.html', 'popup.js', 'background.js', 'icon16.png', 'icon32.png', 'icon48.png', 'icon128.png']) {
  const has = EXT_FILES[name] != null || EXT_FILES['@b64:' + name] != null;
  if (!has) problems.push(`${name} 没有嵌入到 ext-files.js`);
}

if (problems.length) {
  console.log('❌ ext-files.js 与 public/ext-src/ 不一致（这会让用户下载到旧版扩展）：');
  for (const p of problems) console.log('   - ' + p);
  console.log('   跑一次：node tools/gen-ext-files.mjs');
  process.exit(1);
}
console.log(`✅ ext-files.js 与 public/ext-src/ 一致（${checked} 个文件）`);
