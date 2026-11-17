#!/usr/bin/env bash
# 测试命令：尽快打印大量输出。用法：bigout.sh <行数> [每行附加的字节数，默认 0] [退出码，默认 0]
# 例：bigout.sh 200000 0 3 打印 20 万行后以 3 退出（失败的命令会留在界面名单里，方便选中来看）；bigout.sh 700000 40 约 40 MB（用来碰 32 MiB 的上限）。
n=${1:-200000}
pad=$(printf '%*s' "${2:-0}" '' | tr ' ' 'x')
seq 1 "$n" | sed "s/^/line /;s/\$/ $pad/"
echo "bigout-done $n"
exit "${3:-0}"
