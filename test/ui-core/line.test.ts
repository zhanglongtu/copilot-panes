import assert from "node:assert/strict";
import { test } from "node:test";
import { cell, fitLine, frameText, lineText, lineWidth, span, wrapLine } from "../../src/ui/line.ts";
import { wrapText } from "../../src/ui/width.ts";
import type { Frame, Line } from "../../src/types/ui.ts";

test("span leaves out the style key when there is no style", () => {
  assert.deepEqual(span("a"), { text: "a" });
  assert.ok(!("style" in span("a")));
  assert.deepEqual(span("a", { fg: "red", bold: true }), { text: "a", style: { fg: "red", bold: true } });
});

test("lineWidth and lineText add up the spans", () => {
  const line: Line = [span("ab"), span("你好", { fg: "cyan" }), span("")];
  assert.equal(lineWidth(line), 6);
  assert.equal(lineText(line), "ab你好");
  assert.equal(lineWidth([]), 0);
});

test("fitLine cuts a row to the pane the way the list and the content need it", () => {
  const task = "任务：登录失败是因为 src/auth.ts 里的 refreshToken() 提前清空了会话。";
  assert.equal(lineText(fitLine([span(task)], 48)), "任务：登录失败是因为 src/auth.ts 里的 refreshTo…");
  assert.equal(lineText(fitLine([span(task)], 200)), task);
  assert.equal(lineText(fitLine([span("› 插一句话给 fix-login，它做完手上这一步就会看到")], 48)), "› 插一句话给 fix-login，它做完手上这一步就会看到");
  for (const width of [120, 80, 60, 50, 48, 30, 20, 10, 1, 0]) assert.ok(lineWidth(fitLine([span(task)], width)) <= width, `${width}`);
});

test("cell fills a column: clips with …, pads with spaces on the left for right-aligned numbers", () => {
  assert.equal(lineText(cell([span("python3 -u score.py --run nov15")], 22)), "python3 -u score.py -…");
  assert.equal(lineText(cell([span("48s")], 5, "right")), "  48s");
  assert.equal(lineText(cell([span("1.1万")], 6, "right")), " 1.1万");
  assert.equal(lineText(cell([span("12/40 30%")], 14)), "12/40 30%     ");
  for (const [text, width] of [["你好世界", 5], ["abc", 2], ["", 3]] as const) assert.equal(lineWidth(cell([span(text)], width)), width);
});

test("fitLine clips the span that does not fit, keeps its style and drops the spans after it", () => {
  const line: Line = [span("ab", { fg: "violet" }), span("", { bold: true }), span("你好世界", { fg: "grey" }), span("尾巴")];
  const fitted = fitLine(line, 7);
  assert.deepEqual(fitted, [span("ab", { fg: "violet" }), span("你好…", { fg: "grey" })]);
  assert.deepEqual(fitLine(line, 2), [span("ab", { fg: "violet" })]);
  assert.deepEqual(fitLine(line, 0), []);
  assert.deepEqual(fitLine(line, 20), [span("ab", { fg: "violet" }), span("你好世界", { fg: "grey" }), span("尾巴")]);
});

test("cell pads with unstyled spaces on the chosen side", () => {
  assert.deepEqual(cell([span("你", { fg: "red" })], 5), [span("你", { fg: "red" }), span("   ")]);
  assert.deepEqual(cell([span("ab")], 5, "right"), [span("   "), span("ab")]);
  assert.deepEqual(cell([span("abcdef", { bold: true })], 4), [span("abc…", { bold: true })]);
  assert.deepEqual(cell([], 3), [span("   ")]);
  assert.deepEqual(cell([span("ab")], 2), [span("ab")]);
});

test("wrapLine keeps each character's style", () => {
  const line: Line = [span("hello ", { fg: "cyan" }), span("你好世界abc", { fg: "violet", bold: true }), span(" end")];
  const rows = wrapLine(line, 10);
  assert.deepEqual(
    rows.map(lineText),
    wrapText("hello 你好世界abc end", 10),
  );
  for (const row of rows) assert.ok(lineWidth(row) <= 10);
  assert.deepEqual(rows[0], [span("hello", { fg: "cyan" })]);
  const styledChars = rows.flatMap((row) => row.flatMap((s) => [...s.text].map(() => s.style)));
  assert.equal(styledChars.filter((s) => s?.bold).length, "你好世界abc".length);
  assert.equal(styledChars.filter((s) => s?.fg === "cyan").length, "hello".length);
  assert.deepEqual(wrapLine([], 10), [[]]);
  assert.deepEqual(wrapLine([span("a\nb", { dim: true })], 10), [[span("a", { dim: true })], [span("b", { dim: true })]]);
});

test("frameText trims line ends and joins with newlines", () => {
  const frame: Frame = {
    lines: [[span("┃ "), span("名字  ", { fg: "violet" })], [], [span("│ 内容 ")], [span("   ")]],
    cursor: null,
  };
  assert.equal(frameText(frame), "┃ 名字\n\n│ 内容\n");
});
