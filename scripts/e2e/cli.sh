#!/usr/bin/env bash
# 在左 pane 里起或退出真实的 Copilot CLI（start.sh 建好窗口之后用）。每次启动前后核对 ~/.copilot/settings.json。
#   cli.sh start [--noext] [--no-wait]   起 Copilot CLI。--noext：在没有项目级扩展的目录（.scratch/e2e/proj-noext）里起，不等扩展登记
#   cli.sh exit                          发 /exit，等它退出（退出后左 pane 回到 bash）
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

cmd=${1:-}
shift || true
case "$cmd" in
  start)
    NOEXT=0 WAIT=1
    for arg in "$@"; do
      case "$arg" in
        --noext) NOEXT=1 ;;
        --no-wait) WAIT=0 ;;
        *) echo "用法：cli.sh start [--noext] [--no-wait]" >&2; exit 2 ;;
      esac
    done
    tm has-session -t "$TMUX_SESSION" 2>/dev/null || { echo "先运行 scripts/e2e/start.sh（可加 --no-cli）。" >&2; exit 1; }
    require_model
    settings_check "启动前" || true
    dir=$PROJ
    [ "$NOEXT" = 1 ] && dir=$PROJ_NOEXT
    launch_ms=$(($(date +%s) * 1000))
    # 没有 --experimental、--no-mouse：它们会写全局设置（见 start.sh）。
    line="cd $dir && copilot --model $E2E_MODEL --allow-all --no-custom-instructions --no-ask-user --disable-builtin-mcps --name cp-e2e --log-level debug --log-dir $LOGS/copilot ${E2E_COPILOT_ARGS:-}; echo \"[copilot exited with \$?]\""
    tm send-keys -t "$LEFT" -l "clear"
    tm send-keys -t "$LEFT" Enter
    sleep 0.5
    tm send-keys -t "$LEFT" -l "$line"
    tm send-keys -t "$LEFT" Enter
    say "已在左 pane 启动 Copilot CLI（目录 $dir）"
    [ "$WAIT" = 1 ] || exit 0
    # 就绪：画面上出现输入框的提示符。遇到“是否信任”之类的提问就按回车确认第一项（只信任这一次，不记住）。
    READY_RE=${E2E_READY_RE:-'Ask Copilot|Type @ to mention|Enter @ to mention|❯|esc to cancel'}
    for _ in $(seq 1 120); do
      shot=$(tm capture-pane -p -t "$LEFT" 2>/dev/null || true)
      if grep -qiE 'trust the files|trust this folder|Do you trust' <<<"$shot"; then
        say "遇到信任目录的提问，选第一项"
        tm send-keys -t "$LEFT" Enter
        sleep 2
        continue
      fi
      if grep -qE "$READY_RE" <<<"$shot"; then
        say "Copilot CLI 就绪"
        if [ "$NOEXT" = 1 ]; then
          settings_check "启动后" || true
          exit 0
        fi
        # 输入框出现得比扩展加载早；这次启动之后的登记记录出现才说明被测扩展起来了。
        for _ in $(seq 1 60); do
          if node -e '
            const fs = require("fs"), path = require("path");
            const dir = process.argv[1], since = Number(process.argv[2]);
            let ok = false;
            try { for (const n of fs.readdirSync(dir)) if (n.endsWith(".json")) { const r = JSON.parse(fs.readFileSync(path.join(dir, n), "utf8")); if (r.startedAt >= since) ok = true; } } catch {}
            process.exit(ok ? 0 : 1);' "$DATA/sessions" "$launch_ms"; then
            say "扩展已登记"
            settings_check "启动后" || true
            exit 0
          fi
          sleep 1
        done
        echo "输入框已就绪，但 60 秒内没有新的登记记录：扩展没加载？看 $LOGS/copilot/*.log" >&2
        settings_check "启动后" || true
        exit 3
      fi
      sleep 1
    done
    echo "等了 120 秒还没就绪，最后的画面：" >&2
    tm capture-pane -p -t "$LEFT" >&2
    exit 1
    ;;
  exit)
    tm send-keys -t "$LEFT" -l "/exit"
    sleep 0.5
    tm send-keys -t "$LEFT" Enter
    for _ in $(seq 1 15); do
      tm capture-pane -p -t "$LEFT" 2>/dev/null | grep -q 'copilot exited with' && break
      sleep 1
    done
    if tm capture-pane -p -t "$LEFT" 2>/dev/null | grep -q 'copilot exited with'; then
      say "Copilot CLI 已退出"
    else
      say "/exit 没有生效，改按 Ctrl+C"
      tm send-keys -t "$LEFT" C-c; sleep 1; tm send-keys -t "$LEFT" C-c; sleep 3
    fi
    settings_check "退出后" || true
    ;;
  *)
    echo "用法：cli.sh start [--noext] [--no-wait] | cli.sh exit" >&2
    exit 2
    ;;
esac
