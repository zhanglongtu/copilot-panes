import assert from "node:assert/strict";
import { test } from "node:test";
import { UsageBook } from "../../extension/src/usage.ts";
import type { SdkEvent } from "../../extension/src/sdk.ts";

const usageEvent = (data: Record<string, unknown>, agentId?: string): SdkEvent => ({
  type: "assistant.usage",
  ephemeral: true,
  ...(agentId ? { agentId } : {}),
  data,
});

test("assistant.usage is added up per envelope agentId", () => {
  const book = new UsageBook();
  assert.equal(book.onEvent(usageEvent({ inputTokens: 100, outputTokens: 10, cacheReadTokens: 50, cacheWriteTokens: 5 }, "a1")), true);
  assert.equal(book.onEvent(usageEvent({ inputTokens: 20, outputTokens: 2 }, "a1")), true);
  assert.equal(book.onEvent(usageEvent({ inputTokens: 7 }, "a2")), true);
  assert.deepEqual(book.snapshot(), {
    a1: { inputTokens: 120, outputTokens: 12, cacheReadTokens: 50, cacheWriteTokens: 5, calls: 2 },
    a2: { inputTokens: 7, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, calls: 1 },
  });
});

test("fields that are missing, negative or not numbers count as 0", () => {
  const book = new UsageBook();
  book.onEvent(usageEvent({ inputTokens: "5", outputTokens: -3, cacheReadTokens: null }, "a1"));
  assert.deepEqual(book.snapshot().a1, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, calls: 1 });
});

test("usage without an agentId is attributed through parentToolCallId and the subagent.started mapping", () => {
  const book = new UsageBook();
  assert.equal(book.onEvent({ type: "subagent.started", agentId: "a9", data: { toolCallId: "call-9" } }), false);
  assert.equal(book.onEvent(usageEvent({ inputTokens: 40, outputTokens: 4, parentToolCallId: "call-9" })), true);
  assert.equal(book.onEvent(usageEvent({ inputTokens: 1, parentToolCallId: "call-unknown" })), false);
  assert.deepEqual(book.snapshot(), { a9: { inputTokens: 40, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0, calls: 1 } });
});

test("usage of the main session is ignored", () => {
  const book = new UsageBook();
  assert.equal(book.onEvent(usageEvent({ inputTokens: 1000, outputTokens: 100 })), false);
  assert.deepEqual(book.snapshot(), {});
});

test("totalTokens of subagent.completed and subagent.failed is kept as reportedTotalTokens", () => {
  const book = new UsageBook();
  book.onEvent(usageEvent({ inputTokens: 10 }, "a1"));
  book.onEvent({ type: "subagent.started", agentId: "a2", data: { toolCallId: "call-2" } });
  assert.equal(book.onEvent({ type: "subagent.completed", agentId: "a1", data: { toolCallId: "call-1", totalTokens: 409016 } }), true);
  // 信封没有 agentId 时按 toolCallId 找；这个子 agent 之前没有用量记录，也会建一条
  assert.equal(book.onEvent({ type: "subagent.failed", data: { toolCallId: "call-2", totalTokens: 55 } }), true);
  assert.equal(book.snapshot().a1?.reportedTotalTokens, 409016);
  assert.deepEqual(book.snapshot().a2, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, calls: 0, reportedTotalTokens: 55 });
  // 同一个数字再报一次不算改动；不是数字的忽略
  assert.equal(book.onEvent({ type: "subagent.completed", agentId: "a1", data: { toolCallId: "call-1", totalTokens: 409016 } }), false);
  assert.equal(book.onEvent({ type: "subagent.completed", agentId: "a1", data: { toolCallId: "call-1", totalTokens: "many" } }), false);
});

test("other events and malformed data change nothing, and snapshot returns copies", () => {
  const book = new UsageBook();
  assert.equal(book.onEvent({ type: "assistant.message", agentId: "a1", data: { content: "hi" } }), false);
  assert.equal(book.onEvent({ type: "assistant.usage", agentId: "a1" }), false);
  assert.equal(book.onEvent({ type: "assistant.usage", agentId: "a1", data: "text" }), false);
  book.onEvent(usageEvent({ inputTokens: 1 }, "a1"));
  const copy = book.snapshot();
  copy.a1!.inputTokens = 999;
  assert.equal(book.snapshot().a1?.inputTokens, 1);
});
