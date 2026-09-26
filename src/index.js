// Worker 入口：REST API + Cron 调度。
// 认证：单管理员密码（PBKDF2 存 D1），会话为服务端 session + HttpOnly Cookie。

import { ensureSchema, getSetting, setSetting } from './db.js';
import { hashPassword, verifyPassword, encryptJSON, decryptJSON, randomHex } from './crypto.js';
import { runAll, runAccount } from './runner.js';
import { getSite, siteMeta } from './sites/index.js';
import { getNotifyConfig, setNotifyConfig } from './notify.js';

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

  if (!(await authed(env, req))) return json({ error: '未登录' }, 401);

  // ---- 登录后接口 ----
  if (path === '/api/logout' && method === 'POST') {
    const sid = parseCookies(req).sid;
    if (sid) await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(sid).run();
    return json({ ok: true }, 200, { 'Set-Cookie': 'sid=; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0' });
  }

  if (path === '/api/me' && method === 'GET') return json({ logged_in: true });

  if (path === '/api/sites' && method === 'GET') return json({ sites: siteMeta() });

  // 账号列表（不含凭据）
  if (path === '/api/accounts' && method === 'GET') {
    const { results } = await env.DB.prepare(
      'SELECT id, name, site, enabled, last_status, last_msg, last_run_at, created_at, updated_at FROM accounts ORDER BY id'
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

  // 手动执行全部启用的账号
  if (path === '/api/run-all' && method === 'POST') {
    const r = await runAll(env, { manual: true });
    return json({ ok: true, ...r });
  }

  // 运行日志
  if (path === '/api/runs' && method === 'GET') {
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '100', 10) || 100, 500);
    const { results } = await env.DB.prepare('SELECT * FROM runs ORDER BY id DESC LIMIT ?').bind(limit).all();
    return json({ runs: results || [] });
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

  // Cron 触发：每天自动签到
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      runAll(env, { manual: false }).catch((e) => console.error('[cron]', e))
    );
  },
};
