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
    // 直接调用后台的 runJobs 逻辑（通过消息传递），加 10 秒超时防止卡死
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('后台无响应（扩展可能需要重新加载）')), 10000));
    await Promise.race([
      chrome.runtime.sendMessage({ action: 'runJobsNow' }),
      timeout,
    ]);
    status('已触发执行，请稍后在面板查看日志', 'ok');
  } catch (e) {
    status('触发失败：' + (e.message || e), 'err');
  }
};

// 立即处理中继任务（调试用）
$('btn-relay-now').onclick = async () => {
  status('正在获取中继任务…', '');
  try {
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('后台无响应（扩展可能需要重新加载）')), 10000));
    await Promise.race([
      chrome.runtime.sendMessage({ action: 'runRelayNow' }),
      timeout,
    ]);
    status('已触发中继处理，请稍后在面板查看日志', 'ok');
  } catch (e) {
    status('触发失败：' + (e.message || e), 'err');
  }
};

init();
