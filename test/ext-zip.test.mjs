// 扩展下载包（/checkin-helper.zip）的测试：node test/ext-zip.test.mjs（纯内存，不联网）
//
// 为什么单独立一条：这是「别人 clone 仓库 → 自己部署 → 下载扩展」这条路上最容易出错的一环。
// 下载包里必须**自动写好他自己的面板地址**（不然人人都会卡在「扩展连不上面板」那一步），
// 同时包里绝不能带 API Key（Key 要用户自己去面板复制，随时能换）。
import assert from 'node:assert/strict';
import { handleExtZip } from '../src/ext-zip.js';
import { EXT_FILES } from '../src/ext-files.js';

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log('ok -', name); };

const FILES = ['manifest.json', 'popup.html', 'popup.js', 'background.js',
  'icon16.png', 'icon32.png', 'icon48.png', 'icon128.png'];

async function zipFor(origin) {
  const res = await handleExtZip({ url: origin + '/checkin-helper.zip' }, {});
  assert.equal(res.status, 200);
  const buf = Buffer.from(await res.arrayBuffer());
  return { res, buf };
}

// 在 STORE（不压缩）的 zip 里，文件内容是明文，可以直接在字节里找字符串
const has = (buf, s) => buf.includes(Buffer.from(s, 'utf8'));

await t('扩展 zip：面板地址自动跟着部署地址走（不同地址出不同的包）', async () => {
  const a = await zipFor('https://panel-one.example.workers.dev');
  const b = await zipFor('https://panel-two.example.workers.dev');
  assert.ok(has(a.buf, 'https://panel-one.example.workers.dev'), 'popup.js / background.js 里要带上当前面板地址');
  assert.ok(has(b.buf, 'https://panel-two.example.workers.dev'));
  assert.ok(!has(a.buf, 'panel-two'), 'A 的包里不能出现 B 的地址（别把地址写死或缓存住）');
  assert.ok(!has(b.buf, 'panel-one'));
});

await t('扩展 zip：占位符必须被全部替换掉（漏一个扩展就拿不到地址）', async () => {
  const { buf } = await zipFor('https://demo-panel.workers.dev');
  assert.ok(!has(buf, '__PANEL_URL__'), '不允许留下未替换的占位符');
  // popup.js 与 background.js 里各有一处占位符；两处都要替到
  const text = buf.toString('latin1');
  const hits = text.split('https://demo-panel.workers.dev').length - 1;
  assert.ok(hits >= 2, '两处占位符都要替换（实际只替了 ' + hits + ' 处）');
});

await t('扩展 zip：包里不带 API Key（Key 由用户自己在面板复制）', async () => {
  const { buf } = await zipFor('https://demo-panel.workers.dev');
  // EXT_FILES 里本来就不该有 key；这里兜住「哪天有人图省事把 key 注入进去」
  assert.ok(!/X-Api-Key['"]\s*:\s*['"][A-Za-z0-9]{16,}/.test(buf.toString('latin1')),
    '下载包里不能自带 API Key');
});

await t('扩展 zip：是一个能解的 zip（8 个文件 + 中央目录齐全）', async () => {
  const { res, buf } = await zipFor('https://demo-panel.workers.dev');
  assert.equal(res.headers.get('Content-Type'), 'application/zip');
  assert.match(res.headers.get('Content-Disposition') || '', /attachment;/);
  assert.equal(buf.subarray(0, 2).toString('latin1'), 'PK', 'zip 开头必须是 PK');
  assert.ok(buf.includes(Buffer.from('PK\x01\x02', 'latin1')), '要有中央目录记录');
  assert.ok(buf.includes(Buffer.from('PK\x05\x06', 'latin1')), '要有 EOCD 结束记录');
  for (const name of FILES) {
    assert.ok(has(buf, name), '包内缺少 ' + name);
    assert.ok(EXT_FILES[name] != null || EXT_FILES['@b64:' + name] != null, '源文件表里缺少 ' + name);
  }
});

await t('扩展 zip：文件名带中文时置 UTF-8 标志位（否则 Windows 解压出来是乱码）', async () => {
  const { buf } = await zipFor('https://demo-panel.workers.dev');
  // 中文文件名「签到面板助手.zip」在 Content-Disposition 里（RFC 5987）
  const { res } = await zipFor('https://demo-panel.workers.dev');
  assert.match(res.headers.get('Content-Disposition') || '', /filename\*=UTF-8''/);
});

await t('扩展 zip：自定义域名请求时注入该域名、包里不许出现 workers.dev', async () => {
  const { buf } = await zipFor('https://checkin.example.com');
  assert.ok(has(buf, 'https://checkin.example.com'), '包里要注入请求时的自定义域名');
  assert.ok(!has(buf, 'workers.dev'), '自定义域名部署的包里不许残留 workers.dev（否则用户会以为只能填 workers.dev）');
  assert.ok(!has(buf, '__PANEL_URL__'), '占位符必须被替换掉');
});

console.log(`\n${n} 组通过`);
