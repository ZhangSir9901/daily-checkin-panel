// 本地网络中继的「租约」生命周期：node test/relay-lease.test.mjs
//
// 【为什么必须有这个测试】2026-09-28 线上事故（用户报的「糊涂鳄用本地网络签到失败」）：
//   任务被扩展领走时会被标记成 running，而结果回传只认 status='pending' →
//   每一次真实回传都匹配 0 行 → 面板永远拿不到响应，两分钟后判「扩展没有回传（可能被关闭或休眠）」，
//   而扩展其实早就答完了。同时 GET /api/external/relay/:id 又把 running 落进「done」的兜底分支，
//   于是面板看到的是「任务完成了，但状态码和正文全是空」——
//   站点模块再据此得出「站点不认这个接口」的**错误结论**，用户在面板上看到「本地网络签到失败」，
//   站点却一直在正常回答（实测：带面板那份 Cookie 直连本站，user_qiandao 0.2 秒就回
//   {"status":"0","msg":"今日已签到，请明日再来"}）。
//
// 这个文件直接驱动 Worker 的 HTTP 处理函数（假 D1），把这条链路钉死：
//   ① 领走后必须如实报 running（不许谎报 done）
//   ② 租约中回传的结果必须存下来（不许丢）
//   ③ 结果只能写一次（迟到的第二次回传不许覆盖）
//   ④ 领走但始终没回传 → 租约过期仍要判失败（回收不能被删掉）
//   ⑤ 「done 但空响应」在面板侧就要报「链路没把响应带回来」，不许当站点返回空
import assert from 'node:assert/strict';

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log('ok -', name); };

const KEY = 'k'.repeat(24);

// ---- 极简 D1 仿真：settings + relay_jobs（够跑通中继的整条生命周期）----
function makeDb() {
  const settings = new Map();
  const jobs = new Map();
  const nonces = new Set();
  const norm = (sql) => String(sql).replace(/\s+/g, ' ').trim();

  // 仿真必须**看懂 WHERE 条件**：早期版本里这里一律放行，于是「回传只认 pending」的
  // 旧代码也能通过测试 —— 那样的测试只是装饰，钉不住真正的 bug。
  const whereAllows = (sql, row) => {
    const inList = sql.match(/status IN \(([^)]+)\)/i);
    if (inList) {
      const names = inList[1].split(',').map((s) => s.trim().replace(/^'|'$/g, ''));
      return names.includes(row.status);
    }
    const eq = sql.match(/status\s*=\s*'([a-z]+)'/i);
    if (eq) return row.status === eq[1];
    return true;
  };

  const prepare = (sqlRaw) => {
    const sql = norm(sqlRaw);
    const stmt = {
      _args: [],
      bind(...a) { stmt._args = a; return stmt; },
      async first() {
        if (/^SELECT value FROM settings/i.test(sql)) {
          const v = settings.get(stmt._args[0]);
          return v === undefined ? null : { value: v };
        }
        if (/^SELECT \* FROM relay_jobs WHERE id = \?/i.test(sql)) {
          const row = jobs.get(stmt._args[0]);
          return row ? { ...row } : null;
        }
        return null;
      },
      async all() {
        if (/^PRAGMA table_info/i.test(sql)) return { results: [] };
        if (/^SELECT id, url, method, headers, body, options FROM relay_jobs WHERE status = 'pending'/i.test(sql)) {
          const limit = Number((sql.match(/LIMIT (\d+)/i) || [])[1] || 2);
          const rows = [...jobs.values()].filter((r) => r.status === 'pending').sort((a, b) => a.created_at - b.created_at).slice(0, limit);
          return { results: rows.map((r) => ({ ...r })) };
        }
        if (/^SELECT id, url, method, status, created_at FROM relay_jobs/i.test(sql)) {
          return { results: [...jobs.values()].map((r) => ({ id: r.id, url: r.url, method: r.method, status: r.status, created_at: r.created_at })) };
        }
        return { results: [] };
      },
      async run() {
        const a = stmt._args;
        // settings
        if (/^INSERT INTO settings/i.test(sql)) { settings.set(a[0], a[1]); return { meta: { changes: 1 } }; }
        // 建表 / 补列 / 建索引：仿真里直接当成功
        if (/^(CREATE TABLE|CREATE INDEX|ALTER TABLE)/i.test(sql)) return { meta: { changes: 0 } };
        if (/^INSERT OR IGNORE INTO api_nonces/i.test(sql)) { if (nonces.has(a[0])) return { meta: { changes: 0 } }; nonces.add(a[0]); return { meta: { changes: 1 } }; }
        if (/^DELETE FROM api_nonces/i.test(sql)) return { meta: { changes: 0 } };
        // 入队
        if (/^INSERT INTO relay_jobs/i.test(sql)) {
          const [id, url, method, headers, body, options, status, created_at, updated_at] = a;
          jobs.set(id, { id, url, method, headers, body, options, status, created_at, updated_at, resp_status: null, resp_headers: null, resp_body: null, error: null });
          return { meta: { changes: 1 } };
        }
        if (/^DELETE FROM relay_jobs WHERE created_at < \?/i.test(sql)) {
          for (const [id, r] of jobs) if (r.created_at < a[0]) jobs.delete(id);
          return { meta: { changes: 0 } };
        }
        // 租出（领走）→ running
        if (/^UPDATE relay_jobs SET status='running'/i.test(sql)) {
          const [now, id] = a;
          const r = jobs.get(id);
          if (!r || r.status !== 'pending') return { meta: { changes: 0 } };
          r.status = 'running'; r.updated_at = now;
          return { meta: { changes: 1 } };
        }
        // 回传结果 → done（租约中也要收）
        if (/^UPDATE relay_jobs SET status='done'/i.test(sql)) {
          const [status, headers, body, now, id] = a;
          const r = jobs.get(id);
          if (!r || !whereAllows(sql, r)) return { meta: { changes: 0 } };
          r.status = 'done'; r.resp_status = status; r.resp_headers = headers; r.resp_body = body; r.updated_at = now;
          return { meta: { changes: 1 } };
        }
        // 回传错误 → failed
        if (/^UPDATE relay_jobs SET status='failed', error=\?, updated_at=\? WHERE id=\?/i.test(sql)) {
          const [error, now, id] = a;
          const r = jobs.get(id);
          if (!r || !whereAllows(sql, r)) return { meta: { changes: 0 } };
          r.status = 'failed'; r.error = error; r.updated_at = now;
          return { meta: { changes: 1 } };
        }
        // 回收过期租约 → failed
        if (/^UPDATE relay_jobs SET status='failed', error='扩展没有在 2 分钟内回传/i.test(sql)) {
          const [now, before] = a;
          let changes = 0;
          for (const r of jobs.values()) {
            if (r.status === 'running' && r.updated_at < before) { r.status = 'failed'; r.error = '扩展没有在 2 分钟内回传（可能被关闭或休眠），已放弃该请求'; r.updated_at = now; changes++; }
          }
          return { meta: { changes } };
        }
        return { meta: { changes: 0 } };
      },
    };
    return stmt;
  };

  return {
    settings, jobs,
    prepare,
    // D1 的 batch 是真执行（领走任务就是靠 batch 标记 running 的，仿真里不能空转）
    async batch(stmts) { return Promise.all((stmts || []).map((s) => s.run())); },
  };
}

const worker = (await import('../src/index.js')).default;

function makeCall(db) {
  const env = { DB: db, EXTERNAL_API_KEY: KEY };
  return async (method, path, body) => {
    const req = new Request('https://panel.example' + path, {
      method,
      headers: { 'X-Api-Key': KEY, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const res = await worker.fetch(req, env, {});
    const text = await res.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
    return { status: res.status, json: parsed };
  };
}

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

await t('中继租约①：扩展领走后，面板必须看到 running（不能谎报「完成了但没有响应」）', async () => {
  const db = makeDb();
  const call = makeCall(db);
  const created = await call('POST', '/api/external/relay', { url: 'https://hutue.cn/', method: 'GET', headers: {} });
  assert.equal(created.status, 200);
  const id = created.json.job_id;

  // 还没人领：pending
  assert.equal((await call('GET', '/api/external/relay/' + id)).json.status, 'pending');

  // 扩展来领任务
  const handout = await call('GET', '/api/external/relay-pending?wait=0');
  assert.equal(handout.json.jobs.length, 1, '扩展应能领到这条任务');
  assert.equal(handout.json.jobs[0].id, id);

  // 租约中：必须是 running，并且不能带一个空的 response（那会被误读成「站点返回空」）
  const leased = (await call('GET', '/api/external/relay/' + id)).json;
  assert.equal(leased.status, 'running', '领走后的状态必须是 running');
  assert.equal(leased.response, undefined, 'running 不该带 response');
});

await t('中继租约②：租约中回传的结果必须被存下来（这正是线上丢响应的地方）', async () => {
  const db = makeDb();
  const call = makeCall(db);
  const id = (await call('POST', '/api/external/relay', { url: 'https://hutue.cn/wp-admin/admin-ajax.php', method: 'POST', headers: {}, body: b64('action=user_qiandao') })).json.job_id;
  await call('GET', '/api/external/relay-pending?wait=0'); // 扩展领走 → running

  const siteSaid = '{"status":"0","msg":"今日已签到，请明日再来"}';
  const sent = await call('POST', `/api/external/relay/${id}/result`, {
    status: 200,
    headers: { 'x-relay-url': 'https://hutue.cn/wp-admin/admin-ajax.php' },
    body_base64: b64(siteSaid),
  });
  assert.equal(sent.json.ok, true);

  const done = (await call('GET', '/api/external/relay/' + id)).json;
  assert.equal(done.status, 'done', '回传后必须是 done，不能还停在 running');
  assert.equal(done.response.status, 200, '状态码必须存下来');
  assert.equal(Buffer.from(done.response.body_base64, 'base64').toString('utf8'), siteSaid, '正文必须原样存下来');
});

await t('中继租约③：结果只能写一次，迟到的第二次回传不许覆盖', async () => {
  const db = makeDb();
  const call = makeCall(db);
  const id = (await call('POST', '/api/external/relay', { url: 'https://example.com/', method: 'GET', headers: {} })).json.job_id;
  await call('GET', '/api/external/relay-pending?wait=0');
  await call('POST', `/api/external/relay/${id}/result`, { status: 200, headers: {}, body_base64: b64('第一次') });
  await call('POST', `/api/external/relay/${id}/result`, { status: 500, headers: {}, body_base64: b64('第二次') });
  const done = (await call('GET', '/api/external/relay/' + id)).json;
  assert.equal(done.response.status, 200);
  assert.equal(Buffer.from(done.response.body_base64, 'base64').toString('utf8'), '第一次');
});

await t('中继租约④：领走但始终没回传，租约过期后仍要判失败（回收路线不能丢）', async () => {
  const db = makeDb();
  const call = makeCall(db);
  const id = (await call('POST', '/api/external/relay', { url: 'https://example.com/slow', method: 'GET', headers: {} })).json.job_id;
  await call('GET', '/api/external/relay-pending?wait=0');
  // 把租约时间拨回 3 分钟前：模拟「扩展被浏览器回收、任务永远停在 running」
  db.jobs.get(id).updated_at = Date.now() - 3 * 60000;
  await call('GET', '/api/external/relay-pending?wait=0'); // 下一次轮询触发回收
  const row = (await call('GET', '/api/external/relay/' + id)).json;
  assert.equal(row.status, 'failed');
  assert.match(row.error, /2 分钟内回传/);
});

await t('中继租约⑤：「done 但响应为空」要在面板侧就报链路失败，不许交给站点模块乱解释', async () => {
  const { waitRelayResult } = await import('../src/lib/relay.js');
  const fake = {
    prepare: () => ({
      bind() { return this; },
      async first() {
        return { status: 'done', resp_status: null, resp_headers: '{}', resp_body: '', method: 'POST', url: 'https://hutue.cn/wp-admin/admin-ajax.php' };
      },
    }),
  };
  const err = await waitRelayResult(fake, 'r-empty', 150, 20).catch((e) => e);
  assert.ok(err instanceof Error, '必须抛错，而不是把空响应当成站点回复');
  assert.equal(err.outcome, 'relay', '要按网络层失败处理，自动模式才会换另一条路线');
  assert.match(err.message, /空响应/);
  assert.match(err.message, /不是站点的问题/);
  assert.match(err.detail, /POST https:\/\/hutue\.cn\/wp-admin\/admin-ajax\.php/);
});

await t('中继租约⑥：正常响应（有状态码）照样原样交给站点模块', async () => {
  const { waitRelayResult } = await import('../src/lib/relay.js');
  const body = Buffer.from('{"status":"0","msg":"今日已签到，请明日再来"}', 'utf8').toString('base64');
  const fake = {
    prepare: () => ({
      bind() { return this; },
      async first() {
        return { status: 'done', resp_status: 200, resp_headers: JSON.stringify({ 'x-relay-url': 'https://hutue.cn/x' }), resp_body: body, method: 'POST', url: 'https://hutue.cn/wp-admin/admin-ajax.php' };
      },
    }),
  };
  const r = await waitRelayResult(fake, 'r-ok', 150, 20);
  assert.equal(r.status, 200);
  assert.equal(r.url, 'https://hutue.cn/x');
  assert.match(new TextDecoder().decode(r.body), /今日已签到/);
});

console.log(`\n${n} 组通过`);
