// 过程记录：任务说明、消息、思考和回复、工具调用的合成。对应 src/model/store.ts 的 transcript()。
import assert from "node:assert/strict";
import { test } from "node:test";
import { TOOL_TEXT_KEEP_CHARS } from "../../src/model/limits.ts";
import type { MessageItem, SayItem, TaskItem, ThinkItem, ToolItem, TranscriptItem } from "../../src/types/model.ts";
import { BASE, bashBackground, bashStart, ev, feed, say, shellCall, started, storeOf, taskCall, toolEnd, toolStart } from "./support.ts";

function tools(items: readonly TranscriptItem[]): ToolItem[] {
  return items.filter((item): item is ToolItem => item.kind === "tool");
}

test("the first user.message of an agent is its task item and later ones are message items with the sender rules", () => {
  const store = storeOf(
    started("A", "alpha"),
    ev("user.message", { content: "\n\n派活的话\n第二行\n", source: "agent-S" }, "A", 1),
    ev("user.message", { content: "后来的话", source: "agent-S" }, "A", 2),
    ev("user.message", { content: "你说的话" }, "A", 3),
    ev("user.message", { content: "   " }, "A", 4),
  );
  const items = store.transcript("A");
  assert.deepEqual(
    items.map((item) => [item.seq, item.kind, item.at]),
    [
      [0, "task", BASE + 1000],
      [1, "message", BASE + 2000],
      [2, "message", BASE + 3000],
    ],
  );
  assert.equal((items[0] as TaskItem).text, "派活的话\n第二行");
  assert.deepEqual(
    items.slice(1).map((item) => [(item as MessageItem).from, (item as MessageItem).text]),
    [
      ["main", "后来的话"],
      ["you", "你说的话"],
    ],
  );
});

test("a message to an agent that is not running is followed by a resume item", () => {
  const store = storeOf(started("A", "alpha"), ev("user.message", { content: "派活" }, "A", 1), ev("subagent.completed", { toolCallId: "t-A" }, "A", 5), ev("user.message", { content: "再来一轮" }, "A", 6));
  assert.deepEqual(
    store.transcript("A").map((item) => item.kind),
    ["task", "end", "message", "resume"],
  );
  assert.equal(store.agent("A")?.status, "running");
});

test("assistant.message gives a think item before a say item, trimmed, and nothing for the main session", () => {
  const store = storeOf(started("A", "alpha"), say("A", "  回复  ", 1, "\n思考\n"), say("A", "  ", 2, "只有思考"), say("A", "只有回复", 3), say(null, "主 agent 的回复", 4, "主 agent 的思考"));
  assert.deepEqual(
    store.transcript("A").map((item) => [item.kind, (item as ThinkItem | SayItem).text]),
    [
      ["think", "思考"],
      ["say", "回复"],
      ["think", "只有思考"],
      ["say", "只有回复"],
    ],
  );
  assert.equal(store.transcript("nobody").length, 0);
});

test("a tool call is one ToolItem completed in place, with the result cut to TOOL_TEXT_KEEP_CHARS", () => {
  const store = storeOf(started("A", "alpha"), toolStart("v1", "view", { path: "/a/b.py" }, "A", 1));
  let [item] = tools(store.transcript("A"));
  assert.deepEqual([item?.status, item?.resultText, item?.endedAt, item?.toolName, item?.args], ["running", null, null, "view", { path: "/a/b.py" }]);
  const big = "x".repeat(TOOL_TEXT_KEEP_CHARS + 1000);
  feed(store, toolEnd("v1", big, "A", 3, { toolTelemetry: { metrics: { resultLength: 9 } } }));
  assert.equal(tools(store.transcript("A")).length, 1);
  [item] = tools(store.transcript("A"));
  assert.deepEqual([item?.status, item?.endedAt, item?.resultText?.length, item?.errorText, item?.telemetry], ["ok", BASE + 3000, TOOL_TEXT_KEEP_CHARS, null, { metrics: { resultLength: 9 } }]);
});

test("the result text is detailedContent when there is one, else content; a failed call keeps the error message", () => {
  const store = storeOf(
    started("A", "alpha"),
    toolStart("e1", "edit", { path: "/a" }, "A", 1),
    ev("tool.execution_complete", { toolCallId: "e1", success: true, result: { content: "short", detailedContent: "the diff" } }, "A", 2),
    toolStart("e2", "edit", { path: "/b" }, "A", 3),
    ev("tool.execution_complete", { toolCallId: "e2", success: false, error: { message: "no such file", code: "failure" }, result: { content: "Error: no such file" } }, "A", 4),
    toolStart("e3", "edit", { path: "/c" }, "A", 5),
    ev("tool.execution_complete", { toolCallId: "e3", success: true }, "A", 6),
  );
  const [first, second, third] = tools(store.transcript("A"));
  assert.deepEqual([first?.resultText, first?.status], ["the diff", "ok"]);
  assert.deepEqual([second?.resultText, second?.status, second?.errorText], ["Error: no such file", "failed", "no such file"]);
  assert.deepEqual([third?.resultText, third?.status], ["", "ok"]);
});

test("a task call's ToolItem learns the child agent id from subagent.started, whichever comes first", () => {
  const store = storeOf(taskCall("t-A", null, 0), started("A", "outer", { at: 1 }), taskCall("t-B", "A", 2), started("B", "inner", { at: 3 }));
  assert.equal(tools(store.transcript("A")).find((item) => item.toolCallId === "t-B")?.childAgentId, "B");
  // 主会话的 task 调用没有过程记录，子 agent 的 task 调用在发起者的记录里
  assert.equal(tools(store.transcript("A")).length, 1);
  const early = storeOf(started("A", "outer"), started("B", "inner", { task: "t-B" }), taskCall("t-B", "A", 2));
  assert.equal(tools(early.transcript("A"))[0]?.childAgentId, "B");
});

test("main-session tool calls are not in any transcript, but shell tools of an agent are", () => {
  const store = storeOf(
    started("A", "alpha"),
    toolStart("m1", "view", { path: "/x" }, null, 1),
    bashStart("c1", "make test", "A", 2),
    bashStart("c2", "serve", "A", 3, { mode: "async", shellId: "b" }),
    bashBackground("c2", "b", "A", 3.1),
    shellCall("r1", "read_bash", "b", "out\n<shellId: b completed with exit code 0>", 5, "A"),
  );
  assert.deepEqual(
    tools(store.transcript("A")).map((item) => [item.toolName, item.status]),
    [
      ["bash", "running"],
      ["bash", "ok"],
      ["read_bash", "ok"],
    ],
  );
  assert.equal(store.command("c2")?.status, "done");
});

test("tools of an unknown agent id still get a transcript under the placeholder", () => {
  const store = storeOf(toolStart("v1", "view", { path: "/x" }, "zzzzzzzz-1", 1));
  assert.equal(tools(store.transcript("zzzzzzzz-1")).length, 1);
});
