import assert from "node:assert/strict";
import { test } from "node:test";
import { runRequest } from "../../extension/src/actions.ts";
import { request, FakeSession } from "./fake.ts";
import type { ResultMessage } from "../../src/protocol.ts";

const reasonOf = (result: ResultMessage) => (result.ok ? null : result.reason);

test("each request op calls the matching tasks method with the task id", async () => {
  const session = new FakeSession();
  const refresh = async () => {};
  const rpc = session.rpc.tasks;

  assert.deepEqual(await runRequest(rpc, request("r1", "sendMessage", "a1", "hello there"), refresh), { type: "result", v: 1, requestId: "r1", ok: true });
  assert.deepEqual(await runRequest(rpc, request("r2", "cancel", "a1"), refresh), { type: "result", v: 1, requestId: "r2", ok: true });
  assert.deepEqual(await runRequest(rpc, request("r3", "promoteToBackground", "s7"), refresh), { type: "result", v: 1, requestId: "r3", ok: true });
  assert.deepEqual(await runRequest(rpc, request("r4", "remove", "a2"), refresh), { type: "result", v: 1, requestId: "r4", ok: true });

  assert.deepEqual(session.callsOf("sendMessage"), [{ id: "a1", message: "hello there", fromAgentId: "" }]);
  assert.deepEqual(session.callsOf("cancel"), [{ id: "a1" }]);
  assert.deepEqual(session.callsOf("promoteToBackground"), [{ id: "s7" }]);
  assert.deepEqual(session.callsOf("remove"), [{ id: "a2" }]);
});

test("a refused send, cancel, promote or remove gives the sentence written in actions.ts", async () => {
  const session = new FakeSession();
  const rpc = session.rpc.tasks;
  const refresh = async () => {};

  session.overrides.sendMessage = async () => ({ sent: false, error: "Agent task xyz not found" });
  assert.equal(reasonOf(await runRequest(rpc, request("r", "sendMessage", "a1", "hi"), refresh)), "它已经不在 Copilot CLI 的任务列表里，收不到消息");
  session.overrides.sendMessage = async () => ({ sent: false, error: "Agent is Not Accepting messages" });
  assert.equal(reasonOf(await runRequest(rpc, request("r", "sendMessage", "a1", "hi"), refresh)), "它已经不在 Copilot CLI 的任务列表里，收不到消息");
  session.overrides.sendMessage = async () => ({ sent: false, error: "queue full\nretry later" });
  assert.equal(reasonOf(await runRequest(rpc, request("r", "sendMessage", "a1", "hi"), refresh)), "没送到：queue full retry later");
  session.overrides.sendMessage = async () => ({ sent: false });
  assert.equal(reasonOf(await runRequest(rpc, request("r", "sendMessage", "a1", "hi"), refresh)), "没送到：Copilot CLI 没有说明原因");

  session.overrides.cancel = async () => ({ cancelled: false });
  assert.equal(reasonOf(await runRequest(rpc, request("r", "cancel", "a1"), refresh)), "没停掉：Copilot CLI 说它已经不在跑了");
  session.overrides.promoteToBackground = async () => ({ promoted: false });
  assert.equal(reasonOf(await runRequest(rpc, request("r", "promoteToBackground", "s1"), refresh)), "没转后台：它已经在后台，或者已经结束");
  session.overrides.remove = async () => ({ removed: false });
  assert.equal(reasonOf(await runRequest(rpc, request("r", "remove", "a1"), refresh)), "没移除：它还在跑，或者已经被移除了");
});

test("an exception from the SDK becomes a one-line reason instead of being thrown", async () => {
  const session = new FakeSession();
  const rpc = session.rpc.tasks;
  const refresh = async () => {};

  session.overrides.cancel = async () => {
    throw new Error("connection\nclosed");
  };
  assert.equal(reasonOf(await runRequest(rpc, request("r", "cancel", "a1"), refresh)), "扩展调用 tasks.cancel 出错：connection closed");

  // 方法同步抛异常、方法不存在、返回的不是对象
  session.overrides.remove = () => {
    throw new TypeError("rpc.tasks.remove is not a function");
  };
  assert.equal(reasonOf(await runRequest(rpc, request("r", "remove", "a1"), refresh)), "扩展调用 tasks.remove 出错：rpc.tasks.remove is not a function");
  const missing = { ...rpc, sendMessage: undefined } as unknown as typeof rpc;
  assert.match(reasonOf(await runRequest(missing, request("r", "sendMessage", "a1", "hi"), refresh)) ?? "", /^扩展调用 tasks\.sendMessage 出错：/);
  session.overrides.promoteToBackground = async () => null as never;
  assert.equal(reasonOf(await runRequest(rpc, request("r", "promoteToBackground", "s1"), refresh)), "没转后台：它已经在后台，或者已经结束");
});

test("a call that never answers fails with a reason before the interface gives up", async () => {
  const session = new FakeSession();
  session.overrides.cancel = () => new Promise(() => {});
  const result = await runRequest(session.rpc.tasks, request("r", "cancel", "a1"), async () => {}, 30);
  assert.match(reasonOf(result) ?? "", /^扩展调用 tasks\.cancel 出错：.*没有回应/);
  assert.equal(result.type === "result" && !result.ok && result.uncertain, true, "the call may still complete, so the result says so");
  // 别的失败（SDK 抛异常、明确拒绝）是确定的，不带 uncertain
  session.overrides.cancel = async () => {
    throw new Error("boom");
  };
  const thrown = await runRequest(session.rpc.tasks, request("r", "cancel", "a1"), async () => {}, 30);
  assert.equal(thrown.type === "result" && !thrown.ok && thrown.uncertain, undefined);
});

test("refresh runs after a successful action and for refreshTasks, but not after a refusal", async () => {
  const session = new FakeSession();
  const rpc = session.rpc.tasks;
  let refreshes = 0;
  const refresh = async () => {
    refreshes += 1;
  };

  await runRequest(rpc, request("r1", "cancel", "a1"), refresh);
  assert.equal(refreshes, 1);
  session.overrides.remove = async () => ({ removed: false });
  await runRequest(rpc, request("r2", "remove", "a1"), refresh);
  assert.equal(refreshes, 1);
  assert.deepEqual(await runRequest(rpc, request("r3", "refreshTasks"), refresh), { type: "result", v: 1, requestId: "r3", ok: true });
  assert.equal(refreshes, 2);
  assert.equal(session.calls.length, 2, "refreshTasks does not call any tasks method itself");
});

test("a failing refresh fails refreshTasks but not an action that already succeeded", async () => {
  const session = new FakeSession();
  const refresh = async () => {
    throw new Error("list is down");
  };
  assert.equal(reasonOf(await runRequest(session.rpc.tasks, request("r1", "refreshTasks"), refresh)), "扩展刷新任务列表出错：list is down");
  assert.deepEqual(await runRequest(session.rpc.tasks, request("r2", "cancel", "a1"), refresh), { type: "result", v: 1, requestId: "r2", ok: true });
  // 给没处理的拒绝一个机会冒出来：node:test 会把它算作失败
  await new Promise((resolve) => setImmediate(resolve));
});
