#!/bin/bash
# 从用户上传的 zip 同步代码到仓库，并推送到 GitHub。
# 关键保护：用户的 zip 里 wrangler.toml 是开源模板版（database_id 为占位符），
# 同步后必须恢复真正的 D1 database_id，否则 Cloudflare 自动部署会失败。
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

# 真正的 D1 database_id（Cloudflare 仪表盘创建的 daily-checkin-panel 库）。
# 注意：绝不能提交占位符 REPLACE_ME_WITH_YOUR_OWN_D1_ID，否则线上部署失败。
REAL_DB_ID="23a3455d-69d7-49ec-a71f-4440dff9957c"

TMPDIR=$(mktemp -d)
trap "rm -rf '$TMPDIR'" EXIT
unzip -q "$ZIP" -d "$TMPDIR/unzipped"

# 同步（排除 git 元数据、本地构建产物、本脚本自身、workflow）
# 注意：tools/sync-from-zip.sh 是 hani 维护的同步工具，不在用户 zip 里，
# --delete 会误删它，所以必须排除。
rsync -a --delete \
  --exclude='.git' --exclude='node_modules' --exclude='.wrangler' \
  --exclude='tools/sync-from-zip.sh' --exclude='.github/' \
  "$TMPDIR/unzipped/" ./

# 恢复真正的 database_id（zip 里的是模板占位符）
if grep -q 'REPLACE_ME_WITH_YOUR_OWN_D1_ID' wrangler.toml 2>/dev/null; then
  sed -i "s/database_id = \"REPLACE_ME_WITH_YOUR_OWN_D1_ID\"/database_id = \"$REAL_DB_ID\"/" wrangler.toml
  echo "已恢复 wrangler.toml 中的真正 D1 database_id"
fi

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
