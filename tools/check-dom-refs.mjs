// 检查 public/index.html 内联脚本里 $('xxx') / getElementById('xxx') 引用的 id 是否真的存在。
//
// 两类检查：
//  ① 宽松：脚本里所有 $('x') 引用的 id 必须在文件里出现过（含 JS 模板串里动态生成的）。
//  ② 严格：**顶格（不在函数里）** 的 $('x').onclick = … / .addEventListener(…) 这类
//     “加载时就执行”的写法，其 id 必须出现在 <script> 之外的静态 HTML 里。
//     这是真正的崩溃来源：id 只在 JS 里用字符串拼出来 → $() 返回 null → 赋值抛错 →
//     同一段脚本后面所有绑定全部不执行（面板看着像“坏了”，其实只是没绑上）。
// 检查 ② 就是为了拦住这个：线上真实踩过一次（btn-ck-apply 只在预览弹窗里动态生成，
// 却在顶格赋值）。
// 用法：node tools/check-dom-refs.mjs
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const scriptM = html.match(/<script>([\s\S]*?)<\/script>\s*<\/body>/);
if (!scriptM) throw new Error('找不到内联脚本');
const code = scriptM[1];
const scriptStart = scriptM.index;
const scriptEnd = scriptStart + scriptM[0].length;
// <script> 之外的静态 HTML（动态生成的不算）
const staticHtml = html.slice(0, scriptStart) + html.slice(scriptEnd);

const idRe = (id) => new RegExp('id=["\']' + id + '["\']');
const hasId = (id) => idRe(id).test(html);
const inStaticHtml = (id) => idRe(id).test(staticHtml);

// ---------- ① 宽松：所有引用都要在文件里能找到 ----------
// 只检查“直接取值”的写法：$(...) 后面紧跟 .（访问属性）时会崩，需要存在；
// 而 $('x') 后面跟着 if / && / ? 的算存在性判断，允许不存在。
const refs = new Set();
for (const m of code.matchAll(/\$\(\s*'([a-zA-Z0-9_-]+)'\s*\)/g)) {
  const after = code.slice(m.index + m[0].length).trimStart()[0] || '';
  if (after === ')' || after === '?' || after === '&' || after === '' || after === '\n') continue;
  refs.add(m[1]);
}
for (const m of code.matchAll(/getElementById\(\s*'([a-zA-Z0-9_-]+)'\s*\)/g)) refs.add(m[1]);

const missing = [...refs].filter((id) => !hasId(id)).sort();

// ---------- ② 严格：顶格赋值必须是静态 HTML 里就有的 id ----------
// 顶格 = 行首没有缩进（模块级语句）。缩进的都在函数/try 里，属于运行时才跑。
const hardMissing = [];
const seen = new Set();
for (const m of code.matchAll(/^(?:\$\('([a-zA-Z0-9_-]+)'\)|document\.getElementById\('([a-zA-Z0-9_-]+)'\))\s*\.\s*(onclick|oninput|onchange|onkeydown|addEventListener|value|innerHTML|textContent|disabled)\s*=/gm)) {
  const id = m[1] || m[2];
  if (!id || seen.has(id)) continue;
  seen.add(id);
  if (!inStaticHtml(id)) hardMissing.push(id);
}

// ---------- ③ 顶格 const/let X = $('id') 也一样会崩 ----------
for (const m of code.matchAll(/^(?:const|let|var)\s+[A-Za-z0-9_$]+\s*=\s*\$\('([a-zA-Z0-9_-]+)'\)/gm)) {
  const id = m[1];
  if (!inStaticHtml(id) && !hardMissing.includes(id)) hardMissing.push(id);
}

let bad = false;
if (missing.length) {
  console.log('❌ 脚本引用了不存在的元素：' + missing.join(', '));
  bad = true;
}
if (hardMissing.length) {
  console.log('❌ 顶格（加载时立即执行）取值/绑定的元素不在静态 HTML 里，会抛 TypeError 并中断整段脚本：' + hardMissing.join(', '));
  bad = true;
}
if (bad) process.exit(1);
console.log('✅ 内联脚本引用的 ' + refs.size + ' 个元素 id 都存在（其中 ' + seen.size + ' 个是顶格绑定，已确认在静态 HTML 中）');
