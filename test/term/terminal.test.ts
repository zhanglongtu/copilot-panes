import { test } from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { TermView } from "../../src/term/terminal.ts";
import type { Line } from "../../src/types/ui.ts";

const text = (line: Line): string => line.map((s) => s.text).join("");
const texts = (lines: Line[]): string[] => lines.map(text);

function term(cols = 40, rows = 6, scrollback = 100): TermView {
  return new TermView({ cols, rows, scrollback });
}

test("colour codes become palette and RGB styles and carriage returns overwrite the line", async () => {
  const t = term();
  await t.write(
    "plain \x1b[31mred\x1b[0m \x1b[91mbright\x1b[0m \x1b[38;5;208morange\x1b[0m \x1b[38;2;10;20;30mtruecolor\x1b[0m\n" +
      "\x1b[1mbold\x1b[2mdim\x1b[0;3mitalic\x1b[0;4munder\x1b[0;7minverse\x1b[0;44;37mon blue\x1b[0m\n" +
      "10%\r50%\r100%\n",
  );
  const [first, second, third] = t.lines(0, 3) as [Line, Line, Line];
  assert.deepEqual(first, [
    { text: "plain " },
    { text: "red", style: { fg: 1 } },
    { text: " " },
    { text: "bright", style: { fg: 9 } },
    { text: " " },
    { text: "orange", style: { fg: 208 } },
    { text: " " },
    { text: "truecolor", style: { fg: { r: 10, g: 20, b: 30 } } },
  ]);
  assert.deepEqual(second, [
    { text: "bold", style: { bold: true } },
    { text: "dim", style: { bold: true, dim: true } },
    { text: "italic", style: { italic: true } },
    { text: "under", style: { underline: true } },
    { text: "inverse", style: { inverse: true } },
    { text: "on blue", style: { fg: 7, bg: 4 } },
  ]);
  assert.equal(text(third), "100%");
  t.dispose();
});

test("an in-place progress bar shows its last refresh", async () => {
  const t = term(40, 4);
  const frames = [10, 40, 70, 100].map((p) => `\r${String(p).padStart(3)}%|${"#".repeat(p / 10).padEnd(10)}|`);
  await t.write(frames.join("") + "\ndone\n");
  assert.deepEqual(texts(t.lines(0, 2)), ["100%|##########|", "done"]);
  assert.equal(t.lastNonEmptyLine(), "done");
  t.dispose();
});

test("output with bare \\n lines starts each line at column 0", async () => {
  const t = term();
  await t.write("one\ntwo\nthree\n");
  assert.deepEqual(texts(t.lines(0, 3)), ["one", "two", "three"]);
  const crlf = term();
  await crlf.write("one\r\ntwo\r\nthree\r\n");
  assert.deepEqual(texts(crlf.lines(0, 3)), ["one", "two", "three"]);
  t.dispose();
  crlf.dispose();
});

test("trailing blanks are dropped but blanks with a background or underline stay", async () => {
  const t = term();
  await t.write("abc   \n\x1b[41m   \x1b[0m\n\x1b[4mx  \x1b[0m\n\n");
  assert.deepEqual(t.lines(0, 4), [
    [{ text: "abc" }],
    [{ text: "   ", style: { bg: 1 } }],
    [{ text: "x  ", style: { underline: true } }],
    [],
  ]);
  t.dispose();
});

test("viewport scrolls back through the scrollback and stops at the top", async () => {
  const t = term(20, 5, 50);
  const data = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n") + "\n";
  await t.write(data);
  assert.equal(t.totalLines, 55);
  assert.deepEqual(texts(t.viewport(0)), ["line 96", "line 97", "line 98", "line 99", ""]);
  assert.deepEqual(texts(t.viewport(3)), ["line 93", "line 94", "line 95", "line 96", "line 97"]);
  const top = ["line 46", "line 47", "line 48", "line 49", "line 50"];
  assert.deepEqual(texts(t.viewport(50)), top);
  assert.deepEqual(texts(t.viewport(9999)), top);
  assert.deepEqual(texts(t.viewport(-4)), texts(t.viewport(0)));
  t.dispose();
});

test("the scrollback is capped", async () => {
  const t = term(20, 4, 30);
  await t.write(Array.from({ length: 5000 }, (_, i) => `n${i}`).join("\n"));
  assert.equal(t.totalLines, 34);
  assert.equal(t.lastNonEmptyLine(), "n4999");
  assert.equal(text(t.lines(0, 1)[0]!), "n4966");
  t.dispose();
});

test("lines() returns only the rows that exist", async () => {
  const t = term(10, 3, 10);
  await t.write("a\nb\n");
  assert.equal(t.totalLines, 3);
  assert.deepEqual(texts(t.lines(2, 10)), [""]);
  assert.deepEqual(texts(t.lines(-2, 3)), ["a"]);
  assert.deepEqual(t.lines(3, 5), []);
  assert.deepEqual(t.lines(0, 0), []);
  t.dispose();
});

test("lastNonEmptyLine, plainText and find work across the scrollback", async () => {
  const t = term(30, 4, 20);
  await t.write(
    "first Alpha\n\n  second   \nthird alpha\n" + Array.from({ length: 10 }, (_, i) => `filler ${i}`).join("\n") + "\nlast line  \n\n\n",
  );
  assert.equal(t.lastNonEmptyLine(), "last line");
  assert.equal(t.plainText().split("\n")[0], "first Alpha");
  assert.equal(t.plainText().split("\n")[2], "  second");
  assert.equal(t.plainText().endsWith("filler 9\nlast line"), true);
  assert.deepEqual(t.find("ALPHA"), [0, 3]);
  assert.deepEqual(t.find("filler 9"), [13]);
  assert.deepEqual(t.find(""), []);
  assert.deepEqual(t.find("nowhere"), []);
  t.dispose();
  const empty = term();
  assert.equal(empty.lastNonEmptyLine(), "");
  assert.equal(empty.plainText(), "");
  empty.dispose();
});

test("a line wrapped by a narrow terminal is one line for plainText and lastNonEmptyLine", async () => {
  const t = term(10, 4, 20);
  await t.write("short\n0123456789abcdefghij0123\n");
  assert.deepEqual(texts(t.lines(0, 4)), ["short", "0123456789", "abcdefghij", "0123"]);
  assert.equal(t.plainText(), "short\n0123456789abcdefghij0123");
  assert.equal(t.lastNonEmptyLine(), "0123456789abcdefghij0123");
  t.resize(30, 4);
  assert.deepEqual(texts(t.lines(0, 2)), ["short", "0123456789abcdefghij0123"]);
  t.dispose();
});

test("wide characters take two cells and are not duplicated", async () => {
  const t = term(10, 3);
  await t.write("中文a\x1b[31m字\x1b[0m\n");
  assert.deepEqual(t.lines(0, 1), [[{ text: "中文a" }, { text: "字", style: { fg: 1 } }]]);
  assert.deepEqual(t.find("文a"), [0]);
  assert.equal(t.plainText(), "中文a字");
  // 第 10 列放不下的宽字符折到下一行；接回一行时不能多出一个空格
  await t.write("123456789中\n");
  assert.equal(t.plainText(), "中文a字\n123456789中");
  t.dispose();
});

test("resize changes the size and reflows", async () => {
  const t = term(20, 4);
  await t.write("one\n");
  t.resize(5, 2);
  assert.equal(t.cols, 5);
  assert.equal(t.rows, 2);
  assert.equal(t.viewport(0).length, 2);
  t.dispose();
});

test("reset clears the content and drops the part of a big write that was not fed yet", async () => {
  const t = term(80, 5, 100);
  await t.write("old\n");
  const pending = t.write("big line\n".repeat(200_000));
  t.reset();
  await pending;
  assert.equal(t.plainText(), "");
  assert.equal(t.totalLines, 5);
  await t.write("new\n");
  assert.equal(t.plainText(), "new");
  assert.equal(t.cols, 80);
  t.dispose();
});

test("writes are applied in call order and surrogate pairs survive the chunk boundary", async () => {
  const t = term(100, 5, 5000);
  const emoji = "a" + "😀".repeat(100_000);
  const first = t.write(emoji + "\n");
  const second = t.write("after\n");
  await Promise.all([first, second]);
  assert.equal(t.lastNonEmptyLine(), "after");
  assert.equal(t.plainText(), emoji + "\nafter");
  t.dispose();
});

test("a big write hands control back to the event loop and the screen is fast to read", async () => {
  const t = term(120, 40, 5000);
  const data = Array.from({ length: 100_000 }, (_, i) => `\x1b[32mINFO\x1b[0m ${i} \x1b[1;34mprocessing\x1b[0m item`).join("\n") + "\n";
  let turns = 0;
  let done = false;
  const spinner = (async () => {
    while (!done) {
      await new Promise((resolve) => setImmediate(resolve));
      turns++;
    }
  })();
  await t.write(data);
  done = true;
  await spinner;
  assert.ok(turns >= 20, `event loop turns during the write: ${turns}`);
  assert.equal(t.lastNonEmptyLine(), "INFO 99999 processing item");
  const times: number[] = [];
  for (let i = 0; i < 50; i++) {
    const start = performance.now();
    t.viewport(0);
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  assert.ok(times[25]! < 25, `median viewport time ${times[25]} ms`);
  t.dispose();
});

test("use after dispose is harmless", async () => {
  const t = term();
  t.dispose();
  await t.write("ignored\n");
  t.reset();
  t.resize(10, 10);
  t.dispose();
});
