// 命令输出的文字处理：清理、最后一行、结束标记。
import assert from "node:assert/strict";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { cleanText, lastNonEmptyLine, oneLine, readLastLine, stripExitMarker, stripTrailingNotice } from "../../src/model/output.ts";
import { tempDir } from "../helpers/tmp.ts";

test("cleanText keeps only newline and the printable ASCII among the first 0xA0 characters, and drops the whole C1 range", () => {
  const every = Array.from({ length: 0xa0 }, (_, i) => String.fromCharCode(i));
  const kept = every.filter((ch) => cleanText(ch) === ch).join("");
  const printable = Array.from({ length: 0x7f - 0x20 }, (_, i) => String.fromCharCode(0x20 + i)).join("");
  assert.equal(kept, `\n${printable}`);
  assert.equal(cleanText("a\u0086b\u009b31mc\u009dtitle\u0007d"), "ab31mctitled");
  assert.equal(oneLine("x\u0085y\u009bz"), "xyz");
});

test("terminal escapes are removed, a carriage return keeps only what comes after it, tabs become four spaces", () => {
  assert.equal(cleanText("\x1b[31mred\x1b[0m\nprogress 10%\rprogress 100%\x07"), "red\nprogress 100%");
  assert.equal(cleanText("a\tb"), "a    b");
  assert.equal(cleanText("\x1b]0;title\x07ok"), "ok");
  assert.equal(cleanText("\x1b]8;;http://x\x1b\\link\x1b]8;;\x1b\\"), "link");
  assert.equal(cleanText("\x1b[?25l\x1b[2Kgone\x1bM"), "gone");
  assert.equal(cleanText("a\rb\nc\rd\re"), "b\ne");
  assert.equal(cleanText("汉字\n"), "汉字\n");
});

test("a line ending in \\r\\n is not turned into an empty line", () => {
  assert.equal(cleanText("a\r\nb\r\n"), "a\nb\n");
  assert.equal(cleanText("one\r\ntwo\rTWO\r\n"), "one\nTWO\n");
  assert.equal(lastNonEmptyLine("a\r\nb\r\n"), "b");
});

test("oneLine folds all whitespace, newlines included, into single spaces", () => {
  assert.equal(oneLine("  a \n\t b\r\n c  "), "a b c");
  assert.equal(oneLine("\x1b[1mbold\x1b[0m\ttext"), "bold text");
  assert.equal(oneLine(""), "");
  assert.equal(oneLine("a\u3000b\u00a0c"), "a b c");
});

test("the last line of each kind of output", () => {
  const cases: [string, string][] = [
    ["第一行\nsecond line\n\n   \n", "second line"], // 空行和空白行不算
    ["没有换行的最后一行", "没有换行的最后一行"],
    ["\x1b[32mok\x1b[0m\n", "ok"],
    ["progress 10%\rprogress 55%\rprogress 100%\n", "progress 100%"], // 回车前的部分被覆盖掉了
    ["done 1\n  3%|#     |\r 40%|####  |\r", "40%|####  |"], // 进度条还没换行：回车结尾也取最后一段有字的
    ["a\r\nb\r\n", "b"],
    ["x\ty\x07z\n", "x    yz"], // 制表符换成四个空格，别的控制字符去掉
    ["", ""],
    ["\n\n  \n", ""],
    ["last\n\x1b[2K\r\n", "last"],
  ];
  for (const [text, want] of cases) assert.equal(lastNonEmptyLine(text), want, JSON.stringify(text));
});

test("readLastLine reads the end of a file, and a missing or empty file gives an empty string", () => {
  const tmp = tempDir("ol");
  try {
    const path = join(tmp.path, "x.out");
    assert.equal(readLastLine(join(tmp.path, "missing.out")), "");
    writeFileSync(path, "");
    assert.equal(readLastLine(path), "");
    writeFileSync(path, "开头的一行\n第二行\n\x1b[32m最后一行\x1b[0m\n  \n");
    assert.equal(readLastLine(path), "最后一行");
    appendFileSync(path, "尾巴没换行");
    assert.equal(readLastLine(path), "尾巴没换行");
  } finally {
    tmp.cleanup();
  }
});

test("only the end of a big file is read: a last line longer than the window gives its second half", () => {
  const tmp = tempDir("ol");
  try {
    const path = join(tmp.path, "big.out");
    writeFileSync(path, `${"line\n".repeat(400_000)}最后一行\n`);
    assert.equal(readLastLine(path), "最后一行");
    writeFileSync(path, `${"a".repeat(3000)}${"b".repeat(5000)}\n`);
    assert.equal(readLastLine(path), "b".repeat(4095)); // 窗口是 4096 字节，最后一个是换行符
    assert.equal(readLastLine(path, 100), "b".repeat(99));
  } finally {
    tmp.cleanup();
  }
});

test("a truncated first line of the window does not matter", () => {
  const tmp = tempDir("ol");
  try {
    const path = join(tmp.path, "x.out");
    writeFileSync(path, `${"x".repeat(10_000)}\n结尾\n`);
    assert.equal(readLastLine(path, 10), "结尾");
    writeFileSync(path, "汉字".repeat(1000));
    assert.doesNotThrow(() => readLastLine(path, 7)); // 窗口从一个汉字当中开始
  } finally {
    tmp.cleanup();
  }
});

test("stripExitMarker removes the marker with the newline before it and returns the code", () => {
  assert.deepEqual(stripExitMarker("a\nb\n<shellId: 0 completed with exit code 3>"), { text: "a\nb", exitCode: 3 });
  assert.deepEqual(stripExitMarker("a\nb\n\n<shellId: sh9 completed with exit code 0>\n"), { text: "a\nb\n", exitCode: 0 });
  assert.deepEqual(stripExitMarker("<shellId: 1 completed with exit code -1>"), { text: "", exitCode: -1 });
  assert.deepEqual(stripExitMarker("out<shellId: a b completed with exit code 130>  \n"), { text: "out", exitCode: 130 });
  assert.deepEqual(stripExitMarker("no marker\n"), { text: "no marker\n", exitCode: null });
  // 标记不在末尾，或者说的不是“结束了”，都原样留着
  const middle = "<shellId: 1 completed with exit code 2>\nmore";
  assert.deepEqual(stripExitMarker(middle), { text: middle, exitCode: null });
  const running = "x\n<command with shellId: 7 is still running after 30 seconds>";
  assert.deepEqual(stripExitMarker(running), { text: running, exitCode: null });
});

test("stripTrailingNotice removes one notice at the end and nothing else", () => {
  assert.equal(stripTrailingNotice("out 1\n<command with shellId: b is still running after 5 seconds. Use read_bash to continue waiting, or stop_bash to stop it.>"), "out 1");
  assert.equal(stripTrailingNotice("out\n<shellId: b completed with exit code 0>"), "out");
  assert.equal(stripTrailingNotice("out\n<command started in background with shellId: b>\n"), "out");
  assert.equal(stripTrailingNotice("<command started in background with shellId: b>"), "");
  assert.equal(stripTrailingNotice("a\n\n<shellId: b completed with exit code 0>"), "a\n");
  assert.equal(stripTrailingNotice("plain\n"), "plain\n");
  assert.equal(stripTrailingNotice("<shellId: b>\nmore text"), "<shellId: b>\nmore text");
  assert.equal(stripTrailingNotice("x\n<not a notice>"), "x\n<not a notice>");
  assert.equal(stripTrailingNotice("Read interrupted by user steering; shell continues in background."), "");
});
