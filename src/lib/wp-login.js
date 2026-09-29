// WordPress 账号密码登录（拿一份新的登录会话）。
//
// 为什么需要它：hutue.cn / dj.hutue.cn 这类站的登录会话短得离谱 ——
// 实测（2026-09-29）一个 wp-login 会话只有 12～48 小时，过期后站点一定回「请先登录」。
// 面板如果只会用「用户某天复制的那一份 Cookie」，那它注定会隔一两天就失效一次，
// 表现就是用户看到的那句「登录已失效，请重新获取 Cookie」——而用户其实什么也没做错。
//
// 所以：只要账号里存着用户名 + 密码，会话过期时面板自己重新登录一次。
// 走哪条网络由调用方决定：本模块只用 globalThis.fetch，
// runner 在「本地网络」路线上会把 globalThis.fetch 换成中继版本（见 runner.js），
// 于是这里天然支持两条路线：
//   · CF 直连：POST 由 Worker 发出，Set-Cookie 能读到 → 回写进面板的凭据里；
//   · 本地网络：POST 在浏览器里（目标域名的标签页）发出，浏览器自己种下新会话，
//     页面 JS 读不到 HttpOnly 的 Set-Cookie，但后续请求天然带着它。
//
// 返回 { ok, cookie, user, message, blocked }：
//   ok      true 表示登录成功（已用页面上的「退出登录 / 管理条」等痕迹确认过）
//   cookie  能读到的 Set-Cookie 合并串（读不到就是 ''，不代表失败）
//   blocked true 表示站点要求人机验证 —— 这种情况面板不该反复重试
import { cookiesFrom, mergeCookies, browserHeaders } from './web.js';

const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

// 页面上的「已登录」痕迹：WordPress 默认主题/后台都会留这些
const LOGGED_IN_RE = /wpadminbar|wp-admin-bar|action=logout|退出登录|我的账户|user-name/i;
// 登录失败的痕迹：wp-login.php 的报错块
const LOGIN_ERROR_RE = /id=["']login_error["'][\s\S]{0,400}?<\/div>/i;
const CAPTCHA_RE = /captcha|验证码|geetest|slider|拖动滑块|人机验证/i;

// cookiesFrom 依赖响应头对象存在；中继/测试里的响应未必有，这里统一兜一层
function safeCookies(res) {
  try { return cookiesFrom(res); } catch { return ''; }
}

function textOf(html) {
  return String(html || '').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
}

export async function wpLogin({ base, username, password, ua } = {}) {
  const root = String(base || '').replace(/\/+$/, '');
  const user = String(username || '').trim();
  const pass = String(password || '');
  if (!root || !user || !pass) return { ok: false, message: '缺少账号或密码' };
  const headers = { ...browserHeaders(root + '/', { 'User-Agent': String(ua || '').trim() || DEFAULT_UA }) };

  // ① 先访问一次登录页。
  //    WordPress 会在这里种下 wordpress_test_cookie —— 缺了它 wp-login.php 会直接拒绝登录
  //    （「Cookies 被禁用」）。经中继时这一步还有第二个作用：让浏览器把这个 cookie 种进它自己的 jar。
  let jar = '';
  let loginHtml = '';
  try {
    const res = await fetch(root + '/wp-login.php', { headers, redirect: 'follow' });
    jar = mergeCookies(jar, safeCookies(res));
    loginHtml = await res.text();
  } catch (e) {
    return { ok: false, message: '打不开登录页（' + String((e && e.message) || e).slice(0, 120) + '）' };
  }
  if (CAPTCHA_RE.test(loginHtml)) {
    return { ok: false, blocked: true, message: '站点的登录页要求人机验证，面板不能替你过验证码 —— 请在浏览器登录一次再把 Cookie 复制过来' };
  }

  // ② 提交登录。rememberme=forever 能拿到更长的会话（默认只有两天）。
  const form = new URLSearchParams({
    log: user,
    pwd: pass,
    rememberme: 'forever',
    'wp-submit': '登录',
    redirect_to: root + '/',
    testcookie: '1',
  });
  let postStatus = 0;
  let postHtml = '';
  let location = '';
  try {
    const res = await fetch(root + '/wp-login.php', {
      method: 'POST',
      headers: { ...headers, ...(jar ? { Cookie: jar } : {}), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      // manual 才能在直连时区分「302 回站点（成功）」和「停在 wp-login.php（失败）」；
      // 经中继时页面 fetch 拿不到 opaqueredirect，扩展会退化成 follow，也不影响判断。
      redirect: 'manual',
    });
    postStatus = res.status;
    location = (res.headers && res.headers.get && (res.headers.get('location') || res.headers.get('Location'))) || '';
    jar = mergeCookies(jar, safeCookies(res));
    postHtml = await res.text();
  } catch (e) {
    return { ok: false, message: '登录请求失败（' + String((e && e.message) || e).slice(0, 120) + '）' };
  }

  const errBlock = postHtml.match(LOGIN_ERROR_RE);
  if (errBlock) {
    const why = textOf(errBlock[0]).replace(/^错误[：:]\s*/, '').trim().slice(0, 120);
    return { ok: false, message: '站点拒绝了这次登录' + (why ? '：' + why : ''), cookie: jar };
  }

  // ③ 验证：登录页不该再是登录页（有表单就是没登进去），首页要能看到「已登录」痕迹。
  //    只看 Set-Cookie 是不够的 —— 经中继时根本读不到它。
  let homeHtml = '';
  try {
    const home = await fetch(root + '/', { headers: { ...headers, ...(jar ? { Cookie: jar } : {}) }, redirect: 'follow' });
    jar = mergeCookies(jar, safeCookies(home));
    homeHtml = await home.text();
  } catch { /* 首页拿不到就看下面的判据，不因此判失败 */ }

  const hasLoginForm = /id=["']loginform["']/i.test(postHtml) || /id=["']loginform["']/i.test(homeHtml);
  const looksLoggedIn = LOGGED_IN_RE.test(homeHtml) || /action=logout/i.test(postHtml);
  if (looksLoggedIn && !hasLoginForm) return { ok: true, cookie: jar, user, message: '登录成功' };
  if (hasLoginForm) {
    return {
      ok: false, cookie: jar, user,
      message: '登录没有生效（页面仍是登录表单）' + (postStatus ? '，HTTP ' + postStatus : '')
        + '。常见原因：账号或密码不对；站点要求验证码；或这个账号被站点限制登录。',
    };
  }
  // 判不出来：不冒充成功，也不冒充失败
  return {
    ok: false, cookie: jar, user,
    message: '登录结果不明（HTTP ' + (postStatus || '?') + (location ? ' → ' + String(location).slice(0, 80) : '') + '）',
  };
}
