import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { LastUserMessages, SessionActivity, realUserMessageAt } from "../../src/discover/session-tail.ts";
import { tempDir } from "../helpers/tmp.ts";

const at = (minute: number, second = 0) => `2026-11-16T13:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}.000Z`;
const ms = (iso: string) => Date.parse(iso);

function line(type: string, data: object, timestamp: string, agentId?: string): string {
  return `${JSON.stringify({ type, data, ...(agentId ? { agentId } : {}), id: "x", timestamp })}\n`;
}

const human = (timestamp: string, content = "你好") => line("user.message", { content }, timestamp);
const filler = (n: number) => line("assistant.message", { content: "x".repeat(1000) }, at(0)).repeat(n);

test("only a message from the user counts: not one a sub-agent received, not one a program sent", () => {
  assert.equal(realUserMessageAt(human(at(5))), ms(at(5)));
  assert.equal(realUserMessageAt(line("user.message", { content: "x", source: "user" }, at(5))), ms(at(5)));
  assert.equal(realUserMessageAt(line("user.message", { content: "x", source: "command-compact" }, at(5))), ms(at(5)));
  assert.equal(realUserMessageAt(line("user.message", { content: "x", source: "agent-3f2b8e1a" }, at(5), "a1")), 0);
  assert.equal(realUserMessageAt(line("user.message", { content: "x" }, at(5), "a1")), 0);
  assert.equal(realUserMessageAt(line("user.message", { content: "x", source: "system" }, at(5))), 0);
  assert.equal(realUserMessageAt(line("user.message", { content: "x", source: "schedule-3" }, at(5))), 0);
  assert.equal(realUserMessageAt(line("assistant.message", { content: "user.message" }, at(5))), 0);
  assert.equal(realUserMessageAt("not json but \"type\":\"user.message\""), 0);
});

test("the last user message is found from the end of a large file, skipping the noise after it", () => {
  const dir = tempDir("ut-");
  try {
    const file = join(dir.path, "events.jsonl");
    writeFileSync(
      file,
      human(at(1)) + filler(10) + human(at(2)) + line("user.message", { content: "x", source: "agent-s" }, at(9), "a1") + filler(1200) + line("user.message", { content: "x", source: "system" }, at(8)) + filler(5),
    );
    const messages = new LastUserMessages();
    assert.equal(messages.lastAt(file), ms(at(2)));
    assert.equal(messages.lastAt(file), ms(at(2)));
  } finally {
    dir.cleanup();
  }
});

test("a message that sits far back, past one read block, is still found; a file with none gives 0", () => {
  const dir = tempDir("ut-");
  try {
    const file = join(dir.path, "events.jsonl");
    writeFileSync(file, human(at(3)) + filler(2000)); // 约 2 MB，要读好几块
    assert.equal(new LastUserMessages().lastAt(file), ms(at(3)));
    const none = join(dir.path, "none.jsonl");
    writeFileSync(none, filler(30));
    assert.equal(new LastUserMessages().lastAt(none), 0);
    assert.equal(new LastUserMessages().lastAt(join(dir.path, "missing.jsonl")), 0);
  } finally {
    dir.cleanup();
  }
});

test("lines longer than a read block do not stop the search", () => {
  const dir = tempDir("ut-");
  try {
    const file = join(dir.path, "events.jsonl");
    const huge = line("tool.execution_complete", { result: "y".repeat(700_000) }, at(0));
    writeFileSync(file, human(at(6)) + filler(5) + huge + filler(2) + huge + huge);
    assert.equal(new LastUserMessages().lastAt(file), ms(at(6)));
  } finally {
    dir.cleanup();
  }
});

test("appended messages are picked up, a half-written last line waits, and a replaced file is read again", () => {
  const dir = tempDir("ut-");
  try {
    const file = join(dir.path, "events.jsonl");
    writeFileSync(file, human(at(1)) + filler(3));
    const messages = new LastUserMessages();
    assert.equal(messages.lastAt(file), ms(at(1)));

    const second = human(at(4), "第二句");
    appendFileSync(file, second.slice(0, 30));
    assert.equal(messages.lastAt(file), ms(at(1)), "the line is not complete yet");
    appendFileSync(file, second.slice(30));
    assert.equal(messages.lastAt(file), ms(at(4)));

    writeFileSync(file, human(at(2)));
    assert.equal(messages.lastAt(file), ms(at(2)), "a shorter file replaces what was known");
  } finally {
    dir.cleanup();
  }
});

test("the rough count of running entries comes from the end of the file and is not recomputed while the file is unchanged", () => {
  const dir = tempDir("ac-");
  try {
    mkdirSync(dir.path, { recursive: true });
    const file = join(dir.path, "events.jsonl");
    const started = (id: string, minute: number) => line("subagent.started", { toolCallId: `t_${id}`, agentDisplayName: id, agentType: "x" }, at(minute), id);
    writeFileSync(
      file,
      started("a1", 1) + started("a2", 2) + started("a3", 3) + line("subagent.completed", { toolCallId: "t_a1", totalToolCalls: 1, totalTokens: 5 }, at(4), "a1") + filler(3),
    );
    const now = Date.now();
    const activity = new SessionActivity();
    assert.equal(activity.running(file, "s", now), 2);
    assert.equal(activity.running(file, "s", now), 2);

    appendFileSync(file, line("subagent.completed", { toolCallId: "t_a2", totalToolCalls: 1, totalTokens: 5 }, at(5), "a2"));
    assert.equal(activity.running(file, "s", now), 1);

    // 很久没有事件：Copilot CLI 多半被强行结束了，不算在跑
    const old = new Date(now - 10 * 60 * 1000);
    utimesSync(file, old, old);
    assert.equal(activity.running(file, "s", now), 0);
    assert.equal(activity.running(join(dir.path, "missing.jsonl"), "s", now), 0);
  } finally {
    dir.cleanup();
  }
});
