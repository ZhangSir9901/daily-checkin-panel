// Cron 定时签到：node test/cron.test.mjs
//
// 【为什么必须有这个测试】2026-09-29 用户报「时间到点了，可是没有正常签到」。
// 根因：scheduled() 里有一行 `changed = true;` —— 它只被赋值、**从来没有声明**。
// ES 模块是严格模式，所以第一个到点的账号执行到那一行就抛 ReferenceError，
// 而这个异常被整个大 try 吞掉：每分钟的定时任务都在这里整体中断，
// 一个账号都不会执行，`sched_last_map` 也不会写，面板上「时间到了却什么都没发生」，
// 日志里一条都看不到。
//
// 之前的测试全都盯着 schedule.js 的纯函数（shouldRun），**没有一条真的调用过
// scheduled()**，所以这个 bug 一路活到了线上。这个文件补上这一层：
//   ① 到点了必须真的去跑（不是「记了个 key 就算跑过」）
//   ② 每个账号单独兜错：一个账号炸了，后面的账号照样跑
//   ③ 已经成功过的账号当天不再跑
//   ④ 心跳（cron_last_result / cron_last_at）如实记录，且不会每分钟写库
import assert from 'node:assert/strict';

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log('ok -', name); };

// ---- 极简 D1 仿真：够跑通 scheduled() 这条链 ----
function makeDb({ settings = {}, accounts = [] } = {}) {
  const kv = new Map(Object.entries(settings));
  const rows = accounts.map((a) => ({ meta: '{}', enabled: 1, ...a }));
  const runs = [];
  const norm = (sql) => String(sql).replace(/\s+/g, ' ').trim();

  const prepare = (sqlRaw) => {
    const sql = norm(sqlRaw);
    const stmt = {
      _args: [],
      bind(...a) { stmt._args = a; return stmt; },
      async first() {
        if (/^SELECT value FROM settings WHERE key = \?/i.test(sql)) {
          const v = kv.get(stmt._args[0]);
          return v === undefined ? null : { value: v };
        }
        if (/^SELECT \* FROM accounts WHERE id = \?/i.test(sql)) {
          const r = rows.find((x) => Number(x.id) === Number(stmt._args[0]));
          return r ? { ...r } : null;
        }
        if (/^SELECT COUNT\(\*\) AS n FROM relay_jobs/i.test(sql)) return { n: 0 };
        return null;
      },
      async all() {
        if (/^PRAGMA table_info/i.test(sql)) return { results: [] };
        if (/^SELECT id, site, (name, )?meta FROM accounts WHERE enabled = 1/i.test(sql)) {
          const withName = /name,/.test(sql);
          return {
            results: rows.filter((r) => Number(r.enabled) === 1)
              .map((r) => (withName ? { id: r.id, site: r.site, name: r.name, meta: r.meta } : { id: r.id, site: r.site, meta: r.meta })),
          };
        }
        // 社区站点表 / 中继队列等：本测试用不到，一律当空
        return { results: [] };
      },
      async run() {
        const a = stmt._args;
        if (/^(CREATE TABLE|CREATE INDEX|ALTER TABLE|DELETE FROM)/i.test(sql)) return { meta: { changes: 0 } };
        if (/^PRAGMA/i.test(sql)) return { meta: { changes: 0 } };
        if (/^INSERT INTO settings/i.test(sql)) { kv.set(a[0], a[1]); return { meta: { changes: 1 } }; }
        if (/^INSERT INTO runs/i.test(sql)) { runs.push(a); return { meta: { changes: 1 } }; }
        if (/^UPDATE accounts/i.test(sql)) return { meta: { changes: 1 } };
        if (/^INSERT INTO relay_jobs/i.test(sql)) return { meta: { changes: 1 } };
        return { meta: { changes: 0 } };
      },
    };
    return stmt;
  };

  return { kv, rows, runs, prepare, async batch(s) { return Promise.all((s || []).map((x) => x.run())); } };
}

const worker = (await import('../src/index.js')).default;

// 「现在」是真实时间：把全局签到时间设成**刚刚过去的那个分钟**，
// 于是所有账号都处在「到点、且在补跑窗口内」的状态（不依赖机器当前几点）。
const TZ = 'UTC';
function justNowKey(offsetMin = 1) {
  const d = new Date(Date.now() - offsetMin * 60000);
  const p = (x) => String(x).padStart(2, '0');
  return {
    time: `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`,
    day: `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`,
  };
}
const hhmmOf = (minOfDay) => `${String(Math.floor(minOfDay / 60)).padStart(2, '0')}:${String(minOfDay % 60).padStart(2, '0')}`;

async function runScheduled(db) {
  let pending = null;
  const ctx = { waitUntil: (p) => { pending = p; } };
  await worker.scheduled({}, { DB: db }, ctx);
  await pending;
}

await t('到点的账号必须真的被执行（不是只记个 key），并且结果写回 sched_last_map', async () => {
  const { time } = justNowKey(1);
  const db = makeDb({
    settings: { schedule_time: time, schedule_tz: TZ },
    accounts: [
      { id: 1, name: 'A', site: 'zzz-unknown-1' },
      { id: 2, name: 'B', site: 'zzz-unknown-2' },
      { id: 3, name: 'C', site: 'zzz-unknown-3' },
    ],
  });
  await runScheduled(db);

  const last = JSON.parse(db.kv.get('sched_last_map') || '{}');
  assert.equal(Object.keys(last).length, 3, '三个到点的账号都该留下执行记录，实际：' + JSON.stringify(last));
  // 站点未知 → 必然不是成功，所以记录必须是「失败形态」（key@尝试时刻），
  // 这样下一轮才会自动补跑（而不是被当成「今天已经签过了」）
  for (const id of ['1', '2', '3']) {
    assert.match(last[id], /@/, `账号 ${id} 应记为失败形态（待补跑），实际：${last[id]}`);
  }

  const beat = JSON.parse(db.kv.get('cron_last_result') || 'null');
  assert.ok(beat, '要留下心跳记录（面板靠它显示「自动执行还活着吗」）');
  assert.equal(beat.ran, 3, '三个账号都要被尝试过，实际 ran=' + beat.ran);
  assert.equal(beat.ok, 0, '站点未知不可能成功');
  assert.ok(Number(db.kv.get('cron_last_at')) > 0, '要记下这次自动检查的时间');
});

await t('单个账号出问题不许拖垮整轮（旧代码死在第一行赋值上，后面全都不跑）', async () => {
  const { time } = justNowKey(1);
  // 第一个账号就是坏配置：站点不存在、meta 也是坏 JSON
  const db = makeDb({
    settings: { schedule_time: time, schedule_tz: TZ },
    accounts: [
      { id: 11, name: '坏的', site: '', meta: '{ 不是 JSON' },
      { id: 12, name: '好的', site: 'zzz-unknown-2' },
    ],
  });
  await runScheduled(db);
  const last = JSON.parse(db.kv.get('sched_last_map') || '{}');
  assert.ok(last['12'], '第一个账号炸了，第二个也必须照跑（每个账号单独兜错），实际：' + JSON.stringify(last));
});

await t('当天已经成功的账号不再重复跑', async () => {
  const { time, day } = justNowKey(1);
  const db = makeDb({
    settings: { schedule_time: time, schedule_tz: TZ },
    accounts: [
      { id: 21, name: '已签', site: 'zzz-unknown-1' },
      { id: 22, name: '未签', site: 'zzz-unknown-2' },
    ],
  });
  // 账号 21 今天这个时刻已经成功过 → shouldRun 必须让它跳过
  db.kv.set('sched_last_map', JSON.stringify({ '21': `${day} ${time}` }));
  await runScheduled(db);
  const beat = JSON.parse(db.kv.get('cron_last_result') || 'null');
  assert.equal(beat.ran, 1, '只该跑「未签」那一个，实际 ran=' + beat.ran);
  const last = JSON.parse(db.kv.get('sched_last_map') || '{}');
  assert.equal(last['21'], `${day} ${time}`, '已成功的账号记录不许被覆盖成失败形态');
  assert.match(last['22'], /@/, '没签上的账号要留下待补跑记录');
});

await t('失败后过 15 分钟会自动补跑（补跑窗口内）', async () => {
  const { time, day } = justNowKey(1);
  const db = makeDb({
    settings: { schedule_time: time, schedule_tz: TZ },
    accounts: [{ id: 31, name: 'A', site: 'zzz-unknown-1' }],
  });
  // 上次尝试是 20 分钟前（> 15 分钟间隔）→ 该补跑
  const at = new Date(Date.now() - 20 * 60000);
  const p = (x) => String(x).padStart(2, '0');
  const atKey = `${at.getUTCFullYear()}-${p(at.getUTCMonth() + 1)}-${p(at.getUTCDate())} ${p(at.getUTCHours())}:${p(at.getUTCMinutes())}`;
  db.kv.set('sched_last_map', JSON.stringify({ '31': `${day} ${time}@${atKey}` }));
  await runScheduled(db);
  const beat = JSON.parse(db.kv.get('cron_last_result') || 'null');
  assert.equal(beat.ran, 1, '过了重试间隔就该自动补跑一次');
});

await t('刚补跑过（不到 15 分钟）不再重跑，且不会每分钟写一次心跳', async () => {
  const { time, day } = justNowKey(1);
  const db = makeDb({
    settings: { schedule_time: time, schedule_tz: TZ },
    accounts: [{ id: 41, name: 'A', site: 'zzz-unknown-1' }],
  });
  const now = new Date();
  const p = (x) => String(x).padStart(2, '0');
  const nowKey = `${now.getUTCFullYear()}-${p(now.getUTCMonth() + 1)}-${p(now.getUTCDate())} ${p(now.getUTCHours())}:${p(now.getUTCMinutes())}`;
  db.kv.set('sched_last_map', JSON.stringify({ '41': `${day} ${time}@${nowKey}` }));
  const beatBefore = String(Date.now() - 60000);
  db.kv.set('cron_last_at', beatBefore);
  db.kv.set('cron_last_result', JSON.stringify({ at: Number(beatBefore), ran: 1, ok: 0 }));

  await runScheduled(db);
  const last = JSON.parse(db.kv.get('sched_last_map') || '{}');
  assert.equal(last['41'], `${day} ${time}@${nowKey}`, '不到间隔就不该再跑（否则会一直占着扩展的中继通道）');
  assert.equal(db.kv.get('cron_last_at'), beatBefore, '上一轮心跳还很新，这一轮不该写库（每分钟写一次太浪费）');
});

await t('定时签到也会推日报：同一天只推一次（README 承诺的「每天推签到日报」）', async () => {
  const { time } = justNowKey(1);
  const db = makeDb({
    settings: {
      schedule_time: time, schedule_tz: TZ,
      'notify.enabled': '1',
      // 用通用 Webhook 当接收端：sendNotify 会 POST JSON 到这里
      'notify.webhook_url': 'https://hook.example/daily',
    },
    accounts: [
      { id: 51, name: '甲', site: 'zzz-unknown-1' },
      { id: 52, name: '乙', site: 'zzz-unknown-2' },
    ],
  });

  const sent = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    sent.push({ url: String(url), body: init && init.body });
    return new Response('ok', { status: 200 });
  };
  try {
    await runScheduled(db);
  } finally {
    globalThis.fetch = orig;
  }

  assert.equal(sent.length, 1, '第一轮应该推一条日报，实际 ' + sent.length);
  const payload = JSON.parse(sent[0].body || '{}');
  assert.equal(payload.title, '签到日报（自动）');
  assert.match(payload.body, /自动签到：成功 0 个/);
  assert.match(payload.body, /甲/, '日报里要按账号名列出来（不然不知道是谁失败了）');
  assert.equal(db.kv.get('notify_report_day'), justNowKey(1).day, '要记下「今天已经推过」');

  // 同一天再跑一轮（把 key 清掉让它重新跑）→ 不许重复推
  db.kv.set('sched_last_map', '{}');
  const sent2 = [];
  globalThis.fetch = async (url, init) => { sent2.push({ url: String(url), body: init && init.body }); return new Response('ok', { status: 200 }); };
  try {
    await runScheduled(db);
  } finally {
    globalThis.fetch = orig;
  }
  assert.equal(sent2.length, 0, '同一天不该重复推（失败后的自动补跑会推很多次）');
});

await t('面板 /api/schedule 会带上心跳（供顶部显示「自动检查」）', async () => {
  const db = makeDb({ settings: { schedule_time: '08:05', schedule_tz: TZ, cron_last_at: '1700000000000', cron_last_result: JSON.stringify({ at: 1700000000000, ran: 3, ok: 2, total: 5 }) } });
  // 后台需要一个已登录会话：直接调用内部逻辑不方便，这里只验证 GET 的形状契约
  const res = await worker.fetch(new Request('https://panel.example/api/schedule'), { DB: db }, {});
  // 未登录 → 401/403 是正常的（这个接口要登录）；关键是下面这条：登录后会带 last/cron_at
  assert.ok([200, 401, 403].includes(res.status), '接口不该崩，实际 ' + res.status);
  const src = (await import('node:fs')).readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  assert.match(src, /return json\(\{ time, tz, last, cron_at \}\)/, '/api/schedule 要把心跳一起返回');
});

console.log(`\n${n} 组通过`);
