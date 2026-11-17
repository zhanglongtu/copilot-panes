import assert from "node:assert/strict";
import { test } from "node:test";
import { CSI, lineToAnsi, moveTo, SEQ, sgr } from "../../src/ui/ansi.ts";
import { span } from "../../src/ui/line.ts";
import { THEMES } from "../../src/ui/theme.ts";

test("moveTo is 1-based on the wire and 0-based in the API", () => {
  assert.equal(moveTo(0, 0), "\x1b[1;1H");
  assert.equal(moveTo(4, 12), "\x1b[5;13H");
  assert.equal(CSI, "\x1b[");
});

test("sgr writes 38;5 for palette colours, 38;2 for RGB and 48 for backgrounds", () => {
  const dark = THEMES.dark;
  assert.equal(sgr(undefined, dark), "\x1b[0m");
  assert.equal(sgr({}, dark), "\x1b[0m");
  assert.equal(sgr({ fg: "violet", bold: true }, dark), "\x1b[0;1;38;5;141m");
  assert.equal(sgr({ fg: "violet", bold: true }, THEMES.light), "\x1b[0;1;38;5;56m");
  assert.equal(sgr({ fg: 33 }, dark), "\x1b[0;38;5;33m");
  assert.equal(sgr({ fg: { r: 1, g: 22, b: 255 } }, dark), "\x1b[0;38;2;1;22;255m");
  assert.equal(sgr({ bg: 236 }, dark), "\x1b[0;48;5;236m");
  assert.equal(sgr({ bg: { r: 10, g: 20, b: 30 }, fg: "red" }, dark), "\x1b[0;38;5;210;48;2;10;20;30m");
  assert.equal(sgr({ dim: true, italic: true, underline: true, inverse: true }, dark), "\x1b[0;2;3;4;7m");
  assert.equal(sgr({ bold: false, fg: 999 }, dark), "\x1b[0;38;5;255m");
});

test("the selected-row colours are 256-colour backgrounds that follow the theme", () => {
  assert.equal(sgr({ bg: "selFocus" }, THEMES.dark), "\x1b[0;48;5;237m");
  assert.equal(sgr({ bg: "selBlur" }, THEMES.dark), "\x1b[0;48;5;236m");
  assert.equal(sgr({ fg: "text2", bg: "selFocus", bold: true }, THEMES.light), "\x1b[0;1;38;5;238;48;5;252m");
  // 铺满的底色空格也是片段，行尾的空格不会被丢掉
  const row = [span("▌", { fg: "violet", bg: "selFocus" }), span("  ", { bg: "selFocus" })];
  assert.equal(lineToAnsi(row, THEMES.dark), "\x1b[0;38;5;141;48;5;237m▌\x1b[0;48;5;237m  \x1b[0m");
});

test("lineToAnsi skips repeated styles, strips control characters from text and ends with a reset", () => {
  const dark = THEMES.dark;
  const line = [span("a", { fg: "cyan" }), span("b", { fg: "cyan" }), span("c"), span("d", { fg: "red" })];
  assert.equal(lineToAnsi(line, dark), "\x1b[0;38;5;80mab\x1b[0mc\x1b[0;38;5;210md\x1b[0m");
  assert.equal(lineToAnsi([span("plain")], dark), "\x1b[0mplain\x1b[0m");
  assert.equal(lineToAnsi([], dark), "\x1b[0m");

  const hostile = span("x\x1b[31mred\x07\r\n\t\u009b\x7fy", { dim: true });
  const out = lineToAnsi([hostile], dark);
  assert.equal(out, "\x1b[0;2mx[31mredy\x1b[0m");
  assert.ok(!out.slice(out.indexOf("m") + 1, -4).includes("\x1b"));
  assert.equal(lineToAnsi([span("\x1b\x07"), span("ok")], dark), "\x1b[0mok\x1b[0m");
});

test("the control sequences are the ones the output layer relies on", () => {
  assert.equal(SEQ.altScreenOn, "\x1b[?1049h");
  assert.equal(SEQ.mouseOn, "\x1b[?1000h\x1b[?1002h\x1b[?1006h");
  assert.equal(SEQ.syncBegin, "\x1b[?2026h");
  assert.equal(SEQ.syncEnd, "\x1b[?2026l");
  assert.equal(SEQ.pasteOn, "\x1b[?2004h");
});
