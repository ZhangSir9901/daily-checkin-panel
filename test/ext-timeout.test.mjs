// 扩展侧超时预算：node test/ext-timeout.test.mjs
//
// 为什么要有这个测试（线上真实故障，2026-09-28）：
// 扩展执行中继任务时会「先短超时试探 → 超时就把标签激活到前台再试一次」。
// 旧版本把任务级硬超时设成 45 秒，而这条链最多要 12（首次）+ 1.2（激活等待）+ 30（前台重试）
// ≈ 43 秒，再加上取任务/注入的开销就顶到了 45 秒 —— 于是**第二次明明快要拿到响应了也被掐掉**，
// 面板上永远只看到「中继执行超时」，而那个 POST 其实早就发出去了（站点可能已经签到成功）。
// 糊涂鳄的签到请求就是这么反复「失败」的。下面的断言把这个预算关系钉住。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok -', name); };

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ext = readFileSync(join(root, 'public', 'ext-src', 'background.js'), 'utf8');
const bundled = readFileSync(join(root, 'src', 'ext-files.js'), 'utf8');

// 从源码里取常量值：既支持字面量，也支持「用公式算出来」的写法
function constOf(name) {
  const m = ext.match(new RegExp('const\\s+' + name + '\\s*=\\s*([^;]+);'));
  assert.ok(m, '找不到常量 ' + name);
  const expr = m[1].trim();
  if (/^\d+$/.test(expr)) return Number(expr);
  // 公式：把里面引用的常量名换成数值再求值（只允许数字与 + - * / 和括号）
  const resolved = expr.replace(/[A-Za-z_][A-Za-z0-9_]*/g, (name2) => String(constOf(name2)));
  assert.match(resolved, /^[\d+\-*/().\s]+$/, name + ' 的表达式无法求值：' + expr);
  // eslint-disable-next-line no-new-func
  return Number(new Function('return ' + resolved)());
}

t('中继任务硬超时能装下「首次试探 + 激活前台 + 前台重试」', () => {
  const job = constOf('RELAY_JOB_TIMEOUT_MS');
  const budget = constOf('RELAY_FIRST_TRY_MS') + constOf('RELAY_ACTIVATE_WAIT_MS') + constOf('RELAY_FETCH_TIMEOUT_MS');
  assert.ok(job > budget, `硬超时 ${job}ms 必须大于重试链预算 ${budget}ms`);
  assert.ok(job - budget >= 5000, `至少留 5 秒余量，实际只有 ${job - budget}ms`);
});

t('超时文案说明「请求已发出、结果未知」，不再写成「已放弃该请求」', () => {
  assert.match(ext, /请求已发出但没收到回包/);
  assert.doesNotMatch(ext, /已放弃该请求/);
});

t('面板里的扩展副本与源码同步（src/ext-files.js 是生成的）', () => {
  assert.ok(bundled.includes('RELAY_ACTIVATE_WAIT_MS'), 'ext-files.js 需要重新生成：node tools/gen-ext-files.mjs');
  assert.match(bundled, /请求已发出但没收到回包/);
});

console.log(`\n${n} 组通过`);
