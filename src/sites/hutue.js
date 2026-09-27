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

const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

// 兜底 action 名（发现阶段没找到线索时才用）。
// 顺序按实测命中率排：dj.hutue.cn / hutue.cn 用的是 xb-child 子主题，
// 签到按钮 <a class="click-qiandao zzhuti_qd_1"> 的处理器在 xb-app.js：
//   $.post(caozhuti.ajaxurl, { action: "xb_user_qiandao" }, ...) → 1 == n.status 为成功
// 首页内联脚本里虽然有 ajaxurl，但不会写出 action 名，所以这个兜底顺序很重要（少打一次无用请求）。
// 站点主题自己一定有的 action：永远放最高优先级，不靠猜也不靠记。
const SITE_ACTIONS = ['xb_user_qiandao'];
// 兜底 action 名（发现阶段与主题 action 都没命中时才用）
const FALLBACK_ACTIONS = ['user_qiandao', 'qiandao', 'user_checkin'];
const MAX_ATTEMPTS = 4; // 最多打几次，避免把站点打烦（中继模式下每次尝试都是一次网络往返，要省着用）

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

// ---------- ① 从首页发现签到接口 ----------
// 返回 { ajaxUrl, actions: [], routes: [], nonce, jsUrls: [] }
// jsUrls: 页面引用的主题 JS 文件（签到 action 可能藏在其中，如 xb-app.js）
export function discoverSignin(base, html) {
  const out = { ajaxUrl: '', actions: [], routes: [], nonce: '', jsUrls: [] };

  const ajax = String(html || '').match(/["']?(?:ajaxurl|ajax_url|adminAjax)["']?\s*[:=]\s*["']([^"']+)["']/i);
  if (ajax) out.ajaxUrl = absolutize(ajax[1], base);

  // 收集主题相关的外部 JS 文件地址（签到 action 可能藏在主题 JS 里）
  const scriptRe = /<script[^>]+src=["']([^"']+\.js[^"']*)["']/gi;
  let sm;
  while ((sm = scriptRe.exec(String(html || ''))) !== null) {
    const abs = absolutize(sm[1], base);
    if (abs && /wp-content\/(themes|plugins)/i.test(abs) && !out.jsUrls.includes(abs)) {
      out.jsUrls.push(abs);
      if (out.jsUrls.length >= 5) break;
    }
  }

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
  const sig = classifySignal(text, { status });
  if (sig.outcome === OUTCOME.ALREADY) return { done: true, result: { ok: true, message: '今日已签到，无需重复', detail: snippet } };
  if (sig.outcome === OUTCOME.SUCCESS) {
    return { done: true, result: { ok: true, message: '签到成功：' + text.replace(/\s+/g, ' ').slice(0, 120), detail: snippet } };
  }
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

export const hutue = {
  id: 'hutue',
  name: '糊涂鳄',
  desc: '糊涂鳄资源站每日签到（WordPress/RiPro 悬浮窗）。支持 hutue.cn 与 dj.hutue.cn，自动发现签到接口。',
  execution: 'server', // 默认云端执行（用面板保存的 Cookie）；扩展在线时自动走中继用用户网络
  domain: 'dj.hutue.cn', // 默认域名；实际按账号的 site_url 动态决定
  fields: [
    {
      key: 'site_url',
      label: '站点地址',
      type: 'text',
      required: true,
      placeholder: 'https://dj.hutue.cn 或 https://hutue.cn',
    },
    {
      key: 'cookie',
      label: 'Cookie',
      type: 'textarea',
      required: true,
      placeholder: '浏览器登录站点后，用扩展「一键复制全部信息」获取',
    },
    {
      key: 'user_agent',
      label: 'User-Agent（可选）',
      type: 'text',
      required: false,
      placeholder: '留空用默认；扩展会自动抓取',
    },
  ],
  tips: '先在浏览器中登录站点（右侧会出现签到悬浮窗）→ 用扩展「一键发送到签到面板」→ 面板会自动识别并保存。面板会自动从站点页面里发现悬浮窗真正使用的签到接口，主题升级也不易失效。hutue.cn 和 dj.hutue.cn 是两个独立站点，需要分别添加账号。',

  async run(creds, ctx = {}) {
    const base = normBase(creds.site_url);
    if (!base) throw new Error('站点地址未配置');
    const cookie = String(creds.cookie || '').trim();
    if (!cookie) throw new Error('Cookie 未配置');
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
      for (const r of jsResults) {
        if (r.status !== 'fulfilled' || !r.value) continue;
        try {
          const d2 = discoverSignin(base, r.value);
          for (const a of d2.actions) {
            if (a && !seenActions.includes(a)) seenActions.push(a);
          }
        } catch { /* 解析失败不影响 */ }
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
    // 顺序：上次命中的（最可信，已验证过）→ 主题自己用的 action → 本次页面发现的 → 其余兜底
    const ordered = [];
    const push = (a) => { if (a && !ordered.includes(a)) ordered.push(a); };
    push(remembered);
    for (const a of SITE_ACTIONS) push(a);
    for (const a of seenActions) push(a);
    for (const a of FALLBACK_ACTIONS) push(a);

    // 同一个 action 的「带 nonce」版本优先，但不做全局排序——
    // 全局按 nonce 排序会把首选 action 的无 nonce 版本挤到很后面。
    // 跳过发现时（有记住的 action）：只用记住的 nonce 设置试一次，失败才走完整流程
    const attempts = [];
    if (skipDiscovery && remembered) {
      attempts.push({ action: remembered, nonce: rememberedNonce ? nonce : '' });
    } else {
      for (const action of ordered) {
        if (nonce) attempts.push({ action, nonce });
        attempts.push({ action, nonce: '' });
        if (attempts.length >= MAX_ATTEMPTS) break;
      }
    }

    // ---- ③ 依次尝试：成功即返回；负面结论记录下来，全部试完再抛最有信息量的那个 ----
    let lastReason = '';
    let definitiveFail = null;
    for (const t of attempts.slice(0, MAX_ATTEMPTS)) {
      let raw = '';
      let status = 0;
      try {
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
        status = res.status;
        raw = await res.text();
      } catch (e) {
        lastReason = `请求 ${t.action} 失败：${String((e && e.message) || e).slice(0, 120)}`;
        continue;
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
          return r;
        }
        if (!definitiveFail) definitiveFail = r;
        lastReason = `${t.action}：${r.message}`;
        continue;
      }
      lastReason = `${t.action}：${verdict.reason}`;
    }

    if (definitiveFail) {
      const err = new Error(definitiveFail.message);
      err.detail = definitiveFail.detail;
      err.outcome = definitiveFail.outcome;
      throw err;
    }
    const routeHint = seenRoutes.length ? `（页面里发现 REST 路由 ${seenRoutes[0]}，该站可能改用 REST 签到，请告知开发者）` : '';
    const triedHint = ordered.length ? `（已试 ${ordered.slice(0, MAX_ATTEMPTS).join('、')}）` : '';
    throw new Error('签到失败：' + (lastReason || '未识别到成功标识') + triedHint + routeHint);
  },
};
