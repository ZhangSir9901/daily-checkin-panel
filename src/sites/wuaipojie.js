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
// 网宿 WAF 的硬拦截页（实测云端出口 IP 会被这里挡下）：
//   403 Forbidden ... Client IP: 172.70.x.x eventID: ...403-waf02whc reason:UrlACL
const BLOCK_RE = /reason:UrlACL|Client IP:\s*[\d.:a-f]+|eventID:\s*\d+-[\d.]+-\d+-waf|Request blocked|Access Denied|403 Forbidden/i;
// 已签到特征。重点补充「签到完毕」：52pojie 的每日签到任务页在当天领过之后，
// 按钮文字会变成「签到完毕」，再点没有任何反应（不会报错也不会给提示）。
// 旧版没有这个词，于是把「已经签到过」误报成「未识别到成功标识」。
// 注意：只保留任务场景特有的词，去掉「已完成」「恭喜」这类在论坛帖子里也会出现的泛词。
const SIGNED_MARKS = [
  // 注意：单独的「已签到」「已经签到」太宽泛，页面模板里就可能带有，
  // 曾导致没真签到却被误判为「今日已签到」。必须带「今日/完毕/完成」等限定词才算。
  '今日已签到', '今日已签', '签到完毕', '签到完成', '已完成签到',
  '您已完成过此任务', '您已经完成此任务', '今日任务已完成',
  '无需重复签到', '无需重复', '请等待下次刷新',
  '下期再来', '明天再来',
  'ÄúÒÑ', 'ÏÂÆÚÔÙÀ´', // GBK 被误作 Latin1 解码时的特征
  // 「签到完毕」图标：站点把当天状态画在图片里（qds.png=未签 / wbs.png=已签），
  // 社区脚本（XIU2 的吾爱增强、lyc8503 的签到脚本）都拿 wbs.png 当「今天已签」的判据。
  // 图标名很特殊，不会在正文里乱出现，可以按图片名判。
  'wbs.png',
];
// 成功特征：必须是任务完成场景的强信号。去掉「恭喜」「获得」「吾爱币」这类泛词，
// 它们在论坛帖子/公告里随处可见，会造成误判。
const SUCCESS_MARKS = ['任务已完成', '签到成功', '打卡成功', '签到完毕'];
const PAUSED_MARKS = ['暂停签到', '签到暂停', '暂停每日签到', '签到功能维护'];
const LOGIN_MARKS = ['请先登录', '需要先登录', '请登录后'];

// 站点用**顶部那一个按钮**表示当天状态（2026-09-28 用户截图确认）：
//   未签到 → 「📋 打卡签到」（橙色，可点）
//   已签到 → 「✅ 签到完毕」（绿色，点下去没任何反应）
// 这是全站最可靠的状态指示，比正文里泛泛的「已签到」准得多。
const BTN_SIGNED = /签到完毕|签到完成|今日已签到/;
const BTN_UNSIGNED = /打卡签到|立即签到|点击签到|签到领/;

// 读「签到按钮自己的状态」（只取那个元素，不看整页）：
//   ① 文字版：按钮里写着「签到完毕」/「打卡签到」
//   ② 图片版（52pojie 实际就是这样，DevTools 截图确认）：状态被画在图片里
//      <a href="home.php?mod=task&do=apply&id=2&referer=…"><img src="…/qds.png"></a>
//      图里写着「打卡签到」，文本节点里什么都没有 —— 但**这个「去签到」链接还在**，
//      就说明服务端认为今天还没签（签完链接就没了，点也没反应）。
// 关键：只看按钮/链接元素，不要拿整页文本搜——<a> 的 title 里常年写着「打卡签到」，
// 整页搜会把已签到误判成未签到。
// 返回 'signed' | 'unsigned' | 'unknown'
export function buttonState(texts) {
  const raw = (typeof texts === 'string') ? texts : pickText(texts) || '';
  // 按钮本体：优先按已知 class，其次按「去签到」链接
  const m = raw.match(/<a[^>]*class=["'][^"']*(?:click-qiandao|zzhuti_qd|qq_bind)[^"']*["'][^>]*>([\s\S]{0,200}?)<\/a>/i)
    || raw.match(/<a[^>]*href=["'][^"']*mod=task[^"']*do=apply[^"']*["'][^>]*>([\s\S]{0,200}?)<\/a>/i);
  if (m) {
    const btnText = m[1].replace(/<[^>]*>/g, '').replace(/\s+/g, '');
    if (BTN_SIGNED.test(btnText)) return 'signed';
    // 链接还挂着「去签到」= 未签到（图片版状态靠这个认）
    if (/href=["'][^"']*mod=task[^"']*do=apply/i.test(m[0])) return 'unsigned';
    if (BTN_UNSIGNED.test(btnText)) return 'unsigned';
  }
  // 「签到完毕」图标：站点靠换图片表示状态（qds.png=未签 / wbs.png=已签），文字节点是空的。
  // 社区脚本（XIU2 的吾爱增强、lyc8503 的签到脚本）都拿 wbs.png 当「今天已签」的判据，
  // 图标名很特殊，不会出现在正文里，所以这里可以放心按图片名判。
  if (/wbs\.png/i.test(raw)) return 'signed';
  // 按钮没找着（未登录 / 主题改版）：退一步只看「签到完毕」这种强信号，
  // 不要因为整页里出现「打卡签到」就断定未签到（那条多半来自 title / 导航）
  if (/签到完毕/.test(raw)) return 'signed';
  return 'unknown';
}

// 从任务页里把「打卡签到」这个任务的**真实链接**找出来。
// 为什么要这样（而不是硬编 id=2）：
//   · Discuz 的任务 id 由论坛后台配置，不同论坛/改版会变（社区脚本里就有遍历任务 id 的做法）；
//   · 页面上那个「去签到」链接自带 id 和 referer，照它的原样发请求，和真人点一下完全一致。
// 同时读回：该任务是否已完成（行内的「已完成 / 已申请 / 进行中」文字）。
// texts 可以是 fetchDualText 的返回值，也可以是纯字符串。
export function findSignTask(texts) {
  const raw = (typeof texts === 'string') ? texts : pickText(texts) || '';
  const out = { id: '', href: '', label: '', done: false, formhash: '' };
  const fm = raw.match(/formhash=([0-9a-f]{6,10})/i);
  if (fm) out.formhash = fm[1];
  const re = /<a\b[^>]*href=["']([^"']*mod=task[^"']*do=apply[^"']*?id=(\d+)[^"']*)["'][^>]*>([\s\S]{0,300}?)<\/a>/gi;
  const cands = [];
  let m;
  while ((m = re.exec(raw))) {
    const href = m[1].replace(/&amp;/g, '&');
    const inner = m[3].replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, '');
    const img = (m[3].match(/<img[^>]*src=["']([^"']+)["']/i) || [])[1] || '';
    // 只取这个链接所在的那一小片文字（上下各一屏左右），用来判断是哪条任务、完成没有；
    // 不能拿整页搜「已完成」——任务列表页里别的任务就是已完成状态。
    const around = raw.slice(Math.max(0, m.index - 260), m.index + m[0].length + 420)
      .replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
    cands.push({ href, id: m[2], inner, img, around });
  }
  if (!cands.length) return out;
  const looksSign = (c) => /打卡签到|每日签到|每日打卡|签到/.test(c.inner + ' ' + c.img + ' ' + c.around);
  const pick = cands.find(looksSign) || cands[0];
  out.href = pick.href;
  out.id = pick.id;
  out.label = pick.inner || '打卡签到';
  // 「已完成 / 已申请（当天已领）/ 进行中」且附近没有「立即申请」→ 这个任务今天已做过
  out.done = /已完成|已申请|已领取|进行中/.test(pick.around) && !/立即申请|马上申请|申请任务/.test(pick.around);
  return out;
}

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

// 去掉脚本/标签，得到可读的页面纯文本（用于「网站反馈」展示网站真实回馈）
// 52pojie 页面是 GBK：同一段字节用 utf8 解码会得到带替换字符(U+FFFD)的乱码。
// 判据：utf8 解码出现替换字符、而 gbk 解码没有 → 按 GBK 取文本，
// 否则保留 utf8（UTF-8 页面不会被误判）。不能用「谁的中文更多」——GBK 错解 UTF-8
// 也会得到一批汉字乱码，反而会选错。
function pickText(texts) {
  const u = (texts && texts.utf8) || '';
  const g = (texts && texts.gbk) || '';
  if (!u) return g;
  if (u.includes('\uFFFD') && !g.includes('\uFFFD')) return g;
  return u;
}

function clean(texts) {
  const t = pickText(texts) || '';
  return t.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

// 签到后顺带读一次积分页，把「吾爱币 / 威望 / 热心值」带进日志（参考 Discuz 任务签到脚本做法）
// 纯 best-effort：读不到就返回空串，不影响签到结果
async function creditSuffix(headers) {
  try {
    const page = await fetchDualText('https://www.52pojie.cn/home.php?mod=spacecp&ac=credit', { headers });
    assertNoWaf(page, page.res.status);
    const t = clean(page);
    const pick = (label) => {
      const m = t.match(new RegExp(label + '\\s*[:：]?\\s*(\\d+)'));
      return m ? m[1] : '';
    };
    const parts = [];
    const coin = pick('吾爱币');
    const credit = pick('威望');
    const hot = pick('热心值');
    if (coin) parts.push(`吾爱币 ${coin}`);
    if (credit) parts.push(`威望 ${credit}`);
    if (hot) parts.push(`热心值 ${hot}`);
    return parts.length ? '（当前 ' + parts.join('，') + '）' : '';
  } catch {
    return '';
  }
}

// 从页面里挑出与签到相关的一句话，作为真实网站回馈
function pickLine(texts) {
  const text = clean(texts);
  const m = text.match(/[^\s]{0,20}(任务已完成|签到成功|打卡成功|签到完毕|签到完成|今日已签到|已经签到|下期再来|明天再来)[^\s]{0,30}/);
  return (m ? m[0] : text.slice(0, 120)).trim();
}

// status 可选：HTTP 403 直接判定为被拦截，不用靠猜页面文本
function assertNoWaf(texts, status) {
  if (has(texts, WAF_MARKS)) {
    throw new Error('遇到安全验证（WAF）：请用浏览器打开 www.52pojie.cn 完成滑块/安全验证，然后重新复制完整 Cookie（含 wzws_cid）到面板');
  }
  const all = ((texts && texts.utf8) || '') + '\n' + ((texts && texts.gbk) || '');
  if (Number(status) === 403 || BLOCK_RE.test(all)) {
    throw new Error(
      '网站安全防护拦截（HTTP 403 / 网宿 UrlACL）：\n' +
        '· 若为「云端」执行：Cloudflare 出口 IP 已被该站封禁（52pojie 只放行家庭宽带 IP），请把此账号切到「本地网络」。\n' +
        '· 若为「本地网络」执行：请先在浏览器打开 www.52pojie.cn 完成滑块/安全验证，再重新获取 Cookie。'
    );
  }
}

// 「打卡签到」任务的真实地址（Discuz 任务：do=apply + 任务 id）。
// 社区里各类 52pojie 签到脚本普遍用 id=2；任务列表页里那个按钮自己也是这个地址，
// 所以这里既有默认值，会在页面里查到链接时以页面为准（findSignTask）。
const SIGN_APPLY_URL = 'https://www.52pojie.cn/home.php?mod=task&do=apply&id=2&referer=%2Fportal.php';

// 首页地址。**这是本站点最重要的一个常量**，2026-09-28 用真实登录态实测（本地宽带 IP +
// 面板里那份 Cookie）得到的一张「WAF 面」表：
//
//   GET /                                        → 200，84KB 的登录态首页：
//                                                  · `#um` 里挂着打卡入口（qds.png 图片版）
//                                                  · `#res-sign` 里是文字版「领取今日签到奖励」
//                                                  · 图片名就是当天状态：qds.png=未签 / wbs.png=已签
//   GET /home.php?mod=task                       → 200，但 32KB 的**网宿 WZWS JS 挑战页**
//   GET /home.php?mod=task&do=apply&id=2&…       → 同样是挑战页
//   （带不带 Cookie、带不带 Referer 都一样；挑战页里写着 dynamicapi='/waf_zw_verify'
//     + wzwsquestion/wzwsfactor + 自定义 base64 表，就是社区脚本卡死的那套）
//
// 结论（决定了本模块的三个选择）：
//   ① **导航页选首页**：`/` 不会被挑战，浏览器打开就能直接读到当天状态；
//      原来导航到 `/home.php?mod=task` 等于先让浏览器去闯一次挑战页，
//      扩展的「等页面加载完」很可能就停在那张挑战页上，然后报「找不到签到入口」。
//   ② **签到动作 = 点首页上那个真入口**（`#um` 里的 qds.png 图片链接 / `#res-sign` 的文字链接）：
//      这是站点自己写在本页上的同源 GET，带 Referer、复用本页已过的 WAF 会话；
//      直接 `chrome.tabs.update` 跳到 apply 地址等于发起一次全新的顶层请求，要重闯一次挑战。
//   ③ **复查也读首页**：qds.png → wbs.png 就是签到成功的证据，而且这个读法同时适用于
//      脚本（本地中继）和浏览器两条路。
const HOME_URL = 'https://www.52pojie.cn/';

export const wuaipojie = {
  id: 'wuaipojie',
  name: '吾爱破解',
  desc: '吾爱破解论坛每日签到（Discuz 任务）。Cookie 方式，需先用浏览器过安全验证，UA 须与抓包时一致。',
  execution: 'browser', // 默认执行模式：server=云端执行，browser=浏览器扩展执行（用户网络）
  domain: 'www.52pojie.cn', // 浏览器执行时的目标域名
  // 该站的主站（www.52pojie.cn）被网宿 WAF 保护：**脚本化的 fetch 整站都读不到**
  // （实测 2026-09-28：同一浏览器里 example.com / static.52pojie.cn 正常，而该主站的
  //   robots.txt、portal.php、home.php 全部挂到超时）。
  // 只有「真实的页导航」才能过挑战 —— 所以这个站点默认改走**浏览器导航签到**：
  // 由扩展把用户浏览器的一个标签页打开到「打卡签到」地址（等同人手点一下），再读回结果页。
  preferNavigationSign: true,
  // 这个站的签到**必须由浏览器亲自发**（WAF 只放行真实页面导航），而服务端认的是
  // **浏览器 cookie jar 里的登录态**。所以：面板把存着的凭据一起交给扩展，
  // 由扩展写回浏览器（chrome.cookies.set）——这样「面板点一下」就是完整闭环，
  // 不需要人先去浏览器手工登录一遍。
  needsBrowserSession: true,
  browserJob: () => ({
    domain: 'www.52pojie.cn',
    // 让扩展先把下面那份凭据写回浏览器；跳转之前写，第一次巡检才能看到登录态
    inject_cookies: true,
    // 报成功之前必须回首页核对一次（结果页文案说成功不算数，首页的入口/图标才是服务端状态）
    confirm_before_report: true,
    // 先到**首页**——它是这个站点上唯一不会被 WAF 挑战的页面（见上面 HOME_URL 的实测表），
    // 而且打卡入口和当天状态都在这页上；扩展端会自己找那个入口并点它。
    navigate_url: HOME_URL,
    sign_url: SIGN_APPLY_URL,
    // 触发完签到后**回这些页复查服务端真实状态**（扩展会再看一遍那只「去签到」链接）：
    // ① 任务列表页：链接还在 = 今天没签；链接没了 / 本行写着「已完成」= 今天已签；
    // ② 首页：Discuz 顶部用户菜单 `#um` 里挂着同一个入口（社区脚本用的就是它），
    //    并且签完之后站点会把图标换成 wbs.png（「签到完毕」）——两个地址互为补充。
    // 没有这一步时，申请页往往既不报成功也不报未签（Discuz 点完只是刷新），
    // 面板上就只剩一句含糊的「未识别到成功标识」，用户根本不知道到底签没签上。
    // 首页排第一：它是状态的正本（qds/wbs），而且脚本侧/浏览器侧都不会被挑战。
    // 任务列表页放第二个做补充（能看到「已完成」那一行），它在浏览器里能看（浏览器自己会过挑战），
    // 但脚本侧读它只会拿到挑战页 —— 所以绝不能把它当唯一依据。
    verify_urls: [
      HOME_URL,
      'https://www.52pojie.cn/home.php?mod=task',
    ],
    verify_url: HOME_URL,
  }),
  // 浏览器端签到脚本：在用户浏览器中运行，自动携带登录 Cookie，使用用户网络（无 WAF）
  // 入参 params：{}；返回 { ok, message }
  // 注意：扩展会先导航标签页到 navigate_url（模拟手动点击），脚本只需检查当前页面内容
  // 旧的 n 版字段（老扩展/兜底链用）：这里放**签到动作**的地址，不是导航页。
  // 新版走 browserJob()：navigate_url=首页，sign_url=这个 apply 地址。
  navigateUrl: SIGN_APPLY_URL,
  browserScript: `async (params) => {
    const html = document.documentElement.innerHTML || '';
    const text = document.body ? document.body.innerText || '' : '';
    const all = html + '\\n' + text;
    const WAF = ['waf_zw_verify', 'WZWS_CONFIRM_PREFIX_LABEL', 'slidercaptcha', '请完成安全验证', '安全检查中'];
    if (WAF.some((m) => all.includes(m))) return { ok: false, message: '遇到安全验证（WAF）：请在浏览器中打开 www.52pojie.cn 完成验证后重试' };
    if (/需要先登录|请先登录/.test(all)) return { ok: false, message: '登录已失效，请重新获取 Cookie' };
    // 先读顶部那个按钮自己的文字——它是站点当天的状态指示：
    //   未签到 = 「打卡签到」（橙色）  已签到 = 「签到完毕」（绿色，点下去没反应）
    // 只取按钮元素内部：<a> 的 title 里常年写着「打卡签到」，拿整页文本搜会误判。
    const btn = document.querySelector('.click-qiandao, .zzhuti_qd_1, .zzhuti_qd_2, .user-index-qd, a[href*="do=apply"]');
    const btnText = btn ? String(btn.innerText || btn.textContent || '').replace(/\\s+/g, '') : '';
    const btnSigned = /签到完毕|签到完成|今日已签到/.test(btnText);
    const btnUnsigned = /打卡签到|立即签到|点击签到/.test(btnText);
    // 图片版状态（52pojie 把「打卡签到」画在 qds.png 里）：读不到文字，
    // 但顶栏那个「去签到」的链接还在 = 服务端认为今天还没签
    const linkUnsigned = !!(btn && /do=apply/.test((btn.getAttribute && btn.getAttribute('href')) || ''));
    if (/任务已完成|签到成功|打卡成功/.test(all)) return { ok: true, message: '签到成功' };
    if (btnSigned || /今日已签到|签到完毕|签到完成|下期再来|明天再来|无需重复/.test(all)) {
      return { ok: true, message: '今日已签到，无需重复（网站按钮：' + (btnText || '签到完毕') + '）' };
    }
    if (linkUnsigned || btnUnsigned) {
      return { ok: false, message: '本次没有签上：网站顶栏仍显示「' + (btnText || '打卡签到') + '」，且「去签到」链接还在。可在浏览器打开 www.52pojie.cn 手动点一次（可能要先过滑块验证），再重试' };
    }
    return { ok: false, message: '未识别到成功标识，页面标题：' + (document.title || '未知') };
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

  async run(creds, ctx = {}) {
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

    // 状态探测：读「签到按钮 / 任务页」到底说没说已签到。
    // 返回 'signed' | 'unsigned' | 'unknown'：
    //   超时/中继失败时，'signed' 才能当成功（不能凭空报成功），
    //   'unsigned' 才能确定「本次没签上」并给出人能看懂的原因。
    const isRelay = !!(ctx && ctx.relayDb);

    // 「确定没签上」的统一出口：给出原因 + 下一步怎么操作。
    // 为什么需要它：以前这种情况只报一句「未识别到成功标识」，用户完全不知道该干什么，
    // 而现在站点按钮自己就写着「打卡签到」——那就是明确的未签到状态，可以直说。
    const failUnsigned = (reason) => {
      const err = new Error(
        reason + ' —— 本次签到没有生效。\n' +
          (isRelay
            ? '· 当前是「本地网络」：请在浏览器打开 www.52pojie.cn，手动点一次顶部那个「打卡签到」（可能要先过滑块验证）；成功后本模块下次就能读到「签到完毕」。'
            : '· 当前是「CF 网络」：该站屏蔽机房 IP（403 UrlACL），请把此账号切到「本地网络」再试。')
      );
      err.outcome = 'unsigned';
      throw err;
    };

    const probeSignedState = async () => {
      // 先找「已签到」的正信号，再谈未签到——否则任务列表页里那个
      // 「已完成」文字会被同页的另一条「去签到」链接盖过去。
      const checkPage = (v) => {
        if (buttonState(v) === 'signed') return 'signed';
        if (has(v, SIGNED_MARKS)) return 'signed';
        const raw = pickText(v) || '';
        const taskRow = raw.match(/id=2[\s\S]{0,500}/i);
        if (taskRow && /签到完毕|已完成|已领取/.test(taskRow[0])) return 'signed';
        if (buttonState(v) === 'unsigned') return 'unsigned';
        return 'unknown';
      };
      // 先查任务页（普通页面，能读到）；只有它说不清才去看申请页
      // （申请页本身就可能被 WAF 吊死，能不去就不去）。有结论就立刻停，不等第二次。
      const urls = [
        'https://www.52pojie.cn/home.php?mod=task',
        'https://www.52pojie.cn/home.php?mod=task&do=apply&id=2',
      ];
      for (const u of urls) {
        try {
          const v = await fetchDualText(u, { headers: baseHeaders });
          const st = checkPage(v);
          if (st !== 'unknown') return st;
        } catch { /* 查不到就继续换下一页 */ }
      }
      return 'unknown';
    };
    const verifySigned = async () => (await probeSignedState()) === 'signed';

    // Discuz showmessage 的消息藏在 <script> 里，clean() 会把它删掉。
    // 这里单独从原始 HTML（含 script）里提取消息文本，用于判定。
    const extractShowMessage = (texts) => {
      const raw = pickText(texts);
      const m = raw.match(/showmessage\(['"]([^'"]{2,100})['"]/i)
        || raw.match(/<div[^>]*class=["'].*?(?:msg|message|alert).*?["'][^>]*>([\s\S]{2,200}?)<\/div>/i);
      if (m) return m[1].replace(/<[^>]+>/g, ' ').replace(/\\n/g, ' ').trim();
      return '';
    };

    // ⓿ 先查任务页（home.php?mod=task）：当天是否已领过，这一页就是铁证。
    // 为什么放在最前面（这三条都是线上实测出来的）：
    //   ① 签到接口（do=apply）受网宿 WAF 最严格的那一档保护：经「本地网络」中继时
    //      会把连接吊到超时（用户看到「中继执行超时（45秒），已放弃该请求」），
    //      而那一次请求其实已经签到成功了——面板却报失败、状态还是「未签到」。
    //   ② 任务页是普通页面，能正常读到；当天领过之后按钮文字就是「签到完毕」。
    //   ③ 不重复打签到接口，又快又不会被 WAF 反复惦记。
    // 判定不成立（没查到 / 页面读不到）时，继续走下面的完整流程。
    const taskListUrl = 'https://www.52pojie.cn/home.php?mod=task';
    let knownUnsigned = false; // 按钮写着「打卡签到」= 站点自己的明确未签到状态
    let signTask = { id: '', href: '', label: '', done: false, formhash: '' };
    try {
      const t = await fetchDualText(taskListUrl, { headers: baseHeaders });
      assertNoWaf(t, t.res.status);
      signTask = findSignTask(t); // 以页面上的「打卡签到」链接为准（id/地址都可能变）
      const btnSt = buttonState(t);
      if (btnSt === 'unsigned') knownUnsigned = true;
      // 已签到的判据（正信号优先）：按钮/强文案，或这条任务自己写着已完成
      if (btnSt === 'signed' || has(t, SIGNED_MARKS) || signTask.done) {
        return {
          ok: true,
          message: '今日已签到（任务页显示：' + (signTask.done ? signTask.label + ' 已完成' : pickLine(t)) + '）',
          detail: '网站返回：' + clean(t).slice(0, 300),
        };
      }
    } catch (e) {
      // WAF / 安全验证要如实上报，不能吞掉（否则用户永远不知道要过滑块）
      if (/安全验证|拦截/.test((e && e.message) || '')) throw e;
      // 其它错误（超时、中继失败）忽略，继续尝试签到
    }

    // ① 预检首页：**只看 WAF**。
    // 注意：portal.php 是门户页，上面除了博客卡片，还有论坛的最新帖标题 + 「最新公告」块。
    // 实测该页的公告里就写着「开放注册期间论坛暂停签到」，而帖子标题里什么都可能有。
    // 早期版本拿「暂停签到 / 今日已签到」这类词扫整个首页，结果把一个正常可签的账号
    // 报成「论坛官方暂停签到，等恢复后再试」——所以这里绝不能再凭首页文本下签到结论。
    // 注：中继模式下 runner.js 会透明替换 global fetch，站点代码无需改动
    // 优化：中继模式下跳过 portal.php 预检（省一次中继往返，52pojie 本来就慢）；
    // WAF 检测移到签到页做，签到页有 WAF 同样能识别。
    let home = null, pauseHint = '';
    // 任务页已经明确写着「打卡签到」（未签到）时，门户页预检没意义，省一次请求；
    // 中继模式下也跳过门户页（省一次中继往返，52pojie 本来就慢），WAF 在签到页同样能识别。
    if (!isRelay && !knownUnsigned) {
      try {
        home = await fetchDualText('https://www.52pojie.cn/portal.php', { headers: baseHeaders });
        assertNoWaf(home, home.res.status);
        // 首页公告里提到暂停时，只当作「线索」留到最后当提示，不能当结论
        pauseHint = has(home, PAUSED_MARKS)
          ? '（注：门户页公告提到暂停签到，若确实暂停请等恢复）'
          : '';
      } catch (e) {
        // 预检超时/中继失败：先看站点按钮的状态再下结论（不能凭空报成功，也不能胡报失败）
        if (/超时|timeout|中继|abort|network/i.test(e.message || '')) {
          const st = await probeSignedState();
          if (st === 'signed') return { ok: true, message: '今日已签到（预检超时后验证确认：签到完毕）' };
          if (st === 'unsigned') failUnsigned('预检请求超时，但网站按钮仍是「打卡签到」');
        }
        throw e;
      }
    }

    // ② 签到：用页面上那条「打卡签到」链接的真实地址（含它自己的 id 与 referer）。
    //    Discuz 的任务申请接口认 formhash：页面上有就带上（漏了反而会返回「非法请求」）。
    const abs = (h) => /^https?:\/\//i.test(h) ? h : 'https://www.52pojie.cn/' + String(h).replace(/^\/+/, '');
    let url = signTask.href ? abs(signTask.href) : SIGN_APPLY_URL;
    if (signTask.formhash && !/formhash=/.test(url)) url += (url.includes('?') ? '&' : '?') + 'formhash=' + signTask.formhash;
    let final = null;
    // 中继模式下无法使用 redirect:'manual'（opaqueredirect 响应头不可读），改用 follow 让浏览器自动跟随
    const redirectMode = ctx && ctx.relayDb ? 'follow' : 'manual';
    try {
      for (let i = 0; i < 4; i++) {
        const { res, utf8, gbk } = await fetchDualText(url, { headers: baseHeaders, redirect: redirectMode });
        assertNoWaf({ utf8, gbk }, res.status);
        if (res.status >= 300 && res.status < 400) {
          const loc = res.headers.get('location') || res.headers.get('Location');
          if (!loc) throw new Error('签到失败：重定向无 Location');
          url = /^https?:\/\//i.test(loc) ? loc : 'https://www.52pojie.cn/' + String(loc).replace(/^\/+/, '');
          continue;
        }
        final = { utf8, gbk, status: res.status };
        break;
      }
    } catch (e) {
      // 中继超时/网络错误：请求可能实际成功但响应没回来，先探测一次再下结论
      if (/超时|timeout|中继|abort|network/i.test(e.message || '')) {
        const st = await probeSignedState();
        if (st === 'signed') {
          return { ok: true, message: '今日已签到，无需重复（超时后验证确认：签到完毕）' };
        }
        if (st === 'unsigned') failUnsigned('签到请求超时，网站按钮仍是「打卡签到」');
      }
      throw e;
    }
    if (!final) throw new Error('签到失败：重定向次数过多');

    // 判定只看签到页（home.php?mod=task）——这页的文字都是任务本身的，不会被帖子标题污染
    // 先查 showmessage 弹窗（Discuz 的成功/失败提示藏在 <script> 里，clean 会删掉）
    const showMsg = extractShowMessage(final);
    if (showMsg) {
      const smTexts = { utf8: showMsg, gbk: showMsg };
      if (has(smTexts, SUCCESS_MARKS)) {
        return { ok: true, message: '签到成功：' + showMsg, detail: '网站返回：' + showMsg };
      }
      if (has(smTexts, SIGNED_MARKS)) {
        return { ok: true, message: '今日已签到，无需重复：' + showMsg, detail: '网站返回：' + showMsg };
      }
    }
    const finalText = pickText(final);
    const hasLoginForm = /name=["']loginform["']/i.test(finalText) || /action=["'][^"']*logging\.php/i.test(finalText);
    if (hasLoginForm && !has(final, SIGNED_MARKS) && !has(final, SUCCESS_MARKS)) {
      throw new Error('Cookie 已失效，请重新登录后复制新的 Cookie');
    }
    if (has(final, SUCCESS_MARKS)) {
      // 中继模式下跳过积分页（省一次中继往返，52pojie 本来就慢；积分只是展示用）
      const suffix = isRelay ? '' : await creditSuffix(baseHeaders);
      return { ok: true, message: '签到成功：' + pickLine(final) + suffix, detail: '网站返回：' + clean(final).slice(0, 300) };
    }
    if (has(final, SIGNED_MARKS)) {
      const suffix = isRelay ? '' : await creditSuffix(baseHeaders);
      return { ok: true, message: '今日已签到，无需重复：' + pickLine(final) + suffix, detail: '网站返回：' + clean(final).slice(0, 300) };
    }
    if (has(final, LOGIN_MARKS)) {
      throw new Error('Cookie 已失效，请重新登录后复制新的 Cookie');
    }
    if (has(final, PAUSED_MARKS)) {
      throw new Error('论坛官方暂停签到：' + pickLine(final) + '。等恢复后再试。');
    }
    // 到这一步还没结论。如果站点按钮自己写着「打卡签到」，那就是**明确未签到**：
    // 直接告诉用户没签上（带原因和建议），不要报一句含糊的「未识别到成功标识」。
    if (buttonState(final) === 'unsigned' || knownUnsigned) {
      failUnsigned(buttonState(final) === 'unknown'
        ? '任务页显示网站按钮仍是「打卡签到」'
        : '签到页已返回，但网站按钮仍是「打卡签到」');
    }
    // apply 没出明确结论时，试一次 do=draw 领奖励（Discuz 每日任务：apply 是接任务，draw 是领奖励完成签到）
    try {
      const draw = await fetchDualText('https://www.52pojie.cn/home.php?mod=task&do=draw&id=' + (signTask.id || '2'), { headers: baseHeaders, redirect: redirectMode });
      assertNoWaf(draw, draw.res.status);
      if (has(draw, SUCCESS_MARKS)) {
        const suffix = isRelay ? '' : await creditSuffix(baseHeaders);
        return { ok: true, message: '签到成功：' + pickLine(draw) + suffix, detail: '网站返回：' + clean(draw).slice(0, 300) };
      }
      if (has(draw, SIGNED_MARKS)) {
        const suffix = isRelay ? '' : await creditSuffix(baseHeaders);
        return { ok: true, message: '今日已签到，无需重复：' + pickLine(draw) + suffix, detail: '网站返回：' + clean(draw).slice(0, 300) };
      }
      // draw 页也没结论就用它的内容报，未识别时信息更准
      final = { utf8: draw.utf8, gbk: draw.gbk, status: draw.res.status };
    } catch (e) {
      // draw 失败不致命，继续用 apply 的结果报错
      if (/WAF|安全验证|403|UrlACL/.test(e.message || '')) throw e;
    }
    // 最后一道兜底：页面解析不出结论时，直接查任务实际状态（按钮是「签到完毕」还是「打卡签到」）
    // 避免「网站其实已签到，面板却报未签到」；反过来确定了没签上也要直说。
    try {
      const st = await probeSignedState();
      if (st === 'signed') {
        return { ok: true, message: '今日已签到，无需重复（任务页验证确认：签到完毕）' };
      }
      if (st === 'unsigned') failUnsigned('签到接口已返回，但重新查验发现网站按钮仍是「打卡签到」');
    } catch (e) {
      if (e && e.outcome === 'unsigned') throw e; // 明确未签到的结论要抛出去
      // 其它情况（探测不通）忽略，走下面的报错
    }
    // 诊断：记录页面关键特征，帮助排查为什么没识别到
    const diag = [];
    const diagText = pickText(final);
    if (/task/i.test(diagText)) diag.push('含task字样');
    if (/apply/i.test(diagText)) diag.push('含apply字样');
    if (/draw/i.test(diagText)) diag.push('含draw字样');
    if (/id=2/.test(diagText)) diag.push('含id=2');
    if (/签到/.test(diagText)) diag.push('含"签到"');
    if (/任务/.test(diagText)) diag.push('含"任务"');
    const titleMatch = diagText.match(/<title[^>]*>([^<]{0,60})<\/title>/i);
    if (titleMatch) diag.push('标题:' + titleMatch[1].trim());
    throw new Error(
      `签到失败：未识别到成功标识（HTTP ${final.status}）${pauseHint}` +
        (diag.length ? ` [页面特征:${diag.join(',')}]` : '') + '，' +
        finalText.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 200)
    );
  },
};
