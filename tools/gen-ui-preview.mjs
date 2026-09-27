// 生成界面预览页（不部署就能看排版）
// 用法：node tools/gen-ui-preview.mjs  → 输出 ../../_preview/ui.html
// 抽取 public/index.html 里的真实标记 + 真实 CSS，不是重画的。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const html = readFileSync(resolve(root, 'public/index.html'), 'utf8');

const styleM = html.match(/<style>([\s\S]*?)<\/style>/);
if (!styleM) throw new Error('找不到 <style> 块');
const css = styleM[1];

// 从某个 <div ...> 的起始下标开始，做 div 配对扫描，返回这一段完整标记。
// 关键：不能只 slice 到「下一个卡片」——最后一张卡会一路吞到 </html>，
// 把真正的 <script> 也带进来（预览页里就会重复声明 const $，整段脚本直接报错不执行）。
function balancedDivAt(start) {
  if (start < 0) throw new Error('起始下标无效');
  let i = start;
  let depth = 0;
  while (i < html.length) {
    const open = html.indexOf('<div', i);
    const close = html.indexOf('</div>', i);
    if (close < 0) break;
    if (open >= 0 && open < close) {
      depth++;
      i = open + 4;
    } else {
      depth--;
      i = close + 6;
      if (depth === 0) return html.slice(start, i);
    }
  }
  throw new Error('div 无法配对（start=' + start + '）');
}

function balancedDivByTag(startTag) {
  const start = html.indexOf(startTag);
  if (start < 0) throw new Error('找不到 ' + startTag);
  return balancedDivAt(start);
}

// 按卡片标题找整张卡（<h2> 可能带 style，用正则定位标题）
function cardByTitle(title, from = 0, to = html.length) {
  const sec = html.slice(from, to);
  const re = new RegExp('<h2[^>]*>' + title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const m = sec.match(re);
  if (!m) throw new Error('找不到卡片：' + title);
  const h2Abs = from + m.index;
  const cardStart = html.lastIndexOf('<div class="card">', h2Abs);
  if (cardStart < 0) throw new Error('卡片没有 <div class="card"> 外壳：' + title);
  return balancedDivAt(cardStart);
}

const accSecStart = html.indexOf('<section id="tab-accounts">');
const accSecEnd = html.indexOf('<section id="tab-logs"');
if (accSecStart < 0 || accSecEnd <= accSecStart) throw new Error('找不到「签到账号」区块');

const topbar = balancedDivByTag('<div class="topbar">');
const schedCard = cardByTitle('签到时间', accSecStart, accSecEnd);
const cookieCard = cardByTitle('添加 / 更新账号', accSecStart, accSecEnd);
const extCard = cardByTitle('🔌 浏览器扩展', html.indexOf('<section id="tab-settings"'));

// 时间选择器脚本段（预览页要用它把胶囊/滚轮真正渲染出来）
const jsStart = html.indexOf('// ---------- 时间选择器');
const jsEnd = html.indexOf('// ---------- 签到时间设置 ----------');
if (jsStart < 0 || jsEnd <= jsStart) throw new Error('找不到时间选择器脚本段');
const js = html.slice(jsStart, jsEnd);

function stateTopbar(cls, text, sub) {
  return topbar
    .replace('class="wait"', 'class="' + cls + '"')
    .replace(/<span id="ext-state-text">[^<]*<\/span>/, '<span id="ext-state-text">' + text + '</span>')
    .replace(/id="ext-state-sub">[^<]*/, 'id="ext-state-sub">' + sub);
}

const page = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>面板界面预览</title>
<style>${css}</style>
</head>
<body>
<div class="wrap">
  <p class="muted">以下取自 public/index.html 的真实标记与样式。</p>

  <h2 style="margin-top:18px">首页顶栏 · 扩展离线（灰）</h2>
  ${stateTopbar('off', '扩展离线（本地网络不可用）', '切「本地网络」需先安装并打开扩展')}

  <h2 style="margin-top:18px">首页顶栏 · 扩展在线（绿，呼吸点）</h2>
  ${stateTopbar('on', '扩展在线（自动中继已启用）', '可切「本地网络」：请求经您的浏览器发出')}

  <h2 style="margin-top:22px">签到时间（已移到「签到账号」页，账号表下面）</h2>
  ${schedCard}

  <h2 style="margin-top:22px">添加 / 更新账号（一个粘贴框搞定）</h2>
  ${cookieCard}

  <h2 style="margin-top:22px">设置页 · 浏览器扩展</h2>
  ${extCard}
</div>
<script>
const $ = (id) => document.getElementById(id);
${js}

const sched = $('sched-tp');
if (sched) {
  const p = renderTimePicker(sched, '08:00', { noFollow: true, large: true });
  p.set('08:30');
}
const sel = $('sched-tz');
if (sel) sel.innerHTML = ['Asia/Shanghai', 'UTC', 'America/New_York'].map((z) => '<option>' + z + '</option>').join('');
</script>
</body>
</html>
`;

const out = resolve(root, '../../_preview/ui.html');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, page, 'utf8');
console.log('已生成预览页：' + out + '（' + Buffer.byteLength(page, 'utf8') + ' 字节）');
