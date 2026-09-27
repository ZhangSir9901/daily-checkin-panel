// Worker 入口：REST API + Cron 调度。
// 认证：单管理员密码（PBKDF2 存 D1），会话为服务端 session + HttpOnly Cookie。

import { ensureSchema, getSetting, setSetting } from './db.js';
import { hashPassword, verifyPassword, encryptJSON, decryptJSON, randomHex } from './crypto.js';
import { handleExtZip } from './ext-zip.js';
import { runAll, runAccount } from './runner.js';
import { getSite, siteMeta, getBrowserScript } from './sites/index.js';
import { getNotifyConfig, setNotifyConfig } from './notify.js';
import { probeSignEndpoints } from './probe.js';
import { shouldRun, validHour, validTime, validTz, accountHour, dayInTz, dayStartInTz } from './schedule.js';
import { runHttpSteps } from './sites/http.js';
import { verifyExternalRequest } from './lib/ext-auth.js';

// 外部请求鉴权已迁移到 src/lib/ext-auth.js（API Key + HMAC 签名 + 防重放）。

const SESSION_TTL_MS = 7 * 864e5;

// 「今天」以哪个时区为准：跟随设置里的 schedule_tz（默认 Asia/Shanghai）。
// 签到时间、状态列跨零点重置、当天签到记录查询必须用同一个时区，否则会差一天。
async function scheduleTz(db) {
  try { return (await getSetting(db, 'schedule_tz')) || 'Asia/Shanghai'; } catch { return 'Asia/Shanghai'; }
}

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...extra },
  });
}

function parseCookies(req) {
  const h = req.headers.get('Cookie') || '';
  const out = {};
  for (const p of h.split(';')) {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  }
  return out;
}

function sessionCookie(sid, maxAgeSec) {
  return `sid=${encodeURIComponent(sid)}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=${maxAgeSec}`;
}

async function authed(env, req) {
  const sid = parseCookies(req).sid;
  if (!sid) return false;
  const row = await env.DB.prepare('SELECT expires_at FROM sessions WHERE id = ?').bind(sid).first();
  if (!row) return false;
  if (row.expires_at < Date.now()) {
    await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(sid).run();
    return false;
  }
  return true;
}

// 请求体只能读一次（流不可重放），这里缓存原始文本：
// 既供 JSON 解析，又供扩展请求的签名校验（签名要覆盖 body）。
const RAW_BODY = new WeakMap();
async function readBodyRaw(req) {
  if (RAW_BODY.has(req)) return RAW_BODY.get(req);
  let text = '';
  try { text = await req.text(); } catch { text = ''; }
  RAW_BODY.set(req, text);
  return text;
}

async function readBody(req) {
  const text = await readBodyRaw(req);
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

async function createSession(env) {
  const sid = randomHex(24);
  const now = Date.now();
  await env.DB.prepare('INSERT INTO sessions(id, created_at, expires_at) VALUES(?,?,?)')
    .bind(sid, now, now + SESSION_TTL_MS)
    .run();
  return sid;
}

async function handleApi(req, env, url) {
  const path = url.pathname;
  const method = req.method.toUpperCase();

  // 扩展/外部请求鉴权：API Key +（可选）HMAC 签名与防重放。
  // 通过后顺手记下扩展活跃时间，用于面板展示「扩展在线」状态。
  // 返回 null 表示放行；否则返回应直接发回的 401 Response。
  const extGuard = async () => {
    const r = await verifyExternalRequest(req, env, env.DB, { getRawBody: () => readBodyRaw(req) });
    if (!r.ok) return json({ error: r.error || '鉴权失败' }, r.status || 401);
    const now = Date.now();
    try {
      await setSetting(env.DB, 'ext_last_seen', String(now));
      // 只在确实带了签名时更新，否则会把「上次成功签名」的时间抹掉
      if (r.signed) await setSetting(env.DB, 'ext_last_signed', String(now));
    } catch { /* 忽略 */ }
    return null;
  };

  // ---- 公开接口 ----
  if (path === '/api/status' && method === 'GET') {
    const hash = await getSetting(env.DB, 'admin_hash');
    return json({ setup_needed: !hash, logged_in: await authed(env, req) });
  }

  if (path === '/api/setup' && method === 'POST') {
    if (await getSetting(env.DB, 'admin_hash')) return json({ error: '已经初始化过了' }, 400);
    const { password } = await readBody(req);
    if (!password || String(password).length < 6) return json({ error: '密码至少 6 位' }, 400);
    await setSetting(env.DB, 'admin_hash', await hashPassword(String(password)));
    const sid = await createSession(env);
    return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(sid, SESSION_TTL_MS / 1000) });
  }

  if (path === '/api/login' && method === 'POST') {
    const hash = await getSetting(env.DB, 'admin_hash');
    if (!hash) return json({ error: '尚未初始化，请先设置管理密码' }, 400);
    const { password } = await readBody(req);
    if (!(await verifyPassword(String(password || ''), hash))) return json({ error: '密码错误' }, 401);
    const sid = await createSession(env);
    return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(sid, SESSION_TTL_MS / 1000) });
  }

  // ---- 外部上报接口（VM 定时任务 / 浏览器扩展用 API Key 认证，不走 session） ----
  if (path === '/api/external/report' && method === 'POST') {
    const deny = await extGuard();
    if (deny) return deny;
    const { account_id, status, message, detail, duration_ms } = await readBody(req);
    const acc = await env.DB.prepare('SELECT id, site, name FROM accounts WHERE id = ?').bind(Number(account_id)).first();
    if (!acc) return json({ error: '账号不存在' }, 404);
    // 校验 status 只允许 ok/fail/skip，防止非法值写入
    const validStatus = ['ok', 'fail', 'skip'].includes(status) ? status : 'fail';
    await env.DB.prepare(
      'INSERT INTO runs(account_id, site, name, status, message, detail, duration_ms, created_at) VALUES(?,?,?,?,?,?,?,?)'
    ).bind(acc.id, acc.site, acc.name, validStatus, message || '', detail || '', duration_ms || 0, Date.now()).run();
    await env.DB.prepare('DELETE FROM runs WHERE id NOT IN (SELECT id FROM runs ORDER BY id DESC LIMIT 500)').run();
    // 同步更新账号的上次结果；成功时记录今日已签到日期
    const fullAcc = await env.DB.prepare('SELECT meta FROM accounts WHERE id = ?').bind(acc.id).first();
    let rmeta = {};
    try { rmeta = JSON.parse(fullAcc?.meta || '{}'); } catch { /* 忽略 */ }
    if (validStatus === 'ok') {
      rmeta.last_signin_date = dayInTz(new Date(), await scheduleTz(env.DB));
    }
    await env.DB.prepare('UPDATE accounts SET last_status=?, last_msg=?, last_detail=?, last_run_at=?, meta=?, updated_at=? WHERE id=?')
      .bind(validStatus, message || '', detail || '', Date.now(), JSON.stringify(rmeta), Date.now(), acc.id).run();
    // 如果是手动任务队列中的，上报后删除（避免重复执行）
    await env.DB.prepare('DELETE FROM browser_manual_jobs WHERE account_id = ?').bind(acc.id).run().catch(() => {});
    return json({ ok: true });
  }

  // ---- 外部查询账号状态（VM 跑之前检查是否启用） ----
  const mExtAcc = path.match(/^\/api\/external\/account\/(\d+)$/);
  if (mExtAcc && method === 'GET') {
    const deny = await extGuard();
    if (deny) return deny;
    const acc = await env.DB.prepare('SELECT id, site, name, enabled FROM accounts WHERE id = ?').bind(Number(mExtAcc[1])).first();
    if (!acc) return json({ error: '账号不存在' }, 404);
    return json({ id: acc.id, site: acc.site, name: acc.name, enabled: !!acc.enabled });
  }

  // ---- 外部查询账号凭据（VM 代签用，返回解密后的 cookie / user_agent 等） ----
  // 面板是唯一凭据源：用户在面板更新 Cookie 后，VM 下次运行自动取到最新值，无需手动同步文件
  const mExtCreds = path.match(/^\/api\/external\/account\/(\d+)\/creds$/);
  if (mExtCreds && method === 'GET') {
    const deny = await extGuard();
    if (deny) return deny;
    const acc = await env.DB.prepare('SELECT id, site, name, enabled, creds FROM accounts WHERE id = ?').bind(Number(mExtCreds[1])).first();
    if (!acc) return json({ error: '账号不存在' }, 404);
    let creds = {};
    try { creds = await decryptJSON(env, env.DB, acc.creds) || {}; } catch { /* 解密失败则返回空 */ }
    return json({
      id: acc.id,
      site: acc.site,
      name: acc.name,
      enabled: !!acc.enabled,
      cookie: creds.cookie || '',
      user_agent: creds.user_agent || '',
    });
  }

  // ---- 外部查询 NodeSeek 模式（VM 用） ----
  if (path === '/api/external/nodeseek-mode' && method === 'GET') {
    const deny = await extGuard();
    if (deny) return deny;
    const mode = (await getSetting(env.DB, 'nodeseek_mode')) || 'random';
    return json({ mode });
  }

  // ---- 扩展连接检查（无副作用，不消费任务） ----
  if (path === '/api/external/ping' && method === 'GET') {
    const deny = await extGuard();
    if (deny) return deny;
    return json({ ok: true, version: '2.2', time: Date.now() });
  }

  // ---- 浏览器扩展：任务已并入「本地网络中继」，这里不再下发脚本 ----
  // 浏览器模式（含站点默认 browser 的吾爱破解 / NodeSeek / V2EX / 看雪 / Discuz）统一走中继：
  // 站点逻辑仍在 Worker，HTTP 请求由扩展在用户本地网络中执行（见 runner.js），
  // 既解决了 MV3 无法执行面板脚本的问题，也避免与中继重复执行。
  // 若站点需要人工过人机验证，请用面板上的「打开验证页」，验证后重新「一键发送」刷新 Cookie。
  if (path === '/api/external/browser-jobs' && method === 'GET') {
    const deny = await extGuard();
    if (deny) return deny;
    return json({ jobs: [] });
  }

  // ---- 一次性交接码（扩展 → 面板）----
  // 扩展不再把整包 Cookie 塞进 URL：先 POST 到这里暂存，URL 里只带一个短码，
  // 面板页面用短码取回。好处是登录凭据不再进入浏览器地址栏 / 历史记录。
  if (path === '/api/external/handoff' && method === 'POST') {
    const deny = await extGuard();
    if (deny) return deny;
    const { domain, cookies, cookieList, userAgent, localStorage, stats } = await readBody(req);
    if (!cookies || !String(cookies).trim()) return json({ error: '没有可交接的 Cookie' }, 400);
    const code = randomHex(16);
    const now = Date.now();
    await env.DB.prepare('INSERT INTO handoffs(code, payload, created_at, expires_at, used) VALUES(?,?,?,?,0)')
      .bind(code, JSON.stringify({
        domain: String(domain || ''),
        cookies: String(cookies),
        cookieList: Array.isArray(cookieList) ? cookieList.slice(0, 300) : [],
        userAgent: String(userAgent || ''),
        localStorage: localStorage && typeof localStorage === 'object' ? localStorage : {},
        stats: stats && typeof stats === 'object' ? stats : {},
        ts: now,
      }), now, now + 5 * 60 * 1000).run();
    await env.DB.prepare('DELETE FROM handoffs WHERE expires_at < ?').bind(now - 3600000).run().catch(() => {});
    return json({ ok: true, code, expires_in: 300 });
  }

  // 面板页面凭短码取回交接内容：一次性 + 5 分钟过期 + 取完即作废
  if (path.startsWith('/api/handoff/') && method === 'GET') {
    const code = decodeURIComponent(path.slice('/api/handoff/'.length));
    if (!/^[A-Za-z0-9]{16,64}$/.test(code)) return json({ error: '交接码格式不正确' }, 400);
    const row = await env.DB.prepare('SELECT code, payload, expires_at, used FROM handoffs WHERE code = ?').bind(code).first();
    if (!row) return json({ error: '交接码不存在或已被使用，请在扩展里重新发送' }, 404);
    if (row.used) return json({ error: '交接码已使用过，请在扩展里重新发送' }, 410);
    if (row.expires_at < Date.now()) return json({ error: '交接码已过期，请在扩展里重新发送' }, 410);
    await env.DB.prepare('UPDATE handoffs SET used = 1 WHERE code = ?').bind(row.code).run();
    let payload = {};
    try { payload = JSON.parse(row.payload); } catch { /* 忽略 */ }
    return json({ ok: true, payload });
  }

  // ---- 扩展报到：上报版本 / UA / 能力，面板据此显示「扩展在线 + 版本」----
  if (path === '/api/external/hello' && method === 'POST') {
    const deny = await extGuard();
    if (deny) return deny;
    const { version, ua, capabilities } = await readBody(req);
    const info = {
      version: String(version || '').slice(0, 24),
      ua: String(ua || '').slice(0, 200),
      capabilities: Array.isArray(capabilities) ? capabilities.slice(0, 20).map(String) : [],
      last_seen: Date.now(),
    };
    await setSetting(env.DB, 'ext_status', JSON.stringify(info));
    return json({ ok: true, server_version: '2.3' });
  }

  // ---- 扩展领取面板下发的指令（登录协助等）----
  if (path === '/api/external/commands' && method === 'GET') {
    const deny = await extGuard();
    if (deny) return deny;
    const { results } = await env.DB.prepare(
      "SELECT id, kind, account_id, domain, login_url, payload FROM ext_commands WHERE status = 'pending' ORDER BY created_at LIMIT 5"
    ).all();
    return json({
      commands: (results || []).map((c) => {
        let payload = {};
        try { payload = JSON.parse(c.payload || '{}'); } catch { /* 忽略 */ }
        return { id: c.id, kind: c.kind, account_id: c.account_id, domain: c.domain || '', login_url: c.login_url || '', payload };
      }),
    });
  }

  // 扩展回传指令执行结果
  if (path.startsWith('/api/external/commands/') && path.endsWith('/result') && method === 'POST') {
    const deny = await extGuard();
    if (deny) return deny;
    const cid = path.slice('/api/external/commands/'.length, -'/result'.length);
    const { status, result } = await readBody(req);
    const st = status === 'done' ? 'done' : 'failed';
    await env.DB.prepare("UPDATE ext_commands SET status=?, result=?, updated_at=? WHERE id=? AND status='pending'")
      .bind(st, String(result || '').slice(0, 500), Date.now(), cid).run();
    return json({ ok: true });
  }

  // ---- 诊断：中继队列状态（需要登录） ----
  if (path === '/api/diag/relay' && method === 'GET') {
    if (!(await authed(env, req))) return json({ error: '未登录' }, 401);
    try {
      const { results: pending } = await env.DB.prepare(
        "SELECT id, url, method, status, created_at FROM relay_jobs WHERE status = 'pending' ORDER BY created_at DESC LIMIT 10"
      ).all();
      const { results: recent } = await env.DB.prepare(
        "SELECT id, url, method, status, created_at FROM relay_jobs ORDER BY created_at DESC LIMIT 10"
      ).all();
      const lastPoll = await getSetting(env.DB, 'relay_last_poll');
      return json({
        pending: pending || [],
        recent: recent || [],
        last_poll: lastPoll ? new Date(Number(lastPoll)).toISOString() : null,
        last_poll_ago_sec: lastPoll ? Math.floor((Date.now() - Number(lastPoll)) / 1000) : null,
      });
    } catch (e) {
      return json({ error: '查询失败: ' + e.message }, 500);
    }
  }

  // ---- 本地网络中继代理 ----
  // Worker 把 HTTP 请求存入队列，浏览器扩展用用户本地网络执行后回传响应。
  // 适用于：站点逻辑复杂、希望逻辑保留在 Worker，但需要用户本地 IP 的场景。
  //
  // POST /api/external/relay { url, method, headers, body } → { job_id }
  //   body 为 base64（可空）；headers 为对象
  // GET /api/external/relay/:id → { status: pending|done|failed, response?, error? }
  //   response: { status, headers, body_base64 }
  // GET /api/external/relay-pending → { jobs: [{ id, url, method, headers, body_base64 }] }（扩展轮询）
  // POST /api/external/relay/:id/result { status, headers, body_base64 } 或 { error }
  //   扩展执行完成后回传

  // Worker 提交中继请求
  if (path === '/api/external/relay' && method === 'POST') {
    const deny = await extGuard();
    if (deny) return deny;
    const { url, method, headers, body, options } = await readBody(req);
    if (!url || !/^https?:\/\//i.test(String(url))) {
      return json({ error: 'url 非法' }, 400);
    }
    const id = 'r_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
    const now = Date.now();
    await env.DB.prepare(
      'INSERT INTO relay_jobs(id, url, method, headers, body, options, status, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?)'
    ).bind(
      id,
      String(url),
      String(method || 'GET').toUpperCase(),
      JSON.stringify(headers || {}),
      body ? String(body) : null, // base64
      JSON.stringify(options || {}),
      'pending',
      now,
      now
    ).run();
    // 清理 10 分钟前的旧任务（避免表无限增长）
    await env.DB.prepare("DELETE FROM relay_jobs WHERE created_at < ?").bind(now - 600000).run().catch(() => {});
    return json({ job_id: id });
  }

  // Worker 查询中继结果（轮询）
  const mRelayGet = path.match(/^\/api\/external\/relay\/([A-Za-z0-9_]+)$/);
  if (mRelayGet && method === 'GET') {
    const deny = await extGuard();
    if (deny) return deny;
    const job = await env.DB.prepare('SELECT * FROM relay_jobs WHERE id = ?').bind(mRelayGet[1]).first();
    if (!job) return json({ error: '任务不存在' }, 404);
    if (job.status === 'pending') return json({ status: 'pending' });
    if (job.status === 'failed') return json({ status: 'failed', error: job.error || '执行失败' });
    return json({
      status: 'done',
      response: {
        status: job.resp_status,
        headers: JSON.parse(job.resp_headers || '{}'),
        body_base64: job.resp_body || '',
      },
    });
  }

  // 扩展获取待执行的中继任务
  // 支持长轮询：?wait=20000 → 没有任务时挂起最多 20 秒（每 800ms 查一次 D1），
  // 一有任务立刻返回。这样「点执行」后扩展几乎立刻领走任务，不用等 30 秒的 alarm 周期
  // （Chrome 会把 alarms 的最小周期压到 0.5 分钟，短轮询必然导致每跳 15~30 秒延迟）。
  if (path === '/api/external/relay-pending' && method === 'GET') {
    const deny = await extGuard();
    if (deny) return deny;
    const startPollAt = Date.now();
    const wait = Math.min(Math.max(parseInt(url.searchParams.get('wait') || '0', 10) || 0, 0), 20000);
    const deadline = Date.now() + wait;
    const readPending = async () => {
      const { results } = await env.DB.prepare(
        "SELECT id, url, method, headers, body, options FROM relay_jobs WHERE status = 'pending' ORDER BY created_at LIMIT 10"
      ).all();
      return (results || []).map((j) => ({
        id: j.id,
        url: j.url,
        method: j.method,
        headers: JSON.parse(j.headers || '{}'),
        body_base64: j.body || null,
        options: JSON.parse(j.options || '{}'),
      }));
    };
    // 记录扩展最后轮询时间，用于判断扩展是否在线（自动中继）；
    // 同时记下扩展版本（?v=2.2），面板可以提醒用户版本是否陈旧。
    await setSetting(env.DB, 'relay_last_poll', String(Date.now())).catch(() => {});
    const extVer = String(url.searchParams.get('v') || '').slice(0, 16);
    if (extVer) await setSetting(env.DB, 'relay_version', extVer).catch(() => {});
    let jobs = await readPending();
    while (!jobs.length && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 800));
      jobs = await readPending();
    }
    // 长轮询期间也要保活「扩展在线」状态，否则面板会误判扩展已离线
    if (Date.now() - startPollAt > 5000) {
      await setSetting(env.DB, 'relay_last_poll', String(Date.now())).catch(() => {});
    }
    return json({ jobs, waited: wait > 0 });
  }

  // 扩展回传中继结果
  const mRelayResult = path.match(/^\/api\/external\/relay\/([A-Za-z0-9_]+)\/result$/);
  if (mRelayResult && method === 'POST') {
    const deny = await extGuard();
    if (deny) return deny;
    const { status, headers, body_base64, error } = await readBody(req);
    const now = Date.now();
    if (error) {
      await env.DB.prepare("UPDATE relay_jobs SET status='failed', error=?, updated_at=? WHERE id=? AND status='pending'")
        .bind(String(error).slice(0, 500), now, mRelayResult[1]).run();
    } else {
      await env.DB.prepare("UPDATE relay_jobs SET status='done', resp_status=?, resp_headers=?, resp_body=?, updated_at=? WHERE id=? AND status='pending'")
        .bind(
          Number(status) || 0,
          JSON.stringify(headers || {}),
          body_base64 ? String(body_base64) : '',
          now,
          mRelayResult[1]
        ).run();
    }
    return json({ ok: true });
  }

  if (!(await authed(env, req))) return json({ error: '未登录' }, 401);

  // ---- 登录后接口 ----
  if (path === '/api/logout' && method === 'POST') {
    const sid = parseCookies(req).sid;
    if (sid) await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(sid).run();
    return json({ ok: true }, 200, { 'Set-Cookie': 'sid=; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0' });
  }

  if (path === '/api/me' && method === 'GET') return json({ logged_in: true });

  if (path === '/api/sites' && method === 'GET') return json({ sites: siteMeta() });

  // 账号列表（不含凭据，含 meta 以便前端渲染站点独立开关）
  if (path === '/api/accounts' && method === 'GET') {
    const { results } = await env.DB.prepare(
      'SELECT id, name, site, enabled, meta, last_status, last_msg, last_detail, last_run_at, created_at, updated_at FROM accounts ORDER BY id'
    ).all();
    const accounts = results || [];
    // 回填：今日有成功记录但 meta 缺 last_signin_date 的，补上（兼容旧数据）
    const today = dayInTz(new Date(), await scheduleTz(env.DB));
    const dayStart = dayStartInTz(new Date(), await scheduleTz(env.DB));
    for (const acc of accounts) {
      let m = {};
      try { m = JSON.parse(acc.meta || '{}'); } catch { /* 忽略 */ }
      if (m.last_signin_date !== today) {
        // 查今日是否有成功记录
        const okRun = await env.DB.prepare(
          "SELECT id FROM runs WHERE account_id = ? AND status = 'ok' AND created_at >= ? LIMIT 1"
        ).bind(acc.id, dayStart).first();
        if (okRun) {
          m.last_signin_date = today;
          // 同时把网站反馈补上（取今日最后一条成功的 message + 网站原文）
          const lastOk = await env.DB.prepare(
            "SELECT message, detail FROM runs WHERE account_id = ? AND status = 'ok' AND created_at >= ? ORDER BY id DESC LIMIT 1"
          ).bind(acc.id, dayStart).first();
          if (lastOk?.message) {
            acc.last_msg = lastOk.message;
            acc.last_status = 'ok';
            acc.last_detail = lastOk.detail || '';
          }
          acc.meta = JSON.stringify(m);
          await env.DB.prepare('UPDATE accounts SET meta=?, last_msg=?, last_status=?, last_detail=?, updated_at=? WHERE id=?')
            .bind(acc.meta, acc.last_msg, acc.last_status, acc.last_detail || '', Date.now(), acc.id).run();
        }
      }
    }
    return json({ accounts });
  }

  // 新增账号
  if (path === '/api/accounts' && method === 'POST') {
    const { name, site, creds } = await readBody(req);
    const s = getSite(site);
    if (!s) return json({ error: '未知站点' }, 400);
    if (!name || !String(name).trim()) return json({ error: '请填写备注名' }, 400);
    for (const f of s.fields) {
      if (f.required && !(creds && String(creds[f.key] || '').trim())) {
        return json({ error: `缺少必填项：${f.label}` }, 400);
      }
    }
    const enc = await encryptJSON(env, env.DB, creds || {});
    const now = Date.now();
    const r = await env.DB.prepare(
      'INSERT INTO accounts(name, site, creds, enabled, created_at, updated_at) VALUES(?,?,?,?,?,?)'
    ).bind(String(name).trim(), site, enc, 1, now, now).run();
    return json({ ok: true, id: r.meta.last_row_id });
  }

  const mAcc = path.match(/^\/api\/accounts\/(\d+)(\/run)?$/);
  if (mAcc) {
    const id = Number(mAcc[1]);
    const acc = await env.DB.prepare('SELECT * FROM accounts WHERE id = ?').bind(id).first();
    if (!acc) return json({ error: '账号不存在' }, 404);

    // 手动执行单个账号（browser 模式由浏览器扩展执行，面板不直接执行）
    if (mAcc[2] === '/run' && method === 'POST') {
      const site = getSite(acc.site);
      let execMode = site?.execution || 'server';
      try {
        const m = JSON.parse(acc.meta || '{}');
        if (m.execution === 'server' || m.execution === 'browser' || m.execution === 'relay') execMode = m.execution;
      } catch { /* 忽略 */ }
      // 浏览器模式已并入本地中继：直接执行，扩展在线即走用户本地网络（见 runner.js）
      const r = await runAccount(env, acc);
      return json({ ok: r.status === 'ok', result: r });
    }

    // 读取单个账号（含凭据，用于编辑回填）
    if (!mAcc[2] && method === 'GET') {
      const creds = await decryptJSON(env, env.DB, acc.creds);
      return json({ account: { id: acc.id, name: acc.name, site: acc.site, enabled: acc.enabled, creds } });
    }

    // 更新账号
    if (!mAcc[2] && method === 'PUT') {
      const { name, site, creds, enabled } = await readBody(req);
      const s = getSite(site || acc.site);
      if (!s) return json({ error: '未知站点' }, 400);
      const enc = creds ? await encryptJSON(env, env.DB, creds) : acc.creds;
      await env.DB.prepare('UPDATE accounts SET name=?, site=?, creds=?, enabled=?, updated_at=? WHERE id=?')
        .bind(
          name && String(name).trim() ? String(name).trim() : acc.name,
          site || acc.site,
          enc,
          enabled == null ? acc.enabled : enabled ? 1 : 0,
          Date.now(),
          id
        )
        .run();
      return json({ ok: true });
    }

    // 删除账号
    if (!mAcc[2] && method === 'DELETE') {
      await env.DB.prepare('DELETE FROM accounts WHERE id = ?').bind(id).run();
      return json({ ok: true });
    }
  }

  // 站点独立开关（如 NodeSeek 随机/固定签到）：切换后存入 accounts.meta.toggles
  const mToggle = path.match(/^\/api\/accounts\/(\d+)\/toggle$/);
  if (mToggle && method === 'POST') {
    const id = Number(mToggle[1]);
    const acc = await env.DB.prepare('SELECT * FROM accounts WHERE id = ?').bind(id).first();
    if (!acc) return json({ error: '账号不存在' }, 404);
    const site = getSite(acc.site);
    const { key, value } = await readBody(req);
    const def = site && site.toggles ? site.toggles.find((t) => t.key === key) : null;
    if (!def) return json({ error: '该站点不支持此开关' }, 400);
    let meta = {};
    try { meta = JSON.parse(acc.meta || '{}'); } catch { /* 忽略 */ }
    meta.toggles = meta.toggles || {};
    meta.toggles[key] = !!value;
    await env.DB.prepare('UPDATE accounts SET meta=?, updated_at=? WHERE id=?')
      .bind(JSON.stringify(meta), Date.now(), id).run();
    return json({ ok: true, value: !!value });
  }

  // 账号独立签到时间：PUT /api/accounts/:id/schedule { hour: "08" 或 "" }
  // hour 为 ""（空）表示跟随全局时间；"00"~"23" 为该账号独立的整点小时
  const mSched = path.match(/^\/api\/accounts\/(\d+)\/schedule$/);
  if (mSched && method === 'PUT') {
    const id = Number(mSched[1]);
    const acc = await env.DB.prepare('SELECT * FROM accounts WHERE id = ?').bind(id).first();
    if (!acc) return json({ error: '账号不存在' }, 404);
    const { hour } = await readBody(req);
    const h = String(hour || '').trim();
    if (h !== '' && !validTime(h)) return json({ error: '时间格式错误，请用 HH:MM（如 08:30）' }, 400);
    let meta = {};
    try { meta = JSON.parse(acc.meta || '{}'); } catch { /* 忽略 */ }
    if (h === '') delete meta.sched_hour;
    else meta.sched_hour = validTime(h);
    await env.DB.prepare('UPDATE accounts SET meta=?, updated_at=? WHERE id=?')
      .bind(JSON.stringify(meta), Date.now(), id).run();
    return json({ ok: true, hour: meta.sched_hour || '' });
  }

  // 账号执行模式切换：PUT /api/accounts/:id/execution
  // 在 跟随默认 → browser → relay → server → 跟随默认 之间循环
  // browser：扩展在用户浏览器中执行完整签到脚本（用户网络）
  // relay：Worker 保留站点逻辑，HTTP 经扩展用用户本地网络执行（中继代理）
  // server：Worker 直接请求（云端 IP）
  const mExec = path.match(/^\/api\/accounts\/(\d+)\/execution$/);
  if (mExec && method === 'PUT') {
    const id = Number(mExec[1]);
    const acc = await env.DB.prepare('SELECT * FROM accounts WHERE id = ?').bind(id).first();
    if (!acc) return json({ error: '账号不存在' }, 404);
    let meta = {};
    try { meta = JSON.parse(acc.meta || '{}'); } catch { /* 忽略 */ }
    const cur = meta.execution || '';
    // 「本地网络」只有浏览器扩展在线时才可用（扩展才是真正的本地网络中继）。
    const { isRelayAvailable } = await import('./lib/relay.js');
    const relayOk = await isRelayAvailable(env.DB);
    let next;
    const { target: want = '' } = await readBody(req);
    if (want === 'local') {
      if (!relayOk) return json({ error: '浏览器扩展当前离线，现在不能切换到「本地网络」。请先安装并打开扩展（顶部会显示在线状态），再试。' }, 400);
      next = 'browser';
    } else if (want === 'cf') {
      next = 'server';
    } else if (want === 'default') {
      next = '';
    } else {
      // 无参时循环切换：''（跟随默认） → 本地网络 → CF 网络 → ''
      // 扩展离线时跳过「本地网络」这一档，避免切到一个根本跑不了的模式里出不来
      next = cur === '' ? 'browser' : cur === 'browser' ? 'server' : '';
      if (next === 'browser' && !relayOk) next = 'server';
    }
    if (next === '') delete meta.execution;
    else meta.execution = next;
    await env.DB.prepare('UPDATE accounts SET meta=?, updated_at=? WHERE id=?')
      .bind(JSON.stringify(meta), Date.now(), id).run();
    return json({ ok: true, execution: next || 'default', relay_online: relayOk });
  }

  // 签到时间设置：每天几点（整点，0-23）+ 时区
  if (path === '/api/schedule' && method === 'GET') {
    const time = (await getSetting(env.DB, 'schedule_time')) || '08';
    const tz = (await getSetting(env.DB, 'schedule_tz')) || 'Asia/Shanghai';
    return json({ time, tz });
  }
  if (path === '/api/schedule' && method === 'PUT') {
    const { time, tz } = await readBody(req);
    const h = validTime(time);
    const z = validTz(tz);
    if (!h) return json({ error: '时间格式错误，请用 HH:MM（如 08:30）' }, 400);
    if (!z) return json({ error: '时区无效' }, 400);
    await setSetting(env.DB, 'schedule_time', h);
    await setSetting(env.DB, 'schedule_tz', z);
    return json({ ok: true, time: h, tz: z });
  }

  // 多步录制：不保存，直接试运行 steps（用于编辑时验证）
  if (path === '/api/http-test' && method === 'POST') {
    const { steps } = await readBody(req);
    try {
      const r = await runHttpSteps(Array.isArray(steps) ? steps : []);
      return json({ ok: true, ...r });
    } catch (e) {
      return json({ ok: false, error: String((e && e.message) || e) });
    }
  }

  // 手动执行全部启用的账号
  if (path === '/api/run-all' && method === 'POST') {
    const r = await runAll(env, { manual: true });
    return json({ ok: true, ...r });
  }

  // 签到接口自动探测：输入网站首页，自动寻找候选签到接口
  if (path === '/api/probe' && method === 'POST') {
    const { url, cookie } = await readBody(req);
    if (!url || !/^https?:\/\//i.test(String(url).trim())) {
      return json({ error: '请填写 http(s) 开头的网站地址' }, 400);
    }
    try {
      const r = await probeSignEndpoints({ url: String(url).trim(), cookie: String(cookie || '') });
      return json({ ok: true, ...r });
    } catch (e) {
      return json({ error: '探测失败：' + String((e && e.message) || e) }, 502);
    }
  }

  // 运行日志
  if (path === '/api/runs' && method === 'GET') {
    const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '100', 10) || 100, 1), 500);
    const accountId = parseInt(url.searchParams.get('account_id') || '0', 10) || 0;
    const status = url.searchParams.get('status') || '';
    const conds = [];
    const args = [];
    if (accountId) { conds.push('account_id = ?'); args.push(accountId); }
    if (status === 'ok' || status === 'fail') { conds.push('status = ?'); args.push(status); }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    const { results } = await env.DB.prepare(`SELECT * FROM runs ${where} ORDER BY id DESC LIMIT ?`).bind(...args, limit).all();
    return json({ runs: results || [] });
  }

  // 清空日志（只删 runs，不动 accounts：账号和登录信息不受影响）
  if (path === '/api/runs' && method === 'DELETE') {
    const accountId = parseInt(url.searchParams.get('account_id') || '0', 10) || 0;
    if (accountId) await env.DB.prepare('DELETE FROM runs WHERE account_id = ?').bind(accountId).run();
    else await env.DB.prepare('DELETE FROM runs').run();
    return json({ ok: true });
  }

  // 通知设置
  if (path === '/api/settings' && method === 'GET') {
    return json({ settings: await getNotifyConfig(env.DB) });
  }
  if (path === '/api/settings' && method === 'PUT') {
    await setNotifyConfig(env.DB, await readBody(req));
    return json({ ok: true });
  }

  // NodeSeek 模式（前端设置用）
  if (path === '/api/nodeseek-mode' && method === 'GET') {
    const mode = (await getSetting(env.DB, 'nodeseek_mode')) || 'random';
    return json({ mode });
  }
  if (path === '/api/nodeseek-mode' && method === 'PUT') {
    const { mode } = await readBody(req);
    if (mode !== 'random' && mode !== 'fixed') return json({ error: '无效的模式' }, 400);
    await setSetting(env.DB, 'nodeseek_mode', mode);
    return json({ ok: true });
  }

  // 扩展用 API Key（前端设置页管理，需登录）
  if (path === '/api/ext-key' && method === 'GET') {
    const key = (await getSetting(env.DB, 'external_api_key')) || '';
    // 只返回掩码版本，前端显示时可选择查看完整（已登录用户可信）
    return json({ key, masked: key ? key.slice(0, 4) + '****' + key.slice(-4) : '' });
  }
  if (path === '/api/ext-key' && method === 'PUT') {
    const { key } = await readBody(req);
    const k = String(key || '').trim();
    if (!k || k.length < 16) return json({ error: 'Key 至少 16 位' }, 400);
    await setSetting(env.DB, 'external_api_key', k);
    return json({ ok: true });
  }

  // 中继状态（扩展是否在线）：前端展示用
  if (path === '/api/relay-status' && method === 'GET') {
    const last = parseInt((await getSetting(env.DB, 'relay_last_poll')) || '0', 10) || 0;
    const online = Date.now() - last < 90000;
    const version = (await getSetting(env.DB, 'relay_version')) || '';
    return json({ online, last_poll: last, version });
  }

  // 修改管理密码
  if (path === '/api/change-password' && method === 'POST') {
    const { old_password, new_password } = await readBody(req);
    const hash = await getSetting(env.DB, 'admin_hash');
    if (!(await verifyPassword(String(old_password || ''), hash || ''))) {
      return json({ error: '原密码错误' }, 401);
    }
    if (!new_password || String(new_password).length < 6) return json({ error: '新密码至少 6 位' }, 400);
    await setSetting(env.DB, 'admin_hash', await hashPassword(String(new_password)));
    return json({ ok: true });
  }

  // ---- 扩展连接状态（面板展示用）----
  if (path === '/api/ext-status' && method === 'GET') {
    const lastSeen = parseInt((await getSetting(env.DB, 'ext_last_seen')) || '0', 10) || 0;
    const lastSigned = parseInt((await getSetting(env.DB, 'ext_last_signed')) || '0', 10) || 0;
    let info = {};
    try { info = JSON.parse((await getSetting(env.DB, 'ext_status')) || '{}'); } catch { /* 忽略 */ }
    let pending = 0;
    try {
      const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM ext_commands WHERE status = 'pending'").first();
      pending = (row && row.n) || 0;
    } catch { /* 忽略 */ }
    return json({
      online: !!lastSeen && Date.now() - lastSeen < 120000,
      last_seen_ago_sec: lastSeen ? Math.floor((Date.now() - lastSeen) / 1000) : null,
      version: info.version || '',
      ua: info.ua || '',
      capabilities: info.capabilities || [],
      signed_recently: !!lastSigned && Date.now() - lastSigned < 600000,
      require_sign: (await getSetting(env.DB, 'ext_require_sign')) === '1',
      pending_commands: pending,
    });
  }

  // ---- 扩展签名策略开关（默认关闭以兼容旧版扩展）----
  if (path === '/api/ext-security' && method === 'GET') {
    return json({ require_sign: (await getSetting(env.DB, 'ext_require_sign')) === '1' });
  }
  if (path === '/api/ext-security' && method === 'PUT') {
    const { require_sign } = await readBody(req);
    await setSetting(env.DB, 'ext_require_sign', require_sign ? '1' : '0');
    return json({ ok: true, require_sign: !!require_sign });
  }

  // ---- 让扩展帮某个账号打开登录页（登录/过验证后自动把新 Cookie 交接回面板）----
  if (path.startsWith('/api/accounts/') && path.endsWith('/assist') && method === 'POST') {
    const id = Number(path.slice('/api/accounts/'.length, -'/assist'.length));
    const acc = await env.DB.prepare('SELECT id, site, name FROM accounts WHERE id = ?').bind(id).first();
    if (!acc) return json({ error: '账号不存在' }, 404);
    const meta = siteMeta().find((s) => s.id === acc.site) || {};
    const login = meta.login || {};
    const loginUrl = login.url || (meta.domain ? 'https://' + meta.domain + '/' : '');
    if (!loginUrl) return json({ error: '该站点没有登记登录地址，请手动在浏览器打开站点登录后再用扩展抓取' }, 400);
    const cid = 'c_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
    const now = Date.now();
    await env.DB.prepare('INSERT INTO ext_commands(id, kind, account_id, domain, login_url, payload, status, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
      .bind(cid, 'open_login', id, meta.domain || '', loginUrl,
        JSON.stringify({ site: acc.site, name: acc.name, captcha: login.captcha || 'maybe', note: login.note || '' }),
        'pending', now, now).run();
    return json({ ok: true, command_id: cid, login_url: loginUrl, captcha: login.captcha || 'maybe', note: login.note || '' });
  }

  return json({ error: '未知接口' }, 404);
}

export default {
  async fetch(req, env, ctx) {
    try {
      const url = new URL(req.url);
      await ensureSchema(env.DB);
      if (url.pathname.startsWith('/api/')) return await handleApi(req, env, url);
      // 扩展下载：动态生成 zip，把当前面板地址注入进去（扩展自动带出面板地址；API Key 仍需手动填）
      if (url.pathname === '/cookie-helper-extension.zip') return await handleExtZip(req, env);
      if (url.pathname === '/cookie-plugin-2.2.zip') return await handleExtZip(req, env);
      // 非 API 请求交给静态资源（public 目录）
      if (env.ASSETS) {
        const res = await env.ASSETS.fetch(req);
        // 静态资源存在则直接返回；不存在才回退到 index.html（SPA）
        if (res.status !== 404) return res;
      }
      return new Response('Not Found', { status: 404 });
    } catch (e) {
      return json({ error: '服务异常：' + String((e && e.message) || e) }, 500);
    }
  },

  // Cron 触发：每小时触发一次，按各账号的签到时间（独立时间或全局时间）
  // 判断是否到达整点才执行。每个账号独立记录上次执行 key，避免重复。
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      (async () => {
        try {
          await ensureSchema(env.DB);
          const globalTime = (await getSetting(env.DB, 'schedule_time')) || '08';
          const tz = (await getSetting(env.DB, 'schedule_tz')) || 'Asia/Shanghai';
          // 各账号上次执行 key：{ accountId: "YYYY-MM-DD HH" }
          let lastMap = {};
          try { lastMap = JSON.parse((await getSetting(env.DB, 'sched_last_map')) || '{}'); } catch { /* 忽略 */ }
          const { results } = await env.DB.prepare('SELECT id, site, meta FROM accounts WHERE enabled = 1').all();
          const now = new Date();
          let changed = false;
          for (const acc of results || []) {
            // 执行模式：browser 由扩展执行，Worker 跳过；relay/server/auto 由 runner.js 统一处理
            // （auto 时扩展在线则自动中继，否则云端直连）
            const site = getSite(acc.site);
            let execMode = site?.execution || 'server';
            try {
              const m = JSON.parse(acc.meta || '{}');
              if (m.execution === 'server' || m.execution === 'browser' || m.execution === 'relay') execMode = m.execution;
            } catch { /* 忽略 */ }
            // 浏览器模式已并入本地中继：不再跳过，由 runAccount 决定（扩展在线走本地网络，离线则记 skip）
            const hour = accountHour(acc.meta, globalTime);
            const lastKey = lastMap[String(acc.id)];
            const { run, key } = shouldRun(now, hour, tz, lastKey);
            if (!run) continue;
            lastMap[String(acc.id)] = key;
            changed = true;
            try {
              const full = await env.DB.prepare('SELECT * FROM accounts WHERE id = ?').bind(acc.id).first();
              if (full) await runAccount(env, full);
            } catch (e) {
              console.error('[cron] account', acc.id, e);
            }
            // 账号之间稍作间隔，降低被目标站点限流的概率
            await new Promise((r) => setTimeout(r, 1200));
          }
          if (changed) await setSetting(env.DB, 'sched_last_map', JSON.stringify(lastMap));
        } catch (e) {
          console.error('[cron]', e);
        }
      })().catch((e) => console.error('[cron]', e))
    );
  },
};
