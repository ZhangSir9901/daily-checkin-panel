// 面板出口连通性：node test/net-check.test.mjs
//
// 这块东西最容易出的问题不是「测不出来」，而是**测出来一句错话**：
// 它是从面板（Cloudflare）那一侧去打的，却被看的人当成「我的网络通不通」。
// 所以这里除了测判定逻辑，也把「口径」钉住：任何 HTTP 响应（包括 403）都算「通」，
// 只有超时 / 解析失败这类才是不通 —— 403 说明网络到得了，只是人家不让看这个路径。
import assert from 'node:assert/strict';
import { checkNet, probeTarget, shortNetError, NET_TARGETS } from '../src/lib/net-check.js';

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log('ok -', name); };

const resp = (status, body = null) => ({
  status,
  headers: { get: () => null },
  body: body ? { cancel: async () => {} } : null,
});

await t('要求里点名的几个站点都在：阿里 / 谷歌 / Facebook（外加百度 / GitHub / Telegram）', () => {
  const ids = NET_TARGETS.map((x) => x.id);
  for (const id of ['aliyun', 'google', 'facebook']) assert.ok(ids.includes(id), '缺少 ' + id);
  assert.ok(ids.includes('telegram'), 'Telegram 是推送要用的，值得放着（出问题时一眼能看出）');
  // 全部是公网 https；用 robots.txt 这类稳定的小文件，不参与业务
  for (const it of NET_TARGETS) {
    assert.match(it.url, /^https:\/\//, it.id + ' 必须是 https');
    assert.ok(it.name && it.name.length <= 10, it.id + ' 的名字要短（面板上是一行小字）');
  }
  assert.equal(new Set(ids).size, ids.length, 'id 不能重复');
});

await t('只要有 HTTP 响应就算「通」——403 / 404 也是通，不能报成「不通」', async () => {
  const impl = async () => resp(403);
  const r = await probeTarget(NET_TARGETS[0], { fetchImpl: impl });
  assert.equal(r.ok, true, '403 是「网络到得了、人家不让你看」，不是不通');
  assert.equal(r.status, 403);
  assert.ok(Number.isFinite(r.ms) && r.ms >= 0, '要带上耗时（面板上显示 ms）');
  const impl404 = async () => resp(404);
  assert.equal((await probeTarget(NET_TARGETS[0], { fetchImpl: impl404 })).ok, true);
});

await t('超时 / 解析失败 / 连接被拒 → 不通，并且给出人话原因', async () => {
  const throwWith = (msg) => async () => { throw new Error(msg); };
  const cases = [
    ['The operation was aborted due to timeout', /超时/],
    ['getaddrinfo ENOTFOUND www.google.com', /域名解析失败/],
    ['connect ECONNREFUSED 1.2.3.4:443', /连接被拒绝/],
    ['fetch failed', /连不上/],
    ['unable to verify the first certificate', /证书问题/],
  ];
  for (const [msg, want] of cases) {
    const r = await probeTarget(NET_TARGETS[0], { fetchImpl: throwWith(msg) });
    assert.equal(r.ok, false, msg + ' 应该算不通');
    assert.match(r.error, want, msg + ' 的原因要说人话，实际：' + r.error);
    assert.equal(r.status, 0);
  }
  assert.equal(shortNetError(new Error('随便一个没见过的错')).length > 0, true, '没见过的错也要给个说法');
  assert.equal(shortNetError('') , '未知错误');
});

await t('探测请求：GET + 不跟随重定向（跟重定向只会更慢，我们只关心「通不通」）', async () => {
  const seen = [];
  const impl = async (url, init) => { seen.push({ url, init }); return resp(200); };
  await probeTarget(NET_TARGETS[0], { fetchImpl: impl });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].init.method, 'GET');
  assert.equal(seen[0].init.redirect, 'manual');
  // 不能把面板的任何凭据/密钥带出去
  const h = seen[0].init.headers || {};
  assert.equal(Object.keys(h).length, 1, '只带一个 UA');
  assert.doesNotMatch(JSON.stringify(h), /cookie|authorization|api-?key/i);
  assert.equal('credentials' in seen[0].init, false);
});

await t('checkNet：并发探测全部目标，每个目标都带上 id / name / 结论', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const impl = async (url) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    // 谷歌不通，其余正常：面板上要能只红一个
    if (String(url).includes('google')) throw new Error('The operation was aborted due to timeout');
    return resp(200);
  };
  const r = await checkNet({ fetchImpl: impl });
  assert.equal(r.targets.length, NET_TARGETS.length);
  assert.ok(r.checked_at > 0, '要带检测时间（气泡里会显示「上次检测 12:34:56」）');
  for (const item of r.targets) {
    assert.ok(item.id && item.name, '每项都要有 id 和名字');
    assert.equal(typeof item.ok, 'boolean');
  }
  const google = r.targets.find((x) => x.id === 'google');
  assert.equal(google.ok, false);
  assert.match(google.error, /超时/);
  assert.equal(r.targets.filter((x) => x.ok).length, NET_TARGETS.length - 1);
  assert.equal(maxInFlight > 1, true, '要并发打（串行六个站点会慢到让人以为卡住了）');
  // 一个目标失败不能把整次检测带崩
  const allFail = await checkNet({ fetchImpl: async () => { throw new Error('fetch failed'); } });
  assert.equal(allFail.targets.every((x) => x.ok === false), true);
});

await t('checkNet：能只测指定的目标（测试/将来做「只测某一个」都用得上）', async () => {
  const only = [NET_TARGETS[0]];
  const r = await checkNet({ fetchImpl: async () => resp(200), targets: only });
  assert.equal(r.targets.length, 1);
  assert.equal(r.targets[0].id, NET_TARGETS[0].id);
});

// ---------- 与面板的契约（照旧走源码断言，跟其它 UI 契约一个路子）----------
await t('面板上写清了口径：是「面板出口」，不是「你的本机」', async () => {
  const { readFileSync } = await import('node:fs');
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /id="net-strip"/, '账号页要有这排小圆点');
  assert.match(html, /<span class="net-title">出口<\/span>/, '标题写「出口」（写「网络」会被理解成本机网络）');
  assert.match(html, /测的是面板所在的 Cloudflare，不是你的本机/, '气泡里必须写明口径');
  assert.match(html, /await api\('\/api\/net-check'/, '数据来自 /api/net-check');
  assert.match(html, /\$\('net-strip'\)\.onclick = loadNetStatus;/, '点一下要能重新测');
});

console.log(`\n${n} 组通过`);
