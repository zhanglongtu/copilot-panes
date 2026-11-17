// 子 agent 的状态：归属、结束、停止、唤醒、消息发送者和回复。
import assert from "node:assert/strict";
import { test } from "node:test";
import { agentElapsedMs } from "../../src/model/merge.ts";
import { SessionStore } from "../../src/model/store.ts";
import type { EndItem, MessageItem } from "../../src/types/model.ts";
import { BASE, bashStart, completed, ev, failedEvent, feed, say, started, storeOf, taskCall, toolStart } from "./support.ts";

function agentOf(store: SessionStore, id: string) {
  const agent = store.agent(id);
  assert.ok(agent, `agent ${id}`);
  return agent;
}

function endItems(store: SessionStore, id: string): EndItem[] {
  return store.transcript(id).filter((item): item is EndItem => item.kind === "end");
}

test("events are attributed by agent id: calls are counted per agent and the main session has no record", () => {
  const store = storeOf(
    ev("session.start", { sessionId: "S", selectedModel: "provider/large-1.0", context: { cwd: "/work/demo" } }),
    started("A", "alpha", { at: 1 }),
    started("B", "beta", { model: "provider/medium-1.0", at: 2 }),
    toolStart("c1", "view", { path: "/x/y.md" }, "A", 3),
    toolStart("c2", "grep", { pattern: "p" }, "A", 4),
    toolStart("c3", "view", { path: "/z" }, null, 5),
  );
  const a = agentOf(store, "A");
  assert.deepEqual([a.name, a.toolCalls, a.lastToolCallId], ["alpha", 2, "c2"]);
  assert.deepEqual([agentOf(store, "B").name, agentOf(store, "B").toolCalls], ["beta", 0]);
  assert.equal(store.mainModel, "provider/large-1.0");
  assert.equal(store.cwd, "/work/demo");
  assert.equal(store.transcript("A").length, 2);
  assert.deepEqual(
    store.agents().map((agent) => agent.id),
    ["A", "B"],
  );
});

test("session.model_change of the main session changes the main model, one with an agentId does not", () => {
  const store = storeOf(ev("session.start", { selectedModel: "m1" }), ev("session.model_change", { newModel: "m2" }, "A"), ev("session.model_change", { newModel: "m3" }));
  assert.equal(store.mainModel, "m3");
  feed(store, ev("session.model_change", { newModel: "m4" }, "A"));
  assert.equal(store.mainModel, "m3");
});

test("completed sets the final numbers and the elapsed time stops", () => {
  const store = storeOf(started("A", "alpha"), completed("A", "t-A", { calls: 14, tokens: 290097, ms: 75814, at: 76 }));
  const a = agentOf(store, "A");
  assert.equal(a.status, "done");
  assert.deepEqual([a.toolCalls, a.totalTokens], [14, 290097]);
  assert.equal(agentElapsedMs(a, BASE + 500_000), 75814);
  assert.equal(a.endedAt, BASE + 76_000);
});

test("the elapsed time of a running agent follows the clock", () => {
  const store = storeOf(started("A", "alpha", { at: 10 }));
  assert.equal(agentElapsedMs(agentOf(store, "A"), BASE + 70_000), 60_000);
});

test("a nested agent is linked through the task call of its parent; the first level hangs on the main session", () => {
  const store = storeOf(taskCall("t-A", null, 0), started("A", "outer", { at: 1 }), taskCall("t-B", "A", 2), started("B", "inner", { at: 3 }));
  assert.equal(agentOf(store, "A").parentId, null);
  assert.equal(agentOf(store, "B").parentId, "A");
});

test("the parent is found even when the task call is logged after subagent.started", () => {
  const store = storeOf(started("A", "outer"), started("B", "inner", { task: "t-B" }), taskCall("t-B", "A", 1));
  assert.equal(agentOf(store, "B").parentId, "A");
});

test("a failed agent keeps its error on one line", () => {
  const store = storeOf(started("A", "alpha"), failedEvent("A", "t-A", "模型超时\n重试失败", 5));
  const a = agentOf(store, "A");
  assert.equal(a.status, "failed");
  assert.equal(a.error, "模型超时 重试失败");
  assert.equal(endItems(store, "A")[0]?.error, "模型超时 重试失败");
});

test("a failure without an error message has no error text, and other error values become JSON", () => {
  const store = storeOf(started("A", "alpha"), failedEvent("A", "t-A", undefined, 5), started("B", "beta"), failedEvent("B", "t-B", { code: 7 }, 5));
  assert.equal(agentOf(store, "A").error, null);
  assert.equal(agentOf(store, "B").error, '{"code":7}');
});

test("an agent that completed and then got a subagent_cancelled abort is stopped", () => {
  const store = storeOf(started("A", "alpha"), completed("A", "t-A", { at: 5 }), ev("abort", { reason: "subagent_cancelled" }, "A", 5.01));
  assert.equal(agentOf(store, "A").status, "stopped");
  assert.deepEqual(
    endItems(store, "A").map((item) => item.status),
    ["done", "stopped"],
  );
});

test("an abort with another reason does not touch an agent", () => {
  const store = storeOf(started("A", "alpha"), ev("abort", { reason: "something_else" }, "A", 5));
  assert.equal(agentOf(store, "A").status, "running");
});

test("a completed event marked cancelled means stopped, also in the end item", () => {
  const store = storeOf(started("A", "alpha"), ev("subagent.completed", { toolCallId: "t-A", cancelled: true, totalTokens: 5 }, "A", 5));
  assert.equal(agentOf(store, "A").status, "stopped");
  assert.deepEqual(
    endItems(store, "A").map((item) => item.status),
    ["stopped"],
  );
});

test("a user abort stops running sync agents but not background ones", () => {
  const store = storeOf(started("A", "sync-one", { mode: "sync" }), started("B", "bg-one", { mode: "background" }), ev("abort", { reason: "user_abort" }, null, 3));
  assert.equal(agentOf(store, "A").status, "stopped");
  assert.equal(agentOf(store, "B").status, "running");
});

test("session.resume and session.shutdown stop whatever was running, commands included", () => {
  for (const end of ["session.resume", "session.shutdown"]) {
    const store = storeOf(started("A", "alpha"), bashStart("c1", "sleep 99", "A", 1), ev(end, {}, null, 9));
    assert.equal(agentOf(store, "A").status, "stopped", end);
    assert.deepEqual([store.command("c1")?.status, store.command("c1")?.endReason], ["stopped", "session-ended"], end);
  }
});

test("a message wakes a finished agent and the idle notice finishes it again, adding the time of the second round", () => {
  const store = storeOf(started("A", "alpha", { at: 0 }), completed("A", "t-A", { ms: 10_000, at: 10 }));
  assert.equal(agentOf(store, "A").status, "done");
  feed(store, ev("user.message", { content: "下一个任务", source: "agent-x" }, "A", 100));
  assert.equal(agentOf(store, "A").status, "running");
  assert.equal(agentElapsedMs(agentOf(store, "A"), BASE + 130_000), 40_000);
  feed(store, ev("system.notification", { content: "idle", kind: { type: "agent_idle", agentId: "A" } }, null, 120));
  assert.equal(agentOf(store, "A").status, "done");
  assert.equal(agentElapsedMs(agentOf(store, "A"), BASE + 999_000), 30_000);
});

test("an agent_idle notice for an agent that is not running changes nothing", () => {
  const store = storeOf(started("A", "alpha"), completed("A", "t-A", { at: 5 }));
  const version = store.version;
  feed(store, ev("system.notification", { kind: { type: "agent_idle", agentId: "A" } }, null, 9));
  assert.equal(store.version, version);
});

test("a user message of the main session does not change any agent", () => {
  const store = storeOf(started("A", "alpha"), ev("user.message", { content: "hi" }, null, 1));
  assert.equal(agentOf(store, "A").status, "running");
  assert.equal(store.transcript("A").length, 0);
});

test("who sent a message to an agent: you, the main session, another agent, or a system source", () => {
  const store = storeOf(started("A", "alpha"), started("B", "beta"), ev("user.message", { content: "派活" }, "A", 1));
  const sources: (string | undefined)[] = [undefined, "agent-B", "agent-S1", "system", "schedule-5", "command-0a1b2c3d-4e5f", "-", ""];
  feed(
    store,
    sources.map((source, i) => ev("user.message", { content: `m${i}`, ...(source === undefined ? {} : { source }) }, "A", 2 + i)),
  );
  const messages = store.transcript("A").filter((item): item is MessageItem => item.kind === "message");
  assert.deepEqual(
    messages.map((item) => [item.from, item.fromName]),
    [
      ["you", "你"],
      ["agent", "beta"],
      ["main", "主会话"],
      ["other", "system"],
      ["other", "schedule"],
      ["other", "command"],
      ["other", "-"],
      ["you", "你"],
    ],
  );
});

test("the last reply with text is kept for the list, cut to 600 characters, and blank replies do not replace it", () => {
  const store = storeOf(
    started("A", "alpha"),
    say("A", "  先看看  ", 1),
    say("A", "   ", 2, "只有思考"),
    say("A", "最后的结论\n细节", 3),
    say("A", "", 4),
    say(null, "主 agent 的回复", 5),
  );
  assert.equal(agentOf(store, "A").lastReply, "最后的结论\n细节");
  feed(store, say("A", "x".repeat(5000), 6));
  assert.equal(agentOf(store, "A").lastReply.length, 600);
  feed(store, say("A", `${"y".repeat(599)}😀😀`, 7));
  assert.equal(agentOf(store, "A").lastReply, "y".repeat(599));
});

test("subagent.configured fills in the model when subagent.started had none, and never replaces one", () => {
  const store = storeOf(
    ev("subagent.started", { toolCallId: "t-A", agentDisplayName: "alpha" }, "A", 1),
    ev("subagent.configured", { model: "provider/medium-1.0" }, "A", 1.1),
    started("B", "beta", { model: "provider/small-1.0" }),
    ev("subagent.configured", { model: "provider/medium-1.0" }, "B", 1.1),
  );
  assert.equal(agentOf(store, "A").model, "provider/medium-1.0");
  assert.equal(agentOf(store, "B").model, "provider/small-1.0");
});

test("subagent.completed replaces the model when it names one", () => {
  const store = storeOf(started("A", "alpha", { model: "m1" }), ev("subagent.completed", { toolCallId: "t-A", model: "m2" }, "A", 5));
  assert.equal(agentOf(store, "A").model, "m2");
});

test("end items keep the numbers of their own moment when an agent finishes twice", () => {
  const store = storeOf(
    started("A", "alpha", { at: 0 }),
    ev("user.message", { content: "派活" }, "A", 0.1),
    toolStart("v1", "view", { path: "/a" }, "A", 1),
    completed("A", "t-A", { calls: 3, tokens: 9000, ms: 12_000, at: 12 }),
    ev("user.message", { content: "再来一轮" }, "A", 20),
    toolStart("v2", "view", { path: "/b" }, "A", 21),
    completed("A", "t-A", { calls: 9, tokens: 30_000, ms: 99_000, at: 30 }),
  );
  const [first, second] = endItems(store, "A");
  assert.deepEqual([first?.durationMs, first?.toolCalls, first?.tokens], [12_000, 3, 9000]);
  // 第二次不再用 durationMs，用时是两轮之和：12 秒加上 20 到 30 秒的 10 秒
  assert.deepEqual([second?.durationMs, second?.toolCalls, second?.tokens], [22_000, 9, 30_000]);
  assert.equal(agentOf(store, "A").totalTokens, 30_000);
});

test("an event with an unknown agent id makes a placeholder named after the first 8 characters, subagent.started fills it in", () => {
  const store = storeOf(toolStart("c1", "view", { path: "/a" }, "abcdefgh-1234", 1));
  assert.equal(agentOf(store, "abcdefgh-1234").name, "abcdefgh");
  feed(store, started("abcdefgh-1234", "worker", { at: 2 }));
  const a = agentOf(store, "abcdefgh-1234");
  assert.deepEqual([a.name, a.toolCalls, a.startedAt], ["worker", 1, BASE + 2000]);
  assert.equal(store.agents().length, 1);
});

test("a completion event without a known agentId finds the agent by the task call id", () => {
  const store = storeOf(started("A", "alpha", { task: "t-A" }), ev("subagent.completed", { toolCallId: "t-A", totalTokens: 7 }, null, 5));
  assert.equal(agentOf(store, "A").status, "done");
  assert.equal(agentOf(store, "A").totalTokens, 7);
  feed(store, ev("subagent.completed", { toolCallId: "nobody" }, null, 6));
  assert.equal(store.agents().length, 1);
});

test("version counts changes only and lastEventAt follows the newest event, also for ignored event types", () => {
  const store = new SessionStore("s1");
  assert.deepEqual([store.version, store.lastEventAt], [0, 0]);
  assert.equal(store.feedLine(started("A", "alpha", { at: 1 })), true);
  assert.equal(store.version, 1);
  assert.equal(store.feedLine(ev("hook.start", {}, null, 9)), false);
  assert.equal(store.feedLine(JSON.stringify({ data: {}, timestamp: new Date(BASE + 11_000).toISOString(), type: "assistant.turn_start" })), false);
  assert.equal(store.version, 1);
  assert.equal(store.lastEventAt, BASE + 11_000);
  assert.equal(store.feedLine(toolStart("c1", "view", { path: "/x" }, null, 12)), false);
  assert.equal(store.lastEventAt, BASE + 12_000);
});

test("the description comes from the event, and from the task call's arguments when the event has none", () => {
  const store = storeOf(
    taskCall("t-A", null, 0, { description: "查右侧面板如何常驻" }),
    started("A", "alpha", { at: 1, desc: "事件里的简述" }),
    taskCall("t-B", null, 2, { description: "只在调用里" }),
    started("B", "beta", { at: 3 }),
    started("C", "gamma", { at: 4 }),
  );
  assert.equal(agentOf(store, "A").description, "事件里的简述");
  assert.equal(agentOf(store, "B").description, "只在调用里");
  assert.equal(agentOf(store, "C").description, "");
});

test("promptFoldChars: the header shared by at least three task descriptions is recorded on each sub-agent as the descriptions arrive", () => {
  const header = "开始前先读说明。";
  const prompt = (agent: string, text: string, at: number) => ev("user.message", { content: text }, agent, at);
  const store = storeOf(
    started("A", "a", { at: 0 }),
    started("B", "b", { at: 1 }),
    started("C", "c", { at: 2 }),
    prompt("A", `${header}\n\n任务甲`, 3),
    prompt("B", `${header}\n\n任务乙`, 4),
  );
  assert.deepEqual([agentOf(store, "A").promptFoldChars, agentOf(store, "B").promptFoldChars], [undefined, undefined]);
  feed(store, prompt("C", `${header}\n\n任务丙`, 5));
  assert.deepEqual(["A", "B", "C"].map((id) => agentOf(store, id).promptFoldChars), [header.length + 2, header.length + 2, header.length + 2]);
  // 第二条起的消息不是任务说明，不参与
  feed(store, started("D", "d", { at: 6 }), prompt("D", "不一样", 7), prompt("D", `${header}\n\n追加的话`, 8));
  assert.equal(agentOf(store, "D").promptFoldChars, undefined);
  const task = store.transcript("A")[0];
  assert.equal(task?.kind, "task");
  assert.equal(task?.kind === "task" && task.text.slice(agentOf(store, "A").promptFoldChars ?? 0), "任务甲");
});

test("cancelled is recorded when the completion says so, on an abort for the agent, or when a sync agent is aborted; ending with the session is not", () => {
  const store = storeOf(
    started("A", "a", { at: 0 }),
    started("B", "b", { at: 1, mode: "background" }),
    started("C", "c", { at: 2, mode: "sync" }),
    started("D", "d", { at: 3, mode: "background" }),
    ev("subagent.completed", { toolCallId: "t-A", cancelled: true }, "A", 10),
    ev("abort", { reason: "subagent_cancelled" }, "B", 11),
    ev("abort", { reason: "user_abort" }, null, 12),
    ev("session.shutdown", {}, null, 13),
  );
  assert.deepEqual(["A", "B", "C", "D"].map((id) => [agentOf(store, id).status, agentOf(store, id).cancelled]), [
    ["stopped", true],
    ["stopped", true],
    ["stopped", true],
    ["stopped", undefined],
  ]);
  assert.deepEqual(["A", "B", "C", "D"].map((id) => endItems(store, id)[0]?.cancelled), [true, true, true, undefined]);
});
