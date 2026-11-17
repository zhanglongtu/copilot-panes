import assert from "node:assert/strict";
import { appendFileSync, chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { DemoSession } from "../../src/demo-live.ts";
import { DEMO_IDS, DEMO_KEYS, DEMO_PYTEST_PID, DEMO_SCORE_PID } from "../../src/demo-script.ts";
import { demoData } from "../helpers/demo-data.ts";
import { OutputTail, RealSession, SessionFeed } from "../../src/feed.ts";
import { PROTOCOL_VERSION, REGISTRATION_VERSION, serializeMessage } from "../../src/protocol.ts";
import { agentKey } from "../../src/types/model.ts";
import { FakeTime } from "../extension/fake.ts";
import { tempDir } from "../helpers/tmp.ts";

const MB = 1024 * 1024;

const INSTALLED = { installed: true, experimental: true };

function reasonOf(feed: SessionFeed): string | null {
  const state = feed.extensionState(INSTALLED, feed.clockNow());
  return state.kind === "readonly" ? state.reason : null;
}

test("OutputTail reads only the end of a huge file, starting at a line boundary, and says so", () => {
  const dir = tempDir("ot-");
  try {
    const path = join(dir.path, "a.out");
    const line = `${"x".repeat(98)}\n`;
    writeFileSync(path, line.repeat(30_000)); // 约 2.9 MB
    const tail = new OutputTail(path, MB);
    const chunk = tail.read();
    assert.ok(chunk.exists);
    assert.match(chunk.text, /^\x1b\[2m… 前面约 2 MB 没有显示/);
    const body = chunk.text.slice(chunk.text.indexOf("\n") + 1);
    assert.ok(body.length <= MB && body.length > MB - 200);
    assert.ok(body.startsWith("x"), "starts on a whole line");
    assert.ok(body.split("\n").every((text) => text === "" || text.length === 98));
    assert.equal(tail.read().text, "");
  } finally {
    dir.cleanup();
  }
});

test("OutputTail follows appends, keeps a split character whole, and reports a replaced file", () => {
  const dir = tempDir("ot-");
  try {
    const path = join(dir.path, "a.out");
    const tail = new OutputTail(path);
    assert.deepEqual(tail.read(), { text: "", reset: false, more: false, exists: false });
    writeFileSync(path, "第一行\n");
    assert.equal(tail.read().text, "第一行\n");
    const bytes = Buffer.from("汉字\n");
    appendFileSync(path, bytes.subarray(0, 4));
    assert.equal(tail.read().text, "汉");
    appendFileSync(path, bytes.subarray(4));
    assert.equal(tail.read().text, "字\n");
    writeFileSync(`${path}.new`, "新\n");
    renameSync(`${path}.new`, path);
    const after = tail.read();
    assert.equal(after.reset, true);
    assert.equal(after.text, "新\n");
  } finally {
    dir.cleanup();
  }
});

function eventsFile(dir: string, lines: string[]): string {
  mkdirSync(join(dir, "state", "s1"), { recursive: true });
  const path = join(dir, "state", "s1", "events.jsonl");
  writeFileSync(path, lines.map((text) => `${text}\n`).join(""));
  return path;
}

const agentStart = (name: string, id: string) =>
  JSON.stringify({ type: "subagent.started", data: { toolCallId: `t_${id}`, agentDisplayName: name, agentType: "x" }, agentId: id, timestamp: "2026-11-16T05:00:00.000Z" });

test("a real session replaces its store when events.jsonl is replaced and is read-only without an extension", () => {
  const dir = tempDir("fd-");
  try {
    const events = eventsFile(dir.path, [agentStart("one", "a1")]);
    const time = new FakeTime();
    let changes = 0;
    const io = new RealSession({ sessionId: "s1", stateDir: join(dir.path, "state"), dataDir: join(dir.path, "data"), copilotPid: 7, clock: time, timers: time });
    const feed = new SessionFeed(io, { clock: time, onChange: () => changes++ });
    assert.equal(feed.poll(), true);
    assert.deepEqual(feed.store.agents().map((a) => a.name), ["one"]);
    assert.equal(feed.extensionState(INSTALLED, feed.clockNow()).kind, "readonly");
    assert.equal(reasonOf(feed), "只读：这个 session 没加载扩展");
    assert.equal(io.copilotPid(), 7);

    // 换一个更小的新文件：状态库要重来，不能留着旧的子 agent
    rmSync(events);
    writeFileSync(events, `${agentStart("two", "a2")}\n`);
    assert.equal(feed.poll(), true);
    assert.deepEqual(feed.store.agents().map((a) => a.name), ["two"]);
    assert.equal(feed.resets, 1);
    feed.close();
  } finally {
    dir.cleanup();
  }
});

test("terminals exist only for the selected and the running commands, and not without an .out file", () => {
  const dir = tempDir("fd-");
  try {
    const command = (id: string, extra = {}) =>
      JSON.stringify({ type: "tool.execution_start", data: { toolCallId: id, toolName: "bash", arguments: { command: `run ${id}`, mode: "async", shellId: id, ...extra } }, timestamp: "2026-11-16T05:00:00.000Z" });
    eventsFile(dir.path, [command("c1"), command("c2")]);
    const dataDir = join(dir.path, "data");
    const time = new FakeTime();
    const io = new RealSession({ sessionId: "s1", stateDir: join(dir.path, "state"), dataDir, copilotPid: null, clock: time, timers: time });
    const feed = new SessionFeed(io, { clock: time, onChange: () => {} });
    feed.poll();
    mkdirSync(join(dataDir, "out", "s1"), { recursive: true });
    writeFileSync(io.outputFile("c1")!, "hello\n");

    feed.syncTerminals(new Set(["c1", "c2"]), 40, 8);
    assert.ok(feed.terminalOf("c1"), "c1 has an .out file");
    assert.equal(feed.terminalOf("c2"), null, "c2 has no .out file: the view falls back to the event output");
    assert.equal(feed.terminalOf("c1")?.cols, 40);

    feed.syncTerminals(new Set(["c1"]), 30, 6);
    assert.equal(feed.terminalOf("c1")?.cols, 30);
    feed.syncTerminals(new Set(), 30, 6);
    assert.equal(feed.terminalOf("c1"), null, "released when it is neither selected nor running");
    feed.syncTerminals(new Set(["c1"]), 30, 6);
    assert.ok(feed.terminalOf("c1"), "rebuilt from the file when selected again");
    feed.close();
  } finally {
    dir.cleanup();
  }
});

// ───── 演示 ─────

function demo() {
  const time = new FakeTime(1_800_000_000_000);
  const session = new DemoSession(time, time);
  const feed = new SessionFeed(session, { clock: time, onChange: () => {} });
  feed.poll();
  session.start();
  return { time, session, feed };
}

test("the live demo goes through the store and list merge and gives the same list as demoData", () => {
  const { time, feed } = demo();
  const live = feed.entries(time.now(), false, new Set());
  const expected = demoData(time.now()).entries;
  assert.deepEqual(live, expected);
  assert.equal(feed.totalTokens(), demoData(time.now()).totalTokens);
  feed.close();
});

test("score prints a line a second until 40/40 and then exits normally; pytest advances slowly", () => {
  const { time, feed } = demo();
  const progress = () => feed.entries(time.now(), false, new Set()).find((e) => e.key === DEMO_KEYS.score)?.step;
  assert.equal(progress(), "12/40 30%");
  time.tick(1000);
  feed.poll();
  assert.equal(progress(), "13/40 32%");
  time.tick(27_000);
  feed.poll();
  assert.equal(progress(), "40/40 100%");
  time.tick(1000);
  feed.poll();
  assert.equal(progress(), undefined, "a command that exited with 0 leaves the list");
  const pytest = feed.entries(time.now(), false, new Set()).find((e) => e.key === DEMO_KEYS.pytest);
  assert.match(pytest?.step ?? "", /^(1[0-9]|2[0-3])\/23 /);
  feed.close();
});

test("Ctrl+C reaches the demo command through the real Interrupter and ends it with exit code 130", () => {
  const { time, session, feed } = demo();
  const outcome = session.interrupter.press(DEMO_IDS.score, DEMO_SCORE_PID, session.copilotPid());
  assert.deepEqual(outcome, { kind: "sent", signal: "SIGINT", target: "group" });
  feed.poll();
  const score = feed.entries(time.now(), false, new Set()).find((e) => e.key === DEMO_KEYS.score);
  assert.equal(score?.status, "failed");
  assert.equal(score?.step, "退出码 130");
  // 进程号不属于这个 session 的 Copilot CLI 时拒绝发信号
  assert.equal(session.interrupter.press("x", 99999, session.copilotPid()).kind, "fallback");
  assert.equal(session.interrupter.press(DEMO_IDS.pytest, DEMO_PYTEST_PID, null).kind, "fallback");
  feed.close();
});

test("a message to a sub-agent comes back as ok, shows up in its transcript, and gets a reply", async () => {
  const { time, feed } = demo();
  const pending = feed.request("r1", { op: "sendMessage", taskId: DEMO_IDS.fixLogin, message: "你好 hello" });
  time.tick(200);
  assert.deepEqual(await pending, { ok: true });
  feed.poll();
  const items = feed.store.transcript(DEMO_IDS.fixLogin);
  const sent = items.find((item) => item.kind === "message");
  assert.ok(sent && sent.kind === "message" && sent.from === "you" && sent.text === "你好 hello");
  time.tick(1600);
  feed.poll();
  assert.ok(feed.store.transcript(DEMO_IDS.fixLogin).some((item) => item.kind === "say" && item.text.startsWith("收到")));

  const refused = feed.request("r2", { op: "sendMessage", taskId: DEMO_IDS.findBug, message: "x" });
  time.tick(200);
  assert.deepEqual(await refused, { ok: false, reason: "find-bug 已经结束，不能再发消息" });
  assert.ok(agentKey(DEMO_IDS.findBug));
  feed.close();
});

// ───── 扩展晚到、断开又连上 ─────

async function waitFor(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!condition()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("the extension can show up after the interface, drop, and come back without rebuilding the session", async () => {
  const dir = tempDir("br-");
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.write(serializeMessage({ type: "hello", v: PROTOCOL_VERSION, sessionId: "s1", copilotPid: 5, extensionPid: 6, extensionVersion: "x" }));
    socket.write(serializeMessage({ type: "tasks", v: PROTOCOL_VERSION, at: 1, tasks: [], shellCalls: {}, error: null }));
  });
  try {
    eventsFile(dir.path, [agentStart("one", "a1")]);
    const time = new FakeTime();
    const io = new RealSession({ sessionId: "s1", stateDir: join(dir.path, "state"), dataDir: join(dir.path, "data"), copilotPid: 7, clock: time, timers: time });
    const feed = new SessionFeed(io, { clock: time, onChange: () => {} });
    feed.poll();
    assert.equal(reasonOf(feed), "只读：这个 session 没加载扩展");
    assert.deepEqual(await feed.request("r1", { op: "refreshTasks" }), { ok: false, reason: "只读：扩展没有加载" });

    const socketPath = join(dir.path, "x.sock");
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    chmodSync(socketPath, 0o600); // 扩展自己开的 socket 是 0600；界面不连对组或其他人可写的 socket
    io.bridge.target({
      v: REGISTRATION_VERSION,
      protocol: PROTOCOL_VERSION,
      sessionId: "s1",
      copilotPid: 5,
      extensionPid: 6,
      tmuxPane: null,
      cwd: "/w",
      socketPath,
      extensionVersion: "x",
      startedAt: 1,
      updatedAt: 1,
    });
    await waitFor(() => feed.extensionState(INSTALLED, feed.clockNow()).kind === "connected", "connected");
    assert.equal(io.copilotPid(), 5);

    // 连接断了：只读，旧的任务列表作废；定时器走到重连时间后再连上
    for (const socket of sockets) socket.destroy();
    await waitFor(() => feed.extensionState(INSTALLED, feed.clockNow()).kind === "readonly", "readonly after the drop");
    assert.equal(reasonOf(feed), "正在连接扩展…");
    assert.equal(io.bridge.state.tasks?.connected, false);
    time.tick(1000);
    await waitFor(() => feed.extensionState(INSTALLED, feed.clockNow()).kind === "connected", "connected again");
    assert.equal(io.bridge.state.tasks?.connected, true);
    feed.close();
  } finally {
    for (const socket of sockets) socket.destroy();
    server.close();
    dir.cleanup();
  }
});

test("the Copilot CLI pid used for signals comes from the registration; a socket whose hello says another pid is not trusted", async () => {
  const dir = tempDir("br-");
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.write(serializeMessage({ type: "hello", v: PROTOCOL_VERSION, sessionId: "s1", copilotPid: 1, extensionPid: 6, extensionVersion: "x" }));
    // 对端还会发一份带别的进程的 pid 的任务列表；hello 不被信任时它不能进到界面里
    socket.write(serializeMessage({ type: "tasks", v: PROTOCOL_VERSION, at: 1, tasks: [{ type: "shell", id: "1", description: "d", status: "running", startedAt: "", command: "x", attachmentMode: "attached", pid: 4242 }], shellCalls: {}, error: null }));
  });
  try {
    eventsFile(dir.path, [agentStart("one", "a1")]);
    const time = new FakeTime();
    const io = new RealSession({ sessionId: "s1", stateDir: join(dir.path, "state"), dataDir: join(dir.path, "data"), copilotPid: 7, clock: time, timers: time });
    const feed = new SessionFeed(io, { clock: time, onChange: () => {} });
    feed.poll();
    const socketPath = join(dir.path, "x.sock");
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    chmodSync(socketPath, 0o600);
    const registration = { v: REGISTRATION_VERSION, protocol: PROTOCOL_VERSION, sessionId: "s1", copilotPid: 5, extensionPid: 6, tmuxPane: null, cwd: "/w", socketPath, extensionVersion: "x", startedAt: 1, updatedAt: 1 };
    io.bridge.target(registration);
    await waitFor(() => io.bridge.state.status === "incompatible", "the pid mismatch is noticed");
    assert.equal(reasonOf(feed), "只读：连接没通过安全检查");
    assert.match(feed.explainReadonly(INSTALLED, feed.clockNow())?.notice.text ?? "", /socket 报的进程号和登记记录对不上/);
    assert.equal(io.bridge.state.tasks, null, "nothing from this socket is used");
    assert.equal(io.copilotPid(), 5, "the registration's pid, not the one in hello");

    // 同一个 session 在新的 Copilot CLI 进程里恢复：socket 路径不变、进程号变了，要重新建客户端
    io.bridge.target({ ...registration, copilotPid: 1 });
    await waitFor(() => io.bridge.state.status === "incompatible" && io.copilotPid() === 1, "rebuilt for the new pid");
    feed.close();
  } finally {
    for (const socket of sockets) socket.destroy();
    server.close();
    dir.cleanup();
  }
});

test("a socket in a directory other people can write to, or in a symlinked directory, is not connected", async () => {
  const dir = tempDir("br-");
  try {
    const time = new FakeTime();
    const io = new RealSession({ sessionId: "s1", stateDir: join(dir.path, "state"), dataDir: join(dir.path, "data"), copilotPid: 7, clock: time, timers: time });
    const registration = (socketPath: string) => ({ v: REGISTRATION_VERSION, protocol: PROTOCOL_VERSION, sessionId: "s1", copilotPid: 7, extensionPid: 6, tmuxPane: null, cwd: "/w", socketPath, extensionVersion: "x", startedAt: 1, updatedAt: 1 });
    const open = join(dir.path, "open");
    mkdirSync(open);
    chmodSync(open, 0o777);
    io.bridge.target(registration(join(open, "x.sock")));
    assert.equal(io.bridge.state.status, "incompatible");
    assert.match(io.bridge.state.problem ?? "", /不连这个 socket：.*对组或其他人可写/);
    io.close();
  } finally {
    dir.cleanup();
  }
});

test("a registration whose socketPath is null (the extension could not open its socket) leaves the session read-only with that reason, and a later registration connects", async () => {
  const dir = tempDir("br-");
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.write(serializeMessage({ type: "hello", v: PROTOCOL_VERSION, sessionId: "s1", copilotPid: 5, extensionPid: 6, extensionVersion: "x" }));
  });
  try {
    eventsFile(dir.path, [agentStart("one", "a1")]);
    const time = new FakeTime();
    const io = new RealSession({ sessionId: "s1", stateDir: join(dir.path, "state"), dataDir: join(dir.path, "data"), copilotPid: 7, clock: time, timers: time });
    const feed = new SessionFeed(io, { clock: time, onChange: () => {} });
    feed.poll();
    const registration = { v: REGISTRATION_VERSION, protocol: PROTOCOL_VERSION, sessionId: "s1", copilotPid: 5, extensionPid: 6, tmuxPane: null, cwd: "/w", extensionVersion: "x", startedAt: 1, updatedAt: 1 };
    io.bridge.target({ ...registration, socketPath: null });
    assert.equal(reasonOf(feed), "只读：扩展没能开成连接");
    assert.deepEqual(await feed.request("r1", { op: "refreshTasks" }), { ok: false, reason: "只读：扩展没能开成 socket，正在重试" });
    const socketPath = join(dir.path, "x.sock");
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    chmodSync(socketPath, 0o600);
    io.bridge.target({ ...registration, socketPath });
    await waitFor(() => feed.extensionState(INSTALLED, feed.clockNow()).kind === "connected", "connected once the extension has a socket");
    feed.close();
  } finally {
    for (const socket of sockets) socket.destroy();
    server.close();
    dir.cleanup();
  }
});

test("entries mark a running agent that started before the extension loaded: ≥ tokens until it ends", () => {
  const dir = tempDir("fd-");
  try {
    const at = (iso: string, type: string, data: object, agentId?: string) => JSON.stringify({ type, data, ...(agentId ? { agentId } : {}), timestamp: iso });
    eventsFile(dir.path, [at("2026-11-16T05:00:00.000Z", "subagent.started", { toolCallId: "t1", agentDisplayName: "old", agentType: "x" }, "a1")]);
    const time = new FakeTime();
    const io = new RealSession({ sessionId: "s1", stateDir: join(dir.path, "state"), dataDir: join(dir.path, "data"), copilotPid: 7, clock: time, timers: time });
    const feed = new SessionFeed(io, { clock: time, onChange: () => {} });
    feed.poll();
    const usage = { a1: { inputTokens: 900, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, calls: 1 } };
    const state = { status: "connected" as const, hello: null, tasks: null, usage, extensionError: null, problem: null };
    const bridge = { state, onChange: () => () => {}, request: async () => ({ ok: true as const }), stop: () => {}, extensionStartedAt: Date.parse("2026-11-16T06:00:00.000Z") };
    Object.defineProperty(io, "bridge", { value: bridge });
    const [entry] = feed.entries(Date.parse("2026-11-16T06:10:00.000Z"), false, new Set());
    assert.deepEqual([entry!.tokens, entry!.tokensPartial], [1_000, true]);
    Object.defineProperty(bridge, "extensionStartedAt", { value: Date.parse("2026-11-16T04:00:00.000Z") });
    assert.equal(feed.entries(Date.parse("2026-11-16T06:10:00.000Z"), false, new Set())[0]!.tokensPartial, undefined);
    feed.close();
  } finally {
    dir.cleanup();
  }
});
