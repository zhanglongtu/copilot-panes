// 每秒查一次任务列表，决定什么时候推给界面。

import { PROTOCOL_VERSION } from "../../src/protocol.ts";
import type { TaskInfo, TasksMessage } from "../../src/protocol.ts";
import type { Clock } from "../../src/types/clock.ts";
import type { ErrorLog } from "./errors.ts";
import type { TasksRpc } from "./sdk.ts";
import { matchShellTasks } from "./shells.ts";
import type { ShellCallBook } from "./shells.ts";

export interface TaskPublisherOptions {
  rpc: TasksRpc;
  shells: ShellCallBook;
  clock: Clock;
  errors: ErrorLog;
  /** 保活间隔（TASKS_KEEPALIVE_MS）。 */
  keepaliveMs: number;
  /** 文字字段的上限（TASK_TEXT_MAX_CHARS）。 */
  textMaxChars: number;
  /** tasks.list() 这么久没有返回就当作失败，下一轮才能再查；省略时 10 秒。 */
  listTimeoutMs?: number;
}

const DEFAULT_LIST_TIMEOUT_MS = 10_000;
const TEXT_FIELDS = ["prompt", "result", "latestResponse", "error", "description"] as const;

function signature(message: TasksMessage): string {
  return JSON.stringify([message.tasks, message.shellCalls, message.error]);
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} ${Math.round(ms / 1000)} 秒没有返回`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export class TaskPublisher {
  readonly #rpc: TasksRpc;
  readonly #shells: ShellCallBook;
  readonly #clock: Clock;
  readonly #errors: ErrorLog;
  readonly #keepaliveMs: number;
  readonly #textMaxChars: number;
  readonly #listTimeoutMs: number;
  #tasks: TaskInfo[] = [];
  #shellCalls = new Map<string, string>();
  #latest: TasksMessage;
  #sentSignature: string | null = null;
  #sentAt = 0;
  /** 正在进行的一次查询；#run 自己接住所有异常，所以它从不拒绝。 */
  #inflight: Promise<TasksMessage> | null = null;

  constructor(options: TaskPublisherOptions) {
    this.#rpc = options.rpc;
    this.#shells = options.shells;
    this.#clock = options.clock;
    this.#errors = options.errors;
    this.#keepaliveMs = options.keepaliveMs;
    this.#textMaxChars = options.textMaxChars;
    this.#listTimeoutMs = options.listTimeoutMs ?? DEFAULT_LIST_TIMEOUT_MS;
    this.#latest = this.#build();
  }

  /**
   * 调用一次 tasks.list()，用 matchShellTasks 更新 shellCalls，得出最新的 TasksMessage。
   * 返回要推送的消息：内容（tasks、shellCalls、error，不含 at）和上次推送的不同，或距上次推送满 keepaliveMs；否则返回 null。
   * tasks.list() 失败时记进 ErrorLog（step "tasks.list"），沿用上次成功的列表，照样按上面的规则决定推不推（让界面知道扩展还活着）。
   * 上一次调用还没返回时，这次直接返回 null（不叠加调用）；force 为 true 时改成等它返回后再查一次，
   * 并且不管内容变没变都返回消息（界面主动要求刷新）。
   */
  async poll(force: boolean = false): Promise<TasksMessage | null> {
    while (this.#inflight) {
      if (!force) return null;
      await this.#inflight;
    }
    const run = this.#run();
    this.#inflight = run;
    try {
      const message = await run;
      return force || this.#shouldPush(message) ? message : null;
    } finally {
      this.#inflight = null;
    }
  }

  /** 最近一次得出的 TasksMessage，给刚连上的界面用；还没查过时 tasks 是空数组。 */
  latest(): TasksMessage {
    return { ...this.#latest, error: this.#errors.last() };
  }

  /** 推送之后调用，记下推送的时刻和内容，用于下一次比较。 */
  markSent(message: TasksMessage): void {
    this.#sentSignature = signature(message);
    this.#sentAt = this.#clock.now();
  }

  #shouldPush(message: TasksMessage): boolean {
    return this.#sentSignature === null || signature(message) !== this.#sentSignature || this.#clock.now() - this.#sentAt >= this.#keepaliveMs;
  }

  async #run(): Promise<TasksMessage> {
    try {
      const result = await withTimeout(Promise.resolve().then(() => this.#rpc.list()), this.#listTimeoutMs, "tasks.list");
      const list: unknown = result?.tasks;
      if (!Array.isArray(list)) throw new Error("tasks.list 的结果里没有 tasks 数组");
      this.#tasks = list
        .filter((t): t is TaskInfo => typeof t === "object" && t !== null && typeof (t as { type?: unknown }).type === "string")
        .map((t) => trimTask(t, this.#textMaxChars));
      this.#shellCalls = matchShellTasks(this.#tasks, this.#shells.calls(), this.#shellCalls);
    } catch (e) {
      this.#errors.record("tasks.list", e);
    }
    this.#latest = this.#build();
    return this.#latest;
  }

  #build(): TasksMessage {
    return {
      type: "tasks",
      v: PROTOCOL_VERSION,
      at: this.#clock.now(),
      tasks: this.#tasks,
      shellCalls: Object.fromEntries(this.#shellCalls),
      error: this.#errors.last(),
    };
  }
}

function cut(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  let end = maxChars;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1; // 不把一对代理字符从中间切开
  return `${text.slice(0, end)}…`;
}

/**
 * 截短任务里过长的文字字段（prompt、result、latestResponse、error、description），每个最多 maxChars 个字符，超出的截断后加 "…"。
 * 其余字段原样保留，返回新对象，不改原对象。
 */
export function trimTask(task: TaskInfo, maxChars: number): TaskInfo {
  const copy: Record<string, unknown> = { ...task };
  for (const field of TEXT_FIELDS) {
    const value = copy[field];
    if (typeof value === "string") copy[field] = cut(value, maxChars);
  }
  return copy as unknown as TaskInfo;
}
