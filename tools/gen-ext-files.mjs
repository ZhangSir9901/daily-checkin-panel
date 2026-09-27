// 生成 src/ext-files.js：把 public/ext-src/ 下的扩展源文件嵌入为字符串常量。
// 面板下载扩展时由 src/ext-zip.js 读取 EXT_FILES，并注入面板地址。
//
// 用法（在仓库根目录）：node tools/gen-ext-files.mjs
//
// 注意：改完 public/ext-src/ 下的文件后，务必重新运行本脚本，否则下载到的还是旧版代码。
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = join(root, 'public', 'ext-src');
const files = ['manifest.json', 'popup.html', 'popup.js', 'background.js'];

const entries = files.map((name) => {
  const text = readFileSync(join(srcDir, name), 'utf8');
  return `  ${JSON.stringify(name)}: ${JSON.stringify(text)}`;
});

const out =
  '// 自动生成：扩展源文件嵌入（运行 node tools/gen-ext-files.mjs 更新）\n' +
  '// 源文件在 public/ext-src/；下载时由 src/ext-zip.js 注入面板地址。\n' +
  'export const EXT_FILES = {\n' + entries.join(',\n') + ',\n};\n';

writeFileSync(join(root, 'src', 'ext-files.js'), out, 'utf8');
console.log('src/ext-files.js 已更新：' + files.join(', '));
