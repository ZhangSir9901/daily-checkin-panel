// 生成时间选择器的独立预览页（不部署也能看视觉效果）
// 用法：node tools/gen-tp-preview.mjs
// 输出：../../_preview/tp.html（相对本仓库；可按需改 OUT）
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const html = readFileSync(resolve(root, 'public/index.html'), 'utf8');

// 1) 样式表
const styleM = html.match(/<style>([\s\S]*?)<\/style>/);
if (!styleM) throw new Error('找不到 <style> 块');
const css = styleM[1];

// 2) 时间选择器脚本（从「时间选择器」注释块到「签到时间设置」注释块之前）
const jsStart = html.indexOf('// ---------- 时间选择器');
const jsEnd = html.indexOf('// ---------- 签到时间设置 ----------');
if (jsStart < 0 || jsEnd < 0 || jsEnd <= jsStart) throw new Error('找不到时间选择器脚本段');
const js = html.slice(jsStart, jsEnd);

const page = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>时间选择器预览</title>
<style>${css}</style>
</head>
<body>
<div class="wrap">
  <h1>时间选择器预览</h1>

  <div class="card">
    <h2>签到时间（设置页内嵌形态）</h2>
    <p class="muted">Worker 每分钟唤醒一次，到达设定的时间才执行签到。修改即时生效，无需重新部署。</p>
    <div class="row">
      <div><label>每天执行时间</label><div id="sched-tp"></div></div>
      <div style="flex:1;min-width:200px"><label>时区</label><select id="sched-tz"></select></div>
    </div>
    <button id="btn-save-sched" style="margin-top:12px">保存时间设置</button>
  </div>

  <div class="card">
    <h2>账号独立时间（列表胶囊 + 浮层）</h2>
    <p class="muted">点下面的胶囊试试浮层滚轮；浮层里可「跟随全局」或「完成」。</p>
    <table>
      <thead><tr><th>站点</th><th>签到时间</th><th>网站反馈</th></tr></thead>
      <tbody id="tb"></tbody>
    </table>
  </div>
</div>
<script>
// 预览页里只实现用到的几个 DOM 小工具
const $ = (id) => document.getElementById(id);
${js}
// 设置页内嵌
const p1 = renderTimePicker($('sched-tp'), '08:00', { inline: true });
$('sched-tz').innerHTML = ['Asia/Shanghai', 'UTC', 'America/New_York'].map((z) => '<option>' + z + '</option>').join('');
// 账号列表胶囊
const rows = [
  ['NodeSeek', '08:00', true, '今日已签到，不能重复签到'],
  ['吾爱破解', '', false, '签到成功：任务已完成，获得 2 吾爱币'],
  ['糊涂鳄', '21:30', false, 'Cookie 已失效，请重新登录后复制新的 Cookie'],
];
$('tb').innerHTML = rows.map(([name, hour, follow, msg], i) => \`
  <tr>
    <td><b>\${name}</b></td>
    <td><div class="sched-cell"><div data-tp-acc="\${i}" title="点击设置独立签到时间"></div></div></td>
    <td class="muted">\${msg}</td>
  </tr>\`).join('');
document.querySelectorAll('[data-tp-acc]').forEach((el) => {
  const r = rows[Number(el.dataset.tpAcc)];
  renderTimePicker(el, r[1] || '08:00', { follow: r[2] });
});
</script>
</body>
</html>
`;

const out = resolve(root, '../../_preview/tp.html');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, page, 'utf8');
console.log('已生成预览页：' + out + '（' + Buffer.byteLength(page, 'utf8') + ' 字节）');
