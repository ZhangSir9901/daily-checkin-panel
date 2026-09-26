// 签到接口自动探测：给定站点首页 URL（可带 Cookie），抓取页面 HTML，
//  1) 找出文字含「签到/打卡」的链接与按钮；
//  2) 在 HTML 及同源 JS 文件中正则匹配疑似签到 API（sign/checkin/attendance/qiandao…）；
//  3) 识别 WordPress 风格：ajaxurl + action=user_qiandao 这类签到动作。
// 返回候选列表，由用户在面板中确认后再保存为「自定义 HTTP」账号。
// 注意：这是尽力而为的启发式探测，不保证命中；命中后仍建议点「执行」验证一次。

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

const TEXT_KEYWORDS = /签到|打卡/;

// 路径中疑似签到接口的片段；sign(?!ed\b) 排除 signed.apk 这类误伤，
// DENY_SEGS 排除 design/assign/signal 等
const DENY_SEGS = ['design', 'assign', 'resign', 'signal', 'signature'];
const API_SEG_RE = /sign(?!ed\b)|check-?in|attendance|qiandao|daka/i;

// 疑似第三方库 JS，探测时靠后抓取
const LIB_JS_RE = /jquery|sweetalert|swiper|pace|html5shiv|respond|bootstrap|popper|moment/i;

function looksLikeSignApi(pathname) {
  return String(pathname || '')
    .toLowerCase()
    .split('/')
    .filter(Boolean)
    .some((p) => {
      const seg = p.split(/[?#;]/)[0];
      if (!seg) return false;
      if (DENY_SEGS.some((d) => seg.includes(d))) return false;
      return API_SEG_RE.test(seg);
    });
}

function looksLikeSignAction(name) {
  return API_SEG_RE.test(String(name || ''));
}

function resolveUrl(raw, base) {
  try {
    const u = new URL(raw, base);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    return u.href;
  } catch {
    return '';
  }
}

function stripTags(s) {
  return String(s || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

// 从 HTML 中提取：签到链接/按钮、疑似 API、ajaxurl、同源脚本
function extractFromHtml(html, base) {
  const out = [];
  const seen = new Set();
  const push = (url, label, source, body = '') => {
    const abs = resolveUrl(url, base);
    if (!abs || seen.has(abs)) return;
    seen.add(abs);
    out.push({ url: abs, label: label.slice(0, 80), source, body });
  };

  // 1) <a href> 且文字含签到/打卡
  const aRe = /<a\b[^>]*href\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]{0,300}?)<\/a\s*>/gi;
  let m;
  while ((m = aRe.exec(html))) {
    const text = stripTags(m[3]);
    if (TEXT_KEYWORDS.test(text)) push(m[2], text || '签到链接', '页面链接');
  }

  // 2) button/div/span 文字含签到/打卡，且带 data-url / data-href / onclick 中的 URL
  const bRe = /<(button|div|span|li)\b[^>]*(data-url|data-href|onclick)\s*=\s*(["'])(.*?)\3[^>]*>([\s\S]{0,200}?)<\/\1\s*>/gi;
  while ((m = bRe.exec(html))) {
    const text = stripTags(m[5]);
    if (!TEXT_KEYWORDS.test(text)) continue;
    const attrVal = m[4];
    const urlInAttr =
      attrVal.match(/["']((?:https?:)?\/\/[^"'\s<>]+|\/[a-zA-Z0-9_\-./?=&%#]+)["']/) ||
      attrVal.match(/((?:https?:)?\/\/[^\s"'<>]+|\/[a-zA-Z0-9_\-./?=&%#]+)/);
    if (urlInAttr) push(urlInAttr[1], text || '签到按钮', '页面按钮');
  }

  // 3) HTML 全文：疑似签到 API 的 URL
  const urlRe = /["']((?:https?:)?\/\/[^"'\s<>]+|\/[a-zA-Z0-9_\-./?=&%#]+)["']/g;
  while ((m = urlRe.exec(html))) {
    const abs = resolveUrl(m[1], base);
    if (!abs) continue;
    try {
      if (looksLikeSignApi(new URL(abs).pathname)) push(abs, '代码中发现的接口', '页面代码');
    } catch { /* ignore */ }
  }

  // 4) ajaxurl（WordPress 风格，如 "ajaxurl":"https:\/\/site\/wp-admin\/admin-ajax.php"）
  let ajaxUrl = '';
  const ajaxM = html.match(/["']ajaxurl["']\s*:\s*["']([^"']+)["']/);
  if (ajaxM) {
    ajaxUrl = ajaxM[1].replace(/\\\//g, '/');
    if (!/^https?:\/\//i.test(ajaxUrl)) ajaxUrl = '';
  }

  // 5) 同源 <script src>：库文件靠后，最多取 5 个
  const scripts = [];
  const sRe = /<script\b[^>]*src\s*=\s*(["'])(.*?)\1/gi;
  while ((m = sRe.exec(html))) {
    const abs = resolveUrl(m[2], base);
    if (!abs || seen.has('js:' + abs)) continue;
    seen.add('js:' + abs);
    try {
      if (new URL(abs).origin === new URL(base).origin) scripts.push(abs);
    } catch { /* ignore */ }
  }
  scripts.sort((a, b) => (LIB_JS_RE.test(a) ? 1 : 0) - (LIB_JS_RE.test(b) ? 1 : 0));

  return { candidates: out, scripts: scripts.slice(0, 5), ajaxUrl };
}

// 从 JS 文本中提取：疑似签到 API + action=xxx 签到动作
function extractFromJs(js, base, ajaxUrl) {
  const out = [];
  const seen = new Set();
  const push = (url, label, source, body = '') => {
    const abs = resolveUrl(url, base);
    if (!abs || seen.has(abs + '|' + body)) return;
    seen.add(abs + '|' + body);
    out.push({ url: abs, label: label.slice(0, 80), source, body });
  };

  const urlRe = /["']((?:https?:)?\/\/[^"'\s<>]+|\/[a-zA-Z0-9_\-./?=&%#]+)["']/g;
  let m;
  while ((m = urlRe.exec(js))) {
    const abs = resolveUrl(m[1], base);
    if (!abs) continue;
    try {
      if (looksLikeSignApi(new URL(abs).pathname)) push(abs, 'JS 中发现的接口', 'JS 文件');
    } catch { /* ignore */ }
  }

  // action:"user_qiandao" / action='do_sign' 这类 WP 风格签到动作
  const actRe = /action\s*[:=]\s*["']([a-zA-Z0-9_]+)["']/g;
  const origin = (() => { try { return new URL(base).origin; } catch { return ''; } })();
  while ((m = actRe.exec(js))) {
    const name = m[1];
    if (!looksLikeSignAction(name)) continue;
    const target = ajaxUrl || (origin ? origin + '/wp-admin/admin-ajax.php' : '');
    if (!target) continue;
    push(
      target,
      `签到动作 action=${name}（已自动填入请求体）`,
      ajaxUrl ? 'JS 动作' : 'JS 动作（推测地址）',
      `action=${name}`
    );
  }
  return out;
}

export async function probeSignEndpoints({ url, cookie = '', fetchImpl = fetch, maxCandidates = 20 } = {}) {
  const pageUrl = String(url || '').trim();
  if (!/^https?:\/\//i.test(pageUrl)) throw new Error('请填写 http(s) 开头的网址');

  const headers = { 'User-Agent': UA };
  if (cookie && String(cookie).trim()) headers.Cookie = String(cookie).trim();

  const get = async (u) => {
    const res = await fetchImpl(u, { headers, signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`抓取失败 HTTP ${res.status}：${u}`);
    const text = await res.text();
    return text.length > 2_000_000 ? text.slice(0, 2_000_000) : text;
  };

  const html = await get(pageUrl);
  const { candidates, scripts, ajaxUrl } = extractFromHtml(html, pageUrl);

  // 抓同源 JS 继续找（失败跳过）
  for (const jsUrl of scripts) {
    if (candidates.length >= maxCandidates) break;
    try {
      const js = await get(jsUrl);
      for (const c of extractFromJs(js, pageUrl, ajaxUrl)) {
        if (candidates.length >= maxCandidates) break;
        if (!candidates.some((x) => x.url === c.url && x.body === c.body)) candidates.push(c);
      }
    } catch { /* 单个 JS 失败不影响整体 */ }
  }

  return { page: pageUrl, candidates: candidates.slice(0, maxCandidates) };
}
