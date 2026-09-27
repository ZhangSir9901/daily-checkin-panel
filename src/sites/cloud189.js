// 天翼云盘每日签到
// ---------------------------------------------------------------------------
// 登录流程参考 cnb.cool/IIIStudio/Tasks/PYQianDao/tianyiyun 的最新修复版
// （2026-09「修复天翼云盘登录流程并精简签到逻辑」），相比旧实现有三处关键改进：
//
//   ① 用 loginUrl.action 进入登录页并跟随重定向，从最终地址/页面里取 lt、reqId，
//      不再依赖会被改版的 unifyLoginForPC.action 表单 HTML；
//   ② 用 appConf.do 权威获取 paramId / returnUrl / mailSuffix（HTML 解析只作兜底）；
//   ③ 登录前先调 needcaptcha.do 预检验证码 —— 命中时明确报「需要验证码」，
//      而不是等 loginSubmit 返回一个含糊的「登录失败」。
//
// 登录参数也按最新客户端对齐：appKey=cloud、accountType=01、密码字段名为 epd。
// 签到接口改为 api.cloud.189.cn + 移动端 App UA/Referer（随登录 Cookie 走）。
//
// 会话以「登录 Cookie」形式缓存 5 天复用；失效时自动重新登录。
// 纯 JS + BigInt 实现 RSA PKCS#1 v1.5（Workers WebCrypto 未提供 RSAES-PKCS1-v1_5）。

import { classifySignal, OUTCOME } from '../lib/signals.js';

const WEB_URL = 'https://cloud.189.cn';
const AUTH_URL = 'https://open.e.189.cn';
const API_URL = 'https://api.cloud.189.cn';
const APP_KEY = 'cloud';
const SESSION_TTL = 5 * 864e5;

// 登录/网页请求使用的常规 UA（与参考实现一致）
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:74.0) Gecko/20100101 Firefox/76.0';
// 签到接口要求移动端 App UA（天翼对非 App 客户端会拒绝）
const APP_UA =
  'Mozilla/5.0 (Linux; Android 5.1.1; SM-G930K Build/NRD90M; wv) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Version/4.0 Chrome/74.0.3729.136 Mobile Safari/537.36 Ecloud/8.6.3 Android/22 clientId/355325117317828 ' +
  'clientModel/SM-G930K imsi/460071114317824 clientChannelId/qq proVersion/1.0.6';
const SIGN_REFERER = 'https://m.cloud.189.cn/zhuanti/2016/sign/index.jsp?albumBackupOpened=1';

// ============================================================================
// RSA（PKCS#1 v1.5）纯 JS 实现
// ============================================================================
export function b64ToBytes(s) {
  const bin = atob(s);
  const b = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
  return b;
}

export function bytesToBig(b) {
  let v = 0n;
  for (const x of b) v = (v << 8n) | BigInt(x);
  return v;
}

// 从 SPKI DER 中解析出 RSA 公钥的 n / e（固定结构，最小化 DER 解析）
export function parseRsaPublicKey(der) {
  let pos = 0;
  const readLen = () => {
    let len = der[pos++];
    if (len & 0x80) {
      const n = len & 0x7f;
      len = 0;
      for (let i = 0; i < n; i++) len = (len << 8) | der[pos++];
    }
    return len;
  };
  const expect = (tag) => {
    if (der[pos++] !== tag) throw new Error('RSA 公钥 DER 解析失败');
  };
  expect(0x30); readLen();                    // SEQUENCE (SPKI)
  expect(0x30);
  const algLen = readLen(); // 先取值：readLen 有副作用，不能写在 += 右边
  pos += algLen;            // 跳过 AlgorithmIdentifier 内容
  expect(0x03); readLen(); pos += 1;          // BIT STRING（跳过 unused-bits 字节）
  expect(0x30); readLen();                    // SEQUENCE (RSAPublicKey)
  expect(0x02);
  const nLen = readLen();
  const nBytes = der.slice(pos, pos + nLen); pos += nLen;
  expect(0x02);
  const eLen = readLen();
  const eBytes = der.slice(pos, pos + eLen);
  const k = nLen - (nBytes[0] === 0 ? 1 : 0); // 模数的字节长度（去掉 INTEGER 前导 0x00）
  return { n: bytesToBig(nBytes), e: bytesToBig(eBytes), k };
}

export function modPow(base, exp, mod) {
  let r = 1n;
  base = base % mod;
  while (exp > 0n) {
    if (exp & 1n) r = (r * base) % mod;
    base = (base * base) % mod;
    exp >>= 1n;
  }
  return r;
}

export function rsaEncryptPkcs1(pubKeyB64, text) {
  const { n, e, k } = parseRsaPublicKey(b64ToBytes(pubKeyB64));
  const msg = new TextEncoder().encode(text);
  if (msg.length > k - 11) throw new Error('RSA 明文过长');

  // EM = 0x00 || 0x02 || PS(非零随机) || 0x00 || msg
  const psLen = k - msg.length - 3;
  const ps = new Uint8Array(psLen);
  let i = 0;
  while (i < psLen) {
    const b = crypto.getRandomValues(new Uint8Array(1))[0];
    if (b !== 0) ps[i++] = b;
  }
  const em = new Uint8Array(k);
  em[0] = 0x00;
  em[1] = 0x02;
  em.set(ps, 2);
  em[2 + psLen] = 0x00;
  em.set(msg, 3 + psLen);

  const c = modPow(bytesToBig(em), e, n);
  return c.toString(16).padStart(k * 2, '0');
}

// ============================================================================
// 小工具：Cookie 罐 / JSON / 文本提取
// ============================================================================

function parseJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

function pickFrom(sources, re) {
  for (const s of sources) {
    const m = String(s || '').match(re);
    if (m && m[1]) return m[1];
  }
  return '';
}

// needcaptcha.do 既可能返回纯文本 true/false，也可能返回 JSON
export function parseNeedCaptcha(text) {
  if (typeof text !== 'string') return false;
  const t = text.trim();
  if (!t) return false;
  const j = parseJson(t);
  if (j != null) {
    if (typeof j === 'boolean') return j;
    if (j.data != null) return j.data === true || String(j.data) === 'true' || String(j.data) === '1';
  }
  return t === 'true' || t === '1';
}

function collectSetCookies(res) {
  const out = [];
  try {
    if (typeof res.headers.getSetCookie === 'function') {
      for (const c of res.headers.getSetCookie()) out.push(c);
    } else {
      const c = res.headers.get('set-cookie');
      if (c) out.push(c);
    }
  } catch { /* 忽略 */ }
  return out;
}

// 极简 Cookie 罐：Workers 的 fetch 没有自动 Cookie 管理，中继场景下也需要显式携带
function makeJar(initial = '') {
  const map = new Map();
  const parse = (s) => {
    for (const part of String(s || '').split(';')) {
      const i = part.indexOf('=');
      if (i > 0) map.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
    }
  };
  parse(initial);
  return {
    absorb(res) {
      for (const sc of collectSetCookies(res)) {
        const pair = sc.split(';')[0];
        const i = pair.indexOf('=');
        if (i > 0) map.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
      }
    },
    header() {
      return [...map].map(([k, v]) => `${k}=${v}`).join('; ');
    },
    size() { return map.size; },
  };
}

// 带 Cookie 罐的 fetch：自动附上/吸收 Cookie
async function req(jar, url, init = {}) {
  const headers = { 'User-Agent': UA, Accept: '*/*', ...(init.headers || {}) };
  const ck = jar.header();
  if (ck) headers.Cookie = ck;
  const res = await fetch(url, { redirect: 'follow', ...init, headers });
  jar.absorb(res);
  return res;
}

// ============================================================================
// 登录
// ============================================================================

// 天翼登录需要验证码时抛出的专用错误：别的站点模块/面板可据此提示「人工验证」
function captchaError(msg) {
  const e = new Error(msg);
  e.outcome = OUTCOME.CAPTCHA;
  return e;
}

async function login(username, password, jar) {
  // ① 进入登录页（跟随重定向，最终地址即登录页）
  const redirectURL = encodeURIComponent('https://cloud.189.cn/web/redirect.html?returnURL=/main.action');
  const entry = `${WEB_URL}/api/portal/loginUrl.action?redirectURL=${redirectURL}`;
  const entryRes = await req(jar, entry);
  const html = await entryRes.text().catch(() => '');
  const finalUrl = entryRes.url || entry;

  // ② 取 lt / reqId（地址栏或页面源码里）
  const lt = pickFrom([finalUrl, html], /[?&]lt=([^&"'\s]+)/);
  const reqId = pickFrom([finalUrl, html], /[?&]reqId=([^&"'\s]+)/);
  if (!lt || !reqId) throw new Error('登录页解析失败：未取到 lt / reqId（页面可能已改版）');

  // ③ appConf.do 权威获取 paramId / returnUrl / mailSuffix
  const confRes = await req(jar, `${AUTH_URL}/api/logbox/oauth2/appConf.do`, {
    method: 'POST',
    headers: {
      reqid: reqId,
      lt,
      referer: finalUrl,
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
    },
    body: 'version=2.0&appKey=cloud',
  });
  const conf = parseJson(await confRes.text().catch(() => ''));
  const confData = (conf && conf.data) || conf || {};
  let paramId = confData.paramId || '';
  // 兜底：万一 appConf 改版，从登录页源码里抓 paramId
  if (!paramId) paramId = pickFrom([html, finalUrl], /paramId\s*=\s*["']([^"']+)["']/);
  const returnUrl = confData.returnUrl || `${WEB_URL}/web/main/`;
  const mailSuffix = confData.mailSuffix || '@189.cn';
  if (!paramId) throw new Error('获取登录参数失败：appConf 未返回 paramId');

  // ④ RSA 公钥
  const encRes = await req(jar, `${AUTH_URL}/api/logbox/config/encryptConf.do`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
    body: `appId=${encodeURIComponent(APP_KEY)}`,
  });
  const enc = parseJson(await encRes.text().catch(() => ''));
  const encData = (enc && enc.data) || enc || {};
  const pubKey = encData.pubKey || '';
  const pre = encData.pre || '';
  if (!pubKey) throw new Error('获取 RSA 公钥失败');

  const rsaUser = pre + rsaEncryptPkcs1(pubKey, username);
  const rsaPass = pre + rsaEncryptPkcs1(pubKey, password);

  // ⑤ 登录前预检验证码（本次新增的关键一步）
  const ncRes = await req(jar, `${AUTH_URL}/api/logbox/oauth2/needcaptcha.do`, {
    method: 'POST',
    headers: { lt, referer: finalUrl, 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
    body: `accountType=01&userName=${encodeURIComponent('{NRP}' + rsaUser)}&appKey=${encodeURIComponent(APP_KEY)}`,
  });
  if (parseNeedCaptcha(await ncRes.text().catch(() => ''))) {
    throw captchaError('该天翼账号需要验证码：请先用官方 App/网页登录一次（可关闭设备锁/二次验证），再回面板执行');
  }

  // ⑥ 提交登录（字段名与最新客户端对齐：epd=密码）
  const body = new URLSearchParams({
    version: 'v2.0',
    apToken: '',
    appKey: APP_KEY,
    accountType: '01',
    userName: rsaUser,
    epd: rsaPass,
    captchaType: '',
    validateCode: '',
    smsValidateCode: '',
    captchaToken: '',
    returnUrl,
    mailSuffix,
    dynamicCheck: 'FALSE',
    clientType: '1',
    cb_SaveName: '1',
    isOauth2: 'false',
    state: '',
    paramId,
  });
  const loginRes = await req(jar, `${AUTH_URL}/api/logbox/oauth2/loginSubmit.do`, {
    method: 'POST',
    headers: { lt, referer: `${AUTH_URL}/`, 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
    body: body.toString(),
  });
  const raw = await loginRes.text().catch(() => '');
  const j = parseJson(raw) || {};
  if (String(j.result) !== '0') {
    const msg = String(j.msg || '').trim();
    const sig = classifySignal(raw + ' ' + msg, { status: loginRes.status });
    const friendly = sig.outcome !== OUTCOME.UNKNOWN ? `${sig.label}${msg ? '：' + msg : ''}` : `登录失败：${msg || 'HTTP ' + loginRes.status}`;
    const e = new Error(friendly);
    e.outcome = sig.outcome;
    e.detail = String(raw).replace(/\s+/g, ' ').slice(0, 300);
    throw e;
  }

  // ⑦ 跟随 toUrl 完成登录（换取会话 Cookie）
  const toUrl = j.toUrl || '';
  if (toUrl) {
    try { await req(jar, toUrl); } catch { /* 落地失败不一定是致命错误 */ }
  }
  return jar;
}

// ============================================================================
// 签到
// ============================================================================

async function userSign(jar) {
  const url =
    `${API_URL}/mkt/userSign.action?rand=${Date.now()}` +
    `&clientType=TELEANDROID&version=8.6.3&model=SM-G930K`;
  const res = await req(jar, url, {
    headers: {
      'User-Agent': APP_UA,
      Referer: SIGN_REFERER,
      Accept: 'application/json;charset=UTF-8',
    },
  });
  const raw = await res.text().catch(() => '');
  const j = parseJson(raw);
  if (!j) throw new Error(`签到接口返回非 JSON（HTTP ${res.status}）：${String(raw).replace(/\s+/g, ' ').slice(0, 200)}`);
  return j;
}

async function getUserSizeInfo(jar) {
  const res = await req(jar, `${WEB_URL}/api/portal/getUserSizeInfo.action`, {
    headers: { Referer: `${WEB_URL}/web/main/`, Accept: 'application/json;charset=UTF-8' },
  });
  return parseJson(await res.text().catch(() => '')) || {};
}

// ============================================================================
// 站点模块
// ============================================================================

export const cloud189 = {
  id: 'cloud189',
  name: '天翼云盘',
  desc: '账号密码登录，每日签到领随机空间（登录态自动缓存复用，登录前自动检测验证码）。',
  execution: 'server',
  fields: [
    { key: 'username', label: '账号', type: 'text', required: true, placeholder: '189 手机号' },
    { key: 'password', label: '密码', type: 'password', required: true, placeholder: '天翼账号密码' },
  ],
  tips: '首次若提示「需要验证码」，请先用天翼云盘官方 App 或网页端登录一次该账号（可关闭设备锁/二次验证），之后面板即可自动签到。登录态会缓存复用，失效时自动重新登录。',

  // 登录协助元数据：面板据此展示「打开登录页 / 如何过验证码」
  login: {
    kind: 'password', // 账号密码登录
    captcha: 'maybe', // 视账号而定，登录前会预检
    url: 'https://cloud.189.cn/web/login.html',
    note: '若提示需要验证码，请先在官方 App/网页完成一次登录（关闭设备锁）',
  },

  async run(creds, ctx = {}) {
    const username = String(creds.username || '').trim();
    const password = String(creds.password || '');
    if (!username || !password) throw new Error('账号或密码未配置');

    const meta = ctx.meta || {};
    ctx.meta = meta; // 保证缓存回写能被 runner 持久化

    const cached = String(meta.cloud189_cookies || '');
    const cachedAt = Number(meta.cloud189_cookies_at || 0);
    const fresh = cached && Date.now() - cachedAt < SESSION_TTL;

    const signOnce = async (jar) => {
      const sj = await userSign(jar);
      if (sj && (sj.errorCode === 'InvalidSessionKey' || sj.errorCode === 'InvalidAccessToken')) {
        const e = new Error('登录态失效，重新登录');
        e.code = 'SESSION_INVALID';
        throw e;
      }
      if (!sj || typeof sj.isSign === 'undefined') {
        const e = new Error('签到接口返回异常，按登录态失效处理：' + JSON.stringify(sj).slice(0, 200));
        e.code = 'SESSION_INVALID';
        throw e;
      }
      return sj;
    };

    let jar = makeJar(fresh ? cached : '');
    let sj = null;
    let needRelogin = !fresh;

    if (!needRelogin) {
      try {
        sj = await signOnce(jar);
      } catch (e) {
        if (e.code === 'SESSION_INVALID') needRelogin = true;
        else throw e;
      }
    }

    if (needRelogin) {
      jar = makeJar('');
      await login(username, password, jar);
      meta.cloud189_cookies = jar.header();
      meta.cloud189_cookies_at = Date.now();
      sj = await signOnce(jar);
    }

    const bonus = sj.netdiskBonus != null ? sj.netdiskBonus : '';
    let msg = sj.isSign
      ? `今日已签到${bonus !== '' ? `（已累计获得 ${bonus}M 空间）` : ''}`
      : `签到成功，获得 ${bonus !== '' ? bonus : 0}M 空间`;

    // 顺带查询总容量（best-effort）
    try {
      const info = await getUserSizeInfo(jar);
      const total = info && info.cloudCapacityInfo && info.cloudCapacityInfo.totalSize;
      if (total) msg += `（总容量 ${(total / 1024 / 1024).toFixed(1)}G）`;
    } catch { /* 忽略 */ }

    return { ok: true, message: msg };
  },
};
