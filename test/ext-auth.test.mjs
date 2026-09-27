// 扩展请求鉴权测试：node test/ext-auth.test.mjs（纯 mock，不依赖网络）
import assert from 'node:assert/strict';
import { signRequest, verifyExternalRequest, safeEqual, canonicalString } from '../src/lib/ext-auth.js';

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log('ok -', name); };

const KEY = 'k'.repeat(24);

// 极简 D1 仿真：settings 读 + api_nonces 的 INSERT OR IGNORE 语义
function fakeDb(settings = {}) {
  const nonces = new Set();
  return {
    settings,
    nonces,
    prepare(sql) {
      const stmt = {
        _args: [],
        bind(...a) { stmt._args = a; return stmt; },
        async first() {
          if (/FROM settings/i.test(sql)) return { value: settings[stmt._args[0]] ?? null };
          return null;
        },
        async run() {
          if (/INSERT OR IGNORE INTO api_nonces/i.test(sql)) {
            const id = stmt._args[0];
            if (nonces.has(id)) return { meta: { changes: 0 } };
            nonces.add(id);
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 0 } };
        },
        async all() { return { results: [] }; },
      };
      return stmt;
    },
    async batch() { return []; },
  };
}

function fakeReq({ method = 'GET', url = 'https://panel.test/api/external/ping', headers = {} } = {}) {
  const h = new Map(Object.entries(headers).map(([k, v]) => [String(k).toLowerCase(), v]));
  return { method, url, headers: { get: (k) => (h.has(String(k).toLowerCase()) ? h.get(String(k).toLowerCase()) : null) } };
}

async function signedReq(db, { method = 'GET', path = '/api/external/ping', body = '' } = {}) {
  const headers = await signRequest(KEY, { method, path, body });
  return fakeReq({ method, url: 'https://panel.test' + path, headers });
}

await t('safeEqual 常量时间比较', async () => {
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('abc', 'abcd'), false);
  assert.equal(safeEqual('', ''), true);
});

await t('canonicalString 规范串格式固定', async () => {
  assert.equal(canonicalString('post', '/x', 1, 'n', 'h'), 'POST\n/x\n1\nn\nh');
});

await t('签名请求通过校验（signed=true）', async () => {
  const db = fakeDb({ external_api_key: KEY });
  const req = await signedReq(db, { path: '/api/external/relay-pending' });
  const r = await verifyExternalRequest(req, {}, db, { getRawBody: async () => '' });
  assert.equal(r.ok, true);
  assert.equal(r.signed, true);
});

await t('签名覆盖请求体：改一个字节即失败', async () => {
  const db = fakeDb({ external_api_key: KEY });
  const headers = await signRequest(KEY, { method: 'POST', path: '/api/external/handoff', body: '{"a":1}' });
  const req = fakeReq({ method: 'POST', url: 'https://panel.test/api/external/handoff', headers });
  const bad = await verifyExternalRequest(req, {}, db, { getRawBody: async () => '{"a":2}' });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /签名校验失败/);
});

await t('nonce 不能重放', async () => {
  const db = fakeDb({ external_api_key: KEY });
  const headers = await signRequest(KEY, { method: 'GET', path: '/api/external/ping', body: '', nonce: 'fixed-nonce-1' });
  const mk = () => fakeReq({ method: 'GET', url: 'https://panel.test/api/external/ping', headers });
  const first = await verifyExternalRequest(mk(), {}, db, { getRawBody: async () => '' });
  assert.equal(first.ok, true);
  const second = await verifyExternalRequest(mk(), {}, db, { getRawBody: async () => '' });
  assert.equal(second.ok, false);
  assert.match(second.error, /nonce 重复/);
});

await t('时间戳超出 ±5 分钟被拒', async () => {
  const db = fakeDb({ external_api_key: KEY });
  const headers = await signRequest(KEY, { method: 'GET', path: '/api/external/ping', body: '', ts: Date.now() - 10 * 60 * 1000 });
  const r = await verifyExternalRequest(fakeReq({ headers }), {}, db, { getRawBody: async () => '' });
  assert.equal(r.ok, false);
  assert.match(r.error, /时间戳/);
});

await t('错误的 API Key 被拒', async () => {
  const db = fakeDb({ external_api_key: KEY });
  const headers = await signRequest('wrong-key', { method: 'GET', path: '/api/external/ping', body: '' });
  const r = await verifyExternalRequest(fakeReq({ headers }), {}, db, { getRawBody: async () => '' });
  assert.equal(r.ok, false);
  assert.match(r.error, /无效的 API Key/);
});

await t('未配置 Key 时给出明确错误（500）', async () => {
  const db = fakeDb({});
  const r = await verifyExternalRequest(fakeReq({ headers: { 'X-Api-Key': KEY } }), {}, db, { getRawBody: async () => '' });
  assert.equal(r.ok, false);
  assert.match(r.error, /尚未配置/);
  assert.equal(r.status, 500);
});

await t('未签名请求：默认放行（兼容旧版扩展）', async () => {
  const db = fakeDb({ external_api_key: KEY });
  const r = await verifyExternalRequest(fakeReq({ headers: { 'X-Api-Key': KEY } }), {}, db, { getRawBody: async () => '' });
  assert.equal(r.ok, true);
  assert.equal(r.signed, false);
});

await t('开启 require_sign 后，未签名请求被拒', async () => {
  const db = fakeDb({ external_api_key: KEY, ext_require_sign: '1' });
  const r = await verifyExternalRequest(fakeReq({ headers: { 'X-Api-Key': KEY } }), {}, db, { getRawBody: async () => '' });
  assert.equal(r.ok, false);
  assert.match(r.error, /签名校验/);
});

await t('开启 require_sign 后，签名请求仍放行', async () => {
  const db = fakeDb({ external_api_key: KEY, ext_require_sign: '1' });
  const req = await signedReq(db, { path: '/api/external/ping' });
  const r = await verifyExternalRequest(req, {}, db, { getRawBody: async () => '' });
  assert.equal(r.ok, true);
  assert.equal(r.signed, true);
});

await t('Cloudflare Secret 优先于 D1 设置', async () => {
  const db = fakeDb({ external_api_key: 'd1-key-should-not-win' });
  const headers = await signRequest('env-secret-key', { method: 'GET', path: '/api/external/ping', body: '' });
  const r = await verifyExternalRequest(fakeReq({ headers }), { EXTERNAL_API_KEY: 'env-secret-key' }, db, { getRawBody: async () => '' });
  assert.equal(r.ok, true);
});

console.log(`\n${n} 组通过`);
