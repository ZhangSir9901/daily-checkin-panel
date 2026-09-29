// 站点自动识别（detect.js）
// 扩展在「一键复制 / 发送到面板」采集 Cookie 的同时，给当前页面做一次指纹，
// 判定站点类型后随 payload 发给面板。面板收到高置信结果就直接用，
// 不再让人手动选站点（人工选容易点错；V2Board 这类无 Cookie 字段的站点以前甚至选不到）。
//
// 两部分：
//  - collectPageFingerprint：在页面里执行（经 chrome.scripting.executeScript 注入，
//    MV3 允许），只取判断够用的字段，不把整页 HTML 传回来。
//  - detectSite：在 popup 里执行的纯函数。popup 手里有完整 Cookie（含 HttpOnly）、
//    localStorage 和域名，比页面里看得全，所以判定放这里。
// 两个函数都不依赖 chrome.*，方便在 Node 里单测。

'use strict';

// 在页面里执行，返回指纹
function collectPageFingerprint() {
  var html = '';
  try { html = (document.documentElement && document.documentElement.outerHTML) || ''; } catch (e) { /* 忽略 */ }
  var lsKeys = [];
  try {
    for (var i = 0; i < localStorage.length && i < 200; i++) {
      var k = localStorage.key(i);
      if (k) lsKeys.push(k);
    }
  } catch (e) { /* 忽略 */ }
  return {
    title: String((typeof document !== 'undefined' && document.title) || ''),
    path: String((typeof location !== 'undefined' && location.pathname) || ''),
    html: String(html).slice(0, 30000),
    lsKeys: lsKeys,
  };
}

// 判定站点。fp = collectPageFingerprint() 的结果（探针失败可传 null，
// 照样能用 Cookie 名 / localStorage 键 / 域名信号判定）。
// 返回 { site, confidence: 'high'|'medium', reason }，认不出返回 null。
// high = 面板可直接用；medium = 面板只做推荐预选，不自动用。
function detectSite(fp, cookieNames, lsKeys, domain) {
  fp = fp || {};
  var html = String(fp.html || '');
  var path = String(fp.path || '');
  var names = Array.isArray(cookieNames) ? cookieNames : [];
  var d = String(domain || '').toLowerCase();
  var ls = {};
  (Array.isArray(lsKeys) ? lsKeys : []).forEach(function (k) { ls[k] = 1; });
  var hasCookie = function (re) {
    return names.some(function (n) { return re.test(String(n)); });
  };

  // 1) Akile：localStorage 里有 akile-token（它的登录态全靠这个，Cookie 里没有）
  if (ls['akile-token']) {
    return { site: 'akile', confidence: 'high', reason: '页面 localStorage 里有 akile-token' };
  }
  // 2) 糊涂鳄：WordPress 登录 Cookie（RiPro 签到站都是 WordPress）
  if (hasCookie(/^wordpress_logged_in_/)) {
    return { site: 'hutue', confidence: 'high', reason: 'WordPress 登录 Cookie（wordpress_logged_in_）' };
  }
  // 3) Discuz 系：saltkey/auth Cookie。域名能对上就直接定站，对不上暂按通用 Discuz 推荐
  if (hasCookie(/_(saltkey|auth)$/) || hasCookie(/^discuz_uid$/)) {
    if (d.indexOf('52pojie') >= 0) {
      return { site: 'wuaipojie', confidence: 'high', reason: 'Discuz Cookie + 域名含 52pojie' };
    }
    if (d.indexOf('kanxue') >= 0) {
      return { site: 'kanxue', confidence: 'high', reason: 'Discuz Cookie + 域名含 kanxue' };
    }
    return { site: 'misign', confidence: 'medium', reason: 'Discuz 论坛 Cookie（saltkey/auth），域名不在内置站点里，暂按通用 Discuz 推荐' };
  }
  // 4) 域名关键词（和面板 guessSiteByDomain 同口径）
  var kw = [
    ['nodeseek', 'nodeseek'], ['52pojie', 'wuaipojie'], ['kanxue', 'kanxue'],
    ['v2ex', 'v2ex'], ['akile', 'akile'], ['quark', 'quark'],
    ['189.cn', 'cloud189'], ['hutue', 'hutue'],
  ];
  for (var i = 0; i < kw.length; i++) {
    if (d.indexOf(kw[i][0]) >= 0) {
      return { site: kw[i][1], confidence: 'high', reason: '域名含关键词 ' + kw[i][0] };
    }
  }
  // 5) V2Board（69 这类机场站）：页面指纹。登录页实测（69yun69.com/auth/login，2026-09-30）：
  //    - 魔改站常用 metron 主题（/metron-assets-*/），默认主题则是 #app + /assets/
  //    - 接口统一走 /api/v1/ 前缀；登录路由固定 /auth/login
  if (/v2board/i.test(html)) {
    return { site: 'v2board', confidence: 'high', reason: '页面里有 V2Board 标识' };
  }
  if (/\/api\/v1\//.test(html)) {
    return { site: 'v2board', confidence: 'medium', reason: '页面引用了 /api/v1/（V2Board 接口前缀）' };
  }
  if (/metron-assets/i.test(html)) {
    return { site: 'v2board', confidence: 'medium', reason: '页面用了 metron 主题（V2Board 魔改站常用）' };
  }
  if (/^\/auth\/(login|register)/i.test(path)) {
    return { site: 'v2board', confidence: 'medium', reason: '地址是 /auth/login（V2Board 登录路由）' };
  }
  return null;
}

// 展示用：站点 id → 中文名（popup 里显示识别结果用）
var DETECT_SITE_NAMES = {
  akile: 'Akile', hutue: '糊涂鳄', wuaipojie: '吾爱破解', kanxue: '看雪',
  misign: '通用 Discuz', nodeseek: 'NodeSeek', v2ex: 'V2EX', quark: '夸克网盘',
  cloud189: '天翼云盘', v2board: 'V2Board 机场',
};

// Node 单测用；浏览器里 popup.html 用 <script> 直接引入，全局函数照常用
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { collectPageFingerprint, detectSite, DETECT_SITE_NAMES };
}
