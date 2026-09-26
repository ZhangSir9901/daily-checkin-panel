// 签到时间设置：settings 表存 schedule_time（小时 "00"~"23"，默认 "08"）
// 与 schedule_tz（IANA 时区，默认 Asia/Shanghai）。
// Worker Cron 每小时触发一次（0 * * * *），在这里判断当前（设定时区）
// 是否到达整点、且本小时未执行过，避免重复签到。

export function tzParts(date, tz) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false, hourCycle: 'h23',
  });
  const p = {};
  for (const x of fmt.formatToParts(date)) p[x.type] = x.value;
  return { day: `${p.year}-${p.month}-${p.day}`, hour: p.hour };
}

// now: Date；timeHH: "08"；tz: IANA；lastKey: 上次执行 key（"YYYY-MM-DD HH"）
// 返回 { run, key }：run 为 true 表示本小时应该执行。
export function shouldRun(now, timeHH, tz, lastKey) {
  let parts;
  try {
    parts = tzParts(now, tz);
  } catch {
    parts = tzParts(now, 'Asia/Shanghai');
  }
  const key = `${parts.day} ${parts.hour}`;
  const want = String(timeHH).padStart(2, '0');
  if (parts.hour !== want) return { run: false, key };
  if (lastKey === key) return { run: false, key };
  return { run: true, key };
}

export function validHour(v) {
  const n = parseInt(v, 10);
  return Number.isInteger(n) && n >= 0 && n <= 23 ? String(n).padStart(2, '0') : null;
}

export function validTz(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: String(tz) });
    return String(tz);
  } catch {
    return null;
  }
}
