import assert from "node:assert/strict";
import { test } from "node:test";
import type { EntryStatus } from "../../src/types/model.ts";
import { lineText, lineWidth } from "../../src/ui/line.ts";
import { frameBar, frameColor, renderDividerLine, renderTitleLine, statusWord } from "../../src/ui/views/title.ts";
import { baseState } from "./body-support.ts";
import { command, entry } from "./views-support.ts";

const agent = entry({ description: "修登录失败的 bug", elapsedMs: 134_000 });
const title = (e = agent, focus: "list" | "content" = "list", cols = 80, tail = "", state = baseState({ focus })) => renderTitleLine(e, state, cols, tail);
const none = baseState();
/** 一行标题：文字加上线，补满 cols 列。 */
const padded = (text: string, cols: number, fill = "─") => text + fill.repeat(cols - lineWidth([{ text }]));

test("status words: 在跑, 等你发话, 已结束, 失败, 已取消, 已停", () => {
  const word = (status: EntryStatus, extra = {}) => statusWord(entry({ status, ...extra }), none);
  assert.deepEqual(
    [word("running"), word("idle"), word("done"), word("stopped"), word("failed"), word("cancelled"), word("stopped", { orphaned: true }), word("running", { orphaned: true })],
    ["在跑", "等你发话", "已结束", "已停", "失败", "已取消", "已停", "已停"],
  );
});

test("a command that has ended says how, with the exit code in full-width brackets", () => {
  const word = (over: Parameters<typeof command>[0], state = none) => statusWord(command(over), state);
  assert.equal(word({ status: "running" }), "在跑");
  assert.equal(word({ status: "failed", exitCode: 1 }), "失败（退出码 1）");
  assert.equal(word({ status: "done", exitCode: 0 }), "已结束（退出码 0）");
  assert.equal(word({ status: "failed", exitCode: 130 }), "已中断（退出码 130）");
  assert.equal(word({ status: "cancelled", exitCode: null }), "已中断");
  assert.equal(word({ status: "stopped", exitCode: 143 }), "已停");
  assert.equal(word({ status: "failed", exitCode: null }), "失败");
  assert.equal(word({ status: "failed", exitCode: 1 }, baseState({ interrupts: new Map([["cmd:c1", { signal: "SIGINT", at: 0 }]]) })), "已中断（退出码 1）");
});

test("title row, keyboard in the list: ┌─, name, description, model and status, a thin line to the last column in the dim kind colour", () => {
  const line = title();
  assert.equal(lineText(line), padded("┌─ fix-login  修登录失败的 bug  medium-1.0  在跑 2m14s ", 80));
  assert.equal(lineWidth(line), 80);
  assert.deepEqual(
    line.filter((s) => s.text.trim() !== "").map((s) => [s.text.slice(0, 10), s.style]),
    [
      ["┌─", { fg: "violetDim" }],
      ["fix-login", { fg: "violet", bold: true }],
      ["修登录失败的 bug", undefined],
      ["medium-1.0", { fg: "grey" }],
      ["在跑 2m14s", { fg: "text2" }],
      ["──────────", { fg: "violetDim" }],
    ],
  );
});

test("title row, keyboard in the content: ┏━ and a heavy line in the bright kind colour", () => {
  const line = title(agent, "content");
  assert.ok(lineText(line).startsWith("┏━ fix-login  修登录失败的 bug  medium-1.0  在跑 2m14s ━━━"));
  assert.equal(lineWidth(line), 80);
  assert.deepEqual(line[0]!.style, { fg: "violet" });
  assert.deepEqual(line.at(-1)!.style, { fg: "violet" });
  assert.ok(line.at(-1)!.text.endsWith("━"));
});

test("title row of a command: $ and the name in bold bright cyan, the status with the exit code, then the time", () => {
  const failed = command({ status: "failed", exitCode: 1, elapsedMs: 12_000 });
  const line = title(failed, "content");
  assert.ok(lineText(line).startsWith("┏━ $ npm run build  失败（退出码 1） 12s ━━"));
  assert.deepEqual(line.find((s) => s.text === "$ npm run build")?.style, { fg: "cyan", bold: true });
  assert.deepEqual(line.find((s) => s.text.startsWith("失败"))?.style, { fg: "text2" });
  assert.equal(title(failed, "list")[0]!.style?.fg, "cyanDim");
});

test("when the title does not fit the model goes first, then the description, then the name is cut", () => {
  const at = (cols: number) => lineText(title(agent, "list", cols));
  assert.ok(at(60).startsWith("┌─ fix-login  修登录失败的 bug  medium-1.0  在跑 2m14s ─"));
  assert.equal(at(48), padded("┌─ fix-login  修登录失败的 bug  在跑 2m14s ", 48));
  assert.equal(at(33), padded("┌─ fix-login  在跑 2m14s ", 33));
  assert.equal(at(24), padded("┌─ fix-lo…  在跑 2m14s ", 24));
  assert.equal(at(14), "┌─ 在跑 2m1… ─");
  for (let cols = 0; cols <= 100; cols++) assert.ok(lineWidth(title(agent, "content", cols, "第 2 个，共 7 个")) <= cols, `${cols}`);
});

test("an agent without a description has no gap where it would be", () => {
  assert.ok(lineText(title(entry({ elapsedMs: 134_000, model: null }))).startsWith("┌─ fix-login  在跑 2m14s ─"));
  assert.ok(lineText(title(entry({ elapsedMs: 134_000 }))).startsWith("┌─ fix-login  medium-1.0  在跑 2m14s ─"));
  assert.ok(lineText(title(entry({ description: "  跑\n测试  ", model: "small-1.0", elapsedMs: 134_000 }))).startsWith("┌─ fix-login  跑 测试  small-1.0  在跑"));
});

test("zoomed, the position is written at the end of the line in third tier, when there is room", () => {
  const line = title(agent, "list", 80, "第 2 个，共 7 个");
  assert.ok(lineText(line).endsWith("─ 第 2 个，共 7 个"), lineText(line));
  assert.equal(lineWidth(line), 80);
  assert.deepEqual(line.at(-1), { text: "第 2 个，共 7 个", style: { fg: "grey" } });
  const tight = title(agent, "list", 48, "第 2 个，共 7 个");
  assert.equal(lineText(tight).includes("第 2 个"), false, "no room for it, so the title keeps the line");
});

test("the divider above the input line is thin and dim, ┠ with the keyboard in the content and ├ otherwise", () => {
  assert.deepEqual(renderDividerLine("agent", "content", 20), [{ text: "┠" + "─".repeat(19), style: { fg: "violetDim" } }]);
  assert.deepEqual(renderDividerLine("command", "list", 12), [{ text: "├" + "─".repeat(11), style: { fg: "cyanDim" } }]);
  assert.deepEqual(renderDividerLine("agent", "list", 0), []);
});

test("the bar and the frame colour: kind says who gets the keys, weight and brightness say whether the keyboard is in the content", () => {
  assert.deepEqual([frameColor("agent", "content"), frameColor("agent", "list"), frameColor("command", "content"), frameColor("command", "list")], ["violet", "violetDim", "cyan", "cyanDim"]);
  assert.deepEqual(frameBar("agent", "content"), { text: "┃", style: { fg: "violet" } });
  assert.deepEqual(frameBar("command", "list"), { text: "│", style: { fg: "cyanDim" } });
});
