#!/usr/bin/env bash
# 测试命令：每秒打印一行带颜色的 <标签>-N，并用 \r 刷新一行进度；最后换行，打印 <标签>-done，按指定退出码退出。
# 用法：emit.sh <秒数> <标签> [退出码]
n=${1:-10}
label=${2:-emit}
code=${3:-0}
for i in $(seq 1 "$n"); do
  printf '\033[3%dm%s-%d\033[0m\n' $((i % 6 + 1)) "$label" "$i"
  printf 'progress %d/%d\r' "$i" "$n"
  sleep 1
done
printf '\n%s-done\n' "$label"
exit "$code"
