// 包 1 的测试共用的假东西：假 session、假时钟和定时器、socket 客户端。不是测试文件（不以 .test.ts 结尾），不会被 node --test 当作测试运行。

import net from "node:net";
import { LineDecoder, parseExtensionMessage, PROTOCOL_VERSION, serializeMessage } from "../../src/protocol.ts";
import type { ExtensionMessage, TaskInfo, TaskShellInfo, UiMessage } from "../../src/protocol.ts";
import type { Clock, Timers } from "../../src/types/clock.ts";
import type { PanesSession, SdkEvent, TasksRpc } from "../../extension/src/sdk.ts";

/** 假的时间：同时是 Clock 和 Timers，只在 tick() 时往前走。 */
export class FakeTime implements Clock, Timers {
  #now: number;
  #nextId = 1;
  #timers = new Map<number, { due: number; fn: () => void; every: number | null }>();

  constructor(start: number = 1_700_000_000_000) {
    this.#now = start;
  }

  now(): number {
    return this.#now;
  }

  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.#nextId++;
    this.#timers.set(id, { due: this.#now + ms, fn, every: null });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.#timers.delete(handle as number);
  }

  setInterval(fn: () => void, ms: number): unknown {
    const id = this.#nextId++;
    this.#timers.set(id, { due: this.#now + ms, fn, every: ms });
    return id;
  }

  clearInterval(handle: unknown): void {
    this.#timers.delete(handle as number);
  }

  /** 往前走 ms 毫秒，按到期的先后触发定时器。 */
  tick(ms: number): void {
    const end = this.#now + ms;
    for (;;) {
      let nextId: number | null = null;
      let nextDue = Infinity;
      for (const [id, t] of this.#timers) {
        if (t.due <= end && t.due < nextDue) {
          nextDue = t.due;
          nextId = id;
        }
      }
      if (nextId === null) break;
      const timer = this.#timers.get(nextId)!;
      this.#now = Math.max(this.#now, timer.due);
      if (timer.every === null) this.#timers.delete(nextId);
      else timer.due += timer.every;
      timer.fn();
    }
    this.#now = end;
  }

  get pendingTimers(): number {
    return this.#timers.size;
  }
}

type RpcCall = { method: string; params: unknown };

/** 假的 session：能手动发事件、记录 rpc 调用，rpc 的行为可以按方法替换。 */
export class FakeSession implements PanesSession {
  readonly sessionId: string;
  readonly calls: RpcCall[] = [];
  readonly handlers = new Set<(event: SdkEvent) => void>();
  /** tasks.list() 返回的任务。 */
  tasks: TaskInfo[] = [];
  /** getEvents() 返回的历史事件；置为 null 时 getEvents 抛错，置为函数时由它决定行为。 */
  history: SdkEvent[] | (() => Promise<SdkEvent[]>) | null = [];
  /** 替换某个 rpc 方法的行为；没替换的方法用默认的（成功）。 */
  overrides: Partial<Record<keyof TasksRpc, (params: never) => Promise<unknown>>> = {};
  readonly logs: string[] = [];

  constructor(sessionId: string = "s1") {
    this.sessionId = sessionId;
  }

  readonly rpc: { readonly tasks: TasksRpc } = {
    tasks: {
      list: () => this.#call("list", undefined, async () => ({ tasks: structuredClone(this.tasks) })),
      cancel: (params) => this.#call("cancel", params, async () => ({ cancelled: true })),
      remove: (params) => this.#call("remove", params, async () => ({ removed: true })),
      sendMessage: (params) => this.#call("sendMessage", params, async () => ({ sent: true })),
      promoteToBackground: (params) => this.#call("promoteToBackground", params, async () => ({ promoted: true })),
      readOutput: (params) => this.#call("readOutput", params, async () => ({ text: "", cursor: "c0", exit: { status: "completed" as const } })),
    },
  };

  on(handler: (event: SdkEvent) => void): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  async log(message: string): Promise<void> {
    this.logs.push(message);
  }

  async getEvents(): Promise<SdkEvent[]> {
    if (this.history === null) throw new Error("getEvents is not available");
    return typeof this.history === "function" ? this.history() : structuredClone(this.history);
  }

  /** 把一个事件发给所有订阅的处理函数。 */
  emit(event: SdkEvent): void {
    for (const handler of [...this.handlers]) handler(event);
  }

  /** 某个 rpc 方法被调用过的参数。 */
  callsOf(method: string): unknown[] {
    return this.calls.filter((c) => c.method === method).map((c) => c.params);
  }

  #call<T>(method: keyof TasksRpc, params: unknown, fallback: () => Promise<T>): Promise<T> {
    this.calls.push({ method, params });
    const override = this.overrides[method];
    return (override ? override(params as never) : fallback()) as Promise<T>;
  }
}

// ───── 事件的简写 ─────

let counter = 0;
function stamp(): string {
  counter += 1;
  return new Date(1_700_000_000_000 + counter).toISOString();
}

export function bashStart(toolCallId: string, command: string, args: Record<string, unknown> = {}, extra: Partial<SdkEvent> = {}): SdkEvent {
  return { type: "tool.execution_start", timestamp: stamp(), data: { toolCallId, toolName: "bash", arguments: { command, ...args } }, ...extra };
}

export function shellOutput(toolCallId: string, sequence: number | undefined, text: string, stream?: string): SdkEvent {
  return { type: "tool.shell_output", ephemeral: true, data: { toolCallId, text, ...(sequence === undefined ? {} : { sequence }), ...(stream ? { stream } : {}) } };
}

export function toolComplete(toolCallId: string, data: Record<string, unknown> = {}): SdkEvent {
  return { type: "tool.execution_complete", timestamp: stamp(), data: { toolCallId, success: true, ...data } };
}

export function shellTask(id: string, command: string, startedAt: string, extra: Partial<TaskShellInfo> = {}): TaskShellInfo {
  return { type: "shell", id, description: command, status: "running", startedAt, command, attachmentMode: "attached", ...extra };
}

// ───── socket 客户端 ─────

/** 测试里的界面：连上 socket，收到的消息排成队，可以按顺序取。 */
export class TestClient {
  readonly socket: net.Socket;
  readonly messages: ExtensionMessage[] = [];
  closed = false;
  #waiters: Array<() => void> = [];
  #decoder = new LineDecoder();

  private constructor(socket: net.Socket) {
    this.socket = socket;
    socket.on("data", (chunk: Buffer) => {
      for (const line of this.#decoder.push(chunk)) {
        const parsed = parseExtensionMessage(line);
        if (parsed.ok) this.messages.push(parsed.value);
      }
      this.#wake();
    });
    socket.on("close", () => {
      this.closed = true;
      this.#wake();
    });
    socket.on("error", () => {});
  }

  static connect(path: string): Promise<TestClient> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(path);
      socket.once("error", reject);
      socket.once("connect", () => {
        socket.off("error", reject);
        resolve(new TestClient(socket));
      });
    });
  }

  #wake(): void {
    const waiters = this.#waiters;
    this.#waiters = [];
    for (const w of waiters) w();
  }

  /** 等到有 count 条还没取走的消息，取走并返回；超时抛异常，并写出收到了什么。 */
  async take(count: number = 1, timeoutMs: number = 3000): Promise<ExtensionMessage[]> {
    const deadline = Date.now() + timeoutMs;
    while (this.messages.length < count) {
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`等 ${count} 条消息超时，只收到：${JSON.stringify(this.messages)}`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left);
        this.#waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    return this.messages.splice(0, count);
  }

  /** 等下一条满足条件的消息，不满足的丢掉。 */
  async takeMatching(match: (m: ExtensionMessage) => boolean, timeoutMs: number = 3000): Promise<ExtensionMessage> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const left = deadline - Date.now();
      const [message] = await this.take(1, Math.max(left, 1));
      if (message && match(message)) return message;
    }
  }

  /** 给一小段时间，确认没有收到消息。 */
  async expectQuiet(ms: number = 150): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
    if (this.messages.length > 0) throw new Error(`本该没有消息，却收到：${JSON.stringify(this.messages)}`);
  }

  send(message: UiMessage): void {
    this.socket.write(serializeMessage(message));
  }

  sendRaw(text: string): void {
    this.socket.write(text);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    await new Promise<void>((resolve) => {
      this.socket.once("close", () => resolve());
      this.socket.destroy();
    });
  }
}

export function request(requestId: string, op: "refreshTasks"): UiMessage;
export function request(requestId: string, op: "sendMessage", taskId: string, message: string): UiMessage;
export function request(requestId: string, op: "cancel" | "promoteToBackground" | "remove", taskId: string): UiMessage;
export function request(requestId: string, op: string, taskId?: string, message?: string): UiMessage {
  const base = { type: "request" as const, v: PROTOCOL_VERSION, requestId };
  if (op === "refreshTasks") return { ...base, op };
  if (op === "sendMessage") return { ...base, op, taskId: taskId!, message: message! };
  return { ...base, op: op as "cancel", taskId: taskId! };
}
