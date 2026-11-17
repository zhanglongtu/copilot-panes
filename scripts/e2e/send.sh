#!/usr/bin/env bash
# 往左 pane（Copilot CLI）送一条提示，或送按键。
#   send.sh <名字>          送 prompts/<名字>.txt 的内容（@EMIT@ 换成 emit.sh 的路径）；send.sh --list 列出所有名字
#   send.sh -t "任意文字"   原样送这段文字，再按回车（斜杠命令如 "/new" 也这样送）
#   send.sh -k Escape       只送按键（tmux 的键名，如 Escape、C-c、Enter）
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
DIR=$(dirname "${BASH_SOURCE[0]}")

case "${1:-}" in
  --list)
    for f in "$DIR"/prompts/*.txt; do printf '%-16s %s\n' "$(basename "$f" .txt)" "$(head -c 100 "$f")"; done
    exit 0 ;;
  -k) shift; tm send-keys -t "$LEFT" "$@"; exit 0 ;;
  -t) text=${2:?缺文字} ;;
  "") echo "用法：send.sh <名字>|-t <文字>|-k <键>|--list" >&2; exit 2 ;;
  *)
    file="$DIR/prompts/$1.txt"
    [ -f "$file" ] || { echo "没有这条提示：$1（send.sh --list 看全部）" >&2; exit 1; }
    text=$(<"$file")
    text=${text//@EMIT@/$E2E_ROOT/scripts/e2e/emit.sh}
    text=${text//@DIR@/$E2E_ROOT/scripts/e2e}
    if [[ $text == *@MODEL@* ]]; then require_model; fi
    text=${text//@MODEL@/$E2E_MODEL} ;;
esac

tm send-keys -t "$LEFT" -l "$text"
sleep 0.5
tm send-keys -t "$LEFT" Enter
say "已送出：${text:0:120}"
