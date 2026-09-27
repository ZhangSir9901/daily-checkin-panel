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
  return { day: `${p.year}-${p.month}-${p.day}`, hour: p.hour, minute: p.minute };
}

// 当前（指定时区，默认 Asia/Shanghai）的日期 "YYYY-MM-DD"。
// 用于「状态」列的跨零点自动重置：过了当地 00:00 就算新的一天，
// 全部账号重新显示「未签到」，只有当天真正签到成功才变回「已签到」。
export function dayInTz(date, tz) {
  try {
    return tzParts(date, tz || 'Asia/Shanghai').day;
  } catch {
    return tzParts(date, 'Asia/Shanghai').day;
  }
}

// 指定时区相对 UTC 的偏移（毫秒）。做法：把当地墙上时间当 UTC 解析，
// 再减去真实时刻（截到分钟 —— 格式化只精确到分钟）。
function tzOffsetMs(date, tz) {
  let p;
  try {
    p = tzParts(date, tz || 'Asia/Shanghai');
  } catch {
    p = tzParts(date, 'Asia/Shanghai');
  }
  const wall = Date.parse(`${p.day}T${p.hour}:${p.minute}:00Z`);
  const real = Math.floor(date.getTime() / 60000) * 60000;
  return wall - real;
}

// 指定时区「今天 00:00」的时间戳（毫秒）。
// 用于判断某条运行记录是否属于「今天」——跟状态列的跨零点重置口径一致。
export function dayStartInTz(date, tz) {
  const day = dayInTz(date, tz);
  return Date.parse(`${day}T00:00:00Z`) - tzOffsetMs(date, tz);
}

// now: Date；timeHH: "08"；tz: IANA；lastKey: 上次执行 key（"YYYY-MM-DD HH"）
// 返回 { run, key }：run 为 true 表示本小时应该执行。
export function shouldRun(now, timeHHMM, tz, lastKey) {
  let parts;
  try {
    parts = tzParts(now, tz);
  } catch {
    parts = tzParts(now, 'Asia/Shanghai');
  }
  // 支持 HH:MM 格式，也兼容旧的 HH 格式
  const t = String(timeHHMM || '');
  let wantHour, wantMin;
  if (t.includes(':')) {
    const [h, m] = t.split(':');
    wantHour = String(h).padStart(2, '0');
    wantMin = String(m).padStart(2, '0');
  } else {
    wantHour = String(t).padStart(2, '0');
    wantMin = '00';
  }
  const key = `${parts.day} ${parts.hour}:${parts.minute}`;
  if (parts.hour !== wantHour || parts.minute !== wantMin) return { run: false, key };
  if (lastKey === key) return { run: false, key };
  return { run: true, key };
}

// 全角转半角（支持全角数字和冒号输入）
export function toHalfWidth(s) {
  return String(s || '').replace(/[０-９：]/g, (c) => {
    if (c === '：') return ':';
    return String.fromCharCode(c.charCodeAt(0) - 0xFEE0);
  });
}

export function validHour(v) {
  const n = parseInt(v, 10);
  return Number.isInteger(n) && n >= 0 && n <= 23 ? String(n).padStart(2, '0') : null;
}

// 验证 HH:MM 格式（支持 8:30、08:30、8：30全角等），返回规范化的 "HH:MM" 或 null
export function validTime(v) {
  const s = toHalfWidth(v).trim();
  if (!s) return null;
  const m = s.match(/^(\d{1,2})[:：](\d{1,2})$/);
  if (m) {
    const h = parseInt(m[1], 10);
    const min = parseInt(m[2], 10);
    if (h >= 0 && h <= 23 && min >= 0 && min <= 59) {
      return String(h).padStart(2, '0') + ':' + String(min).padStart(2, '0');
    }
    return null;
  }
  // 兼容旧的纯小时格式 "08"
  const h = validHour(s);
  return h ? h + ':00' : null;
}

export function validTz(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: String(tz) });
    return String(tz);
  } catch {
    return null;
  }
}

// 账号的签到小时：独立时间优先（meta.sched_hour），为空则跟随全局
export function accountHour(metaJson, globalHour) {
  try {
    const m = JSON.parse(metaJson || '{}');
    return m.sched_hour || globalHour;
  } catch {
    return globalHour;
  }
}
