import assert from "node:assert/strict";
import { test } from "node:test";
import { TermView } from "../../src/term/terminal.ts";
import type { Line, TerminalLines } from "../../src/types/ui.ts";
import { lineText, lineWidth } from "../../src/ui/line.ts";
import {
  EVENT_OUTPUT_NOTICE,
  NO_OUTPUT_TEXT,
  ORPHANED_NO_OUTPUT_TEXT,
  commandContentLines,
  commandContentWindow,
  commandEventRows,
  commandHeaderRows,
  commandRowCount,
} from "../../src/ui/views/command.ts";

const texts = (lines: readonly Line[]) => lines.map((line) => line.map((s) => s.text).join(""));

/** 和真终端一样：屏幕至少有 rows 行，没写的行是空的。 */
function terminalOf(rows: Line[], screenRows: number, cols = 40): TerminalLines {
  const all = [...rows];
  while (all.length < screenRows) all.push([]);
  return { cols, rows: screenRows, totalLines: all.length, lines: (start, count) => all.slice(Math.max(0, start), Math.max(0, start) + count) };
}
const plain = (n: number): Line[] => Array.from({ length: n }, (_, i) => [{ text: `out ${i}` }]);

test("the command's own colours and bold pass through; blank rows at the bottom of the screen are not content", () => {
  const rows: Line[] = [
    [{ text: "ok ", style: { fg: 2, bold: true } }, { text: "done", style: { fg: { r: 1, g: 2, b: 3 } } }],
    [{ text: "bg", style: { bg: 4 } }],
  ];
  const term = terminalOf(rows, 10);
  const lines = commandContentLines(term, 0, 8);
  assert.equal(lines.length, 2);
  assert.deepEqual(lines, rows);
  assert.equal(commandRowCount({ terminal: term }, 40), 2);

  const win = commandContentWindow({ terminal: term }, { rows: 5, scroll: 0 });
  assert.equal(win.lines.length, 5);
  assert.deepEqual(win.lines.slice(0, 2), rows);
  assert.deepEqual(texts(win.lines.slice(2)), ["", "", ""]);
});

test("bottom-follow shows the last rows; scrolling goes up by lines and stops at the top", () => {
  const term = terminalOf(plain(30), 10);
  assert.deepEqual(texts(commandContentLines(term, 0, 4)), ["out 26", "out 27", "out 28", "out 29"]);
  assert.deepEqual(texts(commandContentLines(term, 6, 4)), ["out 20", "out 21", "out 22", "out 23"]);
  assert.deepEqual(texts(commandContentLines(term, 1000, 4)), ["out 0", "out 1", "out 2", "out 3"]);
  assert.deepEqual(commandContentWindow({ terminal: term }, { rows: 4, scroll: 1000 }).scroll, { below: 26, fresh: 0 });
});

test("rows from the real terminal emulator keep colours and the blank screen tail is dropped", async () => {
  const view = new TermView({ cols: 20, rows: 5, scrollback: 100 });
  await view.write(`\x1b[31mred\x1b[0m line\n${Array.from({ length: 12 }, (_, i) => `n${i}`).join("\n")}\n`);
  const bottom = commandContentWindow({ terminal: view }, { rows: 3, scroll: 0 });
  assert.deepEqual(texts(bottom.lines), ["n9", "n10", "n11"]);
  const top = commandContentWindow({ terminal: view }, { rows: 3, scroll: 100 });
  assert.deepEqual(top.lines[0], [{ text: "red", style: { fg: 1 } }, { text: " line" }]);
  assert.equal(commandRowCount({ terminal: view }, 20), 13);
  assert.deepEqual(view.find("n1"), [2, 11, 12]);
  view.dispose();
});

test("a terminal with no output shows one grey line saying so", () => {
  const empty = terminalOf([], 6);
  assert.deepEqual(commandContentLines(empty, 0, 5), [[{ text: NO_OUTPUT_TEXT, style: { fg: "grey" } }]]);
  const win = commandContentWindow({ terminal: empty }, { rows: 3, scroll: 0 });
  assert.equal(win.lines.length, 3);
  assert.equal(lineText(win.lines[0]!), "还没有输出");
  assert.deepEqual(commandContentWindow({ terminal: null }, { rows: 2, scroll: 0 }).lines.map(lineText), ["还没有输出", ""]);
});

test("a row wider than the content is cut with … (the terminal should be sized to fit, but the view never overflows)", () => {
  const term = terminalOf([[{ text: "x".repeat(60), style: { fg: 3 } }]], 3, 60);
  const [row] = commandContentLines(term, 0, 3, { width: 20 });
  assert.equal(lineText(row!), `${"x".repeat(19)}…`);
  assert.deepEqual(row![0]!.style, { fg: 3 });
  for (const line of commandContentWindow({ terminal: term }, { width: 7, rows: 3, scroll: 0 }).lines) assert.ok(lineWidth(line) <= 7);
});

test("without an output file the event text is cleaned, shown as plain text and the first row explains why", () => {
  const raw = "\x1b[32mgreen\x1b[0m\r\nprogress 10%\rprogress 100%\r\n\ttabbed\n\n";
  const rows = commandEventRows(raw, 50);
  assert.deepEqual(texts(rows), [EVENT_OUTPUT_NOTICE, "green", "progress 100%", "    tabbed"]);
  assert.deepEqual(rows[0], [{ text: EVENT_OUTPUT_NOTICE, style: { fg: "grey" } }]);
  assert.deepEqual(rows[1], [{ text: "green" }]);

  const narrow = commandEventRows(raw, 12);
  assert.ok(narrow.length > 4 && narrow.every((line) => lineWidth(line) <= 12));
  assert.equal(texts(narrow.slice(0, texts(narrow).indexOf("green"))).join(""), EVENT_OUTPUT_NOTICE);
  const win = commandContentWindow({ terminal: null, eventOutput: raw }, { width: 12, rows: 6, scroll: 0 });
  assert.equal(win.lines.length, 6);
  assert.ok(win.lines.every((line) => lineWidth(line) <= 12));
  assert.deepEqual(texts(commandEventRows("", 50)), [EVENT_OUTPUT_NOTICE, NO_OUTPUT_TEXT]);
  assert.equal(commandRowCount({ terminal: null, eventOutput: raw }, 50), 4);
});

test("after the user scrolls up, new terminal rows do not move the window and are counted; search marks the hits", () => {
  const before = terminalOf(plain(30), 10);
  const seen = commandContentWindow({ terminal: before }, { rows: 4, scroll: 6, scrollTotal: 30 });
  const after = terminalOf(plain(33), 10);
  const still = commandContentWindow({ terminal: after }, { rows: 4, scroll: 6, scrollTotal: 30 });
  assert.deepEqual(still.lines, seen.lines);
  assert.deepEqual(still.scroll, { below: 9, fresh: 3 });

  const hit = commandContentWindow({ terminal: after }, { rows: 4, scroll: 0, search: { query: "OUT 3", currentRow: 31 } });
  assert.deepEqual(hit.lines[2], [{ text: "out 3", style: { inverse: true, bold: true } }, { text: "1" }]);
  assert.deepEqual(hit.lines[3], [{ text: "out 3", style: { underline: true } }, { text: "2" }]);
});

test("with the command text given (details expanded) it sits above the output, row numbers and the total count it, and search finds it", () => {
  const command = "cd /work/demo && timeout 300 stdbuf -oL pytest -x \\\n  tests/ 2>&1 | tee run.log";
  const head = commandHeaderRows(command, 34);
  assert.deepEqual(texts(head), ["$ cd /work/demo && timeout 300", "stdbuf -oL pytest -x \\", "    tests/ 2>&1 | tee run.log", ""]);
  assert.ok(head.slice(0, 3).every((line) => line[0]?.style?.fg === "grey"));

  const term = terminalOf(plain(5), 10, 34);
  const source = { terminal: term, command };
  assert.equal(commandRowCount(source, 34), 4 + 5);
  const top = commandContentWindow(source, { width: 34, rows: 6, scroll: 100 });
  assert.deepEqual(texts(top.lines), ["$ cd /work/demo && timeout 300", "stdbuf -oL pytest -x \\", "    tests/ 2>&1 | tee run.log", "", "out 0", "out 1"]);
  assert.deepEqual(texts(commandContentWindow(source, { width: 34, rows: 3, scroll: 0 }).lines), ["out 2", "out 3", "out 4"]);
  const hit = commandContentWindow(source, { width: 34, rows: 6, scroll: 100, search: { query: "out 1", currentRow: 5 } });
  assert.deepEqual(hit.lines[5], [{ text: "out 1", style: { inverse: true, bold: true } }]);

  const none = commandContentWindow({ terminal: terminalOf([], 10, 30), command: "make" }, { width: 30, rows: 5, scroll: 0 });
  assert.deepEqual(texts(none.lines), ["$ make", "", NO_OUTPUT_TEXT, "", ""]);
  const many = commandHeaderRows(Array.from({ length: 30 }, (_, i) => `echo ${i}`).join("\n"), 30);
  assert.equal(many.length, 14);
  assert.equal(texts(many)[12], "  … 还有 18 行");
});

test("a command stopped halfway with no output says no output was left, instead of 'no output yet'", () => {
  const source = { terminal: null, eventOutput: "", orphaned: true };
  assert.deepEqual(texts(commandContentWindow(source, { width: 40, rows: 3, scroll: 0 }).lines), [ORPHANED_NO_OUTPUT_TEXT, "", ""]);
  assert.equal(commandRowCount(source, 40), 1);
  const withHeader = commandContentWindow({ ...source, command: "make" }, { width: 40, rows: 4, scroll: 0 });
  assert.deepEqual(texts(withHeader.lines), ["$ make", "", ORPHANED_NO_OUTPUT_TEXT, ""]);
  assert.equal(commandRowCount({ ...source, command: "make" }, 40), 3);
  // 有输出就照常显示
  const shown = texts(commandContentWindow({ ...source, eventOutput: "built\n" }, { width: 80, rows: 3, scroll: 0 }).lines);
  assert.ok(shown.includes("built") && !shown.includes(ORPHANED_NO_OUTPUT_TEXT), shown.join("|"));
});
