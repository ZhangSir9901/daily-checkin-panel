// 签到面板 Cookie 助手 - popup.js
// DEFAULT_PANEL_URL 由面板在用户下载时动态注入（替换 __PANEL_URL__ 占位符），
// 扩展首次打开时自动带出，用户仍可手动修改。
const DEFAULT_PANEL_URL = '__PANEL_URL__';
const $ = (id) => document.getElementById(id);
const status = (msg, cls = '') => { const s = $('status'); s.textContent = msg; s.className = cls; };

let cookies = [];
let domain = '';

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

  // 获取该域名下所有 Cookie（含 HttpOnly）
  cookies = await chrome.cookies.getAll({ domain });
  // 也尝试 host-only 的精确匹配
  const exact = await chrome.cookies.getAll({ domain: domain.replace(/^\./, '') });
  const seen = new Set(cookies.map((c) => c.name));
  for (const c of exact) if (!seen.has(c.name)) cookies.push(c);

  $('count').textContent = cookies.length + ' 个';
  status(cookies.length ? `已读取 ${cookies.length} 个 Cookie（含 HttpOnly）` : '该网站没有 Cookie', cookies.length ? 'ok' : 'err');

  // 保存 UA 供发送时使用
  window._pageUA = pageUA;
}

function cookieString() {
  return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
}

function fullPayload() {
  return JSON.stringify({
    domain,
    userAgent: window._pageUA || '',
    cookies: cookieString(),
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
  const payload = btoa(unescape(encodeURIComponent(fullPayload())));
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

// 立即执行待办签到（触发后台任务）
$('btn-run-now').onclick = async () => {
  status('正在获取待办任务…', '');
  try {
    let panelUrl = $('panel-url').value.trim().replace(/\/$/, '');
    if (!panelUrl) return status('请先填写签到面板地址', 'err');
    if (!panelUrl.startsWith('http')) panelUrl = 'https://' + panelUrl;
    const apiKey = $('api-key').value.trim();
    if (!apiKey) return status('请先填写 API Key', 'err');

    // 直接在弹窗里获取并执行（不依赖后台 Service Worker，避免休眠无响应）
    const resp = await fetch(panelUrl + '/api/external/browser-jobs', {
      headers: { 'X-Api-Key': apiKey },
    });
    if (!resp.ok) return status('获取任务失败：HTTP ' + resp.status, 'err');
    const data = await resp.json();
    const jobs = data.jobs || [];
    if (!jobs.length) return status('暂无待办任务', 'ok');

    status(`找到 ${jobs.length} 个任务，开始执行…`, '');
    for (const job of jobs) {
      status(`正在执行：${job.site_name || job.domain}…`, '');
      const r = await executeJobInPopup(job);
      // 上报结果
      await fetch(panelUrl + '/api/external/report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Api-Key': apiKey },
        body: JSON.stringify({
          account_id: job.account_id,
          status: r.status,
          message: r.message,
          detail: '',
          duration_ms: r.durationMs || 0,
        }),
      }).catch(() => {});
      status(`${job.site_name || job.domain}：${r.message}`, r.status === 'ok' ? 'ok' : 'err');
      await new Promise((r2) => setTimeout(r2, 1500));
    }
    status('全部执行完成，去面板查看日志', 'ok');
  } catch (e) {
    status('执行失败：' + (e.message || e), 'err');
  }
};

// 在弹窗上下文中执行单个签到任务（复用目标域名标签页，携带用户 Cookie）
async function executeJobInPopup(job) {
  const startMs = Date.now();
  try {
    if (!job.domain) throw new Error('任务缺少目标域名');
    if (!job.script) throw new Error('任务缺少签到脚本');
    const tabs = await chrome.tabs.query({ url: `*://${job.domain}/*` });
    let tab;
    if (tabs.length > 0) {
      tab = tabs[0];
    } else {
      tab = await chrome.tabs.create({ url: `https://${job.domain}/`, active: false });
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
    // 脚本执行加 60 秒超时，防止卡死
    const execPromise = chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (scriptStr, params) => {
        // 用 Function 构造器替代 eval，更可靠
        const fn = new Function('params', `return (${scriptStr})(params)`);
        return fn(params);
      },
      args: [job.script, job.params || {}],
    });
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('脚本执行超时（60秒）')), 60000)
    );
    const results = await Promise.race([execPromise, timeoutPromise]);
    const result = results && results[0] && results[0].result;
    if (!result) throw new Error('脚本无返回结果');
    return {
      status: result.ok ? 'ok' : 'fail',
      message: String(result.message || (result.ok ? '签到成功' : '签到失败')),
      durationMs: Date.now() - startMs,
    };
  } catch (e) {
    return { status: 'fail', message: '浏览器执行失败：' + (e.message || e), durationMs: Date.now() - startMs };
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
