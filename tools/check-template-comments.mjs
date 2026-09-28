// 扫描 public/index.html 的内联 JS，找出「写在模板字符串里的 // 注释」。
//
// 为什么要单独立一条检查：
//   账号表格的每一行都是用模板字符串拼出来的。注释一旦写在 `return \`` 的**下一行**，
//   它就不再是注释，而成了这段 HTML 的**内容**：每一行账号都会把那段注释渲染成文字
//   （表格里还会被浏览器提到表格上方），整页排版立刻被撑乱 ——
//   而 `new Function()` 语法检查完全看不出问题（它是合法字符串）。
//
// 用法：node tools/check-template-comments.mjs [文件]
// 退出码：0=干净；1=发现泄漏（打印行号与内容）
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const file = process.argv[2] || join(root, 'public', 'index.html');
const src = readFileSync(file, 'utf8');

// 只检查内联 <script>（末尾那个），别去扫 HTML 文本 —— HTML 里的 // 是正常内容
const m = src.match(/<script>([\s\S]*?)<\/script>\s*<\/body>/);
if (!m) {
  console.log('找不到内联脚本（跳过）');
  process.exit(0);
}
const script = m[1];
const offset = m.index + m[0].indexOf(script); // 换算回整份文件的行号

// 极简词法：state = code | line | block | sq | dq | tpl
// 模板字符串里遇到 ${ 要进一层 code（里面还能再嵌字符串/模板），所以用栈记层。
const stack = ['code'];
const leaks = [];
let line = 1;
let lineStart = 0;
const atLineStartNoCode = () => stack[stack.length - 1] === 'tpl';

for (let i = 0; i < script.length; i++) {
  const c = script[i];
  const top = stack[stack.length - 1];

  if (c === '\n') {
    if (top === 'line') stack.pop(); // 行注释到行尾结束
    line++;
    lineStart = i + 1;
    continue;
  }

  if (top === 'line') continue;
  if (top === 'block') {
    if (c === '*' && script[i + 1] === '/') { stack.pop(); i++; }
    continue;
  }
  if (top === 'sq' || top === 'dq') {
    if (c === '\\') { i++; continue; }
    if ((top === 'sq' && c === "'") || (top === 'dq' && c === '"')) stack.pop();
    continue;
  }

  // 模板字符串内部：只认结束反引号与 ${（其余都是文本）
  if (top === 'tpl') {
    if (c === '\\') { i++; continue; }
    if (c === '`') { stack.pop(); continue; }
    if (c === '$' && script[i + 1] === '{') { stack.push('code'); i++; continue; }
    // 在一行里（前面只有空白）出现 // → 这行注释会被当成内容渲染出去
    if (c === '/' && script[i + 1] === '/' && script.slice(lineStart, i).trim() === '') {
      let end = script.indexOf('\n', i);
      if (end < 0) end = script.length;
      const raw = script.slice(lineStart, end);
      const ln = src.slice(0, offset + lineStart).split('\n').length;
      leaks.push({ ln, text: raw.trim().slice(0, 100) });
      i = end - 1;
    }
    continue;
  }

  // code
  if (c === '/' && script[i + 1] === '/') { stack.push('line'); i++; continue; }
  if (c === '/' && script[i + 1] === '*') { stack.push('block'); i++; continue; }
  if (c === "'") { stack.push('sq'); continue; }
  if (c === '"') { stack.push('dq'); continue; }
  if (c === '`') { stack.push('tpl'); continue; }
  if (c === '}') {
    // 关掉一层 ${…}：只在「这层是 code 且不是最外层」时弹栈
    if (stack.length > 1) stack.pop();
    continue;
  }
}

void atLineStartNoCode;

if (leaks.length) {
  console.log('❌ 模板字符串里出现了 ' + leaks.length + ' 行 // 注释（会被当成内容渲染到页面上）：');
  for (const l of leaks) console.log('   第 ' + l.ln + ' 行：' + l.text);
  process.exit(1);
}
console.log('✅ 没有模板字符串内的注释泄漏');
