// 签到面板 Cookie 助手 - 后台执行引擎
// 每小时从面板获取 browser 模式的待执行任务，在用户浏览器中完成签到（使用用户网络），上报结果。

// DEFAULT_PANEL_URL 由面板在用户下载时动态注入（替换 https://daily-checkin-panel.guo527029137.workers.dev 占位符）
const DEFAULT_PANEL_URL = '__PANEL_URL__';

const ALARM_NAME = 'checkin-jobs';
const CHECK_INTERVAL_MIN = 5; // 每 5 分钟领一次待办签到任务（面板点“执行”后无需等一小时）
const RELAY_ALARM = 'relay-poll';
// 注意：Chrome 会把 alarms 的周期压到最小 0.5 分钟，靠短轮询做不到「秒级响应」。
// 所以中继改成「长轮询」：请求挂起最多 20 秒，一有任务 Worker 立刻返回；
// 一轮结束马上接下一轮（RELAY_GAP_MS），延迟从 15~30 秒降到 1 秒内。
const RELAY_INTERVAL_MIN = 0.5; // 兜底 alarm（Service Worker 被回收后由它重新拉起长轮询循环）
const RELAY_LONGPOLL_MS = 15000; // 单次长轮询挂起时长（Worker 端上限 15 秒）
const RELAY_GAP_MS = 200; // 两轮长轮询之间的间隔
const RELAY_BURST_ROUNDS = 24; // 单次突发最多跑几轮长轮询（防止无限循环/异常时死循环）
const RELAY_BURST_IDLE = 6; // 连续几轮没接到任务就结束本次突发（6×15s≈90s 空转覆盖）
const RELAY_JOB_TIMEOUT_MS = 60000; // 单个中继任务硬超时，超时也要回传，避免任务永久卡在 pending
const RELAY_FETCH_TIMEOUT_MS = 30000; // 页面内单次 fetch 的超时（52pojie 这类慢站需要更久）

// 获取面板地址和 API Key
async function getConfig() {
  const { panelUrl, apiKey } = await chrome.storage.sync.get(['panelUrl', 'apiKey']);
  // 面板地址：已保存 > 下载时注入的默认值
  let url = (panelUrl || '').trim().replace(/\/$/, '');
  if (!url && typeof DEFAULT_PANEL_URL !== 'undefined' && DEFAULT_PANEL_URL && DEFAULT_PANEL_URL.startsWith('http')) {
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

// 原生页面巡检：不依赖 eval / new Function（MV3 已禁止），用于读取网站真实反馈。
// 返回 { ok, message } 或 null。
async function inspectPage(tabId) {
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
      if (CAPTCHA.some((m) => all.includes(m))) {
        return { ok: false, message: '遇到人机验证/安全验证（验证码/滑块），需人工验证后重试｜页面：' + title };
      }
      const WAF = ['waf_zw_verify', 'WZWS_CONFIRM_PREFIX_LABEL', 'Access Denied', '403 Forbidden', '请求被拦截'];
      if (WAF.some((m) => all.includes(m))) {
        return { ok: false, message: '遇到网站安全防护（WAF），请在浏览器完成验证后重试｜页面：' + title };
      }
      // 2) 签到成功
      if (/任务已完成|签到成功|打卡成功|签到完毕|签到完成|已连续签到|领取成功|成功领取|恭喜.{0,12}(获得|领到|签到)|获得.{0,10}(鸡腿|积分|金币|铜币|银币|AK|币|空间|MB|GB|M|G)/.test(all)) {
        return { ok: true, message: '签到成功｜' + (compact.slice(0, 120) || title) };
      }
      // 3) 今日已签到（Discuz 重复申请会返回「您已完成过此任务」）
      if (/今日已签到|今天已签到|已经签到|已签到|重复签到|请勿重复|无需重复|下期再来|已完成过此任务|已领取/.test(all)) {
        return { ok: true, message: '今日已签到，无需重复' };
      }
      // 4) 未登录
      if (/需要先登录|请先登录|还未登录|请登录后|登录已失效|登录失效|请重新登录|未登录/.test(all)) {
        return { ok: false, message: '登录已失效，请重新获取 Cookie' };
      }
      return { ok: false, message: '未识别到成功标识｜页面：' + title + '｜' + compact.slice(0, 140) };
    },
  });
  return (results && results[0] && results[0].result) || null;
}

// 尝试执行面板下发的脚本字符串。
// 注意：MV3 禁止 new Function / eval，多数情况下这里会失败——失败时由调用方回退到原生巡检。
async function runPanelScript(tabId, job) {
  const execPromise = chrome.scripting.executeScript({
    target: { tabId },
    func: (scriptStr, params) => {
      const fn = new Function('params', `return (${scriptStr})(params)`);
      return fn(params);
    },
    args: [job.script, job.params || {}],
  });
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('脚本执行超时（60秒）')), 60000)
  );
  const results = await Promise.race([execPromise, timeoutPromise]);
  return (results && results[0] && results[0].result) || null;
}

// 在目标域名的标签页中执行签到脚本
async function executeJob(job) {
  const startMs = Date.now();
  let tab = null;
  let created = false;
  try {
    // 与 popup 保持一致：缺域名时直接报错，避免误开 https://undefined/ 标签页
    if (!job.domain) throw new Error('任务缺少目标域名');
    // 找一个该域名的已存在标签页，复用；没有则新建隐藏标签页
    const tabs = await chrome.tabs.query({ url: `*://${job.domain}/*` });
    if (tabs.length > 0) {
      tab = tabs[0];
    } else {
      tab = await chrome.tabs.create({ url: `https://${job.domain}/`, active: false });
      created = true;
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

    // 如果任务指定了导航 URL（如吾爱破解），先导航到该页面（模拟手动点击），再执行检查脚本
    if (job.navigate_url) {
      await chrome.tabs.update(tab.id, { url: job.navigate_url });
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
      await new Promise((r) => setTimeout(r, 2000));
    }

    // 执行签到。
    // MV3 禁止 new Function / eval，面板下发的脚本字符串通常无法执行；
    // 因此：有 navigate_url 的任务直接对目标页做原生巡检；否则先试面板脚本，拿不到结果就回退原生巡检。
    let result = null;
    if (!job.navigate_url && job.script) {
      try {
        result = await runPanelScript(tab.id, job);
      } catch (e) {
        console.log('[签到面板] 面板脚本执行失败，回退原生巡检：', e.message || e);
        result = null;
      }
    }
    if (!result) result = await inspectPage(tab.id);
    if (!result) throw new Error('无法读取页面内容（标签页可能已关闭或被重定向）');

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
    // 只关闭“我们自己新建”的标签页（复用的、用户正在看的保留），避免每次签到累积一堆隐藏标签页
    if (created && tab && tab.id) {
      chrome.tabs.remove(tab.id).catch(() => {});
    }
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

// ============ 本地网络中继代理 ============
// Worker 把 HTTP 请求存入面板队列，扩展用用户本地网络执行后回传响应。
// 这样 Worker 端的站点逻辑可以使用用户本地 IP，绕过 CF/Worker IP 限制。

// base64 ↔ Uint8Array
function b64ToBytes(b64) {
  const s = atob(b64);
  const arr = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) arr[i] = s.charCodeAt(i);
  return arr;
}
function bytesToB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

// 获取待执行的中继任务（长轮询：没有任务时挂起，一有任务立刻返回）
async function fetchRelayJobs(panelUrl, apiKey, waitMs = RELAY_LONGPOLL_MS) {
  // 带上扩展版本（?v=），面板可以显示「扩展在线 · v2.2」并提醒版本陈旧
  let ver = '';
  try { ver = (chrome.runtime.getManifest() || {}).version || ''; } catch { /* 忽略 */ }
  const resp = await fetch(panelUrl + '/api/external/relay-pending?wait=' + waitMs + (ver ? '&v=' + encodeURIComponent(ver) : ''), {
    headers: { 'X-Api-Key': apiKey },
  });
  if (!resp.ok) throw new Error('HTTP ' + resp.status);
  const data = await resp.json();
  return data.jobs || [];
}

// 回传中继结果
async function submitRelayResult(panelUrl, apiKey, jobId, result) {
  await fetch(panelUrl + '/api/external/relay/' + jobId + '/result', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Api-Key': apiKey },
    body: JSON.stringify(result),
  }).catch(() => { /* 忽略 */ });
}

// 在目标域名的页面上下文中执行单个 HTTP 请求（携带用户 Cookie）
async function executeRelayJob(job) {
  const url = new URL(job.url);
  const domain = url.hostname;
  let tab = null;
  let created = false;
  try {
    const tabs = await chrome.tabs.query({ url: `*://${domain}/*` });
    if (tabs.length > 0) {
      tab = tabs[0];
    } else {
      tab = await chrome.tabs.create({ url: `https://${domain}/`, active: false });
      created = true;
      await new Promise((resolve) => {
        const listener = (tabId, info) => {
          if (tabId === tab.id && info.status === 'complete') {
            chrome.tabs.onUpdated.removeListener(listener);
            resolve();
          }
        };
        chrome.tabs.onUpdated.addListener(listener);
        setTimeout(resolve, 8000); // 建标签页只为拿登录态，页面没加载完也照样能发请求，不必等满
      });
    }

    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: async (url, method, headers, bodyB64, options, timeoutMs) => {
        const b64ToBytes = (b64) => {
          const s = atob(b64);
          const arr = new Uint8Array(s.length);
          for (let i = 0; i < s.length; i++) arr[i] = s.charCodeAt(i);
          return arr;
        };
        const bytesToB64 = (bytes) => {
          let s = '';
          for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
          return btoa(s);
        };
        const init = {
          method,
          headers,
          credentials: 'include', // 始终携带用户 Cookie
          // 页面里拿不到 opaqueredirect 的响应头，manual 等于白跑一轮，统一 follow
          redirect: options.redirect === 'manual' ? 'follow' : (options.redirect || 'follow'),
        };
        if (bodyB64) init.body = b64ToBytes(bodyB64);
        // 页面内自超时：即便站点把连接吊死，也要抛出错误而不是让整个任务卡到硬超时
        // （AbortController 在某些受限环境里不存在，存在性判断不能省）
        const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
        const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs || 18000) : null;
        if (ctrl) init.signal = ctrl.signal;
        try {
          const resp = await fetch(url, init);
          const buf = new Uint8Array(await resp.arrayBuffer());
          const h = {};
          resp.headers.forEach((v, k) => { h[k] = v; });
          return {
            status: resp.status,
            headers: h,
            body_base64: bytesToB64(buf),
            url: resp.url, // 最终 URL（跟随重定向后）
          };
        } finally {
          clearTimeout(timer);
        }
      },
      args: [job.url, job.method, job.headers || {}, job.body_base64 || null, job.options || {}, RELAY_FETCH_TIMEOUT_MS],
    });

    const r = results && results[0] && results[0].result;
    if (!r) throw new Error('无返回结果');
    // 把最终 URL 放入特殊头，Worker 端可读取
    const headers = { ...(r.headers || {}), 'x-relay-url': r.url || job.url };
    return { status: r.status, headers, body_base64: r.body_base64 };
  } catch (e) {
    return { error: String(e.message || e).slice(0, 500) };
  } finally {
    // 复用的标签页保留，自己新建的关闭（避免堆积）
    if (created && tab && tab.id) {
      chrome.tabs.remove(tab.id).catch(() => {});
    }
  }
}

// 中继主循环（单轮）：取任务 → 执行 → 回传
// 若正好有一轮在跑，先等它（避免「刚排队的任务被这轮跳过」），最多等 ~600ms。
async function runRelayOnce() {
  for (let i = 0; i < 3 && relayBusy; i++) await sleep(200);
  if (relayBusy) return { ok: true, count: 0, skipped: true };
  relayBusy = true;
  try {
    return await runRelayRound();
  } finally {
    relayBusy = false;
  }
}

async function runRelayRound() {
  const { panelUrl, apiKey } = await getConfig();
  if (!panelUrl || !apiKey) return { ok: false, reason: 'noconfig' };
  let jobs;
  try {
    jobs = await fetchRelayJobs(panelUrl, apiKey);
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }; // 面板不可达时静默重试
  }
  for (const job of jobs) {
    try {
      console.log(`[签到面板] 中继请求：${job.method} ${job.url}`);
      // 硬超时：即使页面 fetch 或注入挂起，也必须回传结果，否则任务会永久卡在队列
      const result = await Promise.race([
        executeRelayJob(job),
        new Promise((resolve) => setTimeout(() => resolve({ error: `中继执行超时（${RELAY_JOB_TIMEOUT_MS / 1000}秒），已放弃该请求` }), RELAY_JOB_TIMEOUT_MS)),
      ]);
      await submitRelayResult(panelUrl, apiKey, job.id, result);
    } catch (e) {
      console.error(`[签到面板] 中继任务 ${job.id} 失败:`, e);
      // 回传错误，避免任务卡在 pending
      try {
        await submitRelayResult(panelUrl, apiKey, job.id, { error: String(e.message || e) });
      } catch { /* 忽略 */ }
    }
  }
  return { ok: true, count: jobs.length };
}

// 中继长轮询「突发」：一轮结束立刻接下一轮，让面板点「执行」后 1 秒内就被领走。
//
// 为什么不用 while(true) 常驻循环：① 浏览器可能随时回收 Service Worker，常驻循环早晚会断；
// ② 若面板侧不支持长轮询（旧版本），常驻循环会变成毫秒级空转打网络。
// 所以改成「有界突发」：最多 RELAY_BURST_ROUNDS 轮，连续 RELAY_BURST_IDLE 轮没任务就结束；
// 由 RELAY_ALARM（0.5 分钟）和 popup 的「立即执行」反复拉起，接得上就与常驻无异。
let relayGen = 0; // 代际令牌：新的突发会作废旧的，避免多份循环并发抢任务
let relayBusy = false; // 正在处理一轮长轮询（避免并发取同一批任务）

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

function startRelayBurst(opts = {}) {
  const rounds = opts.rounds || RELAY_BURST_ROUNDS;
  const idleStop = opts.idleStop || RELAY_BURST_IDLE;
  const gen = ++relayGen;
  let idle = 0;
  (async () => {
    for (let i = 0; i < rounds; i++) {
      if (gen !== relayGen) return; // 已被更新的突发取代/已停止
      let r;
      try {
        r = await runRelayOnce();
      } catch (e) {
        r = { ok: false, error: String((e && e.message) || e) };
      }
      if (gen !== relayGen) return;
      if (r && r.reason === 'noconfig') return; // 未配置面板地址/Key，不空转
      if (r && r.count) idle = 0; else idle++;
      if (idle >= idleStop) return; // 一连几轮都没任务，先歇着，交给下次 alarm
      await sleep(r && r.ok ? RELAY_GAP_MS : 5000);
    }
  })();
}

// 供 popup / 测试使用：立刻停掉当前突发（不打断正在执行的那一轮）
function stopRelayBurst() {
  relayGen++;
}

// 定时器
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) runJobs();
  if (alarm.name === RELAY_ALARM) startRelayBurst();
});

// 扩展安装/启动时设置定时器
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: CHECK_INTERVAL_MIN });
  chrome.alarms.create(RELAY_ALARM, { periodInMinutes: RELAY_INTERVAL_MIN });
  // 安装后立即跑一次（方便验证），并起一次中继突发
  setTimeout(runJobs, 5000);
  startRelayBurst();
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: CHECK_INTERVAL_MIN });
  chrome.alarms.create(RELAY_ALARM, { periodInMinutes: RELAY_INTERVAL_MIN });
  startRelayBurst();
});

// Service Worker 每次启动时确保定时器存在（覆盖"重新加载"场景：onInstalled/onStartup 都不触发）
chrome.alarms.get(ALARM_NAME, (a) => {
  if (!a) chrome.alarms.create(ALARM_NAME, { periodInMinutes: CHECK_INTERVAL_MIN });
});
chrome.alarms.get(RELAY_ALARM, (a) => {
  if (!a) chrome.alarms.create(RELAY_ALARM, { periodInMinutes: RELAY_INTERVAL_MIN });
});

// popup 手动触发
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.action === 'runJobsNow') {
    runJobs().then(() => sendResponse({ ok: true })).catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true; // 异步响应
  }
  if (msg && msg.action === 'runRelayNow') {
    // 先同步跑完一轮（已排队的任务立即执行），响应后再转入长轮询突发
    runRelayOnce()
      .then((r) => {
        sendResponse({ ok: true, count: (r && r.count) || 0 });
        startRelayBurst();
      })
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true;
  }
  if (msg && msg.action === 'stopRelay') {
    stopRelayBurst();
    sendResponse({ ok: true });
    return true;
  }
});
