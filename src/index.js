// Worker 入口：REST API + Cron 调度。
// 认证：单管理员密码（PBKDF2 存 D1），会话为服务端 session + HttpOnly Cookie。

import { ensureSchema, getSetting, setSetting } from './db.js';
import { hashPassword, verifyPassword, encryptJSON, decryptJSON, randomHex } from './crypto.js';
import { runAll, runAccount } from './runner.js';
import { getSite, siteMeta } from './sites/index.js';
import { getNotifyConfig, setNotifyConfig } from './notify.js';
import { probeSignEndpoints } from './probe.js';
import { shouldRun, validHour, validTz, accountHour } from './schedule.js';
import { runHttpSteps } from './sites/http.js';

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

  // ---- 外部上报接口（VM 定时任务用 API Key 认证，不走 session） ----
  if (path === '/api/external/report' && method === 'POST') {
    const apiKey = req.headers.get('X-Api-Key') || '';
    if (!env.EXTERNAL_API_KEY || apiKey !== env.EXTERNAL_API_KEY) {
      return json({ error: '无效的 API Key' }, 401);
    }
    const { account_id, status, message, detail, duration_ms } = await readBody(req);
    const acc = await env.DB.prepare('SELECT id, site, name FROM accounts WHERE id = ?').bind(Number(account_id)).first();
    if (!acc) return json({ error: '账号不存在' }, 404);
    await env.DB.prepare(
      'INSERT INTO runs(account_id, site, name, status, message, detail, duration_ms, created_at) VALUES(?,?,?,?,?,?,?,?)'
    ).bind(acc.id, acc.site, acc.name, status || 'ok', message || '', detail || '', duration_ms || 0, Date.now()).run();
    await env.DB.prepare('DELETE FROM runs WHERE id NOT IN (SELECT id FROM runs ORDER BY id DESC LIMIT 500)').run();
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
    return json({ accounts: results || [] });
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

    // 手动执行单个账号
    if (mAcc[2] === '/run' && method === 'POST') {
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
    if (h !== '' && !validHour(h)) return json({ error: '时间必须是 0-23 的整点小时' }, 400);
    let meta = {};
    try { meta = JSON.parse(acc.meta || '{}'); } catch { /* 忽略 */ }
    if (h === '') delete meta.sched_hour;
    else meta.sched_hour = validHour(h);
    await env.DB.prepare('UPDATE accounts SET meta=?, updated_at=? WHERE id=?')
      .bind(JSON.stringify(meta), Date.now(), id).run();
    return json({ ok: true, hour: meta.sched_hour || '' });
  }

  // 签到时间设置：每天几点（整点，0-23）+ 时区
  if (path === '/api/schedule' && method === 'GET') {
    const time = (await getSetting(env.DB, 'schedule_time')) || '08';
    const tz = (await getSetting(env.DB, 'schedule_tz')) || 'Asia/Shanghai';
    return json({ time, tz });
  }
  if (path === '/api/schedule' && method === 'PUT') {
    const { time, tz } = await readBody(req);
    const h = validHour(time);
    const z = validTz(tz);
    if (!h) return json({ error: '时间必须是 0-23 的整点小时' }, 400);
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
          const { results } = await env.DB.prepare('SELECT id, meta FROM accounts WHERE enabled = 1').all();
          const now = new Date();
          let changed = false;
          for (const acc of results || []) {
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
