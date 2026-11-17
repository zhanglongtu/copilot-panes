// 中断命令：界面直接给命令的进程发信号（不经过 Copilot CLI），Ctrl+C 连按时逐级升级。
// 依据：后台命令是它自己进程组和会话的组长、没有伪终端（实测）；
// SDK 的 shell.kill 对 bash 工具起的命令无效，所以只能自己发信号。

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { InterruptOutcome, InterruptSignal } from "../types/app.ts";
import type { Clock } from "../types/clock.ts";

/** 读进程信息和发信号的接口。真实现读 /proc；测试用假的进程表。 */
export interface ProcAccess {
  /** /proc/<pid> 还在。 */
  exists(pid: number): boolean;
  /** 父进程号；读不到是 null。 */
  parentOf(pid: number): number | null;
  /** 进程组号；读不到是 null。 */
  processGroupOf(pid: number): number | null;
  /** process.kill(target, signal)；target 为负数时发给整个进程组。 */
  kill(target: number, signal: InterruptSignal): void;
}

/** 读 /proc/<pid>/stat 里括号后面的字段：[0] 是状态（第 3 个字段），[1] 是父进程号，[2] 是进程组号。程序名里可以有空格和括号，所以从最后一个 ")" 切。 */
function statFields(procRoot: string, pid: number): string[] | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    const stat = readFileSync(join(procRoot, String(pid), "stat"), "utf8");
    const close = stat.lastIndexOf(")");
    if (close === -1) return null;
    return stat.slice(close + 2).trim().split(" ");
  } catch {
    return null;
  }
}

function numberAt(fields: string[] | null, index: number): number | null {
  const n = Number(fields?.[index]);
  return Number.isSafeInteger(n) ? n : null;
}

/** 读真实 /proc 的实现（procRoot 默认 "/proc"，测试可以指向临时目录里假造的 /proc）。 */
export function procAccess(procRoot: string = "/proc"): ProcAccess {
  return {
    exists: (pid) => Number.isSafeInteger(pid) && pid > 0 && existsSync(join(procRoot, String(pid))),
    parentOf: (pid) => numberAt(statFields(procRoot, pid), 1),
    processGroupOf: (pid) => numberAt(statFields(procRoot, pid), 2),
    kill: (target, signal) => {
      // 0 和 1 以及 -1 会波及自己的进程组、init 或所有进程，绝不发。
      if (!Number.isSafeInteger(target) || Math.abs(target) <= 1) throw new RangeError(`refusing to signal ${target}`);
      process.kill(target, signal);
    },
  };
}

/** 沿父进程链往上找，ancestor 是不是 pid 的祖先（不含 pid 自己）。链断了或绕圈（最多走 4096 步）返回 false。 */
export function isDescendantOf(pid: number, ancestor: number, proc: ProcAccess): boolean {
  let current = pid;
  for (let step = 0; step < 4096; step++) {
    const parent = proc.parentOf(current);
    if (parent === null || parent <= 0) return false;
    if (parent === ancestor) return true;
    current = parent;
  }
  return false;
}

export type TargetCheck = { ok: true; group: boolean } | { ok: false; reason: string };

/**
 * 发信号前的检查（防止进程号被别的进程重用，也防止被骗去杀不相干的进程）：
 * - copilotPid 小于等于 1 不可信：进程号 1 是所有进程的祖先，祖先检查对它永远通过。
 * - /proc/<pid> 还在，并且 copilotPid 是它的祖先。
 * - 目标不能是界面自己（selfPid）或它的祖先，信号要发往的进程组也不能是界面自己所在的进程组。selfPid 不给就不查这一项。
 * 通过时 group 表示 pid 是不是自己进程组的组长（进程组号等于 pid）：是就给整个进程组发，不是就只给它发。
 * 不通过的 reason：“命令已经退出了”“这个进程号已经不属于这个 session 的 Copilot CLI”等。
 */
export function checkTarget(pid: number, copilotPid: number, proc: ProcAccess, selfPid: number | null = null): TargetCheck {
  if (!Number.isSafeInteger(copilotPid) || copilotPid <= 1) return { ok: false, reason: "Copilot CLI 的进程号不可信" };
  if (!Number.isSafeInteger(pid) || pid <= 1 || !proc.exists(pid)) return { ok: false, reason: "命令已经退出了" };
  if (!isDescendantOf(pid, copilotPid, proc)) return { ok: false, reason: "这个进程号已经不属于这个 session 的 Copilot CLI" };
  const group = proc.processGroupOf(pid) === pid;
  if (selfPid !== null) {
    if (pid === selfPid || isDescendantOf(selfPid, pid, proc)) return { ok: false, reason: "这个进程号是界面自己或它的祖先" };
    const selfGroup = proc.processGroupOf(selfPid);
    if (selfGroup !== null && selfGroup === (group ? pid : proc.processGroupOf(pid))) return { ok: false, reason: "信号会发到界面自己所在的进程组" };
  }
  return { ok: true, group };
}

const NEXT_SIGNAL: Record<InterruptSignal, InterruptSignal> = { SIGINT: "SIGTERM", SIGTERM: "SIGKILL", SIGKILL: "SIGKILL" };

/**
 * 纯函数：这次按 Ctrl+C 该发什么。previous 是这条命令上一次发的信号和时刻（没发过是 undefined）。
 * 没发过发 SIGINT；距上一次不到 escalateMs（INTERRUPT_ESCALATE_MS，3 秒）返回 wait；否则 SIGINT 之后发 SIGTERM，SIGTERM 之后发 SIGKILL，
 * SIGKILL 之后还发 SIGKILL。
 */
export function nextSignal(
  previous: { signal: InterruptSignal; sentAt: number } | undefined,
  now: number,
  escalateMs: number,
): { send: InterruptSignal } | { wait: number; last: InterruptSignal } {
  if (!previous) return { send: "SIGINT" };
  const elapsed = now - previous.sentAt;
  if (elapsed < escalateMs) return { wait: escalateMs - Math.max(0, elapsed), last: previous.signal };
  return { send: NEXT_SIGNAL[previous.signal] };
}

/** 记着每条命令发过什么信号，按一次 Ctrl+C 就调用一次 press。 */
export class Interrupter {
  readonly #proc: ProcAccess;
  readonly #clock: Clock;
  readonly #escalateMs: number;
  readonly #sent = new Map<string, { signal: InterruptSignal; sentAt: number }>();

  readonly #selfPid: number;

  /** selfPid 是界面自己的进程号（默认 process.pid），checkTarget 用它保证不会给自己或自己的祖先发信号。 */
  constructor(proc: ProcAccess, clock: Clock, escalateMs: number, selfPid: number = process.pid) {
    this.#proc = proc;
    this.#clock = clock;
    this.#escalateMs = escalateMs;
    this.#selfPid = selfPid;
  }

  /**
   * detached 为真（detach 出去的命令）时直接返回 fallback：它的 pid 不是进程组组长，只给这一个进程发 SIGINT，bash 还在等子进程，
   * 实测 5 秒后命令照跑；tasks.cancel 才停得掉。
   * pid 或 copilotPid 为 null 时返回 fallback（调用方改请扩展 tasks.cancel）；checkTarget 不通过时也返回 fallback，reason 用它的；
   * 该等时返回 wait；否则按 nextSignal 发信号（组长发 -pid），返回 sent。kill 抛异常时返回 failed（ESRCH 写“命令已经退出了”）。
   */
  press(toolCallId: string, pid: number | null, copilotPid: number | null, options: { detached?: boolean } = {}): InterruptOutcome {
    if (options.detached === true) return { kind: "fallback", reason: "这是 detach 出去的命令，发信号停不掉它" };
    if (pid === null) return { kind: "fallback", reason: "拿不到命令的进程号" };
    if (copilotPid === null) return { kind: "fallback", reason: "不知道这个 session 的 Copilot CLI 进程号" };
    const check = checkTarget(pid, copilotPid, this.#proc, this.#selfPid);
    if (!check.ok) {
      this.#sent.delete(toolCallId);
      return { kind: "fallback", reason: check.reason };
    }
    const now = this.#clock.now();
    const next = nextSignal(this.#sent.get(toolCallId), now, this.#escalateMs);
    if ("wait" in next) return { kind: "wait", signal: next.last, remainingMs: next.wait };
    try {
      this.#proc.kill(check.group ? -pid : pid, next.send);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return { kind: "failed", reason: "命令已经退出了" };
      return { kind: "failed", reason: `发信号失败：${error instanceof Error ? error.message : String(error)}` };
    }
    this.#sent.set(toolCallId, { signal: next.send, sentAt: now });
    return { kind: "sent", signal: next.send, target: check.group ? "group" : "process" };
  }

  /** 命令结束后调用，忘掉它的记录。 */
  forget(toolCallId: string): void {
    this.#sent.delete(toolCallId);
  }
}
