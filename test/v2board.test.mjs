// v2board 模块测试：node test/v2board.test.mjs（纯 mock，不依赖网络）
import assert from 'node:assert/strict';
import { v2board } from '../src/sites/v2board.js';

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log('ok -', name); };

// mock fetch：按 URL 返回预设响应，并记录请求（兼容 JSON 与表单两种请求体）
function mockFetch(routes) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    let body = null;
    const ct = String(init.headers?.['Content-Type'] || '');
    if (init.body) {
      if (ct.includes('x-www-form-urlencoded')) {
        body = Object.fromEntries(new URLSearchParams(String(init.body)));
      } else {
        body = JSON.parse(init.body);
      }
    }
    calls.push({ url: String(url), init, body, contentType: ct });
    globalThis.__calls = calls;
    for (const [match, resp] of routes) {
      if (String(url).includes(match)) {
        const body = typeof resp === 'function' ? resp(calls.length) : resp;
        const headers = new Headers();
        if (body && body.__setCookie) for (const c of body.__setCookie) headers.append('set-cookie', c);
        return { status: 200, headers, json: async () => body, text: async () => JSON.stringify(body) };
      }
    }
    throw new Error('unexpected url: ' + url);
  };
}

const loginOk = { ret: 1, msg: '登录成功', __setCookie: ['session=abc123; Path=/; HttpOnly', 'uid=99; Path=/'] };
const checkinOk = { ret: 1, msg: '签到成功，获得 88 MB 流量' };

await t('登录+签到成功，Cookie 透传', async () => {
  mockFetch([
    ['/auth/login', loginOk],
    ['/user/checkin', checkinOk],
  ]);
  const r = await v2board.run({ domain: 'example.com', email: 'a@b.c', password: 'pw' });
  assert.equal(r.ok, true);
  assert.match(r.message, /签到成功/);
  // 登录请求：表单提交，同时带 password 与 passwd
  const loginCall = globalThis.__calls[0];
  assert.ok(loginCall.url.startsWith('https://example.com/auth/login'));
  assert.match(loginCall.contentType, /x-www-form-urlencoded/);
  assert.equal(loginCall.body.email, 'a@b.c');
  assert.equal(loginCall.body.password, 'pw');
  assert.equal(loginCall.body.passwd, 'pw');
  // 签到请求带上登录 Cookie
  const chkCall = globalThis.__calls[1];
  assert.ok(chkCall.url.startsWith('https://example.com/user/checkin'));
  assert.match(chkCall.init.headers.Cookie, /session=abc123/);
  assert.match(chkCall.init.headers.Cookie, /uid=99/);
});

await t('域名自动补 https:// 并去尾斜杠', async () => {
  mockFetch([
    ['/auth/login', loginOk],
    ['/user/checkin', checkinOk],
  ]);
  await v2board.run({ domain: '  example.com/ ', email: 'a@b.c', password: 'pw' });
  assert.ok(globalThis.__calls[0].url.startsWith('https://example.com/auth/login'));
});

await t('域名带路径前缀时保留路径', async () => {
  mockFetch([
    ['/uuid/auth/login', loginOk],
    ['/uuid/user/checkin', checkinOk],
  ]);
  const r = await v2board.run({ domain: 'china_69yun.337979.xyz/uuid', email: 'a@b.c', password: 'pw' });
  assert.equal(r.ok, true);
  assert.ok(globalThis.__calls[0].url.startsWith('https://china_69yun.337979.xyz/uuid/auth/login'));
  assert.ok(globalThis.__calls[1].url.startsWith('https://china_69yun.337979.xyz/uuid/user/checkin'));
});

await t('魔改站登录：表单字段含 passwd/remember_me/code', async () => {
  mockFetch([
    ['/uuid/auth/login', loginOk],
    ['/uuid/user/checkin', checkinOk],
  ]);
  await v2board.run({ domain: 'china_69yun.337979.xyz/uuid', email: 'a@b.c', password: 'pw' });
  const loginCall = globalThis.__calls[0];
  assert.match(loginCall.contentType, /x-www-form-urlencoded/);
  assert.equal(loginCall.body.email, 'a@b.c');
  assert.equal(loginCall.body.passwd, 'pw');
  assert.equal(loginCall.body.password, 'pw');
  assert.equal(loginCall.body.remember_me, '1');
  assert.ok('code' in loginCall.body);
});

await t('登录失败抛错', async () => {
  mockFetch([['/auth/login', { ret: 0, msg: '密码错误' }]]);
  await assert.rejects(
    v2board.run({ domain: 'example.com', email: 'a@b.c', password: 'bad' }),
    /登录失败.*密码错误/
  );
});

await t('已签到判为成功', async () => {
  mockFetch([
    ['/auth/login', loginOk],
    ['/user/checkin', { ret: 0, msg: '您今天已经签到过了' }],
  ]);
  const r = await v2board.run({ domain: 'example.com', email: 'a@b.c', password: 'pw' });
  assert.equal(r.ok, true);
  // 主文案必须是**网站原话**（面板「网站反馈」展示的就是这句），不再归纳成我们的套话
  assert.equal(r.message, '您今天已经签到过了');
});

await t('签到成功：用网站原话当反馈，且不把促销公告一起刷出来', async () => {
  mockFetch([
    ['/auth/login', loginOk],
    ['/user/checkin', { ret: 1, msg: '尊贵的王者Lv7，您获得了 1.535GB 流量.\n\n🎉【69云】中秋国庆季 全场 7.8 折!🎉\n📅【活动时间】9月25日' }],
  ]);
  const r = await v2board.run({ domain: 'example.com', email: 'a@b.c', password: 'pw' });
  assert.equal(r.ok, true);
  assert.equal(r.message, '尊贵的王者Lv7，您获得了 1.535GB 流量.');
  assert.ok(!r.message.includes('7.8 折'), '促销公告不应出现在网站反馈里');
});

await t('缺字段报错', async () => {
  await assert.rejects(v2board.run({ domain: '', email: 'a@b.c', password: 'pw' }), /域名/);
  await assert.rejects(v2board.run({ domain: 'example.com', email: '', password: 'pw' }), /邮箱和密码/);
});

console.log(`\n${n} passed`);
