import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { buildDeps, realHost, runWithSession } from "../../extension/src/bootstrap.ts";
import type { HostEnvironment, ProcessEvent } from "../../extension/src/bootstrap.ts";
import { registrationPath } from "../../src/paths.ts";
import { version } from "../../src/version.ts";
import type { TasksMessage } from "../../src/protocol.ts";
import { tempDir } from "../helpers/tmp.ts";
import { FakeSession, FakeTime, shellOutput, TestClient } from "./fake.ts";

function fakeHost(root: string, time: FakeTime, env: Record<string, string> = {}) {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  const stderr: string[] = [];
  const exits: number[] = [];
  const host: HostEnvironment = {
    env: { COPILOT_PANES_HOME: join(root, "d"), XDG_RUNTIME_DIR: root, ...env },
    pid: 4243,
    ppid: process.pid,
    cwd: "/work/demo",
    homeDir: join(root, "home"),
    tmpDir: root,
    uid: 1000,
    clock: time,
    timers: time,
    isPidAlive: (pid) => pid === process.pid,
    writeStderr: (text) => stderr.push(text),
    onProcess: (event, listener) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
    },
    exit: (code) => exits.push(code),
  };
  const fire = (event: ProcessEvent, ...args: unknown[]) => {
    for (const l of listeners.get(event) ?? []) l(...args);
  };
  return { host, listeners, stderr, exits, fire };
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

test("buildDeps takes the Copilot CLI pid from COPILOT_EXTENSION_PARENT_PID, then from the parent process", () => {
  const time = new FakeTime();
  const withVar = fakeHost("/r", time, { COPILOT_EXTENSION_PARENT_PID: "777", TMUX_PANE: "%9" });
  const deps = buildDeps(withVar.host);
  assert.equal(deps.copilotPid, 777);
  assert.equal(deps.tmuxPane, "%9");
  assert.equal(deps.pid, 4243);
  assert.equal(deps.cwd, "/work/demo");
  assert.equal(deps.version, version);
  assert.deepEqual(deps.socketOptions, { runtimeDir: "/r", tmpDir: "/r", uid: 1000 });

  for (const bad of ["", "abc", "-5", "0", "1.5"]) {
    assert.equal(buildDeps(fakeHost("/r", time, { COPILOT_EXTENSION_PARENT_PID: bad }).host).copilotPid, process.pid, `value ${JSON.stringify(bad)}`);
  }
  assert.equal(buildDeps(fakeHost("/r", time).host).tmuxPane, null);
});

test("buildDeps puts the data directory where paths.ts says: COPILOT_PANES_HOME, then COPILOT_HOME, then ~/.copilot", () => {
  const time = new FakeTime();
  const pick = (env: Record<string, string>) => {
    const fake = fakeHost("/r", time);
    return buildDeps({ ...fake.host, env: { ...env } }).dataDir;
  };
  assert.equal(pick({ COPILOT_PANES_HOME: "/data" }), "/data");
  assert.equal(pick({ COPILOT_HOME: "/ch" }), "/ch/copilot-panes");
  assert.equal(pick({}), "/r/home/.copilot/copilot-panes");
  assert.equal(buildDeps({ ...fakeHost("/r", time).host, env: {} }).socketOptions.runtimeDir, null);
});

test("the real host tells live pids from dead ones", () => {
  const host = realHost();
  assert.equal(host.isPidAlive(process.pid), true);
  assert.equal(host.isPidAlive(2 ** 22 + 12345), false);
});

test("SIGTERM stops the extension, removes its files and exits once, even when more signals follow", async (t) => {
  const tmp = tempDir("b");
  t.after(tmp.cleanup);
  const time = new FakeTime();
  const { host, exits, fire, listeners } = fakeHost(tmp.path, time);
  const handle = await runWithSession(new FakeSession("s1"), host);
  assert.deepEqual([...listeners.keys()].sort(), ["SIGHUP", "SIGINT", "SIGTERM", "exit", "uncaughtException", "unhandledRejection"]);
  const registration = registrationPath(join(tmp.path, "d"), "s1");
  assert.equal(existsSync(registration), true);
  assert.equal(existsSync(handle.socketPath), true);

  fire("SIGTERM");
  fire("SIGINT");
  await settle();
  await settle();
  assert.deepEqual(exits, [0]);
  assert.equal(existsSync(registration), false);
  assert.equal(existsSync(handle.socketPath), false);
  fire("SIGHUP");
  await settle();
  assert.deepEqual(exits, [0]);
  // 之后收到 exit 事件也没有东西可清了
  fire("exit", 0);
});

test("a SIGTERM that arrives while the extension is still starting waits for the start to finish, then cleans up", async (t) => {
  const tmp = tempDir("b");
  t.after(tmp.cleanup);
  const { host, exits, fire } = fakeHost(tmp.path, new FakeTime());
  const starting = runWithSession(new FakeSession("s1"), host);
  fire("SIGTERM");
  await starting;
  await settle();
  await settle();
  assert.deepEqual(exits, [0]);
  assert.equal(existsSync(registrationPath(join(tmp.path, "d"), "s1")), false);
  assert.equal(existsSync(join(tmp.path, "d", "sessions", "s1.sock")), false);
});

test("a process exit without a signal (the SDK's watchdog calls process.exit) still removes the files synchronously", async (t) => {
  const tmp = tempDir("b");
  t.after(tmp.cleanup);
  const { host, exits, fire } = fakeHost(tmp.path, new FakeTime());
  const handle = await runWithSession(new FakeSession("s1"), host);
  t.after(() => handle.stop()); // fire("exit") 只删文件，socket 服务还开着
  fire("exit", 0);
  assert.equal(existsSync(registrationPath(join(tmp.path, "d"), "s1")), false);
  assert.equal(existsSync(handle.socketPath), false);
  assert.deepEqual(exits, [], "the exit handler does not call exit again");
});

test("uncaught exceptions and unhandled rejections are only recorded: no exit, a stderr line, and the error reaches the interface", async (t) => {
  const tmp = tempDir("b");
  t.after(tmp.cleanup);
  const time = new FakeTime();
  const { host, exits, stderr, fire } = fakeHost(tmp.path, time);
  const handle = await runWithSession(new FakeSession("s1"), host);
  t.after(() => handle.stop());
  const client = await TestClient.connect(handle.socketPath);
  t.after(() => client.close());
  await client.take(3);

  fire("uncaughtException", new Error("kaboom"));
  fire("unhandledRejection", "plain string reason");
  assert.deepEqual(exits, []);
  assert.equal(stderr.length, 2);
  assert.match(stderr[0] ?? "", /uncaught: kaboom/);
  assert.match(stderr[1] ?? "", /unhandled\.rejection: plain string reason/);
  assert.ok(stderr.every((line) => line.endsWith("\n")));

  time.tick(1000);
  const message = (await client.takeMatching((m) => m.type === "tasks")) as TasksMessage;
  assert.equal(message.error?.step, "unhandled.rejection");
  assert.equal(message.error?.message, "plain string reason");
});

test("errors raised before the extension has started are written to stderr and do not need a handle", async (t) => {
  const tmp = tempDir("b");
  t.after(tmp.cleanup);
  const { host, stderr, fire } = fakeHost(tmp.path, new FakeTime());
  const starting = runWithSession(new FakeSession("s1"), host);
  fire("uncaughtException", new Error("too early"));
  const handle = await starting;
  t.after(() => handle.stop());
  assert.match(stderr[0] ?? "", /too early/);
});

test("output recorded through the bootstrap path ends up in the data directory of the host", async (t) => {
  const tmp = tempDir("b");
  t.after(tmp.cleanup);
  const session = new FakeSession("s1");
  const { host } = fakeHost(tmp.path, new FakeTime());
  const handle = await runWithSession(session, host);
  t.after(() => handle.stop());
  session.emit(shellOutput("c1", 0, "hello\n"));
  assert.equal(readFileSync(join(tmp.path, "d", "out", "s1", "c1.out"), "utf8"), "hello\n");
});
