import assert from "node:assert/strict";
import { test } from "node:test";
import { matchShellTasks, ShellCallBook } from "../../extension/src/shells.ts";
import type { ShellCall } from "../../extension/src/shells.ts";
import { bashStart, shellTask, toolComplete } from "./fake.ts";

const T0 = Date.parse("2026-11-16T05:00:00.000Z");
const iso = (ms: number) => new Date(T0 + ms).toISOString();
const call = (toolCallId: string, command: string, offsetMs: number, shellId: string | null = null): ShellCall => ({
  toolCallId,
  command,
  startedAt: T0 + offsetMs,
  shellId,
});

test("a shell task whose id equals a call's shellId is matched to that call", () => {
  const tasks = [shellTask("gw", "python3 server.py", iso(0))];
  const calls = [call("c-other", "python3 server.py", 0), call("c-gw", "something else entirely", 500_000, "gw")];
  assert.deepEqual([...matchShellTasks(tasks, calls, new Map())], [["gw", "c-gw"]]);
});

test("without a shellId the call with the same command started closest within 30 seconds is matched", () => {
  const tasks = [shellTask("7", "npm test", iso(0))];
  const calls = [call("far", "npm test", -20_000), call("near", "npm test", 3_000), call("wrong", "npm run build", 10)];
  assert.deepEqual([...matchShellTasks(tasks, calls, new Map())], [["7", "near"]]);
  // 相差 30 秒整不算“不到 30 秒”
  assert.equal(matchShellTasks(tasks, [call("edge", "npm test", 30_000)], new Map()).size, 0);
  assert.equal(matchShellTasks(tasks, [call("edge", "npm test", 29_999)], new Map()).size, 1);
});

test("a call that already knows its shellId only matches the task with that id, not by command text", () => {
  const tasks = [shellTask("8", "npm test", iso(0))];
  assert.equal(matchShellTasks(tasks, [call("done", "npm test", 0, "7")], new Map()).size, 0);
});

test("two identical commands started within 100 ms of each other are left unmatched", () => {
  const tasks = [shellTask("1", "sleep 60", iso(0))];
  assert.equal(matchShellTasks(tasks, [call("a", "sleep 60", 10), call("b", "sleep 60", 60)], new Map()).size, 0);
  assert.equal(matchShellTasks(tasks, [call("a", "sleep 60", 10), call("b", "sleep 60", 110)], new Map()).size, 0);
  assert.deepEqual([...matchShellTasks(tasks, [call("a", "sleep 60", 10), call("b", "sleep 60", 111)], new Map())], [["1", "a"]]);
});

test("a call is matched to at most one task and earlier matches are kept until the task disappears", () => {
  const calls = [call("c1", "make", 0), call("c2", "make", 5_000)];
  const first = matchShellTasks([shellTask("1", "make", iso(100))], calls, new Map());
  assert.deepEqual([...first], [["1", "c1"]]);

  // 第二个任务出现：c1 已经被任务 1 认领，只能对 c2
  const both = [shellTask("1", "make", iso(100)), shellTask("2", "make", iso(5_100))];
  const second = matchShellTasks(both, calls, first);
  assert.deepEqual([...second].sort(), [["1", "c1"], ["2", "c2"]]);

  // 任务 1 不在列表里了：它的对应丢掉，c1 空出来
  const third = matchShellTasks([shellTask("2", "make", iso(5_100))], calls, second);
  assert.deepEqual([...third], [["2", "c2"]]);

  // 之前的对应优先于更近的候选
  const kept = matchShellTasks([shellTask("2", "make", iso(0))], calls, new Map([["2", "c2"]]));
  assert.deepEqual([...kept], [["2", "c2"]]);
});

test("tasks are handled oldest first and non-shell tasks are ignored", () => {
  const agent = { type: "agent" as const, id: "a1", toolCallId: "x", description: "d", status: "running" as const, startedAt: iso(0), agentType: "explore", prompt: "p" };
  const tasks = [shellTask("late", "make", iso(2_000)), agent, shellTask("early", "make", iso(1_000))];
  const calls = [call("c1", "make", 1_000), call("c2", "make", 2_000)];
  assert.deepEqual([...matchShellTasks(tasks, calls, new Map())].sort(), [["early", "c1"], ["late", "c2"]]);
});

test("the call book keeps the shellId from the start arguments, the complete event's structuredContent or the 'shellId: X>' text", () => {
  const book = new ShellCallBook(10, () => 123);
  book.onEvent(bashStart("c1", "make", { mode: "async", shellId: "named" }));
  book.onEvent(bashStart("c2", "make"));
  book.onEvent(toolComplete("c2", { result: { content: "ok\n<shellId: 7 completed with exit code 0>", structuredContent: { shellId: "7" } } }));
  book.onEvent(bashStart("c3", "make"));
  book.onEvent(toolComplete("c3", { result: { content: "<command started in background with shellId: bg3>" } }));
  book.onEvent(bashStart("c4", "make"));
  assert.deepEqual(
    book.calls().map((c) => [c.toolCallId, c.shellId]),
    [["c1", "named"], ["c2", "7"], ["c3", "bg3"], ["c4", null]],
  );
});

test("the call book keeps the event time, falls back to now, ignores other tools, and drops the oldest calls", () => {
  const book = new ShellCallBook(2, () => 123);
  book.onEvent({ type: "tool.execution_start", timestamp: "2026-11-16T05:00:00.000Z", data: { toolCallId: "c1", toolName: "bash", arguments: { command: "a" } } });
  book.onEvent({ type: "tool.execution_start", timestamp: "not a time", data: { toolCallId: "c2", toolName: "powershell", arguments: { command: "b" } } });
  book.onEvent({ type: "tool.execution_start", data: { toolCallId: "c3", toolName: "view", arguments: { path: "/x" } } });
  assert.deepEqual(
    book.calls().map((c) => [c.toolCallId, c.command, c.startedAt]),
    [["c1", "a", T0], ["c2", "b", 123]],
  );
  book.onEvent(bashStart("c4", "d"));
  assert.deepEqual(book.calls().map((c) => c.toolCallId), ["c2", "c4"]);
  // 没有对应开始事件的完成事件、数据不对的事件都忽略
  book.onEvent(toolComplete("never-started", { result: { structuredContent: { shellId: "1" } } }));
  book.onEvent({ type: "tool.execution_start", data: null });
  assert.equal(book.calls().length, 2);
});
