// 读进程表（/proc）：找 tmux pane 里的 Copilot CLI 进程、判断进程是否活着。只支持 Linux。
// 所有函数都接受 procRoot 参数，测试在临时目录里假造 /proc/<pid>/stat、cmdline。

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface ProcInfo {
  pid: number;
  ppid: number;
  /** 进程组号。 */
  pgid: number;
  /** 进程的启动时刻（/proc/<pid>/stat 第 22 个字段，开机后的时钟滴答数）。 */
  startTicks: number;
  /** 程序名（/proc/<pid>/stat 括号里的部分；括号里可能有空格和括号，按最后一个 ")" 切）。 */
  comm: string;
  /** /proc/<pid>/cmdline 按 \0 切开；读不到是 []。 */
  argv: string[];
}

const DEFAULT_PROC_ROOT = "/proc";

/** 读一个进程。不存在、读不了、stat 格式不对返回 null（僵尸进程照常返回）。 */
export function readProc(pid: number, procRoot: string = DEFAULT_PROC_ROOT): ProcInfo | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  const dir = join(procRoot, String(pid));
  let stat: string;
  try {
    stat = readFileSync(join(dir, "stat"), "utf8");
  } catch {
    return null;
  }
  const open = stat.indexOf("(");
  const close = stat.lastIndexOf(")");
  if (open === -1 || close < open) return null;
  // ")" 后面从第 3 个字段（状态）开始：[1] 是父进程号，[2] 是进程组号，[19] 是第 22 个字段启动时刻。
  const fields = stat.slice(close + 2).trim().split(/\s+/);
  const ppid = Number(fields[1]);
  const pgid = Number(fields[2]);
  const startTicks = Number(fields[19]);
  if (![ppid, pgid, startTicks].every(Number.isSafeInteger)) return null;
  let argv: string[] = [];
  try {
    const raw = readFileSync(join(dir, "cmdline"), "utf8");
    argv = raw === "" ? [] : raw.replace(/\0$/, "").split("\0");
  } catch {
    // 进程刚退出或读不了：argv 留空
  }
  return { pid, ppid, pgid, startTicks, comm: stat.slice(open + 1, close), argv };
}

/** 读所有进程（/proc 下的数字目录）。单个进程读不了就跳过。 */
export function readProcTable(procRoot: string = DEFAULT_PROC_ROOT): Map<number, ProcInfo> {
  const table = new Map<number, ProcInfo>();
  let names: string[];
  try {
    names = readdirSync(procRoot);
  } catch {
    return table;
  }
  for (const name of names) {
    if (!/^[1-9][0-9]*$/.test(name)) continue;
    const info = readProc(Number(name), procRoot);
    if (info) table.set(info.pid, info);
  }
  return table;
}

/** /proc/<pid> 存在。 */
export function isPidAlive(pid: number, procRoot: string = DEFAULT_PROC_ROOT): boolean {
  return Number.isSafeInteger(pid) && pid > 0 && existsSync(join(procRoot, String(pid)));
}

/** root 自己和它的所有子孙进程号（按进程表的父子关系），root 不在表里时返回 []。 */
export function selfAndDescendants(root: number, table: ReadonlyMap<number, ProcInfo>): number[] {
  if (!table.has(root)) return [];
  const children = new Map<number, number[]>();
  for (const info of table.values()) {
    const siblings = children.get(info.ppid);
    if (siblings) siblings.push(info.pid);
    else children.set(info.ppid, [info.pid]);
  }
  const result = [root];
  const seen = new Set(result);
  for (let i = 0; i < result.length; i++) {
    for (const child of children.get(result[i]!) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      result.push(child);
    }
  }
  return result;
}

/** 这个参数是不是 copilot-panes 的程序：文件名是 copilot-panes（可带 .js、.mjs、.ts），或者脚本放在名叫 copilot-panes 的目录里。 */
function isPanesProgram(arg: string): boolean {
  return /(^|\/)copilot-panes(\.[cm]?[jt]s)?$/.test(arg) || /\/copilot-panes\/\S*\.[cm]?[jt]s$/.test(arg);
}

/** 是不是 copilot-panes 自己：程序（argv[0]）是它，或者 node 之类的解释器运行的第一个脚本是它。后面的参数不看。 */
function isCopilotPanes(info: ProcInfo): boolean {
  if (info.comm.startsWith("copilot-panes")) return true;
  const [program, ...rest] = info.argv;
  if (program === undefined) return false;
  if (isPanesProgram(program)) return true;
  if (!/(^|\/)(node|nodejs|bun|deno)$/.test(program)) return false;
  const script = rest.find((arg) => !arg.startsWith("-"));
  return script !== undefined && isPanesProgram(script);
}

/**
 * 像不像 Copilot CLI 进程：comm 是 "copilot"，或者 argv 里有以 "/copilot" 结尾、或包含 "@github/copilot/" 的路径。
 * copilot-panes 自己不算。认 copilot-panes 只看程序和脚本，不看整个 argv 里有没有这几个字：
 * `copilot --add-dir ~/projects/copilot-panes-ts` 或 `copilot --resume copilot-panes` 是 Copilot CLI，不能被排除。
 * 注意本机的 Copilot CLI 进程 comm 是 "MainThread"，靠 argv 认出来。
 */
export function looksLikeCopilot(info: ProcInfo): boolean {
  if (isCopilotPanes(info)) return false;
  if (info.comm === "copilot") return true;
  return info.argv.some((arg) => arg.endsWith("/copilot") || arg.includes("@github/copilot/"));
}
