#!/usr/bin/env node
// 一键部署（给完全没碰过 Cloudflare 的人用）
//
// 用法：在这个文件夹里打开命令行，输入
//
//     node deploy.mjs
//
// 它会按顺序做完这七件事，每一步都会在屏幕上说清楚现在在干什么：
//   1. 检查 Node.js 版本（要 18 以上）
//   2. 检查有没有登录 Cloudflare；没有就打开浏览器让你点「同意」
//   3. 建一个免费的 D1 数据库，并把它的 id 自动写进 wrangler.toml
//   4. 生成一把加密密钥并设置成 Worker Secret（账号密码/Cookie 就是用它加密的）
//   5. 部署前把关（database_id 必须真的是 id，不能还是占位符）
//   6. 部署，并把你的面板网址打印出来
//   7. 部署完当场验收：首页能不能打开、数据库通不通（不合格会把排错命令列出来）
//
// 中途任何一步失败都会停下来并告诉你怎么处理，不会带着半成品往下跑。
//
// 想先看看「配置齐了没、能不能部署」而不要真的发布，加一个 --check：
//
//     node deploy.mjs --check
//
// 它只读不写：检查 Node 版本、wrangler 登录状态、wrangler.toml 里的 database_id、
// ENCRYPT_KEY 有没有设置，然后告诉你还差点什么（GitHub Actions 里的部署检查用的就是它）。

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const TOML = join(ROOT, 'wrangler.toml');
const DB_NAME = 'daily-checkin-panel'; // 要和 wrangler.toml 里的 database_name 一致
const SECRET_NAME = 'ENCRYPT_KEY';
const CHECK_ONLY = process.argv.includes('--check'); // 只体检、不发布

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
};

let stepNo = 0;
function step(title) {
  stepNo++;
  console.log('\n' + c.bold(`【第 ${stepNo} 步】${title}`));
}
function ok(msg) { console.log(c.green('  ✅ ') + msg); }
function info(msg) { console.log(c.dim('     ' + msg)); }
function warn(msg) { console.log(c.yellow('  ⚠️  ') + msg); }
function die(msg, hint) {
  console.log('\n' + c.red('❌ ' + msg));
  if (hint) console.log('\n' + hint);
  console.log('');
  process.exit(1);
}

// 调 wrangler。capture=true 时把输出收起来自己解析，否则直接把输出给用户看。
function wrangler(args, { capture = false, input } = {}) {
  const full = ['wrangler@latest', ...args];
  const r = spawnSync('npx', full, {
    cwd: ROOT,
    shell: true, // Windows 上是 npx.cmd，必须走 shell 才找得到
    encoding: 'utf8',
    stdio: capture ? ['pipe', 'pipe', 'pipe'] : ['pipe', 'inherit', 'inherit'],
    input,
    maxBuffer: 32 * 1024 * 1024,
  });
  // status === null 表示「命令压根没跑起来」（这台机器上没有 npx）。
  // 以前这种情况会把后面每一步都误导到别的报错上去，这里直接说清楚。
  if (r.status === null) {
    die('没法运行 npx（多半是这台机器上没装 Node.js，或没装好）',
      '先在命令行里试试这两条，都能打印版本号才算正常：\n\n    node -v\n    npx -v\n\n'
      + '报「不是内部或外部命令 / command not found」的话，去 https://nodejs.org/ 下载 LTS 版装上，'
      + '再重新打开命令行，然后跑：node deploy.mjs');
  }
  return r;
}

// 部署前把关：wrangler.toml 里必须是真 id，不能还是占位符。
// 否则部署本身会成功，但面板一打开就报错 —— 那种「部署成功却不能用」最难查。
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------- 第 1 步：Node 版本 ----------
step('检查运行环境');
{
  const major = Number(process.versions.node.split('.')[0]);
  if (Number.isNaN(major) || major < 18) {
    die(`Node.js 版本太低（现在是 ${process.versions.node}，需要 18 或更高）`,
      '去 https://nodejs.org/ 下载 LTS 版，装完重新打开命令行，再跑一次 node deploy.mjs');
  }
  ok(`Node.js ${process.versions.node}`);
  const toml = readFileSync(TOML, 'utf8');
  if (!/database_name\s*=\s*"([^"]+)"/.test(toml)) {
    die('wrangler.toml 里找不到 database_name，这个文件可能被改坏了',
      '重新下载一份本项目，或把 wrangler.toml 里的 database_name 改回 "' + DB_NAME + '"');
  }
}

// ---------- 第 2 步：登录 Cloudflare ----------
step('登录 Cloudflare（免费账号就行，不用绑卡）');
let cloudflareLoggedIn = false;
{
  const who = wrangler(['whoami'], { capture: true });
  const out = `${who.stdout || ''}${who.stderr || ''}`;
  const loggedIn = who.status === 0 && !/not authenticated|You are not authenticated|not logged in/i.test(out);
  cloudflareLoggedIn = loggedIn;
  if (loggedIn) {
    const who2 = (out.match(/[^\s@]+@[^\s@]+\.[^\s@]+/) || [])[0];
    ok('已经登录过了' + (who2 ? '（' + who2 + '）' : ''));
  } else if (CHECK_ONLY) {
    // --check 是「只读体检」：绝不能去拉一个登录授权流程（会弹浏览器、也会在 CI 里挂住）。
    warn('还没登录 Cloudflare —— 正式部署时这一步会自动打开浏览器让你点「允许」');
  } else {
    info('还没登录，下面会打开浏览器，请点「允许 / Allow」。');
    info('如果浏览器没自动打开，屏幕上会有一个链接，复制到浏览器里打开。');
    const login = wrangler(['login']);
    if (login.status !== 0) {
      die('登录没有完成',
        '手动跑一下这条命令看提示：\n\n    npx wrangler@latest login\n\n登录成功后再跑 node deploy.mjs');
    }
    ok('登录成功');
  }
}

// ---------- 第 3 步：D1 数据库 ----------
if (CHECK_ONLY) {
  step('准备数据库（--check 模式：只看现状，不创建、不修改）');
  if (!cloudflareLoggedIn) {
    warn('没登录 Cloudflare，没法列出数据库（正式部署时它会自动建库并填好 id）');
  } else {
    const list = wrangler(['d1', 'list'], { capture: true });
    const text = `${list.stdout || ''}${list.stderr || ''}`;
    if (text.includes(DB_NAME)) ok(`已经有一个叫 ${DB_NAME} 的数据库`);
    else warn(`没找到叫 ${DB_NAME} 的数据库 —— 正式部署时这一步会自动帮你建`);
  }
} else {
step('准备数据库（D1，免费额度足够签到面板用）');
let databaseId = '';
{
  info(`正在尝试创建数据库 ${DB_NAME} …`);
  const create = wrangler(['d1', 'create', DB_NAME], { capture: true });
  const out = `${create.stdout || ''}\n${create.stderr || ''}`;
  const m = out.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  if (create.status === 0 && m) {
    databaseId = m[0];
    ok('数据库已创建');
  } else {
    // 多半是「这个名字的库早就建过了」——那就去列表里找它的 id
    info('创建没有成功（可能是你以前建过同名数据库），改去已有的列表里找 …');
    const list = wrangler(['d1', 'list', '--json'], { capture: true });
    const text = `${list.stdout || ''}${list.stderr || ''}`;
    let arr = null;
    try { arr = JSON.parse(text.slice(text.indexOf('['))); } catch { arr = null; }
    if (Array.isArray(arr)) {
      const hit = arr.find((x) => x && (x.name === DB_NAME));
      if (hit) databaseId = hit.uuid || hit.database_id || hit.id || '';
    }
    if (!databaseId) {
      die('没能拿到数据库 id',
        '先看看 wrangler 到底报了什么错：\n\n    npx wrangler@latest d1 create ' + DB_NAME + '\n\n'
        + '如果提示 already exists，执行下面这条列出所有数据库：\n\n    npx wrangler@latest d1 list\n\n'
        + '然后手动把那一串 database_id 填进 wrangler.toml，再跑 node deploy.mjs');
    }
    ok('找到已存在的数据库');
  }
  info('database_id = ' + databaseId);

  const toml = readFileSync(TOML, 'utf8');
  const next = toml.replace(/^(\s*database_id\s*=\s*)".*?"/m, `$1"${databaseId}"`);
  if (next === toml) {
    die('没能把 database_id 写进 wrangler.toml',
      '用记事本打开 wrangler.toml，把 database_id 那一行改成：\n\n    database_id = "' + databaseId + '"');
  }
  writeFileSync(TOML, next);
  ok('已把 database_id 写进 wrangler.toml');
}
} // ← 非 --check 模式结束

// ---------- 第 4 步：加密密钥 ----------
step(CHECK_ONLY
  ? '加密密钥（--check 模式：只看有没有设置）'
  : '设置加密密钥（账号的 Cookie / 密码就是用它加密后存进数据库的）');
{
  const list = cloudflareLoggedIn ? wrangler(['secret', 'list'], { capture: true }) : { stdout: '', stderr: '' };
  const text = `${list.stdout || ''}${list.stderr || ''}`;
  const hasSecret = new RegExp(SECRET_NAME).test(text) && !/not found|没有|Error/i.test(text);
  if (CHECK_ONLY) {
    if (!cloudflareLoggedIn) warn('没登录 Cloudflare，没法核对该密钥是否已设置');
    else if (hasSecret) ok(`已经设置过 ${SECRET_NAME}`);
    else warn(`还没有设置 ${SECRET_NAME} —— 正式部署时这一步会自动帮你生成并设置`);
  } else if (hasSecret) {
    ok('已经设置过，保持不变（改了会导致旧数据解不开）');
  } else {
    const key = randomBytes(32).toString('base64');
    info('正在设置 ' + SECRET_NAME + ' …');
    const put = wrangler(['secret', 'put', SECRET_NAME], { input: key + '\n' });
    if (put.status !== 0) {
      warn('自动设置没成功。不影响使用（面板会自动生成一把），但建议手动补上：');
      info('    npx wrangler@latest secret put ' + SECRET_NAME);
      info('    （提示 Enter a secret value 时，粘这一串进去：' + key + '）');
    } else {
      ok('加密密钥已设置');
    }
  }
}

// ---------- 第 5 步：部署前把关 ----------
// 「部署成功但面板打不开 / 一打开就报错」几乎都是这一关能提前拦住的。
step('部署前最后检查一遍配置');
{
  const toml = readFileSync(TOML, 'utf8');
  const m = toml.match(/^\s*database_id\s*=\s*"([^"]*)"/m);
  if (!m || !UUID_RE.test(m[1])) {
    // --check 模式下这**不算错**：新用户第一次跑时 id 还是占位符，正式部署会自动建库并填好。
    if (CHECK_ONLY) {
      warn('database_id 还没填（现在是：' + (m ? m[1] : '（整行都没找到）') + '）—— 正式部署会自动建库并写进去');
    } else {
      die('wrangler.toml 里的 database_id 不是一个真正的 D1 数据库 id（现在是：' + (m ? m[1] : '（整行都没找到）') + '）',
        '这种情况直接部署也能成功，但面板一打开就什么都读不出来。\n'
        + '先列出你自己的数据库，把里面的 uuid 复制到 wrangler.toml 的 database_id：\n\n    npx wrangler@latest d1 list\n\n'
        + '改好后重新跑：node deploy.mjs');
    }
  } else {
    ok('database_id 已填好：' + m[1]);
  }
  if (!/^\s*name\s*=\s*"[^"]+"/m.test(toml)) {
    die('wrangler.toml 里没有 name（Worker 的名字）',
      '重新下载一份本项目，或把这一行加回去：\n\n    name = "daily-checkin-panel"');
  }
  ok('Worker 名字没问题');
}

// --check 模式到这里就够了：上面每一项都是「读了就知道」的，不需要真的发布。
if (CHECK_ONLY) {
  console.log('\n' + c.green(c.bold('✅ 部署前检查完毕')));
  console.log(c.dim('   上面标 ⚠️ 的项在正式部署时会被自动处理；标 ❌ 的项要先按提示改好。'));
  console.log('\n   真正发布：node deploy.mjs（不加 --check）\n');
  process.exit(0);
}

// ---------- 第 6 步：部署 ----------
step('部署到 Cloudflare');
let panelUrl = '';
{
  const dep = wrangler(['deploy'], { capture: true });
  const out = `${dep.stdout || ''}${dep.stderr || ''}`;
  const url = (out.match(/https:\/\/[a-z0-9.-]+\.workers\.dev/gi) || []).pop();
  if (dep.status !== 0 || !url) {
    console.log(out.split('\n').slice(-25).join('\n'));
    die('部署没有成功',
      '把上面那段报错复制下来查一下。最常见的两种：\n'
      + '  · database_id 填错了 → 跑 npx wrangler@latest d1 list 看一下正确的 id\n'
      + '  · 没登录 / 登录过期 → 跑 npx wrangler@latest login\n\n'
      + '处理好之后再跑一次：node deploy.mjs');
  }
  panelUrl = url;
  ok('已部署：' + url);
}

// ---------- 第 7 步：部署完立刻验一下，真的能用才算成功 ----------
// wrangler 说成功、面板却打不开（或一打开就报错）是最坑的情况：
// 用户以为已经弄好了，其实还得排错。所以这里当场把面板请一遍：
//   ① 首页能不能打开、是不是本面板的页面
//   ② 数据库通不通（用「故意输错密码」探登录接口：能回 JSON 就说明 D1 绑上了）
step('验收：真的能用才算部署成功');
{
  let bad = 0;
  // ① 首页
  try {
    const res = await fetch(panelUrl, { redirect: 'follow' });
    const html = await res.text();
    if (!res.ok) { warn(`首页返回 HTTP ${res.status}（等一两分钟再刷新试试，新部署有时要几十秒才完全生效）`); bad++; }
    else if (!/签到面板/.test(html)) { warn('首页能打开，但内容不像本面板（同名 Worker 被别人占了？）'); bad++; }
    else ok('面板首页能正常打开');
  } catch (e) {
    warn('打不开面板地址：' + ((e && e.message) || e));
    bad++;
  }
  // ② 数据库：故意用错密码调登录接口。
  //    密码肯定是错的 → 应该回一个 401/JSON；回 5xx 就说明 D1 没绑上或表没建起来。
  try {
    const res = await fetch(panelUrl + '/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'deploy-self-check-not-a-real-password' }),
    });
    const ct = res.headers.get('content-type') || '';
    if (res.status >= 500) { warn(`数据库接口返回 HTTP ${res.status} —— D1 没绑上或没建表，面板会读不出任何东西`); bad++; }
    else if (!/json/i.test(ct)) { warn('数据库接口没有回 JSON —— 静态资源和 API 路由可能没对上'); bad++; }
    else ok('数据库（D1）连得上，接口正常');
  } catch (e) {
    warn('数据库接口请求失败：' + ((e && e.message) || e));
    bad++;
  }

  if (bad) {
    console.log('');
    console.log(c.yellow('⚠️  部署命令是成功的，但上面这几项没过 —— 请先按下面做，做完再刷新面板：'));
    console.log(c.dim('    1) 等 1 分钟（新部署生效有时有几士秒延迟），再刷新一次面板地址'));
    console.log(c.dim('    2) 还不行就跑这两条看真实报错：'));
    console.log(c.dim('         npx wrangler@latest deployments list'));
    console.log(c.dim('         npx wrangler@latest tail            （然后在浏览器里刷新面板，看它报什么错）'));
    console.log(c.dim('    3) 报数据库相关（D1 / DB / no such table）就先列一下库和 id：'));
    console.log(c.dim('         npx wrangler@latest d1 list'));
    console.log('');
  }

  console.log('\n' + c.green(c.bold(bad ? '🎉 已部署完成（但请先看上面的 ⚠️）' : '🎉 部署成功，一切正常！')));
  console.log('\n你的签到面板地址是：\n\n    ' + c.bold(panelUrl) + '\n');
  console.log('接下来：');
  console.log('  1. 用浏览器打开上面的地址，设置一个管理密码（至少 8 位）');
  console.log('  2. 进去后点「设置」→「浏览器扩展」→ 点「🎲 重新生成 API Key」，把 Key 复制下来');
  console.log('     （这串 Key 只显示那一次，先粘到扩展弹窗里再关页面）');
  console.log('  3. 在「设置」→「🔌 浏览器扩展」里点「⬇️ 下载」，解压后按页面上的 4 步装上扩展');
  console.log('     （下载包里已经自动写好了你现在的面板地址，不用手抄）');
  console.log('  4. 在扩展弹窗里填 API Key，点「🔌 面板连接检查」');
  console.log('\n下一步的图文步骤看 README.md 的「部署完还要做 4 件事」；');
  console.log('想手动一步步来、或想弄清每步在干什么，看 docs/详细手册.md。\n');
}
