// 天翼云盘每日签到
// 登录流程参考 wes-lin/cloud189-sdk（MIT）：
//  encryptConf 取 RSA 公钥 → unifyLoginForPC 取登录表单 → RSA 加密账号密码 →
//  loginSubmit 登录 → getSessionForPC 换 sessionKey → mkt/userSign.action 签到
// sessionKey 会缓存 5 天复用，失效时自动重新登录。

const WEB_URL = 'https://cloud.189.cn';
const AUTH_URL = 'https://open.e.189.cn';
const API_URL = 'https://api.cloud.189.cn';
const APP_ID = '8025431004';
const CLIENT_TYPE = '10020';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/87.0.4280.88 Safari/537.36';
const SESSION_TTL = 5 * 864e5;

// RSA PKCS#1 v1.5 加密（对应 Node 端 crypto.publicEncrypt RSA_PKCS1_PADDING），输出 hex。
// 纯 JS + BigInt 实现，不依赖 SubtleCrypto（Workers/Node 的 WebCrypto 均未实现 RSAES-PKCS1-v1_5）。
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

async function login(username, password) {
  // 1. 获取 RSA 公钥
  const encRes = await (
    await fetch(`${AUTH_URL}/api/logbox/config/encryptConf.do`, {
      method: 'POST',
      headers: { 'User-Agent': UA },
    })
  ).json();
  if (!encRes.data || !encRes.data.pubKey) throw new Error('获取加密参数失败');
  const { pubKey, pre } = encRes.data;

  // 2. 获取登录表单参数
  const returnURL = 'https://cloud.189.cn/web/main/';
  const html = await (
    await fetch(
      `${WEB_URL}/api/portal/unifyLoginForPC.action?appId=${APP_ID}&clientType=${CLIENT_TYPE}&returnURL=${encodeURIComponent(returnURL)}&timeStamp=${Date.now()}`,
      { headers: { 'User-Agent': UA } }
    )
  ).text();
  const pick = (re, name) => {
    const m = html.match(re);
    if (!m) throw new Error(`解析登录页失败（${name}）`);
    return m[1];
  };
  const captchaToken = pick(/'captchaToken' value='(.+?)'/, 'captchaToken');
  const lt = pick(/lt = "(.+?)"/, 'lt');
  const paramId = pick(/paramId = "(.+?)"/, 'paramId');
  const reqId = pick(/reqId = "(.+?)"/, 'reqId');

  // 3. RSA 加密账号密码并提交登录
  const body = new URLSearchParams({
    appKey: APP_ID,
    accountType: '02',
    validateCode: '',
    captchaToken,
    dynamicCheck: 'FALSE',
    clientType: '1',
    cb_SaveName: '3',
    isOauth2: 'false',
    returnUrl: returnURL,
    paramId,
    userName: pre + rsaEncryptPkcs1(pubKey, username),
    password: pre + rsaEncryptPkcs1(pubKey, password),
  });
  const loginRes = await (
    await fetch(`${AUTH_URL}/api/logbox/oauth2/loginSubmit.do`, {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        Referer: AUTH_URL,
        lt,
        REQID: reqId,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    })
  ).json();
  if (loginRes.result !== 0 || !loginRes.toUrl) {
    throw new Error('登录失败：' + (loginRes.msg || '未知错误') + '（若提示设备校验，请先在官方客户端完成一次登录/关闭设备锁）');
  }

  // 4. 换取 sessionKey
  const sessRes = await (
    await fetch(
      `${API_URL}/getSessionForPC.action?appId=${APP_ID}&clientType=TELEPC&version=6.2&channelId=web_cloud.189.cn&rand=${Date.now()}&redirectURL=${encodeURIComponent(loginRes.toUrl)}`,
      { method: 'POST', headers: { 'User-Agent': UA } }
    )
  ).json();
  if (!sessRes.sessionKey) throw new Error('获取 sessionKey 失败：' + (sessRes.res_message || '未知错误'));
  return sessRes.sessionKey;
}

async function userSign(sessionKey) {
  const url =
    `${WEB_URL}/mkt/userSign.action?rand=${Date.now()}` +
    `&clientType=TELEANDROID&version=9.0.6&model=KB2000&sessionKey=${encodeURIComponent(sessionKey)}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Referer: `${WEB_URL}/web/main/`, Accept: 'application/json;charset=UTF-8' },
  });
  return res.json();
}

async function getUserSizeInfo(sessionKey) {
  const res = await fetch(`${WEB_URL}/api/portal/getUserSizeInfo.action?sessionKey=${encodeURIComponent(sessionKey)}`, {
    headers: { 'User-Agent': UA, Referer: `${WEB_URL}/web/main/`, Accept: 'application/json;charset=UTF-8' },
  });
  return res.json();
}

export const cloud189 = {
  id: 'cloud189',
  name: '天翼云盘',
  desc: '账号密码登录，每日签到领随机空间（登录态自动缓存复用）。',
  fields: [
    { key: 'username', label: '账号', type: 'text', required: true, placeholder: '189 手机号' },
    { key: 'password', label: '密码', type: 'password', required: true, placeholder: '天翼账号密码' },
  ],
  tips: '首次登录若提示设备校验/二次验证，请先在天翼云盘官方 App 或网页端完成一次手动登录（可关闭账号设备锁），之后面板可自动签到。',

  async run(creds, ctx) {
    const { username, password } = creds;
    if (!username || !password) throw new Error('账号或密码未配置');

    const needLogin = !(ctx.meta.sessionKey && ctx.meta.sessionKeyAt && Date.now() - ctx.meta.sessionKeyAt < SESSION_TTL);

    const doSign = async (sk) => {
      const res = await userSign(sk);
      if (res && (res.errorCode === 'InvalidSessionKey' || res.errorCode === 'InvalidAccessToken')) {
        const e = new Error('登录态失效，重新登录');
        e.code = 'SESSION_INVALID';
        throw e;
      }
      return res;
    };

    let sessionKey = ctx.meta.sessionKey;
    let res;
    try {
      if (needLogin) throw Object.assign(new Error('need login'), { code: 'NEED_LOGIN' });
      res = await doSign(sessionKey);
    } catch (e) {
      if (e.code === 'SESSION_INVALID' || e.code === 'NEED_LOGIN') {
        sessionKey = await login(username, password);
        ctx.meta.sessionKey = sessionKey;
        ctx.meta.sessionKeyAt = Date.now();
        res = await doSign(sessionKey);
      } else {
        throw e;
      }
    }

    if (!res || typeof res.isSign === 'undefined') {
      throw new Error('签到接口返回异常：' + JSON.stringify(res).slice(0, 200));
    }

    let msg = res.isSign ? '今日已签到' : `签到成功，获得 ${res.netdiskBonus || 0}M 空间`;

    // 顺带查询总容量（best-effort）
    try {
      const info = await getUserSizeInfo(sessionKey);
      const total = info && info.cloudCapacityInfo && info.cloudCapacityInfo.totalSize;
      if (total) msg += `（总容量 ${(total / 1024 / 1024).toFixed(1)}G）`;
    } catch { /* 忽略 */ }

    return { ok: true, message: msg };
  },
};
