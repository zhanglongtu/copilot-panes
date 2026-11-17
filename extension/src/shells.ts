// 把 shell 任务对应到命令的 toolCallId。shell 任务（TaskShellInfo）没有 toolCallId 字段，界面却要按 toolCallId 找进程号、
// 发请求，所以扩展先把它们对应好，放进 tasks 消息的 shellCalls。

import type { TaskInfo } from "../../src/protocol.ts";
import type { SdkEvent } from "./sdk.ts";

/** 一次 shell 工具调用（bash、powershell）。 */
export interface ShellCall {
  toolCallId: string;
  /** arguments.command 原文。 */
  command: string;
  /** tool.execution_start 的时间（Unix 毫秒）；时间解析不了用收到事件的时刻。 */
  startedAt: number;
  /** 已知的 shellId：开始事件的 arguments.shellId，或完成事件的 result.structuredContent.shellId、content 里的 "shellId: X>"。 */
  shellId: string | null;
}

/** 命令文字相同的调用，开始时间和任务的 startedAt 相差不到这么久才可能对应。 */
const MATCH_WINDOW_MS = 30_000;
/** 最近的两个候选相差不超过这么久，就当作分不出谁是谁。 */
const AMBIGUOUS_MS = 100;
const SHELL_TOOLS: ReadonlySet<string> = new Set(["bash", "powershell"]);

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** 记下最近的 shell 调用，最多留 maxCalls 条（超出时丢最早的）。 */
export class ShellCallBook {
  readonly #maxCalls: number;
  readonly #now: () => number;
  readonly #calls = new Map<string, ShellCall>();

  constructor(maxCalls: number, now: () => number) {
    this.#maxCalls = Math.max(1, maxCalls);
    this.#now = now;
  }

  /** tool.execution_start 和 tool.execution_complete 时调用；别的事件和非 shell 工具忽略。 */
  onEvent(event: SdkEvent): void {
    const data = record(event.data);
    if (!data) return;
    if (event.type === "tool.execution_start") this.#onStart(event, data);
    else if (event.type === "tool.execution_complete") this.#onComplete(data);
  }

  calls(): readonly ShellCall[] {
    return [...this.#calls.values()];
  }

  #onStart(event: SdkEvent, data: Record<string, unknown>): void {
    const toolCallId = data.toolCallId;
    if (typeof toolCallId !== "string" || toolCallId === "") return;
    if (typeof data.toolName !== "string" || !SHELL_TOOLS.has(data.toolName)) return;
    const args = record(data.arguments);
    const parsed = typeof event.timestamp === "string" ? Date.parse(event.timestamp) : NaN;
    const shellId = args?.shellId;
    this.#calls.delete(toolCallId);
    this.#calls.set(toolCallId, {
      toolCallId,
      command: typeof args?.command === "string" ? args.command : "",
      startedAt: Number.isFinite(parsed) ? parsed : this.#now(),
      shellId: typeof shellId === "string" && shellId !== "" ? shellId : typeof shellId === "number" ? String(shellId) : null,
    });
    if (this.#calls.size > this.#maxCalls) {
      const oldest = this.#calls.keys().next().value;
      if (oldest !== undefined) this.#calls.delete(oldest);
    }
  }

  #onComplete(data: Record<string, unknown>): void {
    const toolCallId = data.toolCallId;
    if (typeof toolCallId !== "string") return;
    const call = this.#calls.get(toolCallId);
    if (!call) return;
    const result = record(data.result);
    const structured = record(result?.structuredContent)?.shellId;
    if (typeof structured === "string" && structured !== "") {
      call.shellId = structured;
      return;
    }
    if (typeof structured === "number") {
      call.shellId = String(structured);
      return;
    }
    const content = typeof result?.content === "string" ? result.content : "";
    const fromText = /shellId: (\S+?)[ >]/.exec(content)?.[1];
    if (fromText) call.shellId = fromText;
  }
}

function startedMs(task: TaskInfo): number {
  const t = Date.parse(task.startedAt);
  return Number.isFinite(t) ? t : 0;
}

/**
 * 纯函数：给每个 shell 任务找它的 toolCallId，返回 shell 任务 id → toolCallId。规则：
 * 1. previous 里已有、任务还在列表里的对应保留；任务不在了的丢掉。
 * 2. 有调用的 shellId 等于任务 id 的，直接对上。
 * 3. 否则在没被认领、自己没有 shellId、命令文字和任务 command 完全相同、开始时间和任务 startedAt 相差不到 30 秒的调用里取最近的；
 *    最近的两个候选相差不超过 100 毫秒就不对应（两条一样的命令同时启动，分不出谁是谁）。
 * 任务按 startedAt 从早到晚处理；非 shell 任务忽略。一个调用最多对上一个任务。
 */
export function matchShellTasks(
  tasks: readonly TaskInfo[],
  calls: readonly ShellCall[],
  previous: ReadonlyMap<string, string>,
): Map<string, string> {
  const shells = tasks.filter((t) => t.type === "shell").sort((a, b) => startedMs(a) - startedMs(b));
  const matched = new Map<string, string>();
  const claimed = new Set<string>();
  for (const task of shells) {
    const kept = previous.get(task.id);
    if (kept !== undefined && !claimed.has(kept)) {
      matched.set(task.id, kept);
      claimed.add(kept);
    }
  }
  for (const task of shells) {
    if (matched.has(task.id)) continue;
    const free = calls.filter((c) => !claimed.has(c.toolCallId));
    const byId = free.find((c) => c.shellId === task.id);
    if (byId) {
      matched.set(task.id, byId.toolCallId);
      claimed.add(byId.toolCallId);
      continue;
    }
    const command = task.type === "shell" ? task.command : "";
    const started = startedMs(task);
    const near = free
      .filter((c) => c.shellId === null && c.command === command && Math.abs(c.startedAt - started) < MATCH_WINDOW_MS)
      .map((c) => ({ id: c.toolCallId, gap: Math.abs(c.startedAt - started) }))
      .sort((a, b) => a.gap - b.gap);
    const best = near[0];
    if (best && (near.length === 1 || near[1]!.gap - best.gap > AMBIGUOUS_MS)) {
      matched.set(task.id, best.id);
      claimed.add(best.id);
    }
  }
  return matched;
}
