// 子 agent 的 token 数：取 events.jsonl 的用量记录、完成事件的 totalTokens、扩展累加的用量里最大的一个，不会比真实用量小。
import assert from "node:assert/strict";
import { test } from "node:test";
import { liveTokens, sessionTokens, tokensByAgent, tokensPartial } from "../../src/model/tokens.ts";
import type { AgentUsage } from "../../src/protocol.ts";
import { BASE, completed, ev, failedEvent, listOf, started, storeOf, taskCall, usageOf } from "./support.ts";

/** 一个子 agent 显示的 token 数：它自己的事件加可选的扩展用量。 */
function shown(id: string, usage: AgentUsage | undefined, ...lines: string[]): number | null {
  const store = storeOf(started(id, id), ...lines);
  return tokensByAgent(store, usage ? { [id]: usage } : null).get(id) ?? null;
}

test("liveTokens counts input plus output, not the cache", () => {
  assert.equal(liveTokens(usageOf(1000, 234, { cacheReadTokens: 50_000, cacheWriteTokens: 7 })), 1234);
});

test("a finished agent shows totalTokens unless the live usage is larger, and a running one the live usage", () => {
  const usage = usageOf(900, 100);
  const done = completed("A", "t-A", { tokens: 38_000 });
  assert.equal(shown("A", usage, done), 38_000);
  assert.equal(shown("A", undefined, done), 38_000);
  // 追加消息后又跑了几轮，完成事件里的数偏小：累加值更大就显示累加值
  assert.equal(shown("A", usageOf(60_000, 1000), done), 61_000);
  assert.equal(shown("B", usage), 1000);
});

test("a finished agent without totalTokens falls back to the live usage, and to nothing without either", () => {
  const failed = ev("subagent.failed", { toolCallId: "t-A" }, "A", 5);
  assert.equal(shown("A", usageOf(10, 5), failed), 15);
  assert.equal(shown("A", undefined, failed), null);
});

test("an agent that is running again after a round shows the larger of the live usage and the last totalTokens", () => {
  const woken = [completed("A", "t-A", { tokens: 5000 }), ev("user.message", { content: "x" }, "A", 20)];
  assert.equal(shown("A", usageOf(3000, 500), ...woken), 5000);
  assert.equal(shown("A", usageOf(6000, 500), ...woken), 6500);
});

test("without usage a running agent shows its last totalTokens or nothing", () => {
  assert.equal(shown("A", undefined), null);
  assert.equal(shown("B", undefined, completed("B", "t-B", { tokens: 7000 }), ev("user.message", { content: "x" }, "B", 9)), 7000);
});

test("sessionTokens adds up every agent including collapsed ones, by event status", () => {
  const store = storeOf(
    started("A", "a", { at: 0 }),
    completed("A", "t-A", { tokens: 10_000, at: 5 }),
    started("B", "b", { at: 1 }),
    started("C", "c", { at: 2 }),
    failedEvent("C", "t-C", "x", 6),
    started("D", "d", { at: 3 }),
  );
  assert.equal(sessionTokens(store, { B: usageOf(300, 20), C: usageOf(1, 1) }), 10_000 + 320 + 2);
  // 没有用量时，只有结束过的才知道
  assert.equal(sessionTokens(store, null), 10_000);
  assert.equal(sessionTokens(storeOf(started("X", "x")), null), null);
  assert.equal(sessionTokens(storeOf(), null), null);
  assert.equal(sessionTokens(storeOf(started("X", "x")), { X: usageOf(0, 0) }), 0);
});

test("a running agent that started before the extension loaded is marked as a lower bound; ended ones and later ones are not", () => {
  const since = BASE + 10_000;
  const early = storeOf(started("A", "early", { at: 0 })).agent("A")!;
  const late = storeOf(started("B", "late", { at: 20 })).agent("B")!;
  const usage = usageOf(900, 100);
  assert.equal(tokensPartial(early, "running", usage, since), true);
  assert.equal(tokensPartial(early, "idle", usage, since), true);
  assert.equal(tokensPartial(early, "done", usage, since), false);
  assert.equal(tokensPartial(late, "running", usage, since), false);
  assert.equal(tokensPartial(early, "running", undefined, since), false, "no usage from the extension: nothing to qualify");
  assert.equal(tokensPartial(early, "running", usage, undefined), false);

  const store = storeOf(started("A", "early", { at: 0 }), started("B", "late", { at: 20 }), completed("A", "t-A", { tokens: 40_000, at: 30 }));
  const list = listOf(store, { usage: { A: usageOf(900, 100), B: usageOf(2000, 500) }, usageSince: since });
  assert.deepEqual(list.map((e) => [e.name, e.status, e.tokens, e.tokensPartial]), [
    ["early", "done", 40_000, undefined],
    ["late", "running", 2_500, undefined],
  ]);
  const running = listOf(storeOf(started("A", "early", { at: 0 })), { usage: { A: usageOf(900, 100) }, usageSince: since });
  assert.deepEqual([running[0]!.tokens, running[0]!.tokensPartial], [1_000, true]);
});

const usageRecord = (agent: string, input: number, output: number, at = 1) =>
  ev("session.usage_record", { usage: { model: "m", inputTokens: input, outputTokens: output, cacheReadTokens: 999, cacheWriteTokens: 999 } }, agent, at);

test("usage records in events.jsonl add up input plus output per sub-agent, over every round, with or without the extension", () => {
  const store = storeOf(
    started("A", "a"),
    started("B", "b"),
    usageRecord("A", 1000, 100),
    usageRecord("A", 2000, 50, 2),
    usageRecord("B", 7, 3),
    ev("session.usage_record", { usage: { inputTokens: 500_000, outputTokens: 1 } }, null, 3), // 主会话的用量不算
    usageRecord("ghost", 5, 5), // 没见过的子 agent 不建占位记录
    ev("session.usage_record", { usage: { inputTokens: "x", outputTokens: -4 } }, "B", 4),
    completed("A", "t-A", { tokens: 3150, at: 5 }),
  );
  assert.deepEqual(store.agents().map((a) => [a.id, a.eventTokens]), [["A", 3150], ["B", 10]]);
  assert.equal(store.agent("ghost"), undefined);
  const tokens = tokensByAgent(store, null);
  assert.deepEqual([tokens.get("A"), tokens.get("B")], [3150, 10], "no extension, still counted");
  assert.equal(sessionTokens(store, null), 3160);
});

test("totalTokens is cumulative over all rounds, so rounds after the last completion make it too small: the larger known number wins and totals are never added up", () => {
  const store = storeOf(
    started("A", "a"),
    usageRecord("A", 40_000, 8_000),
    completed("A", "t-A", { tokens: 48_000, at: 5 }),
    ev("user.message", { content: "再做一轮" }, "A", 6),
    usageRecord("A", 12_000, 1_000, 7),
    ev("system.notification", { kind: { type: "agent_idle", agentId: "A" } }, null, 8),
    // 第二条完成事件（取消）带的也是累计数，不是这一轮的
    ev("subagent.completed", { toolCallId: "t-A", totalTokens: 61_000, cancelled: true }, "A", 9),
  );
  const agent = store.agent("A")!;
  assert.deepEqual([agent.totalTokens, agent.eventTokens], [61_000, 61_000]);
  assert.equal(tokensByAgent(store, null).get("A"), 61_000);

  const stale = storeOf(started("B", "b"), usageRecord("B", 40_000, 8_000), completed("B", "t-B", { tokens: 48_000, at: 5 }), ev("user.message", { content: "x" }, "B", 6), usageRecord("B", 12_000, 1_000, 7), ev("system.notification", { kind: { type: "agent_idle", agentId: "B" } }, null, 8));
  const b = stale.agent("B")!;
  assert.deepEqual([b.status, b.totalTokens, b.eventTokens], ["done", 48_000, 61_000]);
  assert.equal(tokensByAgent(stale, null).get("B"), 61_000, "the event log knows the later round, totalTokens does not");
  // 没有用量记录、也没有扩展（老版本的日志）：只能显示完成事件里的数
  const old = storeOf(started("C", "c"), completed("C", "t-C", { tokens: 48_000, at: 5 }));
  assert.equal(tokensByAgent(old, null).get("C"), 48_000);
});

test("with usage records in the log the number is exact, so it is never marked as a lower bound", () => {
  const since = BASE + 10_000;
  const early = storeOf(started("A", "early", { at: 0 }), usageRecord("A", 900, 100)).agent("A")!;
  assert.equal(tokensPartial(early, "running", usageOf(10, 10), since), false);
  const bare = storeOf(started("A", "early", { at: 0 })).agent("A")!;
  assert.equal(tokensPartial(bare, "running", usageOf(10, 10), since), true);
});

test("totalTokens already contains the sub-agents below an agent, so the top line adds up only the outermost ones and a parent shows at least what its children used", () => {
  const nested = (...extra: string[]) =>
    storeOf(
      taskCall("t-P", null),
      started("P", "parent", { at: 0 }),
      taskCall("t-K", "P"),
      started("K", "kid", { at: 1 }),
      started("Z", "other", { at: 2 }),
      usageRecord("P", 600, 0),
      usageRecord("K", 300, 100),
      usageRecord("Z", 50, 0),
      ev("subagent.completed", { toolCallId: "t-K", totalTokens: 400 }, "K", 5),
      ev("subagent.completed", { toolCallId: "t-P", totalTokens: 1000 }, "P", 6),
      ...extra,
    );
  const done = nested();
  const tokens = tokensByAgent(done, null);
  assert.deepEqual([tokens.get("P"), tokens.get("K"), tokens.get("Z")], [1000, 400, 50]);
  assert.equal(sessionTokens(done, null), 1050, "not 1000 + 400 + 50");
  // 父还在跑、没有完成事件：自己加下级，不会比下级用的还小
  const running = storeOf(taskCall("t-P", null), started("P", "parent", { at: 0 }), taskCall("t-K", "P"), started("K", "kid", { at: 1 }), usageRecord("P", 600, 0), usageRecord("K", 300, 100));
  assert.equal(tokensByAgent(running, null).get("P"), 1000);
  // 扩展的累加值比事件里的大时用它
  assert.equal(tokensByAgent(running, { K: usageOf(900, 100) }).get("P"), 1600);
});
