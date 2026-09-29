// Cookie 里「自带到期时间」的那类凭据：解析出它到底还能不能用。
//
// 为什么值得单独做一个模块：WordPress 的登录态 Cookie（`wordpress_logged_in_<hash>`）值形如
//     other-user|1791635708|token|hmac        （URL 编码）
// 中间那段就是**站点自己判「认不认这个会话」用的到期时间**（`wp_parse_auth_cookie`：
// 到期时间过了就当作未登录）。也就是说，不用发任何请求，光看 Cookie 就能知道
// 「这份 Cookie 是不是已经废了」——而这正是用户最容易卡住的地方：
// 他以为「我更新了 Cookie」，其实复制到的是**已经过期的那一份**，于是面板一直说「登录已失效」，
// 两边来回改却谁也没错。
//
// 同一站的两个独立域名（hutue.cn 与 dj.hutue.cn）各有一套 cookie hash，
// 复制时很容易把两边的会话混在一串里（面板里就是这样：9 段 Cookie 里混着两套 hash），
// 所以这里把每段都解析出来、带上用户与到期时间，界面才能说清
// 「有效的那段是给另一个站的」。
//
// 浏览器端有一份等价实现（public/cookie-tools.js 的 wpLoginSessions，给粘贴体检用），
// 两份必须一致 —— test/cookie-info.test.mjs 会拿同一批样本比对它们的结果。

// 极简 MD5（RFC 1321）。
//
// 只用来算 WordPress 的 COOKIEHASH —— 也就是 md5(siteurl)：
// WordPress 的登录 Cookie 名字是 `wordpress_logged_in_` + md5(siteurl)，
// 所以拿到目标站点地址就能**反推出它只认哪几段 Cookie**，从而回答
// 「你这串 Cookie 里到底哪一段是给这个站的」。
// （实测：md5('https://hutue.cn') = ec35f1949aa62d7b02e78d74b17cb6b5，
//   md5('http://dj.hutue.cn') = ca7674586a167c665930997282100f84 —— 与线上两份 Cookie 完全对上。）
// Worker 里 crypto.subtle 不提供 md5，所以自带一份；非安全用途。
export function md5(str) {
  const bytes = new TextEncoder().encode(String(str));
  const len = bytes.length;
  const bitLen = len * 8;
  const total = len + 1 + (((56 - (len + 1) % 64) + 64) % 64) + 8;
  const buf = new Uint8Array(total);
  buf.set(bytes);
  buf[len] = 0x80;
  const dv = new DataView(buf.buffer);
  dv.setUint32(total - 8, bitLen >>> 0, true);
  dv.setUint32(total - 4, Math.floor(bitLen / 4294967296), true);
  const K = new Uint32Array(64);
  for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296);
  const S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
  const M = new Uint32Array(16);
  let a0 = 0x67452301; let b0 = 0xefcdab89; let c0 = 0x98badcfe; let d0 = 0x10325476;
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) M[i] = dv.getUint32(off + i * 4, true);
    let A = a0; let B = b0; let C = c0; let D = d0;
    for (let i = 0; i < 64; i++) {
      let F; let g;
      if (i < 16) { F = (B & C) | (~B & D); g = i; } else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; } else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; } else { F = C ^ (B | (~D)); g = (7 * i) % 16; }
      F = (F + A + K[i] + M[g]) | 0;
      A = D; D = C; C = B;
      B = (B + ((F << S[i]) | (F >>> (32 - S[i])))) | 0;
    }
    a0 = (a0 + A) | 0; b0 = (b0 + B) | 0; c0 = (c0 + C) | 0; d0 = (d0 + D) | 0;
  }
  const out = new Uint8Array(16);
  const odv = new DataView(out.buffer);
  odv.setUint32(0, a0 >>> 0, true);
  odv.setUint32(4, b0 >>> 0, true);
  odv.setUint32(8, c0 >>> 0, true);
  odv.setUint32(12, d0 >>> 0, true);
  let hex = '';
  for (let i = 0; i < 16; i++) hex += out[i].toString(16).padStart(2, '0');
  return hex;
}

// 目标站点「自己的」WordPress cookie hash 候选：md5(siteurl)。
// 站点的 siteurl 选项未必和你在面板里填的写法一致（有无斜杠 / http 与 https 混用），
// 所以两种协议、带不带斜杠、带不带 www 都算一遍。
// 返回小写 32 位十六进制串数组；地址不合法时返回 []（调用方要能接受「认不出来」）。
export function wpCookieHashes(siteUrl) {
  let u;
  try { u = new URL(String(siteUrl || '').trim()); } catch { return []; }
  if (!u.hostname) return [];
  const hosts = new Set();
  const host = u.hostname.toLowerCase();
  hosts.add(host);
  if (/^www\./.test(host)) hosts.add(host.replace(/^www\./, ''));
  else hosts.add('www.' + host);
  // 站点装子目录时 siteurl 带路径（如 https://host/blog），那种写法也算上
  const path = u.pathname && u.pathname !== '/' ? u.pathname.replace(/\/+$/, '') : '';
  const out = new Set();
  for (const h of hosts) {
    for (const scheme of ['https', 'http']) {
      out.add(md5(`${scheme}://${h}`));
      out.add(md5(`${scheme}://${h}/`));
      if (path) {
        out.add(md5(`${scheme}://${h}${path}`));
        out.add(md5(`${scheme}://${h}${path}/`));
      }
    }
  }
  return [...out];
}

// 把一串 Cookie 按「是不是目标站点自己的」拆开。
//
// 这是 hutue.cn / dj.hutue.cn 这类「同品牌两个独立站」最容易坑人的地方：
// 两站的 Cookie 往往挂在同一个上级域下，用扩展复制一次就会把**两套会话**混在一串里。
// 面板拿着这一串去打 A 站时，其中一段（B 站的）看着还有效，用户就会以为「我明明有有效登录态」。
//
// 返回：
//   all       全部 WordPress 会话（带 user / exp / expired）
//   own       属于本站的会话（hash 命中 md5(siteurl) 候选）
//   foreign   明显属于别的站的会话（hash 命中不代表本站，且我们能认出本站的会话）
//   needsLogin 本站没有可用会话（仅在「串里确实有 WP 会话」时才敢下这个结论）
//   cookie    过滤后的 Cookie：只去掉 foreign 那些段，其余原样保留
//   dropped   被去掉的段名
// 安全阀：**只有在认出了本站会话时才会剔除异站段** —— 认不出来（比如站点用了子目录、
// 或者 siteurl 写法很特殊）就原样返回，绝不因为猜错把能用的登录态丢掉。
export function splitCookieBySite(cookie, siteUrl, now = Date.now()) {
  const all = wpLoginSessions(cookie, now);
  const hashes = new Set(wpCookieHashes(siteUrl));
  const own = all.filter((s) => hashes.has(String(s.hash).toLowerCase()));
  const foreign = all.filter((s) => !hashes.has(String(s.hash).toLowerCase()));
  const ownValid = own.filter((s) => !s.expired);
  // 可以安心剔除的条件：本站的 hash 认得出来、而且本站确实有一把能用的会话。
  // 剔两类别的东西：
  //   ①  别的站的会话（hash 不在本站候选里）—— WordPress 对本站根本不看它；
  //   ②  本站已经过期的那几段 —— WordPress 自己也不认（wp_parse_auth_cookie 先看到期时间），
  //      留着只会让「Cookie 体检」白报一条「有 N 段已过期」的提醒。
  // 但如果本站一段有效的都没（全是过期的），就一段也不删 —— 那些过期段是
  // 「needsLogin」判据的依据，靠它才能触发自动重新登录（见 hutue.js）。
  const mayFilter = hashes.size > 0 && own.length > 0 && (foreign.length > 0 || (ownValid.length > 0 && ownValid.length < own.length));
  const dropped = [];
  let out = String(cookie || '');
  if (mayFilter) {
    const segs = [];
    for (const seg of out.split(';')) {
      const s = seg.trim();
      if (!s) continue;
      const m = /^(wordpress_logged_in_([0-9a-f]+))=/i.exec(s);
      if (m) {
        const hash = m[2].toLowerCase();
        const seg2 = wpLoginSessions(s, now)[0];
        const foreignSeg = !hashes.has(hash);
        const deadOwn = hashes.has(hash) && seg2 && seg2.expired && ownValid.length > 0;
        if (foreignSeg || deadOwn) { dropped.push(m[1]); continue; }
      }
      segs.push(s);
    }
    out = segs.join('; ');
  }
  return {
    all,
    own,
    foreign,
    ownValid,
    // needsLogin 的含义是**确伊地**知道「面板里这份 Cookie 已经没用了」：
    // 只有在本站那一段真的存在、而且已经过期时才算。
    // 故意不把「一段都没认出来」也算进去 —— 认不出来可能只是我们没猜中站的 siteurl
    // （子目录、端口、带 www 的怪写法），而经中继时真正决定登录态的其实是**浏览器的**
    // Cookie jar，面板这份只是个备份。猜错了就去重新登录，比什么伤害都大。
    needsLogin: own.length > 0 && !ownValid.length,
    // 「串里有 WP 会话，但一段都不属于本站」：多半是复制错了站（两个独立站最常见的坑），
    // 只用于诊断文案，不用来做自动登录的开关。
    ownMissing: all.length > 0 && own.length === 0,
    cookie: out,
    dropped,
    hashOfSite: [...hashes],
  };
}

// 解析 Cookie 串里的所有 WordPress 登录会话段。
// 返回 [{ name, hash, user, exp, expired }]，exp 是毫秒时间戳（解不出时为 0，expired=false）。
export function wpLoginSessions(cookie, now = Date.now()) {
  const out = [];
  for (const seg of String(cookie || '').split(';')) {
    const s = seg.trim();
    if (!s) continue;
    const i = s.indexOf('=');
    if (i < 0) continue;
    const name = s.slice(0, i).trim();
    if (!/^wordpress_logged_in_/i.test(name)) continue;
    const raw = s.slice(i + 1);
    let val = raw;
    try { val = decodeURIComponent(raw); } catch { /* 解不开就按原样 */ }
    const parts = val.split('|');
    const expSec = Number(parts[1]);
    const exp = Number.isFinite(expSec) && expSec > 1e9 ? expSec * 1000 : 0;
    out.push({
      name,
      hash: name.replace(/^wordpress_logged_in_/i, ''),
      user: String(parts[0] || '').trim(),
      exp,
      expired: exp > 0 ? exp < now : false,
    });
  }
  return out;
}

// 面向用户的「Cookie 体检结论」：这份 Cookie 到底能不能被目标站点认成登录态。
//
// 线上案例（2026-09-29）：hutue.cn 那一行永远显示「登录已失效，请重新获取 Cookie」，
// 而用户其实是照做了的 —— 他复制回来的串里同时混着两套会话：
//   wordpress_logged_in_ec35f1949a…（hutue.cn 的会话，demo-user）→ 11:05 已过期
//   wordpress_logged_in_ca7674586a…（dj.hutue.cn 的会话，other-user）→ 还活着
// 于是「我更新了 Cookie」和「登录已失效」在他眼里是矛盾的。这里把每一段归属谁、
// 什么时候到期讲清楚，他自己一眼就能看出该去哪重新登录。
// 返回一句话（没有 WP 会话段时也返回一句能照着做的说明）。
export function wpLoginDiagnosis(cookie, siteUrl, now = Date.now()) {
  let host = String(siteUrl || '').trim();
  try { host = new URL(host).hostname; } catch { /* 保留原样 */ }
  const sp = splitCookieBySite(cookie, siteUrl, now);
  const fmt = (ts) => (ts ? new Date(ts).toLocaleString('zh-CN') : '无到期时间');
  const tag = (s) => (s.user ? s.user + ' ' : '') + (s.exp ? fmt(s.exp) + ' 到期' : '无到期时间');
  if (!sp.all.length) {
    return '面板里这份 Cookie 没有任何 WordPress 登录会话段（wordpress_logged_in_…），'
      + '也就是说它不是「' + host + ' 已登录」的快照。请在浏览器登录 ' + host + '（页面上能看到自己的用户名）后再复制一次。';
  }
  const parts = [];
  if (sp.own.length) {
    parts.push('属于 ' + host + ' 的会话：' + sp.own.map((s) => tag(s) + (s.expired ? '（已过期）' : '（仍有效）')).join('、'));
  } else if (sp.ownMissing) {
    parts.push('这份 Cookie 里没有 ' + host + ' 自己的登录会话（WordPress 只认名字里带 md5(站点地址) 的那一段，'
      + '也就是说这段 Cookie 是别的站登录时复制的）');
  }
  if (sp.foreign.length) {
    parts.push('另有属于其它域名的会话：' + sp.foreign.map((s) => tag(s)).join('、')
      + ' —— 同品牌的两个独立站（hutue.cn / dj.hutue.cn）各自一套登录态，必须分别在各自站点登录后再复制');
  }
  return parts.join('；') + '。';
}

// 凭据值里**自带**的另一种到期时间：JWT（`aaa.bbb.ccc` 三段 base64url）。
//
// 为什么值得单独解：Akile 要的就是 localStorage 里的 `akile-token`（一个 JWT），
// 而用户在面板里更新的往往是 Cookie —— 面板一直说「过期」、他说「我明明更新了」，
// 两边都没错。把 exp 解出来，界面上就能直接写出「这个 token 于 X 时刻过期」，
// 不用等人去猜。
// 返回毫秒时间戳；不是 JWT / 解不出 exp 时返回 0（调用方要能接受）。
export function jwtExp(value) {
  const s = String(value || '').trim();
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(s)) return 0;
  let obj = null;
  try {
    // base64url → base64：换字符表**并且补回被 JWT 省掉的 `=`**（atob 遇到长度模 4 余 1 会直接抛）
    let b64 = s.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    b64 += '='.repeat((4 - (b64.length % 4)) % 4);
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    obj = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return 0;
  }
  const exp = Number(obj && obj.exp);
  // exp 是**秒**。太小的值不像是时间戳（1e9 秒 ≈ 2001 年），当解错处理。
  return Number.isFinite(exp) && exp > 1e9 ? exp * 1000 : 0;
}

// 「这份凭据什么时候到期」——账号列表里鼠标悬浮站点名时显示的那句话。
//
// 只回答**凭据自己带着**的到期时间，分两类：
//   sessions：WordPress 登录会话（到期时间写在 cookie 值里，站点自己也在看它）
//   tokens  ：JWT 型 token（如 akile-token，exp 一到就作废）
// 其它站点（Discuz、机场面板…）的会话有效期只在服务器那边知道，这里**不猜** ——
// 界面上如实说「这份凭据里没写到期时间」，总比编一个时间出来强。
//
// 入参是解密后的 creds 对象（可能为空/不是对象），返回：
//   { sessions: [{ field, user, exp, expired }], tokens: [{ field, exp, expired }] }
export function credentialExpiry(creds, now = Date.now()) {
  const sessions = [];
  const tokens = [];
  const seenS = new Set();
  const seenT = new Set();
  if (!creds || typeof creds !== 'object') return { sessions, tokens };
  for (const [field, raw] of Object.entries(creds)) {
    const val = typeof raw === 'string' ? raw : '';
    if (!val) continue;
    // 一个字段里可能塞着好几段 WordPress 会话（复制时把两个站混在一串里就是这种）
    for (const s of wpLoginSessions(val, now)) {
      const k = `${s.user}|${s.exp}`;
      if (seenS.has(k)) continue;
      seenS.add(k);
      sessions.push({ field, user: s.user, exp: s.exp, expired: s.expired });
    }
    const jwt = jwtExp(val);
    if (jwt) {
      const k = `${field}|${jwt}`;
      if (!seenT.has(k)) { seenT.add(k); tokens.push({ field, exp: jwt, expired: jwt < now }); }
    }
  }
  return { sessions, tokens };
}

// 一句话概括一份 Cookie 的登录态，给「签到失败」的文案用。
// 返回 { kind, message }：
//   kind = 'none'    没有 WordPress 会话段（站点可能不是 WordPress，或者这段 Cookie 真没带登录态）
//   kind = 'expired' 所有会话都过期了 → 必须重新登录再复制
//   kind = 'valid'   还有有效的会话（但站点仍说未登录 → 多半是复制错了站/账号）
export function wpSessionSummary(cookie, now = Date.now()) {
  const all = wpLoginSessions(cookie, now);
  if (!all.length) return { kind: 'none', sessions: [], message: '' };
  const fmt = (ts) => (ts ? new Date(ts).toLocaleString('zh-CN') : '未知时间');
  const valid = all.filter((s) => !s.expired);
  const expired = all.filter((s) => s.expired);
  if (!valid.length) {
    return {
      kind: 'expired',
      sessions: all,
      message: '面板里这份 Cookie 的登录会话已经过期了（WordPress 把到期时间写在 wordpress_logged_in_ 里：'
        + expired.map((s) => (s.user ? s.user + ' ' : '') + fmt(s.exp)).join('、')
        + '）。这不是 Cookie 抄错，是它在网站上真的过期了 —— 请在浏览器重新登录该网站'
        + '（确认页面上能看到自己的用户名），再用扩展复制一次。',
    };
  }
  return {
    kind: 'valid',
    sessions: all,
    message: '这份 Cookie 里仍有有效的登录会话（'
      + valid.map((s) => (s.user ? s.user + ' ' : '') + fmt(s.exp)).join('、')
      + (expired.length ? '；另有 ' + expired.length + ' 段已过期' : '')
      + '）。站点仍说未登录，多半是这份 Cookie 属于另一个域名／另一个账号 ——'
      + 'hutue.cn 和 dj.hutue.cn 这类「同一品牌的两个独立站」各有各的登录态，要分别在各自站点登录后再复制。',
  };
}
