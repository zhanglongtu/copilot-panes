#!/usr/bin/env bash
# 一次跑完全部场景（约 6 分钟，每次花费几美分）：前台命令、会失败的命令、子 agent（同步、后台）、给运行中和空闲的子 agent 发消息、
# 转后台、取消子 agent 和命令、SIGINT 中断后台命令、detach 命令、扩展重新加载。每一步打印一行进度，最后用 compare-out.mjs 对照 .out。
# 前提：已运行 start.sh；另开窗口运行 `node scripts/e2e/probe.mjs watch` 可以同时看到所有推送。
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
DIR=$E2E_ROOT/scripts/e2e
P="node $DIR/probe.mjs"
N=11
K=0
T0=$(date +%s)
step() { K=$((K + 1)); printf '[%d/%d] 已用 %ds %s\n' "$K" "$N" $(($(date +%s) - T0)) "$*"; }
# wait_for <秒数> <命令…>：反复运行命令，成功就返回 0，超时返回 1
wait_for() { local limit=$1; shift; for _ in $(seq 1 "$limit"); do "$@" >/dev/null 2>&1 && return 0; sleep 1; done; return 1; }
first() { "$@" 2>/dev/null | sed -E 's/^[0-9:.]+ //' | head -1; }

step "主 agent 的前台命令（8 秒）"
"$DIR/send.sh" main-sync >/dev/null; sleep 18
step "会失败的命令（退出码 7）"
"$DIR/send.sh" main-fail >/dev/null; sleep 12
step "瞬间结束的命令"
"$DIR/send.sh" main-quick >/dev/null; sleep 10

step "同步子 agent：运行中发消息，结束后（空闲）再发一条"
"$DIR/send.sh" sync-agent >/dev/null
wait_for 40 $P find agent running
AG=$(first $P find agent running)
sleep 4; $P send "$AG" "Please also say the word PINEAPPLE in your final reply."
wait_for 40 $P find agent idle; sleep 3
$P send "$AG" "Reply with only the word MANGO."; sleep 8

step "后台子 agent：把它的命令转后台，再取消子 agent"
"$DIR/send.sh" bg-agent >/dev/null
wait_for 40 $P find shell running sync
SH=$(first $P find shell running sync)
sleep 2; $P promote "$SH"; sleep 2
BG=$(first $P find agent running)
$P cancel "$BG"; sleep 5

step "子 agent 起的后台命令，用 tasks.cancel 取消"
"$DIR/send.sh" agent-async-cmd >/dev/null
wait_for 60 $P find shell running
SH=$(first $P find shell running)
sleep 3; $P cancel "$SH"; sleep 6

step "主 agent 的后台命令（60 秒），用 SIGINT 给进程组发信号"
"$DIR/send.sh" main-async >/dev/null
wait_for 40 $P find shell running
SH=$(first $P find shell running)
sleep 8; $P sigint "$SH"; sleep 8

step "detach 命令（60 秒），留着跑"
"$DIR/send.sh" main-detach >/dev/null
wait_for 40 $P find shell running detached
DET=$(first $P find shell running detached)
echo "    detach 任务 id=$DET"

step "再起一条后台命令（60 秒），然后重新加载扩展"
"$DIR/send.sh" main-async >/dev/null
wait_for 40 $P find shell running attached
SH=$(first $P find shell running attached)
sleep 10
"$DIR/send.sh" reload-ext >/dev/null; sleep 25
$P tasks | grep -E "shellCalls|shell id" | cut -c1-260

step "等 detach 命令结束，再中断重新加载前起的后台命令"
detach_done() { ! $P find shell running detached >/dev/null 2>&1; }
wait_for 60 detach_done
$P sigint "$SH"; sleep 8

step "对照 .out 和真实事件"
node "$DIR/compare-out.mjs"
