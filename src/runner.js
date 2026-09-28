// 定时/手动执行引擎：遍历启用的账号 → 调用站点模块签到 → 写运行日志 → 推送汇总。

import { ensureSchema, getSetting } from './db.js';
import { decryptJSON } from './crypto.js';
import { getSite } from './sites/index.js';
import { listCommunitySites, makeCommunitySite } from './community.js';
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
  let handedOff = false; // 已交给扩展去执行（不需要定时器再重试）
  try {
    meta = JSON.parse(account.meta || '{}');
  } catch { /* 忽略 */ }

  // 社区导入的站点（声明式配置）也在这里注册起来：账号可能用的是社区站点
  let customSites = [];
  try {
    customSites = (await listCommunitySites(db)).map((r) => makeCommunitySite(r.def));
  } catch { /* 老库没有 community_sites 表时忽略 */ }

  try {
    const site = getSite(account.site, customSites);
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
      // 执行模式需要扩展但扩展不在线：不记为失败，记为跳过；不覆盖上次网站真实回馈。
      // retryable：这类跳过是暂时的（用户一会儿打开浏览器就能签），定时器该自动补跑。
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
      return { status: 'skip', message: skipReason, duration_ms: duration, retryable: true };
    }

    // ---- 被 WAF 整站拦死的站点：不在这里白等，直接交给「浏览器导航签到」----
    // 吾爱破解（www.52pojie.cn）的网宿 WAF 会让**脚本化请求整站读不到**：
    // 实测 2026-09-28，同一浏览器里 example.com / static.52pojie.cn 都是 200，
    // 而主站的 robots.txt、portal.php、home.php 全部挂到超时（45s/90s 白白浪费，
    // 用户看到的就是「本地网络执行失败：中继执行超时」）。这种站点只有**真实页导航**
    // 能过挑战，所以把任务入队，由扩展打开标签页完成（等同人手点一下）。
    if (typeof site.browserJob === 'function' && site.preferNavigationSign) {
      const { isRelayAvailable } = await import('./lib/relay.js');
      if (await isRelayAvailable(db)) {
        const now = Date.now();
        await db.prepare('INSERT INTO browser_manual_jobs(account_id, created_at) VALUES(?,?)').bind(account.id, now).run();
        const msg = `${site.name}：已交给浏览器执行 —— 该站点的脚本化请求会被 WAF 拦死（本地中继读不到），改由扩展打开标签页完成签到，结果通常 1 分钟内自动写回这一行`;
        const duration = Date.now() - t0;
        await db
          .prepare('INSERT INTO runs(account_id, site, name, status, message, detail, duration_ms, created_at) VALUES(?,?,?,?,?,?,?,?)')
          .bind(account.id, account.site, account.name, 'skip', msg, '', duration, now)
          .run();
        await db
          .prepare('UPDATE accounts SET last_status=?, last_msg=?, last_run_at=?, meta=?, updated_at=? WHERE id=?')
          .bind('skip', msg, now, JSON.stringify(meta), now, account.id)
          .run();
        // 已经交给扩展去做了（谁去做、做没做由扩展写回），定时器不要再排一次
        return { status: 'skip', message: msg, duration_ms: duration, retryable: false };
      }
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
    const rawMsg = String((e && e.message) || e);
    detail = String((e && e.detail) || '').slice(0, 800);
    // 中继超时 + 该站点支持浏览器导航签到 → 自动改道（省得用户每次都看 45 秒超时）
    const siteObj = getSite(account.site, customSites);
    if (typeof siteObj?.browserJob === 'function' && /中继请求超时|中继执行超时|等待本地网络响应超时/.test(rawMsg)) {
      try {
        await db.prepare('INSERT INTO browser_manual_jobs(account_id, created_at) VALUES(?,?)').bind(account.id, Date.now()).run();
        status = 'skip';
        handedOff = true;
        message = `${siteObj.name}：本地中继读不到该站点（被 WAF 拦死），已自动改用浏览器导航签到（扩展会打开标签页完成），结果稍后自动写回`;
      } catch {
        status = 'fail';
        message = rawMsg.slice(0, 800);
      }
    } else if (e && e.outcome === 'relay-unknown') {
      // 本地中继没等到回包：请求**可能已经送达**站点（签到可能已生效），只是响应丢了。
      // 这时既不能报成功（没凭据），也不能报失败（冤枉站点，用户看到「失败」但网站其实签了）。
      // 记为「结果未知」，不写 last_signin_date（不冒充成功），并让定时器稍后自动补跑复核。
      status = 'skip';
      message = rawMsg.slice(0, 800);
    } else {
      status = 'fail';
      message = rawMsg.slice(0, 800);
    }
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
    // 站点可以用 dayTz 声明自己的「一天」从几点算起，默认跟面板设置一致。
    // 踩过的坑：糊涂鳄（WordPress + RiPro）按 UTC 计日，也就是北京时间 08:00 才重置。
    // 若一律按面板的北京时间记「今天」，08:00 之后面板会继续显示「已签到」，
    // 而站点那边其实已是新的一天（用户手动点签到还能领到积分）——看起来就像「假签到」。
    const siteDayTz = (getSite(account.site, customSites) || {}).dayTz || '';
    meta.last_signin_date = dayInTz(new Date(now), siteDayTz || (await scheduleTz(db)));
  }
  await db
    .prepare('UPDATE accounts SET last_status=?, last_msg=?, last_detail=?, last_run_at=?, meta=?, updated_at=? WHERE id=?')
    .bind(status, message, detail || '', now, JSON.stringify(meta), now, account.id)
    .run();

  return { status, message, duration_ms: duration, retryable: status !== 'ok' && !handedOff };
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
