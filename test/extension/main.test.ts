import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import net from "node:net";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import { startPanes } from "../../extension/src/main.ts";
import type { ExtensionDeps, PanesHandle } from "../../extension/src/main.ts";
import { outDir, outPath, registrationPath, sessionsDir, socketFallbackDir } from "../../src/paths.ts";
import { parseRegistration, PROTOCOL_VERSION, REGISTRATION_VERSION } from "../../src/protocol.ts";
import type { Registration, TasksMessage, UsageMessage } from "../../src/protocol.ts";
import { tempDir } from "../helpers/tmp.ts";
import { bashStart, FakeSession, FakeTime, request, shellOutput, shellTask, TestClient, toolComplete } from "./fake.ts";

type Cleanup = { after(fn: () => void | Promise<void>): void };

// The extension only trusts directories owned by this uid, so the tests must use the real one.
const uid = process.getuid?.() ?? 1000;

function makeDeps(root: string, time: FakeTime, extra: Partial<ExtensionDeps> = {}): ExtensionDeps & { lines: string[] } {
  const lines: string[] = [];
  return {
    dataDir: join(root, "data"),
    socketOptions: { runtimeDir: root, tmpDir: root, uid },
    clock: time,
    timers: time,
    pid: 4243,
    copilotPid: process.pid,
    tmuxPane: "%3",
    cwd: "/work/demo",
    version: "9.9.9",
    isPidAlive: (pid) => pid === process.pid,
    logError: (line) => lines.push(line),
    ...extra,
    lines,
  };
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

async function launch(t: Cleanup, options: { session?: FakeSession; deps?: Partial<ExtensionDeps> } = {}) {
  const tmp = tempDir("m");
  const time = new FakeTime(1_700_000_000_000);
  const session = options.session ?? new FakeSession();
  const deps = makeDeps(tmp.path, time, options.deps);
  const handle = await startPanes(session, deps);
  await settle(); // 启动时发出的第一次任务列表查询做完
  const clients: TestClient[] = [];
  t.after(async () => {
    for (const c of clients) await c.close();
    await handle.stop();
    tmp.cleanup();
  });
  const connect = async () => {
    const client = await TestClient.connect(handle.socketPath);
    clients.push(client);
    return client;
  };
  const readRegistration = (): Registration => {
    const parsed = parseRegistration(readFileSync(registrationPath(deps.dataDir, "s1"), "utf8"));
    assert.ok(parsed.ok, "registration parses");
    return parsed.value;
  };
  const read = (id: string) => readFileSync(outPath(deps.dataDir, "s1", id), "utf8");
  return { tmp, time, session, deps, handle, connect, readRegistration, read };
}

const isTasks = (m: { type: string }): m is TasksMessage => m.type === "tasks";
const isUsage = (m: { type: string }): m is UsageMessage => m.type === "usage";
const isResult = (m: { type: string }) => m.type === "result";

test("events emitted while startPanes is still starting are recorded (subscription comes first)", async (t) => {
  const tmp = tempDir("m");
  const time = new FakeTime();
  const session = new FakeSession();
  const deps = makeDeps(tmp.path, time);
  const starting = startPanes(session, deps);
  assert.equal(session.handlers.size, 1, "subscribed before startPanes yields for the first time");
  session.emit(bashStart("call-1", "make"));
  session.emit(shellOutput("call-1", 0, "early output\n"));
  session.emit({ type: "subagent.started", agentId: "a1", data: { toolCallId: "task-1" } });
  session.emit({ type: "assistant.usage", agentId: "a1", ephemeral: true, data: { inputTokens: 5, outputTokens: 1 } });
  const handle = await starting;
  t.after(async () => {
    await handle.stop();
    tmp.cleanup();
  });
  assert.equal(readFileSync(outPath(deps.dataDir, "s1", "call-1"), "utf8"), "early output\n");
  const client = await TestClient.connect(handle.socketPath);
  const [, , usage] = await client.take(3);
  assert.equal(usage?.type === "usage" && usage.agents.a1?.inputTokens, 5);
  await client.close();
});

test("after start the registration exists, and a client gets hello, tasks and usage over the socket", async (t) => {
  const { time, deps, handle, connect, readRegistration } = await launch(t);

  assert.deepEqual(readRegistration(), {
    v: REGISTRATION_VERSION,
    protocol: PROTOCOL_VERSION,
    sessionId: "s1",
    copilotPid: process.pid,
    extensionPid: 4243,
    tmuxPane: "%3",
    cwd: "/work/demo",
    socketPath: handle.socketPath,
    extensionVersion: "9.9.9",
    startedAt: time.now(),
    updatedAt: time.now(),
  });
  assert.equal(handle.socketPath, join(deps.dataDir, "sessions", "s1.sock"));
  assert.equal(statSync(handle.socketPath).mode & 0o777, 0o600);

  const client = await connect();
  const [hello, tasks, usage] = await client.take(3);
  assert.deepEqual(hello, { type: "hello", v: PROTOCOL_VERSION, sessionId: "s1", copilotPid: process.pid, extensionPid: 4243, extensionVersion: "9.9.9" });
  assert.equal(tasks?.type === "tasks" && tasks.tasks.length, 0);
  assert.deepEqual(usage, { type: "usage", v: PROTOCOL_VERSION, at: time.now(), agents: {} });
  await client.expectQuiet();
});

test("a request sent over the socket reaches the fake session's rpc and the result comes back", async (t) => {
  const { session, connect } = await launch(t);
  const client = await connect();
  await client.take(3);

  client.send(request("r1", "sendMessage", "a1", "please continue"));
  assert.deepEqual(await client.takeMatching(isResult), { type: "result", v: PROTOCOL_VERSION, requestId: "r1", ok: true });
  assert.deepEqual(session.callsOf("sendMessage"), [{ id: "a1", message: "please continue", fromAgentId: "" }]);

  session.overrides.cancel = async () => ({ cancelled: false });
  client.send(request("r2", "cancel", "a1"));
  const refused = await client.takeMatching(isResult);
  assert.equal(refused.type === "result" && !refused.ok && refused.reason, "没停掉：Copilot CLI 说它已经不在跑了");

  // refreshTasks：立刻查一次任务列表并推送，不等下一个一秒
  const listsBefore = session.callsOf("list").length;
  client.send(request("r3", "refreshTasks"));
  await client.takeMatching(isTasks);
  assert.deepEqual(await client.takeMatching(isResult), { type: "result", v: PROTOCOL_VERSION, requestId: "r3", ok: true });
  assert.equal(session.callsOf("list").length >= listsBefore + 1, true);
});

test("stop() removes the socket and the registration within one second and can be called twice", async (t) => {
  const { time, session, deps, handle, connect } = await launch(t);
  const client = await connect();
  await client.take(3);
  assert.equal(existsSync(handle.socketPath), true);

  const started = Date.now();
  await Promise.all([handle.stop(), handle.stop()]);
  assert.ok(Date.now() - started < 1000, "stop() takes well under a second");
  assert.equal(existsSync(handle.socketPath), false);
  assert.equal(existsSync(registrationPath(deps.dataDir, "s1")), false);
  assert.equal(session.handlers.size, 0, "unsubscribed");
  assert.equal(time.pendingTimers, 0, "no timers left");
  await handle.stop();

  // 停下之后事件和定时器都不再起作用
  session.emit(bashStart("late", "x"));
  time.tick(10_000);
  assert.equal(existsSync(outPath(deps.dataDir, "s1", "late")), false);
  assert.equal(existsSync(registrationPath(deps.dataDir, "s1")), false);
  handle.cleanupSync();
});

test("cleanupSync() removes the registration and the socket file of a process that is exiting", async (t) => {
  const { deps, handle } = await launch(t);
  handle.cleanupSync();
  assert.equal(existsSync(handle.socketPath), false);
  assert.equal(existsSync(registrationPath(deps.dataDir, "s1")), false);
  handle.cleanupSync();
});

test("a changed task list is pushed at once, an unchanged one only as a keepalive every five seconds", async (t) => {
  const { time, session, connect } = await launch(t);
  const client = await connect();
  await client.take(3);

  for (let i = 0; i < 4; i += 1) {
    time.tick(1000);
    await client.expectQuiet(30);
  }
  time.tick(1000);
  const keepalive = (await client.takeMatching(isTasks)) as TasksMessage;
  assert.equal(keepalive.at, time.now());

  session.tasks = [shellTask("7", "make", new Date(time.now()).toISOString())];
  time.tick(1000);
  const changed = (await client.takeMatching(isTasks)) as TasksMessage;
  assert.deepEqual(changed.tasks.map((x) => x.id), ["7"]);
  time.tick(1000);
  await client.expectQuiet(30);
});

test("usage is pushed after it changed, at most once per second", async (t) => {
  const { time, session, connect } = await launch(t);
  const client = await connect();
  await client.take(3);
  session.emit({ type: "subagent.started", agentId: "a1", data: { toolCallId: "t1" } });
  for (let i = 0; i < 5; i += 1) session.emit({ type: "assistant.usage", agentId: "a1", data: { inputTokens: 10, outputTokens: 1 } });
  await client.expectQuiet(30);
  time.tick(1000);
  const usage = (await client.takeMatching(isUsage)) as UsageMessage;
  assert.equal(usage.agents.a1?.calls, 5);
  assert.equal(usage.agents.a1?.inputTokens, 50);
  time.tick(1000);
  await client.expectQuiet(30);
  session.emit({ type: "subagent.completed", agentId: "a1", data: { toolCallId: "t1", totalTokens: 61 } });
  time.tick(1000);
  assert.equal(((await client.takeMatching(isUsage)) as UsageMessage).agents.a1?.reportedTotalTokens, 61);
});

test("shell tasks are matched to their command's toolCallId in the tasks message", async (t) => {
  const { time, session, connect } = await launch(t);
  const client = await connect();
  await client.take(3);
  session.emit(bashStart("call-sleep", "sleep 500", { mode: "async" }, { timestamp: new Date(time.now() - 20).toISOString() }));
  session.tasks = [shellTask("11", "sleep 500", new Date(time.now()).toISOString(), { pid: 777 })];
  time.tick(1000);
  const message = (await client.takeMatching((m) => isTasks(m) && Object.keys(m.shellCalls).length > 0)) as TasksMessage;
  assert.deepEqual(message.shellCalls, { "11": "call-sleep" });
  assert.equal((message.tasks[0] as { pid?: number }).pid, 777);
});

test("commands and finished sub-agents from before the extension started are recovered from the session history", async (t) => {
  const session = new FakeSession();
  const started = new Date(1_700_000_000_000 - 60_000).toISOString();
  session.history = [
    bashStart("old-call", "sleep 900", { mode: "async" }, { timestamp: started }),
    toolComplete("old-call", { result: { content: "<command started in background with shellId: 9>", structuredContent: { shellId: "9" } } }),
    { type: "subagent.started", agentId: "a1", data: { toolCallId: "task-1" } },
    { type: "subagent.completed", agentId: "a1", data: { toolCallId: "task-1", totalTokens: 74072 } },
  ];
  session.tasks = [shellTask("9", "sleep 900", started, { pid: 4321 })];
  const { time, connect } = await launch(t, { session });
  const client = await connect();
  const seen = await client.take(3);
  time.tick(1000);
  await new Promise((resolve) => setTimeout(resolve, 50));
  const all = [...seen, ...client.messages];
  assert.deepEqual(all.filter(isTasks).at(-1)?.shellCalls, { "9": "old-call" });
  assert.equal(all.filter(isUsage).at(-1)?.agents.a1?.reportedTotalTokens, 74072);
});

test("after a reload a still-running detach command keeps being copied into its .out file", async (t) => {
  const session = new FakeSession();
  const started = new Date(1_700_000_000_000 - 60_000).toISOString();
  session.history = [
    bashStart("daemon", "python3 server.py", { mode: "async", detach: true }, { timestamp: started }),
    toolComplete("daemon", { result: { content: "<command started in detached background with shellId: gw>", structuredContent: { shellId: "gw" } } }),
  ];
  session.tasks = [shellTask("gw", "python3 server.py", started, { attachmentMode: "detached" })];
  const answers = [{ text: "line 1\nline 2\n", cursor: "c1", exit: { status: "completed" as const, exitCode: 0 } }];
  session.overrides.readOutput = async () => answers.shift()!;
  const { deps } = await launch(t, { session });
  const deadline = Date.now() + 8000;
  while (answers.length > 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  await settle();
  assert.equal(readFileSync(outPath(deps.dataDir, "s1", "daemon"), "utf8"), "line 1\nline 2\n");
});

test("a history call that fails is logged and does not stop the extension", async (t) => {
  const session = new FakeSession();
  session.history = null;
  const { deps, connect } = await launch(t, { session });
  const client = await connect();
  await client.take(3);
  assert.ok(deps.lines.some((l) => l.startsWith("backfill.events: getEvents is not available")), deps.lines.join("\n"));
});

test("output files are right for in-order, out-of-order, duplicated and too-fast commands", async (t) => {
  const { time, session, read } = await launch(t);
  session.emit(bashStart("ordered", "make"));
  session.emit(shellOutput("ordered", 1, "\x1b[32mB\x1b[0m\r"));
  session.emit(shellOutput("ordered", 0, "A "));
  session.emit(shellOutput("ordered", 1, "\x1b[32mB\x1b[0m\r"));
  session.emit(shellOutput("ordered", 2, "C\n", "stderr"));
  session.emit(shellOutput("ordered", 2, "C\n", "stderr"));
  assert.equal(read("ordered"), "A \x1b[32mB\x1b[0m\rC\n");

  session.emit(shellOutput("gappy", 0, "x"));
  session.emit(shellOutput("gappy", 2, "z"));
  assert.equal(read("gappy"), "x");
  time.tick(500);
  assert.equal(read("gappy"), "xz");

  session.emit(bashStart("quick", "echo done"));
  session.emit(toolComplete("quick", { shellExecution: { exitCode: 0 }, result: { content: "done\n<shellId: 3 completed with exit code 0>" } }));
  assert.equal(read("quick"), "done");
});

test("a detach command's output is copied from tasks.readOutput into its .out file", async (t) => {
  const { session, read } = await launch(t);
  const answers = [
    { text: "line 1\n", cursor: "c1" },
    { text: "line 2\n", cursor: "c2", exit: { status: "completed" as const, exitCode: 0 } },
  ];
  session.overrides.readOutput = async () => answers.shift()!;
  session.emit(bashStart("daemon", "python3 server.py", { mode: "async", detach: true }));
  session.emit(toolComplete("daemon", { result: { content: "<command started in detached background with shellId: gw>", structuredContent: { shellId: "gw" } } }));
  const deadline = Date.now() + 8000;
  while (answers.length > 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  await settle();
  assert.equal(read("daemon"), "line 1\nline 2\n");
  assert.deepEqual(session.callsOf("readOutput").map((p) => (p as { cursor?: string }).cursor), [undefined, "c1"]);
});

test("the heartbeat keeps rewriting the registration", async (t) => {
  const { time, readRegistration } = await launch(t);
  const startedAt = readRegistration().startedAt;
  time.tick(5000);
  assert.equal(readRegistration().updatedAt, startedAt + 5000);
  time.tick(5000);
  assert.equal(readRegistration().updatedAt, startedAt + 10_000);
  assert.equal(readRegistration().startedAt, startedAt);
});

// ───── 出错和接管 ─────

test("when tasks.list keeps failing the interface still gets tasks messages with the error", async (t) => {
  const session = new FakeSession();
  session.overrides.list = async () => {
    throw new Error("rpc closed");
  };
  const { time, deps, connect } = await launch(t, { session });
  const client = await connect();
  await client.take(3);
  time.tick(1000);
  const message = (await client.takeMatching(isTasks)) as TasksMessage;
  assert.equal(message.error?.step, "tasks.list");
  assert.equal(message.error?.message, "rpc closed");
  assert.ok(deps.lines.some((l) => l.startsWith("tasks.list: rpc closed")), "also written to stderr");
});

test("a session that cannot be subscribed to, an rpc that is missing, and odd events do not stop the extension", async (t) => {
  const session = new FakeSession();
  session.on = () => {
    throw new Error("no subscriptions today");
  };
  Object.defineProperty(session, "rpc", {
    get() {
      throw new Error("rpc not ready");
    },
  });
  const { time, handle, connect, deps } = await launch(t, { session });
  const client = await connect();
  await client.take(3);
  time.tick(1000);
  const message = (await client.takeMatching(isTasks)) as TasksMessage;
  assert.ok(message.error, "an error is reported");
  assert.ok(deps.lines.some((l) => l.startsWith("session.on: no subscriptions today")), deps.lines.join("\n"));
  client.send(request("r1", "cancel", "a1"));
  const result = await client.takeMatching(isResult);
  assert.equal(result.type === "result" && !result.ok && result.reason, "扩展调用 tasks.cancel 出错：rpc not ready");
  await handle.stop();
});

test("events with the wrong shape are ignored without throwing", async (t) => {
  const { session, read } = await launch(t);
  const odd = [null, undefined, 5, "text", { type: "tool.shell_output" }, { type: "assistant.usage", data: [] }, { type: "tool.execution_start", data: { toolCallId: {} } }];
  for (const event of odd) assert.doesNotThrow(() => session.emit(event as never));
  session.emit(shellOutput("still-works", 0, "ok"));
  assert.equal(read("still-works"), "ok");
});

test("a failing setup does not stop startPanes: the problem is logged and the rest keeps working", async (t) => {
  const tmp = tempDir("m");
  const time = new FakeTime();
  const deps = makeDeps(tmp.path, time);
  // data/sessions 是个普通文件：建不了目录，也开不了 socket，写不了登记记录
  mkdirSync(deps.dataDir, { recursive: true });
  writeFileSync(sessionsDir(deps.dataDir), "in the way");
  const session = new FakeSession();
  const handle: PanesHandle = await startPanes(session, deps);
  t.after(async () => {
    await handle.stop();
    tmp.cleanup();
  });
  assert.ok(deps.lines.some((l) => l.startsWith("setup.dirs:")), deps.lines.join("\n"));
  assert.ok(deps.lines.some((l) => l.startsWith("socket.listen:")), deps.lines.join("\n"));
  assert.ok(deps.lines.some((l) => l.startsWith("registration.write:")), deps.lines.join("\n"));
  session.emit(shellOutput("c1", 0, "output still saved"));
  assert.equal(readFileSync(outPath(deps.dataDir, "s1", "c1"), "utf8"), "output still saved");
  time.tick(10_000);
  await handle.stop();
});

test("leftovers of a killed process (socket file and registration) are taken over by the new process", async (t) => {
  const tmp = tempDir("m");
  t.after(tmp.cleanup);
  const time = new FakeTime(1_700_000_000_000);
  const deps = makeDeps(tmp.path, time);
  mkdirSync(sessionsDir(deps.dataDir), { recursive: true });

  // 旧进程被 SIGKILL：socket 文件还在但没人监听，登记记录是它的
  const socketPath = join(sessionsDir(deps.dataDir), "s1.sock");
  const ghost = net.createServer();
  await new Promise<void>((resolve) => ghost.listen(socketPath, resolve));
  renameSync(socketPath, `${socketPath}.moved`);
  ghost.close();
  renameSync(`${socketPath}.moved`, socketPath);
  const stale: Registration = {
    v: REGISTRATION_VERSION,
    protocol: PROTOCOL_VERSION,
    sessionId: "s1",
    copilotPid: process.pid,
    extensionPid: 1,
    tmuxPane: null,
    cwd: "/old",
    socketPath,
    extensionVersion: "old",
    startedAt: 1_699_000_000_000,
    updatedAt: 1_699_000_000_000,
  };
  writeFileSync(registrationPath(deps.dataDir, "s1"), JSON.stringify(stale));
  await assert.rejects(TestClient.connect(socketPath), /ECONNREFUSED/);

  const handle = await startPanes(new FakeSession(), deps);
  t.after(() => handle.stop());
  const client = await TestClient.connect(handle.socketPath);
  const [hello] = await client.take(3);
  assert.equal(hello?.type === "hello" && hello.extensionPid, 4243);
  const parsed = parseRegistration(readFileSync(registrationPath(deps.dataDir, "s1"), "utf8"));
  assert.ok(parsed.ok);
  assert.equal(parsed.value.extensionPid, 4243);
  assert.equal(parsed.value.extensionVersion, "9.9.9");
  await client.close();
});

test("a reloaded extension (new process, same session) takes over while the old one is still alive, and the old one's stop() leaves it intact", async (t) => {
  const tmp = tempDir("m");
  t.after(tmp.cleanup);
  const time = new FakeTime(1_700_000_000_000);
  const deps = makeDeps(tmp.path, time);
  const oldHandle = await startPanes(new FakeSession(), { ...deps, pid: 5001 });
  time.tick(3000);
  const newHandle = await startPanes(new FakeSession(), { ...deps, pid: 5002 });
  t.after(() => newHandle.stop());

  time.tick(5000);
  await oldHandle.stop();
  assert.equal(existsSync(newHandle.socketPath), true);
  const parsed = parseRegistration(readFileSync(registrationPath(deps.dataDir, "s1"), "utf8"));
  assert.ok(parsed.ok);
  assert.equal(parsed.value.extensionPid, 5002);
  const client = await TestClient.connect(newHandle.socketPath);
  const [hello] = await client.take(3);
  assert.equal(hello?.type === "hello" && hello.extensionPid, 5002);
  await client.close();
});

test("two seconds after start the cleanup removes old output directories and dead registrations but not its own", async (t) => {
  const tmp = tempDir("m");
  t.after(tmp.cleanup);
  const time = new FakeTime(Date.now());
  const deps = makeDeps(tmp.path, time);
  const oldOut = outDir(deps.dataDir, "old-session");
  mkdirSync(oldOut, { recursive: true });
  const longAgo = (Date.now() - 10 * 24 * 3600 * 1000) / 1000;
  utimesSync(oldOut, longAgo, longAgo);
  const deadRegistration = registrationPath(deps.dataDir, "dead-session");
  mkdirSync(sessionsDir(deps.dataDir), { recursive: true });
  writeFileSync(
    deadRegistration,
    JSON.stringify({ v: 1, protocol: 1, sessionId: "dead-session", copilotPid: 999_999_999, extensionPid: 999_999_998, tmuxPane: null, cwd: "/", socketPath: join(tmp.path, "none.sock"), extensionVersion: "0", startedAt: 1, updatedAt: 1 }),
  );
  const handle = await startPanes(new FakeSession(), deps);
  t.after(() => handle.stop());

  time.tick(1999);
  assert.equal(existsSync(oldOut), true);
  time.tick(1);
  assert.equal(existsSync(oldOut), false);
  assert.equal(existsSync(deadRegistration), false);
  assert.equal(existsSync(registrationPath(deps.dataDir, "s1")), true);
  assert.equal(existsSync(handle.socketPath), true);
});

test("a data directory so deep that the socket path is too long falls back to the runtime directory", async (t) => {
  const tmp = tempDir("m");
  t.after(tmp.cleanup);
  const time = new FakeTime();
  const deps = makeDeps(tmp.path, time);
  deps.dataDir = join(tmp.path, "a-rather-long-directory-name-to-push-the-socket-path-over-the-limit", "data");
  const handle = await startPanes(new FakeSession(), deps);
  t.after(() => handle.stop());

  assert.equal(handle.socketPath.startsWith(socketFallbackDir(deps.socketOptions)!), true);
  const registration = parseRegistration(readFileSync(registrationPath(deps.dataDir, "s1"), "utf8"));
  assert.ok(registration.ok);
  assert.equal(registration.value.socketPath, handle.socketPath);
  assert.equal(statSync(socketFallbackDir(deps.socketOptions)!).mode & 0o777, 0o700);
  const client = await TestClient.connect(handle.socketPath);
  assert.equal((await client.take(3))[0]?.type, "hello");
  await client.close();
  await handle.stop();
  assert.equal(existsSync(handle.socketPath), false);
});

test("without XDG_RUNTIME_DIR a too-long socket path goes into a mkdtemp directory (random name, 0700) that is named in the registration and removed on stop", async (t) => {
  const tmp = tempDir("m");
  t.after(tmp.cleanup);
  const time = new FakeTime();
  const deps = makeDeps(tmp.path, time);
  deps.dataDir = join(tmp.path, "a-rather-long-directory-name-to-push-the-socket-path-over-the-limit", "data");
  deps.socketOptions = { runtimeDir: null, tmpDir: tmp.path, uid };
  // 别的用户先建好的、名字猜得到的旧式目录不会被用，也不会被改
  const decoy = join(tmp.path, `copilot-panes-${uid}`);
  mkdirSync(decoy, { mode: 0o777 });
  chmodSync(decoy, 0o777);
  const handle = await startPanes(new FakeSession(), deps);
  t.after(() => handle.stop());

  assert.equal(handle.listening, true);
  const dir = dirname(handle.socketPath);
  assert.match(basename(dir), new RegExp(`^copilot-panes-${uid}-[A-Za-z0-9]{6}$`));
  assert.equal(dirname(dir), tmp.path);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.equal(statSync(decoy).mode & 0o777, 0o777, "the guessable directory is left alone");
  assert.equal(existsSync(join(decoy, "s.sock")), false);
  const registration = parseRegistration(readFileSync(registrationPath(deps.dataDir, "s1"), "utf8"));
  assert.ok(registration.ok);
  assert.equal(registration.value.socketPath, handle.socketPath);
  const client = await TestClient.connect(handle.socketPath);
  assert.equal((await client.take(3))[0]?.type, "hello");
  await client.close();
  await handle.stop();
  assert.equal(existsSync(dir), false, "the directory it made is removed");
});

test("when the socket cannot be opened the registration says socketPath: null, the extension keeps working, and it retries every five seconds until it succeeds", async (t) => {
  const tmp = tempDir("m");
  t.after(tmp.cleanup);
  const time = new FakeTime();
  const deps = makeDeps(tmp.path, time);
  // 路径上已经有一个目录：删不掉它，listen 失败
  const blocked = join(sessionsDir(deps.dataDir), "s1.sock");
  mkdirSync(blocked, { recursive: true });
  const session = new FakeSession();
  const handle = await startPanes(session, deps);
  t.after(() => handle.stop());
  const read = () => {
    const parsed = parseRegistration(readFileSync(registrationPath(deps.dataDir, "s1"), "utf8"));
    assert.ok(parsed.ok);
    return parsed.value;
  };

  assert.equal(handle.listening, false);
  assert.equal(read().socketPath, null);
  assert.ok(deps.lines.some((l) => l.startsWith("socket.listen:")), deps.lines.join("\n"));
  session.emit(shellOutput("c1", 0, "output is still saved"));
  assert.equal(readFileSync(outPath(deps.dataDir, "s1", "c1"), "utf8"), "output is still saved");

  time.tick(5000);
  await settle();
  assert.equal(handle.listening, false, "still blocked");
  rmSync(blocked, { recursive: true });
  time.tick(5000);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(handle.listening, true);
  assert.equal(read().socketPath, handle.socketPath);
  const client = await TestClient.connect(handle.socketPath);
  assert.equal((await client.take(3))[0]?.type, "hello");
  await client.close();
});

test("with no interface connected tasks.list is called every five seconds instead of every second, and a new connection triggers one at once", async (t) => {
  const { time, session, connect } = await launch(t);
  const lists = () => session.callsOf("list").length;
  const before = lists();
  for (let i = 0; i < 10; i++) {
    time.tick(1000);
    await settle();
  }
  assert.ok(lists() - before <= 2 + 1, `polled ${lists() - before} times in 10 idle seconds`);
  const beforeConnect = lists();
  const client = await connect();
  await client.take(3);
  await settle();
  assert.ok(lists() > beforeConnect, "a new connection refreshes the task list");
  const connected = lists();
  for (let i = 0; i < 4; i++) {
    time.tick(1000);
    await settle();
  }
  assert.ok(lists() - connected >= 4, "every second while an interface is connected");
});

test("sessions/, out/ and out/<session> are tightened to 0700 when they already exist with looser permissions; the data directory itself is left alone", async (t) => {
  const tmp = tempDir("m");
  t.after(tmp.cleanup);
  const time = new FakeTime();
  const deps = makeDeps(tmp.path, time);
  deps.socketOptions = { ...deps.socketOptions, uid };
  for (const dir of [deps.dataDir, sessionsDir(deps.dataDir), join(deps.dataDir, "out"), outDir(deps.dataDir, "s1")]) {
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o755);
  }
  const handle = await startPanes(new FakeSession(), deps);
  t.after(() => handle.stop());
  const mode = (path: string) => statSync(path).mode & 0o777;
  assert.equal(mode(sessionsDir(deps.dataDir)), 0o700);
  assert.equal(mode(join(deps.dataDir, "out")), 0o700);
  assert.equal(mode(outDir(deps.dataDir, "s1")), 0o700);
  assert.equal(mode(deps.dataDir), 0o755, "the data directory may be a directory the user shares with other things");
  assert.equal(mode(registrationPath(deps.dataDir, "s1")), 0o600);
  assert.equal(mode(handle.socketPath), 0o600);
});
