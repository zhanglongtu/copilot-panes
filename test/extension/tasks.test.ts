import assert from "node:assert/strict";
import { test } from "node:test";
import { ErrorLog } from "../../extension/src/errors.ts";
import { ShellCallBook } from "../../extension/src/shells.ts";
import { TaskPublisher, trimTask } from "../../extension/src/tasks.ts";
import type { TasksRpc } from "../../extension/src/sdk.ts";
import type { TaskAgentInfo, TaskInfo, TasksMessage } from "../../src/protocol.ts";
import { bashStart, FakeSession, FakeTime, shellTask } from "./fake.ts";

function setup(options: { listTimeoutMs?: number } = {}) {
  const time = new FakeTime();
  const session = new FakeSession();
  const errors = new ErrorLog(time);
  const shells = new ShellCallBook(100, () => time.now());
  const rpc: TasksRpc = session.rpc.tasks;
  const publisher = new TaskPublisher({ rpc, shells, clock: time, errors, keepaliveMs: 5000, textMaxChars: 20, ...options });
  return { time, session, errors, shells, publisher };
}

const agent = (id: string, extra: Partial<TaskAgentInfo> = {}): TaskAgentInfo => ({
  type: "agent",
  id,
  toolCallId: `call-${id}`,
  description: "d",
  status: "running",
  startedAt: "2026-11-16T05:00:00.000Z",
  agentType: "explore",
  prompt: "p",
  ...extra,
});

async function pollAndSend(publisher: TaskPublisher, force = false): Promise<TasksMessage | null> {
  const message = await publisher.poll(force);
  if (message) publisher.markSent(message);
  return message;
}

test("a changed task list is pushed and an unchanged one is not, until the keepalive interval has passed", async () => {
  const { time, session, publisher } = setup();
  session.tasks = [agent("a1")];
  const first = await pollAndSend(publisher);
  assert.equal(first?.type, "tasks");
  assert.deepEqual(first?.tasks.map((t) => t.id), ["a1"]);

  time.tick(1000);
  assert.equal(await pollAndSend(publisher), null);
  time.tick(3999);
  assert.equal(await pollAndSend(publisher), null);
  time.tick(1);
  const keepalive = await pollAndSend(publisher);
  assert.equal(keepalive?.at, time.now());

  session.tasks = [agent("a1", { status: "idle" })];
  time.tick(1000);
  const changed = await pollAndSend(publisher);
  assert.equal(changed?.tasks[0]?.status, "idle");
  assert.equal(await pollAndSend(publisher), null);
});

test("a poll whose result was not marked as sent is offered again", async () => {
  const { session, publisher } = setup();
  session.tasks = [agent("a1")];
  assert.notEqual(await publisher.poll(), null);
  assert.notEqual(await publisher.poll(), null);
});

test("when tasks.list fails the last good list is pushed with the error", async () => {
  const { time, session, errors, publisher } = setup();
  session.tasks = [agent("a1")];
  await pollAndSend(publisher);

  session.overrides.list = async () => {
    throw new Error("rpc closed");
  };
  time.tick(1000);
  const failed = await pollAndSend(publisher);
  assert.deepEqual(failed?.tasks.map((t) => t.id), ["a1"]);
  assert.equal(failed?.error?.step, "tasks.list");
  assert.equal(failed?.error?.message, "rpc closed");
  assert.equal(errors.last()?.step, "tasks.list");

  // 一直失败：同一个错误再来一次（at 不同）也会推一次，但内容没变化的保活仍按 5 秒算
  time.tick(1000);
  assert.notEqual(await pollAndSend(publisher), null);
});

test("a first failure pushes an empty list with the error; a missing method or a malformed answer is a failure too", async () => {
  const { session, publisher } = setup();
  session.overrides.list = async () => {
    throw new TypeError("session.rpc.tasks.list is not a function");
  };
  const first = await pollAndSend(publisher);
  assert.deepEqual(first?.tasks, []);
  assert.match(first?.error?.message ?? "", /not a function/);

  session.overrides.list = async () => ({ nothing: true });
  const second = await pollAndSend(publisher);
  assert.match(second?.error?.message ?? "", /没有 tasks 数组/);
});

test("a poll that starts while the previous one is still running does nothing", async () => {
  const { session, publisher } = setup();
  let release: () => void = () => {};
  session.overrides.list = () =>
    new Promise((resolve) => {
      release = () => resolve({ tasks: [agent("a1")] });
    });
  const slow = publisher.poll();
  assert.equal(await publisher.poll(), null);
  assert.equal(session.callsOf("list").length, 1);
  release();
  assert.deepEqual((await slow)?.tasks.map((t) => t.id), ["a1"]);
  // 做完之后又能查了
  session.overrides.list = async () => ({ tasks: [] });
  assert.notEqual(await publisher.poll(), null);
});

test("a forced poll waits for the running one, then queries again and always returns a message", async () => {
  const { session, publisher } = setup();
  let release: () => void = () => {};
  session.overrides.list = () =>
    new Promise((resolve) => {
      release = () => resolve({ tasks: [] });
    });
  const slow = publisher.poll();
  const forced = publisher.poll(true);
  session.overrides.list = async () => ({ tasks: [agent("a2")] });
  release();
  await slow;
  const message = await forced;
  assert.deepEqual(message?.tasks.map((t) => t.id), ["a2"]);
  assert.equal(session.callsOf("list").length, 2);

  publisher.markSent(message!);
  assert.notEqual(await publisher.poll(true), null);
});

test("a tasks.list that never returns is given up on after the timeout", async () => {
  const { session, publisher } = setup({ listTimeoutMs: 20 });
  session.overrides.list = () => new Promise(() => {});
  const message = await publisher.poll();
  assert.match(message?.error?.message ?? "", /没有返回/);
  session.overrides.list = async () => ({ tasks: [agent("a1")] });
  assert.deepEqual((await publisher.poll())?.tasks.map((t) => t.id), ["a1"]);
});

test("shell tasks are matched to the calls the book has seen, and the match survives while the task stays", async () => {
  const { time, session, shells, publisher } = setup();
  shells.onEvent(bashStart("call-make", "make", {}, { timestamp: new Date(time.now()).toISOString() }));
  session.tasks = [shellTask("3", "make", new Date(time.now() + 50).toISOString())];
  const first = await pollAndSend(publisher);
  assert.deepEqual(first?.shellCalls, { "3": "call-make" });
  time.tick(1000);
  session.tasks = [shellTask("3", "make", new Date(time.now() - 950).toISOString(), { pid: 99 })];
  const second = await pollAndSend(publisher);
  assert.deepEqual(second?.shellCalls, { "3": "call-make" });
  assert.equal((second?.tasks[0] as { pid?: number }).pid, 99);
});

test("client tasks are forwarded as they are, entries that are not tasks are dropped, and long text is cut", async () => {
  const { session, publisher } = setup();
  const client = { type: "client", id: "k1", clientTaskId: "x", description: "ext task", status: "running" } as unknown as TaskInfo;
  session.tasks = [agent("a1", { result: "r".repeat(50) }), client, null as unknown as TaskInfo, "oops" as unknown as TaskInfo];
  const message = await publisher.poll();
  assert.deepEqual(message?.tasks.map((t) => t.id), ["a1", "k1"]);
  assert.equal((message?.tasks[0] as TaskAgentInfo).result, `${"r".repeat(20)}…`);
});

test("latest() starts empty and then follows the newest poll, with the current error", async () => {
  const { session, errors, publisher } = setup();
  assert.deepEqual(publisher.latest().tasks, []);
  assert.equal(publisher.latest().error, null);
  session.tasks = [agent("a1")];
  await publisher.poll();
  assert.deepEqual(publisher.latest().tasks.map((t) => t.id), ["a1"]);
  errors.record("output.append", "disk full");
  assert.equal(publisher.latest().error?.step, "output.append");
});

test("trimTask cuts long text fields and leaves everything else untouched", () => {
  const original = agent("a1", { prompt: "p".repeat(30), result: "short", latestResponse: "😀".repeat(8), error: "e".repeat(21), description: "d".repeat(20) });
  const trimmed = trimTask(original, 20) as TaskAgentInfo;
  assert.equal(trimmed.prompt, `${"p".repeat(20)}…`);
  assert.equal(trimmed.result, "short");
  // 8 个 emoji 是 16 个 UTF-16 单元，没超过 20，原样保留
  assert.equal(trimmed.latestResponse, "😀".repeat(8));
  assert.equal(trimmed.error, `${"e".repeat(20)}…`);
  assert.equal(trimmed.description, "d".repeat(20));
  assert.equal(trimmed.id, "a1");
  assert.notEqual(trimmed, original);
  assert.equal(original.prompt.length, 30);

  const split = trimTask(agent("a2", { prompt: `${"x".repeat(19)}😀tail` }), 20) as TaskAgentInfo;
  assert.equal(split.prompt, `${"x".repeat(19)}…`);

  const shell = trimTask(shellTask("1", "c".repeat(40), "t", { pid: 5 }), 20);
  assert.equal(shell.type === "shell" && shell.command, "c".repeat(40));
  assert.equal(shell.description, `${"c".repeat(20)}…`);
});
