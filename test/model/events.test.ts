// 事件行的解析：外层字段、时间戳、坏行和类型不对的字段。
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseEventLine, parseTimestamp } from "../../src/model/events.ts";
import { SessionStore } from "../../src/model/store.ts";
import { BASE, bashEnd, bashStart, completed, ev, feed, say, started, storeOf, taskCall, toolEnd, toolStart } from "./support.ts";

test("timestamps keep milliseconds, read the zone, and bad input gives 0", () => {
  assert.equal(parseTimestamp("2026-11-13T06:59:07.893Z") - parseTimestamp("2026-11-13T06:59:07.000Z"), 893);
  assert.equal(parseTimestamp("2026-11-13T07:00:00.000Z"), BASE);
  assert.equal(parseTimestamp("2026-11-13T07:00:00Z"), BASE);
  assert.equal(parseTimestamp("2026-11-13T07:00:00"), BASE);
  assert.equal(parseTimestamp("2026-11-13T07:00:00.5"), BASE + 500);
  assert.equal(parseTimestamp("2026-11-13T07:00:00.123456Z"), BASE + 123);
  assert.equal(parseTimestamp("2026-11-13T15:00:00.000+08:00"), BASE);
  assert.equal(parseTimestamp("2026-11-13T02:30:00.000-04:30"), BASE);
  assert.equal(parseTimestamp("2026-11-13T07:00:00.000+0000"), BASE);
  for (const bad of ["", "yesterday", "2026-13-01T00:00:00Z", "2026-02-31T00:00:00Z", "2026-11-13T25:00:00Z", "2026-11-13", 42, null, undefined, {}]) {
    assert.equal(parseTimestamp(bad), 0, String(bad));
  }
});

test("truncated JSON, non-objects and lines without a type are dropped", () => {
  for (const bad of ['{"type":"tool.execution_start","data":{"toolCa', "not json", "", "   ", "[1,2]", "42", "null", '"text"', '{"data":{}}', '{"type":7}', '{"type":null,"data":{}}']) {
    assert.equal(parseEventLine(bad), null, bad);
  }
  const store = new SessionStore("s1");
  for (const bad of ['{"type":"tool.execution_start","data":{"toolCa', "not json", '{"type":"hook.start","data":{}}', '{"type":"brand.new.event","data":{}}']) {
    assert.equal(store.feedLine(bad), false, bad);
  }
  assert.deepEqual([store.agents().length, store.commands().length, store.version], [0, 0, 0]);
});

test("the outer fields: data that is not an object becomes {}, an agentId that is not a non-empty string is the main session", () => {
  const at = "2026-11-13T07:00:01.250Z";
  assert.deepEqual(parseEventLine(`{"type":"x.y","data":{"a":1},"agentId":"A","timestamp":"${at}"}`), { type: "x.y", data: { a: 1 }, agentId: "A", at: BASE + 1250 });
  for (const agentId of ["7", "null", '""', "[]", "{}"]) {
    assert.equal(parseEventLine(`{"type":"x","data":{},"agentId":${agentId}}`)?.agentId, null, agentId);
  }
  for (const data of ["5", '"s"', "[1]", "null"]) assert.deepEqual(parseEventLine(`{"type":"x","data":${data}}`)?.data, {}, data);
  assert.deepEqual(parseEventLine('{"type":"x"}'), { type: "x", data: {}, agentId: null, at: 0 });
});

test("events with wrong field types are absorbed and leave what was parsed before alone", () => {
  const store = storeOf(started("good", "alpha", { at: 1 }), bashStart("c1", "make", "good", 2));
  for (const raw of [
    '{"type":"tool.execution_start","data":{"toolCallId":"x","toolName":["list"],"arguments":7}}',
    '{"type":"subagent.started","data":{"toolCallId":5,"agentDisplayName":3},"agentId":"A"}',
    '{"type":"system.notification","data":{"kind":{"type":"shell_completed","shellId":null}}}',
    '{"type":"system.notification","data":{"kind":"shell_completed"}}',
    '{"type":"tool.execution_complete","data":{"toolCallId":["x"]}}',
    '{"type":"tool.execution_start","data":{"toolCallId":5,"toolName":"bash","arguments":{"command":["x"]}},"agentId":"good"}',
    '{"type":"user.message","data":{"content":{"a":1}},"agentId":"good"}',
    '{"type":"assistant.message","data":{"content":5,"reasoningText":[]},"agentId":"good"}',
    '{"type":"subagent.completed","data":{"toolCallId":"t-nobody","totalTokens":"many","totalToolCalls":1.5,"durationMs":"x"},"agentId":"nobody"}',
    '{"type":"abort","data":{"reason":5},"agentId":"good"}',
  ]) {
    assert.doesNotThrow(() => store.feedLine(raw), raw);
  }
  const good = store.agent("good");
  assert.deepEqual([good?.name, good?.status, good?.toolCalls], ["alpha", "running", 2]);
  assert.equal(store.command("c1")?.status, "running"); // shellId 是 null 的结束通知不会误结束别的命令
});

test("the result is the same for any field order, spacing and \\uXXXX escapes", () => {
  const filler = "很长的内容。".repeat(200);
  const lines = [
    ev("session.start", { sessionId: "S", selectedModel: "provider/large-1.0", context: { cwd: "/w" } }),
    ev("hook.start", { hookType: "x", note: filler }, null, 0.5),
    started("A", "alpha", { at: 1 }),
    started("B", "beta", { model: "provider/medium-1.0", at: 2 }),
    taskCall("t-B", "A", 2.5),
    say("A", `${filler}回复`, 3, "先想想\n再想想"),
    say(null, "主 agent 的话", 3.1),
    toolStart("v1", "view", { path: "/x/y.md" }, "A", 4),
    toolEnd("v1", filler, "A", 4.5),
    bashStart("c1", "echo hi", "A", 5),
    ev("tool.execution_complete", { toolCallId: "c1", success: true, shellExecution: { exitCode: 0 }, result: { content: `${filler}hi\n<shellId: 0 completed with exit code 0>` } }, "A", 6),
    bashStart("c2", "make", "B", 7, { mode: "async", shellId: "bg" }),
    ev("tool.execution_complete", { toolCallId: "c2", success: true, result: { content: `${filler}<started>`, structuredContent: { shellId: "bg" } } }, "B", 7.1),
    toolStart("r1", "read_bash", { shellId: "bg" }, "B", 8),
    toolEnd("r1", `${filler}<shellId: bg completed with exit code 3>`, "B", 8.1),
    bashStart("c3", "sleep 99", "B", 9, { mode: "async", shellId: "s3" }),
    ev("tool.execution_complete", { toolCallId: "c3", success: true, result: { content: "<started>", structuredContent: { shellId: "s3" } } }, "B", 9.1),
    ev("system.notification", { content: filler, kind: { type: "shell_completed", shellId: "s3", exitCode: 0 } }, null, 10),
    ev("user.message", { content: `派给 alpha 的活${filler}` }, "A", 11),
    ev("user.message", { content: `后来的消息${filler}`, source: "agent-B" }, "A", 12),
    ev("user.message", { content: `主会话里用户说的话${filler}` }, null, 13),
    completed("A", "t-A", { calls: 3, tokens: 1234, ms: 5000, at: 14 }),
    ev("user.message", { content: "叫醒 alpha" }, "A", 15),
    ev("subagent.failed", { toolCallId: "t-B", error: "boom", durationMs: 100 }, "B", 16),
    bashStart("c4", "tail -f x", null, 17),
    ev("abort", { reason: "user_abort" }, null, 18),
    ev("session.model_change", { newModel: "provider/large-1.5" }, null, 19),
    toolStart("s9", "stop_bash", { shellId: "zz" }, null, 20),
    toolEnd("s9", "stopped", null, 20.1),
  ];
  const sorted = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sorted);
    if (typeof value !== "object" || value === null) return value;
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1)).map(([key, item]) => [key, sorted(item)]));
  };
  const summary = (dump: (event: unknown) => string) => {
    const store = new SessionStore("s1");
    for (const line of lines) store.feedLine(dump(JSON.parse(line)));
    // 工具调用的参数是原样保留的 JSON，键的顺序跟着输入走；其余字段的顺序是固定的
    return JSON.stringify(
      sorted({
        agents: store.agents(),
        commands: store.commands(),
        transcripts: store.agents().map((agent) => store.transcript(agent.id)),
        main: [store.mainModel, store.cwd, store.lastEventAt],
      }),
    );
  };
  const compact = (event: unknown) => JSON.stringify(event);
  const base = summary(compact);
  const parsed = JSON.parse(base) as { agents: unknown[]; commands: { status: string }[]; transcripts: { kind: string }[][] };
  assert.equal(parsed.agents.length, 2);
  assert.equal(parsed.transcripts[0]?.filter((item) => item.kind === "task").length, 1); // 各个分支都走到了
  assert.equal(parsed.transcripts[0]?.filter((item) => item.kind === "message").length, 2);
  assert.deepEqual(
    parsed.commands.map((c) => c.status),
    ["done", "failed", "done", "stopped"],
  );

  let seed = 12345;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  const reorder = (value: unknown, how: "reversed" | "shuffled"): unknown => {
    if (Array.isArray(value)) return value.map((item) => reorder(item, how));
    if (typeof value !== "object" || value === null) return value;
    const entries = Object.entries(value).map(([key, item]) => [key, reorder(item, how)] as const);
    if (how === "reversed") entries.reverse();
    else for (let i = entries.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [entries[i], entries[j]] = [entries[j]!, entries[i]!]; }
    return Object.fromEntries(entries);
  };
  const variants: Record<string, (event: unknown) => string> = {
    reversed: (event) => JSON.stringify(reorder(event, "reversed")),
    pretty: (event) => JSON.stringify(event, null, 1).replaceAll("\n", " "),
    spaces: (event) => JSON.stringify(event).replaceAll('":', '": ').replaceAll(',"', ', "'),
    ascii: (event) => JSON.stringify(event).replace(/[\u0080-\uffff]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`),
    "data last": (event) => {
      const { data, ...rest } = event as { data: unknown };
      return JSON.stringify({ ...rest, data });
    },
    shuffled: (event) => JSON.stringify(reorder(event, "shuffled")),
  };
  for (const [name, dump] of Object.entries(variants)) assert.ok(summary(dump) === base, `variant ${name}`);
});

test("a message to a sub-agent whose agentId is far from the end of the line is not dropped", () => {
  const store = storeOf(started("A", "alpha", { at: 0 }));
  const message = JSON.parse(ev("user.message", { content: "x".repeat(2000) }, "A", 5)) as Record<string, unknown>;
  const line = JSON.stringify({ type: message.type, agentId: "A", id: message.id, timestamp: message.timestamp, parentId: null, data: message.data });
  assert.equal(store.feedLine(line), true);
  assert.deepEqual(
    store.transcript("A").map((item) => item.kind),
    ["task"],
  );
});

test("a failing command does not stop the lines after it", () => {
  const store = storeOf(bashStart("c1", "make", null, 0), "{broken", bashEnd("c1", "", 0, null, 1));
  assert.equal(store.command("c1")?.status, "done");
  feed(store, "");
  assert.equal(store.version, 2);
});
