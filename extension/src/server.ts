// 扩展的 unix socket 服务：接受多个界面同时连接，按行收发 JSON 消息（src/protocol.ts）。

import { chmodSync, lstatSync, mkdirSync, renameSync, rmSync } from "node:fs";
import net from "node:net";
import { dirname } from "node:path";
import { LineDecoder, parseUiMessage, PROTOCOL_VERSION, salvageRequestId, serializeMessage } from "../../src/protocol.ts";
import type { ExtensionMessage, RequestMessage, ResultMessage } from "../../src/protocol.ts";
import { describeError } from "./errors.ts";

export interface PanesServerOptions {
  /** socket 路径（extension/src/socketdir.ts 的 chooseSocket）。第一次选不成时给空串，之后用 listen(path) 指定。 */
  path: string;
  /** 新连接建立时要先发的消息，按顺序：hello、最新的 tasks、最新的 usage。 */
  greeting(): ExtensionMessage[];
  /** 新连接收到 greeting 之后调用（不等它做完）。扩展用它在没人连着、任务列表降频时马上查一次新的。 */
  onConnect?(): void;
  /** 处理一条请求，返回要回给这个连接的 result。同一连接上同一个 requestId 只执行一次（重复的直接回上次的结果）。 */
  onRequest(request: RequestMessage): Promise<ResultMessage>;
  /** 出错时调用（记进 ErrorLog）；服务不因单个连接出错而停。 */
  onError(step: string, error: unknown): void;
}

/** 一个连接上记住最近这么多个请求的结果，用来识别重复的 requestId。 */
const REMEMBERED_REQUESTS = 256;
/** 一个连接还有这么多字节没发出去（对方不读），就关掉它，免得扩展的内存一直涨。 */
const MAX_UNSENT_BYTES = 16 * 1024 * 1024;
/** close() 最多等 server.close 的回调这么久。 */
const CLOSE_WAIT_MS = 300;

interface Connection {
  socket: net.Socket;
  decoder: LineDecoder;
  /** requestId → 这条请求的结果（可能还在执行）。 */
  results: Map<string, Promise<ResultMessage>>;
}

function failedResult(requestId: string, reason: string): ResultMessage {
  return { type: "result", v: PROTOCOL_VERSION, requestId, ok: false, reason };
}

export class PanesServer {
  readonly #options: PanesServerOptions;
  readonly #server: net.Server;
  readonly #connections = new Set<Connection>();
  #path: string;
  #listening = false;
  #identity: { dev: number; ino: number } | null = null;
  #closing: Promise<void> | null = null;

  constructor(options: PanesServerOptions) {
    this.#options = options;
    this.#path = options.path;
    this.#server = net.createServer((socket) => this.#accept(socket));
    // 一直挂着：没有 error 监听器时，server 的错误会变成未捕获的异常
    this.#server.on("error", (e) => {
      if (this.#listening) this.#report("server.error", e);
    });
  }

  /**
   * 开始监听：建好 socket 所在目录（0700）；同路径已有文件时先删掉（上次没清理干净的旧 socket）；listen 后把文件权限改成 0600。
   * 收到的字节用 protocol.ts 的 LineDecoder 切行，每行用 parseUiMessage 解析；解析失败时，能读出 requestId（salvageRequestId）
   * 就回一条 ok: false 的 result，reason 写“请求看不懂：<原因>”，读不出就忽略这一行。
   */
  async listen(path: string = this.#path): Promise<void> {
    if (this.#listening) return;
    this.#path = path;
    if (path === "") throw new Error("没有可用的 socket 路径");
    const dir = dirname(path);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // 目录要用 lstat 看（statSync 会跟随符号链接，接着的 chmod 就会改到链接指向的别处）：必须是自己的真目录才用；
    // 别人能在目录里改名、删文件就等于能换掉我们的 socket，所以不是自己的、或者是符号链接的目录一律不用，也不 chmod。
    const st = lstatSync(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`socket 所在的 ${dir} 不是真目录（符号链接或别的东西），不用它`);
    if (typeof process.getuid === "function" && st.uid !== process.getuid()) throw new Error(`socket 所在目录 ${dir} 不属于当前用户`);
    if ((st.mode & 0o022) !== 0) chmodSync(dir, 0o700);
    rmSync(path, { force: true });
    await new Promise<void>((resolve, reject) => {
      const onFailure = (e: Error) => reject(e);
      this.#server.once("error", onFailure);
      let previousMask: number | null = null;
      try {
        previousMask = process.umask(0o177); // socket 文件一创建就是 0600
      } catch {
        // 不能改 umask 时靠下面的 chmod
      }
      try {
        this.#server.listen(path, () => {
          this.#server.off("error", onFailure);
          resolve();
        });
      } catch (e) {
        this.#server.off("error", onFailure);
        reject(e);
      } finally {
        if (previousMask !== null) process.umask(previousMask);
      }
    });
    this.#listening = true;
    try {
      chmodSync(path, 0o600);
      const st = lstatSync(path);
      this.#identity = { dev: st.dev, ino: st.ino };
    } catch (e) {
      this.#report("server.chmod", e);
    }
  }

  /** 发给所有连接。某个连接写不进去（对方断了）时关掉它，不影响别的连接。 */
  broadcast(message: ExtensionMessage): void {
    let line: string;
    try {
      line = serializeMessage(message);
    } catch (e) {
      this.#report("server.broadcast", e);
      return;
    }
    for (const conn of [...this.#connections]) this.#write(conn, line);
  }

  /** 当前连接数。 */
  get connectionCount(): number {
    return this.#connections.size;
  }

  /** 关掉所有连接和服务，删掉 socket 文件。多次调用只做一次。 */
  close(): Promise<void> {
    this.#closing ??= this.#shutdown();
    return this.#closing;
  }

  /** 同步地删掉 socket 文件（只删自己开的那个）。给进程的 exit 事件用：那里不能等异步的 close()。 */
  removeSocketFile(): void {
    try {
      if (this.#ownsPath()) rmSync(this.#path, { force: true });
    } catch (e) {
      this.#report("server.unlink", e);
    }
  }

  #accept(socket: net.Socket): void {
    const conn: Connection = { socket, decoder: new LineDecoder(), results: new Map() };
    this.#connections.add(conn);
    socket.on("error", (e: NodeJS.ErrnoException) => {
      // 对方突然断开是常事，不算出错
      if (e.code !== "ECONNRESET" && e.code !== "EPIPE") this.#report("server.connection", e);
      socket.destroy();
    });
    socket.on("close", () => this.#connections.delete(conn));
    socket.on("data", (chunk: Buffer) => {
      try {
        for (const line of conn.decoder.push(chunk)) this.#handleLine(conn, line);
      } catch (e) {
        this.#report("server.data", e);
      }
    });
    try {
      for (const message of this.#options.greeting()) this.#write(conn, serializeMessage(message));
    } catch (e) {
      this.#report("server.greeting", e);
    }
    try {
      this.#options.onConnect?.();
    } catch (e) {
      this.#report("server.connect", e);
    }
  }

  #handleLine(conn: Connection, line: string): void {
    const parsed = parseUiMessage(line);
    if (!parsed.ok) {
      const requestId = salvageRequestId(line);
      if (requestId !== null) this.#send(conn, failedResult(requestId, `请求看不懂：${parsed.error}`));
      return;
    }
    const request = parsed.value;
    let result = conn.results.get(request.requestId);
    if (!result) {
      result = this.#execute(request);
      conn.results.set(request.requestId, result);
      if (conn.results.size > REMEMBERED_REQUESTS) {
        const oldest = conn.results.keys().next().value;
        if (oldest !== undefined) conn.results.delete(oldest);
      }
    }
    void result.then((r) => this.#send(conn, r));
  }

  /** 执行请求。返回的 Promise 从不拒绝。 */
  async #execute(request: RequestMessage): Promise<ResultMessage> {
    try {
      return await this.#options.onRequest(request);
    } catch (e) {
      this.#report("server.request", e);
      return failedResult(request.requestId, `扩展处理请求出错：${describeError(e, 300)}`);
    }
  }

  #send(conn: Connection, message: ResultMessage): void {
    try {
      this.#write(conn, serializeMessage(message));
    } catch (e) {
      this.#report("server.send", e);
    }
  }

  #write(conn: Connection, line: string): void {
    const { socket } = conn;
    try {
      if (socket.destroyed || !socket.writable) return;
      if (socket.writableLength > MAX_UNSENT_BYTES) {
        socket.destroy();
        return;
      }
      socket.write(line);
    } catch {
      socket.destroy();
    }
  }

  #report(step: string, error: unknown): void {
    try {
      this.#options.onError(step, error);
    } catch {
      // 记录出错本身不能再出错
    }
  }

  #ownsPath(): boolean {
    if (!this.#identity) return false;
    try {
      const st = lstatSync(this.#path);
      return st.dev === this.#identity.dev && st.ino === this.#identity.ino;
    } catch {
      return false;
    }
  }

  async #shutdown(): Promise<void> {
    const path = this.#path;
    for (const conn of this.#connections) conn.socket.destroy();
    this.#connections.clear();
    if (!this.#listening) return;
    // libuv 在关闭 server 时会删掉路径上的文件。同一个 session 的扩展重新加载后，路径上可能已经是新进程开的 socket，
    // 这时先把它挪开，server 关掉后马上放回去，免得新进程的 socket 被删。
    let aside: string | null = null;
    if (this.#identity && !this.#ownsPath()) {
      try {
        lstatSync(path);
        aside = `${path}.${process.pid}.keep`;
        renameSync(path, aside);
      } catch {
        aside = null;
      }
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, CLOSE_WAIT_MS);
      timer.unref();
      try {
        this.#server.close(() => {
          clearTimeout(timer);
          resolve();
        });
      } catch (e) {
        this.#report("server.close", e);
        clearTimeout(timer);
        resolve();
      }
      if (aside !== null) {
        try {
          renameSync(aside, path);
        } catch (e) {
          this.#report("server.restore", e);
        }
      }
    });
    if (aside === null) {
      try {
        if (this.#ownsPath()) rmSync(path, { force: true });
      } catch (e) {
        this.#report("server.unlink", e);
      }
    }
  }
}
