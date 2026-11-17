// 界面这一头的 socket 客户端：连上扩展、收任务列表和用量、发请求并等结果、断了就重连。
// 协议见 src/protocol.ts。

import { createConnection } from "node:net";
import { LineDecoder, PROTOCOL_VERSION, parseExtensionMessage, serializeMessage } from "../protocol.ts";
import type { AgentUsage, ExtensionError, ExtensionMessage, HelloMessage, RequestOp } from "../protocol.ts";
import type { RequestOutcome } from "../types/app.ts";
import type { Clock, Timers } from "../types/clock.ts";
import type { TasksSnapshot } from "../types/model.ts";

/**
 * idle：还没 start；connecting：在连或等着重连；connected：收到了 hello 且 session 对得上；
 * incompatible：协议版本不对或 socket 上是别的 session（不再重连，直到换 socket 路径）；closed：stop() 之后。
 */
export type ConnectionStatus = "idle" | "connecting" | "connected" | "incompatible" | "closed";

export interface BridgeState {
  status: ConnectionStatus;
  hello: HelloMessage | null;
  /** 最近一次的任务列表。断开后保留内容但 connected 变 false（merge.ts 的 isTasksFresh 据此判它不新鲜）。 */
  tasks: TasksSnapshot | null;
  usage: Readonly<Record<string, AgentUsage>> | null;
  /** 最近一条 tasks 消息里扩展报的错。 */
  extensionError: ExtensionError | null;
  /** 给人看的问题说明，如“扩展版本不对：运行 copilot-panes install，再让 Copilot CLI 重新加载扩展”；没问题是 null。 */
  problem: string | null;
  /** 可选。status 是 incompatible 时是哪一类：version 协议版本不对；unsafe 安全检查（socket 路径、属主、权限）没通过；mismatch 对端不是登记记录里的那个 session 或进程。 */
  problemKind?: "version" | "unsafe" | "mismatch";
  /** 可选。problemKind 是 unsafe 或 mismatch 时，一句短的具体原因（不含“不连这个 socket”之类的前缀）。 */
  problemDetail?: string;
  /** 可选。status 最近一次变化的时刻（clock.now()）；还没变过不写。界面据此区分“刚断开”和“一直连不上”。 */
  statusSince?: number;
}

/** socket 的最小接口（net.Socket 满足它）。测试可以用 net.createServer 在临时目录开真 socket，也可以用假对象。 */
export interface SocketLike {
  write(data: string): boolean;
  destroy(): void;
  on(event: "connect" | "close", listener: () => void): unknown;
  on(event: "data", listener: (chunk: Buffer) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
}

export interface ClientOptions {
  /** 登记记录里的 socketPath。 */
  socketPath: string;
  /** 要连的 session；hello 里的 sessionId 不同就是 incompatible。 */
  sessionId: string;
  /**
   * 登记记录（或锁文件）里的 Copilot CLI 进程号。给了就要求 hello 的 copilotPid 和它一样，不一样就不信这个连接（incompatible）：
   * 别的进程能在 socket 路径上监听，报一个进程号 1 就能骗过“Copilot CLI 是目标的祖先”的检查。hello 的进程号小于等于 1 时无论如何都不信。
   */
  expectedCopilotPid?: number | null;
  /** 每次连接前调用：返回原因就不连（incompatible，不再重连）；返回 null 才连。默认不检查。见 src/bridge/socket-safety.ts。 */
  verifySocket?: (path: string) => string | null;
  clock: Clock;
  timers: Timers;
  /** 建连接；默认 net.createConnection(path)。 */
  connect?: (path: string) => SocketLike;
  /** 重连间隔（RECONNECT_MS）。 */
  reconnectMs: number;
  /** 请求超时（REQUEST_TIMEOUT_MS）。 */
  requestTimeoutMs: number;
}

/** 连续连不上时，重连间隔最多放大到 reconnectMs 的这么多倍（1、2、4、4、4……）；连上并收到 hello 后恢复。 */
const MAX_BACKOFF_FACTOR = 4;

const VERSION_PROBLEM = "扩展版本不对：运行 copilot-panes install，再让 Copilot CLI 重新加载扩展";
const OTHER_SESSION_PROBLEM = "这个 socket 属于另一个 session：登记记录和扩展对不上";
const OTHER_SESSION_DETAIL = "socket 属于另一个 session";
const OTHER_PID_PROBLEM = "这个 socket 报的 Copilot CLI 进程号和登记记录对不上，不信这个连接";
const OTHER_PID_DETAIL = "socket 报的进程号和登记记录对不上";

interface PendingRequest {
  resolve: (outcome: RequestOutcome) => void;
  timer: unknown;
}

function defaultConnect(path: string): SocketLike {
  return createConnection(path);
}

/**
 * 客户端。规则：
 * - start() 后连接；连不上或断开后隔 reconnectMs 重连（连续失败时逐次放大，最多 4 倍），直到 stop()。
 * - 收到的字节用 LineDecoder 切行，用 parseExtensionMessage 解析；解析失败的行丢掉，code 为 "version" 时状态变 incompatible。
 * - tasks 消息：tasks 变成 { tasks, shellCalls, receivedAt: clock.now(), connected: true }，extensionError 取消息的 error。
 * - 每次状态有变化就调用 onChange 的监听者（同一轮里多次变化可以合并成一次）。
 * - 断开时：tasks.connected 变 false；还在等结果的请求全部以“和扩展的连接断了”失败。
 * - 收到 hello 之前到的 tasks、usage、result 一律丢掉。
 */
export class ExtensionClient {
  readonly #options: ClientOptions;
  readonly #listeners = new Set<() => void>();
  readonly #pending = new Map<string, PendingRequest>();
  #state: BridgeState = { status: "idle", hello: null, tasks: null, usage: null, extensionError: null, problem: null };
  #socket: SocketLike | null = null;
  #reconnectTimer: unknown = null;
  #failures = 0;
  #notifyQueued = false;

  constructor(options: ClientOptions) {
    this.#options = options;
  }

  start(): void {
    if (this.#state.status !== "idle") return;
    this.#setState({ status: "connecting" });
    this.#connect();
  }

  /** 断开、停止重连，等结果的请求以“已经断开”失败。多次调用只做一次。 */
  stop(): void {
    if (this.#state.status === "closed") return;
    this.#clearReconnectTimer();
    const socket = this.#socket;
    this.#socket = null;
    this.#failPending("已经断开");
    const tasks = this.#state.tasks;
    this.#setState({ status: "closed", tasks: tasks && tasks.connected ? { ...tasks, connected: false } : tasks });
    if (socket) this.#destroy(socket);
  }

  get state(): BridgeState {
    return this.#state;
  }

  /** 注册状态变化的监听者，返回取消的函数。 */
  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /**
   * 发一条请求，等同一个 requestId 的 result。没连上时立刻返回 { ok: false, reason: "扩展没有连上" }；
   * requestTimeoutMs 内没结果返回 { ok: false, reason: "扩展没有回应" }。requestId 由调用方给（界面状态机生成）。
   */
  request(requestId: string, op: RequestOp): Promise<RequestOutcome> {
    const socket = this.#socket;
    if (this.#state.status !== "connected" || !socket) return Promise.resolve({ ok: false, reason: "扩展没有连上" });
    if (this.#pending.has(requestId)) return Promise.resolve({ ok: false, reason: "请求编号重复" });
    return new Promise<RequestOutcome>((resolve) => {
      const timer = this.#options.timers.setTimeout(() => {
        this.#pending.delete(requestId);
        resolve({ ok: false, reason: "扩展没有回应", uncertain: true });
      }, this.#options.requestTimeoutMs);
      this.#pending.set(requestId, { resolve, timer });
      try {
        socket.write(serializeMessage({ type: "request", v: PROTOCOL_VERSION, requestId, ...op }));
      } catch (error) {
        this.#settle(requestId, { ok: false, reason: `发给扩展失败：${error instanceof Error ? error.message : String(error)}` });
      }
    });
  }

  #connect(): void {
    this.#reconnectTimer = null;
    if (this.#state.status !== "connecting") return;
    const unsafe = this.#options.verifySocket?.(this.#options.socketPath) ?? null;
    if (unsafe !== null) {
      this.#clearReconnectTimer();
      const tasks = this.#state.tasks;
      this.#setState({
        status: "incompatible",
        problem: `不连这个 socket：${unsafe}`,
        problemKind: "unsafe",
        problemDetail: unsafe,
        tasks: tasks && tasks.connected ? { ...tasks, connected: false } : tasks,
      });
      return;
    }
    let socket: SocketLike;
    try {
      socket = (this.#options.connect ?? defaultConnect)(this.#options.socketPath);
    } catch {
      this.#scheduleReconnect();
      return;
    }
    this.#socket = socket;
    const decoder = new LineDecoder();
    const isCurrent = () => this.#socket === socket;
    socket.on("data", (chunk) => {
      if (!isCurrent()) return;
      for (const line of decoder.push(chunk)) {
        if (!isCurrent()) return;
        this.#handleLine(socket, line);
      }
    });
    socket.on("error", () => {
      // 出错之后 close 会跟着来；有些假 socket 只发 error，所以这里也收尾。
      if (isCurrent()) this.#handleDisconnect(socket);
    });
    socket.on("close", () => {
      if (isCurrent()) this.#handleDisconnect(socket);
    });
  }

  #handleLine(socket: SocketLike, line: string): void {
    const parsed = parseExtensionMessage(line);
    if (!parsed.ok) {
      if (parsed.code === "version") this.#markIncompatible(socket, VERSION_PROBLEM, "version");
      return;
    }
    this.#handleMessage(socket, parsed.value);
  }

  #handleMessage(socket: SocketLike, message: ExtensionMessage): void {
    if (message.type === "hello") {
      if (message.sessionId !== this.#options.sessionId) {
        this.#markIncompatible(socket, OTHER_SESSION_PROBLEM, "mismatch", OTHER_SESSION_DETAIL);
        return;
      }
      const expected = this.#options.expectedCopilotPid;
      if (message.copilotPid <= 1 || (typeof expected === "number" && message.copilotPid !== expected)) {
        this.#markIncompatible(socket, OTHER_PID_PROBLEM, "mismatch", OTHER_PID_DETAIL);
        return;
      }
      this.#failures = 0;
      this.#setState({ status: "connected", hello: message, problem: null });
      return;
    }
    if (this.#state.status !== "connected") return;
    switch (message.type) {
      case "tasks":
        this.#setState({
          tasks: { tasks: message.tasks, shellCalls: message.shellCalls, receivedAt: this.#options.clock.now(), connected: true },
          extensionError: message.error,
        });
        break;
      case "usage":
        this.#setState({ usage: message.agents });
        break;
      case "result":
        this.#settle(message.requestId, message.ok ? { ok: true } : { ok: false, reason: message.reason, ...(message.uncertain ? { uncertain: true as const } : {}) });
        break;
    }
  }

  #markIncompatible(socket: SocketLike, problem: string, kind: "version" | "mismatch", detail?: string): void {
    this.#socket = null;
    this.#clearReconnectTimer();
    this.#failPending("和扩展的连接断了");
    const tasks = this.#state.tasks;
    this.#setState({
      status: "incompatible",
      problem,
      problemKind: kind,
      ...(detail === undefined ? {} : { problemDetail: detail }),
      tasks: tasks && tasks.connected ? { ...tasks, connected: false } : tasks,
    });
    this.#destroy(socket);
  }

  #handleDisconnect(socket: SocketLike): void {
    this.#socket = null;
    this.#destroy(socket);
    this.#failPending("和扩展的连接断了");
    if (this.#state.status === "closed" || this.#state.status === "incompatible") return;
    const tasks = this.#state.tasks;
    this.#setState({ status: "connecting", tasks: tasks && tasks.connected ? { ...tasks, connected: false } : tasks });
    this.#scheduleReconnect();
  }

  #scheduleReconnect(): void {
    const factor = Math.min(2 ** this.#failures, MAX_BACKOFF_FACTOR);
    this.#failures += 1;
    this.#reconnectTimer = this.#options.timers.setTimeout(() => this.#connect(), this.#options.reconnectMs * factor);
  }

  #clearReconnectTimer(): void {
    if (this.#reconnectTimer !== null) this.#options.timers.clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = null;
  }

  #destroy(socket: SocketLike): void {
    try {
      socket.destroy();
    } catch {
      // 已经关了
    }
  }

  #settle(requestId: string, outcome: RequestOutcome): void {
    const pending = this.#pending.get(requestId);
    if (!pending) return;
    this.#pending.delete(requestId);
    this.#options.timers.clearTimeout(pending.timer);
    pending.resolve(outcome);
  }

  #failPending(reason: string): void {
    for (const requestId of [...this.#pending.keys()]) this.#settle(requestId, { ok: false, reason });
  }

  #setState(patch: Partial<BridgeState>): void {
    const statusChanged = patch.status !== undefined && patch.status !== this.#state.status;
    this.#state = { ...this.#state, ...patch, ...(statusChanged ? { statusSince: this.#options.clock.now() } : {}) };
    if (this.#notifyQueued) return;
    this.#notifyQueued = true;
    queueMicrotask(() => {
      this.#notifyQueued = false;
      for (const listener of [...this.#listeners]) {
        try {
          listener();
        } catch {
          // 监听者出错不能拖垮连接
        }
      }
    });
  }
}
