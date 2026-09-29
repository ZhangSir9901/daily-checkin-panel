// 账号页 UI 契约 + 「粘贴 → 体检 → 自动保存」流程的源码级测试
// 说明：账号页是内联在 public/index.html 里的真实脚本（没有构建步骤），
// 所以这里读源码断言关键结构，把这些约定钉住：
//   ①「签到时间」统一叫「全局签到」；
//   ② 左右两栏的标题行 / 说明段 / 底边三处对齐的钩子都在；
//   ③ 粘贴区是一个像样的默认框（5 行 + 等宽 + 自动长高 + 清空 + 实时体检）；
//   ④ 保存前有逻辑性体检，硬错误不许保存、域名对不上先确认；
//   ⑤ 保存成功才清空粘贴框；加完账号会滚过去把那一行闪一下。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(root, 'public', 'index.html'), 'utf8');
const tools = readFileSync(join(root, 'public', 'cookie-tools.js'), 'utf8');

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok -', name); };

t('「签到时间」统一叫「全局签到」（表格列名 + 卡片标题 + 胶囊文案）', () => {
  assert.match(html, /<th class="c">全局签到<\/th>/, '表格列名要叫「全局签到」');
  assert.match(html, /<h2>全局签到<\/h2>/, '左侧卡片标题要叫「全局签到」');
  assert.doesNotMatch(html, /follow \? `跟随 \$\{time\(\)\}`/, '胶囊文案不该再是「跟随 xx:xx」');
  assert.match(html, /textContent = follow \? `全局 \$\{time\(\)\}` : time\(\)/, '胶囊要显示「全局 xx:xx」');
  assert.match(html, /<span class="tp-tag hidden">单独<\/span>/, '单独设过时间的账号要有「单独」标记');
  assert.match(html, /renderTimePicker\(el, initHour \|\| GLOBAL_HOUR, \{ follow: !initHour, followTag: true \}\)/, '账号行的时间胶囊要开 followTag');
  assert.match(html, /全局签到 \$\{displayTime\}/, '顶部那行也要用「全局签到」的说法');
});

t('两栏对齐：标题行 / 说明段 / 底边 三处都对齐', () => {
  assert.match(html, /\.col-head \{ display:flex; align-items:center; justify-content:space-between; gap:10px; min-height:34px/, '标题行要固定最小高度');
  assert.match(html, /\.col-tip \{ font-size:12\.5px; line-height:1\.7; color:var\(--muted\); margin:0 0 12px; min-height:64px; \}/,
    '说明段要固定三行高度（两栏第一块内容才会对齐）');
  // 两栏的说明段要都在标题行下面、位置相同（不能一边在上、一边在下）
  const leftCol = html.slice(html.indexOf('<div class="col">'), html.indexOf('<div class="col">', html.indexOf('<div class="col">') + 1));
  assert.ok(leftCol.indexOf('class="col-tip"') < leftCol.indexOf('class="sched-bar"'), '左栏说明段要在时间胶囊上面');
  assert.match(html, /\.col > \.push-bottom \{ margin-top:auto; \}/, '左栏的扩展块要能顶到底');
  assert.match(html, /\.two-col > \.col \{ display:flex; flex-direction:column; min-width:0; \}/, '每栏要是 flex 列');
  assert.equal((html.match(/class="col-head"/g) || []).length, 2, '两栏各有一个 .col-head');
  assert.match(html, /<div class="ext-mini push-bottom">/, '扩展块要带 push-bottom');
  assert.match(html, /\.sched-bar, \.ext-mini, \.paste-box, \.ckb \{\n\s*border-radius:var\(--radius-sm\); border:1px solid var\(--line\);/,
    '内层小块要共用一套度量（同圆角/描边/内边距）');
});

t('粘贴区是一个像样的默认框（5 行 + 等宽 + 自动长高 + 清空 + 实时体检）', () => {
  assert.match(html, /<textarea id="ck-paste" rows="5"/, '粘贴框默认 5 行');
  assert.match(html, /\.paste-box textarea \{ margin:0; min-height:104px; max-height:280px/, '粘贴框有最小/最大高度');
  assert.match(html, /function autoGrowPaste\(\)/, '粘贴框要能自动长高');
  assert.match(html, /<button class="ghost sm" id="btn-ck-clear" type="button">清空<\/button>/, '有清空按钮');
  assert.match(html, /<div id="ck-live" class="paste-live">/, '粘贴框下面有实时体检行');
  assert.match(html, /addEventListener\('input', \(\) => \{ autoGrowPaste\(\); refreshPasteState\(\); \}\)/, '输入时实时体检');
  assert.match(html, /<button id="btn-parse-paste" type="button" disabled>/, '粘贴框空着时保存按钮是禁用的');
});

t('保存前的逻辑性体检：硬错误拦住、域名对不上先确认', () => {
  assert.match(html, /function pasteCheck\(info\)/, '要有 pasteCheck');
  assert.match(html, /function refreshPasteState\(\)/, '要有即时状态刷新');
  assert.match(html, /if \(chk\.level === 'bad'\) \{/, '硬错误要拦住');
  assert.match(html, /return pasteFail\(new Error\(\(bad && bad\.title\)/, '硬错误要给出可读原因');
  assert.match(html, /chk\.mismatch && chk\.siteId[\s\S]{0,220}openCookieApplyDialog/, '域名与站点对不上要让人确认一次');
  assert.match(html, /catch \(e\) \{ return pasteFail\(e\); \}/, '解析失败要走 pasteFail');
  assert.match(html, /function pasteFail\(e, detail\)/, 'pasteFail 要能带一句「怎么修」');
});

t('保存路径只有一条：按钮 / 粘贴 / 解析器都走 applyPaste', () => {
  assert.match(html, /async function applyPaste\(\)/, '要有 applyPaste');
  assert.match(html, /\$\('btn-parse-paste'\)\.onclick = \(\) => \{ applyPaste\(\); \};/, '保存按钮要调到 applyPaste');
  assert.match(html, /\$\('ck-paste'\)\.value = raw;[\s\S]{0,220}applyPaste\(\);/, '「填到上面并保存」也要走 applyPaste');
  assert.match(html, /const st = refreshPasteState\(\);\n\s*if \(st && st\.chk\.level !== 'bad'\) applyPaste\(\);/, '粘贴后自动体检 + 自动保存');
});

t('保存成功才清空粘贴框（避免误点又存一遍）', () => {
  assert.match(html, /const saved = await autoApplyCookies\(/, '要拿到「真的写进去了」的结果');
  assert.match(html, /if \(saved\) clearPasteBox\(\);/, '只有成功才清空');
  assert.match(html, /if \(!s\) \{ toast\('未知站点'\); return false; \}/, 'autoApplyCookies 失败路径返回 false');
  assert.match(html, /showExtApplied\(s, d, \{ names, ls, actionText, accountId \}\);\n  return true;/, '成功路径返回 true');
});

t('加完账号指给你看是哪一行（打通流程的最后一步）', () => {
  assert.match(html, /function flashRow\(accountId\)/, '要有 flashRow');
  assert.match(html, /tbody tr\.row-flash \{ animation:rowFlash/, '要有闪烁样式');
  assert.match(html, /<button class="ghost" id="ext-goto">去账号列表看这一行<\/button>/, '弹窗里要有「去看这一行」');
  assert.match(html, /flashRow\(info\.accountId\)/, '按钮要真的滚过去闪一下');
});

t('扩展送来的交接码：内容是拿到手之后才抹掉地址栏里的短码', () => {
  const at = html.indexOf("const mh = (location.hash || '').match(/#handoff=");
  assert.ok(at > 0, '找不到交接码分支');
  const seg = html.slice(at, at + 1400);
  assert.ok(!/history\.replaceState/.test(seg.split('const d0 =')[0] || ''),
    '取回成功之前不该先抹掉短码（否则网络一抖就没法重试）');
  assert.match(seg, /if \(!sid0\) return openCookieSitePicker/, '认不出站点要让人选');
  assert.match(seg, /pasteCheck\(\{ \.\.\.d0, siteId: sid0 \}\)\.mismatch/, '交接码路径也要做域名比对');
});

t('体检函数有单测，也真的被页面用上（旧缓存没有它时也不能把流程弄挂）', () => {
  assert.match(tools, /function checkPastedCreds\(info\)/, 'cookie-tools.js 里要有 checkPastedCreds');
  assert.match(tools, /globalThis\.checkPastedCreds = checkPastedCreds;/, '要挂到全局给页面用');
  assert.match(html, /checkPastedCreds\(info\)/, '页面要真的调用它');
  assert.match(html, /typeof checkPastedCreds === 'function'/, '旧缓存没有它时要能降级');
});

t('卡片标题行统一（不再各写各的 inline style）', () => {
  assert.match(html, /\.card-head \{ display:flex; align-items:center; justify-content:space-between; gap:10px; margin:0 0 12px; \}/,
    '要有统一的 .card-head');
  assert.match(html, /\.card-head > h2 \{ margin:0; \}/, '.card-head 里的 h2 不要再吃第一块的下边距');
  assert.ok((html.match(/class="card-head"/g) || []).length >= 3, '标题行都得用 .card-head');
  assert.doesNotMatch(html, /style="justify-content:space-between;margin-bottom:12px;\">\s*\n\s*<h2>/, '不该再有 inline 的标题行');
});

t('页面上「签到时间」一律叫「全局签到」（含加载中 / 失败 / 空表兜底文案）', () => {
  assert.doesNotMatch(html, /自动签到时间/, '不该再有「自动签到时间」这个说法');
  assert.match(html, /id="sched-line">全局签到时间加载中…</, '顶部加载中文案');
  assert.match(html, /\$\('sched-line'\)\.textContent = '全局签到时间加载失败'/, '失败文案');
  assert.match(html, /全局签到时间在下面「全局签到」卡片里改/, '空表兜底文案要指到「全局签到」卡片');
});

t('添加/更新账号：保存前先体检，硬错误拦在请求之前', () => {
  assert.match(html, /<div id="f-check" class="form-check hidden"><\/div>/, '弹窗里要有体检行');
  assert.match(html, /function checkAccountForm\(\)/, '要有 checkAccountForm');
  assert.match(html, /function renderFormCheck\(st\)/, '要有 renderFormCheck');
  const at = html.indexOf("$('btn-save').onclick");
  const seg = html.slice(at, at + 1200);
  assert.ok(at > 0 && seg.indexOf('renderFormCheck(checkAccountForm())') > 0, '保存要先体检');
  assert.ok(seg.indexOf("st.level === 'bad'") > 0 && seg.indexOf('return;') > 0, '硬错误要先 return');
  assert.match(seg, /el\.focus\(\); el\.scrollIntoView/, '指出是哪一格并focus过去');
  assert.match(html, /liveFormCheck\(\);\n\}/, '打开弹窗就体检一次');
  assert.match(html, /el\.addEventListener\('input', liveFormCheck\)/, '边填边体检');
  assert.match(html, /标了 \* 的是必填项/, '必填漏填要讲明白');
  assert.match(html, /classList\.add\('field-bad'\)/, '有问题的输入框要描红');
  assert.match(html, /以 http:\/\/ 或 https:\/\/ 开头/, '网址字段要校验协议头');
});

t('添加/更新账号：能自动替人做的事就别让人手填', () => {
  assert.match(html, /function normalizeCookieField\(raw\)/, '要有「整段内容只取 Cookie」的归一化');
  assert.match(html, /const wrapped = \/\(\^\|\\n\)\\s\*\(GET\|POST/, '只对整段请求头/cURL/JSON 动手');
  assert.match(html, /Cookie 框里是整段内容，已自动只取 Cookie 部分/, '自动改了要如实告知');
  assert.match(html, /const name = \$\('f-name'\)\.value\.trim\(\) \|\| \(st\.site \? st\.site\.name : siteId\)/,
    '备注名空着就用站点名兜底');
  assert.match(html, /备注名会自动补成/, '兜底要在体检行里说一声');
});

t('执行路线自动选路：徽章显示「实际路线」，换过路要写出来', () => {
  // 线上事故：糊涂鳄从 CF 直连实测正常，旧版韧「扩展在线就全走中继」把它挤成超时，
  // 面板记失败而网站其实已签 —— 徽章只显示「站点默认」就是在骗人。
  assert.match(html, /try \{ remembered = JSON\.parse\(a\.meta \|\| '\{\}'\)\.exec_route \|\| ''; \} catch/,
    '要做 runner 记下的「上次走通的路线」');
  assert.match(html, /const effRoute = !auto[\s\S]{0,320}?siteLocalExec \? 'relay' : 'server'/,
    '自动模式：先看记下的路线，没记录才用站点默认');
  assert.match(html, /const prefix = auto \? '自动 · ' : '';/, '自动模式的徽章要带「自动 · 」前缀');
  assert.match(html, /const auto = !execOverride;/, '手动覆盖后就不该再标「自动」');
  assert.match(html, /routeNote = m\.route_note \|\| '';/, '要读 meta.route_note');
  assert.match(html, /const routeShow = \/自动改走\|都没成功\/\.test\(routeNote\) \? routeNote : '';/,
    '换路记录只在真的换过路线时才占一行');
  assert.match(html, /class="msg-route"/, '换路记录要有展示位');
  assert.match(html, /\.msg-main, \.msg-raw, \.msg-route, \.hint-tip'/, '截断判定要把换路记录也算进去');
  // 旧建议是错的（实测直连更快更稳），必须删干净
  assert.doesNotMatch(html, /糊涂鳄对机房 IP 更严格/, '糊涂鳄的旧建议（让我切本地网络）与实测不符');
  // 糊涂鳄一个模块管两个域名，提示必须把「dj 直连正常 / hutue.cn 只能本地网络」都说清楚，
  // 只说一半（曾经只写「直连正常」）就是在误导 hutue.cn 那个账号。
  assert.match(html, /hutue: '糊涂鳄分两个独立站：dj\.hutue\.cn 从 CF 网络直连正常/, '糊涂鳄提示没区分两个域名');
  assert.match(html, /hutue\.cn 在 CF 出口被站点 WAF 整站拦死/, '要写明 hutue.cn 从 CF 出口被整站拦死（实测依据）');
});

t('反馈里不摆英文代码，账号行模板里也不能夹注释（会被当成页面内容）', () => {
  // 用户看到的：日志里那行「网站回馈：网站返回：{"success":false,"message":"…"}」——
  // 主文案已经写着那句话了，再摆一串 JSON 只是占地方 + 看着像报错。
  assert.match(html, /function rawFeedbackLine\(raw, shownMsg\)/, '要有 rawFeedbackLine');
  assert.match(html, /const rawClean = rawFeedbackLine\(a\.last_detail, msgShow\)/, '账号行要用它');
  assert.match(html, /const detailLine = rawFeedbackLine\(r\.detail, r\.message\)/, '运行日志也要用它');
  assert.match(html, /网站回馈：\$\{esc\(detailLine\)\}/, '日志里的网站回馈要用清理后的文本');
  assert.doesNotMatch(html, /网站回馈：\$\{esc\(r\.detail\)\}/, '不能把整串 JSON 直接摆出来');
  assert.match(html, /const rawTip = !rawShow && rawText \?/, '不摆出来时也要留一个悬浮看原文的入口');

  // 曾经踩过：注释写在 `return \`` 的下一行 → 成了模板内容，每行账号都把它渲染成文字
  const at = html.indexOf('tb.innerHTML = accounts.map((a) => {');
  assert.ok(at > 0, '找不到账号行模板');
  const seg = html.slice(at, at + 9000);
  const ret = seg.indexOf('return `');
  assert.ok(ret > 0, '账号行模板里找不到 return `');
  const firstLine = (seg.slice(ret + 'return `'.length).split('\n')[1] || '').trim();
  assert.match(firstLine, /^<tr>/, '账号行模板第一行必须是 <tr>，实际：' + firstLine.slice(0, 40));

  // 这个坑单独立了一条自检（语法检查发现不了：它本来就是合法字符串）
  const checkTool = readFileSync(join(root, 'tools', 'check-template-comments.mjs'), 'utf8');
  assert.match(checkTool, /模板字符串里出现了/, '自检工具要能报出泄漏');
  const verifySrc = readFileSync(join(root, 'tools', 'verify.mjs'), 'utf8');
  assert.match(verifySrc, /check-template-comments\.mjs/, '自检要接进 verify.mjs');
});

t('浮层自动收起：共用浮层必须认领「当前主人」（否则鼠标还没进浮层就消失）', () => {
  // 线上表现：点开「全局签到」时间胶囊，鼠标还没来得及移进浮层，它就自己收起来了。
  // 根因：时间浮层是**全页面共用一个元素**，而每个胶囊渲染时都直接覆盖
  // pop.onmouseenter —— 鼠标真进了浮层，cancel 清掉的是「别人的」定时器，
  // 当前胶囊那个 320ms 收起定时器照旧到点执行。
  assert.match(html, /const _popOwner = new WeakMap\(\)/, '缺少「这个浮层现在归谁管」的记录');
  assert.match(html, /pop\.onmouseenter = \(\) => \{ const c = _popOwner\.get\(pop\); if \(c\) c\.cancel\(\); \}/,
    '鼠标进浮层时要现查主人、清掉它的定时器（不能绑死在某个胶囊上）');
  assert.match(html, /ctl\.own\(\)/, '打开浮层时要说清「现在归我管」（own）');
  assert.doesNotMatch(html, /\n\s*bindAutoHide\(pop, chip\);/, '不能回到「渲染时就绑定、丢掉返回值」的老写法（后面创建的胶囊会把它覆盖掉）');
  assert.match(html, /const ctl = bindAutoHide\(pop, chip\);/, '浮动层要拿到控制器（好在打开时认领）');
  // 时区浮层同样要有主人概念，否则它的自动收起也会失效
  assert.match(html, /bindAutoHide\(pop, btn\)\.own\(\)/, '时区浮层也要认领');
});

t('自动检查心跳：面板顶部能看出定时到底有没有在跑', () => {
  // 「时间到了却没签到」以前在面板上完全看不出来：心跳把这层补上。
  assert.match(html, /function schedBeatText\(s\)/, '要有心跳文案函数');
  assert.match(html, /自动检查：暂无记录/, '没有任何记录时也要给一句话');
  assert.match(html, /if \(minutes > 45\)/, '超过 45 分钟没记录就要判定为停摆');
  assert.match(html, /⚠️ 自动检查\$\{hours\}/, '停摆要显式告警（含最后一次时间与排查方向）');
  assert.match(html, /paintSchedLine\(s, displayTime\)/, '顶部那行要用它渲染');
  assert.match(html, /setInterval\(async \(\) => \{[\s\S]{0,240}?paintSchedLine\(s, displayTime\)/, '要有只刷心跳的轮询');
  assert.doesNotMatch(html, /setInterval\(.*loadSchedule/, '轮询不能整块重渲染（那会把用户正开着的浮层关掉）');
});

t('执行：面板不许自己把慢请求提前掐断（否则会报一个假的「执行失败」）', () => {
  // 线上后果：点「执行」/「全部执行」，60 秒到点面板自己 abort，弹一句「执行失败」；
  // 而服务端还在跑，站点很可能已经签上了 —— 用户照着提示再点一次，就是第二轮重复请求。
  assert.match(html, /const API_TIMEOUT_MS = 60000;/, '普通请求保留 60 秒默认超时');
  assert.match(html, /const RUN_TIMEOUT_MS = 150000;/, '执行类请求要单独放开超时');
  assert.match(html, /async function api\(path, method = 'GET', data, opts = \{\}\) \{/, 'api 要支持自定义超时');
  assert.match(html, /opts\.timeoutMs/, '超时要能从调用处传进来');
  assert.match(html, /err\.timedOut = true;/, '超时要能识别出来（好说清「不是失败，是没等到」）');
  assert.equal((html.match(/r\.json\(\)\.catch\(\(\) => \(\{\}\)\)/g) || []).length, 0,
    '不能再用 r.json() 吞掉非 JSON 的错误页（524 会变成一句看不懂的「请求失败 524」）');
  assert.match(html, /raw\.trim\(\)\.startsWith\('\{'\)/, '要能分辨「JSON 错误」与「Cloudflare 的 HTML 错误页」');
});

t('执行：单个账号走同一条路径，结果口径完全一致', () => {
  assert.match(html, /async function runOneAccount\(id, btn = null, quiet = false\)/, '要有 runOneAccount');
  assert.match(html, /api\('\/api\/accounts\/' \+ id \+ '\/run', 'POST', undefined, \{ timeoutMs: RUN_TIMEOUT_MS \}\)/, '要用放开后的超时');
  assert.match(html, /tb\.querySelectorAll\('\[data-run\]'\)\.forEach\(\(b\) => \(b\.onclick = \(\) => runOneAccount\(b\.dataset\.run, b\)\)\)/,
    '行内「执行」按钮要调它');
});

t('全部执行：逐账号发请求，不再用一个请求串完全部', () => {
  // /api/run-all 是「一个请求跑完所有账号」：每个账号最坏等 90 秒 →
  // Cloudflare 单个请求约 100 秒上限（回 524）、浏览器 60 秒就断 —— 必然假失败。
  const at = html.indexOf("$('btn-run-all').onclick");
  assert.ok(at > 0, '找不到全部执行的处理器');
  const seg = html.slice(at, at + 2200);
  assert.doesNotMatch(seg, /api\('\/api\/run-all'/, '面板不该再调那个长请求');
  assert.match(seg, /for \(let i = 0; i < list\.length; i\+\+\)/, '要逐账号循环');
  assert.match(seg, /runOneAccount\(a\.id, null, true\)/, '循环里走同一条执行路径（只是不逐条弹提示）');
  assert.match(seg, /执行中… \$\{i \+ 1\}\/\$\{list\.length\}/, '按钮上要能看到进度');
  assert.match(seg, /ACCTS \|\| \[\]\)\.filter\(\(a\) => a\.enabled\)/, '只跑启用的账号');
  assert.match(seg, /api\('\/api\/notify-report'/, '手动跑完仍要推日报（以前挂在 /api/run-all 上）');
  // 推送失败不许影响面板上的结果
  assert.match(seg, /api\('\/api\/notify-report'[\s\S]{0,120}?\.catch\(\(\) => \{\}\)/, '推送失败要静默');
});

console.log(`\n${n} 通过`);
