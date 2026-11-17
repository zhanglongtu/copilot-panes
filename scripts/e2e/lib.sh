# 联调脚本共用的设置，由别的脚本 source。
E2E_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
E2E_DIR=${E2E_DIR:-$E2E_ROOT/.scratch/e2e}
PROJ=$E2E_DIR/proj
DATA=$E2E_DIR/data
LOGS=$E2E_DIR/logs
TMUX_SOCK=${E2E_TMUX_SOCK:-cp-e2e}
TMUX_SESSION=e2e
LEFT=$TMUX_SESSION:0.0
RIGHT=$TMUX_SESSION:0.1
# 全局设置文件。联调不能改它：start.sh 启动前备份，stop.sh 退出后核对（见 scripts/e2e/README.md 的“不碰全局设置”）。
SETTINGS=${COPILOT_HOME:-$HOME/.copilot}/settings.json
SETTINGS_BEFORE=$E2E_DIR/settings.json.before
PROJ_NOEXT=$E2E_DIR/proj-noext   # 不装扩展的测试项目（cli.sh start --noext 用）
# 真实 session 要花钱：用环境变量 E2E_MODEL 指定模型 ID，自己选一个便宜的。没有默认值；起 Copilot CLI 和送带 @MODEL@ 的提示时检查。
E2E_MODEL=${E2E_MODEL:-}
require_model() {
  [ -n "$E2E_MODEL" ] || { echo "请用环境变量 E2E_MODEL 指定模型 ID，例如：E2E_MODEL=<模型 ID> scripts/e2e/start.sh" >&2; exit 2; }
}

# 只对独立的 tmux 服务发命令；清掉 TMUX 变量，免得误连你正在用的 tmux。
tm() { env -u TMUX -u TMUX_PANE tmux -L "$TMUX_SOCK" "$@"; }

# 给 env 用的参数：清掉外层 Copilot CLI 和 tmux 留在环境里的变量，免得测试用的 Copilot CLI 把自己当成别人的子进程。
clean_env_args() {
  local v
  for v in $(compgen -e | grep -E '^(COPILOT_|TMUX)' || true); do
    printf '%s\n' "-u" "$v"
  done
}

say() { printf '[e2e %s] %s\n' "$(date +%H:%M:%S)" "$*"; }

# 核对全局设置文件和 start.sh 启动前的备份一致；不一致只报出来，绝不覆盖。返回 0 一致，1 不一致或没有备份。
settings_check() {
  if [ ! -f "$SETTINGS_BEFORE" ]; then
    say "没有找到启动前的备份 $SETTINGS_BEFORE，没法核对全局设置"
    return 1
  fi
  if cmp -s "$SETTINGS_BEFORE" "$SETTINGS"; then
    say "确认：$SETTINGS 和启动前的备份一致（$1）"
    return 0
  fi
  say "警告（$1）：$SETTINGS 和启动前不一样（可能是联调启动的 Copilot CLI 改的，也可能是你在别的 session 里改的）："
  diff "$SETTINGS_BEFORE" "$SETTINGS" | head -30
  say "没有自动改回，由你决定。"
  return 1
}
