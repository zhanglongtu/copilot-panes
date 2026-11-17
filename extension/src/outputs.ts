// 把命令的原始输出存成文件：<dataDir>/out/<session ID>/<toolCallId>.out。
// tool.shell_output 不写进 events.jsonl、晚订阅收不到，所以扩展从启动起就要存。每个命令的输出文件最多存 32 MiB。

import { appendFileSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { safeName } from "../../src/paths.ts";
import { realTimers } from "../../src/types/clock.ts";
import type { Clock, Timers } from "../../src/types/clock.ts";
import type { ErrorLog } from "./errors.ts";
import type { SdkEvent, TasksRpc } from "./sdk.ts";

export interface OutputRecorderOptions {
  /** 这个 session 的输出目录（src/paths.ts 的 outDir）。不存在时第一次写入前建好（0700）。 */
  dir: string;
  /** 单个文件的上限（OUT_FILE_MAX_BYTES）。 */
  maxBytes: number;
  clock: Clock;
  errors: ErrorLog;
  /** detach 命令抄输出时每次等多久（DETACHED_READ_WAIT_MS）；测试可以调小。 */
  detachedWaitMs: number;
  /** 等乱序的输出补齐、抄输出失败后重试用的定时器；省略时用真的。 */
  timers?: Timers;
  /** tool.shell_output 的 sequence 出现空缺时，最多等这么久（毫秒）再把后面已到的输出按顺序写进去；省略时 500。 */
  gapWaitMs?: number;
  /** 抄 detach 命令的输出失败后，等这么久再试（毫秒）；省略时 1000。 */
  retryMs?: number;
}

/** 超过上限时在文件末尾写的一行（只写一次），之后这个文件不再追加。 */
export const OUTPUT_CAP_NOTE = "\n[copilot-panes: 输出超过 32 MiB，后面的内容没有写入]\n";

/** 最多同时记着这么多个命令的状态，超出时丢最早的。 */
const MAX_TRACKED_CALLS = 2000;
/** 一个命令等着补空缺的乱序输出最多攒这么多段，再多就不等了。 */
const MAX_PENDING_CHUNKS = 256;
const DEFAULT_GAP_WAIT_MS = 500;
const DEFAULT_RETRY_MS = 1000;
/** 抄 detach 命令的输出连续失败这么多次就放弃。 */
const MAX_PUMP_FAILURES = 3;

interface CallState {
  command: string;
  detach: boolean;
  /** 已经写进文件的字节数；还没从磁盘读过时是 null。 */
  size: number | null;
  capped: boolean;
  /** 收到过这个命令的 tool.shell_output。 */
  got: boolean;
  /** 下一个该写的 sequence；还没收到过带 sequence 的输出时是 null。 */
  nextSequence: number | null;
  /** 比 nextSequence 早到的输出：sequence → 文字。 */
  pending: Map<number, string>;
  gapTimer: unknown;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/**
 * 命令输出的记录器。每个方法都不抛异常：出错记进 ErrorLog（step 写 "output.append" 之类），接着工作。
 * 文件权限 0600。文本原样写入（保留颜色码、回车符），按事件到达的顺序追加；
 * tool.shell_output 带 sequence，所以乱序到达的按 sequence 排好再写，重复的丢掉。
 */
export class OutputRecorder {
  readonly #dir: string;
  readonly #maxBytes: number;
  readonly #clock: Clock;
  readonly #errors: ErrorLog;
  readonly #detachedWaitMs: number;
  readonly #timers: Timers;
  readonly #gapWaitMs: number;
  readonly #retryMs: number;
  readonly #calls = new Map<string, CallState>();
  /** 已经在抄输出的 detach shell 的 shellId。 */
  readonly #pumping = new Set<string>();
  readonly #sleepers = new Set<() => void>();
  #stopped = false;

  constructor(options: OutputRecorderOptions) {
    this.#dir = options.dir;
    this.#maxBytes = options.maxBytes;
    this.#clock = options.clock;
    this.#errors = options.errors;
    this.#detachedWaitMs = options.detachedWaitMs;
    this.#timers = options.timers ?? realTimers;
    this.#gapWaitMs = options.gapWaitMs ?? DEFAULT_GAP_WAIT_MS;
    this.#retryMs = options.retryMs ?? DEFAULT_RETRY_MS;
  }

  /**
   * 收到一个事件时调用，按 type 分发：
   * - tool.execution_start 且 toolName 为 bash：立刻建空的 .out（命令一开始界面就知道“有输出文件”）；记下 command 和
   *   arguments.detach === true。powershell 等别的 shell 工具不建空文件，等第一段输出。
   * - tool.shell_output：data.toolCallId 和 data.text 都是字符串时追加 text（stdout、stderr、terminal 三种 stream 一样处理）。
   * - tool.execution_complete：见 onToolComplete。
   * 其余类型忽略。data 字段缺失或类型不对时忽略这个事件。
   */
  onEvent(event: SdkEvent, rpc: TasksRpc): void {
    if (this.#stopped) return;
    try {
      const data = record(event.data);
      if (!data) return;
      switch (event.type) {
        case "tool.execution_start":
          this.#onStart(data);
          break;
        case "tool.shell_output":
          this.#onShellOutput(data);
          break;
        case "tool.execution_complete":
          this.onToolComplete(data, rpc);
          break;
      }
    } catch (e) {
      this.#errors.record("output.event", e);
    }
  }

  /**
   * 命令的完成事件：
   * - 一直没收到 tool.shell_output、有 shellExecution、内容不是 "<command started in…" 时，把 result.content 去掉末尾的
   *   "<shellId: … completed with exit code N>" 标记后写进去（命令太快，输出只在完成事件里）。
   * - detach 命令：从 result.content 的 "with shellId: X>" 取 shellId，取不到就在 tasks.list() 里按命令文字找还没被认领的
   *   detached shell 任务（取 startedAt 最晚的），然后在后台调用 pumpDetached。返回的 Promise 不等抄完。
   */
  onToolComplete(data: unknown, rpc: TasksRpc): void {
    try {
      const fields = record(data);
      const toolCallId = fields?.toolCallId;
      if (!fields || typeof toolCallId !== "string") return;
      const call = this.#calls.get(toolCallId);
      if (!call) return;
      this.#flushPending(toolCallId, call);
      const result = record(fields.result);
      const content = typeof result?.content === "string" ? result.content : "";
      if (call.detach) {
        if (fields.success === false) return;
        const structured = record(result?.structuredContent)?.shellId;
        const shellId = typeof structured === "string" && structured !== "" ? structured : /with shellId: (\S+?)>/.exec(content)?.[1];
        this.#startPump(rpc, toolCallId, call.command, shellId);
        return;
      }
      if (!call.got && record(fields.shellExecution) && !content.startsWith("<command started in")) {
        const output = content.replace(/\n?<shellId: [^>]*>\s*$/, "");
        if (output !== "") this.append(toolCallId, output);
      }
    } catch (e) {
      this.#errors.record("output.complete", e);
    }
  }

  /** 追加一段文字。累计字节数超过上限时，写 OUTPUT_CAP_NOTE 一次，之后丢弃；目录不在时重建再写。 */
  append(toolCallId: string, text: string): void {
    if (text === "") return;
    try {
      const call = this.#state(toolCallId);
      if (call.capped) return;
      const size = this.#sizeOf(toolCallId, call);
      const bytes = Buffer.byteLength(text, "utf8");
      let data = text;
      if (size + bytes > this.#maxBytes) {
        const buf = Buffer.from(text, "utf8");
        let end = Math.min(Math.max(0, this.#maxBytes - size), buf.length);
        while (end > 0 && end < buf.length && (buf[end]! & 0xc0) === 0x80) end -= 1; // 不把一个多字节字符切开
        data = buf.subarray(0, end).toString("utf8") + OUTPUT_CAP_NOTE;
        call.capped = true;
      }
      this.#write(toolCallId, data);
      call.size = size + Buffer.byteLength(data, "utf8");
    } catch (e) {
      this.#errors.record("output.append", e);
    }
  }

  /**
   * detach 命令没有 tool.shell_output：循环调用 tasks.readOutput({ id: shellId, cursor, waitMs }) 把增量抄进 .out，
   * 直到返回 exit；连续失败 3 次就记错并放弃。stop() 之后立刻停。skipBytes 是 .out 里已有的字节数（见 resumeDetached），
   * 从头读到的文字先丢掉这么多字节。
   */
  async pumpDetached(rpc: TasksRpc, toolCallId: string, shellId: string, skipBytes: number = 0): Promise<void> {
    let cursor: string | undefined;
    let failures = 0;
    let lastError: unknown;
    let skip = skipBytes;
    while (!this.#stopped && failures < MAX_PUMP_FAILURES) {
      const startedAt = this.#clock.now();
      try {
        const chunk = await rpc.readOutput({ id: shellId, cursor, waitMs: this.#detachedWaitMs });
        failures = 0;
        if (typeof chunk?.cursor === "string") cursor = chunk.cursor;
        let text = typeof chunk?.text === "string" ? chunk.text : "";
        if (skip > 0) {
          // 从头读，前 skip 个字节已经在 .out 里了（扩展重新加载前抄过）
          const bytes = Buffer.from(text, "utf8");
          text = bytes.length > skip ? bytes.subarray(skip).toString("utf8") : "";
          skip = Math.max(0, skip - bytes.length);
        }
        this.append(toolCallId, text);
        if (chunk?.exit) return;
        // readOutput 没有等够 waitMs 就空手返回时歇一会儿，免得空转
        if (text === "" && this.#clock.now() - startedAt < 200) await this.#sleep(this.#retryMs / 2);
      } catch (e) {
        lastError = e;
        failures += 1;
        await this.#sleep(this.#retryMs);
      }
    }
    if (!this.#stopped) this.#errors.record("detached.output", lastError);
  }

  /**
   * 扩展重新加载时，上一个进程正在抄的 detach 命令还没结束：接着抄。tasks.readOutput 不带 cursor 就从头给，
   * 所以跳过 .out 里已有的字节数，只追加后面的。同一个 shell 已经在抄时什么都不做。
   */
  resumeDetached(rpc: TasksRpc, toolCallId: string, shellId: string): void {
    if (this.#stopped || this.#pumping.has(shellId)) return;
    this.#pumping.add(shellId);
    const size = this.#sizeOf(toolCallId, this.#state(toolCallId));
    this.pumpDetached(rpc, toolCallId, shellId, size).catch((e: unknown) => this.#errors.record("detached.output", e));
  }

  /** 停下所有 pumpDetached 循环，并把还在等空缺的输出写进文件。 */
  stop(): void {
    if (this.#stopped) return;
    for (const [toolCallId, call] of this.#calls) this.#flushPending(toolCallId, call);
    this.#stopped = true;
    for (const wake of [...this.#sleepers]) wake();
  }

  #onStart(data: Record<string, unknown>): void {
    const toolCallId = data.toolCallId;
    if (data.toolName !== "bash" || typeof toolCallId !== "string" || toolCallId === "") return;
    const args = record(data.arguments);
    const call = this.#state(toolCallId);
    call.command = typeof args?.command === "string" ? args.command : "";
    call.detach = args?.detach === true;
    try {
      this.#write(toolCallId, "");
    } catch (e) {
      this.#errors.record("output.create", e);
    }
  }

  #onShellOutput(data: Record<string, unknown>): void {
    const { toolCallId, text, sequence } = data;
    if (typeof toolCallId !== "string" || toolCallId === "" || typeof text !== "string") return;
    const call = this.#state(toolCallId);
    call.got = true;
    if (typeof sequence !== "number" || !Number.isSafeInteger(sequence) || sequence < 0) {
      this.append(toolCallId, text);
      return;
    }
    if (call.nextSequence !== null && sequence < call.nextSequence) return; // 重复的，或者已经越过的空缺里迟到的
    if (call.pending.has(sequence)) return;
    if (sequence === (call.nextSequence ?? 0)) {
      this.append(toolCallId, text);
      call.nextSequence = sequence + 1;
      this.#drain(toolCallId, call);
      return;
    }
    call.pending.set(sequence, text);
    if (call.pending.size > MAX_PENDING_CHUNKS) this.#flushPending(toolCallId, call);
    else this.#armGapTimer(toolCallId, call);
  }

  /** 把紧接在 nextSequence 后面、已经到了的输出依次写进去。 */
  #drain(toolCallId: string, call: CallState): void {
    while (call.nextSequence !== null) {
      const text = call.pending.get(call.nextSequence);
      if (text === undefined) break;
      call.pending.delete(call.nextSequence);
      call.nextSequence += 1;
      this.append(toolCallId, text);
    }
    if (call.pending.size === 0) this.#clearGapTimer(call);
  }

  /** 不再等空缺：已经到了的输出按 sequence 从小到大写进去。 */
  #flushPending(toolCallId: string, call: CallState): void {
    this.#clearGapTimer(call);
    if (call.pending.size === 0) return;
    const sequences = [...call.pending.keys()].sort((a, b) => a - b);
    for (const sequence of sequences) {
      this.append(toolCallId, call.pending.get(sequence) ?? "");
      call.nextSequence = sequence + 1;
    }
    call.pending.clear();
  }

  #armGapTimer(toolCallId: string, call: CallState): void {
    if (call.gapTimer !== null) return;
    call.gapTimer = this.#timers.setTimeout(() => {
      call.gapTimer = null;
      try {
        this.#flushPending(toolCallId, call);
      } catch (e) {
        this.#errors.record("output.gap", e);
      }
    }, this.#gapWaitMs);
  }

  #clearGapTimer(call: CallState): void {
    if (call.gapTimer === null) return;
    this.#timers.clearTimeout(call.gapTimer);
    call.gapTimer = null;
  }

  #startPump(rpc: TasksRpc, toolCallId: string, command: string, shellId: string | undefined): void {
    void (async () => {
      const id = shellId ?? (await this.#findDetachedShell(rpc, command));
      if (id === undefined || this.#pumping.has(id)) return;
      this.#pumping.add(id);
      await this.pumpDetached(rpc, toolCallId, id);
    })().catch((e: unknown) => this.#errors.record("detached.output", e));
  }

  /** 完成事件里没有 shellId 时，在任务列表里找命令文字相同、还没被认领的 detached shell，取最晚启动的。 */
  async #findDetachedShell(rpc: TasksRpc, command: string): Promise<string | undefined> {
    const { tasks } = await rpc.list();
    const hits = tasks.filter(
      (t) => t.type === "shell" && t.attachmentMode === "detached" && t.command === command && !this.#pumping.has(t.id),
    );
    hits.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
    return hits[0]?.id;
  }

  #sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const wake = () => {
        this.#sleepers.delete(wake);
        this.#timers.clearTimeout(handle);
        resolve();
      };
      const handle = this.#timers.setTimeout(wake, ms);
      this.#sleepers.add(wake);
    });
  }

  #state(toolCallId: string): CallState {
    let call = this.#calls.get(toolCallId);
    if (!call) {
      call = { command: "", detach: false, size: null, capped: false, got: false, nextSequence: null, pending: new Map(), gapTimer: null };
      this.#calls.set(toolCallId, call);
      if (this.#calls.size > MAX_TRACKED_CALLS) {
        const oldest = this.#calls.keys().next().value;
        const dropped = oldest === undefined ? undefined : this.#calls.get(oldest);
        if (oldest !== undefined && dropped) {
          this.#flushPending(oldest, dropped);
          this.#calls.delete(oldest);
        }
      }
    }
    return call;
  }

  #sizeOf(toolCallId: string, call: CallState): number {
    if (call.size === null) {
      try {
        call.size = statSync(this.#file(toolCallId)).size;
      } catch {
        call.size = 0;
      }
    }
    return call.size;
  }

  #file(toolCallId: string): string {
    return join(this.#dir, `${safeName(toolCallId)}.out`);
  }

  #write(toolCallId: string, data: string): void {
    const file = this.#file(toolCallId);
    try {
      appendFileSync(file, data, { mode: 0o600 });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      mkdirSync(this.#dir, { recursive: true, mode: 0o700 });
      appendFileSync(file, data, { mode: 0o600 });
    }
  }
}
