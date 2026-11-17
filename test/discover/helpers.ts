// 假造 /proc 和登记记录的小工具，discover 的几个测试共用。
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REGISTRATION_VERSION } from "../../src/protocol.ts";
import type { Registration } from "../../src/protocol.ts";

export function registration(sessionId: string, over: Partial<Registration> = {}): Registration {
  return {
    v: REGISTRATION_VERSION,
    protocol: 1,
    sessionId,
    copilotPid: 4000,
    extensionPid: 4001,
    tmuxPane: "%3",
    cwd: "/work/app",
    socketPath: `/x/${sessionId}.sock`,
    extensionVersion: "0.0.0",
    startedAt: 1000,
    updatedAt: 2000,
    ...over,
  };
}

export interface FakeProc {
  pid: number;
  ppid?: number;
  pgid?: number;
  startTicks?: number;
  comm?: string;
  argv?: string[];
}

/** 在假的 /proc 目录里写一个进程：stat 的第 4、5、22 个字段是父进程号、进程组号、启动时刻。 */
export function putProc(root: string, p: FakeProc): void {
  const dir = join(root, String(p.pid));
  mkdirSync(dir, { recursive: true });
  const pgid = p.pgid ?? p.pid;
  writeFileSync(join(dir, "stat"), `${p.pid} (${p.comm ?? "proc"}) S ${p.ppid ?? 1} ${pgid} ${pgid} 0 -1 4194304 0 0 0 0 0 0 0 0 20 0 1 0 ${p.startTicks ?? 1000} 1 1 18446744073709551615\n`);
  writeFileSync(join(dir, "cmdline"), (p.argv ?? [p.comm ?? "proc"]).join("\0") + "\0");
}
