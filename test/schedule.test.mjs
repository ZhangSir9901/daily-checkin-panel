// schedule 测试：node test/schedule.test.mjs
import assert from 'node:assert/strict';
import { shouldRun, nextLastKey, parseLastKey, validHour, validTz, tzParts, accountHour, dayInTz, dayStartInTz } from '../src/schedule.js';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok -', name); };

// 2026-09-27T00:30:00Z = 北京时间 08:30
const D0830 = new Date('2026-09-27T00:30:00Z');

t('北京时间整点判断', () => {
  const p = tzParts(D0830, 'Asia/Shanghai');
  assert.equal(p.day, '2026-09-27');
  assert.equal(p.hour, '08');
});

t('到达设定分钟且未跑过 → 执行（key 记「设定时刻」）', () => {
  const r = shouldRun(D0830, '08:30', 'Asia/Shanghai', null);
  assert.equal(r.run, true);
  assert.equal(r.key, '2026-09-27 08:30');
  assert.equal(r.nowKey, '2026-09-27 08:30');
});

t('纯小时格式：08:30 已过 08:00 → 补跑（不要求分秒相等）', () => {
  const r = shouldRun(D0830, '08', 'Asia/Shanghai', null);
  assert.equal(r.run, true);
  assert.equal(r.key, '2026-09-27 08:00');
});

t('当天该时刻已成功跑过 → 跳过', () => {
  const r = shouldRun(D0830, '08:30', 'Asia/Shanghai', '2026-09-27 08:30');
  assert.equal(r.run, false);
});

// ---------- 补跑（Cron 漏一分钟不再等于整天不签） ----------
// 线上现象：把全局时间从 07:00 改成 08:05 之后，当天再也没有自动签到 ——
// 因为旧逻辑要求「当前分钟恰好等于设定分钟」，错过就永远错过。
t('漏了一分钟 → 当天补跑一次（key 仍是设定时刻）', () => {
  const r = shouldRun(D0830, '08:05', 'Asia/Shanghai', null);
  assert.equal(r.run, true);
  assert.equal(r.key, '2026-09-27 08:05');
  // 补跑记录写回后，同一设定时刻不再重复
  assert.equal(shouldRun(D0830, '08:05', 'Asia/Shanghai', r.key).run, false);
});

t('已改到过去很久的时刻（超过补跑窗口）→ 不补跑，避免深夜突然签到', () => {
  // 北京时间 21:00，设定 08:05（差 12 小时 55 分 > 6 小时窗口）
  const D2100 = new Date('2026-09-27T13:00:00Z');
  assert.equal(shouldRun(D2100, '08:05', 'Asia/Shanghai', null).run, false);
  // 窗口边界：正好 6 小时（21:00 时设定 15:00）→ 仍补跑
  assert.equal(shouldRun(D2100, '15:00', 'Asia/Shanghai', null).run, true);
  assert.equal(shouldRun(D2100, '14:59', 'Asia/Shanghai', null).run, false);
});

t('失败/结果未知 → 隔 RETRY_GAP_MIN 分钟自动补一次（不会一分钟一次）', () => {
  // 08:05 跑过但失败：lastKey 记「2026-09-27 08:05@2026-09-27 08:05」
  const failed = nextLastKey('2026-09-27 08:05', '2026-09-27 08:05', 'fail');
  assert.equal(failed, '2026-09-27 08:05@2026-09-27 08:05');
  assert.deepEqual(parseLastKey(failed), { base: '2026-09-27 08:05', at: '2026-09-27 08:05', ok: false });
  // 08:10 刚失败过 → 先不重试
  assert.equal(shouldRun(new Date('2026-09-27T00:10:00Z'), '08:05', 'Asia/Shanghai', failed).run, false);
  // 08:25（隔了 20 分钟）→ 自动补一次
  assert.equal(shouldRun(new Date('2026-09-27T00:25:00Z'), '08:05', 'Asia/Shanghai', failed).run, true);
  // 成功的记录仍是纯 key（当天不再跑）
  assert.equal(nextLastKey('2026-09-27 08:05', '2026-09-27 08:05', 'ok'), '2026-09-27 08:05');
});

t('未到设定时间 → 跳过', () => {
  assert.equal(shouldRun(D0830, '09:00', 'Asia/Shanghai', null).run, false);
  assert.equal(shouldRun(D0830, '08:31', 'Asia/Shanghai', null).run, false);
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
