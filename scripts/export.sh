#!/usr/bin/env bash
# 导出可上传 GitHub 的干净副本（排除依赖、日志、报告、.git）
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/dist"
VERSION="$(node -p "require('$ROOT/package.json').version")"
NAME="desktop-agent-$VERSION"

mkdir -p "$OUT"
rm -f "$OUT/$NAME.tar.gz"

# 附带 ocu 的许可与第三方声明（合规）
node "$ROOT/scripts/bundle-ocu.mjs" >/dev/null 2>&1 || echo "提示：未能附带 ocu 许可（未安装 ocu？）"

cd "$ROOT"
tar -czf "$OUT/$NAME.tar.gz" \
  --exclude='./node_modules' \
  --exclude='./overlay/node_modules' \
  --exclude='./logs' \
  --exclude='./reports' \
  --exclude='./dist' \
  --exclude='./.git' \
  --exclude='.DS_Store' \
  .

SIZE="$(du -h "$OUT/$NAME.tar.gz" | cut -f1)"
echo "已导出 $OUT/$NAME.tar.gz ($SIZE)"
