// 通用 Web 登录模拟工具
// 理念：面板的登录请求应尽量模拟真实浏览器的行为（请求头、Cookie 流程、表单编码），
// 而不是按"想当然"的 API 猜测去发。2026-09-27 的 69机场 登录失败就是教训：
// 站点要的是表单提交 + passwd 字段，面板却发了 JSON + password，服务端直接报"密码错误"。
// 新站点接入时，先抓浏览器真实登录请求，再用这里的工具按原样复刻。

// 标准桌面 Chrome UA（与各站点模块此前使用的移动端 UA 二选一即可，优先用此）
export const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
// 移动端 UA（部分站点对移动端更友好，v2board 等沿用）
export const MOBILE_UA =
  'Mozilla/5.0 (Linux; Android 13; KB2000 Build/TKQ1.221114.001) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36';

// 按页面 URL 生成浏览器风格请求头（含 Referer / Origin，很多站点/WAF 会校验）
export function browserHeaders(pageUrl, extra = {}) {
  let origin = '';
  try {
    origin = new URL(pageUrl).origin;
  } catch { /* 忽略 */ }
  return {
    'User-Agent': BROWSER_UA,
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    ...(origin ? { Origin: origin, Referer: pageUrl } : {}),
    ...extra,
  };
}

// 从响应收集 Cookie（Workers 下优先 getSetCookie；兜底单头）
export function cookiesFrom(res) {
  const out = [];
  try {
    if (typeof res.headers.getSetCookie === 'function') {
      for (const c of res.headers.getSetCookie()) {
        const i = c.indexOf(';');
        out.push(i > 0 ? c.slice(0, i) : c);
      }
      return out.join('; ');
    }
  } catch { /* 忽略，走兜底 */ }
  const c = res.headers.get('set-cookie');
  if (c) out.push(c.split(';')[0]);
  return out.join('; ');
}

// 合并两次收集到的 Cookie（同名以后者为准）
export function mergeCookies(a, b) {
  const m = new Map();
  for (const s of [a, b]) {
    for (const part of String(s || '').split(';')) {
      const i = part.indexOf('=');
      if (i > 0) m.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
    }
  }
  return [...m].map(([k, v]) => `${k}=${v}`).join('; ');
}

async function readJson(res) {
  // 先读文本再解析 JSON，避免 body 被消费两次导致读不到原始内容
  let raw = '';
  try { raw = await res.text(); } catch { /* 忽略 */ }
  raw = String(raw || '');
  try {
    return JSON.parse(raw);
  } catch {
    // JSON 解析失败：把网站实际返回的内容带出来，而不是只显示"失败"
    const snippet = raw.slice(0, 500);
    const err = new Error(`网站返回非 JSON（HTTP ${res.status}）：${snippet || '空响应'}`);
    err.detail = snippet;
    throw err;
  }
}

// GET 页面（模拟浏览器先访问登录页，常用于拿初始 Cookie）
export async function getPage(url, { cookie = '', pageUrl = '', ua } = {}) {
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      ...browserHeaders(pageUrl || url, { 'X-Requested-With': 'XMLHttpRequest' }),
      ...(ua ? { 'User-Agent': ua } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
  });
  return { res, cookie: cookiesFrom(res) };
}

// 表单方式 POST（模拟浏览器表单/AJAX 提交；字段原样发送）
export async function postForm(url, fields, { cookie = '', pageUrl = '', ua } = {}) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(fields || {})) body.append(k, String(v ?? ''));
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      ...browserHeaders(pageUrl || url, {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
      }),
      ...(ua ? { 'User-Agent': ua } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body.toString(),
  });
  const j = await readJson(res);
  return { res, j, cookie: cookiesFrom(res) };
}

// JSON 方式 POST（标准 API 风格，同样带上浏览器头）
export async function postJSON(url, bodyObj, { cookie = '', pageUrl = '', ua } = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      ...browserHeaders(pageUrl || url, { 'Content-Type': 'application/json' }),
      ...(ua ? { 'User-Agent': ua } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify(bodyObj ?? {}),
  });
  const j = await readJson(res);
  return { res, j, cookie: cookiesFrom(res) };
}
