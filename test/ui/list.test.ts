import assert from "node:assert/strict";
import { test } from "node:test";
import { SPINNER_FRAMES } from "../../src/constants.ts";
import type { ListEntry } from "../../src/types/model.ts";
import type { Line } from "../../src/types/ui.ts";
import { lineText, lineWidth } from "../../src/ui/line.ts";
import { hiddenEndedLine, listColumns, listScrollHint, progressBar, progressOf, renderListRow, statusSymbol } from "../../src/ui/views/list.ts";
import type { ListRowOptions } from "../../src/ui/views/list.ts";
import { command, entry } from "./views-support.ts";

const wide = listColumns(80, true, true);
const row = (e = entry(), over: Partial<ListRowOptions> = {}) =>
  renderListRow(e, { selected: false, unread: false, focus: "list", spinnerFrame: 2, columns: wide, ...over });
const blanks = (line: Line) => line.filter((s) => s.text.trim() !== "");
/** 每个非空片段的前景色，从左到右。 */
const colours = (line: Line) => blanks(line).map((s) => s.style?.fg);

test("status symbols: a spinner frame for running, ○ idle, ✓ done, ✗ failed, ⊘ cancelled, ◌ stopped with the session", () => {
  assert.equal(statusSymbol(entry(), 2), "⠹");
  assert.equal(statusSymbol(entry(), 12), "⠹");
  assert.equal(statusSymbol(entry(), -1), SPINNER_FRAMES.at(-1));
  assert.deepEqual((["idle", "done", "stopped", "failed", "cancelled"] as const).map((status) => statusSymbol(entry({ status }), 0)), ["○", "✓", "◌", "✗", "⊘"]);
});

test("column widths: the name grows only on wide panes, the model goes first and the token column second", () => {
  assert.deepEqual(listColumns(80, true, true), { showModel: true, showTokens: true, nameWidth: 22, lastWidth: 29, maxWidth: 80 });
  assert.deepEqual(listColumns(50, false, true), { showModel: false, showTokens: true, nameWidth: 18, lastWidth: 14, maxWidth: 50 });
  assert.equal(listColumns(90, true, true).nameWidth, 22);
  assert.equal(listColumns(130, true, true).nameWidth, 42);
  assert.equal(listColumns(300, true, true).nameWidth, 48);
  const tiny = listColumns(12, false, false);
  assert.deepEqual([tiny.nameWidth, tiny.lastWidth], [8, 0]);
});

test("running: bright kind colour on the symbol and the bold name, first-tier time and step, third-tier model and tokens", () => {
  const line = row();
  assert.equal(lineText(line), "  ⠹ fix-login              medium-1.0 2m14s 18.3万 等 run-tests 交回结果");
  const styles = Object.fromEntries(blanks(line).map((s) => [s.text.trim(), s.style]));
  assert.deepEqual(styles["⠹"], { fg: "violet" });
  assert.deepEqual(styles["fix-login"], { fg: "violet", bold: true });
  assert.deepEqual(styles["medium-1.0"], { fg: "grey" });
  assert.equal(styles["2m14s"], undefined);
  assert.deepEqual(styles["18.3万"], { fg: "grey" });
  assert.equal(styles["等 run-tests 交回结果"], undefined);
  const cmd = row(command());
  assert.deepEqual(colours(cmd).slice(0, 2), ["cyan", "cyan"]);
});

test("waiting for you: unread is bright and first-tier with an orange dot, read is one tier dimmer all the way", () => {
  const idle = entry({ status: "idle", step: "做完一轮，等你发话" });
  assert.deepEqual(colours(row(idle, { unread: true })), ["orange", "violet", undefined, "text2", "text2", "text2", "text2"]);
  assert.deepEqual(colours(row(idle)), ["violetDim", "text2", "grey", "grey", "grey", "grey"]);
  assert.deepEqual(colours(row(command({ status: "idle" }))).slice(0, 2), ["cyanDim", "text2"]);
  assert.equal(row(idle, { unread: true })[0]!.text, "•");
});

test("failed: the cross is bright red when unread and dim red when read; the name and the rest are never coloured", () => {
  const failed = entry({ status: "failed", step: "迁移第 3 步报错" });
  assert.deepEqual(colours(row(failed, { unread: true })), ["orange", "red", "text2", "grey", "grey", "grey", "text2"]);
  assert.deepEqual(colours(row(failed)), ["redDim", "grey", "grey", "grey", "grey", "grey"]);
  const build = command({ status: "failed", step: "退出码 1", exitCode: 1 });
  assert.deepEqual(colours(row(build)), ["redDim", "grey", "grey", "grey"]);
});

test("ended, cancelled and orphaned rows are third-tier all the way, with ✓, ⊘ and ◌", () => {
  for (const [e, symbol] of [
    [entry({ status: "done", step: "交回了报告" }), "✓"],
    [entry({ status: "stopped", step: "已停" }), "◌"],
    [entry({ status: "cancelled", step: "取消了" }), "⊘"],
    [entry({ status: "stopped", orphaned: true, step: "已停" }), "◌"],
    [entry({ status: "running", orphaned: true, step: "已停" }), "◌"],
  ] as const) {
    const line = row(e);
    assert.equal(blanks(line)[0]!.text, symbol);
    assert.ok(blanks(line).every((s) => s.style?.fg === "grey"), `${e.status}: ${lineText(line)}`);
  }
  // 结束了又没看过：行首有橙点，文字还是三档
  const unreadDone = row(entry({ status: "done" }), { unread: true });
  assert.deepEqual(colours(unreadDone).slice(0, 2), ["orange", "grey"]);
});

test("the selected row: a bright kind-coloured block in column 0, a bold name, text one tier brighter and the background to the last column", () => {
  const selected = row(entry(), { selected: true });
  assert.deepEqual(selected[0], { text: "▌", style: { fg: "violet", bg: "selFocus" } });
  assert.equal(lineWidth(selected), 80);
  assert.ok(selected.every((s) => s.style?.bg === "selFocus"));
  assert.equal(selected.at(-1)!.text.trim(), "", "the end of the row is filled with spaces");
  assert.deepEqual(selected.find((s) => s.text.startsWith("fix-login"))?.style, { fg: "violet", bold: true, bg: "selFocus" });

  const blurred = row(command(), { selected: true, focus: "content" });
  assert.deepEqual(blurred[0], { text: "▌", style: { fg: "cyan", bg: "selBlur" } });
  assert.ok(blurred.every((s) => s.style?.bg === "selBlur"));

  // 三档变二档，二档变一档，暗色的符号变亮
  const done = row(entry({ status: "done", step: "交回了报告" }), { selected: true });
  assert.deepEqual(colours(done).slice(0, 3), ["violet", "text2", "text2"]);
  assert.equal(done.find((s) => s.text.startsWith("fix-login"))?.style?.bold, true);
  const idleRead = row(entry({ status: "idle", step: "做完一轮，等你发话" }), { selected: true });
  assert.deepEqual(colours(idleRead), ["violet", "violet", undefined, "text2", "text2", "text2", "text2"]);
  const failed = row(entry({ status: "failed", step: "出错了" }), { selected: true });
  assert.deepEqual(colours(failed).slice(0, 3), ["violet", "red", "text2"]);
  assert.equal(lineText(selected).slice(0, 4), "▌ ⠹ ");
});

test("an unread row has an orange dot unless it is the selected one", () => {
  assert.deepEqual(row(entry(), { unread: true })[0], { text: "•", style: { fg: "orange" } });
  assert.equal(row(entry(), { unread: true, selected: true })[0]!.text, "▌");
  assert.equal(lineText(row(entry(), { unread: true })).slice(0, 1), "•");
});

test("a command takes the model column's room, and nested rows are indented two columns per level", () => {
  const line = lineText(row(command({ depth: 2, elapsedMs: 41_000, step: "7/23 30%", name: "pytest -v tests/" }), { columns: listColumns(79, true, true) }));
  assert.equal(line, "  ⠹     $ pytest -v tests/              41s        7/23 30%");
  const narrow = lineText(row(command({ name: "python3 -u score.py --run nov15" }), { columns: listColumns(50, false, true) }));
  assert.equal(narrow, "  ⠹ $ python3 -u scor… 2m14s        12/40 30%");
});

test("a running command with a recognised progress draws a 10-cell bar in bright cyan at 80 columns or more, and only the numbers below", () => {
  const running = command({ step: "12/40 30%" });
  const bar = row(running);
  assert.equal(lineText(bar), "  ⠹ $ npm run build                   2m14s        ▰▰▰▱▱▱▱▱▱▱ 12/40 30%");
  assert.deepEqual(bar.find((s) => s.text.startsWith("▰"))?.style, { fg: "cyan" });
  assert.equal(bar.find((s) => s.text === "12/40 30%")?.style, undefined, "the numbers are first-tier");
  assert.ok(lineText(row(running, { columns: listColumns(79, true, true) })).endsWith("2m14s        12/40 30%"));
  assert.ok(lineText(row(command({ step: "30%" }))).endsWith("▰▰▰▱▱▱▱▱▱▱ 30%"));
  // 没有进度的命令、不在跑的命令、子 agent 都不画
  assert.ok(!lineText(row(command({ step: "下载中" }))).includes("▰"));
  assert.ok(!lineText(row(command({ status: "failed", step: "12/40 30%" }))).includes("▰"));
  assert.ok(!lineText(row(entry({ step: "12/40 30%" }))).includes("▰"));
  // 选中的行里进度条仍是青·亮，数字提一档（一档不变）
  assert.deepEqual(row(running, { selected: true }).find((s) => s.text.startsWith("▰"))?.style, { fg: "cyan", bg: "selFocus" });
});

test("progress: fractions and percentages are recognised, anything else is not; the bar floors to whole cells", () => {
  assert.equal(progressOf("12/40 30%"), 0.3);
  assert.equal(progressOf("7/23 30%"), 7 / 23);
  assert.equal(progressOf("45%"), 0.45);
  assert.equal(progressOf("40/40 100%"), 1);
  assert.equal(progressOf("下载中"), null);
  assert.equal(progressOf("3/0"), null);
  assert.equal(progressOf("退出码 1"), null);
  assert.equal(progressBar(0.3), "▰▰▰▱▱▱▱▱▱▱");
  assert.equal(progressBar(0), "▱▱▱▱▱▱▱▱▱▱");
  assert.equal(progressBar(1), "▰▰▰▰▰▰▰▰▰▰");
  assert.equal(progressBar(0.999), "▰▰▰▰▰▰▰▰▰▱");
  assert.equal(lineWidth([{ text: progressBar(0.5) }]), 10);
});

test("a row never exceeds the pane, even when the columns do not fit", () => {
  for (const cols of [1, 4, 9, 12, 17, 20, 30, 47, 48, 59, 60, 80, 200]) {
    const columns = listColumns(cols, cols >= 60, cols >= 48);
    for (const e of [entry(), command({ name: "x".repeat(200), step: "12/40 30%" }), entry({ name: "名".repeat(40), depth: 3 })]) {
      for (const selected of [false, true]) {
        const line = row(e, { columns, selected });
        assert.ok(lineWidth(line) <= cols, `${cols} columns: ${lineText(line)}`);
        if (selected && cols >= 9) assert.equal(lineWidth(line), cols, `the background runs to the last column at ${cols}`);
      }
    }
  }
});

test("an orphaned row (the session's process is gone) has a neutral symbol that does not spin and is third-tier all the way", () => {
  const stopped = entry({ status: "stopped", orphaned: true, step: "已停", elapsedMs: 90_000 });
  assert.equal(statusSymbol(stopped, 0), "◌");
  assert.equal(statusSymbol(stopped, 5), "◌");
  const line = row(stopped);
  assert.equal(lineText(line), "  ◌ fix-login              medium-1.0 1m30s 18.3万 已停");
  assert.ok(blanks(line).every((s) => s.style?.fg === "grey"));
});

test("a running agent whose tokens are only a lower bound writes them with ≥ inside the 6-column token column", () => {
  const line = row(entry({ tokens: 123_456, tokensPartial: true }));
  assert.equal(lineText(line), "  ⠹ fix-login              medium-1.0 2m14s  ≥12万 等 run-tests 交回结果");
  assert.equal(lineWidth(line), lineWidth(row(entry({ tokens: 123_456 }))), "the column does not move");
});

test("the scroll hint says how many are above and below, in second tier when a hidden one is running and third tier otherwise", () => {
  const hint = listScrollHint(3, 5, 0, 2);
  assert.equal(lineText(hint), "  ↑ 上面还有 3 个  ↓ 下面还有 5 个，其中 2 个在跑");
  assert.deepEqual(blanks(hint).map((s) => [s.text, s.style?.fg]), [
    ["↑ 上面还有 3 个", "grey"],
    ["↓ 下面还有 5 个，其中 2 个在跑", "text2"],
  ]);
  assert.equal(lineText(listScrollHint(0, 4, 0, 0)), "  ↓ 下面还有 4 个");
  assert.equal(lineText(listScrollHint(24, 0, 1, 0)), "  ↑ 上面还有 24 个，其中 1 个在跑");
  assert.deepEqual(listScrollHint(0, 0, 0, 0), []);
});

test("the hidden-ended line says how many were folded away and how to bring them back, in third tier", () => {
  const line = hiddenEndedLine(5);
  assert.equal(lineText(line), "  … 收起了 5 个已结束的，按 c 显示");
  assert.ok(blanks(line).every((s) => s.style?.fg === "grey"));
});

test("entries of every status draw", () => {
  for (const status of ["running", "idle", "done", "failed", "stopped", "cancelled"] as const) {
    const e: ListEntry = entry({ status });
    assert.ok(lineWidth(row(e)) <= 80, status);
  }
});
