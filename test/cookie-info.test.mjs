// Cookie 体检（WordPress 登录态自带到期时间 + 按站点认领会话）：node test/cookie-info.test.mjs
//
// 依据全部来自线上真实数据（2026-09-29，面板里 #7 单机 / #8 糊涂鳄 两个账号的 Cookie）：
//   #8 hutue.cn 的 Cookie 里混着两套会话 —— 属于 hutue.cn 的那个（guo527029137）11:05 过期，
//   而看起来「还有效」的那个其实是 dj.hutue.cn 的（laoguo）。用户就是被这条坑住的：
//   他一直说「我更新了 Cookie」，面板一直说「登录已失效」，两边都没说错。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import crypto from 'node:crypto';
import { md5, wpCookieHashes, wpLoginSessions, splitCookieBySite, wpLoginDiagnosis } from '../src/lib/cookie-info.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok -', name); };

const NOW = Date.parse('2026-09-29T11:30:00+08:00');
const enc = (v) => encodeURIComponent(v);

// 线上那两段真实会话（值做了截断，但 hash / 用户名 / 到期时间是原样的）
const CN_HASH = 'ec35f1949aa62d7b02e78d74b17cb6b5'; // md5('https://hutue.cn')
const DJ_HASH = 'ca7674586a167c665930997282100f84'; // md5('http://dj.hutue.cn')
const CN_SESSION = 'guo527029137%7C1790651147%7Ctok%7Chmac'; // 2026-09-29 11:05:47 +08（已过期）
const DJ_SESSION = 'laoguo%7C1791684908%7Ctok%7Chmac';       // 2026-10-11 10:15:08 +08（仍有效）
const MIXED = `wordpress_${DJ_HASH}=x; PHPSESSID=aaa; `
  + `wordpress_logged_in_${DJ_HASH}=${DJ_SESSION}; Hm_lvt_7699392dd53df859db50148afbf4ac0b=1; `
  + `PHPSESSID=bbb; wordpress_logged_in_${CN_HASH}=${CN_SESSION}`;

// ---------- 1. MD5：WordPress 的 cookie hash 就是 md5(siteurl) ----------
t('md5 与 node:crypto 完全一致', () => {
  for (const s of ['', 'a', 'abc', 'message digest', 'x'.repeat(55), 'x'.repeat(56), 'x'.repeat(64), '糊涂鳄/hutue.cn']) {
    assert.equal(md5(s), crypto.createHash('md5').update(s).digest('hex'), JSON.stringify(s).slice(0, 30));
  }
});

t('两个真实站点的 cookie hash 能算出来（线上数据反推验证过）', () => {
  assert.equal(md5('https://hutue.cn'), 'ec35f1949aa62d7b02e78d74b17cb6b5');
  assert.equal(md5('http://dj.hutue.cn'), 'ca7674586a167c665930997282100f84');
  // 面板里填的地址未必和站点 siteurl 写法一致，所以两种协议、带不带斜杠、带不带 www 都算候选
  const cands = wpCookieHashes('https://dj.hutue.cn');
  assert.ok(cands.includes('ca7674586a167c665930997282100f84'), '应包含 http:// 写法算出的 hash');
  assert.ok(cands.includes(md5('https://dj.hutue.cn')), '也应包含 https:// 写法');
  assert.deepEqual(wpCookieHashes('不是地址'), [], '非法地址不猜，返回空');
});

// ---------- 2. 按站点认领会话 ----------
t('混着两套会话时，能分清哪段属于本站', () => {
  const cn = splitCookieBySite(MIXED, 'https://hutue.cn', NOW);
  assert.deepEqual(cn.own.map((s) => s.user), ['guo527029137']);
  assert.deepEqual(cn.foreign.map((s) => s.user), ['laoguo']);
  assert.equal(cn.own[0].expired, true, 'hutue.cn 自己那段当时确实已过期');
  assert.equal(cn.needsLogin, true);
  assert.equal(cn.ownValid.length, 0);

  const dj = splitCookieBySite(MIXED, 'https://dj.hutue.cn', NOW);
  assert.deepEqual(dj.own.map((s) => s.user), ['laoguo']);
  assert.equal(dj.ownValid.length, 1);
  assert.equal(dj.needsLogin, false);
});

t('剔除异站会话时只动 wordpress_logged_in_ 那几段，其余原样保留', () => {
  const cn = splitCookieBySite(MIXED, 'https://hutue.cn', NOW);
  assert.deepEqual(cn.dropped, [`wordpress_logged_in_${DJ_HASH}`]);
  assert.doesNotMatch(cn.cookie, /laoguo/, '异站会话不该被发到本站');
  assert.match(cn.cookie, new RegExp(`wordpress_logged_in_${CN_HASH}`));
  // 统计类 / 会话类 Cookie 一概不动（站点可能真的需要它们）
  assert.match(cn.cookie, /Hm_lvt_7699392dd53df859db50148afbf4ac0b=1/);
  assert.match(cn.cookie, new RegExp(`wordpress_${DJ_HASH}=x`));
});

t('安全阀：认不出本站会话时绝不剔除任何东西', () => {
  // 站点用了子目录、或 siteurl 写法很特殊时，我们算出的 hash 一个都对不上 ——
  // 这时宁可不做过滤，也不能因为猜错把能用的登录态丢掉。
  const odd = splitCookieBySite(MIXED, 'https://blog.example.com/hutue', NOW);
  assert.deepEqual(odd.own, []);
  assert.deepEqual(odd.dropped, []);
  assert.equal(odd.cookie, MIXED, '认不出来就原样返回');
  assert.equal(odd.needsLogin, false, '认不出来时不敢断言「这串 Cookie 已经废了」');
});

t('串里只有别的站的会话：能诊断出来，但不据此自动登录', () => {
  const onlyDj = `PHPSESSID=a; wordpress_logged_in_${'ca7674586a167c665930997282100f84'}=${DJ_SESSION}`;
  const cn = splitCookieBySite(onlyDj, 'https://hutue.cn', NOW);
  assert.equal(cn.ownMissing, true);
  assert.equal(cn.needsLogin, false, 'needsLogin 只留给「确定已过期」，认错站的情况交给站点自己的回答');
  assert.equal(cn.cookie, onlyDj, '没认出本站会话就不动它');
  assert.match(wpLoginDiagnosis(onlyDj, 'https://hutue.cn', NOW), /没有 hutue\.cn 自己的登录会话/);
});

t('本站有有效会话时，顺手把本站的过期旧会话也剔掉', () => {
  // 同一站点可能因为 http / https 两种写法留下两套 hash（面板里真实的 Cookie 就是这样）：
  // 过期的那段留着只会让「Cookie 体检」白报一条提醒，而 WordPress 本来也不会认它。
  const nowValid = 'guo527029137%7C1799999999%7Ctok%7Chmac';
  const jar = `wordpress_logged_in_${md5('https://hutue.cn')}=${CN_SESSION}; wordpress_logged_in_${md5('http://hutue.cn')}=${nowValid}; foo=1`;
  const sp = splitCookieBySite(jar, 'https://hutue.cn', NOW);
  assert.deepEqual(sp.dropped, [`wordpress_logged_in_${md5('https://hutue.cn')}`]);
  assert.doesNotMatch(sp.cookie, /1790651147/, '过期那段不该留在串里');
  assert.match(sp.cookie, /1799999999/);
  assert.match(sp.cookie, /foo=1/, '非 WordPress 的段一律不动');
  assert.equal(sp.needsLogin, false);

  // 但「本站一段有效的都没有」时一段也不删：那些过期段正是触发自动重新登录的依据
  const allDead = `wordpress_logged_in_${CN_HASH}=${CN_SESSION}`;
  const sp2 = splitCookieBySite(allDead, 'https://hutue.cn', NOW);
  assert.deepEqual(sp2.dropped, []);
  assert.equal(sp2.cookie, allDead);
  assert.equal(sp2.needsLogin, true, '靠它触发「先重新登录再签」');
});

t('Cookie 里没有 WordPress 会话段时不乱下结论', () => {
  const sp = splitCookieBySite('PHPSESSID=abc; foo=1', 'https://hutue.cn', NOW);
  assert.deepEqual(sp.all, []);
  assert.equal(sp.needsLogin, false);
  assert.equal(sp.cookie, 'PHPSESSID=abc; foo=1');
});

t('会话解析：用户名 / 到期时间 / 是否过期', () => {
  const s = wpLoginSessions(MIXED, NOW);
  assert.equal(s.length, 2);
  assert.equal(s[0].user, 'laoguo');
  assert.equal(s[0].hash, DJ_HASH);
  assert.equal(new Date(s[0].exp).toISOString(), '2026-10-11T02:15:08.000Z');
  assert.equal(s[0].expired, false);
  assert.equal(s[1].user, 'guo527029137');
  assert.equal(new Date(s[1].exp).toISOString(), '2026-09-29T03:05:47.000Z');
  assert.equal(s[1].expired, true);
});

// ---------- 3. 面向用户的那句话 ----------
t('体检结论能说清「本站会话过期了、有效的那段是另一个站的」', () => {
  const msg = wpLoginDiagnosis(MIXED, 'https://hutue.cn', NOW);
  assert.match(msg, /属于 hutue\.cn 的会话：guo527029137/);
  assert.match(msg, /已过期/);
  assert.match(msg, /laoguo/);
  assert.match(msg, /其它域名/);
  assert.match(msg, /分别在各自站点登录/);
});

t('体检结论：连 WordPress 会话都没有时给的是「重新登录再复制」', () => {
  const msg = wpLoginDiagnosis('PHPSESSID=abc', 'https://hutue.cn', NOW);
  assert.match(msg, /没有任何 WordPress 登录会话段/);
  assert.match(msg, /hutue\.cn/);
});

// ---------- 4. 浏览器端与 Worker 端两份实现必须一致 ----------
t('浏览器端 wpLoginSessions 与 Worker 端结果一致', () => {
  eval(readFileSync(join(root, 'public', 'cookie-tools.js'), 'utf8'));
  const browser = globalThis.wpLoginSessions;
  assert.equal(typeof browser, 'function', 'cookie-tools.js 应导出 wpLoginSessions');
  for (const sample of [MIXED, 'PHPSESSID=1', 'wordpress_logged_in_abc=u%7C1791635708%7Ct%7Ch', '']) {
    assert.deepEqual(browser(sample, NOW), wpLoginSessions(sample, NOW), '样本：' + sample.slice(0, 40));
  }
});

console.log(`\n${n} 组全部通过`);
