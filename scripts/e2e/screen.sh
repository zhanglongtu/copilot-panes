#!/usr/bin/env bash
# 打印 pane 的画面。用法：screen.sh [left|right] [-w 正则 [超时秒数]]；-w 会等到画面匹配正则才打印（超时返回 1）。
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

target=$LEFT
case "${1:-}" in left) shift ;; right) target=$RIGHT; shift ;; esac
if [ "${1:-}" = "-w" ]; then
  re=${2:?缺正则}; limit=${3:-60}
  for _ in $(seq 1 "$limit"); do
    shot=$(tm capture-pane -p -t "$target")
    if grep -qE "$re" <<<"$shot"; then printf '%s\n' "$shot"; exit 0; fi
    sleep 1
  done
  printf '%s\n' "$shot"
  exit 1
fi
tm capture-pane -p -t "$target"
