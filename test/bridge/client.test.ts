import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer } from "node:net";
import type { Server, Socket } from "node:net";
import { join } from "node:path";
import { ExtensionClient } from "../../src/bridge/client.ts";
import type { ClientOptions, SocketLike } from "../../src/bridge/client.ts";
import { PROTOCOL_VERSION } from "../../src/protocol.ts";
import type { RequestMessage } from "../../src/protocol.ts";
import type { Timers } from "../../src/types/clock.ts";
import { realTimers } from "../../src/types/clock.ts";
import { tempDir } from "../helpers/tmp.ts";

const SESSION = "s1";
const v = PROTOCOL_VERSION;

const hello = (sessionId = SESSION) => ({ type: "hello", v, sessionId, copilotPid: 100, extensionPid: 101, extensionVersion: "0.0.0" });
const tasksMessage = (id: string) => ({
  type: "tasks",
  v,
  at: 5,
  tasks: [{ type: "shell", id, description: "d", status: "running", startedAt: "2026-01-01T00:00:00Z", command: "sleep 1", attachmentMode: "detached", pid: 4242 }],
  shellCalls: { [id]: "call-1" },
  error: { step: "tasks.list", message: "boom", at: 9 },
});
const usageMessage = { type: "usage", v, at: 6, agents: { a1: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, calls: 2 } } };

const line = (message: unknown): string => JSON.stringify(message) + "\n";

async function waitFor(condition: () => boolean, what: string, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** 假扩展：在临时目录里开真的 unix socket，记下收到的行，让测试决定发什么。 */
class FakeExtension {
  readonly connections: Socket[] = [];
  readonly requests: RequestMessage[] = [];
  #server: Server | null = null;
  /** 新连接建立时自动发的消息；null 表示什么都不发。 */
  onConnect: ((socket: Socket) => void) | null = (socket) => socket.write(line(hello()));
  onRequest: ((socket: Socket, request: RequestMessage) => void) | null = null;

  readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  async listen(): Promise<void> {
    const server = createServer((socket) => {
      this.connections.push(socket);
      let buffered = "";
      socket.on("data", (chunk) => {
        buffered += chunk.toString("utf8");
        let nl: number;
        while ((nl = buffered.indexOf("\n")) !== -1) {
          const text = buffered.slice(0, nl);
          buffered = buffered.slice(nl + 1);
          const request = JSON.parse(text) as RequestMessage;
          this.requests.push(request);
          this.onRequest?.(socket, request);
        }
      });
      socket.on("error", () => {});
      this.onConnect?.(socket);
    });
    this.#server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.path, resolve);
    });
  }

  /** 关掉服务端和所有连接，模拟扩展退出。 */
  async close(): Promise<void> {
    const server = this.#server;
    this.#server = null;
    for (const socket of this.connections) socket.destroy();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  send(message: unknown): void {
    for (const socket of this.connections) if (!socket.destroyed) socket.write(line(message));
  }
}

function setup(prefix = "c", overrides: Partial<ClientOptions> = {}) {
  const dir = tempDir(prefix);
  const extension = new FakeExtension(join(dir.path, "x.sock"));
  const client = new ExtensionClient({
    socketPath: extension.path,
    sessionId: SESSION,
    clock: { now: () => 1234 },
    timers: realTimers,
    reconnectMs: 20,
    requestTimeoutMs: 200,
    ...overrides,
  });
  const cleanup = async () => {
    client.stop();
    await extension.close();
    dir.cleanup();
  };
  return { dir, extension, client, cleanup };
}

test("with a real unix socket in a temp dir the client receives hello, tasks and usage and reports connected", async () => {
  const { extension, client, cleanup } = setup();
  try {
    extension.onConnect = (socket) => {
      socket.write(line(hello()));
      socket.write(line(tasksMessage("sh1")));
      socket.write(line(usageMessage));
    };
    await extension.listen();
    assert.equal(client.state.status, "idle");
    let changes = 0;
    client.onChange(() => changes++);
    client.start();
    assert.equal(client.state.status, "connecting");
    await waitFor(() => client.state.usage !== null, "usage");
    const { state } = client;
    assert.equal(state.status, "connected");
    assert.equal(state.hello?.copilotPid, 100);
    assert.equal(state.problem, null);
    assert.equal(state.tasks?.connected, true);
    assert.equal(state.tasks?.receivedAt, 1234);
    assert.deepEqual(state.tasks?.shellCalls, { sh1: "call-1" });
    assert.equal(state.tasks?.tasks[0]?.type === "shell" && state.tasks.tasks[0].pid, 4242);
    assert.deepEqual(state.extensionError, { step: "tasks.list", message: "boom", at: 9 });
    assert.equal(state.usage?.a1?.inputTokens, 10);
    assert.ok(changes >= 1);
  } finally {
    await cleanup();
  }
});

test("a request gets its result by requestId; no result within the timeout gives '扩展没有回应'", async () => {
  const { extension, client, cleanup } = setup();
  try {
    const held: Array<() => void> = [];
    extension.onRequest = (socket, request) => {
      if (request.requestId === "silent") return;
      const reply = () => socket.write(line({ type: "result", v, requestId: request.requestId, ...(request.requestId === "bad" ? { ok: false, reason: "找不到这个任务" } : { ok: true }) }));
      if (request.requestId === "first" || request.requestId === "second") held.push(reply);
      else reply();
    };
    await extension.listen();
    client.start();
    await waitFor(() => client.state.status === "connected", "connected");

    const first = client.request("first", { op: "cancel", taskId: "t1" });
    const second = client.request("second", { op: "sendMessage", taskId: "t2", message: "hi\nthere" });
    await waitFor(() => held.length === 2, "two requests at the extension");
    assert.deepEqual(extension.requests[1], { type: "request", v, requestId: "second", op: "sendMessage", taskId: "t2", message: "hi\nthere" });
    held[1]!();
    assert.deepEqual(await second, { ok: true });
    held[0]!();
    assert.deepEqual(await first, { ok: true });
    assert.deepEqual(await client.request("bad", { op: "remove", taskId: "t3" }), { ok: false, reason: "找不到这个任务" });

    const started = Date.now();
    assert.deepEqual(await client.request("silent", { op: "refreshTasks" }), { ok: false, reason: "扩展没有回应", uncertain: true });
    assert.ok(Date.now() - started >= 150);
    // 超时后迟到的结果没人等，不能出错
    extension.send({ type: "result", v, requestId: "silent", ok: true });
    assert.deepEqual(await client.request("again", { op: "refreshTasks" }), { ok: true });
  } finally {
    await cleanup();
  }
});

test("a request while disconnected fails at once with '扩展没有连上'", async () => {
  const { client, cleanup } = setup();
  try {
    assert.deepEqual(await client.request("r1", { op: "refreshTasks" }), { ok: false, reason: "扩展没有连上" });
    client.start(); // 没有服务端：连不上
    assert.deepEqual(await client.request("r2", { op: "refreshTasks" }), { ok: false, reason: "扩展没有连上" });
    assert.equal(client.state.status, "connecting");
  } finally {
    await cleanup();
  }
});

test("when the extension goes away pending requests fail, tasks become not connected and the client reconnects", async () => {
  const { extension, client, cleanup } = setup();
  try {
    extension.onConnect = (socket) => {
      socket.write(line(hello()));
      socket.write(line(tasksMessage("sh1")));
    };
    extension.onRequest = () => {};
    await extension.listen();
    client.start();
    await waitFor(() => client.state.tasks !== null, "tasks");
    const pending = client.request("p1", { op: "cancel", taskId: "x" });
    await waitFor(() => extension.requests.length === 1, "request");

    await extension.close();
    assert.deepEqual(await pending, { ok: false, reason: "和扩展的连接断了" });
    await waitFor(() => client.state.status === "connecting", "connecting after the drop");
    assert.equal(client.state.tasks?.connected, false);
    assert.equal(client.state.tasks?.tasks.length, 1);

    const again = new FakeExtension(extension.path);
    again.onConnect = (socket) => {
      socket.write(line(hello()));
      socket.write(line({ ...tasksMessage("sh2"), error: null }));
    };
    await again.listen();
    try {
      await waitFor(() => client.state.status === "connected" && client.state.tasks?.connected === true, "reconnected");
      assert.deepEqual(client.state.tasks?.shellCalls, { sh2: "call-1" });
      assert.equal(client.state.extensionError, null);
    } finally {
      client.stop();
      await again.close();
    }
  } finally {
    await cleanup();
  }
});

test("a hello for another session or a different protocol version makes the client incompatible", async () => {
  const other = setup("c");
  try {
    other.extension.onConnect = (socket) => socket.write(line(hello("someone-else")));
    await other.extension.listen();
    other.client.start();
    await waitFor(() => other.client.state.status === "incompatible", "incompatible (session)");
    assert.match(other.client.state.problem ?? "", /另一个 session/);
    assert.deepEqual([other.client.state.problemKind, other.client.state.problemDetail], ["mismatch", "socket 属于另一个 session"]);
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(other.extension.connections.length, 1, "no reconnect after incompatible");
    assert.deepEqual(await other.client.request("r1", { op: "refreshTasks" }), { ok: false, reason: "扩展没有连上" });
  } finally {
    await other.cleanup();
  }

  const old = setup("c");
  try {
    old.extension.onConnect = (socket) => socket.write(line({ ...hello(), v: 99 }));
    await old.extension.listen();
    old.client.start();
    await waitFor(() => old.client.state.status === "incompatible", "incompatible (version)");
    assert.match(old.client.state.problem ?? "", /copilot-panes install/);
    assert.equal(old.client.state.problemKind, "version");
    assert.equal(old.client.state.hello, null);
  } finally {
    await old.cleanup();
  }
});

test("bad messages are dropped without breaking the connection", async () => {
  const { extension, client, cleanup } = setup();
  try {
    extension.onConnect = (socket) => {
      socket.write(line(tasksMessage("before-hello"))); // hello 之前的消息不算
      socket.write("this is not json\n");
      socket.write("[1,2,3]\n");
      socket.write("\n");
      socket.write(line({ type: "mystery", v }));
      socket.write(line({ type: "tasks", v, at: "yesterday" }));
      socket.write(line({ type: "result", v, requestId: "has space", ok: true }));
      socket.write(line(hello()));
      socket.write(line({ type: "usage", v, at: 1, agents: { a1: "nonsense", a2: { inputTokens: 1 } } }));
      socket.write(Buffer.from([0xff, 0xfe, 0x0a]));
      socket.write(line(tasksMessage("good")));
    };
    await extension.listen();
    client.start();
    await waitFor(() => client.state.tasks !== null, "tasks after the junk");
    assert.equal(client.state.status, "connected");
    assert.deepEqual(client.state.tasks?.shellCalls, { good: "call-1" });
    assert.deepEqual(Object.keys(client.state.usage ?? {}), ["a2"]);
    assert.equal(extension.connections.length, 1);
  } finally {
    await cleanup();
  }
});

test("stop() fails waiting requests, stops reconnecting and can be called twice", async () => {
  const { extension, client, cleanup } = setup();
  try {
    extension.onRequest = () => {};
    await extension.listen();
    client.start();
    await waitFor(() => client.state.status === "connected", "connected");
    const pending = client.request("p1", { op: "refreshTasks" });
    await waitFor(() => extension.requests.length === 1, "request");
    client.stop();
    client.stop();
    assert.deepEqual(await pending, { ok: false, reason: "已经断开" });
    assert.equal(client.state.status, "closed");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(extension.connections.length, 1);
  } finally {
    await cleanup();
  }
});

class FakeSocket extends EventEmitter implements SocketLike {
  written: string[] = [];
  destroyed = false;
  write(data: string): boolean {
    this.written.push(data);
    return true;
  }
  destroy(): void {
    this.destroyed = true;
  }
}

class ManualTimers implements Timers {
  scheduled: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  setTimeout(fn: () => void, ms: number): unknown {
    const entry = { fn, ms, cleared: false };
    this.scheduled.push(entry);
    return entry;
  }
  clearTimeout(handle: unknown): void {
    (handle as { cleared: boolean }).cleared = true;
  }
  setInterval(): unknown {
    throw new Error("not used");
  }
  clearInterval(): void {
    throw new Error("not used");
  }
  /** 触发最近一个没被取消的定时器。 */
  fireLast(): number {
    const entry = [...this.scheduled].reverse().find((e) => !e.cleared)!;
    entry.cleared = true;
    entry.fn();
    return entry.ms;
  }
}

test("reconnect waits longer after each failure and starts over once a hello arrives; changes are coalesced", async () => {
  const timers = new ManualTimers();
  const sockets: FakeSocket[] = [];
  const client = new ExtensionClient({
    socketPath: "/nowhere",
    sessionId: SESSION,
    clock: { now: () => 7 },
    timers,
    reconnectMs: 1000,
    requestTimeoutMs: 10_000,
    connect: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
  });
  let changes = 0;
  const off = client.onChange(() => changes++);
  client.start();
  await Promise.resolve();
  assert.equal(changes, 1);

  const delays: number[] = [];
  for (let i = 0; i < 5; i++) {
    sockets.at(-1)!.emit("error", new Error("ENOENT"));
    sockets.at(-1)!.emit("close");
    delays.push(timers.scheduled.filter((e) => !e.cleared).at(-1)!.ms);
    timers.fireLast();
  }
  assert.deepEqual(delays, [1000, 2000, 4000, 4000, 4000]);
  assert.equal(sockets.length, 6);

  const before = changes;
  const socket = sockets.at(-1)!;
  socket.emit("data", Buffer.from(line(hello()) + line(tasksMessage("sh1")) + line(usageMessage)));
  await Promise.resolve();
  assert.equal(changes, before + 1, "three messages in one chunk notify once");
  assert.equal(client.state.status, "connected");

  socket.emit("close");
  assert.equal(timers.scheduled.filter((e) => !e.cleared).at(-1)!.ms, 1000);
  off();
  client.stop();
  assert.equal(sockets.at(-1)!.destroyed, true);
});

test("a request is written as one JSON line and a duplicate requestId is refused", async () => {
  const timers = new ManualTimers();
  const socket = new FakeSocket();
  const client = new ExtensionClient({
    socketPath: "/nowhere",
    sessionId: SESSION,
    clock: { now: () => 7 },
    timers,
    reconnectMs: 1000,
    requestTimeoutMs: 10_000,
    connect: () => socket,
  });
  client.start();
  socket.emit("data", Buffer.from(line(hello())));
  const first = client.request("r1", { op: "promoteToBackground", taskId: "t" });
  assert.deepEqual(socket.written, [line({ type: "request", v, requestId: "r1", op: "promoteToBackground", taskId: "t" })]);
  assert.deepEqual(await client.request("r1", { op: "refreshTasks" }), { ok: false, reason: "请求编号重复" });
  timers.fireLast();
  assert.deepEqual(await first, { ok: false, reason: "扩展没有回应", uncertain: true });
  client.stop();
});

test("a hello whose copilotPid differs from the registration's, or is 1, is not trusted: incompatible, nothing from it is used", async () => {
  for (const [expected, reported] of [[200, 100], [undefined, 1]] as const) {
    const { extension, client, cleanup } = setup("p", { expectedCopilotPid: expected });
    try {
      extension.onConnect = (socket) => {
        socket.write(line({ ...hello(), copilotPid: reported }));
        socket.write(line(tasksMessage("sh1")));
      };
      await extension.listen();
      client.start();
      await waitFor(() => client.state.status === "incompatible", `incompatible for ${expected}/${reported}`);
      assert.match(client.state.problem ?? "", /进程号和登记记录对不上/);
      assert.deepEqual([client.state.problemKind, client.state.problemDetail], ["mismatch", "socket 报的进程号和登记记录对不上"]);
      assert.equal(client.state.tasks, null);
      assert.deepEqual(await client.request("r1", { op: "cancel", taskId: "t1" }), { ok: false, reason: "扩展没有连上" });
    } finally {
      await cleanup();
    }
  }
  // 一致时照常连上
  const { extension, client, cleanup } = setup("p", { expectedCopilotPid: 100 });
  try {
    extension.onConnect = (socket) => socket.write(line(hello()));
    await extension.listen();
    client.start();
    await waitFor(() => client.state.status === "connected", "connected with the matching pid");
  } finally {
    await cleanup();
  }
});

test("verifySocket vetoes the connection before any socket is opened, and the client does not retry", async () => {
  let connects = 0;
  const { client, cleanup } = setup("v", {
    verifySocket: () => "目录不属于当前用户",
    connect: () => {
      connects++;
      throw new Error("must not connect");
    },
  });
  try {
    client.start();
    assert.equal(client.state.status, "incompatible");
    assert.equal(client.state.problem, "不连这个 socket：目录不属于当前用户");
    assert.deepEqual([client.state.problemKind, client.state.problemDetail], ["unsafe", "目录不属于当前用户"]);
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(connects, 0);
    assert.equal(client.state.status, "incompatible");
  } finally {
    await cleanup();
  }
});

test("statusSince is the clock time of the last status change, so the interface can tell a fresh drop from a long outage", async () => {
  let now = 1000;
  const { extension, client, cleanup } = setup("s", { clock: { now: () => now } });
  try {
    await extension.listen();
    assert.equal(client.state.statusSince, undefined);
    client.start();
    assert.equal(client.state.status, "connecting");
    assert.equal(client.state.statusSince, 1000);
    now = 2000;
    await waitFor(() => client.state.status === "connected", "connected");
    assert.equal(client.state.statusSince, 2000);
    now = 5000;
    extension.onConnect = null; // 重连上来也不发 hello：停在“正在连接”
    for (const socket of extension.connections) socket.destroy();
    await waitFor(() => client.state.status === "connecting", "back to connecting after the drop");
    assert.equal(client.state.statusSince, 5000);
  } finally {
    await cleanup();
  }
});
