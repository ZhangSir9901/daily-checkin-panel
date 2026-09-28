// 签到面板 Cookie 助手 - 后台执行引擎
// 每小时从面板获取 browser 模式的待执行任务，在用户浏览器中完成签到（使用用户网络），上报结果。

// DEFAULT_PANEL_URL 由面板在用户下载时动态注入（替换 https://daily-checkin-panel.guo527029137.workers.dev 占位符）
const DEFAULT_PANEL_URL = '__PANEL_URL__';

const ALARM_NAME = 'checkin-jobs';
const CHECK_INTERVAL_MIN = 1; // 每分钟领一次「浏览器导航签到」任务（面板点「浏览器签到」后很快就会被领走）
const RELAY_ALARM = 'relay-poll';
// 注意：Chrome 会把 alarms 的周期压到最小 0.5 分钟，靠短轮询做不到「秒级响应」。
// 所以中继改成「长轮询」：请求挂起最多 20 秒，一有任务 Worker 立刻返回；
// 一轮结束马上接下一轮（RELAY_GAP_MS），延迟从 15~30 秒降到 1 秒内。
const RELAY_INTERVAL_MIN = 0.5; // 兜底 alarm（Service Worker 被回收后由它重新拉起长轮询循环）
const RELAY_LONGPOLL_MS = 15000; // 单次长轮询挂起时长（Worker 端上限 15 秒）
const RELAY_GAP_MS = 200; // 两轮长轮询之间的间隔
const RELAY_BURST_ROUNDS = 24; // 单次突发最多跑几轮长轮询（防止无限循环/异常时死循环）
const RELAY_BURST_IDLE = 6; // 连续几轮没接到任务就结束本次突发（6×15s≈90s 空转覆盖）
const RELAY_FETCH_TIMEOUT_MS = 30000; // 页面内单次 fetch 的超时（52pojie / 糊涂鳄这类慢站需要更久）
// 第一次尝试用较短超时：普通站点几百毫秒就回来了，只有「后台标签里反爬挑战跑不动」的站点会超时。
// 超时后把标签激活到前台再试一次（见 executeRelayJob）。
const RELAY_FIRST_TRY_MS = 12000;
const RELAY_ACTIVATE_WAIT_MS = 1200; // 激活前台后等页面里的挑战/定时脚本醒过来
// 任务级硬超时：超时也要回传，避免任务永久卡在 pending。
// 【必须能装下「首次试探 + 激活前台 + 前台重试」】—— 否则第二次明明快要拿到响应了，
// 也会被硬超时掐掉。线上就是这么坏的：45 秒的硬超时把 12 + 1.2 + 30 的重试链条掐死，
// 面板上永远只看到「中继执行超时」，而那个 POST 其实已经发出去了（站点可能已签到）。
// 所以下面的值用公式算，改上面任何一个常量都不会再踩这个坑。
const RELAY_JOB_TIMEOUT_MS = RELAY_FIRST_TRY_MS + RELAY_ACTIVATE_WAIT_MS + RELAY_FETCH_TIMEOUT_MS + 15000; // = 58.2s

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
// 返回 { ok, message, unsigned?, href? } 或 null。
//
// 判定顺序很关键（都是踩过的坑）：
//   ① 验证码/WAF 优先 —— 这些页面里也夹带「签到」字样
//   ② 再有「已验证签到」的正信号（Discuz 任务：「签到完毕 / 您已完成过此任务 / 恭喜…获得 N 吾爱币」）
//   ③ 才看「去签到链接」还在不在：
//      论坛（尤其吾爱破解）把当天状态画在图片里（qds.png），文本节点是空的，
//      但**链接还在 = 服务端认为今天还没签**；签完之后链接就没了。
//      注意：必须**限定在链接自己所在的那一行**找「任务/签到」字样 —— 任务列表页里
//      还有其他任务（验证邮箱等）也带 apply 链接，拿整页搜会搞错。
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

      // ---- 找「去签到」入口（Discuz 系论坛通用）----
      // 已签到的视觉特征：文字或图片里直接写着已签/已打卡/连续签到
      const ALREADY = /已签到|已经签到|已打卡|签到完毕|签到完成|连续签到|今日已签|明天再来|下期再来/;
      // 未签到的视觉特征：文字
      const SIGN_TEXT = /打卡签到|立即签到|点击签到|点击打卡|签到领奖|每日签到|每日打卡|签个到|去签到|未打卡|没有签到|还没有签到|今天还没有签到|今天还没有|立即打卡/;
      // 未签到的视觉特征：图片（各 Discuz 签到插件用的图）
      const SIGN_IMG = /qds\.png|signin_no\.png|pperwb\.gif|wb\.png|qiandao|qdbg|sign_?in/i;
      // 已知的签到按钮 id / class（来自各社区签到脚本：discuz 任务、dsu_paulsign、k_misign、zqlj_sign 等）
      const SIGN_SEL = '#kx,#JD_sign,#addsign,#sg_sign,#dcsignin_tips,#tt_sign,.punch_btn,.go-user-qiandao,a.initiate-checkin,#my_amupper,#pper_a,#sign_title,#setsign,.click-qiandao,.zzhuti_qd_1,.user-index-qd,.taskbtn';

      const attrOf = (el) => ((el.getAttribute && el.getAttribute('href') || '') + ' ' +
        (el.id || '') + ' ' + (el.className || '') + ' ' + (el.getAttribute && el.getAttribute('title') || '')).replace(/\s+/g, ' ');
      const textOf = (el) => String(el.innerText || el.textContent || '').replace(/\s+/g, '');
      const imgsOf = (el) => Array.from(el.querySelectorAll ? el.querySelectorAll('img') : [])
        .concat(el.tagName === 'IMG' ? [el] : [])
        .map((i) => (i.getAttribute('src') || '') + ' ' + (i.getAttribute('alt') || '')).join(' ');

      const findSignLink = () => {
        // ① Discuz 任务申请链接（吾爱破解这类：mod=task&do=apply&id=N）
        const applies = Array.from(document.querySelectorAll('a[href*="do=apply"], a[href*="do=draw"]'))
          .filter((a) => /mod=task/i.test(a.getAttribute('href') || ''));
        for (const a of applies) {
          const own = textOf(a) + ' ' + attrOf(a) + ' ' + imgsOf(a);
          if (ALREADY.test(textOf(a))) continue;
          const row = a.closest('tr') || a.closest('li') || a.closest('table') || a.parentElement;
          const rowTxt = ((row && row.innerText) || '').replace(/\s+/g, ' ').slice(0, 200);
          // 任务列表里那个「已完成」是隔壁任务的，必须限定在链接所在行
          const rowDone = /已完成|已申请|已领取|已打卡/.test(rowTxt) && !/立即申请|马上申请|申请任务/.test(rowTxt);
          if (rowDone) return { href: a.getAttribute('href') || '', label: (textOf(a) || '签到'), done: true };
          if (/qds\.png|打卡|每日|签到/i.test(own + ' ' + rowTxt) || applies.length === 1) {
            return { href: a.getAttribute('href') || '', label: (textOf(a) || '打卡签到'), done: false };
          }
        }
        // ② 已知的签到按钮（可能是 <a href>，也可能是 JS 点击的 <span>/<div>/<img>）
        const known = Array.from(document.querySelectorAll(SIGN_SEL));
        for (const el of known) {
          const own = textOf(el) + ' ' + attrOf(el) + ' ' + imgsOf(el);
          if (ALREADY.test(own)) continue;
          const href = (el.getAttribute && el.getAttribute('href')) || '';
          const usable = href && !/^javascript:void/i.test(href) ? href : '';
          return { href: usable, clickSel: true, label: (textOf(el) || '签到'), done: false };
        }
        // ③ 兜底：页面上写着「打卡签到 / 每日签到」的可点元素
        const cands = Array.from(document.querySelectorAll('a,button,[onclick],img'));
        for (const el of cands) {
          const t = textOf(el);
          const im = imgsOf(el);
          if (ALREADY.test(t + ' ' + im)) continue;
          const hit = SIGN_TEXT.test(t) || SIGN_IMG.test(im);
          if (!hit) continue;
          const href = (el.getAttribute && el.getAttribute('href')) || '';
          if (!href && !el.onclick && !el.getAttribute('onclick')) continue;   // 纯展示元素，点了也没用
          return { href: /^javascript:/i.test(href) ? '' : href, clickSel: true, label: (t || '签到'), done: false };
        }
        return null;
      };
      const markForClick = (res) => {
        if (!res || !res.clickSel) return '';
        const el = document.querySelector(SIGN_SEL) || (SIGN_TEXT.test(compact) ? document.querySelector('a[href*="do=apply"]') : null);
        if (!el) return '';
        el.setAttribute('data-panel-sign', '1');
        return '[data-panel-sign="1"]';
      };

      // 2) 「已完成」的强信号（Discuz：您已完成过此任务 / 今日已签到 / 恭喜…获得…）
      const SIGNED = /签到完毕|签到完成|您已完成过此任务|您已经完成此任务|您今日已经签到|您今天已经签到|今天已经签到|已经签到过|已经完成签到|今日任务已完成|今日已签到|今天已完成签到|已连续签到|下期再来|明天再来|无需重复|恭喜.{0,14}(完成|获得|领到|签到)/;
      // 成功信号：任务页直接告诉用户拿到了什么
      const SUCCESS = /任务已完成|签到成功|打卡成功|领取成功|成功领取|获得.{0,10}(鸡腿|积分|金币|铜币|银币|吾爱币|AK|币|空间|MB|GB)/;
      // 注入环境可能没有 DOM API（部分页面/测试台架）：退回到纯文本 + 正则，
      // 只认「do=apply 链接 + 签到图/签到字样」这个最硬的组合。
      let link = null;
      try { link = findSignLink(); } catch (e) { link = null; }
      if (!link) {
        const am = all.match(/<a[^>]*href=["']([^"']*mod=task[^"']*do=(?:apply|draw)[^"']*)["'][^>]*>/i);
        if (am && /qds\.png|打卡签到|每日签到|每日打卡|签到完毕/i.test(all) && !/已完成过此任务|您已经完成此任务/.test(all)) {
          link = { href: am[1].replace(/&amp;/g, '&'), label: '打卡签到', done: false };
        }
      }
      if (SUCCESS.test(all)) {
        return { ok: true, message: '签到成功｜' + (compact.slice(0, 120) || title) };
      }
      // 强信号优先于「还挂着链接」：例如任务列表里签到那条已「已完成」，
      // 而顶栏还挂着别的任务的 apply 链接
      if (SIGNED.test(all)) return { ok: true, message: '今日已签到，无需重复' };
      if (link && link.done) return { ok: true, message: '今日已签到（任务页显示：已完成）' };
      // 4) 未登录（Discuz 游客页会写「注册[Register]」）—— 比「未签到」更优先：
      //    登录失效时页面导航里也有「每日签到」这类字样，不能把它当成“还没签到”。
      if (/需要先登录|请先登录|还未登录|请登录后|登录已失效|登录失效|请重新登录|未登录|注册\[Register\]|立即注册|登录后才能/.test(all)) {
        return { ok: false, message: '登录已失效，请重新获取 Cookie' };
      }
      // 页面上写着「还没签到」却找不到可点的入口（插件式签到页、被遮挡的按钮）：
      // 如实报未签到，并说清要人工处理，不要吐一句“未识别到成功标识”。
      if (!link && /打卡签到|立即签到|点击打卡|每日签到|每日打卡|还没有签到|未打卡/.test(all)) {
        return { ok: false, unsigned: true, href: '', clickSel: '',
                 message: '网站显示还没签到，但页面上找不到可点的签到入口' };
      }
      if (link) {
        let clickSel = '';
        try { clickSel = markForClick(link); } catch (e) { clickSel = ''; }
        return {
          ok: false, unsigned: true, href: link.href || '', clickSel,
          message: '网站还挂着「' + (link.label || '签到') + '」入口 —— 今天还没签上',
        };
      }
      return { ok: false, message: '未识别到成功标识｜页面：' + title + '｜' + compact.slice(0, 140) };
    },
  });
  return (results && results[0] && results[0].result) || null;
}

// 把页面里找到的「去签到」链接解析成绝对地址，并做同源校验。
// 页面内容不可信：只允许跳到当前站点的同源地址（http/https + 同 host）。
function resolveSignHref(result, tab) {
  const raw = result && result.href;
  if (!raw) return '';
  try {
    const base = (tab && tab.url) || ('https://' + (tab && tab.pendingUrl ? '' : ''));
    const u = new URL(raw, base || undefined);
    const cur = tab && tab.url ? new URL(tab.url) : null;
    if (cur && u.host !== cur.host) return '';
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    return u.href;
  } catch {
    return '';
  }
}

// 等待标签页加载完成（带超时），用于导航后复查
function waitTabComplete(tabId, timeoutMs) {
  return new Promise((resolve) => {
    const listener = (id, info) => {
      if (id === tabId && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); resolve(); }, timeoutMs || 20000);
  });
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

    // 页面还挂着「打卡签到」入口 = 服务端认为今天没签。
    // ① 是链接（吾爱破解这类 Discuz 任务）→ 导航过去，等同人手点一下；
    // ② 是 JS 按钮（dsu_paulsign / k_misign 等插件）→ 在页面里点一下。
    // 两条路都是真实用户行为，之前实测过：脚本化 fetch 会被 WAF 吊死，而导航/点击能过。
    if (!result.ok && result.unsigned) {
      const signHref = resolveSignHref(result, tab);
      try {
        if (signHref) {
          await chrome.tabs.update(tab.id, { url: signHref });
          await waitTabComplete(tab.id, 20000);
          await new Promise((r) => setTimeout(r, 2000));
        } else if (result.clickSel) {
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: (sel) => { const el = document.querySelector(sel); if (el) el.click(); },
            args: [result.clickSel],
          });
          await new Promise((r) => setTimeout(r, 3000));
        }
        const after = (signHref || result.clickSel) ? await inspectPage(tab.id) : null;
        if (after) result = after;
      } catch (e) {
        console.log('[签到面板] 触发签到失败：', e.message || e);
      }
    }

    // 连入口都没认出来（站点改版/插件页），但面板给了「签到地址」——那是站点模块自己知道的，
    // 再试一次，别白自放弃（同源校验后仍然只跳本域）。
    if (!result.ok && result.unsigned && !result.href && !result.clickSel && job.sign_url) {
      try {
        const u = new URL(job.sign_url);
        const sameHost = !job.domain || u.hostname === job.domain || u.hostname.endsWith('.' + job.domain);
        if ((u.protocol === 'http:' || u.protocol === 'https:') && sameHost) {
          await chrome.tabs.update(tab.id, { url: u.href });
          await waitTabComplete(tab.id, 20000);
          await new Promise((r) => setTimeout(r, 2000));
          const after = await inspectPage(tab.id);
          if (after) result = after;
        }
      } catch (e) {
        console.log('[签到面板] 兑底签到地址不可用：', e.message || e);
      }
    }

    // 明确未签到、且始终找不到可点的入口/地址 → 把「接下来怎么办」说清楚，
    // 不要只丢一句含糊的“未识别到成功标识”。
    if (!result.ok && result.unsigned && !result.href && !result.clickSel) {
      result = { ...result, message: String(result.message || '今天还没签上') + '；页面上找不到可点的签到入口，请在浏览器手动签一次' };
    }

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
//
// 为什么要「先短超时、超时就激活标签重试」：
// 实测（2026-09-28）发现，对 www.52pojie.cn 这类**带反爬挑战的主站**，从**后台标签**发
// fetch 会一直挂到硬超时（同一时刻同一浏览器：example.com 与 static.52pojie.cn 都正常返回 200，
// 只有主站的 robots.txt / portal.php / home.php 全部超时）。
// 原因是挑战/验证脚本在后台标签里被节流，服务端一直等不到「验证完成」，连接就不回包。
// 所以：第一次用短超时快速试探；若超时，就把标签**激活到前台**再试一次，跑完把焦点还给用户。
async function executeRelayJob(job) {
  const url = new URL(job.url);
  const domain = url.hostname;
  let tab = null;
  let created = false;
  let prevActiveId = null;
  let activated = false;
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

    const injectFetch = async (url, method, headers, bodyB64, options, timeoutMs) => {
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
      const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      if (ctrl) init.signal = ctrl.signal;
      let timer = null;
      // 不依赖 AbortController：某些受限环境里它不存在，那样整个任务会挂到硬超时。
      // 用 Promise.race 做兜底，保证无论如何都在 timeoutMs 内**返回**（返回超时标记，不抛出）。
      const timeout = new Promise((resolve) => {
        timer = setTimeout(() => {
          try { if (ctrl) ctrl.abort(); } catch { /* 忽略 */ }
          resolve({ timeout: true });
        }, timeoutMs || 18000);
      });
      const call = (async () => {
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
      })();
      try {
        return await Promise.race([call, timeout]);
      } finally {
        clearTimeout(timer);
        call.catch(() => {}); // 超时后迟到的失败不要变成未处理拒绝
      }
    };

    const runOnce = async (timeoutMs) => {
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: injectFetch,
        args: [job.url, job.method, job.headers || {}, job.body_base64 || null, job.options || {}, timeoutMs],
      });
      return (results && results[0] && results[0].result) || null;
    };

    let r = await runOnce(RELAY_FIRST_TRY_MS);
    if (r && r.timeout) {
      // 后台标签里反爬挑战跑不动 → 把标签拿到前台重试一次
      try {
        const [cur] = await chrome.tabs.query({ active: true, currentWindow: true });
        prevActiveId = cur && cur.id != null ? cur.id : null;
        await chrome.tabs.update(tab.id, { active: true });
        activated = true;
        await new Promise((res) => setTimeout(res, RELAY_ACTIVATE_WAIT_MS)); // 给页面里的定时/挑战脚本一点时间
      } catch { /* 激活失败也得继续试 */ }
      r = await runOnce(RELAY_FETCH_TIMEOUT_MS);
    }
    if (!r) throw new Error('无返回结果');
    if (r.timeout) {
      // 把话说清楚：请求**已经发出去了**，只是没等到响应。
      // 签到这类写操作可能已经生效，面板不能当成「失败」（面板会记为「结果未知」并稍后自动复核）。
      return {
        error: activated
          ? `中继请求超时（前台标签也没等到响应，${Math.round(RELAY_FETCH_TIMEOUT_MS / 1000)}秒）：请求已发出但没收到回包。该站点的反爬可能要求人工验证，或站点暂时不可达 —— 若站点其实处理了，签到可能已生效`
          : `中继请求超时（${Math.round(RELAY_FETCH_TIMEOUT_MS / 1000)}秒）：请求已发出但没收到回包，站点可能已记录（结果未知）`,
      };
    }
    // 把最终 URL 放入特殊头，Worker 端可读取
    const headers = { ...(r.headers || {}), 'x-relay-url': r.url || job.url };
    return { status: r.status, headers, body_base64: r.body_base64 };
  } catch (e) {
    return { error: String(e.message || e).slice(0, 500) };
  } finally {
    // 把焦点还给用户原来的标签
    if (activated && prevActiveId != null) {
      chrome.tabs.update(prevActiveId, { active: true }).catch(() => {});
    }
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
        new Promise((resolve) => setTimeout(() => resolve({ error: `中继执行超时（${Math.round(RELAY_JOB_TIMEOUT_MS / 1000)}秒）：请求已发出但没收到回包，站点可能已记录（结果未知）` }), RELAY_JOB_TIMEOUT_MS)),
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
