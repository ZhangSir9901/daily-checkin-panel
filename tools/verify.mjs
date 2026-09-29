// 一键自检：语法检查 + HTML 标签配对 + 面板单测
// 用法：node tools/verify.mjs
import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let failed = 0;
const step = (name) => console.log('\n=== ' + name);
const run = (args, label) => {
  try {
    const out = execFileSync(process.execPath, args, { cwd: root, encoding: 'utf8' });
    const last = out.trim().split('\n').filter(Boolean).pop() || '';
    console.log('✅ ' + label + '：' + last);
  } catch (e) {
    failed++;
    console.log('❌ ' + label);
    console.log((e.stdout || '') + (e.stderr || ''));
  }
};

step('语法检查 src/');
for (const f of ['index.js', 'runner.js', 'ext-zip.js', 'ext-files.js', 'schedule.js', 'db.js', 'crypto.js', 'notify.js', 'probe.js', 'version.js']) {
  run(['--check', join('src', f)], f);
}
for (const d of ['src/lib', 'src/sites']) {
  for (const f of readdirSync(join(root, d)).filter((x) => x.endsWith('.js'))) {
    run(['--check', join(d, f)], d + '/' + f);
  }
}

step('HTML 标签配对');
run([join('tools', 'check-html.mjs')], 'index.html');

step('DOM 引用检查（拦住「$() 返回 null → 整段脚本断掉」这类崩溃）');
run([join('tools', 'check-dom-refs.mjs')], 'index.html');

step('内联 JS 模板字符串：不许把 // 注释当成页面内容渲染出去');
run([join('tools', 'check-template-comments.mjs')], 'index.html');

step('扩展嵌入文件：src/ext-files.js 必须与 public/ext-src/ 一致（否则下载到的是旧版扩展）');
run([join('tools', 'check-ext-files.mjs')], 'ext-files.js');

step('index.html 内联 JS 语法');
{
  const html = readFileSync(join(root, 'public', 'index.html'), 'utf8');
  // 取 </body> 之前的那一个内联脚本（<head> 里还有一小段主题预设脚本，别把它当主体）
  const close = html.lastIndexOf('</script>');
  const open = html.lastIndexOf('<script>', close);
  try {
    if (open < 0 || close < 0) throw new Error('找不到内联脚本');
    new Function(html.slice(open + '<script>'.length, close));
    console.log('✅ 内联脚本语法 OK');
  } catch (e) {
    failed++;
    console.log('❌ 内联脚本语法错误：' + e.message);
  }
}

step('面板单测 test/*.test.mjs');
for (const f of readdirSync(join(root, 'test')).filter((x) => x.endsWith('.test.mjs')).sort()) {
  run([join('test', f)], f);
}

console.log('\n' + (failed ? `❌ 有 ${failed} 项未通过` : '✅ 全部通过'));
process.exit(failed ? 1 : 0);
