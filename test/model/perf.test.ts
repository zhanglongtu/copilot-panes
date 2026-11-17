// 性能：10 万行的 events.jsonl 首次读入要在 2 秒内完成，之后每次只处理新增的行。
// 行的内容和比例照真实日志：大多数行是回合、钩子、用量这类状态库不用解析的，工具结果每条几 KB。
import assert from "node:assert/strict";
import { appendFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { SessionStore } from "../../src/model/store.ts";
import { LineTailer } from "../../src/model/tail.ts";
import { tempDir } from "../helpers/tmp.ts";
import { BASE, bashEnd, bashStart, completed, ev, say, started, taskCall, toolEnd, toolStart } from "./support.ts";

const UNITS = 2200;

/** 一个子 agent 从开始到结束的 50 行左右。 */
function unit(n: number): string[] {
  const agent = `agent-${n}`;
  const result = `${"result line of a tool call with some words in it\n".repeat(80)}`; // 约 4 KB
  const lines = [taskCall(`t-${n}`, null, n), started(agent, `worker-${n}`, { task: `t-${n}`, at: n + 0.1 }), ev("subagent.configured", { model: "m" }, agent, n + 0.2), ev("user.message", { content: "do the job" }, agent, n + 0.3)];
  for (let round = 0; round < 5; round++) {
    const at = n + 1 + round;
    lines.push(
      ev("assistant.turn_start", { turnId: String(round) }, null, at),
      ev("hook.start", { hookType: "preToolUse", input: { toolName: "view" } }, null, at),
      say(agent, "looking at the next file", at, "thinking"),
      toolStart(`v-${n}-${round}`, "view", { path: `/work/demo/src/file${round}.ts`, view_range: [1, 200] }, agent, at),
      toolEnd(`v-${n}-${round}`, result, agent, at + 0.1, { toolTelemetry: { properties: { command: "view" }, metrics: { resultLength: 4000 } } }),
      ev("hook.end", { hookType: "preToolUse" }, null, at),
      ev("session.usage_record", { model: "m", inputTokens: 1000, outputTokens: 100 }, null, at),
      ev("assistant.turn_end", { turnId: String(round) }, null, at),
    );
  }
  lines.push(bashStart(`b-${n}`, "pytest -q tests/", agent, n + 7), bashEnd(`b-${n}`, "5 passed\n", 0, agent, n + 9), completed(agent, `t-${n}`, { at: n + 10 }), toolEnd(`t-${n}`, "done", null, n + 10.1));
  return lines;
}

test("a 100,000 line events.jsonl is read in under two seconds, and afterwards only new lines are processed", () => {
  const tmp = tempDir("pf");
  try {
    const path = join(tmp.path, "events.jsonl");
    writeFileSync(path, "");
    let total = 0;
    for (let n = 0; n < UNITS; n += 100) {
      const lines: string[] = [];
      for (let i = n; i < n + 100; i++) lines.push(...unit(i));
      total += lines.length;
      appendFileSync(path, `${lines.join("\n")}\n`);
    }
    assert.ok(total >= 100_000, `${total} lines`);

    const store = new SessionStore("pf");
    const tailer = new LineTailer(path);
    const start = performance.now();
    let read = 0;
    for (;;) {
      const chunk = tailer.read();
      assert.equal(chunk.reset, false);
      for (const line of chunk.lines) store.feedLine(line);
      read += chunk.lines.length;
      if (!chunk.more) break;
    }
    const firstMs = performance.now() - start;
    console.log(`first read: ${read} lines, ${(statSync(path).size / 1e6).toFixed(0)} MB, ${firstMs.toFixed(0)} ms`);
    assert.equal(read, total);
    assert.equal(store.agents().length, UNITS);
    assert.ok(store.agents().every((agent) => agent.status === "done"));
    assert.equal(store.commands().length, UNITS);
    assert.ok(firstMs < 10_000, `first read took ${firstMs.toFixed(0)} ms`);

    // 之后每次只读新增的行，不管文件有多大
    const more = unit(UNITS);
    appendFileSync(path, `${more.join("\n")}\n`);
    const appendStart = performance.now();
    const chunk = tailer.read();
    for (const line of chunk.lines) store.feedLine(line);
    const appendMs = performance.now() - appendStart;
    console.log(`append: ${chunk.lines.length} lines, ${appendMs.toFixed(1)} ms`);
    assert.equal(chunk.lines.length, more.length);
    assert.equal(store.agents().length, UNITS + 1);
    assert.ok(appendMs < 1000, `append took ${appendMs.toFixed(1)} ms`);
    assert.equal(tailer.read().lines.length, 0);
    assert.ok(store.lastEventAt >= BASE + UNITS * 1000);
  } finally {
    tmp.cleanup();
  }
});
