// 签到面板 Cookie 助手 - popup.js
// DEFAULT_PANEL_URL 由面板在用户下载时动态注入（替换 https://daily-checkin-panel.guo527029137.workers.dev 占位符），
// 扩展首次打开时自动带出，用户仍可手动修改。
const DEFAULT_PANEL_URL = '__PANEL_URL__';
// API Key 不从下载包里注入：由用户在面板「设置」页复制后手动填入，避免 Key 随文件传播、也方便随时更换。
const $ = (id) => document.getElementById(id);
const status = (msg, cls = '') => { const s = $('status'); s.textContent = msg; s.className = cls; };

let cookies = [];
let domain = '';

// 采集当前标签页的 Cookie，力求“精准而全面”：
// ① 主源 getAll({ url }) —— 与浏览器真正会发给该地址的 Cookie 完全一致
//    （自动考虑 domain 匹配含父域、path、secure、sameSite、是否过期），对任意网站都准。
// ② host-only 兜底 getAll({ domain: hostname })。
// ③ 尝试分区 Cookie（CHIPS），失败则跳过。
// 合并去重（name|domain|path），并按“路径长→域名→名称”排序，尽量贴近浏览器发送顺序。
// 刻意不猜父域（避免把 co.uk / com.cn 这种当成域名，反而混入无关 Cookie）。
async function collectCookies(tab) {
  const bag = new Map();
  const put = (list) => { for (const c of list || []) bag.set(`${c.name}|${c.domain}|${c.path}`, c); };
  let host = '';
  let origin = '';
  try { const u = new URL(tab.url); host = u.hostname; origin = u.origin; } catch { /* 忽略 */ }

  const queries = [];
  if (tab.url) queries.push({ url: tab.url });
  if (host) queries.push({ domain: host });
  if (origin) queries.push({ url: tab.url, partitionKey: { topLevelSite: origin } });

  for (const q of queries) {
    try { put(await chrome.cookies.getAll(q)); } catch { /* 忽略不支持的查询 */ }
  }

  const list = Array.from(bag.values());
  list.sort((a, b) =>
    (b.path || '').length - (a.path || '').length ||
    String(a.domain).localeCompare(String(b.domain)) ||
    String(a.name).localeCompare(String(b.name)));
  return list;
}

// Cookie 概况：Cookie 数 / 域数 / HttpOnly 数 / 会话与持久数 / 最近过期时间
function describeCookies(list) {
  const domains = new Set();
  let httpOnly = 0;
  let session = 0;
  let persistent = 0;
  for (const c of list) {
    domains.add(c.domain || '');
    if (c.httpOnly) httpOnly++;
    if (c.session) session++; else persistent++;
  }
  return { count: list.length, domains: domains.size, httpOnly, session, persistent };
}

async function init() {
  // 读取保存的面板地址和 API Key；没有保存过则用下载时注入的默认地址（面板动态生成 zip 时填入）
  const { panelUrl, apiKey } = await chrome.storage.sync.get(['panelUrl', 'apiKey']);
  const hasDefault = typeof DEFAULT_PANEL_URL !== 'undefined' && DEFAULT_PANEL_URL && DEFAULT_PANEL_URL.startsWith('http');
  if (panelUrl) {
    $('panel-url').value = panelUrl;
  } else if (hasDefault) {
    $('panel-url').value = DEFAULT_PANEL_URL;
    // 自动保存默认地址，避免下次为空
    chrome.storage.sync.set({ panelUrl: DEFAULT_PANEL_URL }).catch(() => {});
  }
  if (apiKey) $('api-key').value = apiKey;

  // 获取当前标签页
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url || !tab.url.startsWith('http')) {
    status('请在目标网站页面使用', 'err');
    return;
  }
  const url = new URL(tab.url);
  domain = url.hostname;
  $('domain').textContent = '当前网站：' + domain;

  // 获取页面真实的 User-Agent（吾爱等站点要求 UA 与 Cookie 配对）
  let pageUA = '';
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => navigator.userAgent,
    });
    pageUA = result || '';
  } catch { /* 忽略，用默认 */ }

  // 精准而全面地抓取 Cookie（与浏览器实际发送的登录态一致）
  cookies = await collectCookies(tab);
  const stat = describeCookies(cookies);

  // 顺带抓 localStorage（部分站点把 token 放这里，如 akile）
  let localStore = {};
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const o = {};
        try { for (let i = 0; i < localStorage.length && i < 200; i++) { const k = localStorage.key(i); if (k) o[k] = String(localStorage.getItem(k) || '').slice(0, 2000); } } catch { /* 忽略 */ }
        return o;
      },
    });
    localStore = result || {};
  } catch { /* 忽略 */ }

  window._pageUA = pageUA;
  window._localStore = localStore;
  const lsCount = Object.keys(localStore).length;
  $('count').textContent = cookies.length + ' 个';
  status(
    cookies.length
      ? `已读取 ${cookies.length} 个 Cookie（${stat.domains} 个域 / ${stat.httpOnly} 个 HttpOnly）` + (lsCount ? ` + ${lsCount} 项 localStorage` : '')
      : '该网站没有 Cookie',
    cookies.length ? 'ok' : 'err'
  );
}

function cookieString() {
  return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
}

function fullPayload() {
  return JSON.stringify({
    domain,
    userAgent: window._pageUA || '',
    cookies: cookieString(),
    // 附带可读的分解信息，面板据此清晰展示：每个 Cookie 的名称/域/是否 HttpOnly
    cookieList: cookies.map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      secure: !!c.secure,
      httpOnly: !!c.httpOnly,
      sameSite: c.sameSite || '',
      session: !!c.session,
      expirationDate: c.expirationDate || null,
    })),
    localStorage: window._localStore || {},
    stats: describeCookies(cookies),
    ts: Date.now(),
  });
}

$('btn-copy').onclick = async () => {
  if (!cookies.length) return status('没有可复制的 Cookie', 'err');
  // 复制完整 JSON：面板粘贴后自动解析出域名、UA、Cookie
  await navigator.clipboard.writeText(fullPayload());
  status(`已复制 ${cookies.length} 个 Cookie + UA，去面板「粘贴扩展内容」粘贴即可`, 'ok');
};

$('btn-send').onclick = async () => {
  if (!cookies.length) return status('没有可发送的 Cookie', 'err');
  let panelUrl = $('panel-url').value.trim().replace(/\/$/, '');
  if (!panelUrl) return status('请先填写签到面板地址', 'err');
  if (!panelUrl.startsWith('http')) panelUrl = 'https://' + panelUrl;
  await chrome.storage.sync.set({ panelUrl });

  // 把 Cookie + UA + 域名编码进 URL hash，面板 JS 读取后自动弹出确认框
  // 用 base64url 编码（+/= 替换为 -_.），避免特殊字符在地址栏被转义或截断
  const b64 = btoa(unescape(encodeURIComponent(fullPayload())));
  const payload = b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  chrome.tabs.create({ url: panelUrl + '#ext-cookies=' + payload });
  status('已打开面板，请在面板中确认保存', 'ok');
};

$('panel-url').oninput = () => {
  chrome.storage.sync.set({ panelUrl: $('panel-url').value.trim().replace(/\/$/, '') });
};

$('api-key').oninput = () => {
  chrome.storage.sync.set({ apiKey: $('api-key').value.trim() });
};

// 兼容旧的 onchange（保留）
$('panel-url').onchange = () => {
  chrome.storage.sync.set({ panelUrl: $('panel-url').value.trim().replace(/\/$/, '') });
};

$('api-key').onchange = () => {
  chrome.storage.sync.set({ apiKey: $('api-key').value.trim() });
};

// 立即开始中继（让后台马上领任务）。
// 后台常驻长轮询（挂起 20 秒），所以这里点一下等于“立刻唤醒”一次，
// 配合面板端的「执行」，签到请求会在 1 秒内被扩展领走，不用再等 alarm 周期。
$('btn-run-now').onclick = async () => {
  try {
    await chrome.runtime.sendMessage({ action: 'runRelayNow' });
    status('已唤醒中继，正在实时接单…去面板点「执行」即可', 'ok');
    chrome.alarms.create('relay-poll', { periodInMinutes: 0.5 });
  } catch (e) {
    status('唤醒失败：' + (e.message || e) + '（可重新加载扩展后重试）', 'err');
  }
};

// 原生页面巡检：不依赖 eval / new Function（MV3 禁止），用于读取网站真实反馈。
async function inspectPageInPopup(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const title = document.title || '';
      const bodyText = (document.body && document.body.innerText) || '';
      const html = document.documentElement ? document.documentElement.innerHTML : '';
      const all = bodyText + '\n' + html;
      const compact = bodyText.replace(/\s+/g, ' ').trim();
      // 1) 人机验证 / 验证码 / WAF：优先判定——这些页面里往往也夹带「签到」字样
      const CAPTCHA = ['验证码', '人机验证', '安全验证', '请完成验证', '滑动验证', '滑块', '智能验证', 'slidercaptcha', 'geetest', '极验', 'recaptcha', 'hcaptcha', 'turnstile', 'cf_chl', 'challenge-platform', 'Just a moment', 'checking your browser', 'turing.captcha.qcloud.com', 'TCaptcha', 'CaptchaAId', 'ibex'];
      if (CAPTCHA.some((m) => all.includes(m))) return { ok: false, message: '遇到人机验证/安全验证（验证码/滑块），需人工验证后重试｜页面：' + title };
      const WAF = ['waf_zw_verify', 'WZWS_CONFIRM_PREFIX_LABEL', 'Access Denied', '403 Forbidden', '请求被拦截'];
      if (WAF.some((m) => all.includes(m))) return { ok: false, message: '遇到网站安全防护（WAF），请在浏览器完成验证后重试｜页面：' + title };
      // 2) 签到成功
      if (/任务已完成|签到成功|打卡成功|签到完毕|签到完成|已连续签到|领取成功|成功领取|恭喜.{0,12}(获得|领到|签到)|获得.{0,10}(鸡腿|积分|金币|铜币|银币|AK|币|空间|MB|GB|M|G)/.test(all)) {
        return { ok: true, message: '签到成功｜' + (compact.slice(0, 120) || title) };
      }
      // 3) 今日已签到（Discuz 重复申请会返回「您已完成过此任务」）
      if (/今日已签到|今天已签到|已经签到|已签到|重复签到|请勿重复|无需重复|下期再来|已完成过此任务|已领取/.test(all)) return { ok: true, message: '今日已签到，无需重复' };
      // 4) 未登录
      if (/需要先登录|请先登录|还未登录|请登录后|登录已失效|登录失效|请重新登录|未登录/.test(all)) return { ok: false, message: '登录已失效，请重新获取 Cookie' };
      return { ok: false, message: '未识别到成功标识｜页面：' + title + '｜' + compact.slice(0, 140) };
    },
  });
  return (results && results[0] && results[0].result) || null;
}

// 尝试执行面板下发的脚本字符串（MV3 下通常失效，失败时回退原生巡检）。
async function runPanelScriptInPopup(tabId, job) {
  const execPromise = chrome.scripting.executeScript({
    target: { tabId },
    func: (scriptStr, params) => {
      const fn = new Function('params', `return (${scriptStr})(params)`);
      return fn(params);
    },
    args: [job.script, job.params || {}],
  });
  const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('脚本执行超时（60秒）')), 60000));
  const results = await Promise.race([execPromise, timeoutPromise]);
  return (results && results[0] && results[0].result) || null;
}

// 在弹窗上下文中执行单个签到任务（复用目标域名标签页，携带用户 Cookie）
// onStep: 步骤回调，用于显示详细进度
async function executeJobInPopup(job, onStep) {
  const startMs = Date.now();
  const step = (msg) => { if (onStep) onStep(msg); };
  let tab = null;
  let created = false;
  try {
    if (!job.domain) throw new Error('任务缺少目标域名');
    step('查找标签页…');
    const tabs = await chrome.tabs.query({ url: `*://${job.domain}/*` });
    if (tabs.length > 0) {
      tab = tabs[0];
      step('复用已有标签页…');
    } else {
      step('打开新标签页…');
      tab = await chrome.tabs.create({ url: `https://${job.domain}/`, active: false });
      created = true;
      step('等待页面加载…');
      await new Promise((resolve) => {
        const listener = (tabId, info) => {
          if (tabId === tab.id && info.status === 'complete') {
            chrome.tabs.onUpdated.removeListener(listener);
            resolve();
          }
        };
        chrome.tabs.onUpdated.addListener(listener);
        setTimeout(resolve, 15000);
      });
    }
    // 如果任务指定了导航 URL（如吾爱破解），先导航到该页面（模拟手动点击），再执行检查脚本
    if (job.navigate_url) {
      step('导航到签到页面…');
      await chrome.tabs.update(tab.id, { url: job.navigate_url });
      step('等待签到页面加载…');
      await new Promise((resolve) => {
        const listener = (tabId, info) => {
          if (tabId === tab.id && info.status === 'complete') {
            chrome.tabs.onUpdated.removeListener(listener);
            resolve();
          }
        };
        chrome.tabs.onUpdated.addListener(listener);
        setTimeout(resolve, 20000);
      });
      // 多等 2 秒，让页面内跳转完成
      await new Promise((r) => setTimeout(r, 2000));
    }
    // MV3 禁止 new Function / eval：有 navigate_url 直接原生巡检，否则先试面板脚本再回退。
    step('读取页面结果…');
    let result = null;
    if (!job.navigate_url && job.script) {
      try { result = await runPanelScriptInPopup(tab.id, job); } catch { result = null; }
    }
    if (!result) result = await inspectPageInPopup(tab.id);
    if (!result) throw new Error('无法读取页面内容（标签页可能已关闭或被重定向）');
    step('解析结果…');
    return {
      status: result.ok ? 'ok' : 'fail',
      message: String(result.message || (result.ok ? '签到成功' : '签到失败')),
      durationMs: Date.now() - startMs,
    };
  } catch (e) {
    return { status: 'fail', message: '浏览器执行失败：' + (e.message || e), durationMs: Date.now() - startMs };
  } finally {
    // 只关闭自己新建的标签页（复用的保留）
    if (created && tab && tab.id) {
      chrome.tabs.remove(tab.id).catch(() => {});
    }
  }
}

// 面板连接检查：验证面板地址和 API Key 是否可用
$('btn-check-conn').onclick = async () => {
  status('正在检查面板连接…', '');
  try {
    let panelUrl = $('panel-url').value.trim().replace(/\/$/, '');
    if (!panelUrl) return status('请先填写签到面板地址', 'err');
    if (!panelUrl.startsWith('http')) panelUrl = 'https://' + panelUrl;
    const apiKey = $('api-key').value.trim();
    if (!apiKey) return status('请先填写 API Key（面板设置页获取）', 'err');

    // ① 检查面板是否可访问（用专用 ping 接口，不消费任务）
    let resp;
    try {
      resp = await fetch(panelUrl + '/api/external/ping', {
        headers: { 'X-Api-Key': apiKey },
      });
    } catch (e) {
      return status('连接失败：面板地址无法访问（' + (e.message || '网络错误') + '）', 'err');
    }
    // ② 检查 API Key 是否有效
    if (resp.status === 401) return status('连接失败：API Key 无效，请去面板设置页重新生成', 'err');
    if (!resp.ok) return status('连接失败：面板返回 HTTP ' + resp.status, 'err');
    // ③ 解析任务列表
    let data;
    try { data = await resp.json(); } catch { return status('连接失败：面板返回数据格式错误', 'err'); }
    status(`连接正常 ✅ API Key 有效（面板版本 ${data.version || '未知'}）`, 'ok');
  } catch (e) {
    status('检查失败：' + (e.message || e), 'err');
  }
};

init();
