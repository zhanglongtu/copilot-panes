#!/usr/bin/env bash
# 在右 pane 里运行和操作界面（copilot-panes）。界面只能在独立 tmux 服务的 pane 里跑，绝不在别处运行。
#   ui.sh start [参数…]     在右 pane 启动界面（默认 node src/cli.ts；E2E_UI_BUNDLE=1 时用 start.sh 构建到 .scratch/e2e/dist/ 的 copilot-panes.mjs），不带 --session 让它自己找
#   ui.sh key <键名…>       送按键，用 tmux 的键名：Down、Enter、Escape、C-c、Tab、PageDown、x、q……
#   ui.sh type <文字>       把文字原样打进去（含中文），不按回车
#   ui.sh line <文字>       打字并按回车
#   ui.sh screen            打印右 pane 的画面（capture-pane -p，没有控制码）
#   ui.sh wait <正则> [秒]  等画面出现匹配的文字（默认 30 秒），打印画面；超时返回 1
#   ui.sh stop              按 q 退出界面；没退出就按两次 Ctrl+C
#   ui.sh pid               界面的 node 进程号
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

cmd=${1:-}
shift || true
case "$cmd" in
  start)
    tm has-session -t "$TMUX_SESSION" 2>/dev/null || { echo "先运行 scripts/e2e/start.sh。" >&2; exit 1; }
    if [ "${E2E_UI_BUNDLE:-0}" = 1 ]; then entry="node $E2E_DIR/dist/copilot-panes.mjs"; else entry="node src/cli.ts"; fi
    tm send-keys -t "$RIGHT" -l "clear; cd $E2E_ROOT && $entry $*"
    tm send-keys -t "$RIGHT" Enter
    say "已在右 pane 启动界面：$entry $*"
    ;;
  key) tm send-keys -t "$RIGHT" "$@" ;;
  type) tm send-keys -t "$RIGHT" -l "$*" ;;
  line)
    tm send-keys -t "$RIGHT" -l "$*"
    sleep 0.3
    tm send-keys -t "$RIGHT" Enter
    ;;
  screen) tm capture-pane -p -t "$RIGHT" ;;
  wait)
    re=${1:?缺正则}
    limit=${2:-30}
    for _ in $(seq 1 "$limit"); do
      shot=$(tm capture-pane -p -t "$RIGHT")
      if grep -qE -- "$re" <<<"$shot"; then printf '%s\n' "$shot"; exit 0; fi
      sleep 1
    done
    printf '%s\n' "$shot"
    exit 1
    ;;
  pid)
    pane_pid=$(tm display -p -t "$RIGHT" '#{pane_pid}')
    pgrep -P "$pane_pid" -f 'cli.ts|copilot-panes.mjs' | head -1
    ;;
  stop)
    tm send-keys -t "$RIGHT" Escape # 焦点在内容区时 q 只是一个普通字符，先回名单再退出
    sleep 0.4
    tm send-keys -t "$RIGHT" q
    sleep 1
    if ! tm capture-pane -p -t "$RIGHT" | grep -v '^ *$' | tail -1 | grep -qE '\$ *$'; then
      tm send-keys -t "$RIGHT" C-c
      sleep 0.3
      tm send-keys -t "$RIGHT" C-c
      sleep 1
    fi
    ;;
  *)
    echo "用法：ui.sh start|key|type|line|screen|wait|stop|pid" >&2
    exit 2
    ;;
esac
