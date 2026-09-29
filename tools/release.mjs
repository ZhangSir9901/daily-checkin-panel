// 一键发版：自检 → 升版本号 → 写更新日志 → 打发布包 → 告诉你下一步敲什么
//
// 用法（在仓库根目录）：
//   node tools/release.mjs patch        # 2.10.0 → 2.10.1（修 bug）
//   node tools/release.mjs minor        # 2.10.0 → 2.11.0（加功能）
//   node tools/release.mjs major        # 2.10.0 → 3.0.0（不兼容改动）
//   node tools/release.mjs 2.11.3       # 直接指定版本号
//   node tools/release.mjs minor --ext  # 顺便把浏览器扩展的版本也 +1（改过 public/ext-src/ 时用）
//   node tools/release.mjs patch --no-verify   # 跳过自检（不推荐，只在着急看包时才用）
//
// 关键设计：**先自检、后改文件**。测试没过就一个字都不动，
// 不会留下「版本号已经改了、但代码是坏的」这种半成品状态。
//
// 本脚本只改文件、只打 zip，**不碰 git**：提交/打 tag/推送由你自己确认后再敲
// （脚本最后会把要敲的命令列出来）。推上 tag 之后，.github/workflows/release.yml
// 会自动跑自检并把 zip 传成 GitHub Release。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flags = argv.filter((a) => a.startsWith('--'));
const args = argv.filter((a) => !a.startsWith('--'));
const noVerify = flags.includes('--no-verify');
const bumpExt = flags.includes('--ext');

function die(msg, hint) {
  console.log('\n❌ ' + msg);
  if (hint) console.log('\n' + hint);
  console.log('');
  process.exit(1);
}
function step(t) { console.log('\n=== ' + t); }

// ---------- 解析目标版本号 ----------
const VERSION_RE = /export const PANEL_VERSION = '([^']+)'/;
function readVersion() {
  const m = readFileSync(join(root, 'src', 'version.js'), 'utf8').match(VERSION_RE);
  if (!m) die('读不到 src/version.js 里的 PANEL_VERSION');
  return m[1];
}

function nextVersion(cur, kind) {
  const parts = cur.split('.').map(Number);
  if (parts.length !== 3 || parts.some((n) => Number.isNaN(n))) {
    die('当前版本号不是 x.y.z 形式：' + cur);
  }
  if (/^\d+\.\d+\.\d+$/.test(kind)) return kind;
  if (kind === 'patch') return `${parts[0]}.${parts[1]}.${parts[2] + 1}`;
  if (kind === 'minor') return `${parts[0]}.${parts[1] + 1}.0`;
  if (kind === 'major') return `${parts[0] + 1}.0.0`;
  die('不认识的版本参数：' + (kind || '（没给）'),
    '用法：node tools/release.mjs patch|minor|major|<x.y.z> [--ext] [--no-verify]');
}

const kind = args[0] || 'patch';
const cur = readVersion();
const next = nextVersion(cur, kind);

// ---------- 第 1 步：自检 ----------
if (noVerify) {
  step('自检（已用 --no-verify 跳过）');
} else {
  step(`自检（node tools/verify.mjs）—— 不过就不动任何文件`);
  const r = spawnSync(process.execPath, [join('tools', 'verify.mjs')], { cwd: root, stdio: 'inherit' });
  if (r.status !== 0) {
    die('自检没通过，已停在原地（没有改任何文件）。',
      '先修好上面报红的项，再重新跑一次发版命令。');
  }
}

// ---------- 第 2 步：升版本号 ----------
step(`版本号 ${cur} → ${next}`);
{
  // 面板版本（唯一真源）
  const vPath = join(root, 'src', 'version.js');
  const vSrc = readFileSync(vPath, 'utf8');
  writeFileSync(vPath, vSrc.replace(VERSION_RE, `export const PANEL_VERSION = '${next}'`));
  console.log('  ✅ src/version.js');

  // package.json（测试会断言它和 src/version.js 一致）
  const pPath = join(root, 'package.json');
  const pkg = JSON.parse(readFileSync(pPath, 'utf8'));
  pkg.version = next;
  writeFileSync(pPath, JSON.stringify(pkg, null, 2) + '\n');
  console.log('  ✅ package.json');

  // 扩展版本：独立节奏，只在显式 --ext 时动（改了扩展代码才需要）
  if (bumpExt) {
    const mPath = join(root, 'public', 'ext-src', 'manifest.json');
    const man = JSON.parse(readFileSync(mPath, 'utf8'));
    const seg = String(man.version || '1.0').split('.').map(Number);
    seg[seg.length - 1] = (Number.isNaN(seg[seg.length - 1]) ? 0 : seg[seg.length - 1]) + 1;
    man.version = seg.join('.');
    writeFileSync(mPath, JSON.stringify(man, null, 2) + '\n');
    console.log('  ✅ public/ext-src/manifest.json → ' + man.version);
    // manifest 改了 → 必须重新生成嵌入文件，否则用户下载到的是旧扩展
    const g = spawnSync(process.execPath, [join('tools', 'gen-ext-files.mjs')], { cwd: root, stdio: 'inherit' });
    if (g.status !== 0) die('重新生成 src/ext-files.js 失败');
  }
}

// ---------- 第 3 步：更新日志 ----------
step('更新日志 CHANGELOG.md');
{
  const cPath = join(root, 'CHANGELOG.md');
  let text;
  try { text = readFileSync(cPath, 'utf8'); } catch {
    die('找不到 CHANGELOG.md', '这个文件应该在仓库根目录，和 README.md 放一起。');
  }
  const today = new Date().toISOString().slice(0, 10);
  const unrel = /^## \[未发布\]\s*$/m.exec(text);
  if (!unrel) die('CHANGELOG.md 里找不到 "## [未发布]" 这一行', '发版脚本靠它把这一版改了什么的清单挪到新版本号下面。');
  const start = unrel.index + unrel[0].length;
  const rest = text.slice(start);
  const nextIdx = rest.search(/^## \[/m);
  let body = (nextIdx < 0 ? rest : rest.slice(0, nextIdx)).trim();
  if (!body || !/^[-*]/m.test(body)) {
    body = '### 说明\n- 这一版没有单独记录明细。';
  }
  const head = text.slice(0, unrel.index);
  const tail = nextIdx < 0 ? '' : rest.slice(nextIdx);
  const fresh = '## [未发布]\n\n### 新增\n- \n\n### 修复\n- \n\n';
  writeFileSync(cPath, head + fresh + `## [${next}] - ${today}\n\n` + body + '\n\n' + tail);
  console.log('  ✅ 已把「未发布」的内容归到 ' + next + '，并留出新的「未发布」区');
}

// ---------- 第 4 步：打发布包 ----------
step('打发布包');
{
  mkdirSync(join(root, 'release'), { recursive: true });
  const r = spawnSync(process.execPath, [join('tools', 'pack-zip.mjs')], { cwd: root, encoding: 'utf8' });
  if (r.status !== 0) die('打包失败', (r.stderr || '') + (r.stdout || ''));
  const lines = r.stdout.trim().split('\n');
  for (const l of lines.filter((x) => !x.startsWith('  · '))) console.log('  ' + l);
  const out = (lines.find((l) => l.includes('输出：')) || '').split('输出：')[1] || '';
  console.log('');
  console.log('🎉 发布准备完成：v' + next);
  if (!noVerify) console.log('   自检：全部通过');
  console.log('   发布包：' + out);
  console.log('');
  // 这个目录不一定是个 git 仓库（很多人是下载 zip 解压出来的）：真不是就别误导人去敲 git 命令。
  const isGit = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: root, encoding: 'utf8' }).stdout?.trim() === 'true';
  if (isGit) {
    console.log('接下来（这几步要你自己确认后再敲，脚本不替你碰 git）：');
    console.log('   1) 看一眼改动：      git diff && git status');
    console.log('   2) 提交：            git add -A && git commit -m "release: v' + next + '"');
    console.log('   3) 打 tag 并推送：   git tag v' + next + ' && git push && git push --tags');
    console.log('      （推上 tag 后，GitHub Actions 会自动复跑自检、把 zip 传成 Release）');
    console.log('   4) 部署面板到 CF：   node deploy.mjs');
  } else {
    console.log('这个目录不是 git 仓库（像是解压出来的），跳过 git 提示。接下来：');
    console.log('   1) 把上面那个 zip 传到你自己的仓库 / 发布页（Release）');
    console.log('   2) 部署面板到 CF：   node deploy.mjs');
  }
  console.log('');
}
