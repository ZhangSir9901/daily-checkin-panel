// 定时/手动执行引擎：遍历启用的账号 → 调用站点模块签到 → 写运行日志 → 推送汇总。

import { ensureSchema, getSetting } from './db.js';
import { decryptJSON } from './crypto.js';
import { getSite } from './sites/index.js';
import { sendNotify } from './notify.js';
import { dayInTz } from './schedule.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 「今天」以哪个时区为准：跟随面板设置里的 schedule_tz（默认 Asia/Shanghai）。
// 状态列跨零点重置需要和签到时间用同一个时区，否则会差一天。
async function scheduleTz(db) {
  try { return (await getSetting(db, 'schedule_tz')) || 'Asia/Shanghai'; } catch { return 'Asia/Shanghai'; }
}

export async function runAccount(env, account) {
  const db = env.DB;
  const t0 = Date.now();
  let status = 'ok';
  let message = '';
  let detail = ''; // 网站原始回馈（站点模块可返回 detail），日志页展示
  let meta = {};
  try {
    meta = JSON.parse(account.meta || '{}');
  } catch { /* 忽略 */ }

  try {
    const site = getSite(account.site);
    if (!site) throw new Error('未知站点：' + account.site);

    // ---- 执行模式解析 ----
    // 手动覆盖（面板切换）：relay=强制中继 / server=强制云端直连 / browser=同 relay（历史值） / ''=自动
    // 自动：扩展在线则走本地网络中继，否则（站点默认 server）云端直连。
    //
    // 说明：原「浏览器模式」已并入本地中继。MV3 禁止 new Function，扩展无法执行面板下发的脚本，
    // 所以站点逻辑仍保留在 Worker，只把 HTTP 请求交给扩展在用户本地网络中发出（带用户 Cookie）。
    // 这样吾爱破解/NodeSeek/V2EX/看雪/Discuz 等依赖本地 IP + Cookie 的站点能真正自动签到。
    const manual = meta.execution || '';
    const siteDefault = site.execution || 'server';
    let useRelay = false;
    let skipReason = '';

    const wantsLocalNetwork = manual === 'relay' || manual === 'browser' || (manual === '' && siteDefault === 'browser');
    if (wantsLocalNetwork) {
      const { isRelayAvailable } = await import('./lib/relay.js');
      useRelay = await isRelayAvailable(db);
      if (!useRelay) {
        skipReason = '需要浏览器扩展在线（本地网络中继）。请安装并打开扩展；或在面板把该账号切到「云端执行」。';
      }
    } else if (manual === 'server') {
      useRelay = false; // 强制云端直连
    } else if (manual === '' && siteDefault === 'server') {
      // 自动：扩展在线时走中继（用户本地网络），否则云端直连
      const { isRelayAvailable } = await import('./lib/relay.js');
      useRelay = await isRelayAvailable(db);
    }

    if (skipReason) {
      // 浏览器模式定时跳过：不记为失败，记为跳过；不覆盖上次网站真实回馈
      const duration = Date.now() - t0;
      const now = Date.now();
      await db
        .prepare('INSERT INTO runs(account_id, site, name, status, message, detail, duration_ms, created_at) VALUES(?,?,?,?,?,?,?,?)')
        .bind(account.id, account.site, account.name, 'skip', skipReason, '', duration, now)
        .run();
      await db
        .prepare('UPDATE accounts SET last_status=?, last_run_at=?, meta=?, updated_at=? WHERE id=?')
        .bind('skip', now, JSON.stringify(meta), now, account.id)
        .run();
      return { status: 'skip', message: skipReason, duration_ms: duration };
    }

    const creds = await decryptJSON(env, db, account.creds);
    const ctx = { env, db, account, meta };

    let res;
    if (useRelay) {
      // 中继模式：透明替换 global fetch，站点代码无需修改，HTTP 经扩展走用户本地网络
      const { relayFetch } = await import('./lib/relay.js');
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (url, init) => relayFetch(db, url, init);
      // 告知站点模块「当前走本地网络」：重定向无法用 manual（opaqueredirect 读不到头），需改用 follow
      ctx.relayDb = db;
      try {
        res = await site.run(creds, ctx);
      } finally {
        globalThis.fetch = originalFetch;
        delete ctx.relayDb;
      }
    } else {
      res = await site.run(creds, ctx);
    }

    status = res.ok ? 'ok' : 'fail';
    message = String(res.message || '').slice(0, 800);
    detail = String(res.detail || '').slice(0, 800);
  } catch (e) {
    status = 'fail';
    message = String((e && e.message) || e).slice(0, 800);
    detail = String((e && e.detail) || '').slice(0, 800);
  }

  const duration = Date.now() - t0;
  const now = Date.now();
  await db
    .prepare('INSERT INTO runs(account_id, site, name, status, message, detail, duration_ms, created_at) VALUES(?,?,?,?,?,?,?,?)')
    .bind(account.id, account.site, account.name, status, message, detail, duration, now)
    .run();
  // 签到成功时记录「今日」已签到日期（用于状态列显示 已签到/未签到）。
  // 只有 status === 'ok' 才写：fail / skip 一律不写，保证过了当地 00:00
  // 状态统一回到「未签到」，而只有当天真正签到成功才变回「已签到」。
  if (status === 'ok') {
    meta.last_signin_date = dayInTz(new Date(now), await scheduleTz(db));
  }
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
  let skip = 0;
  const lines = [];

  for (const acc of accounts) {
    const r = await runAccount(env, acc);
    if (r.status === 'ok') ok++;
    else if (r.status === 'skip') skip++;
    else fail++;
    const icon = r.status === 'ok' ? '✅' : r.status === 'skip' ? '⏭️' : '❌';
    lines.push(`${icon} ${acc.name}：${r.message}`);
    // 账号之间稍作间隔，降低被目标站点限流的概率
    await sleep(1200);
  }

  // 仅保留最近 500 条运行记录
  await db.prepare('DELETE FROM runs WHERE id NOT IN (SELECT id FROM runs ORDER BY id DESC LIMIT 500)').run();

  const body = `${manual ? '手动' : '定时'}任务完成：成功 ${ok} 个，失败 ${fail} 个\n` + lines.join('\n');
  await sendNotify(env, db, '签到日报', body);

  return { ok, fail, total: accounts.length, lines };
}
