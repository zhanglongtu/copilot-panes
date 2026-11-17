#!/usr/bin/env bash
# 测试命令：每秒打印一行进度，如 "[###-------] 12/40 30% 标签"（带颜色），每行用 \r 在原地刷新，最后换行并打印 <标签>-done。
# 用法：progress.sh <总步数> <标签>
total=${1:-40}
label=${2:-work}
for i in $(seq 1 "$total"); do
  pct=$((i * 100 / total))
  filled=$((i * 10 / total))
  bar=$(printf '%*s' "$filled" '' | tr ' ' '#')$(printf '%*s' $((10 - filled)) '' | tr ' ' '-')
  printf '\033[36m[%s] %d/%d %d%% %s\033[0m\r' "$bar" "$i" "$total" "$pct" "$label"
  sleep 1
done
printf '\n%s-done\n' "$label"
