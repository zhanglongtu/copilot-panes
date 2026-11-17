#!/usr/bin/env bash
# 收尾：让 Copilot CLI 退出，关掉独立的 tmux 服务，确认没有留下进程。用法：scripts/e2e/stop.sh [--force]
# --force：发现留下的测试进程时给它们发 SIGTERM。只会动环境里带着本次数据目录（COPILOT_PANES_HOME）或工作目录在测试项目里的进程。
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
FORCE=0
[ "${1:-}" = "--force" ] && FORCE=1

if tm has-session -t "$TMUX_SESSION" 2>/dev/null; then
  # 先退出界面（右 pane 里还在跑 node 才发 q），再让 Copilot CLI 退出
  if tm capture-pane -p -t "$RIGHT" 2>/dev/null | grep -v '^ *$' | tail -1 | grep -qE '\$ *$'; then :; else
    say "退出界面"
    "$(dirname "${BASH_SOURCE[0]}")/ui.sh" stop >/dev/null 2>&1
  fi
  left_pid=$(tm display -p -t "$LEFT" '#{pane_pid}' 2>/dev/null || true)
  if [ -n "$left_pid" ] && pgrep -P "$left_pid" >/dev/null 2>&1; then # 左 pane 的 bash 下面还有前台程序：Copilot CLI
    say "让 Copilot CLI 退出（/exit）"
    "$(dirname "${BASH_SOURCE[0]}")/cli.sh" exit >/dev/null 2>&1
  fi
  tm kill-server 2>/dev/null
  say "已关掉 tmux 服务 -L $TMUX_SOCK"
else
  say "tmux 服务 -L $TMUX_SOCK 没在运行"
fi
sleep 2
# 服务退出后 socket 文件偶尔还在；确认没有进程在听再删（只删自己的 cp-e2e）
sock="/tmp/tmux-$(id -u)/$TMUX_SOCK"
if [ -S "$sock" ] && ! ss -xl 2>/dev/null | grep -qF "$sock"; then rm -f "$sock"; fi

# 核对全局设置文件有没有被改：和 start.sh 启动前的备份比。不一致只报出来，绝不覆盖。
SETTINGS_CHANGED=0
settings_check "stop.sh" || SETTINGS_CHANGED=1

# 找留下的进程：环境里有本次的 COPILOT_PANES_HOME，或工作目录在测试项目里。
left=()
for dir in /proc/[0-9]*; do
  [ -O "$dir" ] || continue # 只看自己的进程
  pid=${dir#/proc/}
  [ "$pid" = "$$" ] && continue
  hit=0
  if { tr '\0' '\n' <"$dir/environ" | grep -qxF "COPILOT_PANES_HOME=$DATA"; } 2>/dev/null; then hit=1; fi
  cwd=$(readlink "$dir/cwd" 2>/dev/null || true)
  case "$cwd" in "$PROJ"|"$PROJ"/*) hit=1 ;; esac
  [ "$hit" = 1 ] && left+=("$pid")
done

if [ ${#left[@]} -eq 0 ]; then
  say "确认：没有留下进程"
  exit $((SETTINGS_CHANGED * 4))
fi
say "留下了 ${#left[@]} 个进程："
for pid in "${left[@]}"; do printf '  %s %s\n' "$pid" "$(tr '\0' ' ' </proc/$pid/cmdline 2>/dev/null | head -c 150)"; done
if [ "$FORCE" = 1 ]; then
  kill -TERM "${left[@]}" 2>/dev/null
  sleep 2
  for pid in "${left[@]}"; do [ -d "/proc/$pid" ] && say "仍在运行：$pid"; done
else
  say "用 stop.sh --force 给它们发 SIGTERM"
fi
exit 1
