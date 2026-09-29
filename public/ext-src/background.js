// 签到面板 Cookie 助手 - 后台执行引擎
// 每小时从面板获取 browser 模式的待执行任务，在用户浏览器中完成签到（使用用户网络），上报结果。

// DEFAULT_PANEL_URL 由面板在用户下载时动态注入（替换 https://your-panel.your-name.workers.dev 占位符）
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
const RELAY_MAX_JOBS_PER_ROUND = 2; // 单轮最多执行几个中继任务（单飞执行，多了会集体超时）
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
// 单轮「浏览器签到任务」的总预算：Service Worker 随时可能被浏览器回收，
// 串着做太久会做到一半被掐掉；用完了剩下的留给下一分钟（面板每分钟都会再下发）。
const JOBS_BUDGET_MS = 90 * 1000;

// ---------- 配置：面板地址 + API Key ----------
//
// 【为什么 Key 不放 storage.sync】sync 里的内容会跟着浏览器账号同步到云端，
// 而这把 API Key 等于「让面板远程指挥你这台机器开标签页、用你的 Cookie 发请求」的钥匙，
// 属于凭据，只应该留在本机（storage.local）。
// 老版本（≤ 2.3）把它写在 sync：这里读不到本地就回退读一次 sync，
// 并把它搬到 local、再把云端那份删掉（迁移只做一次）。
function localArea() {
  try {
    const l = chrome.storage && chrome.storage.local;
    if (l && typeof l.get === 'function' && typeof l.set === 'function') return l;
  } catch { /* 忽略：受限环境（测试台架）没有 local，回退 sync */ }
  return chrome.storage.sync;
}

async function readStore(keys) {
  try { return (await localArea().get(keys)) || {}; } catch { return {}; }
}

async function writeStore(obj) {
  try { await localArea().set(obj); return true; } catch { return false; }
}

// 把 Key 从 sync 迁到 local（本地已经有就不用管）
async function migrateApiKeyFromSync(got) {
  const have = got || {};
  if (have.apiKey) return have;
  try {
    const s = await chrome.storage.sync.get(['apiKey']);
    if (s && s.apiKey) {
      await writeStore({ apiKey: s.apiKey });
      try { if (typeof chrome.storage.sync.remove === 'function') await chrome.storage.sync.remove(['apiKey']); } catch { /* 忽略 */ }
      return { ...have, apiKey: s.apiKey };
    }
  } catch { /* 忽略 */ }
  return have;
}

// 面板地址必须是合法的 http(s) 地址。
// 凭据（Cookie / API Key）都要发到这儿，地址不合法就当作「没配置」——
// 否则等于把一个未知地址当成面板，把用户 Cookie 全送过去。
function normalizePanelUrl(raw) {
  const s = String(raw || '').trim().replace(/\/+$/, '');
  if (!s) return '';
  try {
    const u = new URL(s);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    const path = u.pathname && u.pathname !== '/' ? u.pathname.replace(/\/+$/, '') : '';
    return u.origin + path;
  } catch {
    return '';
  }
}

// 获取面板地址和 API Key
async function getConfig() {
  const got = await migrateApiKeyFromSync(await readStore(['panelUrl', 'apiKey']));
  // 面板地址：已保存 > 下载时注入的默认值（两者都要过合法性校验）
  let url = normalizePanelUrl(got.panelUrl);
  if (!url && typeof DEFAULT_PANEL_URL !== 'undefined' && DEFAULT_PANEL_URL && DEFAULT_PANEL_URL.startsWith('http')) {
    url = normalizePanelUrl(DEFAULT_PANEL_URL);
  }
  return { panelUrl: url, apiKey: String(got.apiKey || '').trim() };
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

// ---------- 汇报：带重试 + 失败暂存 ----------
//
// 为什么必须重试：签到是**写操作**，一次网络抖动就丢掉汇报，
// 面板上那一行会永远停在「待确认」，用户根本不知道到底签上没有。
// 4xx（Key 错 / 参数错）不重试 —— 重试多少次结果都一样；5xx 和网络错误共试 3 次。
const PENDING_REPORTS_KEY = 'pendingReports';
const PENDING_REPORTS_MAX = 20;

async function postWithRetry(panelUrl, apiKey, path, body, attempts = 3) {
  let last = '';
  for (let i = 0; i < attempts; i++) {
    try {
      const resp = await fetch(panelUrl + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Api-Key': apiKey },
        body: JSON.stringify(body),
      });
      if (resp.ok) return { ok: true };
      last = 'HTTP ' + resp.status;
      if (resp.status >= 400 && resp.status < 500) break;
    } catch (e) {
      last = String((e && e.message) || e);
    }
    if (i < attempts - 1) await sleep(600 * (i + 1));
  }
  return { ok: false, error: last };
}

// 送不出去的结果先攒着，下一轮连上就补报（最多 20 条，避免无限堆积）
async function queuePendingReport(body) {
  try {
    const got = await readStore([PENDING_REPORTS_KEY]);
    const list = Array.isArray(got[PENDING_REPORTS_KEY]) ? got[PENDING_REPORTS_KEY] : [];
    list.push({ ...body, at: Date.now() });
    await writeStore({ [PENDING_REPORTS_KEY]: list.slice(-PENDING_REPORTS_MAX) });
  } catch { /* 忽略 */ }
}

// 补报上一轮没送出去的结果（每条只补一次，还失败就继续留着）
async function flushPendingReports(panelUrl, apiKey) {
  let list = [];
  try {
    const got = await readStore([PENDING_REPORTS_KEY]);
    list = Array.isArray(got[PENDING_REPORTS_KEY]) ? got[PENDING_REPORTS_KEY] : [];
  } catch { list = []; }
  if (!list.length) return 0;
  const left = [];
  let sent = 0;
  for (const item of list) {
    const body = {
      account_id: item.account_id,
      status: item.status,
      message: item.message,
      detail: item.detail || '',
      duration_ms: item.duration_ms || 0,
    };
    const r = await postWithRetry(panelUrl, apiKey, '/api/external/report', body, 1);
    if (r.ok) sent++; else left.push(item);
  }
  await writeStore({ [PENDING_REPORTS_KEY]: left.slice(-PENDING_REPORTS_MAX) });
  if (sent) console.log('[签到面板] 补报了 ' + sent + ' 条之前没送出去的结果');
  return sent;
}

// 上报结果到面板（失败会重试，仍失败则暂存等下一轮补报）
async function reportResult(panelUrl, apiKey, accountId, status, message, durationMs) {
  const body = { account_id: accountId, status, message, detail: '', duration_ms: durationMs || 0 };
  const r = await postWithRetry(panelUrl, apiKey, '/api/external/report', body);
  if (!r.ok) {
    console.log('[签到面板] 上报失败（已暂存，稍后补报）：' + r.error);
    await queuePendingReport(body);
  }
  return r.ok;
}

// 原生页面巡检：不依赖 eval / new Function（MV3 已禁止），用于读取网站真实反馈。
// 返回 { ok, message, unsigned?, href? } 或 null。
//
// 判定顺序很关键（都是踩过的坑）：
//   ① 验证码/WAF 优先 —— 这些页面里也夹带「签到」字样（但**只认真实挑战证据**，见下面）
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

      // 1) 人机验证 / 验证码 / WAF：优先判定——这些页面里往往也夹带「签到」字样。
      //
      // ★ 2026-09-28 线上踩坑（「吾爱明明已登录、今天还没签到，面板却报人机验证」的唯一原因）：
      //   以前是拿「整页 HTML」去搜一批中文词，其中包含光秃秃的「验证码」。而 52pojie
      //   **每一个页面**顶栏都有那条公告链接：
      //     title="修复各种访问不了论坛、访问论坛异常、验证码异常等各种问题的大杀器！"
      //   这几个字只存在于 title 属性里、人眼根本看不见，却让浏览器签到 100% 误判成
      //   「遇到人机验证/安全验证」，于是面板上永远只有一句「需人工验证后重试」。
      //   现在的规矩：**中文词只搜可见文本（innerText），技术指纹才搜 HTML。**
      const visibleText = bodyText.replace(/\s+/g, ' ');
      // ① 只有真正的挑战页才会出现的**可见**文案（正常论坛页不会在正文里说这些）
      const CHALLENGE_TEXT = ['请完成安全验证', '完成安全验证', '人机验证', '滑动验证', '拖动滑块', '请拖动滑块', '智能验证', '请完成验证', '安全验证失败', '正在检查您的浏览器', '检查浏览器中', '请输入验证码', '请填写验证码', '验证码不正确', '验证码错误'];
      // ② 技术指纹：挑战脚本 / 挂载点（不算「验证码」这种正文里也可能出现的词）
      const CHALLENGE_SIG = ['wzws-waf-cgi', 'slidercaptcha', 'geetest', 'grecaptcha', 'hcaptcha', 'turnstile', 'challenge-platform', 'cf_chl', 'Just a moment', 'checking your browser', 'turing.captcha.qcloud.com', 'TCaptcha', 'CaptchaAId'];
      // ③ 挑战控件：真的有验证码输入框 / 滑块 iframe 才算（52pojie 正常页面上一个都查不到，已实测）
      const CHALLENGE_DOM = '[class*=geetest],[id*=geetest],[class*=slidercaptcha],[id*=slidercaptcha],[class*=turnstile],[id*=turnstile],iframe[src*=captcha],iframe[src*=geetest],#captcha,[id*=captcha],.verifyimg,input[name*=seccode],input[id*=seccode]';
      // ⓪ 网宿 WZWS 挑战页（实测 2026-09-28：吾爱破解的 /home.php* 一律先回这一页）：
      //    它是**纯 JS 自动过**的 —— 浏览器把页内那段混淆脚本跑完、POST /waf_zw_verify
      //    拿到新的 wzws_sid 就自动继续，**不需要人点任何东西**。
      //    所以不能归到「请人工过验证」那一类：那样只会把人引向一个根本不存在的滑块。
      //    如实说明，并指出去读首页就能拿到真状态。
      const wzwsHit = (html.match(/wzws-waf-cgi|wzwsquestion|WZWS_CONFIRM_PREFIX_LABEL|\/waf_zw_verify/) || [''])[0];
      if (wzwsHit) {
        return { ok: false, waf: 'wzws',
                 message: '这一页是网宿 WAF（WZWS）的 JS 挑战页，浏览器会自动过掉，不需要人工操作｜命中：' + wzwsHit
                   + '｜说明：/home.php 这类动态地址首次访问都会先回它，跑完 JS 就继续（别把它当成签到结果）｜想直接看当天状态可以读首页｜页面：' + title };
      }
      const challengeText = CHALLENGE_TEXT.find((m) => visibleText.includes(m)) || '';
      const challengeSig = CHALLENGE_SIG.find((m) => html.includes(m)) || '';
      let challengeDom = '';
      try { challengeDom = document.querySelector(CHALLENGE_DOM) ? CHALLENGE_DOM : ''; } catch { challengeDom = ''; }
      // 挑战页还有一个共同点：正文几乎空白（只有一句提示 + 一个转圈）。
      // 用它兜住「没有明显文案的挑战页」（如网宿 WZWS），同时不会误伤信息量正常的论坛页。
      const blankPage = visibleText.replace(/\s+/g, '').length < 200;
      const sigFired = !!(challengeSig && blankPage);
      const challengeHit = challengeDom || challengeText || (sigFired ? challengeSig : '');
      if (challengeHit) {
        const why = [challengeDom && '验证控件', challengeText && '挑战文案', sigFired && '挑战脚本'].filter(Boolean).join('+');
        return { ok: false, message: '遇到人机验证/安全验证（验证码/滑块），需人工验证后重试｜命中：' + why + '（' + challengeHit.slice(0, 48) + '）｜页面：' + title };
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

      // 找到入口元素时**当场给它打个标记**，并把选择器随结果一起返回。
      // 为什么不在外面再 querySelector 一次：入口往往是「图片包在 <a> 里」这种奇怪结构
      // （吾爱首页：`<a href="…do=apply…"><img src="…/qds.png"></a>`），
      // 外面按通用选择器重找很可能落到另一个元素上 —— 点了等于没点。
      const PANEL_SIGN_SEL = '[data-panel-sign="1"]';
      const markEl = (el) => {
        try { if (el && el.setAttribute) { el.setAttribute('data-panel-sign', '1'); return PANEL_SIGN_SEL; } } catch (e) { /* 注入环境可能没有 DOM */ }
        return '';
      };
      const findSignLink = () => {
        // ⓪ 站点自己的「打卡签到」入口优先：Discuz 顶部用户菜单里的
        //    <a href="home.php?mod=task&do=apply&id=2"><img src="…/qds.png"></a>
        //    社区脚本用的就是这个选择器（XIU2 的「吾爱破解论坛增强」：
        //    `#um a[href^="home.php?mod=task&do=apply&id=2"]`）。
        //    为什么先看它：这个入口在**每个页面**都有（首页/版块页/任务页），签完就消失，
        //    所以「它还在不在」是**页面无关**的服务端状态 —— 也才能拿首页当复查页。
        let umLink = null;
        try {
          umLink = document.querySelector('#um a[href*="do=apply"], #um a[href*="do=draw"], #um .click-qiandao, #um .qq_bind');
        } catch { umLink = null; }
        if (umLink) {
          const anchor = (umLink.tagName === 'IMG' && umLink.closest) ? (umLink.closest('a') || umLink) : umLink;
          const own = textOf(anchor) + ' ' + attrOf(anchor) + ' ' + imgsOf(anchor);
          const href = (anchor.getAttribute && anchor.getAttribute('href')) || '';
          if (!ALREADY.test(textOf(anchor)) && !/wbs\.png/i.test(own)) {
            const row = (anchor.closest && (anchor.closest('li') || anchor.closest('tr'))) || null;
            const rowTxt = ((row && row.innerText) || '').replace(/\s+/g, ' ').slice(0, 200);
            const rowDone = /已完成|已申请|已领取|已打卡/.test(rowTxt) && !/立即申请|马上申请|申请任务/.test(rowTxt);
            if (rowDone) return { href, label: (textOf(anchor) || '打卡签到'), done: true };
            if (href) return { href, clickSel: markEl(anchor), label: (textOf(anchor) || '打卡签到'), done: false };
          }
        }

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
            return { href: a.getAttribute('href') || '', clickSel: markEl(a), label: (textOf(a) || '打卡签到'), done: false };
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
        // findSignLink 已经在入口元素上打过标记了（图片版入口那种），直接用那一个
        try { if (document.querySelector(PANEL_SIGN_SEL)) return PANEL_SIGN_SEL; } catch (e) { /* 无 DOM */ }
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
      // 3.5) 「签到完毕」图标 wbs.png —— 社区脚本（XIU2 的吾爱增强、lyc8503 的签到脚本）
      //      都拿它当「今天已经签过」的判据：站点靠换图标表示状态（qds.png 未签 / wbs.png 已签），
      //      文字节点是空的。图标名很特殊，不会在正文里乱出现；
      //      放在「还挂着入口」之前判断，避免因为入口链接还在而误判为未签。
      if (/wbs\.png/i.test(all)) return { ok: true, message: '今日已签到，无需重复（网站图标：签到完毕 wbs.png）' };
      // 4) 未登录（Discuz 游客页会写「注册[Register]」）—— 比「未签到」更优先：
      //    登录失效时页面导航里也有「每日签到」这类字样，不能把它当成“还没签到”。
      // ★ 2026-09-28 实测抓到的第二个「拿 HTML 搜中文」的坑，和上次那个「验证码异常」公告一模一样：
      //   Discuz 每个页面（**包括登录态首页**）都带一段隐藏的快捷登录菜单：
      //     <div id="qmenu_menu" style="display: none">请 登录 后使用快捷导航…注册[Register]</div>
      //   它只存在于 HTML 里（innerText 里根本没有，因为它 display:none）。
      //   以前这条判定搜的是 `all = 可见文本 + 整页 HTML`，于是**登录得好好的首页也会被判成
      //   「登录已失效，请重新获取 Cookie」**。改用可见文本（innerText）：
      //   真掉登录态时，游客页顶部那个登录表单是**看得见**的，仍然能判出来。
      if (/需要先登录|请先登录|还未登录|请登录后|登录已失效|登录失效|请重新登录|未登录|注册\[Register\]|立即注册|登录后才能/.test(visibleText)) {
        return { ok: false, message: '登录已失效，请重新获取 Cookie' };
      }
      // 页面上写着「还没签到」却找不到可点的入口（插件式签到页、被遮挡的按钮）：
      // 如实报未签到，并说清要人工处理，不要吐一句“未识别到成功标识”。
      if (!link && /打卡签到|立即签到|点击打卡|每日签到|每日打卡|还没有签到|未打卡|qds\.png/.test(all)) {
        return { ok: false, unsigned: true, href: '', clickSel: '',
                 message: '网站显示还没签到（打卡入口/图标 qds.png 还在），但页面上找不到可点的签到入口' };
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

// 校验一个「站点自己给的绝对地址」（navigate_url / sign_url / verify_urls 都走它）：
// 只允许 http(s)，且必须落在目标任务域上（本域、子域，或反过来域名是它的子域）。
// 这些地址全部来自面板下发的配置，同样是不可信输入 —— 不能拿用户的标签页去跳任意站点。
// 把面板给的 Cookie 写进浏览器、并让「浏览器签到」这条路真的能走通。
//
// 为什么需要它：吾爱破解这类站点，签到动作必须由浏览器亲自发出（WAF 只放行真实页面导航），
// 而服务端认的是**浏览器 cookie jar 里的那个登录态**。浏览器没登录时，这条路一步都走不下去；
// 面板里又恰好存着这份登录态（当初就是扩展从浏览器读出去交给面板的），所以由面板把它交回来最顺。
// 于是「面板点一下 → 自动签到」才是完整的闭环，不需要人先去浏览器登录一遍。
// ============ 「自动过的挑战」要等它过完，别急着下结论 ============
//
// 实测（2026-09-28，吾爱破解）：/home.php?mod=task 与 /home.php?mod=task&do=apply&id=2
// 无论带不带 Cookie、带不带 Referer，都先回一张网宿 WZWS 的 JS 挑战页。
// 这张页子是**纯 JS 自动过**的：浏览器跑完脚本（POST /waf_zw_verify 换一张新票）会自动
// 继续到真页面，全程不需要人点任何东西。
//
// 所以「点完入口立刻看一眼」看到的往往还是挑战页 —— 在那里就报结论，等于把一次
// 已经成功的签到判成失败（或者反过来让人去找一个根本不存在的滑块，以前就这么干过）。
// 这里的做法：看到这种页子就等一会儿再看，最多等 AUTO_PASS_TRIES 轮。
// 真的等不到才如实说「等了 N 秒仍未跳转」，并把耗时写进结论里。
const AUTO_PASS_WAIT_MS = 2000;
const AUTO_PASS_TRIES = 5; // 最长约 10 秒

async function waitAutoPassedChallenge(tabId, first) {
  let cur = first;
  let waited = 0;
  for (let i = 0; i < AUTO_PASS_TRIES; i++) {
    if (!cur || cur.ok || cur.waf !== 'wzws') break;
    await new Promise((r) => setTimeout(r, AUTO_PASS_WAIT_MS));
    waited += AUTO_PASS_WAIT_MS;
    const again = await inspectPage(tabId).catch(() => null);
    if (!again) break;
    cur = again;
  }
  if (cur && cur.waf === 'wzws' && waited) {
    cur = Object.assign({}, cur, {
      message: String(cur.message || '') + `（已等 ${Math.round(waited / 1000)} 秒仍未跳转，说明这次挑战没能自动过掉）`,
    });
  }
  return cur;
}

//
// 这段能力很重（写 cookie = 改这个站的登录身份），所以自己再守一道：
//   ① 只写给任务声明的那个域（job.domain，已经过 sameSiteHttpUrl 同域校验）；
//   ② 只写面板给的那些名值，不读回、不上报、**日志里不打值**；
//   ③ 明确跳过 WAF/CF 自己的会话票（wzws_sid / cf_clearance …）：
//      那张票由浏览器现场过一遍挑战拿新的才对，灌一个旧的进去反而自讨苦吃；
//   ④ 单条写失败不影响其他，整体失败也不阻断签到流程（就当没注入，如实记日志）。
// 写之前先看一眼浏览器里已有什么。三种情况：
//   none —— 没登录过/已清干净 → 该写（这正是我们要修的主场景）
//   same —— 已经有同名同值的凭据（同一个会话）→ **不用写**（浏览器自己那份就是对的）
//   diff —— 有同名的但值不一样：浏览器登录的是**另一个会话**，很可能是另一个账号。
//           这时候绝对不能硬写：写下去会把人家在浏览器里的登录顶掉；更坏的是，
//           如果不写而直接用浏览器那个会话去点签到，就会「用 B 的登录态签上，面板上记成 A 成功」
//           —— 那就成了假状态。宁可不签，也要把话说清楚。
async function existingAuthState(host, cookieStr) {
  const SENSITIVE = /(_auth$|_auth\b|saltkey|^session|sessionid|passport|pwd)/i;
  if (!chrome.cookies || typeof chrome.cookies.get !== 'function' || !host || !cookieStr) return 'none';
  let same = false;
  for (const part of String(cookieStr).split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const name = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    if (!SENSITIVE.test(name)) continue;
    let cur = null;
    try { cur = await chrome.cookies.get({ url: 'https://' + host + '/', name }); } catch { cur = null; }
    if (!cur || typeof cur.value !== 'string') continue;
    if (cur.value !== value) return 'diff';
    same = true;
  }
  return same ? 'same' : 'none';
}

// ============ 会话续命（alist 式）：把站点轮换后的新 Cookie 回写面板 ============
//
// alist 对网盘 token 的做法：请求过程中令牌被服务端轮换（refresh token rotation），
// 就把新令牌当场写回存储，而不是等它过期后人工重新填。我们这里同理：
// 签到过程本身会让站点下发新会话（Set-Cookie 换发登录名、WAF 换票），
// 签完还把旧值留在面板里，等于让凭据「计划性报废」——过几天必然「登录已失效」。
//
// 规矩（和服务端 /api/external/creds-rotation 配套）：
//   ① 只在「任务确实注入过凭据」的站点上做（浏览器里那份就是面板给的同一会话，才谈得上轮换）；
//   ② 只把「登录名类」Cookie 的**值有变化**的条目报上去，整包不变就不发请求（省 D1 配额）；
//   ③ 面板还会再做同域 + 内容两道校验，这里被拒就打日志，绝不重试（不是网络问题）。
const ROTATION_SENSITIVE = /(_auth$|_auth|saltkey|^session|sessionid|passport|pwd|token)/i;

// 采集某域名下浏览器 cookie jar 里的「登录名类」条目（名 -> 值）
async function collectAuthCookies(host) {
  const out = new Map();
  if (!chrome.cookies || typeof chrome.cookies.getAll !== 'function' || !host) return out;
  let list = [];
  try { list = await chrome.cookies.getAll({ domain: host }) || []; } catch { list = []; }
  // 与 collectCookies（popup）同一套兜底：url 查询能带上父域 Cookie
  try {
    const more = await chrome.cookies.getAll({ url: 'https://' + host + '/' }) || [];
    for (const c of more) if (c && c.name && !out.has(c.name)) out.set(c.name, c);
  } catch { /* 忽略 */ }
  for (const c of list) if (c && c.name) out.set(c.name, c);
  for (const [name, c] of Array.from(out)) {
    if (!ROTATION_SENSITIVE.test(name)) out.delete(name);
    else out.set(name, String(c.value || ''));
  }
  return out;
}

// 与面板库里的旧值比对：只有「同名不同值」才算轮换。返回 null 或 { changed: 'a=..; b=..' }
function diffRotated(newMap, oldCookieStr) {
  const oldMap = new Map();
  for (const part of String(oldCookieStr || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) oldMap.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
  }
  const changed = [];
  for (const [name, val] of newMap) {
    const old = oldMap.get(name);
    if (old !== undefined && old !== val && val) changed.push(name + '=' + val);
  }
  return changed.length ? { changed: changed.join('; ') } : null;
}

// 签到结束后调用：发现轮换就回写面板（失败只打日志，不影响签到结果本身）
async function reportCookieRotation(panelUrl, apiKey, job, host) {
  try {
    if (!panelUrl || !apiKey || !job || !job.inject_cookies || !job.cookie) return;
    const fresh = await collectAuthCookies(host);
    if (!fresh.size) return;
    const d = diffRotated(fresh, job.cookie);
    if (!d) return; // 没变化，一个请求都不发
    const resp = await fetch(panelUrl + '/api/external/creds-rotation', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Api-Key': apiKey },
      body: JSON.stringify({ account_id: job.account_id, domain: 'https://' + host + '/', cookies: d.changed }),
    });
    if (resp.ok) {
      const n = d.changed.split(';').length;
      console.log('[签到面板] 检测到站点轮换了登录 Cookie，已把 ' + n + ' 条新值回写面板（' + host + '）');
    } else {
      console.log('[签到面板] Cookie 回写被面板拒绝（HTTP ' + resp.status + '），不影响签到结果');
    }
  } catch (e) {
    console.log('[签到面板] Cookie 回写失败（不影响签到结果）：', String((e && e.message) || e).slice(0, 120));
  }
}

async function injectCookies(domain, cookieStr) {
  const host = String(domain || '').replace(/^\./, '').trim().toLowerCase();
  if (!host || !cookieStr) return 0;
  if (!chrome.cookies || typeof chrome.cookies.set !== 'function') return 0; // 老浏览器没有这个能力
  const SKIP = /^(wzws_sid|__jsl|cf_clearance|__cf)/i;
  // 登录凭据类写成 HttpOnly（站点自己也是这么下的）；其余保持可读，免得站点 JS 读不到自己的值
  const SENSITIVE = /(_auth$|_auth\b|saltkey|^session|sessionid|passport|pwd)/i;
  let n = 0;
  for (const part of String(cookieStr).split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const name = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    if (!name || SKIP.test(name)) continue;
    try {
      await chrome.cookies.set({
        url: 'https://' + host + '/', name, value, path: '/',
        secure: true, sameSite: 'lax', httpOnly: SENSITIVE.test(name),
      });
      n++;
    } catch (e) { /* 单个 cookie 写失败（如名字非法）不影响其它 */ }
  }
  return n;
}

function sameSiteHttpUrl(raw, domain) {
  try {
    const u = new URL(String(raw || ''));
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    const d = String(domain || '').trim().toLowerCase();
    if (!d) return u.href; // 站点没声明的（如自定义站点）不额外限制
    const h = u.hostname.toLowerCase();
    if (h === d || h.endsWith('.' + d) || d.endsWith('.' + h)) return u.href;
    return '';
  } catch {
    return '';
  }
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

// ============ 「只动我们自己的标签页」 ============
//
// 浏览器签到需要目标站点的一个标签页来发请求/点按钮。旧做法是「优先复用同域名下已存在的标签页」，
// 于是：用户正在看 52pojie 的那个标签页被扩展拿去导航来导航去（任务页 → 签到链接 → 再读一遍），
// 用户看到的就是「浏览器签到乱跳」，甚至自己正在读的页面被改掉。
//
// 现在的规矩：**用户的标签页一律不碰**（不看、不导航、不关闭），只用我们自己开的标签页；
// 同一个域名只开**一个**，后续请求复用，空闲一段时间后自动关掉（见 RELAY_TAB_IDLE_MS）。
// 新建的标签页用 active:false（后台打开），不抢焦点。
const ownTabs = new Map(); // tabId -> { domain, at }
const OWN_TAB_TTL_MS = 10 * 60 * 1000;
// 中继专用标签页的空闲回收时间：比上面短得多。
// 一次签到（比如糊涂鳄）要打好几个请求（首页 → 主题 JS → 签到接口），
// 以前**每个请求**都开一个标签页、用完立刻关 —— 用户看到的就是「浏览器一直在新建页面」。
// 现在改成：一个域名只开一个后台标签页，后续请求都复用它；
// 连续 45 秒没用到才关掉（够覆盖一次签到的全部请求，又不会一直挂着）。
const RELAY_TAB_IDLE_MS = 45 * 1000;

function sameDomain(url, domain) {
  try {
    const h = new URL(String(url)).hostname;
    const d = String(domain || '');
    return !!d && (h === d || h.endsWith('.' + d));
  } catch {
    return false;
  }
}

function rememberOwnTab(id, domain) {
  if (id == null) return;
  ownTabs.set(id, { domain: String(domain || ''), at: Date.now() });
  // 清掉过期记录。
  // 【以前只删记录、不关标签页】——一旦某个域名超过 10 分钟没再用到，它的记录会被这里悄悄丢掉，
  // 之后 sweepOwnTabs 就再也不认识那个标签页了（回收是照着 ownTabs 关的），
  // 于是我们在用户浏览器里留了一个永远没人管的标签页。现在顺手一起关掉。
  for (const [tid, info] of Array.from(ownTabs)) {
    if (tid === id || Date.now() - info.at <= OWN_TAB_TTL_MS) continue;
    ownTabs.delete(tid);
    try { chrome.tabs.remove(tid).catch(() => {}); } catch { /* 已经关了就算了 */ }
  }
}

function forgetOwnTab(id) {
  ownTabs.delete(id);
}

// 找一个「我们自己开的、还是这个域名」的标签页（没有就返回 null）。
// 复用时刷新使用时间：有它在，sweepOwnTabs 才知道这个标签页还在干活。
async function findOwnTab(domain) {
  if (!ownTabs.size) return null;
  let tabs = [];
  try { tabs = await chrome.tabs.query({}); } catch { return null; }
  for (const t of tabs || []) {
    if (!ownTabs.has(t.id)) continue;
    if (!sameDomain(t.url || t.pendingUrl, domain)) continue;
    const info = ownTabs.get(t.id);
    if (info) info.at = Date.now();
    return t;
  }
  return null;
}

// 开一个「用户看不见」的签到窗口，并等页面加载完。
//
// 【为什么要独立窗口而不是普通标签页】以前用 chrome.tabs.create({active:false}) 后台标签页：
// 不抢焦点没错，但浏览器标签栏上会多出「签到用的标签页」，一次签好几个站时标签栏挤满
// 「52pojie / nodeseek / …」，用户观感就是「浏览器总在开新标签页」。
// 现在开在一个**最小化的独立窗口**里：
//   · chrome.windows.create({focused:false}) 不抢焦点，落地后立即 minimize 到任务栏；
//   · 任务栏里始终只有一个「签到面板助手」窗口，所有站点的标签页都收在它里面；
//   · 页面照常加载、JS 照常跑、Cookie 照常带 —— 签到逻辑一行不用改。
// 回收：sweepOwnTabs 照旧按空闲关标签页；窗口里最后一个标签页被关掉时窗口自己消失，
// 另外 rememberOwnTab 里 TTL 到期也会顺手关（见下）。
let signWindowId = null; // 签到专用窗口的 id（可能已被用户关掉，用时校验）

async function ensureSignWindow() {
  if (signWindowId != null) {
    try { await chrome.windows.get(signWindowId); return signWindowId; } catch { signWindowId = null; }
  }
  const win = await chrome.windows.create({ url: 'about:blank', focused: false, type: 'normal' });
  signWindowId = win.id;
  try { await chrome.windows.update(win.id, { state: 'minimized' }); } catch { /* 个别环境不支持 minimized，不碍事 */ }
  return win.id;
}

async function openOwnTab(domain, url) {
  const winId = await ensureSignWindow().catch(() => null);
  // 万一窗口建不出来（极少数受限环境），退回老办法：后台标签页，功能不受影响
  const tab = winId != null
    ? await chrome.tabs.create({ windowId: winId, url: url || `https://${domain}/`, active: true })
    : await chrome.tabs.create({ url: url || `https://${domain}/`, active: false });
  rememberOwnTab(tab.id, domain);
  await waitTabComplete(tab.id, 15000);
  return tab;
}

// 在目标域名的标签页中执行签到
//
// 【2026-09-28 安全整改：删掉了 runPanelScript】
// 以前这里有个「执行面板下发脚本字符串」的路径（new Function(scriptStr)）。
// 两个理由把它整个删掉：
//   ① MV3 里 new Function / eval 一律被禁 —— 这条路径在真实浏览器里 100% 失败，纯死代码；
//   ② 万一哪天限制放宽，它就变成一个现成的「远程代码执行」入口：
//      面板（或面板数据库里的站点配置）能往用户浏览器里塞任意脚本。
// 页内判定一律走下面的原生巡检（inspectPage），不再执行任何字符串代码。
async function executeJob(job) {
  const startMs = Date.now();
  let tab = null;
  let created = false;
  try {
    // 与 popup 保持一致：缺域名时直接报错，避免误开 https://undefined/ 标签页
    if (!job.domain) throw new Error('任务缺少目标域名');
    // 【不碰用户的标签页】只复用我们自己开的，没有就开一个新的后台标签页。
    // 以前的「复用同域名已有标签页」会把用户正在看的页面导航走（「浏览器签到乱跳」的来源）。
    tab = await findOwnTab(job.domain);
    if (!tab) {
      tab = await openOwnTab(job.domain);
      created = true;
    }

    // 站点声明「需要浏览器处于登录态」时，先把面板里的登录态写回浏览器（见 injectCookies）。
    // 顺序很重要：必须在导航之前写，否则第一次巡检读到的还是未登录页。
    if (job.inject_cookies && job.cookie) {
      // 关键：写入目标取「我们真的要去访问的那个主机名」，而不是面板自称的 job.domain。
      // job.domain 同样是面板给的输入，只拿它自己跟自己比毫无意义（它说自己是哪个域都行）；
      // navigate_url 过完同站校验后剩下的主机名，才是这次真实要落的域。
      const navForHost = sameSiteHttpUrl(job.navigate_url || '', job.domain);
      let host = '';
      try { host = navForHost ? new URL(navForHost).hostname.toLowerCase() : ''; } catch { host = ''; }
      const declared = String(job.domain || '').replace(/^www\./, '').toLowerCase();
      const hostOk = host && declared && (host === declared || host.endsWith('.' + declared) || declared.endsWith('.' + host));
      if (!hostOk) {
        console.log('[签到面板] 拒绝把登录态写到非本域：要访问的是 ' + (host || '(无)') + '，声明的是 ' + (job.domain || '(无)').slice(0, 60));
      } else if ((await existingAuthState(host, job.cookie)) === 'diff') {
        // 浏览器里是另一个登录会话：不写、也不签 —— 直接把话说清楚
        // （否则很容易出现「浏览器里是 B、面板里记的是 A」的假状态）
        const msg = '浏览器里已经登录了这个网站的另一个账号或会话，为避免签错账号（以及把你在浏览器里的登录顶掉），'
          + '本次没有写回面板里的登录态、也没有执行签到。请在浏览器里退出该网站的登录（或清掉这个网站的 Cookie）后重试，'
          + '面板下次会自动把登录态写回去。';
        console.log('[签到面板] 浏览器已有另一个登录会话，跳过本次执行（不写凭据、不签到）');
        return { status: 'fail', message: msg, durationMs: Date.now() - startMs };
      } else if ((await existingAuthState(host, job.cookie)) === 'same') {
        // 浏览器里就是同一个会话（同名同值）：不用写，直接用人家自己那份
        console.log('[签到面板] 浏览器里已经是同一个登录会话，不需要写回凭据');
      } else {
        const n = await injectCookies(host, job.cookie).catch(() => 0);
        console.log(n
          ? '[签到面板] 已把 ' + n + ' 条登录 Cookie 写回浏览器（' + host + '，值不记录）'
          : '[签到面板] 没有写入任何登录 Cookie（浏览器可能不支持，或面板没给）');
      }
    }

    // 如果任务指定了导航 URL（如吾爱破解的任务页），先导航过去（模拟手动点击）再巡检。
    // 两个要点：
    //   ① navigate_url 也要过同站校验 —— 它同样来自面板下发的配置，不是我们自己写死的常量；
    //   ② 用 waitTabComplete，而不是就地再抄一遍监听器 —— 老写法在「20 秒超时」那一支忘了摘监听器
    //      （只 resolve、不 removeListener），任务做得越多监听器积得越多。
    if (job.navigate_url) {
      const navUrl = sameSiteHttpUrl(job.navigate_url, job.domain);
      if (navUrl) {
        await chrome.tabs.update(tab.id, { url: navUrl });
        await waitTabComplete(tab.id, 20000);
        await new Promise((r) => setTimeout(r, 2000));
      } else {
        console.log('[签到面板] 忽略跨站/非法的导航地址：', String(job.navigate_url).slice(0, 120));
      }
    }

    // 执行签到：页内判定一律走原生巡检（不执行面板下发的任何脚本字符串，见上面的安全说明）。
    let result = await inspectPage(tab.id);
    if (!result) throw new Error('无法读取页面内容（标签页可能已关闭或被重定向）');
    // 落在 WZWS 这类「JS 自动过」的挑战页上时不能立刻下结论（见 waitAutoPassedChallenge 的说明）
    result = await waitAutoPassedChallenge(tab.id, result);
    if (!result) throw new Error('无法读取页面内容（标签页可能已关闭或被重定向）');

    // 页面还挂着「打卡签到」入口 = 服务端认为今天没签。
    // ① 是链接（吾爱破解这类 Discuz 任务）→ 导航过去，等同人手点一下；
    // ② 是 JS 按钮（dsu_paulsign / k_misign 等插件）→ 在页面里点一下。
    // 两条路都是真实用户行为，之前实测过：脚本化 fetch 会被 WAF 吊死，而导航/点击能过。
    if (!result.ok && result.unsigned) {
      const signHref = resolveSignHref(result, tab);
      try {
        // 顺序很重要：**先点页面上的真入口，点不动再退回直接导航**。
        // 点了才是「人手点一下」的样子：同源 GET、带 Referer、复用本页已经过掉的 WAF 会话。
        // 直接 chrome.tabs.update 过去等于发起一次全新的顶层请求 ——
        // 吾爱这类站点的 /home.php* 一律先回一张网宿 WZWS 挑战页（实测：带不带 Cookie、
        // 带不带 Referer 都一样），浏览器得先把挑战跑完才能落到真页面，又慢又容易被误判。
        const urlBefore = ((await chrome.tabs.get(tab.id).catch(() => null)) || {}).url || '';
        let clicked = false;
        if (result.clickSel) {
          try {
            await chrome.scripting.executeScript({
              target: { tabId: tab.id },
              func: (sel) => { const el = document.querySelector(sel); if (el) el.click(); },
              args: [result.clickSel],
            });
            clicked = true;
            await waitTabComplete(tab.id, 15000);
            await new Promise((r) => setTimeout(r, 2000));
          } catch (e) {
            console.log('[签到面板] 页内点击失败，改为直接导航入口地址：', e.message || e);
          }
        }
        const urlAfterClick = ((await chrome.tabs.get(tab.id).catch(() => null)) || {}).url || '';
        const moved = clicked && urlAfterClick && urlAfterClick !== urlBefore;
        if (signHref && !moved) {
          // 没有可点元素，或者点了没跳（站点用 AJAX 结算时也可能不跳）—— 再按入口地址跳一次；
          // Discuz 对重复的 apply 是幂等的（第二次只会告诉你「已经领取过」）。
          await chrome.tabs.update(tab.id, { url: signHref });
          await waitTabComplete(tab.id, 20000);
          await new Promise((r) => setTimeout(r, 2000));
        }
        const after = (signHref || result.clickSel)
          ? await waitAutoPassedChallenge(tab.id, await inspectPage(tab.id))
          : null;
        if (after) result = after;
      } catch (e) {
        console.log('[签到面板] 触发签到失败：', e.message || e);
      }
    }

    // 连入口都没认出来（站点改版/插件页），但面板给了「签到地址」——那是站点模块自己知道的，
    // 再试一次，别白自放弃（同源校验后仍然只跳本域）。
    if (!result.ok && result.unsigned && !result.href && !result.clickSel && job.sign_url) {
      const signUrl = sameSiteHttpUrl(job.sign_url, job.domain);
      if (!signUrl) {
        console.log('[签到面板] 忽略跨站/非法的兜底签到地址：', String(job.sign_url).slice(0, 120));
      } else {
        try {
          await chrome.tabs.update(tab.id, { url: signUrl });
          await waitTabComplete(tab.id, 20000);
          await new Promise((r) => setTimeout(r, 2000));
          const after = await waitAutoPassedChallenge(tab.id, await inspectPage(tab.id));
          if (after) result = after;
        } catch (e) {
          console.log('[签到面板] 兜底签到地址不可用：', e.message || e);
        }
      }
    }

    // ============ 触发完之后：回「任务页」复查服务端真实状态 ============
    //
    // ★ 为什么必须有这一步（2026-09-28 吾爱破解实测）：
    //   点完「去签到」之后，Discuz 的任务页往往只是刷新/跳回列表——
    //   既没有「任务已完成」，也没有「打卡签到」，扩展只能含糊地报「未识别到成功标识」，
    //   于是面板上这一行永远显示失败：签没签上都看不出来，用户只能自己去网站手点一遍。
    //   而任务页上那条 `do=apply` 链接是**服务端状态**：
    //     · 链接还在 = 今天真的没签上
    //     · 链接没了 / 本行写着「已完成」= 今天已经签上了
    //   以它为准，比在结果页里猜文案硬得多。
    //
    // 复查地址由站点自己声明（browserJob 里的 verify_urls / verify_url）；没声明就不动 ——
    // 不给自己找活干，也不去别的站点乱跳。
    // 安全：页面内容不可信，复查只允许同域（http/https）；导航只在我们自己的后台标签页里发生。
    //
    // 为什么可以给多个地址（社区两边都在用，互为补充）：
    //   · 任务页（home.php?mod=task）—— 那条 do=apply 链接就是服务端状态；
    //   · 站点的任意页面（含首页）—— Discuz 顶部用户菜单 `#um` 里也挂着同一个入口，
    //     签完就消失；站点还要把图标换成 wbs.png（「签到完毕」）。
    //   一个地址说不清或说「还没签」时，再看下一个；只要有一个说已签就报成功。
    // ============ 「报成功之前先跟站点核对」 ============
    // 结果页说成功，有可能只是页面文案；而首页上那个入口 / 图标是**服务端状态**。
    // 站点声明 confirm_before_report 时，结果页说成功也要再看一眼，两个证据对上了才敢报成功。
    // 三种结局一个都不含糊（“状态真实无误”就靠这一段）：
    //   ① 首页也说已签 → ok，并在反馈里写明是复查确认过的；
    //   ② 首页仍挂着入口（等几秒再读一次仍如此）→ fail，并写明“结果页说成功、首页说没签”的矛盾；
    //   ③ 复查页读不到/说不清 → 保留结果页结论，但注明“未能复查”，不假装核实过。
    let reconciled = false; // 已经被「核对」环节给出结论了，后面的老复查就不要把它覆盖掉
    if (result.ok && job.confirm_before_report) {
      const confirmTargets = [];
      if (Array.isArray(job.verify_urls)) confirmTargets.push(...job.verify_urls);
      if (job.verify_url) confirmTargets.push(job.verify_url);
      let confirmed = false;
      let contradicted = false;
      let checked = 0;
      for (const t of confirmTargets) {
        const v = sameSiteHttpUrl(t, job.domain); // 只回本站核对，跨站一律跳过
        if (!v) continue;
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            await chrome.tabs.update(tab.id, { url: v });
            await waitTabComplete(tab.id, 20000);
            await new Promise((r) => setTimeout(r, attempt === 0 ? 1200 : 1800));
            const back = await inspectPage(tab.id);
            if (!back) break;
            checked++;
            if (back.ok) { confirmed = true; break; }
            if (back.unsigned) { contradicted = true; continue; } // 服务端可能要一小会儿才更新，再读一次
            break; // 页面上说不清，不强求
          } catch (e) {
            console.log('[签到面板] 复查失败：', e.message || e);
            break;
          }
        }
        // 只有「确认已签」才能提前收工；「说没签」要继续看下一个复查页
        // （首页说没签、任务页写「已完成」这种情况要以后者为准，不能因为第一个说法就下结论）
        if (confirmed) break;
      }
      if (confirmed) {
        result = { ok: true, message: String(result.message || '') + '（已回站点复查确认：今日已签到）' };
        reconciled = true;
      } else if (contradicted && checked) {
        result = { ok: false,
                   message: '结果页显示「' + String(result.message || '').slice(0, 40)
                     + '」，但回站点复查时首页仍挂着打卡入口 —— 两边对不上，本次按“没签上”记，稍后会自动重试' };
        reconciled = true;
      } else if (checked) {
        result = { ok: true, message: String(result.message || '') + '（未能复查确认，按结果页记）' };
        reconciled = true;
      }
    }

    if (!result.ok && !reconciled) {
      const rawTargets = [];
      if (Array.isArray(job.verify_urls)) rawTargets.push(...job.verify_urls);
      if (job.verify_url) rawTargets.push(job.verify_url);
      const targets = [];
      for (const t of rawTargets) {
        const v = sameSiteHttpUrl(t, job.domain); // 只复查本站地址，跨站一律跳过
        if (v && !targets.includes(v)) targets.push(v);
      }
      let sawAmbiguous = false;
      for (const verifyUrl of targets) {
        try {
          await chrome.tabs.update(tab.id, { url: verifyUrl });
          await waitTabComplete(tab.id, 20000);
          await new Promise((r) => setTimeout(r, 1500));
          const after = await inspectPage(tab.id);
          if (!after) continue;
          if (after.ok) {
            result = { ok: true, message: '签到成功（已回站点复查确认）：' + String(after.message || '') };
            break;
          }
          if (after.unsigned) {
            result = { ...after, message: '复查（' + verifyUrl.replace(/^https?:\/\/[^/]+/, '') + '）：' + String(after.message || '今天还没有签上') };
            continue;
          }
          sawAmbiguous = true;
        } catch (e) {
          console.log('[签到面板] 复查失败：', e.message || e);
        }
      }
      // 复查地址都说不清（既非成功也非未签）：保留原结论，但注明「已复查过」
      if (!result.ok && sawAmbiguous && !result.unsigned) {
        result = { ...result, message: String(result.message || '未识别到成功标识') + '（已回站点复查，仍未识别到已签到标识）' };
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
    // 只关闭「我们自己开的」标签页（用户的标签页一律不动），避免累积一堆后台标签页
    if (created && tab && tab.id != null) {
      forgetOwnTab(tab.id);
      chrome.tabs.remove(tab.id).catch(() => {});
    }
  }
}

// 任务互斥：定时 alarm、popup 手动触发、安装时的一次都可能同时进来，
// 两套循环并行 = 同时开两个标签页各自导航（看起来就是“乱跳”），所以同一时刻只允许一套。
let jobsBusy = false;

// 主流程：获取任务 → 逐个执行 → 上报
async function runJobs() {
  if (jobsBusy) {
    console.log('[签到面板] 浏览器任务正在执行中，本轮跳过');
    return;
  }
  jobsBusy = true;
  try {
    await runJobsOnce();
  } finally {
    jobsBusy = false;
  }
}

async function runJobsOnce() {
  const { panelUrl, apiKey } = await getConfig();
  if (!panelUrl || !apiKey) {
    console.log('[签到面板] 未配置面板地址或 API Key，跳过');
    return;
  }
  // 先把上一轮没送出去的汇报补掉
  await flushPendingReports(panelUrl, apiKey);

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
  // 单轮总预算：Service Worker 随时可能被回收，不能无限期串着做；
  // 用完了剩下的留给下一分钟（面板每分钟都会重新下发一次，不会丢）。
  const startedAt = Date.now();
  for (const job of jobs) {
    if (Date.now() - startedAt > JOBS_BUDGET_MS) {
      console.log('[签到面板] 本轮预算用尽，剩余任务留到下一分钟（从账号 ' + job.account_id + ' 开始）');
      break;
    }
    console.log(`[签到面板] 执行：${job.site_name}（账号 ${job.account_id}）`);
    const r = await executeJob(job);
    console.log(`[签到面板] 结果：${r.status} - ${r.message}`);
    await reportResult(panelUrl, apiKey, job.account_id, r.status, r.message, r.durationMs);
    // 会话续命：签到过程里站点可能已经换了新会话（Set-Cookie），把新值回写面板，
    // 免得过几天「登录已失效」又要人工重抓（见 reportCookieRotation 顶部说明）。
    // 只对「这次确实注入过凭据」的任务做 —— 浏览器里那份才确定是面板的同一会话。
    if (job.inject_cookies && job.cookie) {
      let rotHost = '';
      try { rotHost = new URL(job.navigate_url || 'https://' + job.domain + '/').hostname.toLowerCase(); } catch { rotHost = ''; }
      if (rotHost) await reportCookieRotation(panelUrl, apiKey, job, rotHost);
    }
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
//
// 【两道自保，都是线上踩过的坑（2026-09-28）】
//   ① **绝不能回传空 body**：`JSON.stringify(undefined)` 返回 undefined，fetch 会把它当成
//      「没有请求体」，面板那边解析成空对象，最后存成一条「完成了、但没有状态码也没有正文」的结果。
//      站点模块拿到空响应就会得出「站点不认这个接口」这类**错误结论** —— 用户看到的是
//      「本地网络签到失败」，而站点其实一直回答得好好的。所以先把 payload 归一化。
//   ② **必须看 HTTP 状态并重试**：以前 `.catch(() => {})` 把一切都吞掉，包括「面板返回 500 / 401」，
//      于是任务永远停在「租约中」，两分钟后被面板判成「扩展没有回传（可能被关闭或休眠）」——
//      而扩展早就答完了。现在 5xx / 网络错误重试 3 次，4xx 立即停（Key 错重试无意义）。
async function submitRelayResult(panelUrl, apiKey, jobId, result) {
  const obj = (result && typeof result === 'object' && !Array.isArray(result)) ? { ...result } : {};
  // 既没有状态码也没有错误说明 → 当作「扩展内部错误」如实回传，不要发空 body
  if (obj.status == null && !obj.error) {
    obj.error = '中继执行没有返回结果（扩展内部错误：' + String(result === undefined ? 'undefined' : result).slice(0, 120) + '）';
  }
  const body = JSON.stringify(obj);
  let last = '';
  for (let i = 0; i < 3; i++) {
    try {
      const resp = await fetch(panelUrl + '/api/external/relay/' + jobId + '/result', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Api-Key': apiKey },
        body,
      });
      if (resp.ok) return true;
      last = 'HTTP ' + resp.status;
      if (resp.status >= 400 && resp.status < 500) break; // Key/参数错，重试无意义
    } catch (e) {
      last = String((e && e.message) || e);
    }
    if (i < 2) await sleep(600 * (i + 1));
  }
  console.error(`[签到面板] 中继结果回传失败（${last}）：${jobId}`);
  return false;
}

// ============ 中继请求的三道闸门 ============
//
// 中继是「用你的浏览器 + 你的登录态发请求，再把响应原文回传给面板」——
// 这是整个扩展权限最大的能力。面板本身可信，但任务里的 url / headers 来自面板数据库里的
// 站点配置（社区导入的配置也进这里），所以扩展这边必须自己再收一道口子：
//   ① 只发 http(s)，且不碰内网 / 回环 / 链路本地地址（否则一条恶意配置就能拿用户的浏览器
//      当内网探针：读路由器后台、扫描内网服务）；
//   ② 方法白名单、请求头清洗（不允许 Host/Connection/Content-Length 这类由浏览器自己管的头，
//      也不允许 CRLF 注入）；
//   ③ 响应体上限（把几百 MB 的内容 base64 回来会把整个 Service Worker 拖死）。
const RELAY_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];
const RELAY_MAX_BYTES = 4 * 1024 * 1024;
const RELAY_BLOCKED_HEADERS = ['host', 'connection', 'content-length', 'transfer-encoding', 'upgrade', 'proxy-authorization', 'proxy-connection'];

// 内网 / 回环 / 链路本地（含云元数据 169.254.169.254）一律拒绝
function isPrivateHost(host) {
  const h = String(host || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  // IPv6 字面量（URL 里是带中括号的，上面已经去过括号）。
  // 注意必须限定在「含冒号」的情况下判断 fc/fd —— 否则像 fc2.com 这种普通域名会被误拦。
  if (h.includes(':')) {
    if (h === '::1' || h === '::' || h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) return true;
    if (/^::ffff:(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/.test(h)) return true; // IPv4-mapped
  }
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 169 && b === 254) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
}

// 校验一条中继任务；不合法就返回原因（由调用方回传给面板，不静默丢）
function checkRelayJob(job) {
  let u = null;
  try { u = new URL(String((job && job.url) || '')); } catch { return '地址不是合法 URL'; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return '只允许 http/https 地址';
  if (isPrivateHost(u.hostname)) return '拒绝访问内网/本机地址（' + u.hostname + '）';
  const method = String((job && job.method) || 'GET').toUpperCase();
  if (!RELAY_METHODS.includes(method)) return '不支持的方法：' + method;
  if (job && job.body_base64 && String(job.body_base64).length > 8 * 1024 * 1024) return '请求体过大';
  return '';
}

// 只保留合法、且不会破坏请求语义的头
function sanitizeHeaders(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const k of Object.keys(raw).slice(0, 60)) {
    const name = String(k).trim();
    if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(name)) continue; // 头名必须是合法 token
    if (RELAY_BLOCKED_HEADERS.includes(name.toLowerCase())) continue; // 交给浏览器自己算
    const v = String(raw[k] == null ? '' : raw[k]);
    if (/[\r\n]/.test(v)) continue; // 防头注入
    out[name] = v.slice(0, 8192);
  }
  return out;
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
  // 三道闸门（见上面说明）：不合法的任务直接回传错误，不照做
  const bad = checkRelayJob(job);
  if (bad) return { error: '中继任务被拒绝：' + bad };
  const url = new URL(job.url);
  const domain = url.hostname;
  const method = String(job.method || 'GET').toUpperCase();
  const reqHeaders = sanitizeHeaders(job.headers);
  let tab = null;
  let created = false;
  let prevActiveId = null;
  let activated = false;
  try {
    // 同样只用我们自己的标签页（Cookie 是按域名走的，新开的标签页一样带着登录态）。
    // 以前会把用户正在看的那个标签页激活到前台去反爬，焦点被抢来抢去。
    tab = await findOwnTab(domain);
    if (!tab) {
      tab = await openOwnTab(domain);
      created = true;
    }

    const injectFetch = async (url, method, headers, bodyB64, options, timeoutMs, maxBytes) => {
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
        // 超大响应直接放弃：base64 后回传会把 Service Worker 的内存/消息通道拖垮
        if (maxBytes && buf.length > maxBytes) return { tooLarge: buf.length, status: resp.status };
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
        args: [url.href, method, reqHeaders, job.body_base64 || null, job.options || {}, timeoutMs, RELAY_MAX_BYTES],
      });
      return (results && results[0] && results[0].result) || null;
    };

    let r = await runOnce(RELAY_FIRST_TRY_MS);
    if (r && r.tooLarge) {
      return { error: `响应体过大（${Math.round(r.tooLarge / 1048576)}MB，上限 ${Math.round(RELAY_MAX_BYTES / 1048576)}MB），已放弃回传` };
    }
    if (r && r.timeout) {
      // 超时后的第二次尝试。
      // 【默认不抢焦点】把标签页拿到前台确实能让某些反爬挑战跑起来，但那会打断用户正在看的页面
      // （用户看到的就是“浏览器乱跳”），所以改成**站点显式声明**才启用：
      //   relayFetch(..., { foreground: true }) → 任务里带 options.foreground
      // 没声明的站点就在后台标签页里再试一次（超时放宽到 RELAY_FETCH_TIMEOUT_MS）。
      if (job.options && job.options.foreground) {
        try {
          const [cur] = await chrome.tabs.query({ active: true, currentWindow: true });
          prevActiveId = cur && cur.id != null ? cur.id : null;
          await chrome.tabs.update(tab.id, { active: true });
          activated = true;
          await new Promise((res) => setTimeout(res, RELAY_ACTIVATE_WAIT_MS)); // 给页面里的定时/挑战脚本一点时间
        } catch { /* 激活失败也得继续试 */ }
      }
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
    const respHeaders = { ...(r.headers || {}), 'x-relay-url': r.url || job.url };
    return { status: r.status, headers: respHeaders, body_base64: r.body_base64 };
  } catch (e) {
    return { error: String(e.message || e).slice(0, 500) };
  } finally {
    // 把焦点还给用户原来的标签（重试时我们只能激活自己的标签页，激活完还回去）
    if (activated && prevActiveId != null) {
      chrome.tabs.update(prevActiveId, { active: true }).catch(() => {});
    }
    // 【这里刻意不再立刻关标签页】
    // 一次签到要打好几个请求（首页 → 主题 JS → 签到接口），以前每个请求都
    // 「开一个 → 用完关掉」，用户看到的就是「浏览器总在新建页面」。
    // 现在这个标签页留给本域名后续的请求复用，由 runRelayRound 末尾的
    // sweepOwnTabs(RELAY_TAB_IDLE_MS) 在空闲 45 秒后统一关掉。
    // 它是后台标签页（active:false），不会抢焦点、也不会打断用户正在看的页面。
    // （created 仅用于日志，说明这一轮是不是新开的）
    if (created && tab && tab.id != null) rememberOwnTab(tab.id, domain);
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
  // 上一轮没送出去的汇报：连上了就补报（面板否则永远停在「待确认」）
  await flushPendingReports(panelUrl, apiKey);
  let jobs;
  try {
    jobs = await fetchRelayJobs(panelUrl, apiKey);
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }; // 面板不可达时静默重试
  }
  // 一次只做少量：扩展是**单飞**执行（每个请求最长约 RELAY_FETCH_TIMEOUT_MS 秒），
  // 一口气领一堆，后面的会在 Worker 那边等到 90 秒超时（线上 2026-09-28 的「扩展没有在 90 秒内回传」）。
  // Worker 端也已经只下发 2 个，这里再兜一道，两边都不会把队列堵死。
  const batch = (jobs || []).slice(0, RELAY_MAX_JOBS_PER_ROUND);
  for (const job of batch) {
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
  // 顺手回收我们自己开的后台标签页：中继标签页按「空闲 45 秒」回收 ——
  // 一次签到的各个请求之间会有几秒停顿，45 秒足够让它们复用同一个页面，
  // 而签到结束后最多 45 秒它自己就消失了（用户不会看到一堆残留标签页）。
  await sweepOwnTabs(RELAY_TAB_IDLE_MS);
  // count 只算「这一轮真的处理了几条」：算上没领回来的那些会让突发误以为一直有活干
  return { ok: true, count: batch.length, total: (jobs || []).length };
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
      // 被别的一轮顶掉（busy）时既不算「有活」也不算「空转」：
      // 否则一次并发就能让突发提前收工
      if (r && r.skipped) { await sleep(RELAY_GAP_MS); continue; }
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

// 回收我们自己开的后台标签页：空闲超过 idleMs 没再被用到的就关掉。
// （只动 ownTabs 里记着的 —— 那都是我们开的；用户的标签页一律不碰）
async function sweepOwnTabs(idleMs = OWN_TAB_TTL_MS) {
  if (!ownTabs.size) return 0;
  const now = Date.now();
  let tabs = [];
  try { tabs = await chrome.tabs.query({}); } catch { return 0; }
  const live = new Set((tabs || []).map((t) => t.id));
  let closed = 0;
  for (const [tid, info] of Array.from(ownTabs)) {
    if (now - info.at <= idleMs) continue;
    ownTabs.delete(tid);
    if (!live.has(tid)) continue;
    try { await chrome.tabs.remove(tid); closed++; } catch { /* 已经关了就算了 */ }
  }
  if (closed) console.log('[签到面板] 回收了 ' + closed + ' 个自己开的陈旧标签页');
  return closed;
}

// 定时器
// 我们自己开的标签页被关掉（用户手动关/浏览器回收）后，别再记着它。
// 受限环境（测试台架/阉割实现）里可能没有 onRemoved：不能因此让整个后台挂掉。
if (chrome.tabs && chrome.tabs.onRemoved && typeof chrome.tabs.onRemoved.addListener === 'function') {
  chrome.tabs.onRemoved.addListener((tabId) => forgetOwnTab(tabId));
}
// 签到专用窗口被关（用户手动关 / 最后一个标签页没了）时把 id 作废，下次签到会重新建一个
if (chrome.windows && chrome.windows.onRemoved && typeof chrome.windows.onRemoved.addListener === 'function') {
  chrome.windows.onRemoved.addListener((winId) => { if (winId === signWindowId) signWindowId = null; });
}

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

// popup 手动触发。
// 【安全】只接受本扩展自己的页面发来的消息（sender.id 就是本扩展的 id）：
// 否则任何能发消息的一方都能指挥这里开标签页、发请求、用用户的登录态干活。
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const fromSelf = !sender || !sender.id || !chrome.runtime.id || sender.id === chrome.runtime.id;
  if (!fromSelf) {
    sendResponse({ ok: false, error: '来源不受信任' });
    return false;
  }
  if (!msg || typeof msg.action !== 'string') {
    sendResponse({ ok: false, error: '未知指令' });
    return false;
  }
  if (msg.action === 'runJobsNow') {
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
