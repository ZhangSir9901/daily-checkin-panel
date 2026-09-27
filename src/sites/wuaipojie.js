// 吾爱破解论坛每日签到（www.52pojie.cn，Discuz 架构）
// 流程（来源：开源签到脚本 xixingchao/qx-scripts 2026-06 版）：
// ① GET https://www.52pojie.cn/portal.php（带完整 Cookie + 与抓包一致的 UA）
//    → 含「今日已签到」等文案 = 今日已签，直接结束
//    → 含 WAF 特征 = 需用户用浏览器重新过安全验证后更新 Cookie
// ② GET https://www.52pojie.cn/home.php?mod=task&do=apply&id=2&referer=%2Fportal.php
//    （Discuz 每日任务领取，无需 formhash；手动跟随最多 3 次 30x 跳转，
//     过程中出现 do=draw 表示进入奖励领取链）
//    → 最终页面含成功文案 = 签到成功
//
// 注意：
// 1. 页面为 GBK 编码，模块同时按 UTF-8 和 GBK 解码后匹配（Worker 与 Node 均支持 TextDecoder('gbk')）。
// 2. 站点有网宿 WAF / 滑块验证，Worker 无法自动绕过：Cookie 必须包含用户
//    用浏览器完成安全验证后的 wzws_cid（及 wzws_sid），且 UA 必须与抓 Cookie 时一致。
// 3. 遇到 WAF 页时模块会明确报错提示重新验证，不会静默失败。

const WAF_MARKS = ['waf_zw_verify', 'WZWS_CONFIRM_PREFIX_LABEL', 'slidercaptcha', '请完成安全验证', '安全检查中', 'Please enable JavaScript'];
const SIGNED_MARKS = ['今日已签到', '今日已签', '已经签到', '已完成', '下期再来', 'ÄúÒÑ', 'ÏÂÆÚÔÙÀ´']; // 后两项为 GBK 被误作 Latin1 解码时的特征
const SUCCESS_MARKS = ['签到成功', '打卡成功', '恭喜', '获得', '吾爱币', '热心值'];
const LOGIN_MARKS = ['请先登录', '需要先登录', '请登录后'];

async function fetchDualText(url, init) {
  const res = await fetch(url, init);
  const ab = await res.arrayBuffer();
  const bytes = ab instanceof Uint8Array ? ab : new Uint8Array(ab);
  const utf8 = new TextDecoder('utf-8').decode(bytes);
  let gbk = '';
  try { gbk = new TextDecoder('gbk').decode(bytes); } catch { /* 环境不支持则忽略 */ }
  return { res, utf8, gbk };
}

function has(texts, marks) {
  const all = texts.utf8 + '\n' + texts.gbk;
  return marks.some((m) => all.includes(m));
}

function assertNoWaf(texts) {
  if (has(texts, WAF_MARKS)) {
    throw new Error('遇到安全验证（WAF）：请用浏览器打开 www.52pojie.cn 完成滑块/安全验证，然后重新复制完整 Cookie（含 wzws_cid）到面板');
  }
}

export const wuaipojie = {
  id: 'wuaipojie',
  name: '吾爱破解',
  desc: '吾爱破解论坛每日签到（Discuz 任务）。Cookie 方式，需先用浏览器过安全验证，UA 须与抓包时一致。',
  execution: 'browser', // 默认执行模式：server=云端执行，browser=浏览器扩展执行（用户网络）
  domain: 'www.52pojie.cn', // 浏览器执行时的目标域名
  // 浏览器端签到脚本：在用户浏览器中运行，自动携带登录 Cookie，使用用户网络（无 WAF）
  // 入参 params：{}；返回 { ok, message }
  browserScript: `async (params) => {
    const base = 'https://www.52pojie.cn';
    const WAF = ['waf_zw_verify', 'WZWS_CONFIRM_PREFIX_LABEL', 'slidercaptcha', '请完成安全验证', '安全检查中'];
    const isWaf = (t) => WAF.some((m) => t.includes(m));
    // 带超时的 fetch：WAF 有时会把连接挂起不返回，避免无限等待
    const fetchT = async (url, init, ms) => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), ms || 20000);
      try { return await fetch(url, Object.assign({}, init, { signal: ctrl.signal })); }
      finally { clearTimeout(timer); }
    };
    // ① 检查是否已签到
    let portalResp;
    try {
      portalResp = await fetchT(base + '/portal.php', { credentials: 'include' }, 20000);
    } catch (e) {
      return { ok: false, message: e.name === 'AbortError' ? '请求超时（20秒）：网络或 WAF 拦截' : '网络请求失败：' + (e.message || 'fetch 异常') };
    }
    const portalText = await portalResp.text();
    if (isWaf(portalText)) return { ok: false, message: '遇到安全验证（WAF）：请在浏览器中打开 www.52pojie.cn 完成验证后重试' };
    if (/今日已签到/.test(portalText)) return { ok: true, message: '今日已签到，无需重复' };
    if (/请先登录|member.php\\?mod=logging/.test(portalText) && !/退出/.test(portalText)) {
      return { ok: false, message: '登录已失效，请重新获取 Cookie' };
    }
    // ② 执行签到
    let signResp;
    try {
      signResp = await fetchT(base + '/home.php?mod=task&do=apply&id=2&referer=%2Fportal.php', {
        credentials: 'include',
        headers: { 'Referer': base + '/portal.php' },
      }, 20000);
    } catch (e) {
      return { ok: false, message: e.name === 'AbortError' ? '签到请求超时（20秒）：网络或 WAF 拦截' : '签到请求失败：' + (e.message || 'fetch 异常') };
    }
    const text = await signResp.text();
    if (isWaf(text)) return { ok: false, message: '签到时遇到安全验证（WAF）：请在浏览器中完成验证后重试' };
    if (/签到成功|打卡成功|恭喜|获得.*吾爱币/.test(text)) return { ok: true, message: '签到成功' };
    if (/今日已签到|已经签到|下期再来/.test(text)) return { ok: true, message: '今日已签到，无需重复' };
    if (/请先登录/.test(text)) return { ok: false, message: '登录已失效，请重新获取 Cookie' };
    return { ok: false, message: '签到失败：未识别到成功标识（HTTP ' + signResp.status + '）' };
  }`,
  fields: [
    {
      key: 'cookie',
      label: 'Cookie',
      type: 'textarea',
      required: true,
      placeholder: '浏览器完成安全验证并登录 www.52pojie.cn 后，F12 → 网络 → 任一请求 → 复制请求头 Cookie（含 wzws_cid）',
    },
    {
      key: 'user_agent',
      label: 'User-Agent',
      type: 'text',
      required: true,
      placeholder: '必须与抓 Cookie 时的浏览器完全一致，否则会被 WAF 拦截',
    },
  ],
  tips: '关键：① 先用浏览器打开 www.52pojie.cn，完成滑块/安全验证并登录；② F12 复制完整 Cookie（必须含 wzws_cid，有时还有 wzws_sid）；③ User-Agent 填抓包浏览器的完整 UA，必须一致。Cookie 遇到 WAF 失效时面板会明确提示，重新用浏览器验证一次并更新 Cookie 即可。',

  async run(creds, ctx) {
    const cookie = String(creds.cookie || '').trim();
    const ua = String(creds.user_agent || '').trim();
    if (!cookie) throw new Error('Cookie 未配置');
    if (!ua) throw new Error('User-Agent 未配置（必须与抓 Cookie 时的浏览器一致）');

    const baseHeaders = {
      'User-Agent': ua,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      Referer: 'https://www.52pojie.cn/portal.php',
      Cookie: cookie,
    };

    // ① 预检首页
    // 注：中继模式下 runner.js 会透明替换 global fetch，站点代码无需改动
    const home = await fetchDualText('https://www.52pojie.cn/portal.php', { headers: baseHeaders });
    assertNoWaf(home);
    if (has(home, SIGNED_MARKS)) {
      return { ok: true, message: '今日已签到，无需重复' };
    }
    if (has(home, LOGIN_MARKS) || (/mod=logging/i.test(home.utf8) && !/mod=space/i.test(home.utf8))) {
      throw new Error('Cookie 已失效，请重新登录后复制新的 Cookie');
    }

    // ② 签到（手动跟随重定向，最多 3 跳）
    let url = 'https://www.52pojie.cn/home.php?mod=task&do=apply&id=2&referer=%2Fportal.php';
    let final = null;
    // 中继模式下无法使用 redirect:'manual'（opaqueredirect 响应头不可读），改用 follow 让浏览器自动跟随
    const redirectMode = ctx.relayDb ? 'follow' : 'manual';
    for (let i = 0; i < 4; i++) {
      const { res, utf8, gbk } = await fetchDualText(url, { headers: baseHeaders, redirect: redirectMode });
      assertNoWaf({ utf8, gbk });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location') || res.headers.get('Location');
        if (!loc) throw new Error('签到失败：重定向无 Location');
        url = /^https?:\/\//i.test(loc) ? loc : 'https://www.52pojie.cn/' + String(loc).replace(/^\/+/, '');
        continue;
      }
      final = { utf8, gbk, status: res.status };
      break;
    }
    if (!final) throw new Error('签到失败：重定向次数过多');

    if (has(final, SUCCESS_MARKS)) {
      return { ok: true, message: '签到成功' };
    }
    if (has(final, SIGNED_MARKS)) {
      return { ok: true, message: '今日已签到，无需重复' };
    }
    if (has(final, LOGIN_MARKS)) {
      throw new Error('Cookie 已失效，请重新登录后复制新的 Cookie');
    }
    throw new Error('签到失败：未识别到成功标识，' + final.utf8.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 160));
  },
};
