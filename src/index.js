// Worker 入口：REST API + Cron 调度。
// 认证：单管理员密码（PBKDF2 存 D1），会话为服务端 session + HttpOnly Cookie。

import { ensureSchema, getSetting, setSetting } from './db.js';
import { hashPassword, verifyPassword, encryptJSON, decryptJSON, randomHex } from './crypto.js';
import { handleExtZip } from './ext-zip.js';
import { runAll, runAccount } from './runner.js';
import { getSite, siteMeta, getBrowserScript } from './sites/index.js';
import { getNotifyConfig, setNotifyConfig } from './notify.js';
import { probeSignEndpoints } from './probe.js';
import { shouldRun, validHour, validTime, validTz, accountHour } from './schedule.js';
import { runHttpSteps } from './sites/http.js';

// 校验外部 API Key：支持 Cloudflare Secret（旧）或面板设置中的 Key（新，可在 UI 查看/修改）
async function checkExternalKey(env, apiKey) {
  if (!apiKey) return false;
  if (env.EXTERNAL_API_KEY && apiKey === env.EXTERNAL_API_KEY) return true;
  try {
    const saved = await getSetting(env.DB, 'external_api_key');
    if (saved && apiKey === saved) return true;
  } catch { /* 忽略 */ }
  return false;
}

const SESSION_TTL_MS = 7 * 864e5;

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

async function readBody(req) {
  try {
    return await req.json();
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
    const apiKey = req.headers.get('X-Api-Key') || '';
    if (!(await checkExternalKey(env, apiKey))) {
      return json({ error: '无效的 API Key' }, 401);
    }
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
      const d = new Date();
      const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
      const p = {};
      for (const x of parts) p[x.type] = x.value;
      rmeta.last_signin_date = `${p.year}-${p.month}-${p.day}`;
    }
    await env.DB.prepare('UPDATE accounts SET last_status=?, last_msg=?, last_run_at=?, meta=?, updated_at=? WHERE id=?')
      .bind(validStatus, message || '', Date.now(), JSON.stringify(rmeta), Date.now(), acc.id).run();
    // 如果是手动任务队列中的，上报后删除（避免重复执行）
    await env.DB.prepare('DELETE FROM browser_manual_jobs WHERE account_id = ?').bind(acc.id).run().catch(() => {});
    return json({ ok: true });
  }

  // ---- 外部查询账号状态（VM 跑之前检查是否启用） ----
  const mExtAcc = path.match(/^\/api\/external\/account\/(\d+)$/);
  if (mExtAcc && method === 'GET') {
    const apiKey = req.headers.get('X-Api-Key') || '';
    if (!(await checkExternalKey(env, apiKey))) {
      return json({ error: '无效的 API Key' }, 401);
    }
    const acc = await env.DB.prepare('SELECT id, site, name, enabled FROM accounts WHERE id = ?').bind(Number(mExtAcc[1])).first();
    if (!acc) return json({ error: '账号不存在' }, 404);
    return json({ id: acc.id, site: acc.site, name: acc.name, enabled: !!acc.enabled });
  }

  // ---- 外部查询账号凭据（VM 代签用，返回解密后的 cookie / user_agent 等） ----
  // 面板是唯一凭据源：用户在面板更新 Cookie 后，VM 下次运行自动取到最新值，无需手动同步文件
  const mExtCreds = path.match(/^\/api\/external\/account\/(\d+)\/creds$/);
  if (mExtCreds && method === 'GET') {
    const apiKey = req.headers.get('X-Api-Key') || '';
    if (!(await checkExternalKey(env, apiKey))) {
      return json({ error: '无效的 API Key' }, 401);
    }
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
    const apiKey = req.headers.get('X-Api-Key') || '';
    if (!(await checkExternalKey(env, apiKey))) {
      return json({ error: '无效的 API Key' }, 401);
    }
    const mode = (await getSetting(env.DB, 'nodeseek_mode')) || 'random';
    return json({ mode });
  }

  // ---- 扩展连接检查（无副作用，不消费任务） ----
  if (path === '/api/external/ping' && method === 'GET') {
    const apiKey = req.headers.get('X-Api-Key') || '';
    if (!(await checkExternalKey(env, apiKey))) {
      return json({ error: '无效的 API Key' }, 401);
    }
    return json({ ok: true, version: '2.2', time: Date.now() });
  }

  // ---- 浏览器扩展获取待执行任务 ----
  // 扩展每小时调用一次，获取所有 browser 模式、已启用、到执行时间的账号
  // 返回每个任务的签到脚本（在用户浏览器中运行，使用用户网络 + 自动携带 Cookie）
  if (path === '/api/external/browser-jobs' && method === 'GET') {
    const apiKey = req.headers.get('X-Api-Key') || '';
    if (!(await checkExternalKey(env, apiKey))) {
      return json({ error: '无效的 API Key' }, 401);
    }
    const globalTime = (await getSetting(env.DB, 'schedule_time')) || '08';
    const tz = (await getSetting(env.DB, 'schedule_tz')) || 'Asia/Shanghai';
    let lastMap = {};
    try { lastMap = JSON.parse((await getSetting(env.DB, 'sched_last_map')) || '{}'); } catch { /* 忽略 */ }
    const now = new Date();
    const { results } = await env.DB.prepare('SELECT id, site, name, meta, creds FROM accounts WHERE enabled = 1').all();
    const jobs = [];
    let changed = false;
    for (const acc of results || []) {
      const site = getSite(acc.site);
      if (!site) continue;
      // 有效执行模式：账号覆盖 > 站点默认
      let execMode = site.execution || 'server';
      let meta = {};
      try { meta = JSON.parse(acc.meta || '{}'); } catch { /* 忽略 */ }
      if (meta.execution === 'server' || meta.execution === 'browser') execMode = meta.execution;
      if (execMode !== 'browser') continue;
      // 检查是否到执行时间
      const hour = accountHour(acc.meta, globalTime);
      const lastKey = lastMap[String(acc.id)];
      const { run, key } = shouldRun(now, hour, tz, lastKey);
      if (!run) continue;
      // 获取浏览器脚本
      const bs = getBrowserScript(acc.site);
      if (!bs || !bs.script) continue;
      // 组装参数（站点相关，不含敏感信息）
      const params = {};
      let domain = bs.domain;
      if (acc.site === 'nodeseek') {
        // 签到模式：账号开关 > 全局设置
        const t = meta.toggles ? meta.toggles.random : undefined;
        if (t != null) params.random = !!t;
        else params.random = ((await getSetting(env.DB, 'nodeseek_mode')) || 'random') === 'random';
      }
      if (acc.site === 'misign') {
        try {
          const creds = await decryptJSON(env, env.DB, acc.creds) || {};
          params.base_url = String(creds.base_url || '').trim();
          if (params.base_url) {
            try { domain = new URL(params.base_url).hostname; } catch { /* 忽略 */ }
          }
        } catch { /* 忽略 */ }
      }
      if (acc.site === 'kanxue') {
        try {
          const creds = await decryptJSON(env, env.DB, acc.creds) || {};
          if (creds.csrf_token) params.csrf_token = String(creds.csrf_token);
        } catch { /* 忽略 */ }
      }
      if (acc.site === 'v2board') {
        try {
          const creds = await decryptJSON(env, env.DB, acc.creds) || {};
          params.domain = String(creds.domain || '').trim();
          params.email = String(creds.email || '').trim();
          params.password = String(creds.password || '');
          if (params.domain) {
            try { domain = new URL(params.domain.startsWith('http') ? params.domain : 'https://' + params.domain).hostname; } catch { /* 忽略 */ }
          }
        } catch { /* 忽略 */ }
      }
      if (acc.site === 'akile') {
        try {
          const creds = await decryptJSON(env, env.DB, acc.creds) || {};
          params.token = String(creds.token || '').trim();
        } catch { /* 忽略 */ }
      }
      if (!domain) continue; // 没有目标域名无法执行
      jobs.push({
        account_id: acc.id,
        site: acc.site,
        site_name: site.name,
        domain,
        script: bs.script,
        params,
      });
      // 标记已领取任务，避免重复下发（扩展上报后也会更新 last_run，这里先占位）
      lastMap[String(acc.id)] = key;
      changed = true;
    }
    if (changed) await setSetting(env.DB, 'sched_last_map', JSON.stringify(lastMap));

    // 手动任务队列：面板"执行"按钮为 browser 模式账号加入的即时任务
    // 清理 24 小时前的过期任务，防止堆积
    try {
      await env.DB.prepare('DELETE FROM browser_manual_jobs WHERE created_at < ?')
        .bind(Date.now() - 86400000).run().catch(() => {});
    } catch { /* 忽略 */ }
    try {
      const { results: manualJobs } = await env.DB.prepare(
        'SELECT account_id FROM browser_manual_jobs ORDER BY created_at LIMIT 20'
      ).all();
      const manualIds = (manualJobs || []).map((j) => j.account_id);
      if (manualIds.length > 0) {
        // 查询这些账号的信息
        const placeholders = manualIds.map(() => '?').join(',');
        const { results: manualAccs } = await env.DB.prepare(
          `SELECT id, site, name, meta, creds FROM accounts WHERE id IN (${placeholders}) AND enabled = 1`
        ).bind(...manualIds).all();
        for (const acc of manualAccs || []) {
          // 避免重复（已在定时任务中）
          if (jobs.some((j) => j.account_id === acc.id)) continue;
          const site = getSite(acc.site);
          if (!site) continue;
          const bs = getBrowserScript(acc.site);
          if (!bs || !bs.script) continue;
          let meta = {};
          try { meta = JSON.parse(acc.meta || '{}'); } catch { /* 忽略 */ }
          const params = {};
          let domain = bs.domain;
          if (acc.site === 'nodeseek') {
            const t = meta.toggles ? meta.toggles.random : undefined;
            if (t != null) params.random = !!t;
            else params.random = ((await getSetting(env.DB, 'nodeseek_mode')) || 'random') === 'random';
          }
          // misign/kanxue 等需要 creds 参数的站点，复用上面的逻辑（简化：只处理通用情况）
          if (domain) {
            jobs.push({
              account_id: acc.id,
              site: acc.site,
              site_name: site.name,
              domain,
              script: bs.script,
              params,
              manual: true, // 标记为手动任务，扩展执行后需通知面板删除队列记录
            });
          }
        }
        // 注意：不立即删除，等扩展上报结果后再删（通过 /api/external/report 的 account_id 匹配）
      }
    } catch { /* 忽略，手动队列不影响主流程 */ }

    return json({ jobs });
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
    const apiKey = req.headers.get('X-Api-Key') || '';
    if (!(await checkExternalKey(env, apiKey))) {
      return json({ error: '无效的 API Key' }, 401);
    }
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
    const apiKey = req.headers.get('X-Api-Key') || '';
    if (!(await checkExternalKey(env, apiKey))) {
      return json({ error: '无效的 API Key' }, 401);
    }
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

  // 扩展轮询待执行的中继任务
  if (path === '/api/external/relay-pending' && method === 'GET') {
    const apiKey = req.headers.get('X-Api-Key') || '';
    if (!(await checkExternalKey(env, apiKey))) {
      return json({ error: '无效的 API Key' }, 401);
    }
    // 记录扩展最后轮询时间，用于判断扩展是否在线（自动中继）
    await setSetting(env.DB, 'relay_last_poll', String(Date.now())).catch(() => {});
    const { results } = await env.DB.prepare(
      "SELECT id, url, method, headers, body, options FROM relay_jobs WHERE status = 'pending' ORDER BY created_at LIMIT 10"
    ).all();
    return json({
      jobs: (results || []).map((j) => ({
        id: j.id,
        url: j.url,
        method: j.method,
        headers: JSON.parse(j.headers || '{}'),
        body_base64: j.body || null,
        options: JSON.parse(j.options || '{}'),
      })),
    });
  }

  // 扩展回传中继结果
  const mRelayResult = path.match(/^\/api\/external\/relay\/([A-Za-z0-9_]+)\/result$/);
  if (mRelayResult && method === 'POST') {
    const apiKey = req.headers.get('X-Api-Key') || '';
    if (!(await checkExternalKey(env, apiKey))) {
      return json({ error: '无效的 API Key' }, 401);
    }
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
      'SELECT id, name, site, enabled, meta, last_status, last_msg, last_run_at, created_at, updated_at FROM accounts ORDER BY id'
    ).all();
    const accounts = results || [];
    // 回填：今日有成功记录但 meta 缺 last_signin_date 的，补上（兼容旧数据）
    const d = new Date();
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
    const p = {};
    for (const x of parts) p[x.type] = x.value;
    const today = `${p.year}-${p.month}-${p.day}`;
    const dayStart = new Date(`${today}T00:00:00+08:00`).getTime();
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
          // 同时把网站反馈补上（取今日最后一条成功的 message）
          const lastOk = await env.DB.prepare(
            "SELECT message FROM runs WHERE account_id = ? AND status = 'ok' AND created_at >= ? ORDER BY id DESC LIMIT 1"
          ).bind(acc.id, dayStart).first();
          if (lastOk?.message) {
            acc.last_msg = lastOk.message;
            acc.last_status = 'ok';
          }
          acc.meta = JSON.stringify(m);
          await env.DB.prepare('UPDATE accounts SET meta=?, last_msg=?, last_status=?, updated_at=? WHERE id=?')
            .bind(acc.meta, acc.last_msg, acc.last_status, Date.now(), acc.id).run();
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
      if (execMode === 'browser') {
        // 加入手动任务队列，扩展"立即执行"或下次轮询时执行
        await env.DB.prepare('INSERT INTO browser_manual_jobs(account_id, created_at) VALUES(?,?)')
          .bind(acc.id, Date.now()).run().catch(() => {});
        return json({ ok: true, result: { status: 'ok', message: `${site?.name || acc.site} 已加入扩展待办。请点击浏览器扩展的「▶ 立即执行待办签到」，或等待扩展自动执行（每小时）。` } });
      }
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
    // 循环：''（跟随默认） → 'browser' → 'server' → ''
    // 注：relay 模式已从手动切换中移除（中继代理过于复杂，browser 模式已覆盖本地网络需求）
    const next = cur === '' ? 'browser' : cur === 'browser' ? 'server' : '';
    if (next === '') delete meta.execution;
    else meta.execution = next;
    await env.DB.prepare('UPDATE accounts SET meta=?, updated_at=? WHERE id=?')
      .bind(JSON.stringify(meta), Date.now(), id).run();
    return json({ ok: true, execution: next || 'default' });
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
    return json({ online, last_poll: last });
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

  return json({ error: '未知接口' }, 404);
}

export default {
  async fetch(req, env, ctx) {
    try {
      const url = new URL(req.url);
      await ensureSchema(env.DB);
      if (url.pathname.startsWith('/api/')) return await handleApi(req, env, url);
      // 扩展下载：动态生成 zip，把当前面板地址注入进去（扩展自动带出面板地址）
      if (url.pathname === '/cookie-helper-extension.zip') return await handleExtZip(req, env);
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
            if (execMode === 'browser') continue;
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
