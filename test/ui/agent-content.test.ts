import assert from "node:assert/strict";
import { test } from "node:test";
import { lineText, lineWidth } from "../../src/ui/line.ts";
import { agentContentLines, agentContentWindow, agentPlainText, agentRowCount } from "../../src/ui/views/agent.ts";
import type { AgentContentOptions } from "../../src/ui/views/agent.ts";
import { matchRows, scrollForRow } from "../../src/ui/views/content.ts";
import { baseState, fakeStore, say, toolItem } from "./body-support.ts";
import type { Item } from "./body-support.ts";

const options = (over: Partial<AgentContentOptions> = {}): AgentContentOptions => ({ width: 40, expanded: false, now: 100_000, spinnerFrame: 0, ...over });
const texts = (lines: readonly (readonly { text: string }[])[]) => lines.map((line) => line.map((s) => s.text).join(""));

test("say text wraps by width without splitting a Chinese character, and no row is wider than the width", () => {
  const long = "清空会话的调用在第七十一行，我把它移到登出函数里面，然后再补一条测试，最后运行全部的测试确认没有问题。 ok";
  for (const width of [10, 11, 17, 24, 40]) {
    const lines = agentContentLines(fakeStore([say(long)]), "a1", options({ width }));
    assert.ok(lines.length > 1);
    assert.equal(texts(lines).join("").replaceAll(" ", ""), long.replaceAll(" ", ""));
    for (const line of lines) assert.ok(lineWidth(line) <= width, `width ${width}: ${lineText(line)}`);
    assert.ok(lines.every((line) => line.every((s) => s.style === undefined)), "say text keeps the default colour");
  }
});

test("the task shows its first 2 lines, each on one row; the rest is a hint until it is expanded", () => {
  const task: Item = { kind: "task", at: 0, text: "第一行任务\n第二行任务\n\n第三行任务\n第四行任务" };
  const store = fakeStore([task]);
  const collapsed = texts(agentContentLines(store, "a1", options()));
  assert.deepEqual(collapsed, ["任务：第一行任务", "第二行任务  （还有 2 行，按 e 展开）", ""]);
  const expanded = texts(agentContentLines(store, "a1", options({ expanded: true })));
  assert.deepEqual(expanded, ["任务：第一行任务", "第二行任务", "", "第三行任务", "第四行任务", ""]);

  const clipped = agentContentLines(fakeStore([{ kind: "task", at: 0, text: "x".repeat(100) }]), "a1", options({ width: 20 }));
  assert.equal(lineText(clipped[0]!), `任务：${"x".repeat(13)}…`);
  assert.deepEqual(clipped[0]!.map((s) => s.style), [{ fg: "grey" }]);
});

test("a task whose opening is shared with other tasks: collapsed it starts after the shared part; expanded it says how much is shared", () => {
  const shared = "开始前先读项目说明。\n\n";
  const text = `${shared}登录失败是因为 refreshToken() 提前清空了会话。\n把清空动作移到 logout() 里。\n再跑测试。`;
  const task: Item = { kind: "task", at: 0, text };
  const folded = fakeStore([task], "running", shared.length);
  assert.deepEqual(texts(agentContentLines(folded, "a1", options({ width: 60 }))), [
    "任务：登录失败是因为 refreshToken() 提前清空了会话。",
    "把清空动作移到 logout() 里。  （还有 1 行，按 e 展开）",
    "",
  ]);
  const expanded = agentContentLines(folded, "a1", options({ width: 60, expanded: true }));
  assert.equal(lineText(expanded[0]!), `（开头 ${shared.length} 个字和其他任务相同）`);
  assert.deepEqual(expanded[0], [{ text: `（开头 ${shared.length} 个字和其他任务相同）`, style: { fg: "grey" } }]);
  assert.ok(lineText(expanded[1]!).startsWith("任务：开始前先读"), "the whole text follows the note");
  // 没有这个字段、是 0、或者整份说明都相同时，和没有折叠时一样
  for (const fold of [undefined, 0, text.length, text.length + 50]) {
    const plain = texts(agentContentLines(fakeStore([task], "running", fold), "a1", options({ width: 60 })));
    assert.ok(plain[0]!.startsWith("任务：开始前先读"), `fold ${fold}`);
    assert.equal(texts(agentContentLines(fakeStore([task], "running", fold), "a1", options({ width: 60, expanded: true })))[0]!.startsWith("（开头"), false);
  }
  // 折叠的字数变了，行数和内容跟着变
  const more = fakeStore([task], "running", shared.length + 5);
  assert.ok(texts(agentContentLines(more, "a1", options({ width: 60 })))[0]!.startsWith("任务：因为 refreshToken()"));
  const rowCount = (store: ReturnType<typeof fakeStore>) => agentRowCount(store, "a1", options({ width: 60, expanded: true }));
  assert.equal(rowCount(folded), rowCount(fakeStore([task])) + 1, "the expanded record has one more row, the note");
});

test("messages: yours is bold and starts with ›, others are grey and start with the sender", () => {
  const store = fakeStore([
    { kind: "message", at: 0, from: "you", fromName: "你", text: "请先别动 auth.ts，我想想怎么改比较稳妥" },
    { kind: "message", at: 1, from: "main", fromName: "主会话", text: "收到" },
  ]);
  const lines = agentContentLines(store, "a1", options({ width: 20 }));
  assert.deepEqual(texts(lines), ["› 请先别动 auth.ts，", "  我想想怎么改比较稳", "  妥", "主会话：收到"]);
  assert.deepEqual(lines[0]!.map((s) => s.style), [{ bold: true }]);
  assert.deepEqual(lines[2]!.map((s) => s.style), [{ bold: true }]);
  assert.deepEqual(lines[3]!.map((s) => s.style), [{ fg: "grey" }]);
});

test("tool results and thinking show only when expanded; long results are cut with a count", () => {
  const result = Array.from({ length: 15 }, (_, i) => `line ${i + 1}`).join("\n");
  const items: Item[] = [
    { kind: "think", at: 0, text: "想一想" },
    toolItem({ toolName: "view", args: { path: "/work/src/a.ts" }, resultText: result }),
    toolItem({ toolCallId: "t2", toolName: "edit", args: { path: "/work/src/b.ts" }, status: "failed", errorText: "no match" }),
  ];
  const store = fakeStore(items);
  const collapsed = agentContentLines(store, "a1", options());
  assert.deepEqual(texts(collapsed), ["▸ 看  src/a.ts", "▸ 改  src/b.ts  失败"]);
  assert.deepEqual(collapsed[1]!.map((s) => s.style), [{ fg: "grey" }, { fg: "red" }]);

  const expanded = texts(agentContentLines(store, "a1", options({ expanded: true })));
  assert.equal(expanded[0], "思考：想一想");
  assert.equal(expanded[1], "▸ 看  src/a.ts");
  assert.equal(expanded[2], "  line 1");
  assert.equal(expanded[13], "  line 12");
  assert.equal(expanded[14], "  … 还有 3 行");
  assert.equal(expanded[15], "▸ 改  src/b.ts  失败");
  assert.equal(expanded[16], "  no match");
});

test("the waiting row appears only while the agent runs and its last tool call is still going", () => {
  const waiting = toolItem({ toolCallId: "t9", toolName: "task", args: { name: "run-tests", mode: "sync" }, status: "running", endedAt: null });
  const running = fakeStore([say("开始"), { ...waiting, at: 50_000 }]);
  const lines = agentContentLines(running, "a1", options({ spinnerFrame: 3 }));
  const last = lines[lines.length - 1]!;
  assert.equal(lineText(last), "⠸ 等 run-tests 交回结果  50s");
  assert.deepEqual(last.map((s) => s.style), [undefined, { fg: "grey" }]);

  const ended = fakeStore([say("开始"), { ...waiting, at: 50_000 }], "done");
  assert.ok(!texts(agentContentLines(ended, "a1", options())).some((row) => row.includes("等 run-tests")));
});

test("a failed end adds a red line; resume and a normal end add nothing", () => {
  const store = fakeStore([
    { kind: "resume", at: 0 },
    { kind: "end", at: 1, status: "done", durationMs: 1, toolCalls: 1, tokens: 1, error: null },
    { kind: "end", at: 2, status: "failed", durationMs: 1, toolCalls: 1, tokens: 1, error: "模型超时" },
  ]);
  const lines = agentContentLines(store, "a1", options());
  assert.deepEqual(texts(lines), ["失败：模型超时"]);
  assert.deepEqual(lines[0]!.map((s) => s.style), [{ fg: "red" }]);
});

const numbered = (n: number) => fakeStore(Array.from({ length: n }, (_, i) => say(`row ${i}`)));
const window = (store: ReturnType<typeof numbered>, rows: number, scroll: number, scrollTotal?: number | null) =>
  agentContentWindow(store, "a1", { ...options(), rows, scroll, scrollTotal });

test("the window follows the bottom, scrolls up by lines, and clamps at both ends", () => {
  const store = numbered(20);
  assert.deepEqual(texts(window(store, 5, 0).lines), ["row 15", "row 16", "row 17", "row 18", "row 19"]);
  assert.deepEqual(texts(window(store, 5, 4).lines), ["row 11", "row 12", "row 13", "row 14", "row 15"]);
  assert.deepEqual(window(store, 5, 4).scroll, { below: 4, fresh: 0 });
  assert.deepEqual(texts(window(store, 5, 999).lines), ["row 0", "row 1", "row 2", "row 3", "row 4"]);
  assert.equal(window(store, 5, 999).scroll.below, 15);
  assert.deepEqual(texts(window(store, 5, -3).lines), ["row 15", "row 16", "row 17", "row 18", "row 19"]);
});

test("a short content sits at the top and the window pads it with empty rows", () => {
  const win = window(numbered(2), 5, 0);
  assert.equal(win.lines.length, 5);
  assert.deepEqual(texts(win.lines), ["row 0", "row 1", "", "", ""]);
});

test("after the user scrolls up, new rows do not move the window and are counted", () => {
  const before = numbered(20);
  assert.equal(agentRowCount(before, "a1", { width: 40, expanded: false }), 20);
  const seen = window(before, 5, 4, 20);
  const after = numbered(23);
  const still = window(after, 5, 4, 20);
  assert.deepEqual(texts(still.lines), texts(seen.lines));
  assert.deepEqual(still.scroll, { below: 7, fresh: 3 });
  // 没翻看（scroll 为 0）时新内容照常顶上来。
  assert.deepEqual(texts(window(after, 5, 0, 20).lines), ["row 18", "row 19", "row 20", "row 21", "row 22"]);
});

test("search highlights every hit (underline) and the current row in reverse; matchRows and scrollForRow agree", () => {
  const store = fakeStore([say("Alpha beta\nalpha again"), say("nothing"), say("ALPHA")]);
  const all = agentContentLines(store, "a1", options());
  assert.deepEqual(matchRows(all, "alpha"), [0, 1, 3]);
  assert.deepEqual(matchRows(all, ""), []);

  const marked = agentContentLines(store, "a1", options({ search: { query: "alpha", currentRow: 1 } }));
  assert.deepEqual(marked[0], [{ text: "Alpha", style: { underline: true } }, { text: " beta" }]);
  assert.deepEqual(marked[1], [{ text: "alpha", style: { inverse: true, bold: true } }, { text: " again" }]);
  assert.deepEqual(marked[2], [{ text: "nothing" }]);

  const win = agentContentWindow(store, "a1", { ...options({ search: { query: "alpha", currentRow: 3 } }), rows: 2, scroll: 0 });
  assert.deepEqual(win.lines[1], [{ text: "ALPHA", style: { inverse: true, bold: true } }]);

  assert.equal(scrollForRow(40, 10, 5), 30);
  assert.equal(scrollForRow(40, 10, 20), 15);
  assert.equal(scrollForRow(40, 10, 39), 0);
  assert.equal(scrollForRow(4, 10, 2), 0);
});

test("agentPlainText is the unwrapped, fully expanded text without the waiting row", () => {
  const long = "很长的一句话".repeat(20);
  const items: Item[] = [
    { kind: "task", at: 0, text: "任务一\n任务二\n任务三" },
    say(long),
    toolItem({ resultText: Array.from({ length: 15 }, (_, i) => `r${i}`).join("\n") }),
    { ...toolItem({ toolCallId: "t9", toolName: "task", args: { name: "x", mode: "sync" }, status: "running", endedAt: null }) },
  ];
  const text = agentPlainText(fakeStore(items), "a1", baseState());
  const rows = text.split("\n");
  assert.deepEqual(rows.slice(0, 4), ["任务：任务一", "任务二", "任务三", ""]);
  assert.equal(rows[4], long);
  assert.equal(rows.filter((r) => r.startsWith("  r")).length, 15);
  assert.ok(!text.includes("等 x 交回结果"));
});
