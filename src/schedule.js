// 签到时间设置：settings 表存 schedule_time（"HH:MM"，如 "08:05"，默认 "08"）
// 与 schedule_tz（IANA 时区，默认 Asia/Shanghai）。
// Worker Cron 每分钟触发一次（* * * * *），在这里判断当前（设定时区）
// 是否该执行，避免重复签到。
//
// 【为什么不是「当前分钟必须等于设定分钟」】
// 旧逻辑要求严格相等，后果是：只要那一分钟没被触发（Cloudflare 在部署/抖动时会漏），
// 或者用户把时间改成了**已经过去**的时刻（例如 09:00 才把 07:00 改成 08:05），
// 这一天就再也不会自动签到了 —— 面板看起来就像「不会自动签到」。
// 现在改成三个规则，既可预期又不会漏：
//   ① 到达/超过设定时刻 → 执行（当天该时刻第一次）
//   ② 执行过且**成功** → 当天不再执行
//   ③ 执行过但**失败/结果未知** → 隔 RETRY_GAP_MIN 分钟自动补一次，直到成功或超出补跑窗口
// 窗口 CATCHUP_WINDOW_MIN 存在的意义：晚上才部署、或把时间从 20:00 改到 08:05 时，
// 不该深夜突然批量签到；超出窗口就等下一个自然日（想立刻签到点面板的「执行」）。

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

// 没跑成功的补跑窗口（分钟）：默认 6 小时。
export const CATCHUP_WINDOW_MIN = 360;
// 失败后的重试间隔（分钟）：避免每分钟重试（那会一直占着扩展的中继通道）。
export const RETRY_GAP_MIN = 15;

// 设定时间的解析结果："08" / "08:05" 都接受，缺分钟按 00 算。
function parseWant(timeHHMM) {
  const t = String(timeHHMM || '');
  if (t.includes(':')) {
    const [h, m] = t.split(':');
    return { wantHour: String(h).padStart(2, '0'), wantMin: String(m).padStart(2, '0') };
  }
  return { wantHour: String(t).padStart(2, '0'), wantMin: '00' };
}

// "YYYY-MM-DD HH:MM" → 当天的「第几分钟」，便于算间隔（不涉及时区换算，两端同一时区）。
function clockMinutes(s) {
  const m = String(s || '').match(/\d{4}-\d{2}-\d{2}\s+(\d{2}):(\d{2})/);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

// 上次执行记录 → { base: 设定时刻 key, at: 上次尝试时刻（同一 key 当天）, ok: 是否成功 }
// 格式：成功 "2026-09-28 08:05"；失败/结果未知 "2026-09-28 08:05@2026-09-28 08:07"
export function parseLastKey(lastKey) {
  const s = String(lastKey || '');
  const i = s.indexOf('@');
  if (i < 0) return { base: s, at: '', ok: true };
  return { base: s.slice(0, i), at: s.slice(i + 1), ok: false };
}

// now: Date；timeHHMM: "08:05"；tz: IANA；lastKey: 上次执行记录（见 parseLastKey）
// 返回 { run, key, nowKey }：run 为 true 表示现在应该执行；key 记录「本设定时刻已处理」。
export function shouldRun(now, timeHHMM, tz, lastKey, opts = {}) {
  const windowMin = Number.isFinite(opts.windowMin) ? opts.windowMin : CATCHUP_WINDOW_MIN;
  const retryGap = Number.isFinite(opts.retryGap) ? opts.retryGap : RETRY_GAP_MIN;
  let parts;
  try {
    parts = tzParts(now, tz);
  } catch {
    parts = tzParts(now, 'Asia/Shanghai');
  }
  const { wantHour, wantMin } = parseWant(timeHHMM);
  const key = `${parts.day} ${wantHour}:${wantMin}`;
  const nowKey = `${parts.day} ${parts.hour}:${parts.minute}`;
  const nowMin = Number(parts.hour) * 60 + Number(parts.minute);
  const wantMinTotal = Number(wantHour) * 60 + Number(wantMin);

  const last = parseLastKey(lastKey);
  if (last.base === key) {
    if (last.ok) return { run: false, key, nowKey }; // 今天这个时刻已经成功签过
    // 上一次尝试过但没成功（失败/结果未知）：隔 retryGap 再补一次
    const atMin = clockMinutes(last.at);
    if (atMin != null && nowMin - atMin < retryGap) return { run: false, key, nowKey };
  }

  // 还没到设定时刻 → 等
  if (nowMin < wantMinTotal) return { run: false, key, nowKey };
  // 已经过太久（例如晚上才部署）→ 不补跑，避免深夜突然签到
  if (nowMin - wantMinTotal > windowMin) return { run: false, key, nowKey };
  return { run: true, key, nowKey };
}

// 纯“看钟”的判断：今天该账号的签到时刻到了吗（且没超出补跑窗口）。
//
// 【为什么单独要这个】shouldRun() 会看执行记录（成功过就不再跑），适合 cron；
// 而“浏览器签到工单自动下发”那条路只应该关心**时间到了没有**：
// 它以前只看「今天还没签上」，于是每天 0 点一过就立刻下发 ——
// 用户把时间设成 08:05，吾爱破解却在半夜就被自动签了，看起来就是
// 「吾爱不跟随全局时间」。这个函数就是给那种场景用的：只看钟，不看记录。
export function pastScheduleTime(now, timeHHMM, tz, opts = {}) {
  const windowMin = Number.isFinite(opts.windowMin) ? opts.windowMin : CATCHUP_WINDOW_MIN;
  let parts;
  try {
    parts = tzParts(now, tz);
  } catch {
    parts = tzParts(now, 'Asia/Shanghai');
  }
  const { wantHour, wantMin } = parseWant(timeHHMM);
  const nowMin = Number(parts.hour) * 60 + Number(parts.minute);
  const wantMinTotal = Number(wantHour) * 60 + Number(wantMin);
  if (nowMin < wantMinTotal) return false;
  if (nowMin - wantMinTotal > windowMin) return false;
  return true;
}

// 执行后要写回 lastMap 的值：成功记 key；失败/结果未知记 "key@本次时刻"，好让 shouldRun 决定何时补跑。
export function nextLastKey(key, nowKey, status) {
  return status === 'ok' ? key : `${key}@${nowKey}`;
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
