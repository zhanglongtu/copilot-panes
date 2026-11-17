import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  LineDecoder,
  PROTOCOL_VERSION,
  REGISTRATION_VERSION,
  parseExtensionMessage,
  parseRegistration,
  parseTaskInfo,
  parseUiMessage,
  salvageRequestId,
  serializeMessage,
  serializeRegistration,
  type ExtensionMessage,
  type Registration,
  type UiMessage,
} from "../../src/protocol.ts";

const v = PROTOCOL_VERSION;

const shellTask = {
  type: "shell",
  id: "34865",
  description: "run tests",
  status: "running",
  startedAt: "2026-11-16T05:00:00.000Z",
  command: "pytest -v tests/",
  attachmentMode: "detached",
  pid: 4242,
};
const agentTask = {
  type: "agent",
  id: "aaaaaaaa-0000-4000-8000-000000000001",
  toolCallId: "toolu_task_alpha",
  description: "alpha",
  status: "idle",
  startedAt: "2026-11-16T05:00:00.000Z",
  agentType: "explore",
  prompt: "do it",
};

test("every message survives serialize then parse unchanged", () => {
  const fromExtension: ExtensionMessage[] = [
    { type: "hello", v, sessionId: "s1", copilotPid: 10, extensionPid: 11, extensionVersion: "0.1.0" },
    {
      type: "tasks",
      v,
      at: 1000,
      tasks: [shellTask as never, agentTask as never],
      shellCalls: { "34865": "toolu_cmd1" },
      error: { step: "tasks.list", message: "boom", at: 900 },
    },
    {
      type: "usage",
      v,
      at: 1000,
      agents: { a1: { inputTokens: 5, outputTokens: 6, cacheReadTokens: 7, cacheWriteTokens: 8, calls: 2, reportedTotalTokens: 11 } },
    },
    { type: "result", v, requestId: "r1", ok: true },
    { type: "result", v, requestId: "r2", ok: false, reason: "没停掉：Copilot CLI 说它已经不在跑了" },
  ];
  for (const m of fromExtension) {
    const line = serializeMessage(m);
    assert.ok(line.endsWith("\n") && !line.slice(0, -1).includes("\n"));
    assert.deepEqual(parseExtensionMessage(line.trimEnd()), { ok: true, value: m });
  }
  const fromUi: UiMessage[] = [
    { type: "request", v, requestId: "r1", op: "sendMessage", taskId: "a1", message: "第一行\n第二行" },
    { type: "request", v, requestId: "r2", op: "cancel", taskId: "a1" },
    { type: "request", v, requestId: "r3", op: "promoteToBackground", taskId: "7" },
    { type: "request", v, requestId: "r4", op: "remove", taskId: "a1" },
    { type: "request", v, requestId: "r5", op: "refreshTasks" },
  ];
  for (const m of fromUi) {
    const line = serializeMessage(m);
    assert.ok(!line.slice(0, -1).includes("\n"), "a message with a newline in a string still takes one line");
    assert.deepEqual(parseUiMessage(line), { ok: true, value: m });
  }
});

test("bad lines come back as errors with a code instead of throwing", () => {
  const code = (line: string) => {
    const r = parseExtensionMessage(line);
    return r.ok ? "ok" : r.code;
  };
  assert.equal(code("{not json"), "json");
  assert.equal(code("[1,2]"), "shape");
  assert.equal(code(JSON.stringify({ type: "hello", v: 99, sessionId: "s" })), "version");
  assert.equal(code(JSON.stringify({ type: "hello", sessionId: "s" })), "version");
  assert.equal(code(JSON.stringify({ type: "mystery", v })), "type");
  assert.equal(code(JSON.stringify({ type: "hello", v, sessionId: "s", copilotPid: 0, extensionPid: 1, extensionVersion: "" })), "shape");
  assert.equal(code(JSON.stringify({ type: "tasks", v, at: 1, tasks: "nope" })), "shape");
  assert.equal(code(JSON.stringify({ type: "result", v, requestId: "has space", ok: true })), "shape");
});

test("a tasks message keeps the good tasks and drops the ones it cannot read", () => {
  const line = JSON.stringify({
    type: "tasks",
    v,
    at: 5,
    tasks: [
      shellTask,
      "not an object",
      { ...agentTask, id: 7 },
      { ...agentTask, id: "x", status: "sleeping" },
      { ...agentTask, id: "y", type: "workflow" },
      { ...shellTask, id: "8", pid: -3, canPromoteToBackground: "yes" },
      { type: "client", id: "c1", status: "orphaned" },
    ],
    shellCalls: { "34865": "toolu_cmd1", "9": 42 },
    error: { step: "tasks.list", message: 5, at: 1 },
  });
  const r = parseExtensionMessage(line);
  assert.ok(r.ok && r.value.type === "tasks");
  assert.deepEqual(
    r.value.tasks.map((t) => t.id),
    ["34865", "8", "c1"],
  );
  const eight = r.value.tasks[1];
  assert.ok(eight && eight.type === "shell");
  assert.equal(eight.pid, undefined, "a pid that is not a positive integer is dropped");
  assert.equal(eight.canPromoteToBackground, undefined);
  assert.deepEqual(r.value.shellCalls, { "34865": "toolu_cmd1" });
  assert.equal(r.value.error, null, "a malformed error counts as no error");
});

test("the task list the old extension wrote parses task by task", () => {
  const sample = JSON.parse(readFileSync(new URL("../fixtures/events/tasks-sample.json", import.meta.url), "utf8")) as {
    tasks: unknown[];
  };
  const tasks = sample.tasks.map(parseTaskInfo);
  assert.equal(tasks.length, 4);
  assert.ok(tasks.every((t) => t !== null));
  const shell = tasks[3];
  assert.ok(shell && shell.type === "shell");
  assert.equal(shell.pid, 4242);
  assert.equal(shell.command, "make test");
});

test("usage fills missing numbers with zero and a failed result without a reason gets one", () => {
  const usage = parseExtensionMessage(JSON.stringify({ type: "usage", v, at: 1, agents: { a: { inputTokens: 3, outputTokens: "x" }, b: 5 } }));
  assert.deepEqual(usage, {
    ok: true,
    value: { type: "usage", v, at: 1, agents: { a: { inputTokens: 3, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, calls: 0 } } },
  });
  const result = parseExtensionMessage(JSON.stringify({ type: "result", v, requestId: "r9", ok: false }));
  assert.deepEqual(result, { ok: true, value: { type: "result", v, requestId: "r9", ok: false, reason: "扩展没有说明原因" } });
});

test("requests the extension cannot act on are refused, and the request id is still found when possible", () => {
  const bad = [
    { type: "request", v, requestId: "r1", op: "sendMessage", taskId: "a" },
    { type: "request", v, requestId: "r1", op: "cancel" },
    { type: "request", v, requestId: "r1", op: "explode", taskId: "a" },
    { type: "request", v, requestId: "", op: "refreshTasks" },
    { type: "hello", v },
  ];
  for (const m of bad) assert.equal(parseUiMessage(JSON.stringify(m)).ok, false, JSON.stringify(m));
  assert.equal(salvageRequestId(JSON.stringify(bad[2])), "r1");
  assert.equal(salvageRequestId(JSON.stringify(bad[3])), null);
  assert.equal(salvageRequestId("garbage"), null);
});

test("the line decoder joins pieces, keeps split UTF-8 characters whole and skips blank lines", () => {
  const d = new LineDecoder();
  const bytes = Buffer.from('{"a":"汉字"}\r\n\n{"b":1}\n{"c"', "utf8");
  const cut = bytes.indexOf(Buffer.from("汉", "utf8")) + 1; // in the middle of a 3-byte character
  assert.deepEqual(d.push(bytes.subarray(0, cut)), []);
  assert.deepEqual(d.push(bytes.subarray(cut)), ['{"a":"汉字"}', '{"b":1}']);
  assert.deepEqual(d.push(":2}\n"), ['{"c":2}']);
});

test("a line longer than the limit is dropped and the next line still arrives", () => {
  const d = new LineDecoder(10);
  assert.deepEqual(d.push("0123456789AB"), []);
  assert.deepEqual(d.push("CD\nok\n"), ["ok"]);
  assert.equal(d.droppedLines, 1);
});

test("a registration survives a round trip and odd optional fields are tolerated", () => {
  const r: Registration = {
    v: REGISTRATION_VERSION,
    protocol: PROTOCOL_VERSION,
    sessionId: "s1",
    copilotPid: 100,
    extensionPid: 101,
    tmuxPane: "%3",
    cwd: "/work",
    socketPath: "/data/sessions/s1.sock",
    extensionVersion: "0.1.0",
    startedAt: 1,
    updatedAt: 2,
  };
  assert.deepEqual(parseRegistration(serializeRegistration(r)), { ok: true, value: r });
  const odd = parseRegistration(JSON.stringify({ ...r, tmuxPane: 5, cwd: null }));
  assert.ok(odd.ok);
  assert.equal(odd.value.tmuxPane, null);
  assert.equal(odd.value.cwd, "");
  // socket 没开成：socketPath 是 null，界面据此显示只读；空串和缺字段仍然是坏记录
  assert.deepEqual(parseRegistration(JSON.stringify({ ...r, socketPath: null })), { ok: true, value: { ...r, socketPath: null } });
  assert.equal(parseRegistration(JSON.stringify({ ...r, socketPath: undefined })).ok, false);
  const old = parseRegistration(JSON.stringify({ ...r, v: 0 }));
  assert.equal(old.ok ? "ok" : old.code, "version");
  const broken = parseRegistration(JSON.stringify({ ...r, socketPath: "" }));
  assert.equal(broken.ok, false);
});

test("a failed result keeps uncertain only when it is exactly true", () => {
  const base = { type: "result", v: PROTOCOL_VERSION, requestId: "r1", ok: false, reason: "超时" };
  const parse = (extra: object) => parseExtensionMessage(JSON.stringify({ ...base, ...extra }));
  assert.deepEqual(parse({ uncertain: true }), { ok: true, value: { ...base, uncertain: true } });
  assert.deepEqual(parse({ uncertain: "yes" }), { ok: true, value: base });
  assert.deepEqual(parse({}), { ok: true, value: base });
});
