// 社区站点配置测试：node test/community.test.mjs（纯 mock，不联网）
// 这套东西是「开源 + 别人贡献站点适配」的入口，所以判定要严：
//   · 配置里的明文凭据必须被拦下（分享配置不能带上别人的 Cookie）
//   · 导入 / 导出 / 执行 三条链路都要能跑通
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import {
  CONFIG_SCHEMA,
  validateSiteConfig,
  sanitizeSiteConfig,
  importSiteConfig,
  listCommunitySites,
  deleteCommunitySite,
  makeCommunitySite,
  exportAccountConfig,
} from '../src/community.js';

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log('ok -', name); };

const GOOD = {
  schema: CONFIG_SCHEMA,
  id: 'demo_bbs',
  name: '示例论坛',
  desc: '示例论坛每日签到',
  author: 'someone',
  version: '1.0.0',
  execution: 'server',
  fields: [
    { key: 'site_url', label: '站点地址', type: 'text', required: true },
    { key: 'cookie', label: 'Cookie', type: 'textarea', required: true },
    { key: 'user_agent', label: 'User-Agent', type: 'text' },
  ],
  steps: [
    {
      name: '每日签到',
      method: 'POST',
      url: '{{site_url}}/api/sign',
      headers: { Cookie: '{{cookie}}', 'User-Agent': '{{user_agent}}' },
      body: '',
      expect_status: 200,
      expect_contains: 'ok',
    },
  ],
  tips: '登录后用扩展抓 Cookie',
};

// ---------- 极简 D1 fake（只认 community_sites 那几条 SQL） ----------
function fakeDb() {
  const rows = new Map();
  return {
    rows,
    prepare(sql) {
      const stmt = {
        _args: [],
        bind(...args) { stmt._args = args; return stmt; },
        async run() {
          if (/INSERT INTO community_sites/i.test(sql)) {
            const [id, name, author, version, source, def, created_at, updated_at] = stmt._args;
            rows.set(id, { id, name, author, version, source, def, created_at, updated_at });
          }
          if (/DELETE FROM community_sites/i.test(sql)) rows.delete(stmt._args[0]);
          return {};
        },
        async first() {
          if (/SELECT id FROM community_sites WHERE id = \?/i.test(sql)) {
            const r = rows.get(stmt._args[0]);
            return r ? { id: r.id } : null;
          }
          return null;
        },
        async all() {
          if (/FROM community_sites ORDER BY name/i.test(sql)) {
            return { results: [...rows.values()].sort((a, b) => String(a.name).localeCompare(String(b.name))) };
          }
          return { results: [] };
        },
      };
      return stmt;
    },
    async batch() { return []; },
  };
}

await t('社区配置：合法配置通过校验（无错误、无警告）', () => {
  const v = validateSiteConfig(GOOD);
  assert.equal(v.ok, true, JSON.stringify(v.errors));
  assert.deepEqual(v.warnings, []);
});

await t('社区配置：缺 id / steps 会被明确拦下', () => {
  const v = validateSiteConfig({ name: 'X', steps: [] });
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /id/.test(e)), JSON.stringify(v.errors));
  assert.ok(v.errors.some((e) => /steps/.test(e)), JSON.stringify(v.errors));
});

await t('社区配置：非法 JSON 直接报错而不是崩', () => {
  const v = validateSiteConfig('{不是 json');
  assert.equal(v.ok, false);
  assert.match(v.errors[0], /JSON/);
});

await t('社区配置：请求头里带明文 Cookie 的配置必须被拒绝', () => {
  const bad = JSON.parse(JSON.stringify(GOOD));
  bad.steps[0].headers.Cookie = 'abc=1; sess=deadbeefdeadbeef';
  const v = validateSiteConfig(bad);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /明文凭据/.test(e)), JSON.stringify(v.errors));
});

await t('社区配置：导出时把凭据换成占位符（不会把别人的 Cookie 分享出去）', () => {
  const withSecret = JSON.parse(JSON.stringify(GOOD));
  withSecret.steps[0].headers.Cookie = 'sess=deadbeefdeadbeef';
  withSecret.steps[0].headers.Authorization = 'Bearer abcdefghijklmnop';
  const out = sanitizeSiteConfig(withSecret);
  assert.equal(out.steps[0].headers.Cookie, '{{cookie}}');
  assert.equal(out.steps[0].headers.Authorization, '{{authorization}}');
  assert.equal(out.schema, CONFIG_SCHEMA);
  assert.ok(!JSON.stringify(out).includes('deadbeef'));
});

await t('社区配置：导入 → 列出 → 再导入需确认覆盖 → 删除', async () => {
  const db = fakeDb();
  const r = await importSiteConfig(db, GOOD);
  assert.equal(r.ok, true);
  assert.equal(r.id, 'demo_bbs');

  const list = await listCommunitySites(db);
  assert.equal(list.length, 1);
  assert.equal(list[0].name, '示例论坛');
  assert.equal(list[0].author, 'someone');

  const again = await importSiteConfig(db, GOOD).catch((e) => e);
  assert.ok(again instanceof Error);
  assert.equal(again.needOverwrite, true);

  const forced = await importSiteConfig(db, { ...GOOD, version: '1.0.1' }, { overwrite: true });
  assert.equal(forced.ok, true);
  const list2 = await listCommunitySites(db);
  assert.equal(list2[0].version, '1.0.1');

  await deleteCommunitySite(db, 'demo_bbs');
  assert.equal((await listCommunitySites(db)).length, 0);
});

await t('社区配置：makeCommunitySite 真能执行（占位符被账号字段替换）', async () => {
  const site = makeCommunitySite(GOOD);
  assert.equal(site.id, 'demo_bbs');
  assert.equal(site.execution, 'server');
  assert.ok(site.fields.some((f) => f.key === 'cookie'));

  const seen = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    seen.push({ url: String(url), headers: init.headers || {}, method: init.method });
    return { status: 200, text: async () => JSON.stringify({ ok: true, msg: 'ok' }) };
  };
  let r;
  try {
    r = await site.run({ site_url: 'https://bbs.example.com', cookie: 'a=1', user_agent: 'UA1' });
  } finally {
    globalThis.fetch = origFetch;
  }
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, 'https://bbs.example.com/api/sign');
  assert.equal(seen[0].headers.Cookie, 'a=1', '{{cookie}} 必须被账号字段替换');
  assert.equal(seen[0].headers['User-Agent'], 'UA1');
  assert.equal(r.ok, true);
  assert.match(r.detail, /网站返回/);
});

await t('社区配置：站点的失败判定沿用统一信号识别（登录失效能说清楚）', async () => {
  const site = makeCommunitySite(GOOD);
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ status: 200, text: async () => '请先登录后再签到' });
  const err = await (async () => { try { await site.run({ site_url: 'https://x.com', cookie: 'c' }); } catch (e) { return e; } finally { globalThis.fetch = origFetch; } return null; })();
  assert.ok(err instanceof Error, '应抛错');
  assert.match(err.message, /登录/);
});

// ---------- 反向：账号 → 可分享配置 ----------
await t('导出：把录好的多步流程变成可分享配置（凭据变占位符、域名变 {{site_url}}）', () => {
  const acc = {
    id: 7,
    name: '我的论坛',
    site: 'http',
    creds: {
      steps: [
        {
          name: '签到',
          method: 'POST',
          url: 'https://bbs.example.com/api/sign?inajax=1',
          headers: JSON.stringify({ Cookie: 'sess=deadbeefdeadbeefdead', 'User-Agent': 'UA-abc', 'X-Csrf-Token': 'tok_1234567890abcdef' }),
          body: 'a=1',
          expect_status: '200',
          expect_contains: '成功',
        },
      ],
    },
  };
  const r = exportAccountConfig(acc, { id: 'http', name: '自定义 HTTP', domain: '', execution: 'server' });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  const cfg = r.config;
  assert.equal(cfg.schema, CONFIG_SCHEMA);
  assert.equal(cfg.id, 'bbs_example_com', 'id 应从域名推出来');
  assert.equal(cfg.domain, 'bbs.example.com');
  assert.match(cfg.steps[0].url, /^\{\{site_url\}\}\/api\/sign/);
  const h = JSON.parse(cfg.steps[0].headers);
  assert.equal(h.Cookie, '{{cookie}}');
  assert.equal(h['X-Csrf-Token'], '{{x_csrf_token}}', '不合法的占位符名要归一化');
  assert.ok(!JSON.stringify(cfg).includes('deadbeef'), '配置里不允许出现真实凭据');
  const keys = cfg.fields.map((f) => f.key).sort();
  assert.deepEqual(keys, ['cookie', 'site_url', 'x_csrf_token'], '用到的占位符都应变成要填的字段（UA 不是占位符就不出现）');
  assert.equal(validateSiteConfig(cfg).ok, true, '导出的配置必须能再导进去');
});

await t('导出：单次请求的账号也能变成一步配置', () => {
  const r = exportAccountConfig(
    { id: 9, name: 'x', site: 'http', creds: { url: 'https://x.com/sign', method: 'GET', headers: '{"Cookie":"a=1"}', expect_status: '200' } },
    { id: 'http' }
  );
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.config.steps.length, 1);
  assert.equal(r.config.steps[0].url, '{{site_url}}/sign');
  assert.deepEqual(r.config.fields.map((f) => f.key).sort(), ['cookie', 'site_url']);
  assert.equal(r.config.domain, 'x.com');
});

await t('导出：内置站点（代码写死的逻辑）明确拒绝并给出人话解释', () => {
  const r = exportAccountConfig({ id: 1, name: 'x', site: 'nodeseek', creds: { cookie: 'a=1' } }, { id: 'nodeseek', name: 'NodeSeek' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /自定义 HTTP/);
});

// 仓库自带的示例 / 贡献配置必须能通过校验。
// 这是开源共建的第一道关：别人照着改的时候，不应该一上来就踩坑。
await t('社区配置：community/sites/*.json 全部能通过校验（含不带明文凭据）', () => {
  const dir = new URL('../community/sites/', import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  assert.ok(files.length >= 3, '至少要有模板 + 两个示例：' + files.join(','));
  for (const f of files) {
    const cfg = JSON.parse(readFileSync(new URL(f, dir), 'utf8'));
    const v = validateSiteConfig(cfg);
    assert.equal(v.ok, true, `${f}：${JSON.stringify(v.errors)}`);
    assert.ok(cfg.desc, `${f}：配置要写 desc`);
    assert.ok(cfg.author, `${f}：配置要写作者`);
  }
});

await t('社区配置：community/index.json 的 raw 链接都指向真实存在的文件', () => {
  const idx = JSON.parse(readFileSync(new URL('../community/index.json', import.meta.url), 'utf8'));
  assert.equal(idx.schema, 'daily-checkin-community-index/1');
  for (const s of idx.sites) {
    assert.match(s.raw, /\/community\/sites\/[a-z0-9_\-]+\.json$/i, s.raw);
    const name = s.raw.split('/').pop();
    const cfg = JSON.parse(readFileSync(new URL('../community/sites/' + name, import.meta.url), 'utf8'));
    assert.equal(cfg.id, s.id, `${name} 的 id 与索引不一致`);
  }
});

console.log(`\n${n} 组通过`);
