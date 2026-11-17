// 长期保留的文字的上限：每条的上限、超出时记下的数量、一行摘要不受影响，以及整个状态库的总量预算。
import assert from "node:assert/strict";
import { test } from "node:test";
import { agentStep, toolLine } from "../../src/model/describe.ts";
import {
  EVENT_OUTPUT_KEEP_CHARS,
  MESSAGE_KEEP_CHARS,
  SHRUNK_KEEP_CHARS,
  TOOL_TEXT_KEEP_CHARS,
  clipHead,
  clipJson,
  clipTail,
  cutChars,
} from "../../src/model/limits.ts";
import { SessionStore } from "../../src/model/store.ts";
import type { MessageItem, SayItem, TaskItem, ThinkItem, ToolItem } from "../../src/types/model.ts";
import { bashBackground, bashEnd, bashStart, ev, feed, shellCall, started, storeOf, toolEnd, toolStart } from "./support.ts";

const SESSION = [ev("session.start", { context: { cwd: "/work/demo" } }), started("A", "alpha")];

function toolItem(store: SessionStore, id: string): ToolItem {
  const item = store.transcript("A").find((entry): entry is ToolItem => entry.kind === "tool" && entry.toolCallId === id);
  assert.ok(item, id);
  return item;
}

test("tool arguments and results keep 4 KB per string, record what was cut, and the one-line summary does not change", () => {
  const body = "x".repeat(100_000);
  const diff = `\ndiff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1,2000 +1,3000 @@\n${Array.from({ length: 2000 }, (_, i) => `-old line ${i}`).join("\n")}\n${Array.from({ length: 3000 }, (_, i) => `+new line ${i}`).join("\n")}\n`;
  assert.ok(diff.length > 10 * TOOL_TEXT_KEEP_CHARS);
  const store = storeOf(
    SESSION,
    toolStart("v1", "view", { path: "/work/demo/src/auth.ts", view_range: [40, 96] }, "A", 1),
    toolEnd("v1", body, "A", 2, { toolTelemetry: { properties: { x: "y".repeat(50_000) }, restrictedProperties: { path: "/secret" }, metrics: { resultLength: 100_000, note: "not a number" } } }),
    toolStart("b1", "bash", { command: `pytest -x tests/\n${body}`, description: "d".repeat(9000) }, "A", 3),
    toolStart("e1", "edit", { path: "/work/demo/src/auth.ts", old_str: body, new_str: "n".repeat(TOOL_TEXT_KEEP_CHARS) }, "A", 4),
    ev("tool.execution_complete", { toolCallId: "e1", success: true, result: { content: "updated", detailedContent: diff } }, "A", 5),
    toolStart("x1", "view", { path: "/nope" }, "A", 6),
    ev("tool.execution_complete", { toolCallId: "x1", success: false, error: { message: "e".repeat(9000) }, result: { content: "Error" } }, "A", 7),
  );

  const view = toolItem(store, "v1");
  assert.equal(view.resultText?.length, TOOL_TEXT_KEEP_CHARS);
  assert.equal(cutChars(view, "resultText"), 100_000 - TOOL_TEXT_KEEP_CHARS);
  assert.deepEqual(view.args, { path: "/work/demo/src/auth.ts", view_range: [40, 96] });
  assert.equal(cutChars(view, "args"), 0);
  assert.deepEqual(view.telemetry, { metrics: { resultLength: 100_000 } });
  assert.equal(toolLine(view, store, { home: "/home/u" }).target, "src/auth.ts 第 40 到 96 行");

  const bash = toolItem(store, "b1");
  const args = bash.args as { command: string; description: string };
  assert.deepEqual([args.command.length, args.description.length], [TOOL_TEXT_KEEP_CHARS, TOOL_TEXT_KEEP_CHARS]);
  assert.equal(cutChars(bash, "args"), 100_000 + "pytest -x tests/\n".length - TOOL_TEXT_KEEP_CHARS + 9000 - TOOL_TEXT_KEEP_CHARS);
  assert.equal(toolLine(bash, store).target, "pytest -x tests/");
  const record = store.command("b1")!;
  assert.deepEqual([record.command.length, cutChars(record, "command"), cutChars(record, "description")], [TOOL_TEXT_KEEP_CHARS, 100_000 + "pytest -x tests/\n".length - TOOL_TEXT_KEEP_CHARS, 9000 - TOOL_TEXT_KEEP_CHARS]);

  const edit = toolItem(store, "e1");
  assert.deepEqual([edit.resultText?.length, cutChars(edit, "resultText")], [TOOL_TEXT_KEEP_CHARS, diff.length - TOOL_TEXT_KEEP_CHARS]);
  assert.equal(agentStep(store.agent("A")!, "running", store), "看 nope");
  const failed = toolItem(store, "x1");
  assert.deepEqual([failed.status, failed.errorText?.length, cutChars(failed, "errorText")], ["failed", TOOL_TEXT_KEEP_CHARS, 9000 - TOOL_TEXT_KEEP_CHARS]);
  assert.equal(cutChars(edit, "args"), 100_000 - TOOL_TEXT_KEEP_CHARS);
  // 增删的行数在结果截断之前数好，不受 4 KB 影响
  assert.equal(toolLine(edit, store).detail, "+3000 −2000");
});

test("clipHead, clipTail and clipJson do not split a surrogate pair, and leave a value alone when nothing is too long", () => {
  assert.deepEqual(clipHead("abc", 5), { text: "abc", cut: 0 });
  assert.deepEqual(clipHead("a😀b", 2), { text: "a", cut: 3 });
  assert.deepEqual(clipHead("a😀b", 3), { text: "a😀", cut: 1 });
  assert.deepEqual(clipTail("a😀b", 2), { text: "b", cut: 3 });
  assert.deepEqual(clipTail("a😀b", 3), { text: "😀b", cut: 1 });
  const small = { a: ["x", { b: "y" }], c: 1 };
  assert.equal(clipJson(small, 10).value, small);
  const clipped = clipJson({ a: ["x".repeat(30), { b: "y".repeat(12) }], c: 1 }, 10);
  assert.deepEqual(clipped, { value: { a: ["x".repeat(10), { b: "y".repeat(10) }], c: 1 }, cut: 22, size: 20 });
});

test("a command's event output keeps its last 256 KB, from a foreground result and from background reads alike", () => {
  const lines = Array.from({ length: 60_000 }, (_, i) => `output line ${i}\n`).join("");
  assert.ok(lines.length > EVENT_OUTPUT_KEEP_CHARS * 2);
  const store = storeOf(bashStart("c1", "make", null, 0), bashEnd("c1", lines, 0, null, 3));
  const fg = store.command("c1")!;
  assert.equal(fg.eventOutput.length, EVENT_OUTPUT_KEEP_CHARS);
  assert.ok(fg.eventOutput.endsWith("output line 59999")); // 结束标记连同它前面的换行已经去掉
  assert.equal(cutChars(fg, "eventOutput"), lines.length - 1 - EVENT_OUTPUT_KEEP_CHARS);

  const piece = `${"y".repeat(99_999)}\n`;
  feed(store, bashStart("c2", "serve", null, 5, { mode: "async", shellId: "s" }), bashBackground("c2", "s", null, 5.1));
  for (let i = 0; i < 4; i++) feed(store, shellCall(`r${i}`, "read_bash", "s", i === 3 ? `${piece.slice(0, -1)}END\n` : piece, 6 + i));
  const bg = store.command("c2")!;
  assert.equal(bg.eventOutput.length, EVENT_OUTPUT_KEEP_CHARS);
  assert.ok(bg.eventOutput.endsWith("END\n"));
  assert.equal(cutChars(bg, "eventOutput"), 3 * 100_000 + 100_003 - EVENT_OUTPUT_KEEP_CHARS);
});

test("what an agent says, thinks, is told and is sent keeps 64 KB per message and records the rest", () => {
  const long = "字".repeat(100_000);
  const store = storeOf(
    started("A", "alpha"),
    ev("user.message", { content: `任务\n${long}` }, "A", 1),
    ev("user.message", { content: long, source: "agent-S" }, "A", 2),
    ev("assistant.message", { content: long, reasoningText: `想\n${long}` }, "A", 3),
  );
  const [task, message, think, say] = store.transcript("A") as [TaskItem, MessageItem, ThinkItem, SayItem];
  assert.deepEqual([task.kind, message.kind, think.kind, say.kind], ["task", "message", "think", "say"]);
  for (const item of [task, message, think, say]) assert.equal(item.text.length, MESSAGE_KEEP_CHARS, item.kind);
  assert.deepEqual([cutChars(task, "text"), cutChars(message, "text"), cutChars(think, "text"), cutChars(say, "text")], [100_003 - MESSAGE_KEEP_CHARS, 100_000 - MESSAGE_KEEP_CHARS, 100_002 - MESSAGE_KEEP_CHARS, 100_000 - MESSAGE_KEEP_CHARS]);
  assert.equal(store.agent("A")!.lastReply.length, 600);
  // 没超限的原样，什么都没截
  const short = storeOf(started("A", "alpha"), ev("user.message", { content: "短" }, "A", 1));
  assert.equal(cutChars(short.transcript("A")[0] as TaskItem, "text"), 0);
});

test("when the long texts of a session add up past the budget, the oldest are shortened first", () => {
  const store = new SessionStore("s1", { textBudgetChars: 10_000 });
  feed(store, SESSION);
  for (let i = 0; i < 10; i++) feed(store, toolStart(`v${i}`, "view", { path: `/work/demo/f${i}.ts` }, "A", i), toolEnd(`v${i}`, `${i}`.repeat(2000), "A", i + 0.5));
  const lengths = Array.from({ length: 10 }, (_, i) => toolItem(store, `v${i}`).resultText?.length);
  assert.deepEqual(lengths, [SHRUNK_KEEP_CHARS, SHRUNK_KEEP_CHARS, SHRUNK_KEEP_CHARS, SHRUNK_KEEP_CHARS, SHRUNK_KEEP_CHARS, 2000, 2000, 2000, 2000, 2000]);
  assert.equal(cutChars(toolItem(store, "v0"), "resultText"), 2000 - SHRUNK_KEEP_CHARS);
  // 缩短的只是长文字，一行摘要要的路径还在
  assert.equal(toolLine(toolItem(store, "v0"), store, { home: "/home/u" }).target, "f0.ts");
  assert.equal(toolItem(store, "v0").status, "ok");
});
