// Cookie 获取工具：把多种常见格式解析成 Cookie 字符串。
// 支持：原始 Cookie 字符串 / 完整请求头文本 / cURL 命令 /
//       Cookie-Editor(EditThisCookie) 导出的 JSON / Netscape cookie.txt。
// 纯函数、无 DOM 依赖：浏览器端 <script src> 引入，Node 端测试时 eval 加载。
// 挂载为全局：parseCookieHeader, extractCookieFromHeaders,
//             parseCookieEditorJson, parseNetscapeCookies, extractCookieFromCurl

function parseCookieHeader(str) {
  const s = String(str == null ? '' : str).trim().replace(/^Cookie\s*:\s*/i, '').trim();
  if (!s) throw new Error('内容为空，请先粘贴 Cookie');
  const parts = s.split(';').map((p) => p.trim()).filter(Boolean);
  if (!parts.length) throw new Error('没有解析到有效的 Cookie');
  return parts.join('; ');
}

function extractCookieFromHeaders(text) {
  const lines = String(text == null ? '' : text).split(/\r?\n/);
  const found = [];
  let userAgent = '';
  for (const line of lines) {
    const m = line.match(/^\s*cookie\s*:\s*(.+?)\s*$/i);
    if (m && m[1]) found.push(m[1]);
    const u = line.match(/^\s*user-agent\s*:\s*(.+?)\s*$/i);
    if (u && u[1]) userAgent = u[1];
  }
  if (!found.length) throw new Error('没有找到 Cookie 请求头（形如 Cookie: a=1; b=2）');
  return { cookie: parseCookieHeader(found.join('; ')), userAgent };
}

function parseCookieEditorJson(text) {
  let arr;
  try {
    arr = JSON.parse(String(text == null ? '' : text).trim());
  } catch (e) {
    throw new Error('JSON 解析失败：' + e.message);
  }
  if (!Array.isArray(arr)) {
    // 兼容单个对象
    if (arr && typeof arr === 'object' && arr.name) arr = [arr];
    else throw new Error('需要 Cookie-Editor / EditThisCookie 导出的 JSON 数组');
  }
  const parts = [];
  for (const c of arr) {
    if (!c || !c.name) continue;
    parts.push(c.name + '=' + (c.value == null ? '' : c.value));
  }
  if (!parts.length) throw new Error('JSON 里没有可用的 Cookie');
  return parts.join('; ');
}

function parseNetscapeCookies(text) {
  // Netscape cookie.txt：每行 domain \t flag \t path \t secure \t expires \t name \t value
  const lines = String(text == null ? '' : text).split(/\r?\n/);
  const parts = [];
  for (let line of lines) {
    line = line.trim();
    if (!line) continue;
    if (line.startsWith('#HttpOnly_')) line = line.slice('#HttpOnly_'.length).trim();
    else if (line.startsWith('#')) continue;
    const f = line.split('\t');
    if (f.length < 7) continue;
    const name = (f[5] || '').trim();
    const value = (f[6] || '').trim();
    if (!name) continue;
    parts.push(name + '=' + value);
  }
  if (!parts.length) throw new Error('没有解析到有效的 Cookie（需要 Netscape cookie.txt 格式，每行 7 列）');
  return parts.join('; ');
}

// ---------------------------------------------------------------------------
// 「粘进来的到底是什么」统一识别
// 一个函数吃下所有常见格式，免得页面与保存流程各判一次、迟早判出两种结果。
// 支持：扩展「一键复制全部信息」JSON / Cookie-Editor JSON / 请求头文本 /
//       cURL 命令 / Netscape cookie.txt / 光秃秃的 name=value 串
// ---------------------------------------------------------------------------
function parsePasteText(rawInput) {
  const raw = String(rawInput == null ? '' : rawInput).trim();
  if (!raw) throw new Error('请先在目标网站用扩展「📋 一键复制全部信息」，然后在这里粘贴');
  const v = raw.replace(/^["']|["'];?$/g, '');

  // ①/④ JSON：扩展格式带 cookies 字段；数组则是 Cookie-Editor 导出
  if (v.startsWith('{') || v.startsWith('[')) {
    let d = null;
    try { d = JSON.parse(v); } catch {
      // 人最容易犯的错是「没复制全」（结尾少了 } 或 "）—— 把这句话直接说出来
      const looksCut = !/[}\]]\s*$/.test(v);
      throw new Error(looksCut
        ? 'JSON 没解析成功，看着像没复制全（结尾少了 } 或引号）。请回扩展里重新点一次「📋 一键复制全部信息」再粘。'
        : 'JSON 格式不对，请在扩展里点「📋 一键复制全部信息」重新复制一次');
    }
    if (Array.isArray(d)) {
      return { cookie: parseCookieEditorJson(v), domain: '', userAgent: '', format: 'Cookie-Editor JSON' };
    }
    if (!d || !d.cookies) throw new Error('这段 JSON 里没有 Cookie，请确认是扩展「一键复制全部信息」复制出来的');
    return {
      cookie: String(d.cookies),
      domain: String(d.domain || ''),
      userAgent: String(d.userAgent || d.ua || ''),
      cookieList: Array.isArray(d.cookieList) ? d.cookieList : [],
      localStorage: d.localStorage && typeof d.localStorage === 'object' ? d.localStorage : {},
      stats: d.stats || null,
      format: '扩展「一键复制全部信息」',
    };
  }

  // ③ cURL：浏览器右键「复制为 cURL」
  if (/^curl\s|curl\s+'https?:/i.test(v)) {
    const r = extractCookieFromCurl(v);
    return { cookie: r.cookie, domain: '', userAgent: r.userAgent || '', format: '浏览器复制的 cURL 命令' };
  }

  // ② 请求头文本：带 Cookie: / User-Agent: 这类头
  if (/^\s*cookie\s*:/im.test(v) || /^\s*user-agent\s*:/im.test(v)) {
    const r = extractCookieFromHeaders(v);
    return { cookie: r.cookie, domain: '', userAgent: r.userAgent || '', format: '浏览器复制的请求头' };
  }

  // ④ Netscape cookie.txt：以 # 开头的注释 + 制表符分隔的 7 列
  if (/^#(?: Netscape )?HTTP Cookie File/im.test(v) || v.split('\n').some((l) => l.split('\t').length === 7)) {
    return { cookie: parseNetscapeCookies(v), domain: '', userAgent: '', format: 'cookie.txt（Netscape 格式）' };
  }

  // ⑤ 纯 Cookie 串
  if (v.includes('=')) {
    return { cookie: v, domain: '', userAgent: '', format: '纯 Cookie 字符串' };
  }
  throw new Error('没看出这是 Cookie，请用扩展的「📋 一键复制全部信息」再试一次');
}

// 把解析结果拆成「一段一段 + 中文说明」，供面板直接渲染（不关心 DOM）。
function splitCookieParts(cookie, cookieList) {
  if (Array.isArray(cookieList) && cookieList.length) {
    return cookieList.map((c) => ({
      name: String(c.name || ''),
      value: String(c.value == null ? '' : c.value),
      note: [
        c.httpOnly ? 'HttpOnly（脚本读不到、只能用扩展抓）' : '',
        c.session ? '会话 Cookie（关浏览器就失效）' : '',
        c.path && c.path !== '/' ? '路径 ' + c.path : '',
        c.expirationDate ? '有效期至 ' + new Date(c.expirationDate * 1000).toLocaleDateString('zh-CN') : '',
      ].filter(Boolean).join('，') || '普通 Cookie',
    }));
  }
  return String(cookie || '')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const i = s.indexOf('=');
      return { name: (i >= 0 ? s.slice(0, i) : s).trim(), value: i >= 0 ? s.slice(i + 1) : '' };
    })
    .filter((x) => x.name);
}

// 给每一段加上「它是什么」：类型（登录必需/安全校验/表单防护/界面偏好/统计）+ 中文说明 + 值形态
function explainCookieText(raw) {
  const info = parsePasteText(raw);
  const parts = splitCookieParts(info.cookie, info.cookieList).map((p) => {
    const named = /^[A-Za-z0-9_.\-]+$/.test(p.name);
    const d = named ? describeCookieName(p.name) : { desc: '名字含特殊字符，可能是值里多了分隔符', kind: 'other' };
    const fromList = Array.isArray(info.cookieList) && info.cookieList.length;
    return {
      name: p.name,
      kind: d.kind,
      desc: d.desc,
      detail: fromList ? p.note : describeCookieValue(p.value),
    };
  });
  const counts = { login: 0, waf: 0, csrf: 0, pref: 0, stat: 0, other: 0 };
  for (const p of parts) counts[p.kind] = (counts[p.kind] || 0) + 1;
  return {
    format: info.format,
    domain: info.domain || '',
    userAgent: info.userAgent || '',
    cookie: info.cookie,
    cookieList: info.cookieList || [],
    localStorage: info.localStorage || {},
    parts,
    counts,
    // 一句人话小结：登录必需的几段、安全校验几段
    summary: '共 ' + parts.length + ' 段：登录必需 ' + counts.login + ' 段、网站安全校验 ' + counts.waf +
      ' 段' + (counts.csrf ? '、表单防护 ' + counts.csrf + ' 段' : '') +
      (counts.stat ? '、纯统计 ' + counts.stat + ' 段（可忽略）' : ''),
  };
}

// ---------------------------------------------------------------------------
// 粘贴内容的「体检」：保存前把能查的都查一遍，把低级错误挡在保存之前。
// 纯函数（不碰 DOM、不碰站点表）—— 站点相关的匹配由页面补（见 index.html 的 pasteCheck）。
// 返回 { level:'ok'|'warn'|'bad', items:[{ level, title, detail }] }
//   ok   通过
//   warn 提醒（可以继续，但用户要知道）
//   bad  硬错误（不要保存）
// ---------------------------------------------------------------------------
function checkPastedCreds(info) {
  const d = info || {};
  const items = [];
  const cookie = String(d.cookie || '').trim();
  const parts = splitCookieParts(cookie, d.cookieList).filter((p) => p.name);
  if (!cookie || !parts.length) {
    return { level: 'bad', items: [{ level: 'bad', title: '没有读到 Cookie', detail: '这段内容里没有 name=value 形式的 Cookie。请回到目标网站，用扩展的「📋 一键复制全部信息」重新复制一次。' }] };
  }
  items.push({ level: 'ok', title: '认出了格式：' + (d.format || '未知格式'), detail: '面板自己判断，你不用手动选格式。' });

  const counts = { login: 0, waf: 0, csrf: 0, pref: 0, stat: 0, other: 0 };
  for (const p of parts) counts[describeCookieName(p.name).kind] += 1;
  items.push({
    level: 'ok',
    title: 'Cookie 一共 ' + parts.length + ' 段',
    detail: '登录必需 ' + counts.login + ' 段、网站安全校验 ' + counts.waf + ' 段'
      + (counts.csrf ? '、表单防护 ' + counts.csrf + ' 段' : '')
      + (counts.stat ? '、纯统计 ' + counts.stat + ' 段（可忽略）' : '') + '。',
  });
  // 一句一个的提醒（都能继续，但得让人知道）
  if (counts.login === 0) {
    items.push({ level: 'warn', title: '没看出「登录必需」的 Cookie', detail: '这段几乎都是统计 / 偏好类的话，签到很可能被判成未登录。确认自己确实登录着再存。' });
  }
  const empty = parts.filter((p) => !String(p.value == null ? '' : p.value).trim());
  if (empty.length) {
    items.push({ level: 'warn', title: '有 ' + empty.length + ' 段是空值', detail: '空 Cookie 通常代表没抓到或被站点清掉了：' + empty.slice(0, 5).map((p) => p.name).join('、') + (empty.length > 5 ? ' 等' : '') + '。' });
  }
  if (!String(d.domain || '').trim()) {
    items.push({ level: 'warn', title: '这段内容里没带域名', detail: '面板要靠域名自动认站点；没带就只能手动选一次。用扩展「一键复制全部信息」通常会带。' });
  } else {
    items.push({ level: 'ok', title: '来自网站：' + String(d.domain), detail: '' });
  }
  const ls = d.localStorage && typeof d.localStorage === 'object' ? d.localStorage : {};
  if (Object.keys(ls).length) {
    items.push({ level: 'ok', title: '附带 ' + Object.keys(ls).length + ' 项 localStorage', detail: '有些站（如 akile）把登录 token 放这里，一起存下来才不会掉登录。' });
  }

  // WordPress 登录会话自带到期时间：过期的会话粘进去必然还是「未登录」。
  // 在这里说清楚，用户就不用在「更新 Cookie → 还是登录已失效」之间反复转了。
  //
  // 为什么过期不再直接判「不许保存」：糊涂鳄这类站现在可以用账号密码**自动重新登录**
  // （见它的站点模块），所以「一份过期的 Cookie + 正确的账号密码」是完全可用的组合；
  // 把保存按钮直接封死反而让用户没法这么配。这里降为提醒，并把两条出路都写出来。
  const wp = wpLoginSessions(cookie);
  if (wp.length) {
    const fmt = (ts) => (ts ? new Date(ts).toLocaleString('zh-CN') : '未知时间');
    const valid = wp.filter((s) => !s.expired);
    const expired = wp.filter((s) => s.expired);
    // 每段会话是哪个域名来的（扩展的「一键复制全部信息」会带上）：
    // 同品牌两个独立站（hutue.cn / dj.hutue.cn）混在一串里时就靠它说清楚。
    const domOf = {};
    for (const c of (Array.isArray(d.cookieList) ? d.cookieList : [])) {
      if (c && c.name) domOf[String(c.name)] = String(c.domain || '');
    }
    const where = (s) => (domOf[s.name] ? '（来自 ' + domOf[s.name] + '）' : '');
    const desc = (s) => (s.user ? s.user + ' ' : '') + fmt(s.exp) + ' 到期' + where(s);
    const domains = [...new Set(wp.map((s) => domOf[s.name]).filter(Boolean))];
    if (!valid.length) {
      items.push({
        level: 'warn',
        title: '这份 Cookie 里的登录会话已经过期了',
        detail: 'WordPress 把到期时间写在 wordpress_logged_in_ 里，它写着 '
          + expired.map(desc).join('、') + ' 到期（现在 ' + fmt(Date.now()) + '）。\n'
          + '两条出路任选：① 这个账号如果填了账号密码，面板会在会话过期时自己重新登录（糊涂鳄这类站已支持），这份 Cookie 可以照常保存；'
          + '② 否则请在浏览器重新登录该网站 —— 确认页面上能看到自己的用户名（或「退出登录」）—— 再用扩展复制一次。',
      });
    } else if (expired.length) {
      items.push({
        level: 'warn',
        title: '有 ' + expired.length + ' 段登录会话已过期',
        detail: '仍有效的还有 ' + valid.length + ' 段（' + valid.map(desc).join('、') + '）。'
          + '同一品牌的两个独立站（如 hutue.cn 与 dj.hutue.cn）各有一套会话，'
          + '如果目标站用的不是有效的那一段，签到照样会被判成未登录。',
      });
    } else {
      items.push({
        level: 'ok',
        title: '登录会话有效',
        detail: wp.map(desc).join('、'),
      });
    }
    // 一串里混着两个域名的会话 —— 复制时把两个站混在一起了，这正是「我明明更新了 Cookie，
    // 面板还说登录已失效」最常见的原因：有效的那段是给另一个站的。
    if (domains.length > 1) {
      items.push({
        level: 'warn',
        title: '这份 Cookie 混了两个域名的登录会话：' + domains.join('、'),
        detail: '同一品牌的两个独立站各有一套登录态，混在一起复制时，看上去「还有效」的那段往往属于另一个站。'
          + '建议回到目标站点重新复制一次（只保留该站的登录态）；面板在签到时会自动只保留属于本站的那几段，并在反馈里说明。',
      });
    }
  }
  const level = items.some((i) => i.level === 'bad') ? 'bad' : (items.some((i) => i.level === 'warn') ? 'warn' : 'ok');
  return { level, items };
}

// ---------------------------------------------------------------------------
// WordPress 登录会话**自带到期时间**，这是「这份 Cookie 到底还能不能用」最硬的判据。
//
// 值形如 `other-user|1791635708|token|hmac`（URL 编码），中间那段就是站点自己判
// 「认不认这个会话」用的时间（wp_parse_auth_cookie：过期即当作未登录）。
// 于是不用发任何请求就能知道结果 —— 用户最常卡住的地方正是这里：
// 「我明明更新了 Cookie」而复制到的其实是**已经过期的那一份**，
// 面板于是永远回「登录已失效」，两边来回改却谁也没错。
//
// 同一品牌的两个独立站（hutue.cn / dj.hutue.cn）各有一套 cookie hash，而两套 Cookie
// 往往都挂在同一个上级域（.hutue.cn）下，于是复制出来的一串里混着两边的会话 ——
// 这里把每一段都带上「用户 + 到期时间」，界面才能说清「有效的那段是给另一个站的」。
//
// 注意：Worker 端有一份等价实现（src/lib/cookie-info.js），两份必须一致，
// test/cookie-info.test.mjs 会拿同一批样本比对它们的结果。
function wpLoginSessions(cookie, now) {
  const t = Number(now) || Date.now();
  const out = [];
  for (const seg of String(cookie || '').split(';')) {
    const s = seg.trim();
    if (!s) continue;
    const i = s.indexOf('=');
    if (i < 0) continue;
    const name = s.slice(0, i).trim();
    if (!/^wordpress_logged_in_/i.test(name)) continue;
    let val = s.slice(i + 1);
    try { val = decodeURIComponent(val); } catch { /* 解不开就按原样 */ }
    const parts = val.split('|');
    const expSec = Number(parts[1]);
    const exp = Number.isFinite(expSec) && expSec > 1e9 ? expSec * 1000 : 0;
    out.push({
      name,
      hash: name.replace(/^wordpress_logged_in_/i, ''),
      user: String(parts[0] || '').trim(),
      exp,
      expired: exp > 0 ? exp < t : false,
    });
  }
  return out;
}

function extractCookieFromCurl(cmd) {
  // parseCurl 由 curl-import.js 提供（浏览器端先引入该文件，测试时先 eval 它）
  const pc = typeof parseCurl === 'function' ? parseCurl : (typeof globalThis !== 'undefined' && typeof globalThis.parseCurl === 'function' ? globalThis.parseCurl : null);
  if (!pc) throw new Error('cURL 解析器未加载');
  const p = pc(cmd);
  const cookie = p.headers['Cookie'] || p.headers['cookie'];
  if (!cookie || !String(cookie).trim()) throw new Error('这条 cURL 里没有 Cookie（需要 -H "Cookie: ..." 或 -b 参数）');
  const ua = p.headers['User-Agent'] || p.headers['user-agent'] || '';
  return { cookie: parseCookieHeader(cookie), userAgent: ua, url: p.url };
}

// ============================================================================
// Cookie 逐段中文说明（面板的「Cookie 解析器」用）
// 目的：用户粘一大串 Cookie 时，能看懂哪段是登录必需的、哪段是网站安全校验
// （比如吾爱破解的 wzws_cid）、哪些只是统计（丢了也不影响签到）。
// ============================================================================
const COOKIE_KNOWN = [
  [/^PHPSESSID$/i, 'PHP 会话 ID', 'login'],
  [/^(session|sessionid|sid|sess|bbs_sid|connect_sid)$/i, '会话标识（服务器靠它认得你）', 'login'],
  [/^JSESSIONID$/i, 'Java 会话 ID', 'login'],
  [/^laravel_session$/i, 'Laravel 会话 ID', 'login'],
  [/^(ASP\.NET_SessionId|__RequestVerificationToken)$/i, 'ASP.NET 会话 / 表单令牌', 'login'],
  [/^wordpress_(logged_in|sec)/i, 'WordPress 登录态（糊涂鳄这类站就是它）', 'login'],
  [/^wp-settings/i, 'WordPress 界面偏好', 'pref'],
  [/^saltkey$/i, 'Discuz 登录盐值（配合会话一起校验）', 'login'],
  [/^(c_token|token|access_token|auth|auth_token|jwt|refresh_token|x-token)$/i, '登录令牌（很多站把它当唯一凭据）', 'login'],
  [/^(cf_clearance|cf_chl_\w+|__cf_bm|__cfduid)$/i, 'Cloudflare 人机校验通行证（换 IP / 换浏览器会失效）', 'waf'],
  [/^(wzws_\w+|csm_\w+)$/i, '网宿 WAF 校验（吾爱破解要的就是它，缺了会被 403）', 'waf'],
  [/^(acw_tc|cdn_sec_tc|aliyungf_tc|cna)$/i, '阿里云 CDN / WAF 标记', 'waf'],
  [/^(XSRF-TOKEN|csrf\w*|_csrf)$/i, '跨站请求伪造防护（提交表单时要带上）', 'csrf'],
  [/^(_ga|_gid|_gat\w*|Hm_lvt_\w+|Hm_lpvt_\w+|CNZZDATA\w*|_clck|_clsk)$/i, '访问统计，与登录无关（丢了也不碍事）', 'stat'],
  [/^(_pk_id|_pk_ses|matomo\w*)$/i, '站点统计', 'stat'],
  [/^(theme|lang|language|noticeTitle|style|fontsize|_style_\w+)$/i, '界面偏好', 'pref'],
  [/^(cookie_?consent|consent|gdpr\w*)$/i, 'Cookie 同意提示的记录', 'pref'],
  [/^(referer|lastvisit|lastactive|online\w*)$/i, '上次访问痕迹', 'pref'],
  [/^(seraph\w*|tt_\w+|s_v_\w+|ssid|fip)$/i, '风控 / 指纹类标记', 'waf'],
];

function describeCookieName(name) {
  const n = String(name || '');
  for (const [re, desc, kind] of COOKIE_KNOWN) {
    if (re.test(n)) return { desc: desc, kind: kind };
  }
  return { desc: '站点自定义', kind: 'other' };
}

// 值只讲「长什么样」，不把敏感内容摊开：长度、像不像 JWT / 时间戳 / base64。
function describeCookieValue(v) {
  const s = String(v == null ? '' : v);
  if (!s) return '空值（可能没抓到或已被清掉）';
  const bits = ['长度 ' + s.length];
  if (/^\d{10}$/.test(s)) bits.push('像 Unix 时间戳（' + new Date(Number(s) * 1000).toLocaleString('zh-CN') + '）');
  else if (/^[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}$/.test(s)) bits.push('像 JWT 令牌');
  else if (/^[A-Za-z0-9+/]{24,}={0,2}$/.test(s)) bits.push('像 base64 数据');
  else if (/^[0-9a-f]{32}$/i.test(s)) bits.push('像 32 位十六进制（Discuz 会话常见）');
  else if (/\|/.test(s)) bits.push('含竖线（WordPress 登录态常见形态）');
  if (/[^\x20-\x7E]/.test(s)) bits.push('含中文 / 非 ASCII 字符');
  // 只露头尾给用户对一下（面板截图/录屏时不该把凭据全文摊在屏幕上）
  return bits.join('，') + '：' + (s.length > 12 ? s.slice(0, 6) + '…' + s.slice(-4) : '短值（不展示）');
}

if (typeof globalThis !== 'undefined') {
  globalThis.describeCookieName = describeCookieName;
  globalThis.describeCookieValue = describeCookieValue;
  globalThis.parsePasteText = parsePasteText;
  globalThis.splitCookieParts = splitCookieParts;
  globalThis.checkPastedCreds = checkPastedCreds;
  globalThis.wpLoginSessions = wpLoginSessions;
  globalThis.explainCookieText = explainCookieText;
  globalThis.parseCookieHeader = parseCookieHeader;
  globalThis.extractCookieFromHeaders = extractCookieFromHeaders;
  globalThis.parseCookieEditorJson = parseCookieEditorJson;
  globalThis.parseNetscapeCookies = parseNetscapeCookies;
  globalThis.extractCookieFromCurl = extractCookieFromCurl;
}
