#!/bin/bash
# 从用户上传的 zip 同步代码到仓库，并推送到 GitHub。
# 开源后：wrangler.toml 里保持占位符 REPLACE_ME_WITH_YOUR_OWN_D1_ID（不提交真 ID）。
# 用户自己的线上部署靠 Cloudflare 仪表盘里配好的 D1 绑定（会覆盖 wrangler.toml），
# 所以这里不再恢复真 ID。仪表盘绑定配好之前不要推送，否则自动部署会失败。
#
# 用法：bash tools/sync-from-zip.sh <zip路径> ["<commit信息>"]
set -e
cd "$(dirname "$0")/.."

ZIP="$1"
MSG="${2:-同步用户更新}"
if [ -z "$ZIP" ] || [ ! -f "$ZIP" ]; then
  echo "用法：bash tools/sync-from-zip.sh <zip路径> [\"commit信息\"]"
  exit 1
fi

TMPDIR=$(mktemp -d)
trap "rm -rf '$TMPDIR'" EXIT
unzip -q "$ZIP" -d "$TMPDIR/unzipped"

# 同步（排除 git 元数据、本地构建产物、本脚本自身、workflow）
# 注意：tools/sync-from-zip.sh 是 hani 维护的同步工具，不在用户 zip 里，
# --delete 会误删它，所以必须排除。
rsync -a --delete \
  --exclude='.git' --exclude='node_modules' --exclude='.wrangler' \
  --exclude='tools/sync-from-zip.sh' --exclude='.github/' \
  --exclude='wrangler.toml' \
  "$TMPDIR/unzipped/" ./

# wrangler.toml 已排除：开源仓库里永远保持占位符，不碰。

# 重新生成扩展静态文件
node tools/gen-ext-files.mjs

# 模块冒烟检查
node --input-type=module -e "
Promise.all([
  import('./src/index.js'),
  import('./src/sites/hutue.js'),
  import('./src/sites/wuaipojie.js'),
]).then(() => console.log('模块加载 OK')).catch(e => { console.log('模块加载失败:', e.message); process.exit(1); })
"

git add -A
# .github/ 已在 rsync 阶段排除，这里是双保险：万一哪天排除失效，
# 提交前把 .github/ 拿出暂存区（当前 token 缺 workflow 权限，推不上去）
git reset -q HEAD .github/ 2>/dev/null || true
git commit -m "$MSG"
git push origin master
echo "同步完成，已推送。"
