// 推送通知：node test/notify.test.mjs
//
// 【为什么要有这个】「填进去就能用」的前提是**失败要能看见**：
// 以前 Telegram 的失败被 .catch(() => {}) 全部吞掉，用户只看到「签到日报没来」，
// 不知道是 Token 错、Chat ID 错、还是被 Bot 拉黑了。这里把三件事钉住：
//   ① 表单校验能挡住明显填错的（省一次「为什么没收到」）
//   ② Telegram 的英文错误会被翻成「下一步该做什么」
//   ③ 密钥落库是加密的，接口只回「是否已设置」
import assert from 'node:assert/strict';
import {
  validTelegramToken, validTelegramChatId, describeTelegramError,
  sendTelegram, telegramChats, sendBark, getNotifyConfig, setNotifyConfig,
  readNotifyRaw, sendNotifyDetailed,
} from '../src/notify.js';

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log('ok -', name); };

// ---------- 极简 D1 仿真（只要 settings 读写） ----------
function makeDb(rows = {}) {
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
          if (/^SELECT value FROM settings WHERE key = \?/i.test(sql)) {
            const v = kv.get(stmt._args[0]);
            return v === undefined ? null : { value: v };
          }
          return null;
        },
        async run() {
          if (/INSERT INTO settings/i.test(sql)) {
            kv.set(stmt._args[0], stmt._args[1]);
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 0 } };
        },
      };
      return stmt;
    },
  };
}

// 固定一把 32 字节的加密密钥：不固定的话每次都要现生成，测不出「密钥加密落库」
const ENV = { ENCRYPT_KEY: Buffer.alloc(32, 5).toString('base64') };

// 网络一律 mock：测试里不能真的去连 Telegram
let calls = [];
function mockFetch(handler) {
  calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init: init || {} });
    return handler(String(url), init || {});
  };
  return () => { globalThis.fetch = real; };
}
const respJson = (obj, { ok = true, status = 200 } = {}) => ({ ok, status, json: async () => obj });
// 一份格式合法的假 Token（数字:后半段 >=20 个字符）
const TOKEN = '123456789:' + 'AAE'.repeat(10);

await t('Bot Token 校验：能认出常见的填错方式', async () => {
  assert.equal(validTelegramToken('123456789:AAEabcdefghijklmnopqrstuvwxyz12345'), true);
  assert.equal(validTelegramToken(''), false);
  assert.equal(validTelegramToken('123456789'), false, '只有数字（把 Chat ID 填进来了）');
  assert.equal(validTelegramToken('abc:def'), false);
  assert.equal(validTelegramToken('12345:short'), false, '后半段太短');
});

await t('Chat ID 校验：数字 / 负数（群） / @频道名都接受', async () => {
  assert.equal(validTelegramChatId('123456789'), true);
  assert.equal(validTelegramChatId('-1001234567890'), true);
  assert.equal(validTelegramChatId('@my_channel'), true);
  assert.equal(validTelegramChatId(''), false);
  assert.equal(validTelegramChatId('我的群'), false);
  assert.equal(validTelegramChatId('@ab'), false, '频道名太短');
});

await t('Telegram 英文错误 → 能照着做的中文提示', async () => {
  assert.match(describeTelegramError('Bad Request: chat not found'), /自动获取|发一条消息/);
  assert.match(describeTelegramError('Unauthorized'), /Bot Token/);
  assert.match(describeTelegramError('Forbidden: bot was blocked by the user'), /拉黑/);
  assert.match(describeTelegramError('Bad Request: not enough rights to send text messages'), /管理员|权限/);
  assert.match(describeTelegramError('Too Many Requests: retry after 30'), /限流|太频繁/);
  assert.match(describeTelegramError(''), /没有返回具体原因/);
  assert.match(describeTelegramError('something brand new'), /something brand new/, '没见过的错误原样带上，别吞掉');
});

await t('sendTelegram：成功时把 chat_id / 正文 / 禁止预览都带上', async () => {
  const restore = mockFetch(() => respJson({ ok: true, result: {} }));
  try {
    const r = await sendTelegram(TOKEN, '777', '标题', '正文');
    assert.equal(r.ok, true);
    assert.equal(calls[0].url, 'https://api.telegram.org/bot' + TOKEN + '/sendMessage');
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.chat_id, '777');
    assert.equal(body.text, '标题\n\n正文');
    assert.equal(body.disable_web_page_preview, true);
  } finally { restore(); }
});

await t('sendTelegram：ok:false 时把 Telegram 的原话翻成人话（不再静默失败）', async () => {
  const restore = mockFetch(() => respJson({ ok: false, description: 'Bad Request: chat not found' }));
  try {
    const r = await sendTelegram('123456789:AAAAAAAAAAAAAAAAAAAAA', '777', 't', 'b');
    assert.equal(r.ok, false);
    assert.match(r.error, /找不到/);
  } finally { restore(); }
});

await t('sendTelegram：401 时指出是 Token 的问题', async () => {
  const restore = mockFetch(() => respJson({ ok: false, description: 'Unauthorized' }, { ok: false, status: 401 }));
  try {
    const r = await sendTelegram('123456789:AAAAAAAAAAAAAAAAAAAAA', '777', 't', 'b');
    assert.equal(r.ok, false);
    assert.match(r.error, /Token/);
  } finally { restore(); }
});

await t('sendTelegram：连不上时说清楚是网络问题，不是「配置错了」', async () => {
  const restore = mockFetch(() => { throw new Error('network down'); });
  try {
    const r = await sendTelegram('123456789:AAAAAAAAAAAAAAAAAAAAA', '777', 't', 'b');
    assert.equal(r.ok, false);
    assert.match(r.error, /连不上 Telegram/);
  } finally { restore(); }
});

await t('sendTelegram：缺 Token / Chat ID 时本地就拦下，不发请求', async () => {
  const restore = mockFetch(() => respJson({ ok: true }));
  try {
    assert.equal((await sendTelegram('', '777', 't', 'b')).ok, false);
    assert.equal((await sendTelegram('123456789:AAAAAAAAAAAAAAAAAAAAA', '', 't', 'b')).ok, false);
    assert.equal(calls.length, 0, '不该发出任何请求');
  } finally { restore(); }
});

await t('telegramChats：读 getUpdates，去重并带上标题', async () => {
  const restore = mockFetch(() => respJson({
    ok: true,
    result: [
      { message: { chat: { id: 111, type: 'private', first_name: '老锅' } } },
      { message: { chat: { id: 111, type: 'private', first_name: '老锅' } } }, // 重复
      { message: { chat: { id: -100999, type: 'supergroup', title: '签到通知群' } } },
    ],
  }));
  try {
    const r = await telegramChats('123456789:AAAAAAAAAAAAAAAAAAAAA');
    assert.equal(r.ok, true);
    assert.equal(r.chats.length, 2, '同一个会话只出现一次');
    assert.deepEqual(r.chats.map((c) => c.id), [111, -100999]);
    assert.equal(r.chats[1].title, '签到通知群');
  } finally { restore(); }
});

await t('telegramChats：一个消息都没有时告诉用户「先给 Bot 发一句 hi」', async () => {
  const restore = mockFetch(() => respJson({ ok: true, result: [] }));
  try {
    const r = await telegramChats('123456789:AAAAAAAAAAAAAAAAAAAAA');
    assert.equal(r.ok, true);
    assert.equal(r.chats.length, 0);
    assert.match(r.error, /发一句|发一条/);
  } finally { restore(); }
});

await t('telegramChats：Token 不对时直接指出，不当成「没消息」', async () => {
  const restore = mockFetch(() => respJson({ ok: false, description: 'Unauthorized' }, { ok: false, status: 401 }));
  try {
    const r = await telegramChats('123456789:AAAAAAAAAAAAAAAAAAAAA');
    assert.equal(r.ok, false);
    assert.match(r.error, /Token/);
  } finally { restore(); }
});

await t('Bark：非 http 服务器地址会被拦下（不会把 Key 发到奇怪的地址）', async () => {
  const restore = mockFetch(() => respJson({ code: 200 }));
  try {
    const r = await sendBark('ftp://x', 'key', 't', 'b');
    assert.equal(r.ok, false);
    assert.equal(calls.length, 0);
  } finally { restore(); }
});

await t('保存配置：密钥加密落库，接口只回「是否已设置」', async () => {
  const db = makeDb();
  await setNotifyConfig(ENV, db, {
    enabled: true,
    telegram_bot_token: '123456789:AAAAAAAAAAAAAAAAAAAAA',
    telegram_chat_id: '777',
    webhook_url: 'https://example.com/hook',
  });
  const rawToken = db.kv.get('notify.telegram_bot_token');
  assert.match(rawToken, /^gcm1\./, 'Token 必须加密后落库，不能明文躺在 D1 里');
  assert.doesNotMatch(rawToken, /AAAAAAAA/, '密文里不该出现原文');

  const cfg = await getNotifyConfig(ENV, db);
  assert.equal(cfg.telegram_bot_token, '', '接口不回明文');
  assert.equal(cfg.telegram_bot_token_set, true);
  assert.equal(cfg.telegram_chat_id, '777', 'Chat ID 不是密钥，可以直接回显');
  assert.deepEqual(cfg.channels, ['Telegram', 'Webhook']);
  assert.equal(cfg.telegram_ready, true);

  const raw = await readNotifyRaw(ENV, db);
  assert.equal(raw.telegram_bot_token, '123456789:AAAAAAAAAAAAAAAAAAAAA', '内部要能解回明文（发消息要用）');
});

await t('老数据兼容：D1 里已有的明文密钥照样能读', async () => {
  const db = makeDb({ 'notify.telegram_bot_token': '123456789:PLAINTEXTTOKENAAAAAAAAA' });
  const raw = await readNotifyRaw(ENV, db);
  assert.equal(raw.telegram_bot_token, '123456789:PLAINTEXTTOKENAAAAAAAAA');
});

await t('清除密钥：clear 列表里的字段会被删掉，其它字段不动', async () => {
  const db = makeDb();
  await setNotifyConfig(ENV, db, { telegram_bot_token: '123456789:AAAAAAAAAAAAAAAAAAAAA', telegram_chat_id: '777' });
  await setNotifyConfig(ENV, db, { clear: ['telegram_bot_token'] });
  const cfg = await getNotifyConfig(ENV, db);
  assert.equal(cfg.telegram_bot_token_set, false);
  assert.equal(cfg.telegram_chat_id, '777', 'Chat ID 不该被一起清掉');
});

await t('sendNotifyDetailed：没开推送就什么都不发', async () => {
  const db = makeDb();
  await setNotifyConfig(ENV, db, { telegram_bot_token: '123456789:AAAAAAAAAAAAAAAAAAAAA', telegram_chat_id: '777' });
  const restore = mockFetch(() => respJson({ ok: true }));
  try {
    const r = await sendNotifyDetailed(ENV, db, '标题', '正文');
    assert.equal(r.sent, 0);
    assert.equal(r.skipped, 'disabled');
    assert.equal(calls.length, 0);
  } finally { restore(); }
});

await t('sendNotifyDetailed：开了推送就发给已配置的渠道，并逐条报告结果', async () => {
  const db = makeDb();
  await setNotifyConfig(ENV, db, {
    enabled: true,
    telegram_bot_token: '123456789:AAAAAAAAAAAAAAAAAAAAA',
    telegram_chat_id: '777',
    webhook_url: 'https://hook.example/x',
  });
  const restore = mockFetch((url) => (
    url.includes('api.telegram.org') ? respJson({ ok: true }) : respJson({}, { ok: false, status: 500 })
  ));
  try {
    const r = await sendNotifyDetailed(ENV, db, '签到日报', '全部成功');
    assert.equal(r.results.length, 2);
    assert.equal(r.sent, 1, 'Telegram 成功、Webhook 失败');
    const tg = r.results.find((x) => x.channel === 'Telegram');
    const wh = r.results.find((x) => x.channel === 'Webhook');
    assert.equal(tg.ok, true);
    assert.equal(wh.ok, false);
    assert.match(wh.error, /HTTP 500/);
  } finally { restore(); }
});

console.log(`\n${n} 组通过`);
