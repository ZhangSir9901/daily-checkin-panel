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

// ---------- 完整往返：我导出 → 别人导入 → 真的能签上（开源共建最基本的那条路）----------
// 这条用例回答的就是用户的那句「确保别人的导出，都能正常导入使用」：
// 一份导出、发到 GitHub、别人粘贴导入，中间任何一环对不上（字段名、占位符、步骤格式……）
// 都会在这里曝光；同时全程不允许出现我自己的 Cookie。
await t('往返：导出的配置 → 别人粘贴导入 → 真的能跑起来（且全程不出现原 Cookie）', async () => {
  const SECRET = 'sess=MY-PRIVATE-COOKIE-abcdef123456';
  const acc = {
    id: 21,
    name: '我的小论坛',
    site: 'http',
    creds: {
      steps: [
        {
          name: '打开签到页',
          method: 'GET',
          url: 'https://bbs.other.example.com/plugin.php?id=sign',
          headers: JSON.stringify({ Cookie: SECRET, 'User-Agent': 'UA-mine' }),
          body: '',
          expect_status: '200',
          expect_contains: '',
        },
        {
          name: '提交签到',
          method: 'POST',
          url: 'https://bbs.other.example.com/plugin.php?id=sign&do=submit',
          headers: JSON.stringify({ Cookie: SECRET, 'X-Csrf-Token': 'tok_ZZZ999' }),
          body: 'formhash={{formhash}}&sign=1',
          expect_status: '200',
          expect_contains: '签到成功',
        },
      ],
    },
  };

  // ① 我这边导出 —— 这就是会发到 Issue / 网盘上的东西
  const r = exportAccountConfig(acc, { id: 'http', name: '自定义 HTTP', execution: 'server' });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  const shared = JSON.stringify(r.config);
  assert.ok(!shared.includes('MY-PRIVATE-COOKIE-abcdef123456'), '导出的 JSON 里绝不允许出现原 Cookie');
  assert.ok(!shared.includes('tok_ZZZ999'), '其它请求头里的凭据也必须清掉');
  assert.ok(shared.includes('{{cookie}}'), '应该换成占位符留给别人填');

  // ② 别人那边导入（就是面板上的「导入一份配置」）：字符串也能直接导
  const db = fakeDb();
  const imp = await importSiteConfig(db, shared);
  assert.equal(imp.ok, true, '别人的导出必须能直接导入');
  assert.equal((await listCommunitySites(db)).length, 1);

  // ③ 导入后的站点要能真的跑：别人填自己的 Cookie，占位符被替换掉
  const site = makeCommunitySite(r.config);
  assert.ok(site.fields.some((f) => f.key === 'cookie'), '导入后要告诉别人填 Cookie');
  const seen = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    seen.push({ url: String(url), headers: init.headers || {}, body: init.body });
    return { status: 200, text: async () => '{"msg":"签到成功"}' };
  };
  let ran;
  try {
    ran = await site.run({ site_url: 'https://bbs.other.example.com', cookie: 'them=own-cookie', formhash: 'fh1' });
  } finally {
    globalThis.fetch = origFetch;
  }
  assert.equal(seen.length, 2, '两步都要跑（多步录制不能丢步）');
  assert.equal(seen[0].url, 'https://bbs.other.example.com/plugin.php?id=sign');
  assert.equal(seen[1].url, 'https://bbs.other.example.com/plugin.php?id=sign&do=submit');
  for (const s of seen) {
    assert.equal(s.headers.Cookie, 'them=own-cookie', '{{cookie}} 必须换成导入者自己的 Cookie');
    assert.ok(!JSON.stringify(s).includes('MY-PRIVATE-COOKIE'), '别人的凭据不许混进来');
  }
  assert.match(String(seen[1].body), /formhash=fh1/, '{{formhash}} 也要被填上');
  assert.equal(ran.ok, true, JSON.stringify(ran));
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

// ---------- fields：会直接进 HTML，所以逐项要严 ----------
//
// 【为什么在这里卡死】面板把 f.key 拼进 `data-k="…"`（还有一堆 querySelector），
// 而这份配置是**从网上拿别人的 JSON 导入**的。key 里写一句
//   `" onfocus="alert(1)" autofocus x="`
// 就是一段在管理员会话里执行的 XSS（面板里能拿到会话能拿到的一切）。
await t('字段 key：只允许字母/数字/下划线 —— 带引号的（XSS 载荷）一律拒绝', () => {
  const withKey = (key) => validateSiteConfig({ ...GOOD, fields: [{ key, label: 'Cookie', required: true }] });
  assert.equal(withKey('cookie').ok, true, '正常 key 要放行');
  assert.equal(withKey('user_agent2').ok, true);
  for (const bad of ['"><script>', 'a" onfocus="alert(1)" autofocus x="', 'a b', 'a-b', 'a.b', '中文', '', '../../x']) {
    const v = withKey(bad);
    assert.equal(v.ok, false, `key=${JSON.stringify(bad)} 应该被拒`);
    assert.ok(v.errors.some((e) => /key 只能用/.test(e)), `要指明是 key 的问题：${JSON.stringify(v.errors)}`);
  }
});

await t('字段：key 重复 / type 不认识 / select 没 options / 太长 —— 全部当场报错', () => {
  const v = validateSiteConfig({
    ...GOOD,
    fields: [
      { key: 'cookie', label: 'Cookie', required: true },
      { key: 'cookie', label: '又一个 Cookie' },          // 重复
      { key: 'mode', label: '模式', type: 'radio' },        // 不认识的 type
      { key: 'pick', label: '选一个', type: 'select' },     // select 没 options
      { key: 'long', label: 'x'.repeat(200) },              // label 太长
    ],
  });
  assert.equal(v.ok, false);
  const all = v.errors.join('\n');
  assert.match(all, /key 与前面的字段重复了/);
  assert.match(all, /type 不认识/);
  assert.match(all, /select 必须给 options/);
  assert.match(all, /label 太长/);
});

await t('字段：正规写法（含 select + textarea + password）照旧能通过', () => {
  const v = validateSiteConfig({
    ...GOOD,
    fields: [
      { key: 'cookie', label: 'Cookie', required: true, type: 'textarea', placeholder: '粘贴 Cookie' },
      { key: 'mode', label: '签到模式', type: 'select', options: ['random', 'fixed'] },
      { key: 'password', label: '密码', type: 'password' },
      { key: 'user_agent', label: 'UA' },
    ],
  });
  assert.equal(v.ok, true, JSON.stringify(v.errors));
});

await t('导出/入库：source 里的非 http(s) 地址（javascript: 这类）必须被剔掉', () => {
  // source 会在面板上渲染成「来源」链接。esc() 只管引号尖括号，管不了协议：
  // <a href="javascript:fetch('/api/ext-key/rotate',{method:'POST'})"> 转义后依旧能点，
  // 点一下就在面板的源（带着管理员会话）里执行脚本。而 source 是别人写在配置里的。
  const bad = sanitizeSiteConfig({ ...GOOD, source: "javascript:fetch('/api/ext-key/rotate',{method:'POST'})" });
  assert.equal(bad.source, undefined, '非 http(s) 的来源地址要直接去掉');
  const ok = sanitizeSiteConfig({ ...GOOD, source: 'https://github.com/x/y/blob/main/c.json' });
  assert.equal(ok.source, 'https://github.com/x/y/blob/main/c.json', '正常来源要留着');
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
