// 生成「签到账号」表格的预览页：不部署、不连线上，就能看到真实排版。
//
// 做法：把 public/index.html 的 CSS + <body> + 内联 <script> 原样搬过来，
// 只在最前面插一段「假后端」把 window.fetch 拦掉，返回一份仿真数据。
// 这样预览里跑的就是线上那一份真实代码（表格行、红标、提示气泡都是真的），
// 而不是重画一个近似版。
//
// 用法：node tools/gen-table-preview.mjs  → 输出 ../../_preview/table.html
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { siteMeta } from '../src/sites/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const html = readFileSync(resolve(root, 'public/index.html'), 'utf8');

const styleM = html.match(/<style>([\s\S]*?)<\/style>/);
const scriptM = html.match(/<script>([\s\S]*?)<\/script>\s*<\/body>/);
// 只取到第一个 <script 之前。不能取到 </script>：
// 那两个外部脚本（curl-import.js / cookie-tools.js）是 <script src=…></script>，
// 如果切在标签中间，剩下的半个 <script 会把整页吞掉，预览就白了。
const bodyM = html.match(/<body>([\s\S]*?)\n<script/);
if (!styleM || !scriptM || !bodyM) throw new Error('没找到 <style> / <body> / 内联 <script>');

const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' })
  .format(new Date());
const now = Date.now();

// 仿真账号：尽量复刻线上真实会出现的几种状态（含出错的红标）
const accounts = [
  {
    id: 1, name: 'NodeSeek', site: 'nodeseek', enabled: 1,
    meta: JSON.stringify({ toggles: { random: true }, last_signin_date: today }),
    // 这里故意用**旧的存库文案**（我们自己的套话）+ 线上真实的网站原文：
    // 面板会改用网站原话当主文案，并打上「网站原话」标记 ——
    // 也就是说部署后，**已经存在的那些旧记录立刻就会显示成网站原话**，不用等下一次执行。
    last_status: 'ok',
    last_msg: '今日已签到，不能重复签到',
    last_detail: '网站返回：{"success":false,"message":"今天已完成签到，请勿重复操作"}',
    last_run_at: now - 4000,
  },
  {
    id: 2, name: 'AK', site: 'akile', enabled: 1,
    meta: JSON.stringify({ last_signin_date: today }),
    last_status: 'ok', last_msg: '今日已签到，无需重复',
    last_detail: '网站返回：{"status_code":1,"status_msg":"今日已签到"}',
    last_run_at: now - 70000,
  },
  {
    id: 3, name: '69机场', site: 'v2board', enabled: 1,
    meta: JSON.stringify({ last_signin_date: today }),
    last_status: 'ok', last_msg: '签到成功，获得 1.2 GB 流量',
    last_detail: '网站返回：{"ret":1,"msg":"签到成功","data":{"traffic":1288490188}}',
    last_run_at: now - 78000,
  },
  {
    // 演示「网站反馈 + 红标提示」：未识别到成功标识本身不致命，
    // 红标里是对着失败类型给出的中文建议
    id: 4, name: '吾爱破解', site: 'wuaipojie', enabled: 1,
    meta: JSON.stringify({}),
    last_status: 'fail',
    last_msg: '签到失败：未识别到成功标识（HTTP 403）',
    last_detail: '网站返回：403 Forbidden Client IP: 172.70.215.118 eventID: 1249-1790535085.403-waf02whc reason:UrlACL',
    last_run_at: now - 300000,
  },
  {
    id: 5, name: '糊涂鳄', site: 'hutue', enabled: 1,
    meta: JSON.stringify({ sched_hour: '07:00', last_signin_date: today }),
    last_status: 'ok', last_msg: '签到成功，赠送5晶石',
    // 线上糊涂鳄返回的是全转义 JSON（\u4eca\u65e5…），面板要还原成人话
    last_detail: '网站返回：{"status":"0","msg":"\\u4eca\\u65e5\\u5df2\\u7b7e\\u5230\\uff0c\\u8bf7\\u660e\\u65e5\\u518d\\u6765"}',
    last_run_at: now - 120000,
  },
  {
    id: 6, name: '看雪', site: 'kanxue', enabled: 0,
    meta: JSON.stringify({}),
    last_status: 'skip', last_msg: '需要浏览器扩展在线（本地网络中继）。',
    last_detail: '',
    last_run_at: now - 900000,
  },
  // 「结果未知」：请求发出去了但没等到回包 —— 状态列要显示「待确认」，而不是武断的「未签到」
  {
    id: 8, name: '糊涂鳄（hf）', site: 'hutue', enabled: 1,
    meta: JSON.stringify({ sched_hour: '08:05' }),
    last_status: 'skip',
    last_msg: '签到结果未知：请求已发出但没等到回包（本地网络失败：中继执行超时（58秒）：请求已发出但没收到回包）。请求可能已经送达网站（签到可能已生效），也可能没有；稍后会自动复核。',
    last_detail: '网站返回：（无响应） · 接口 user_qiandao · user_qiandao：重试仍无回包',
    last_run_at: now - 60000,
  },
];

const page = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>签到账号表格预览</title>
<style>${styleM[1]}</style>
</head>
<body>
${bodyM[1]}
<script>
// —— 预览专用假后端：拦掉 fetch，返回仿真数据 ——
// 这样下面那段「真实面板脚本」会以为自己在跟线上 Worker 说话。
const _SITES = ${JSON.stringify(siteMeta())};
const _ACCOUNTS = ${JSON.stringify(accounts)};
window.fetch = async (path) => {
  const p = String(path);
  const ok = (obj) => new Response(JSON.stringify(obj), { status: 200, headers: { 'Content-Type': 'application/json' } });
  if (p.startsWith('/api/status')) return ok({ logged_in: true, setup_needed: false });
  if (p.startsWith('/api/sites')) return ok({ sites: _SITES });
  if (p.startsWith('/api/schedule')) return ok({ time: '08:00', tz: 'Asia/Shanghai' });
  if (p.startsWith('/api/relay-status')) return ok({ online: true, version: '2.2', last_poll: Date.now() });
  if (p.startsWith('/api/accounts')) return ok({ accounts: _ACCOUNTS });
  if (p.startsWith('/api/logs')) return ok({ logs: [], total: 0 });
  if (p.startsWith('/api/settings')) return ok({ settings: {} });
  if (p.startsWith('/api/ext-key')) return ok({ key: 'preview-key-000' });
  return ok({ ok: true });
};
</script>
<script>${scriptM[1]}</script>
</body>
</html>
`;

const out = resolve(root, '../../_preview/table.html');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, page, 'utf8');
console.log('已生成预览页：' + out + '（' + Buffer.byteLength(page, 'utf8') + ' 字节）');
