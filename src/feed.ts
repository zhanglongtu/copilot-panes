// 一个 session 的全部数据：增量读 events.jsonl 喂给状态库，连扩展，给要看的命令各养一个终端模拟器，合成名单。
// 文件、socket 这些输入输出都放在 SessionIO 接口后面：真实的（openRealSession）读磁盘、连 unix socket，
// 演示的（src/demo-live.ts）用内存里的假数据，两者走同一条路径进入界面。

import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { INTERRUPT_ESCALATE_MS, RECONNECT_MS, REQUEST_TIMEOUT_MS, TERM_SCROLLBACK_LINES } from "./constants.ts";
import { ExtensionClient } from "./bridge/client.ts";
import type { BridgeState } from "./bridge/client.ts";
import { explainReadonly } from "./bridge/readonly.ts";
import type { ReadonlyExplanation } from "./bridge/readonly.ts";
import type { ExtensionEnv } from "./bridge/extension-env.ts";
import { Interrupter, procAccess } from "./bridge/signals.ts";
import { checkSocketSafety } from "./bridge/socket-safety.ts";
import { buildList } from "./model/merge.ts";
import { cleanText, lastNonEmptyLine, readLastLine } from "./model/output.ts";
import { SessionStore } from "./model/store.ts";
import { LineTailer } from "./model/tail.ts";
import type { LineChunk, TextChunk } from "./model/tail.ts";
import { sessionTokens } from "./model/tokens.ts";
import { eventsPath, outPath } from "./paths.ts";
import type { Registration, RequestOp } from "./protocol.ts";
import { TermView } from "./term/terminal.ts";
import type { ExtensionState, RequestOutcome } from "./types/app.ts";
import type { Clock, Timers } from "./types/clock.ts";
import type { EntryKey, ListEntry, StoreView } from "./types/model.ts";
import type { TerminalLines } from "./types/ui.ts";

export interface EventSource {
  read(): LineChunk;
}

export interface OutputSource {
  read(): TextChunk;
}

/** ExtensionClient 的最小接口。演示用假的实现。 */
export interface BridgeLike {
  readonly state: BridgeState;
  onChange(listener: () => void): () => void;
  request(requestId: string, op: RequestOp): Promise<RequestOutcome>;
  stop(): void;
  /** 有没有扩展可连（登记记录存在）。不写当作 true。 */
  readonly loaded?: boolean;
  /** 扩展的启动时刻（登记记录里的 startedAt）；不知道或不写是 null。名单据此把更早开始的子 agent 的 tokens 标成下限。 */
  readonly extensionStartedAt?: number | null;
  /** 这个 session 有效的登记记录；没有（或不写）是 null。只读时据此说清原因。 */
  readonly registration?: Registration | null;
}

/** 一个 session 的输入输出。 */
export interface SessionIO {
  readonly sessionId: string;
  readonly events: EventSource;
  /** 命令的输出文件；文件还不存在时 read() 返回 exists: false。 */
  openOutput(toolCallId: string): OutputSource;
  /** 输出的最后一行非空文字（没有终端模拟器时用）。 */
  lastLine(toolCallId: string): string;
  /** 输出文件的路径（o 键用 less 打开它）；没有输出文件是 null。 */
  outputFile(toolCallId: string): string | null;
  /** 连扩展的客户端；扩展没有加载时是 null。 */
  readonly bridge: BridgeLike | null;
  /** bridge 为 null 时的原因，如“扩展没有加载”。 */
  readonly bridgeNote: string;
  /** 开着这个 session 的 Copilot CLI 进程号（中断命令前核对进程树用）。 */
  copilotPid(): number | null;
  readonly interrupter: Interrupter;
  close(): void;
}

/** 终端模拟器只读命令输出文件的末尾这么多字节；更早的内容用 o 键在 less 里看。 */
export const OUTPUT_TAIL_BYTES = 2 * 1024 * 1024;
const OUTPUT_READ_BYTES = 8 * 1024 * 1024;
const EVENTS_READ_BYTES = 4 * 1024 * 1024;
const LAST_LINE_TTL_MS = 1000;

/**
 * 读命令的 .out：第一次只读最后 OUTPUT_TAIL_BYTES 字节（从第一个换行之后开始，免得从半行或转义序列中间起头），
 * 之后读新增的部分；文件变短或被换掉时报告 reset，从头（同样只读末尾）再来。
 */
export class OutputTail implements OutputSource {
  readonly path: string;
  readonly #tailBytes: number;
  #pos = -1;
  #ino: bigint | null = null;
  #decoder = new StringDecoder("utf8");

  constructor(path: string, tailBytes: number = OUTPUT_TAIL_BYTES) {
    this.path = path;
    this.#tailBytes = tailBytes;
  }

  read(): TextChunk {
    let fd: number;
    try {
      fd = openSync(this.path, "r");
    } catch {
      return { text: "", reset: false, more: false, exists: false };
    }
    try {
      const stat = fstatSync(fd, { bigint: true });
      const size = Number(stat.size);
      let reset = false;
      let skipped = 0;
      if (this.#pos >= 0 && (this.#ino !== stat.ino || size < this.#pos)) {
        this.#pos = -1;
        reset = true;
      }
      this.#ino = stat.ino;
      if (this.#pos < 0) {
        this.#decoder = new StringDecoder("utf8");
        const start = Math.max(0, size - this.#tailBytes);
        this.#pos = start;
        if (start > 0) skipped = this.#skipToLineStart(fd, size);
      }
      if (size === this.#pos) return { text: skipped > 0 ? this.#notice(skipped) : "", reset, more: false, exists: true };
      const want = Math.min(OUTPUT_READ_BYTES, size - this.#pos);
      const buffer = Buffer.allocUnsafe(want);
      let got = 0;
      while (got < want) {
        const n = readSync(fd, buffer, got, want - got, this.#pos + got);
        if (n === 0) break;
        got += n;
      }
      this.#pos += got;
      const text = this.#decoder.write(buffer.subarray(0, got));
      return { text: (skipped > 0 ? this.#notice(skipped) : "") + text, reset, more: this.#pos < size, exists: true };
    } catch {
      return { text: "", reset: false, more: false, exists: true };
    } finally {
      closeSync(fd);
    }
  }

  #notice(skippedBytes: number): string {
    const mb = Math.max(1, Math.round(skippedBytes / (1024 * 1024)));
    return `\x1b[2m… 前面约 ${mb} MB 没有显示，按 o 用 less 看全文\x1b[0m\n`;
  }

  /** 把 #pos 挪到窗口里第一个换行（没有就是第一个回车）之后；返回前面跳过的字节数（含原来没读的部分）。 */
  #skipToLineStart(fd: number, size: number): number {
    const window = Buffer.allocUnsafe(Math.min(size - this.#pos, 64 * 1024));
    const n = readSync(fd, window, 0, window.length, this.#pos);
    let cut = window.subarray(0, n).indexOf(0x0a);
    if (cut < 0) cut = window.subarray(0, n).indexOf(0x0d);
    if (cut < 0) {
      // 没有行边界：至少别从多字节字符的中间起头
      cut = 0;
      while (cut < n && (window[cut]! & 0xc0) === 0x80) cut++;
      this.#pos += cut;
      return this.#pos;
    }
    this.#pos += cut + 1;
    return this.#pos;
  }
}

class CommandTerm {
  readonly id: string;
  readonly term: TermView;
  readonly tail: OutputSource;
  /** .out 文件存在。不存在时（扩展没加载）视图改用事件日志里的输出，不用终端。 */
  hasFile = false;

  constructor(id: string, term: TermView, tail: OutputSource) {
    this.id = id;
    this.term = term;
    this.tail = tail;
  }
}

export interface FeedOptions {
  clock: Clock;
  /** 终端模拟器有新内容或要重画时调用（xterm 的 write 是异步的）。 */
  onChange: () => void;
}

/** 终端模拟器的初始尺寸；真正的尺寸由 syncTerminals 跟着内容区走。 */
const INITIAL_TERM = { cols: 78, rows: 10 };

export class SessionFeed {
  readonly io: SessionIO;
  readonly #clock: Clock;
  readonly #onChange: () => void;
  #store: SessionStore;
  #terms = new Map<string, CommandTerm>();
  #termSize = { ...INITIAL_TERM };
  #lastLines = new Map<string, { at: number; line: string }>();
  #more = false;
  #caughtUp = false;
  #closed = false;
  /** 事件文件被换掉的次数；调用方据此知道名单要重算。 */
  resets = 0;

  constructor(io: SessionIO, options: FeedOptions) {
    this.io = io;
    this.#clock = options.clock;
    this.#onChange = options.onChange;
    this.#store = new SessionStore(io.sessionId);
    io.bridge?.onChange(() => {
      if (!this.#closed) this.#onChange();
    });
  }

  get store(): StoreView {
    return this.#store;
  }

  /** 事件文件已经读到头过一次。第一次加载是分块读的，没读完之前名单里的状态是半截的，调用方不要拿它当“变化”。 */
  get caughtUp(): boolean {
    return this.#caughtUp;
  }

  /** 事件文件还有没读完的内容：调用方应马上再 poll。 */
  get more(): boolean {
    return this.#more;
  }

  /** 读事件和命令输出，返回有没有变化。每次读事件最多占用 budgetMs 毫秒，剩下的留给下一次。 */
  poll(budgetMs = 25): boolean {
    if (this.#closed) return false;
    let changed = this.#pollEvents(budgetMs);
    if (this.#pollOutputs()) changed = true;
    return changed;
  }

  #pollEvents(budgetMs: number): boolean {
    let changed = false;
    const deadline = performance.now() + budgetMs;
    for (;;) {
      const chunk = this.io.events.read();
      if (chunk.reset) {
        this.#store = new SessionStore(this.io.sessionId);
        this.#lastLines.clear();
        this.#caughtUp = false;
        this.resets++;
        changed = true;
      }
      for (const line of chunk.lines) if (this.#store.feedLine(line)) changed = true;
      this.#more = chunk.more;
      if (!chunk.more) this.#caughtUp = true;
      if (!chunk.more || performance.now() >= deadline) break;
    }
    return changed;
  }

  #pollOutputs(): boolean {
    let changed = false;
    for (const entry of this.#terms.values()) {
      const chunk = entry.tail.read();
      if (chunk.more) this.#more = true;
      if (chunk.exists !== entry.hasFile) {
        entry.hasFile = chunk.exists;
        changed = true;
      }
      if (chunk.reset) {
        entry.term.reset();
        changed = true;
      }
      if (chunk.text !== "") {
        entry.term.write(chunk.text).then(this.#onChange, () => {});
        changed = true;
      }
    }
    return changed;
  }

  /** 让终端模拟器和 wanted（选中的和在跑的命令的 toolCallId）一致，尺寸跟着内容区。新建的从文件末尾读起，不要的释放。 */
  syncTerminals(wanted: ReadonlySet<string>, cols: number, rows: number): void {
    if (this.#closed) return;
    const size = { cols: Math.max(2, cols), rows: Math.max(1, rows) };
    const resized = size.cols !== this.#termSize.cols || size.rows !== this.#termSize.rows;
    this.#termSize = size;
    for (const [id, entry] of this.#terms) {
      if (!wanted.has(id)) {
        entry.term.dispose();
        this.#terms.delete(id);
      } else if (resized) {
        entry.term.resize(size.cols, size.rows);
      }
    }
    let created = false;
    for (const id of wanted) {
      if (this.#terms.has(id)) continue;
      const term = new TermView({ cols: size.cols, rows: size.rows, scrollback: TERM_SCROLLBACK_LINES });
      this.#terms.set(id, new CommandTerm(id, term, this.io.openOutput(id)));
      created = true;
    }
    if (created) this.#pollOutputs();
  }


  /** 命令的终端；没有 .out 文件（或还没给这条命令建终端）时是 null，视图改用事件日志里的输出。 */
  terminalOf(toolCallId: string): TerminalLines | null {
    const entry = this.#terms.get(toolCallId);
    return entry?.hasFile ? entry.term : null;
  }

  /** 命令的全文（纯文字）：终端里的；没有 .out 文件时是事件日志里的输出（清理过）。 */
  plainTextOf(toolCallId: string): string {
    const entry = this.#terms.get(toolCallId);
    if (entry?.hasFile) return entry.term.plainText();
    return cleanText(this.#store.command(toolCallId)?.eventOutput ?? "").trimEnd();
  }

  /** 命令输出的最后一行：有终端模拟器就取它看到的最后一行，否则每秒读一次文件末尾（没有文件时用事件里的输出）。 */
  lastOutputLine(toolCallId: string, now: number): string {
    const fromTerm = this.#terms.get(toolCallId)?.term.lastNonEmptyLine();
    if (fromTerm) return fromTerm;
    const cached = this.#lastLines.get(toolCallId);
    if (cached && now - cached.at < LAST_LINE_TTL_MS) return cached.line;
    let line = this.io.lastLine(toolCallId);
    if (line === "") {
      const text = this.#store.command(toolCallId)?.eventOutput ?? "";
      if (text !== "") line = lastNonEmptyLine(cleanText(text));
    }
    this.#lastLines.set(toolCallId, { at: now, line });
    return line;
  }

  entries(now: number, collapseEnded: boolean, keep: ReadonlySet<EntryKey>): ListEntry[] {
    const bridge = this.io.bridge?.state;
    return buildList({
      store: this.#store,
      tasks: bridge?.tasks ?? null,
      usage: bridge?.usage ?? null,
      now,
      collapseEnded,
      keep,
      lastOutputLine: (toolCallId) => this.lastOutputLine(toolCallId, now),
      ...(this.io.bridge?.extensionStartedAt != null ? { usageSince: this.io.bridge.extensionStartedAt } : {}),
    });
  }

  totalTokens(): number | null {
    return sessionTokens(this.#store, this.io.bridge?.state.usage ?? null);
  }

  /** 为什么只读；扩展连着（不是只读）是 null。env 是扩展装了没有、实验功能开了没有（bridge/extension-env.ts）。 */
  explainReadonly(env: ExtensionEnv, now: number): ReadonlyExplanation | null {
    const bridge = this.io.bridge;
    const registration = bridge?.registration ?? null;
    return explainReadonly({
      registered: registration !== null,
      noSocket: registration !== null && registration.socketPath === null,
      bridge: bridge && bridge.loaded !== false ? bridge.state : null,
      env,
      now,
    });
  }

  extensionState(env: ExtensionEnv, now: number): ExtensionState {
    const why = this.explainReadonly(env, now);
    return why === null ? { kind: "connected" } : { kind: "readonly", reason: why.reason, cause: why.cause };
  }

  request(requestId: string, op: RequestOp): Promise<RequestOutcome> {
    const bridge = this.io.bridge;
    if (!bridge || bridge.loaded === false) return Promise.resolve({ ok: false, reason: `只读：${this.io.bridgeNote}` });
    return bridge.request(requestId, op);
  }

  clockNow(): number {
    return this.#clock.now();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const entry of this.#terms.values()) entry.term.dispose();
    this.#terms.clear();
    this.io.close();
  }
}

export interface RealSessionOptions {
  sessionId: string;
  stateDir: string;
  dataDir: string;
  /** 候选 session 里知道的 Copilot CLI 进程号（登记记录和 hello 都没有时用）。 */
  copilotPid: number | null;
  clock: Clock;
  timers: Timers;
}

const NO_BRIDGE_STATE: BridgeState = { status: "idle", hello: null, tasks: null, usage: null, extensionError: null, problem: null };

/** 随登记记录换目标的客户端：扩展晚于界面加载、或者重装后 socket 换了路径时，不用重建整个 session。 */
export class BridgeSwitch implements BridgeLike {
  readonly #options: Omit<RealSessionOptions, "stateDir" | "dataDir" | "copilotPid">;
  readonly #listeners = new Set<() => void>();
  #client: ExtensionClient | null = null;
  #unsubscribe: (() => void) | null = null;
  #socketPath: string | null = null;
  registration: Registration | null = null;

  constructor(options: Omit<RealSessionOptions, "stateDir" | "dataDir" | "copilotPid">) {
    this.#options = options;
  }

  get loaded(): boolean {
    return this.#client !== null;
  }

  get extensionStartedAt(): number | null {
    return this.registration?.startedAt ?? null;
  }

  get state(): BridgeState {
    return this.#client?.state ?? NO_BRIDGE_STATE;
  }

  /**
   * 登记记录里的 socket 路径或 Copilot CLI 进程号变了（或第一次出现）就换一个新客户端；没有登记记录时保持原样。
   * 进程号也要看：同一个 session 在新的 Copilot CLI 进程里恢复时 socket 路径不变，但 hello 里的进程号变了，旧客户端会不信它。
   */
  target(registration: Registration | null): void {
    if (registration === null) return;
    const unchanged = registration.socketPath === this.#socketPath && registration.copilotPid === this.registration?.copilotPid;
    this.registration = registration;
    if (unchanged) return;
    this.#unsubscribe?.();
    this.#client?.stop();
    this.#socketPath = registration.socketPath;
    // 扩展没能开成 socket（登记记录里是 null）：没有可连的，界面只读；扩展开成后会重写登记记录
    if (registration.socketPath === null) {
      this.#client = null;
      this.#unsubscribe = null;
      this.#notify();
      return;
    }
    const client = new ExtensionClient({
      socketPath: registration.socketPath,
      sessionId: this.#options.sessionId,
      expectedCopilotPid: registration.copilotPid,
      verifySocket: checkSocketSafety,
      clock: this.#options.clock,
      timers: this.#options.timers,
      reconnectMs: RECONNECT_MS,
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
    });
    this.#client = client;
    this.#unsubscribe = client.onChange(() => this.#notify());
    client.start();
    this.#notify();
  }

  #notify(): void {
    for (const listener of [...this.#listeners]) listener();
  }

  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  request(requestId: string, op: RequestOp): Promise<RequestOutcome> {
    return this.#client ? this.#client.request(requestId, op) : Promise.resolve({ ok: false, reason: "扩展没有加载" });
  }

  stop(): void {
    this.#unsubscribe?.();
    this.#client?.stop();
    this.#client = null;
  }
}

/** 真实 session 的输入输出：读 session-state 和数据目录里的文件，连登记记录里的 socket。 */
export class RealSession implements SessionIO {
  readonly sessionId: string;
  readonly events: EventSource;
  readonly bridge: BridgeSwitch;
  get bridgeNote(): string {
    return this.bridge.registration?.socketPath === null ? "扩展没能开成 socket，正在重试" : "扩展没有加载";
  }
  readonly interrupter: Interrupter;
  readonly #options: RealSessionOptions;

  constructor(options: RealSessionOptions) {
    this.#options = options;
    this.sessionId = options.sessionId;
    this.events = new LineTailer(eventsPath(options.stateDir, options.sessionId), { maxBytesPerRead: EVENTS_READ_BYTES });
    this.bridge = new BridgeSwitch(options);
    this.interrupter = new Interrupter(procAccess(), options.clock, INTERRUPT_ESCALATE_MS);
  }

  openOutput(toolCallId: string): OutputSource {
    return new OutputTail(outPath(this.#options.dataDir, this.sessionId, toolCallId));
  }

  lastLine(toolCallId: string): string {
    return readLastLine(outPath(this.#options.dataDir, this.sessionId, toolCallId));
  }

  outputFile(toolCallId: string): string | null {
    return outPath(this.#options.dataDir, this.sessionId, toolCallId);
  }

  copilotPid(): number | null {
    // 不用 hello 里的进程号：那是 socket 对端自己报的，对端可能是别的进程。登记记录的进程号才是核对过的（BridgeSwitch 要求 hello 与它一致）。
    return this.bridge.registration?.copilotPid ?? this.#options.copilotPid;
  }

  close(): void {
    this.bridge.stop();
  }
}
