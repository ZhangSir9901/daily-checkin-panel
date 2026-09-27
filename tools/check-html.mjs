// 粗略检查 public/index.html 的标签是否配对（去掉 script/style 内容后按标签栈校验）
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8')
  .replace(/<script[\s\S]*?<\/script>/gi, '')
  .replace(/<style[\s\S]*?<\/style>/gi, '')
  .replace(/<!--[\s\S]*?-->/g, '');

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const stack = [];
const errors = [];
const re = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>])*)>/g;
let m;
while ((m = re.exec(html))) {
  const closing = m[1] === '/';
  const tag = m[2].toLowerCase();
  const attrs = m[3] || '';
  if (VOID.has(tag) || /\/\s*$/.test(attrs)) continue;
  if (!closing) {
    stack.push(tag);
  } else {
    const top = stack.pop();
    if (top !== tag) errors.push(`期望 </${top}>，实到 </${tag}>（位置 ${m.index}）`);
  }
}
for (const t of stack) errors.push(`未闭合的 <${t}>`);

if (errors.length) {
  console.log('❌ 发现问题：');
  for (const e of errors.slice(0, 20)) console.log('   ' + e);
  process.exit(1);
}
console.log('✅ 标签配对正常');
