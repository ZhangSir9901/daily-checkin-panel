// 凭据加密（enc_key）：node test/crypto.test.mjs
//
// 【为什么必须有这个测试】新建库的**第一次**使用会现场生成一把 AES 密钥存进 settings。
// 老写法是「查不到就用 INSERT 写一把」：只要两个请求同时走到这一步（面板轮询、定时任务、
// 你正点「保存账号」三者撞在一起，冷启动时很常见），后到的那个必然撞主键冲突 → 整个请求 500。
// 更糟的是两把不同的 key 谁先落库说不准。
// 现在改成 INSERT OR IGNORE + 回头再读：并发的双方最终拿到**同一把** key。
import assert from 'node:assert/strict';
import { encryptJSON, decryptJSON, hashPassword, verifyPassword, randomHex } from '../src/crypto.js';

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log('ok -', name); };

// ---- 极简 D1 仿真：真实现「主键唯一」这个约束，才能复现冲突 ----
function makeDb({ rows = {} } = {}) {
  const kv = new Map(Object.entries(rows));
  const norm = (sql) => String(sql).replace(/\s+/g, ' ').trim();
  return {
    kv,
    prepare(sqlRaw) {
      const sql = norm(sqlRaw);
      const stmt = {
        _args: [],
        bind(...a) { stmt._args = a; return stmt; },
        async first() {
          if (/^SELECT value FROM settings WHERE key/i.test(sql)) {
            // 注意：crypto.js 里这条查询是把 key 写在 SQL 里的（key='enc_key'），不是 bind 的。
            // 仿真必须两种写法都认，否则永远查不到 → 测试会变成「每次都重新生成密钥」的假场景。
            const m = sql.match(/key\s*=\s*'([^']+)'/i);
            const k = m ? m[1] : stmt._args[0];
            const v = kv.get(k);
            return v === undefined ? null : { value: v };
          }
          return null;
        },
        async run() {
          // settings 的写入同样把 key 写在 SQL 里：INSERT … VALUES('enc_key', ?)，参数只有 value
          const m = sql.match(/settings\s*\(\s*key\s*,\s*value\s*\)\s*VALUES\s*\(\s*'([^']+)'/i);
          if (!m) return { meta: { changes: 0 } };
          const k = m[1];
          const v = stmt._args[0];
          if (/^INSERT OR IGNORE INTO settings/i.test(sql)) {
            if (kv.has(k)) return { meta: { changes: 0 } }; // 主键已存在 → 忽略，不报错
            kv.set(k, v);
            return { meta: { changes: 1 } };
          }
          if (/^INSERT INTO settings/i.test(sql)) {
            // 真 D1 会在主键冲突时抛错 —— 仿真里也要抛，否则测试就失去意义了
            if (kv.has(k)) throw new Error('UNIQUE constraint failed: settings.key');
            kv.set(k, v);
            return { meta: { changes: 1 } };
          }
          kv.set(k, v);
          return { meta: { changes: 1 } };
        },
      };
      return stmt;
    },
  };
}

await t('并发第一次加密：两个请求同时生成密钥，不会 500，且用的是同一把 key（密文可互解）', async () => {
  const db = makeDb();
  // 两个请求同时进来，各自都没查到 enc_key
  const [a, b] = await Promise.all([
    encryptJSON({}, db, { cookie: 'aaa=1' }),
    encryptJSON({}, db, { cookie: 'bbb=2' }),
  ]);
  // 两边都能被解回来 —— 说明它们用的是同一把 key（否则必然 OperationError）
  assert.deepEqual(await decryptJSON({}, db, a), { cookie: 'aaa=1' });
  assert.deepEqual(await decryptJSON({}, db, b), { cookie: 'bbb=2' });
  assert.equal(db.kv.size, 1, 'settings 里只应该有一把 enc_key');
});

await t('加密往返：Cookie / localStorage 里的非 ASCII 与换行都要原样回来', async () => {
  const db = makeDb();
  const creds = { cookie: 'uid=1; nick=老锅', localStorage: { t: '中文\n换行 "引号"' }, site_url: 'https://hutue.cn/' };
  const enc = await encryptJSON({}, db, creds);
  assert.match(enc, /^gcm1\./);
  assert.deepEqual(await decryptJSON({}, db, enc), creds);
});

await t('坏数据不静默：格式不对的凭据要抛错，而不是返回半个对象', async () => {
  const db = makeDb();
  await assert.rejects(() => decryptJSON({}, db, 'not-a-ciphertext'), /格式异常/);
});

await t('ENCRYPT_KEY 必须是 32 字节 base64：写错要给出能看懂的话', async () => {
  const db = makeDb();
  const err = await encryptJSON({ ENCRYPT_KEY: 'short' }, db, { x: 1 }).catch((e) => e);
  assert.ok(err instanceof Error);
  assert.match(err.message, /32 字节/);
});

await t('管理员密码：正确/错误/损坏的哈希都不出错', async () => {
  const stored = await hashPassword('Gxp78537904@');
  assert.equal(await verifyPassword('Gxp78537904@', stored), true);
  assert.equal(await verifyPassword('wrong', stored), false);
  assert.equal(await verifyPassword('x', 'garbage'), false);
  assert.equal(await verifyPassword('x', ''), false);
  assert.equal(randomHex(16).length, 32);
});

console.log(`\n${n} 组通过`);
