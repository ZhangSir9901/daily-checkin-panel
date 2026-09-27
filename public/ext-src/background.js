// 签到面板 Cookie 助手 - 后台执行引擎
// 每小时从面板获取 browser 模式的待执行任务，在用户浏览器中完成签到（使用用户网络），上报结果。

const ALARM_NAME = 'checkin-jobs';
const CHECK_INTERVAL_MIN = 60; // 每小时检查一次

// 获取面板地址和 API Key
async function getConfig() {
  const { panelUrl, apiKey } = await chrome.storage.sync.get(['panelUrl', 'apiKey']);
  // 面板地址：已保存 > 下载时注入的默认值
  let url = (panelUrl || '').trim().replace(/\/$/, '');
  if (!url && typeof DEFAULT_PANEL_URL !== 'undefined' && DEFAULT_PANEL_URL && !DEFAULT_PANEL_URL.includes('__PANEL_URL__')) {
    url = DEFAULT_PANEL_URL.replace(/\/$/, '');
  }
  return { panelUrl: url, apiKey: (apiKey || '').trim() };
}

// 从面板获取待执行任务
async function fetchJobs(panelUrl, apiKey) {
  const resp = await fetch(panelUrl + '/api/external/browser-jobs', {
    headers: { 'X-Api-Key': apiKey },
  });
  if (!resp.ok) throw new Error('获取任务失败：HTTP ' + resp.status);
  const data = await resp.json();
  return data.jobs || [];
}

// 上报结果到面板
async function reportResult(panelUrl, apiKey, accountId, status, message, durationMs) {
  await fetch(panelUrl + '/api/external/report', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Api-Key': apiKey },
    body: JSON.stringify({
      account_id: accountId,
      status,
      message,
      detail: '',
      duration_ms: durationMs || 0,
    }),
  }).catch(() => { /* 上报失败不阻塞 */ });
}

// 在目标域名的标签页中执行签到脚本
async function executeJob(job) {
  const startMs = Date.now();
  let tab = null;
  try {
    // 找一个该域名的已存在标签页，复用；没有则新建隐藏标签页
    const tabs = await chrome.tabs.query({ url: `*://${job.domain}/*` });
    if (tabs.length > 0) {
      tab = tabs[0];
    } else {
      tab = await chrome.tabs.create({ url: `https://${job.domain}/`, active: false });
      // 等待页面加载完成
      await new Promise((resolve) => {
        const listener = (tabId, info) => {
          if (tabId === tab.id && info.status === 'complete') {
            chrome.tabs.onUpdated.removeListener(listener);
            resolve();
          }
        };
        chrome.tabs.onUpdated.addListener(listener);
        setTimeout(resolve, 15000); // 超时保护
      });
    }

    // 在页面上下文中执行签到脚本
    // 脚本是面板下发的自包含 async 函数，入参为 params，返回 { ok, message }
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (scriptStr, params) => {
        // eslint-disable-next-line no-eval
        const fn = eval(`(${scriptStr})`);
        return fn(params);
      },
      args: [job.script, job.params || {}],
    });

    const result = results && results[0] && results[0].result;
    if (!result) throw new Error('脚本无返回结果');

    return {
      status: result.ok ? 'ok' : 'fail',
      message: String(result.message || (result.ok ? '签到成功' : '签到失败')),
      durationMs: Date.now() - startMs,
    };
  } catch (e) {
    return {
      status: 'fail',
      message: '浏览器执行失败：' + (e.message || e),
      durationMs: Date.now() - startMs,
    };
  } finally {
    // 如果是我们新建的标签页，执行完关闭（复用的则保留）
    // 简单起见：不自动关闭，避免打断用户正在看的页面
  }
}

// 主流程：获取任务 → 逐个执行 → 上报
async function runJobs() {
  const { panelUrl, apiKey } = await getConfig();
  if (!panelUrl || !apiKey) {
    console.log('[签到面板] 未配置面板地址或 API Key，跳过');
    return;
  }

  let jobs;
  try {
    jobs = await fetchJobs(panelUrl, apiKey);
  } catch (e) {
    console.log('[签到面板] 获取任务失败：', e.message);
    return;
  }

  if (!jobs.length) {
    console.log('[签到面板] 暂无待执行任务');
    return;
  }

  console.log(`[签到面板] 获取到 ${jobs.length} 个任务，开始执行`);
  for (const job of jobs) {
    console.log(`[签到面板] 执行：${job.site_name}（账号 ${job.account_id}）`);
    const r = await executeJob(job);
    console.log(`[签到面板] 结果：${r.status} - ${r.message}`);
    await reportResult(panelUrl, apiKey, job.account_id, r.status, r.message, r.durationMs);
    // 任务之间稍作间隔
    await new Promise((r) => setTimeout(r, 2000));
  }
}

// 定时器
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) runJobs();
});

// 扩展安装/启动时设置定时器
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: CHECK_INTERVAL_MIN });
  // 安装后立即跑一次（方便验证）
  setTimeout(runJobs, 5000);
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: CHECK_INTERVAL_MIN });
});

// popup 手动触发
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.action === 'runJobsNow') {
    runJobs().then(() => sendResponse({ ok: true })).catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true; // 异步响应
  }
});
