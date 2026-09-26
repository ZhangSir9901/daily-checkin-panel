// 定时/手动执行引擎：遍历启用的账号 → 调用站点模块签到 → 写运行日志 → 推送汇总。

import { ensureSchema } from './db.js';
import { decryptJSON } from './crypto.js';
import { getSite } from './sites/index.js';
import { sendNotify } from './notify.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function runAccount(env, account) {
  const db = env.DB;
  const t0 = Date.now();
  let status = 'ok';
  let message = '';
  let meta = {};
  try {
    meta = JSON.parse(account.meta || '{}');
  } catch { /* 忽略 */ }

  try {
    const site = getSite(account.site);
    if (!site) throw new Error('未知站点：' + account.site);
    const creds = await decryptJSON(env, db, account.creds);
    const res = await site.run(creds, { env, db, account, meta });
    status = res.ok ? 'ok' : 'fail';
    message = String(res.message || '').slice(0, 800);
  } catch (e) {
    status = 'fail';
    message = String((e && e.message) || e).slice(0, 800);
  }

  const duration = Date.now() - t0;
  const now = Date.now();
  await db
    .prepare('INSERT INTO runs(account_id, site, name, status, message, duration_ms, created_at) VALUES(?,?,?,?,?,?,?)')
    .bind(account.id, account.site, account.name, status, message, duration, now)
    .run();
  await db
    .prepare('UPDATE accounts SET last_status=?, last_msg=?, last_run_at=?, meta=?, updated_at=? WHERE id=?')
    .bind(status, message, now, JSON.stringify(meta), now, account.id)
    .run();

  return { status, message, duration_ms: duration };
}

export async function runAll(env, { manual = false } = {}) {
  const db = env.DB;
  await ensureSchema(db);
  const { results } = await db.prepare('SELECT * FROM accounts WHERE enabled = 1 ORDER BY id').all();
  const accounts = results || [];

  let ok = 0;
  let fail = 0;
  const lines = [];

  for (const acc of accounts) {
    const r = await runAccount(env, acc);
    if (r.status === 'ok') ok++;
    else fail++;
    lines.push(`${r.status === 'ok' ? '✅' : '❌'} ${acc.name}：${r.message}`);
    // 账号之间稍作间隔，降低被目标站点限流的概率
    await sleep(1200);
  }

  // 仅保留最近 500 条运行记录
  await db.prepare('DELETE FROM runs WHERE id NOT IN (SELECT id FROM runs ORDER BY id DESC LIMIT 500)').run();

  const body = `${manual ? '手动' : '定时'}任务完成：成功 ${ok} 个，失败 ${fail} 个\n` + lines.join('\n');
  await sendNotify(env, db, '签到日报', body);

  return { ok, fail, total: accounts.length, lines };
}
