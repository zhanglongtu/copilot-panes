#!/usr/bin/env bash
# 测试命令：忽略 SIGINT，每秒打印一行 <标签>-N；收到 SIGTERM 会正常结束。用来验证 Ctrl+C 三级升级。
# 用法：trapint.sh <秒数> <标签>
trap '' INT
n=${1:-120}
label=${2:-trap}
for i in $(seq 1 "$n"); do
  echo "$label-$i"
  sleep 1
done
