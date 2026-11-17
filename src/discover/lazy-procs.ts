// 按需读 /proc/<pid> 的“进程表”：scanCandidates 只按进程号查几个锁文件里的进程像不像 Copilot CLI，不用把上千个进程都读一遍。
// 只有 get 和 has 能用；遍历、size 当作空表。需要全部进程（找 tmux pane 里的子孙进程）时用 procs.ts 的 readProcTable。

import { readProc } from "./procs.ts";
import type { ProcInfo } from "./procs.ts";

export class LazyProcTable extends Map<number, ProcInfo> {
  override get(pid: number): ProcInfo | undefined {
    return readProc(pid) ?? undefined;
  }

  override has(pid: number): boolean {
    return readProc(pid) !== null;
  }
}
