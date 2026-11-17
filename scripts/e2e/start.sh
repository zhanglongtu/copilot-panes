#!/usr/bin/env bash
# 启动联调环境：独立的 tmux 服务（-L cp-e2e）里一个窗口，左右两个 pane 都是干净的 bash。
# 默认接着在左 pane 里起真实的 Copilot CLI（cli.sh start，装了项目级扩展 copilot-panes-dev）；右 pane 留给界面（ui.sh start）。
# 用法：scripts/e2e/start.sh [--build] [--no-wait] [--no-cli]
#   --no-cli：只建窗口，不起 Copilot CLI（先起界面看等待画面，再用 cli.sh start 起 Copilot CLI）。
# 环境变量：E2E_MODEL（必填：用来起 Copilot CLI 的模型 ID，没有默认值）、E2E_COPILOT_ARGS（追加给 copilot 的参数，不能含会写全局设置的参数）、
# E2E_READY_RE（判断“就绪”的正则）、E2E_NO_TRUST_ENV=1（见 cli.sh）。
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
DIR=$(dirname "${BASH_SOURCE[0]}")

BUILD=0 WAIT=1 CLI=1
for arg in "$@"; do
  case "$arg" in
    --build) BUILD=1 ;;
    --no-wait) WAIT=0 ;;
    --no-cli) CLI=0 ;;
    *) echo "用法：start.sh [--build] [--no-wait] [--no-cli]" >&2; exit 2 ;;
  esac
done

[ "$CLI" = 0 ] || require_model

if tm has-session -t "$TMUX_SESSION" 2>/dev/null; then
  echo "独立的 tmux 服务（-L $TMUX_SOCK）已经在运行。先运行 scripts/e2e/stop.sh。" >&2
  exit 1
fi

cd "$E2E_ROOT"
# 产物写到 .scratch/e2e/dist，不动 dist/：开发中的构建不该影响 dist/ 里已有的产物，也不该影响 deploy 过的版本。
E2E_BUILD=$E2E_DIR/dist
if [ "$BUILD" = 1 ] || [ ! -f "$E2E_BUILD/extension.mjs" ]; then
  say "构建 $E2E_BUILD/extension.mjs"
  BUILD_OUTDIR=$E2E_BUILD node build.mjs >/dev/null
fi

# 项目级扩展只认“仓库根目录或（不在 git 里时）当前目录”下的 .github/extensions/，
# 而 .scratch/ 在本仓库里面，所以测试项目要自己 git init，成为自己的仓库根目录。
mkdir -p "$PROJ/.github/extensions/copilot-panes-dev" "$PROJ/.github/extensions/e2e-spy" "$PROJ_NOEXT" "$LOGS/copilot" "$E2E_DIR/spy"
[ -d "$PROJ/.git" ] || git -C "$PROJ" init -q
[ -d "$PROJ_NOEXT/.git" ] || git -C "$PROJ_NOEXT" init -q
cp "$E2E_BUILD/extension.mjs" "$PROJ/.github/extensions/copilot-panes-dev/extension.mjs"
# 旁观者扩展：原样记下所有事件和任务列表，给被测扩展对照用（scripts/e2e/spy-extension.mjs）。
cp scripts/e2e/spy-extension.mjs "$PROJ/.github/extensions/e2e-spy/extension.mjs"
say "扩展已复制到 $PROJ/.github/extensions/{copilot-panes-dev,e2e-spy}/extension.mjs"

# 这些参数会把值写进全局设置文件（实测）：--no-mouse 写 "mouse": false，别的正在运行的 session 读到后会关掉鼠标；
# --experimental 写 "experimental": true；help 里说 --dynamic-retrieval 会保存。一律不用，也不准经 E2E_COPILOT_ARGS 传进来。
for bad in --no-mouse --mouse --experimental --no-experimental --dynamic-retrieval; do
  if printf ' %s ' "${E2E_COPILOT_ARGS:-}" | grep -qE -- " $bad[= ]"; then
    echo "E2E_COPILOT_ARGS 里的 $bad 会改写 $SETTINGS，不允许。" >&2
    exit 2
  fi
done
# 项目级扩展要求实验功能已开；不靠 --experimental 开，只检查设置里已经开了。
if ! node -e 'process.exit(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).experimental === true ? 0 : 1)' "$SETTINGS"; then
  echo "$SETTINGS 里 experimental 不是 true，项目级扩展不会加载。请先在 Copilot CLI 里运行 /settings 打开 experimental；脚本不会替你改。" >&2
  exit 2
fi
cp -p "$SETTINGS" "$SETTINGS_BEFORE"
say "已备份 $SETTINGS 到 $SETTINGS_BEFORE，cli.sh 和 stop.sh 会核对它有没有被改"

# COPILOT_ALLOW_ALL=true 同时让 Copilot CLI 不再问“是否信任这个目录”；COPILOT_PANES_HOME 把扩展和界面的数据目录指到 .scratch/e2e/data。
ENVS=(-e "COPILOT_PANES_HOME=$DATA" -e "E2E_SPY_DIR=$E2E_DIR/spy" -e "TERM=xterm-256color" -e "PS1=\$ ")
# E2E_NO_TRUST_ENV=1：不设 COPILOT_ALLOW_ALL，用来观察没信任目录时 Copilot CLI 怎么提问、扩展加不加载。
[ "${E2E_NO_TRUST_ENV:-0}" = 1 ] || ENVS+=(-e "COPILOT_ALLOW_ALL=true")

mapfile -t UNSET < <(clean_env_args)
env "${UNSET[@]}" tmux -L "$TMUX_SOCK" -f /dev/null new-session -d -s "$TMUX_SESSION" -x 200 -y 50 -c "$PROJ" "${ENVS[@]}" "bash --noprofile --norc"
tm set-option -t "$TMUX_SESSION" remain-on-exit on
tm split-window -h -t "$TMUX_SESSION:0" -c "$E2E_ROOT" "${ENVS[@]}" "bash --noprofile --norc"
tm select-pane -t "$LEFT"
say "tmux 服务 -L $TMUX_SOCK，窗口 $TMUX_SESSION：左 pane $LEFT 放 Copilot CLI，右 pane $RIGHT 放界面（ui.sh start）"

[ "$CLI" = 1 ] || exit 0
if [ "$WAIT" = 1 ]; then exec "$DIR/cli.sh" start; else exec "$DIR/cli.sh" start --no-wait; fi
