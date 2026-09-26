// schedule 测试：node test/schedule.test.mjs
import assert from 'node:assert/strict';
import { shouldRun, validHour, validTz, tzParts } from '../src/schedule.js';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok -', name); };

// 2026-09-27T00:30:00Z = 北京时间 08:30
const D0830 = new Date('2026-09-27T00:30:00Z');

t('北京时间整点判断', () => {
  const p = tzParts(D0830, 'Asia/Shanghai');
  assert.equal(p.day, '2026-09-27');
  assert.equal(p.hour, '08');
});

t('到达整点且未跑过 → 执行', () => {
  const r = shouldRun(D0830, '08', 'Asia/Shanghai', null);
  assert.equal(r.run, true);
  assert.equal(r.key, '2026-09-27 08');
});

t('本小时已跑过 → 跳过', () => {
  const r = shouldRun(D0830, '08', 'Asia/Shanghai', '2026-09-27 08');
  assert.equal(r.run, false);
});

t('未到整点 → 跳过', () => {
  const r = shouldRun(D0830, '09', 'Asia/Shanghai', null);
  assert.equal(r.run, false);
});

t('UTC 时区换算', () => {
  // 同一时刻 UTC 是 00:30，设 00 点应执行
  const r = shouldRun(D0830, '00', 'UTC', null);
  assert.equal(r.run, true);
});

t('非法时区回退上海', () => {
  const r = shouldRun(D0830, '08', 'Invalid/TZ', null);
  assert.equal(r.run, true);
});

t('validHour 校验', () => {
  assert.equal(validHour('8'), '08');
  assert.equal(validHour('23'), '23');
  assert.equal(validHour('24'), null);
  assert.equal(validHour('abc'), null);
});

t('validTz 校验', () => {
  assert.equal(validTz('Asia/Shanghai'), 'Asia/Shanghai');
  assert.equal(validTz('Nope/Zone'), null);
});

console.log(`\n${n} 组通过`);
