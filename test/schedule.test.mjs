// schedule 测试：node test/schedule.test.mjs
import assert from 'node:assert/strict';
import { shouldRun, validHour, validTz, tzParts, accountHour, dayInTz, dayStartInTz } from '../src/schedule.js';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok -', name); };

// 2026-09-27T00:30:00Z = 北京时间 08:30
const D0830 = new Date('2026-09-27T00:30:00Z');

t('北京时间整点判断', () => {
  const p = tzParts(D0830, 'Asia/Shanghai');
  assert.equal(p.day, '2026-09-27');
  assert.equal(p.hour, '08');
});

t('到达设定分钟且未跑过 → 执行（含分钟键）', () => {
  const r = shouldRun(D0830, '08:30', 'Asia/Shanghai', null);
  assert.equal(r.run, true);
  assert.equal(r.key, '2026-09-27 08:30');
});

t('纯小时格式按整点匹配：08:30 未到 08:00 → 跳过', () => {
  const r = shouldRun(D0830, '08', 'Asia/Shanghai', null);
  assert.equal(r.run, false);
});

t('该分钟已跑过 → 跳过', () => {
  const r = shouldRun(D0830, '08:30', 'Asia/Shanghai', '2026-09-27 08:30');
  assert.equal(r.run, false);
});

t('未到设定时间 → 跳过', () => {
  assert.equal(shouldRun(D0830, '09:00', 'Asia/Shanghai', null).run, false);
  assert.equal(shouldRun(D0830, '08:29', 'Asia/Shanghai', null).run, false);
});

t('UTC 时区换算', () => {
  // 同一时刻 UTC 是 00:30，设 00:30 应执行
  const r = shouldRun(D0830, '00:30', 'UTC', null);
  assert.equal(r.run, true);
});

t('非法时区回退上海', () => {
  const r = shouldRun(D0830, '08:30', 'Invalid/TZ', null);
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

t('accountHour：独立时间优先，为空跟随全局', () => {
  assert.equal(accountHour('{"sched_hour":"09"}', '08'), '09');
  assert.equal(accountHour('{}', '08'), '08');
  assert.equal(accountHour('{"sched_hour":""}', '08'), '08');
  assert.equal(accountHour('not-json', '08'), '08');
  assert.equal(accountHour(null, '08'), '08');
});

// ---------- 跨零点：状态列「今天」的口径 ----------
// 线上要求：过了当地 00:00 状态统一回到「未签到」，所以「今天」必须按时区算，
// 而且当天的成功记录要按当地 00:00 之后筛选，不能硬编 +08:00。
const D_JUST_BEFORE = new Date('2026-09-27T15:59:00Z'); // 北京时间 2026-09-27 23:59
const D_JUST_AFTER = new Date('2026-09-27T16:01:00Z');  // 北京时间 2026-09-28 00:01

t('dayInTz：北京时间跨零点换天', () => {
  assert.equal(dayInTz(D_JUST_BEFORE, 'Asia/Shanghai'), '2026-09-27');
  assert.equal(dayInTz(D_JUST_AFTER, 'Asia/Shanghai'), '2026-09-28');
});

t('dayInTz：换时区后换天时刻跟着变（UTC 还是 27 号）', () => {
  assert.equal(dayInTz(D_JUST_AFTER, 'UTC'), '2026-09-27');
  assert.equal(dayInTz(D_JUST_AFTER, 'Asia/Tokyo'), '2026-09-28');
});

t('dayInTz：非法时区回退上海，不抛错', () => {
  assert.equal(dayInTz(D_JUST_BEFORE, 'Nope/Zone'), '2026-09-27');
  assert.equal(dayInTz(D_JUST_BEFORE, ''), '2026-09-27');
});

t('dayStartInTz：当地 00:00 的时间戳（非 +08:00 硬编）', () => {
  // 北京时间 2026-09-28 00:00 = 2026-09-27T16:00:00Z
  assert.equal(dayStartInTz(D_JUST_AFTER, 'Asia/Shanghai'), Date.parse('2026-09-27T16:00:00Z'));
  // UTC 时区当天 00:00 = 2026-09-27T00:00:00Z
  assert.equal(dayStartInTz(D_JUST_AFTER, 'UTC'), Date.parse('2026-09-27T00:00:00Z'));
});

t('dayStartInTz：23:59 的成功记录不算第二天', () => {
  const start = dayStartInTz(D_JUST_AFTER, 'Asia/Shanghai');
  assert.ok(Date.parse('2026-09-27T14:00:00Z') < start, '昨天 22:00 的记录应被排除');
  assert.ok(Date.parse('2026-09-27T16:30:00Z') > start, '今天 00:30 的记录应被计入');
});

console.log(`\n${n} 组通过`);
