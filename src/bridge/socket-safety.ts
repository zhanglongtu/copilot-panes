// 连扩展的 socket 之前先看一眼路径靠不靠谱：别的用户或别的进程能在路径上放一个 socket，界面就会把它当扩展，
// 它发来的任务列表（含进程号）会被拿去发信号。这里只做 lstat 检查（不跟随符号链接），真正的对端身份靠 hello 里的进程号和登记记录对照
// （src/bridge/client.ts 的 expectedCopilotPid）。没有做 SO_PEERCRED：Node 没有直接读它的接口。

import { lstatSync } from "node:fs";
import type { Stats } from "node:fs";
import { dirname } from "node:path";

export interface SafetyFs {
  lstat(path: string): Pick<Stats, "uid" | "mode" | "isDirectory" | "isSocket" | "isSymbolicLink">;
  /** 当前用户号；取不到（不是 POSIX）时是 null，跳过属主检查。 */
  uid: number | null;
}

export const realSafetyFs: SafetyFs = {
  lstat: (path) => lstatSync(path),
  uid: typeof process.getuid === "function" ? process.getuid() : null,
};

/**
 * 返回 null 表示可以连，否则是一句给人看的原因（界面显示成“只读：不连这个 socket：<原因>”）。规则：
 * - socket 所在的目录：用 lstat 看，必须是真目录（不是符号链接）、属于当前用户、对组和其他人不可写（mode & 0o022 为 0）。
 * - socket 文件：必须是 socket、属于当前用户、对组和其他人不可写。
 * 文件还不存在（ENOENT）不算不安全：返回 null，让正常的连接和重连去处理。检查和连接之间有一个很窄的时间差，这里挡不住，
 * 所以连上之后还要核对 hello 里的进程号。
 */
export function checkSocketSafety(socketPath: string, fs: SafetyFs = realSafetyFs): string | null {
  const dir = dirname(socketPath);
  let dirStat: ReturnType<SafetyFs["lstat"]>;
  try {
    dirStat = fs.lstat(dir);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? null : `读不了 socket 所在的目录 ${dir}：${(error as Error).message}`;
  }
  if (dirStat.isSymbolicLink()) return `socket 所在的目录 ${dir} 是符号链接`;
  if (!dirStat.isDirectory()) return `socket 所在的 ${dir} 不是目录`;
  if (fs.uid !== null && dirStat.uid !== fs.uid) return `socket 所在的目录 ${dir} 不属于当前用户`;
  if ((dirStat.mode & 0o022) !== 0) return `socket 所在的目录 ${dir} 对组或其他人可写`;

  let fileStat: ReturnType<SafetyFs["lstat"]>;
  try {
    fileStat = fs.lstat(socketPath);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? null : `读不了 ${socketPath}：${(error as Error).message}`;
  }
  if (!fileStat.isSocket()) return `${socketPath} 不是 socket`;
  if (fs.uid !== null && fileStat.uid !== fs.uid) return `${socketPath} 不属于当前用户`;
  if ((fileStat.mode & 0o022) !== 0) return `${socketPath} 对组或其他人可写`;
  return null;
}
