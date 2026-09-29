// 糊涂鳄资源站每日签到（hutue.cn / dj.hutue.cn，WordPress + RiPro 主题）
// ---------------------------------------------------------------------------
// 关键发现（2026-09-27）：这两个站登录后，页面右侧会挂一个「签到」悬浮窗。
// 悬浮窗不是简单的固定链接，而是主题自带的 AJAX 组件——不同 RiPro 版本/魔改版
// 用的 action 名并不统一（user_qiandao / xb_user_qiandao / 甚至自定义），
// 有的还要求带一个 nonce。靠硬编码 action 名会随主题升级随时失效。
//
// 因此本模块改为「先发现、再执行」：
//   ① 用登录 Cookie 抓一次站点首页，从 HTML/内联 JS 里找出：
//        - ajax 入口（ajaxurl / ajax_url）
//        - 候选 action（形如 action:'xxx_qiandao' / data-action="qiandao"，
//          以及页面里出现的 /wp-json/...qiandao... 路由）
//        - 可能的 nonce
//   ② 先试「发现到的 action」，再兜底常见 action；nonce 有就带着，失败再试不带
//   ③ 用统一的网站反馈识别器（signals.js）判定成功/已签/登录失效/验证码
//
// 这样悬浮窗换了 action 名也能自动跟上，不需要改代码。

import { classifySignal, OUTCOME } from '../lib/signals.js';
import { splitCookieBySite, wpLoginDiagnosis } from '../lib/cookie-info.js';
import { wpLogin } from '../lib/wp-login.js';
import { mergeCookies } from '../lib/web.js';
import { encryptJSON } from '../crypto.js';

const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

// 站点真正的签到 action：永远放最高优先级，不靠猜也不靠记。
//
// 【重要踩坑】站点有两个长得几乎一样的「签到」，奖励完全不同：
//   ① 真签到：首页右侧悬浮窗 <a class="click-qiandao zzhuti_qd_1">打卡签到</a>，
//      首页文案写着「每天签到 5 晶石」。它的处理器在**父主题** RiPro 的
//      /wp-content/themes/ripro/assets/js/app.js：
//        $(".click-qiandao").on("click", … $.post(caozhuti.ajaxurl, {action:"user_qiandao"}) )
//      → 1 == status 为成功。
//   ② 会员中心的「首页签到」：/wp-content/themes/xb-child/assets/js/xb-app.js 里
//      $(".user-index-qd") → action:"xb_user_qiandao"，奖励只有 1 积分。
//
// 线上事故：面板一直打的是 ②。它确实会回 {status:1,msg:"签到成功，赠送1积分"}，
// 于是面板报「签到成功」——但真签到 ① 根本没动，用户去网站点悬浮窗照样能领 5 晶石，
// 看起来就是「面板的签到是假的」。所以 ① 必须排第一，② 仅当 ① **接口不存在**时兼用。
//
// 2026-09-28 复核（直读站点主题 JS，不是猜）：
//   dj.hutue.cn/wp-content/themes/ripro/assets/js/app.js:
//     $(".click-qiandao").on("click", function(){ … $.post(caozhuti.ajaxurl,{action:"user_qiandao"}) … })
//   dj.hutue.cn/wp-content/themes/xb-child/assets/js/xb-app.js:
//     action: "xb_user_qiandao"   ← 会员中心那个「首页签到」，只给 1 积分
// 而页面上的悬浮窗就是 <a class="click-qiandao zzhuti_qd_1" title="打卡签到">，
// 即**真签到 = user_qiandao**。换接口只允许发生在「真接口不存在」时，否则就是假签到。
const SITE_ACTIONS = ['user_qiandao'];
// 会员中心的另一个签到（只给 1 积分）：只当真接口不存在时才轮到它，且要在反馈里说清楚。
const LAST_RESORT_ACTIONS = ['xb_user_qiandao'];
// 兜底 action 名（发现阶段与主题 action 都没命中时才用）
const FALLBACK_ACTIONS = ['qiandao', 'user_checkin', 'xb_qiandao'];
const MAX_ATTEMPTS = 5; // 最多打几次，避免把站点打烦（中继模式下每次尝试都是一次网络往返，要省着用）

function normBase(u) {
  let s = String(u || '').trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  return s.replace(/\/+$/, '');
}

function absolutize(u, base) {
  const s = String(u || '').trim().replace(/\\\//g, '/');
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s;
  if (s.startsWith('//')) return 'https:' + s;
  if (s.startsWith('/')) return base + s;
  return base + '/' + s;
}

function tryJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

// 排 JS 文件优先级：主题主文件（assets/js/app.js）最可能写着「按钮 → action」的绑定关系
function rankScript(u) {
  const s = String(u || '');
  if (/\/assets\/js\/(app|main)(\.min)?\.js/i.test(s)) return 0;
  if (/\/themes\/[^/]+\/assets\//i.test(s)) return 1;
  return 2;
}

// ---------- ① 从首页发现签到接口 ----------
// 返回 { ajaxUrl, actions: [], routes: [], nonce, jsUrls: [] }
// jsUrls: 页面引用的主题 JS 文件（签到 action 可能藏在其中）
// actions: 按「可信度」排序——按钮真实绑定的 action 排最前，泛匹配的靠后
export function discoverSignin(base, html) {
  const out = { ajaxUrl: '', actions: [], buttonActions: [], routes: [], nonce: '', jsUrls: [] };

  const ajax = String(html || '').match(/["']?(?:ajaxurl|ajax_url|adminAjax)["']?\s*[:=]\s*["']([^"']+)["']/i);
  if (ajax) out.ajaxUrl = absolutize(ajax[1], base);

  // 收集主题相关的外部 JS 文件地址（签到 action 可能藏在主题 JS 里）。
  // 排序很关键：签到按钮的处理器在**父主题**的 /assets/js/app.js 里，
  // 而子主题的 xb-app.js 里藏着另一个「会员中心签到」（奖励完全不同）。
  // 不排序的话，先抓到哪个全看页面里 <script> 的先后，很容易抓错。
  const scriptRe = /<script[^>]+src=["']([^"']+\.js[^"']*)["']/gi;
  let sm;
  while ((sm = scriptRe.exec(String(html || ''))) !== null) {
    const abs = absolutize(sm[1], base);
    if (abs && /wp-content\/(themes|plugins)/i.test(abs) && !out.jsUrls.includes(abs)) {
      out.jsUrls.push(abs);
      if (out.jsUrls.length >= 8) break;
    }
  }
  // 主 JS（assets/js/app.js）排最前，其余的靠后
  out.jsUrls.sort((a, b) => rankScript(a) - rankScript(b));

  // action:'user_qiandao' / action: "xb_user_qiandao" / data-action="qiandao"
  const actionRe = /(?:action|do|type)\s*[:=]\s*["']([A-Za-z0-9_-]*(?:qiandao|checkin|check_in|signin|sign_in)[A-Za-z0-9_-]*)["']/gi;
  for (const m of String(html || '').matchAll(actionRe)) {
    if (m[1] && !out.actions.includes(m[1])) out.actions.push(m[1]);
  }
  const dataActionRe = /data-(?:action|do)\s*=\s*["']([A-Za-z0-9_-]*(?:qiandao|checkin|sign)[A-Za-z0-9_-]*)["']/gi;
  for (const m of String(html || '').matchAll(dataActionRe)) {
    if (m[1] && !out.actions.includes(m[1])) out.actions.push(m[1]);
  }
  // 站内出现的中文关键词附近若带引号标识符，也收进来（如 'sign': 'qiandao'）
  const looseRe = /["']([A-Za-z0-9_-]{3,40})["']\s*:\s*["']([A-Za-z0-9_-]*(?:qiandao|checkin|signin)[A-Za-z0-9_-]*)["']/gi;
  for (const m of String(html || '').matchAll(looseRe)) {
    if (m[2] && !out.actions.includes(m[2])) out.actions.push(m[2]);
  }

  // 【关键】按钮真正绑定的 action：页面里出现站点的签到按钮（RiPro 是
  // <a class="click-qiandao …">）时，往后找最近的 action:"…"——那个才是点按钮会走的接口。
  // 实测：不认按钮，只做泛匹配时，会先抓到另一个名字很像、奖励却完全不同的 action。
  const buttonActions = [];
  const btnRe = /(?:class|id)\s*=\s*["'][^"']*(click-qiandao|qiandao-btn|qd-btn)[^"']*["'][\s\S]{0,800}?action\s*:\s*["']([A-Za-z0-9_-]+)["']/gi;
  for (const m of String(html || '').matchAll(btnRe)) {
    if (m[2] && !buttonActions.includes(m[2])) buttonActions.push(m[2]);
  }
  // 同一份代码里也可能是反过来的顺序：先绑事件再取按钮
  const btnRe2 = /click-qiandao[\s\S]{0,400}?action\s*:\s*["']([A-Za-z0-9_-]+)["']/gi;
  for (const m of String(html || '').matchAll(btnRe2)) {
    if (m[1] && !buttonActions.includes(m[1])) buttonActions.push(m[1]);
  }
  if (buttonActions.length) {
    out.buttonActions = buttonActions;
    out.actions = [...buttonActions, ...out.actions.filter((a) => !buttonActions.includes(a))];
  }

  // REST 路由线索：/wp-json/xxx/qiandao（绝对或站内相对路径都要能识别）
  const routeRe = /["']([^"'\s]*wp-json[^"'\s]*(?:qiandao|checkin|sign)[^"'\s]*)["']/gi;
  for (const m of String(html || '').matchAll(routeRe)) {
    const abs = absolutize(m[1], base);
    if (abs && !out.routes.includes(abs)) out.routes.push(abs);
  }

  // nonce：优先主题专用字段名，其次通用 nonce
  const noncePats = [
    /["']?(?:ripro_ajax_nonce|ripro_nonce|ajax_nonce|_ajax_nonce|security)["']?\s*[:=]\s*["']([A-Za-z0-9_-]{6,})["']/i,
    /data-nonce\s*=\s*["']([A-Za-z0-9_-]{6,})["']/i,
    /["']?nonce["']?\s*[:=]\s*["']([A-Za-z0-9_-]{6,})["']/i,
  ];
  for (const p of noncePats) {
    const m = String(html || '').match(p);
    if (m) { out.nonce = m[1]; break; }
  }

  return out;
}

// ---------- ③ 判定一次签到响应 ----------
// 约定：
//   { done: true,  result: { ok: true,  message } }        → 签到成功/今日已签，立即返回
//   { done: true,  result: { ok: false, message, outcome } } → 该 action 给出「明确负面结论」
//                                                              （登录失效/验证码/WAF/限流），
//                                                              记录下来，但继续试别的 action
//   { done: false, reason }                                 → 线索不足，继续试下一个 action
// 不在函数内抛异常，便于调用方在所有 action 试完后再挑最有信息量的原因抛出。
export function judgeSigninResponse(raw, status) {
  const text = String(raw == null ? '' : raw).trim();
  const snippet = `网站返回：${text.replace(/\s+/g, ' ').slice(0, 300)}`;
  const j = tryJson(text);

  if (j && typeof j === 'object') {
    const msg = String(j.msg || j.message || (j.data && (j.data.msg || j.data.message)) || '');
    const okFlag =
      j.status == 1 || j.code == 1 || j.ret == 1 || j.success === true ||
      (j.data && (j.data.status == 1 || j.data.success === true || j.data.code == 1));
    if (okFlag) {
      // 直接用网站自己返回的那句话，不再拼「签到成功：」前缀。
      // 面板「网站反馈」列要的就是网站真实反馈；拼前缀会变成
      // 「签到成功：签到成功，赠送1积分」这种既重复又不算真实反馈的东西。
      return { done: true, result: { ok: true, message: msg || '签到成功（网站未返回文字）', detail: snippet } };
    }
    const sig = classifySignal(msg || text, { status });
    if (sig.outcome === OUTCOME.ALREADY) return { done: true, result: { ok: true, message: msg || '今日已签到，无需重复', detail: snippet } };
    if (sig.outcome === OUTCOME.NEED_LOGIN) return definitive('登录已失效，请重新获取 Cookie', sig, snippet);
    if (sig.outcome === OUTCOME.CAPTCHA) return definitive('遇到人机验证，请在浏览器完成验证后重试', sig, snippet);
    if (sig.outcome === OUTCOME.WAF) return definitive('遇到网站安全防护（WAF），请在浏览器完成验证后重试', sig, snippet);
    if (sig.outcome === OUTCOME.RATE_LIMIT) return definitive('请求过于频繁，稍后再试', sig, snippet);
    return { done: false, reason: msg || `status=${j.status != null ? j.status : j.code}` };
  }

  // 非 JSON（可能是登录页 / WAF 页 / 空响应）
  // 注意：HTML 页面里的「已签到」文字不可信（可能是模板/按钮文字），
  // 曾导致没真签到却误报「今日已签到」。非 JSON 响应一律不判为成功/已签，
  // 只认登录失效/验证码/WAF 这类明确负面信号，其余按「未识别」继续试下一个 action。
  const sig = classifySignal(text, { status });
  if (sig.outcome === OUTCOME.NEED_LOGIN || /wp-login|请先登录|登录后查看/i.test(text)) {
    return definitive('登录已失效，请重新获取 Cookie', sig, snippet);
  }
  if (sig.outcome === OUTCOME.CAPTCHA) return definitive('遇到人机验证，请在浏览器完成验证后重试', sig, snippet);
  if (sig.outcome === OUTCOME.WAF) return definitive('遇到网站安全防护（WAF），请在浏览器完成验证后重试', sig, snippet);
  return { done: false, reason: `响应不是 JSON（HTTP ${status}）：${text.replace(/\s+/g, ' ').slice(0, 120)}` };
}

function definitive(message, sig, detail) {
  return { done: true, result: { ok: false, message, outcome: (sig && sig.outcome) || '', detail } };
}

// 「请求根本没发出去」和「发出去了但没等到回包」必须分开——两者后续该做的事完全相反：
//   · 连不上（fetch failed / DNS 解析不了 / 连接被拒 / TLS 握手失败）→ 这条出口连站点都到不了，
//     换个出口重试是对的，而且肯定不会「签两次」（上一次压根没发出去）；
//   · 没等到回包（超时）→ 请求很可能已经送达（签到可能已生效），换出口重发就有可能签两次。
// 线上 2026-09-28：糊涂鳄被固定走「CF 网络」时，CF 出口对 hutue.cn 就是这个连不上/被拦的情形，
// 以前一律归成「结果未知」，于是那一行永远只显示「结果未知」，明明换条路就能签上。
function couldNotSend(em) {
  const m = String(em || '');
  if (!m) return false;
  if (/超时|timeout|timed out|没等到回包|没收到回包/i.test(m)) return false;
  return /fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|getaddrinfo|ENETUNREACH|socket|handshake|certificate|SSL|TLS|network|连不上|无法连接|连接被拒/i.test(m);
}

// 这条出口到不了本站：按「出口不通」报（runner 会自动换另一条路线重试）。
function routeDead(action, em, trace) {
  const e = new Error(`${action}：连不上站点（${String(em).slice(0, 120)}）—— 这条网络出口到不了本站，不是在站点那边签到失败`);
  e.outcome = 'relay';
  e.detail = detailOf(action, '', trace);
  return e;
}

// 空响应（既没状态码、也没正文）是**链路**的空白，不是站点对接口的回答。
//
// 【踩坑 2026-09-28 线上】“本地网络”中继那一天把响应丢了，面板只看到「（无响应）」，
// 本模块于是把 user_qiandao / xb_user_qiandao / … 五个候选接口一个个判成
// 「站点不认这个接口」，最后写出一句「签到失败：… 站点不认这个接口」——
// 站点明明一直在正常回答，用户看到的却是「本地网络签到失败」。
// 现在碰到空响应立即停下，并把「这不是站点的问题」和可执行的下一步说清楚。
function emptyResponse(what) {
  // 建议部分不写死另一条路线：站点模块看不到用户固定了哪条、扩展在不在线。
  // （写死「切回自动就会改走 CF 直连」在「本来就固定着 CF 直连」的账号上是误导。）
  // 具体该换哪条、为什么换不过去，由 runner 拿到全局信息后补在反馈末尾。
  const e = new Error(
    `${what}没有带回任何响应（空响应）。这多半是链路问题（例如「本地网络」中继没把响应交回来），不是站点不认这个接口；`
    + '可确认浏览器扩展已升级到最新版并重新加载，或在「执行方式」里换另一条路线重试。'
  );
  e.outcome = 'relay'; // 网络层失败 → 自动模式会换另一条路线重试
  return e;
}

// 「站点不认这个接口」的判定 —— 只有这种情况才允许换下一个 action。
//
// 为什么必须分清：WordPress 对不存在的 action 会**原样返回字符串 "0"**，插件也可能回
// 「无效的请求」。这种才可以换接口试。反过来，只要站点给出了真正的业务回答
// （哪怕是「签到失败：xxx」「还没绑定手机号」），就说明这个接口是真的 ——
// 那时再换一个奖励不同的接口去「试成功」，用户看到的就是「面板说签好了，网站却还能再签」。
export function isUnknownAction(raw) {
  const t = String(raw == null ? '' : raw).trim();
  if (!t) return true;
  if (t === '0' || t === '-1' || t === 'null' || t === 'false') return true;
  if (/^(无效的请求|无效请求|非法请求|invalid|unknown|bad request)/i.test(t)) return true;
  const j = tryJson(t);
  if (j && typeof j === 'object') {
    const msg = String(j.msg || j.message || j.error || (j.data && (j.data.msg || j.data.message)) || '');
    const okFlag =
      j.status == 1 || j.code == 1 || j.ret == 1 || j.success === true ||
      (j.data && (j.data.status == 1 || j.data.success === true || j.data.code == 1));
    if (okFlag) return false;
    if (/无效的请求|无效请求|非法请求|不存在|未知的|invalid|unknown action|not found/i.test(msg)) return true;
    if (!msg) return true;
    return false; // 有业务文字回答 → 接口是存在的，不该再换接口
  }
  return false; // 非 JSON 的非空响应（HTML/文本）→ 当作「有回答」
}

// 「网站返回」那一行的写法：网站原话在前（面板主文案直接用它），
// 后面跟上「打的是哪个接口」—— 这样「面板到底有没有真打通」在面板上就能自查，不用猜。
function detailOf(action, raw, trace) {
  const text = String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim();
  const head = text ? `网站返回：${text.slice(0, 300)}` : '网站返回：（无响应）';
  const meta = action ? ` · 接口 ${action}` : '';
  // 「已忽略…」= 这份 Cookie 里剔掉了别的站的会话（同品牌两个独立站最常见的坑），
  // 属于要让人看见的一条事实，和超时/不认接口一个待遇。
  const extra = (trace || []).filter((x) => /超时|不认|已忽略/.test(x)).slice(-2).join('；');
  return head + meta + (extra ? ` · ${extra.slice(0, 160)}` : '');
}

export const hutue = {
  id: 'hutue',
  name: '糊涂鳄',
  desc: '糊涂鳄资源站每日签到（WordPress/RiPro 悬浮窗）。支持 hutue.cn 与 dj.hutue.cn（两站独立），自动发现签到接口、按域名选出口。',
  // 默认走 CF 直连。
  //
  // 【实测依据，2026-09-28】本站从 Cloudflare 机房 IP 直连完全正常：
  //   首页 200（84KB 登录态首页）、签到接口 POST /wp-admin/admin-ajax.php {action:user_qiandao}
  //   0.4 秒就回 {"status":"0","msg":"今日已签到，请明日再来"}。
  // 反倒是「扩展在线就一律走本地中继」的旧策略害了它：中继是单飞执行，
  // 前面吾爱破解的浏览器工单占掉将近一分钟，它就被挤成「中继执行超时（45秒）」，
  // 面板记「失败」而网站其实早就签好了 —— 用户看到的就是「面板跟网站对不上」。
  // 现在 runner 的自动模式是「server 站先直连、走不通才换本地网络」（见 runner.js 的 isRouteFailure）。
  execution: 'server',
  // 但同一个模块管着两个**独立站点**，它们的「CF 出口能不能用」并不一样：
  //   · dj.hutue.cn：从 CF 直连完全正常（首页 200、签到接口 0.4 秒回）
  //   · hutue.cn   ：2026-09-28 实测从 CF 机房 IP 连**首页**都被站点 WAF 回 `error code: 1002`
  //                  （`/api/http-test` 实测），而本机 IP 直连签到接口 178ms 就正常回答。
  // 所以默认路线按域名给：hutue.cn 默认走「本地网络」，dj 默认走「CF 直连」。
  // 手动切换仍然优先，自动模式下走不通也会自动换另一条。
  executionFor(siteUrl) {
    const h = String(siteUrl || '').toLowerCase();
    if (/hutue\.cn/.test(h) && !/dj\.hutue\.cn/.test(h)) return 'relay';
    return 'server';
  },
  domain: 'dj.hutue.cn', // 默认域名；实际按账号的 site_url 动态决定
  // 本站「一天」按 UTC 算（= 北京时间 08:00 重置），不是面板时区的 00:00。
  // 依据（2026-09-28 线上日志）：9/28 00:33 / 07:04 / 07:56（北京）三次站点都回
  // 「今日已签到，请明日再来」，而这三个时刻都还在 UTC 9/27 之内；9/28 08:05（北京，
  // 刚进 UTC 9/28）用户手动点签到就成功领到 5 晶石。
  // 注意：这个日界是从站点的「签到锁」行为推出来的（WordPress 默认时区就是 UTC）。
  // 万一某个站实际按北京时间算，最坏后果也只是 00:00–08:00 这 8 小时面板先显示「未签到」，
  // 不影响签到本身（建议签到时间设在 08:05 之后，两种日界都能签得上）。
  dayTz: 'UTC',
  fields: [
    {
      key: 'site_url',
      label: '站点地址',
      type: 'text',
      required: true,
      placeholder: 'https://dj.hutue.cn 或 https://hutue.cn',
    },
    {
      key: 'username',
      label: '账号（邮箱）',
      type: 'text',
      required: false,
      placeholder: '填上它，站点登录态过期时面板会自己重新登录',
    },
    {
      key: 'password',
      label: '密码',
      type: 'password',
      required: false,
      placeholder: '只存在你自己的 D1 里（加密保存），用途只有「自动重新登录」',
    },
    {
      key: 'cookie',
      label: 'Cookie',
      type: 'textarea',
      // 不再是必填：本站的 wp-login 会话只活一两天，靠一份 Cookie 长期运行本来就不可能。
      // 填了账号密码时面板会自动登录拿新会话（见 run 的说明）。
      required: false,
      placeholder: '浏览器登录站点后，用扩展「一键复制全部信息」获取（也可以留空，填账号密码让面板自己登录）',
    },
    {
      key: 'user_agent',
      label: 'User-Agent（可选）',
      type: 'text',
      required: false,
      placeholder: '留空用默认；扩展会自动抓取',
    },
  ],
  tips: '先在浏览器中登录站点（首页右侧会出现「打卡签到」悬浮窗，每天 5 晶石）→ 用扩展「一键发送到签到面板」→ 面板会自动识别并保存。面板认的是悬浮窗按钮真正绑定的接口（RiPro 的 user_qiandao）；站点还有另一个长得很像的「会员中心首页签到」（只给 1 积分），不会被误用。hutue.cn 和 dj.hutue.cn 是两个独立站点，需要分别添加账号。注意：本站按 UTC 计日，北京时间 08:00 才算它新的一天——签到时间建议设在 08:05 之后。执行路线按域名自动给：dj.hutue.cn 默认走「CF 网络」（实测 0.4 秒返回，比借本机网络更快更稳）；hutue.cn 默认走「本地网络」。hutue.cn 在 CF 出口是**整站**被拦的（2026-09-29 复核：从 CF 机房 IP 不仅首页 200 不到，连 /robots.txt、/wp-admin/admin-ajax.php 都回 `error code: 1002`），所以它只能借你的本机网络 —— 签到期间扩展会在后台开一个 hutue.cn 的页面代发请求（不会抢焦点，同一个域名只开一个、用完 45 秒后自动关）。两条路线走不通时都会自动换另一条，「执行方式」保持「自动」即可。强烈建议把「账号」和「密码」也填上：本站的 WordPress 登录会话只活一两天（实测 2026-09-29：hutue.cn 的会话到点后站点一直回「请登录后签到」），填了账号密码后会话过期时面板会自己重新登录，不再需要你手动复制 Cookie。另外，两个站的登录态各有一套，用扩展复制时容易把两套会话混在一串里（面板会自动只留本站那几段，并在反馈里说清楚），遇到「登录已失效」时先看反馈里的「Cookie 体检」那一句。',

  // 站点的 wp-login 登录会话只活一两天（实测 2026-09-29：hutue.cn 的会话 11:05 到期、
  // 之后站点一直回「请登录后签到」），所以「会话过期」在这两个站是常态，不是异常。
  // 只要账号里存了用户名 + 密码，面板就自己重新登录一次再签。
  //
  // 登录用哪条网络由 runner 决定（本模块只用 globalThis.fetch，换成中继就是借本地网络）。
  async run(creds, ctx = {}) {
    const base = normBase(creds.site_url);
    if (!base) throw new Error('站点地址未配置');
    let c = { ...creds };
    const username = String(c.username || '').trim();
    const password = String(c.password || '');
    const canLogin = !!username && !!password;
    const throttleMs = 10 * 60 * 1000;
    const lastLogin = Number((ctx.meta && ctx.meta.wp_login_at) || 0) || 0;
    const throttled = lastLogin > 0 && Date.now() - lastLogin < throttleMs;

    // 自己登录一次，成功就把新会话并进 creds（直连路线能读到 Set-Cookie，回写 D1；
    // 本地网络路线读不到，但浏览器自己已经种下了，后续请求天然带着它）。
    let droppedByLogin = [];
    const doLogin = async () => {
      const r = await wpLogin({ base, username, password, ua: c.user_agent });
      if (ctx.meta) ctx.meta.wp_login_at = Date.now();
      if (r.ok) {
        if (r.cookie) {
          c.cookie = mergeCookies(String(c.cookie || ''), r.cookie);
          // 顺手把不属于本站的旧会话剔掉（同品牌两个站混在一串里的情况）
          const sp = splitCookieBySite(c.cookie, base);
          if (sp.dropped.length) { c.cookie = sp.cookie; droppedByLogin = sp.dropped; }
          await saveCreds(ctx, c);
        }
      }
      return r;
    };

    // ① 面板里那份 Cookie 已经明确过期（或根本不属于本站）→ 先登录，省掉一次注定被拒的签到请求。
    //    只在「串里确实有 WordPress 会话、但没有本站可用的」时才走这条，认不出来就照常先试签到。
    //    另外：连 Cookie 都没填（只填了账号密码）时也直接登录 —— 这种账号就是靠密码吃饭的。
    const split0 = splitCookieBySite(String(c.cookie || ''), base);
    const noCookieAtAll = !String(c.cookie || '').trim();
    let loginNote = '';
    if (canLogin && (split0.needsLogin || noCookieAtAll) && !throttled) {
      const r = await doLogin();
      if (!r.ok) {
        const e = new Error('登录已失效，且面板用账号密码自动重新登录也没成功：' + r.message);
        e.outcome = OUTCOME.NEED_LOGIN;
        throw enrichWithCookieDiag(e, c, base);
      }
      loginNote = '面板已用账号密码重新登录并续上会话'
        + (droppedByLogin.length ? '（已剔除属于其它域名的旧会话：' + droppedByLogin.join('、') + '）' : '');
    }

    try {
      const res = await signinOnce(c, ctx);
      return loginNote ? { ...res, detail: [res.detail, loginNote].filter(Boolean).join(' · ') } : res;
    } catch (e) {
      if (!e || e.outcome !== OUTCOME.NEED_LOGIN) throw e;
      // ② 站点自己回了「请登录后签到」→ 再给自己一次机会（例如会话是在本次运行前刚好过期的）
      if (!canLogin || throttled) throw enrichWithCookieDiag(e, c, base, canLogin ? '' : '这个账号没有存账号密码，面板没法自己重新登录 —— 在「编辑」里补上账号和密码，以后会话过期面板会自己处理。');
      const r = await doLogin();
      if (!r.ok) throw enrichWithCookieDiag(e, c, base, '面板尝试用账号密码自动重新登录，但没成功：' + r.message);
      try {
        const res = await signinOnce(c, ctx);
        return { ...res, detail: [res.detail, '面板已用账号密码重新登录并续上会话'].filter(Boolean).join(' · ') };
      } catch (e2) {
        throw enrichWithCookieDiag(e2, c, base, '面板已用账号密码自动登录成功（会话已续），但签到仍回未登录 —— 请确认这组用户名/密码就是这个站点的账号。');
      }
    }
  },
};

// 把「这份 Cookie 到底能不能被本站认成登录态」写进错误文案。
function enrichWithCookieDiag(e, creds, base, extra) {
  const parts = [String((e && e.message) || e)];
  if (extra) parts.push(extra);
  parts.push('Cookie 体检：' + wpLoginDiagnosis(creds.cookie, base));
  parts.push('说明：hutue.cn 走「本地网络」时，签到用的是浏览器里的登录态（面板这份 Cookie 只是备份），两边任何一个过期都会回「请登录后签到」。');
  const err = new Error(parts.join('｜'));
  err.detail = (e && e.detail) || '';
  err.outcome = (e && e.outcome) || '';
  return err;
}

// 把新拿到的会话回写 D1（拿不到 Set-Cookie 时不用调）
async function saveCreds(ctx, creds) {
  try {
    const { env, db, account } = ctx || {};
    if (!env || !db || !account) return;
    const enc = await encryptJSON(env, db, creds);
    await db.prepare('UPDATE accounts SET creds=?, updated_at=? WHERE id=?')
      .bind(enc, Date.now(), account.id).run();
  } catch {
    /* 回写失败不影响本次签到 */
  }
}

// 真正的一次签到尝试：发现接口 → 打签到接口。
// 登录态相关的判断留给外层 run（它知道有没有账号密码、能不能重新登录）。
async function signinOnce(creds, ctx = {}) {
    const base = normBase(creds.site_url);
    if (!base) throw new Error('站点地址未配置');
    // Cookie 串里可能混着同品牌另一个站的登录会话（hutue.cn / dj.hutue.cn 就会这样）：
    // 只保留本站自己那几段，认不出来就原样保留（见 splitCookieBySite 的安全阀）。
    const split = splitCookieBySite(String(creds.cookie || ''), base);
    const cookie = String(split.cookie || '').trim();
    if (!cookie && !String(creds.username || '').trim()) {
      throw new Error('Cookie 未配置（也可以在「编辑」里填账号和密码，面板会自己登录）');
    }
    // Cookie 可能一份都没有（只填了账号密码）：这时靠本次登录拿到的新会话走完整流程。
    const droppedNote = split.dropped.length ? `已忽略不属于本站的会话 Cookie：${split.dropped.join('、')}` : '';
    const ua = String(creds.user_agent || '').trim() || DEFAULT_UA;

    const headers = {
      'User-Agent': ua,
      Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      Referer: base + '/',
      Cookie: cookie,
    };

    // ---- ① 发现：抓首页，找悬浮窗用的 ajax 入口 / action / nonce ----
    // 优化：如果已记住上次命中的 action，跳过首页抓取（省一次中继往返，首页 HTML 很大很慢），
    // 直接用记住的 action 试；只有记住的 action 失效时才走完整发现流程。
    let ajaxUrl = base + '/wp-admin/admin-ajax.php';
    const seenActions = [];
    const seenRoutes = [];
    let nonce = '';
    const remembered = ctx && ctx.meta && ctx.meta.hutue_action ? String(ctx.meta.hutue_action) : '';
    const rememberedNonce = ctx && ctx.meta && ctx.meta.hutue_use_nonce;
    // 只有记住的 action 且不需要 nonce 时才跳过发现（nonce 是每页刷新的，跳过就拿不到新的）
    let skipDiscovery = !!remembered && !rememberedNonce;
    if (!skipDiscovery) {
    try {
      const res = await fetch(base + '/', { headers });
      const html = await res.text();
      // 首页都读成空的时候别再往下猜了：这只说明这条链路没把响应带回来。
      if (!String(html || '').trim()) throw emptyResponse('站点首页');
      const d = discoverSignin(base, html);
      if (d.ajaxUrl) ajaxUrl = d.ajaxUrl;
      for (const a of d.actions) seenActions.push(a);
      for (const r of d.routes) seenRoutes.push(r);
      nonce = d.nonce;
      // 二次发现：抓主题 JS 文件，从中找签到 action（xb-app.js 这类文件里才有真正的 action 名）
      // 并行抓取，省时间（中继模式下每次都是网络往返）
      const jsUrls = (d.jsUrls || []).slice(0, 2);
      const jsResults = await Promise.allSettled(
        jsUrls.map(async (jsUrl) => {
          const jr = await fetch(jsUrl, { headers });
          return await jr.text();
        })
      );
      const jsButtonActions = []; // 主题 JS 里「按钮真正绑定的 action」，优先级最高
      for (const r of jsResults) {
        if (r.status !== 'fulfilled' || !r.value) continue;
        try {
          const d2 = discoverSignin(base, r.value);
          for (const a of d2.buttonActions || []) {
            if (a && !jsButtonActions.includes(a)) jsButtonActions.push(a);
          }
          for (const a of d2.actions) {
            if (a && !seenActions.includes(a)) seenActions.push(a);
          }
        } catch { /* 解析失败不影响 */ }
      }
      // 按钮绑定的 action 提到最前（已发现的其他 action 依次排后）
      if (jsButtonActions.length) {
        seenActions.splice(0, seenActions.length, ...jsButtonActions, ...seenActions.filter((a) => !jsButtonActions.includes(a)));
      }

      // 首页本身若是验证码/登录页，直接给出明确结论，不再瞎试
      const snippet = '网站返回：' + String(html).replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 240);
      const sig = classifySignal(html, { status: res.status });
      // 只有「页面明显不是正常主题页」时才认作拦截页：
      // 正常首页会加载 /wp-content/themes/... 资源，而验证码/WAF 插页不会。
      // 否则主题里一个叫「滑块」的轮播组件就能把正常签到吓回去。
      const looksLikeThemePage = /wp-content\/(themes|plugins)/i.test(html);
      if (sig.outcome === OUTCOME.CAPTCHA && !looksLikeThemePage) {
        const e = new Error('站点要求人机验证，请在浏览器完成验证后重新获取 Cookie');
        e.outcome = OUTCOME.CAPTCHA;
        e.detail = snippet;
        throw e;
      }
      // 「登录已失效」必须确凿才能下结论。
      // 踩过的坑：RiPro 首页的登录弹窗/内联脚本里就带「请先登录」「登录后查看」「wp-login.php」，
      // 只看这些字样会把刚刚登录的账号误判成 Cookie 失效（实测：新鲜 Cookie 被报失效）。
      // 现在的判据：页面里真的有登录表单（loginform / name=log+name=pwd / form action 指 wp-login.php），
      // 并且没有任何「已登录」痕迹（admin bar / 退出登录 / wp-admin 脚本）。
      const loginForm =
        /id=["']loginform["']/i.test(html) ||
        (/name=["']log["']/i.test(html) && /name=["']pwd["']/i.test(html)) ||
        /<form[^>]+action=["'][^"']*wp-login\.php/i.test(html);
      const loggedInHint = /wpadminbar|wp-admin-bar|action=logout|退出登录/i.test(html);
      if (loginForm && !loggedInHint) {
        const e = new Error('Cookie 已失效，请重新登录后复制新的 Cookie');
        e.outcome = OUTCOME.NEED_LOGIN;
        e.detail = snippet;
        throw e;
      }
    } catch (e) {
      // 只有「明确结论」才中断；普通网络失败继续走兜底 action 尝试
      if (e && e.outcome) throw e;
    }
    } // end if (!skipDiscovery)

    // ---- ② 组装尝试列表 ----
    // 顺序：站点真签到（悬浮窗那个）→ 上次命中的 → 本次页面发现的
    //       → 会员中心那个（只给 1 积分，最后才轮到）→ 其余兜底。
    // 为什么主题 action 永远排第一：踩过的坑——若某个别的插件 action 也返回 status=1，
    // 一旦它先命中就会被记住（hutue_action），以后每次都走它，
    // 网站反馈就变成那个插件的话、奖励也跟本站对不上（实测线上出现过 1 积分 vs 本站 5 积分）。
    // 排在前面不额外花网络请求，所以不跟「跳过首页发现」的优化冲突。
    const ordered = [];
    const push = (a) => { if (a && !ordered.includes(a)) ordered.push(a); };
    for (const a of SITE_ACTIONS) push(a);
    push(remembered);
    for (const a of seenActions) push(a);
    for (const a of LAST_RESORT_ACTIONS) push(a);
    for (const a of FALLBACK_ACTIONS) push(a);

    // 每个 action 先试「不带 nonce」：站点自己的 JS 调签到接口时也不带 nonce
    // （RiPro 的 user_qiandao 就只发 action 一个参数），先带 nonce 反而多打一次、
    // 甚至可能被别的 action 的 nonce 校验撚回。真需要 nonce 的主题会在第二次命中。
    // 跳过发现时（有记住的 action）：按同样顺序先试一遍，失败才走完整流程。
    const attempts = [];
    if (skipDiscovery && remembered) {
      for (const action of ordered.slice(0, 2)) {
        attempts.push({ action, nonce: (action === remembered && rememberedNonce) ? nonce : '' });
      }
    } else {
      for (const action of ordered) {
        attempts.push({ action, nonce: '' });
        if (nonce) attempts.push({ action, nonce });
        if (attempts.length >= MAX_ATTEMPTS) break;
      }
    }

    // ---- ③ 依次尝试：记录每一步「打的是谁、站点回了什么」，成功即返回 ----
    const trace = [];
    const note = (s) => { if (s) trace.push(String(s).slice(0, 200)); };
    if (droppedNote) note(droppedNote);
    let lastReason = '';
    let definitiveFail = null;
    let timeoutFail = ''; // 最后一次「发出去了但没等到回包」
    let usedAction = '';
    let usedRaw = '';

    const sendOnce = async (t) => {
      const body = new URLSearchParams({ action: t.action, ...(t.nonce ? { nonce: t.nonce } : {}) });
      const res = await fetch(ajaxUrl, {
        method: 'POST',
        headers: {
          ...headers,
          Accept: 'application/json, text/plain, */*',
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'X-Requested-With': 'XMLHttpRequest',
          Referer: base + '/',
        },
        body: body.toString(),
      });
      return { status: res.status, raw: await res.text() };
    };

    for (const t of attempts.slice(0, MAX_ATTEMPTS)) {
      timeoutFail = '';
      let raw = '';
      let status = 0;
      try {
        const r0 = await sendOnce(t);
        status = r0.status;
        raw = r0.raw;
      } catch (e) {
        const em = String((e && e.message) || e);
        // 连不上：没发出去的请求重试一次也一样，直接按「这条出口不通」上报，
        // 交给 runner 换另一条路线（固定路线时也会临时兜底）。
        if (couldNotSend(em)) throw routeDead(t.action, em, trace);
        // 超时只说明**我们没等到回包**，请求很可能已经送达站点（站点可能已经签成功了）。
        // 所以先重打一次同一个 action：上一次若真生效，站点这次会直接回「今日已签到」。
        note(`${t.action}：首次请求超时（${em.slice(0, 50)}），重试一次以确认到底送达没有`);
        try {
          await new Promise((r) => setTimeout(r, 1200));
          const r1 = await sendOnce(t);
          status = r1.status;
          raw = r1.raw;
        } catch (e2) {
          const em2 = String((e2 && e2.message) || e2);
          if (couldNotSend(em2)) throw routeDead(t.action, em2, trace);
          timeoutFail = `请求已发出但没等到回包（${em2.slice(0, 100)}）`;
          lastReason = `${t.action}：${timeoutFail}`;
          note(`${t.action}：重试仍无回包`);
          continue;
        }
      }

      usedAction = t.action;
      usedRaw = raw;
      // 空响应：不是「站点不认这个接口」，是这条链路没把响应带回来。
      // 立刻停下 —— 换接口重打 5 次不会得到别的结果，只会白花用户的网络往返、
      // 还给出错误的结论（详见 emptyResponse 的说明）。
      if (!String(raw == null ? '' : raw).trim() && (!status || status <= 0)) {
        const e = emptyResponse(`${t.action} 的请求`);
        e.detail = detailOf(t.action, raw, trace);
        throw e;
      }
      const verdict = judgeSigninResponse(raw, status);
      if (verdict.done) {
        const r = verdict.result;
        if (r.ok) {
          // 记住命中的 action + 是否要带 nonce，下次优先，减少盲试
          if (ctx && ctx.meta) {
            ctx.meta.hutue_action = t.action;
            ctx.meta.hutue_use_nonce = !!t.nonce;
          }
          const fallbackWarn = LAST_RESORT_ACTIONS.includes(t.action)
            ? ' · 注意：本次走的是「会员中心签到」（只给 1 积分），首页悬浮窗那个真签到接口本次不可用'
            : '';
          return { ...r, detail: detailOf(t.action, raw, trace) + fallbackWarn };
        }
        // 明确负面结论（登录失效/验证码/WAF/限流）：与接口无关，换接口也一样，不白试。
        if (!definitiveFail) definitiveFail = r;
        lastReason = `${t.action}：${r.message}`;
        break;
      }
      if (isUnknownAction(raw)) {
        lastReason = `${t.action}：站点不认这个接口`;
        note(`${t.action}：站点不认这个接口（${String(raw || '').replace(/\s+/g, ' ').slice(0, 40)}），继续试下一个`);
        continue;
      }
      // 站点有业务回答但既不是成功也不是已签（例如「签到失败：xx」「还没绑定手机号」）：
      // 这是**这个接口**的真实结论，不再换接口 —— 换成会员中心那个只会得到另一个「签到成功」，
      // 奖励完全不同，用户看到的就是「面板说签好了，网站却还能再签」。
      lastReason = `${t.action}：${verdict.reason}`;
      note(`${t.action}：站点有回答但未识别为成功，不再换接口`);
      break;
    }

    if (definitiveFail) {
      const err = new Error(definitiveFail.message);
      err.detail = detailOf(usedAction, usedRaw, trace) || definitiveFail.detail;
      err.outcome = definitiveFail.outcome;
      throw err;
    }
    if (timeoutFail) {
      // 结果未知：不冒充成功，也不冤枉网站为失败（runner 会记为「结果未知」，
      // 并让定时器稍后自动补跑一次复核）。
      const err = new Error(`签到结果未知：${timeoutFail}。请求可能已经送达网站（签到可能已生效），也可能没有；稍后会自动复核，若已签到网站会直接回「今日已签到」。`);
      err.outcome = 'relay-unknown';
      err.detail = detailOf(usedAction, usedRaw, trace);
      throw err;
    }
    const planned = attempts.slice(0, MAX_ATTEMPTS).map((p) => p.action);
    const triedHint = planned.length ? `（已试 ${planned.join('、')}）` : '';
    const routeHint = seenRoutes.length ? `（页面里发现 REST 路由 ${seenRoutes[0]}，该站可能改用 REST 签到，请告知开发者）` : '';
    const err = new Error('签到失败：' + (lastReason || '未识别到成功标识') + triedHint + routeHint);
    err.detail = detailOf(usedAction, usedRaw, trace);
    throw err;
}
