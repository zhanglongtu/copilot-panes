// 增量读文件：LineTailer（events.jsonl）和 TextTailer（命令的 .out）。
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, renameSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { LineTailer, TextTailer } from "../../src/model/tail.ts";
import { tempDir } from "../helpers/tmp.ts";

function withDir(run: (dir: string) => void): void {
  const tmp = tempDir("tl");
  try {
    run(tmp.path);
  } finally {
    tmp.cleanup();
  }
}

test("only new lines are read and a half-written line waits for its newline", () => {
  withDir((dir) => {
    const path = join(dir, "events.jsonl");
    writeFileSync(path, "a\nb\nc");
    const tailer = new LineTailer(path);
    assert.deepEqual(tailer.read(), { lines: ["a", "b"], reset: false, more: false });
    assert.deepEqual(tailer.read(), { lines: [], reset: false, more: false });
    appendFileSync(path, "d\ne\n");
    assert.deepEqual(tailer.read(), { lines: ["cd", "e"], reset: false, more: false });
    appendFileSync(path, "f\n");
    assert.deepEqual(tailer.read().lines, ["f"]);
    assert.deepEqual(tailer.read().lines, []);
    assert.equal(tailer.path, path);
  });
});

test("a line that is still being written is not delivered, however many reads see it", () => {
  withDir((dir) => {
    const path = join(dir, "events.jsonl");
    writeFileSync(path, '{"type":"tool.exec');
    const tailer = new LineTailer(path);
    for (let i = 0; i < 3; i++) assert.deepEqual(tailer.read().lines, []);
    appendFileSync(path, 'ution_start"}\n');
    assert.deepEqual(tailer.read().lines, ['{"type":"tool.execution_start"}']);
  });
});

test("a missing file reads as empty and is picked up once it appears", () => {
  withDir((dir) => {
    const path = join(dir, "later", "events.jsonl");
    const tailer = new LineTailer(path);
    assert.deepEqual(tailer.read(), { lines: [], reset: false, more: false });
    mkdirSync(join(dir, "later"));
    assert.deepEqual(tailer.read(), { lines: [], reset: false, more: false });
    writeFileSync(path, "x\ny\n");
    assert.deepEqual(tailer.read(), { lines: ["x", "y"], reset: false, more: false });
  });
});

test("blank lines are not delivered, whitespace-only lines are, and bad UTF-8 becomes U+FFFD", () => {
  withDir((dir) => {
    const path = join(dir, "events.jsonl");
    writeFileSync(path, Buffer.concat([Buffer.from("a\n\n  \n\n"), Buffer.from([0x62, 0xff, 0x63, 0x0a]), Buffer.from("汉字\n")]));
    assert.deepEqual(new LineTailer(path).read().lines, ["a", "  ", "b\ufffdc", "汉字"]);
  });
});

test("a truncated file is read from the start and the chunk says reset", () => {
  withDir((dir) => {
    const path = join(dir, "events.jsonl");
    writeFileSync(path, "one\ntwo\nthree\npartial");
    const tailer = new LineTailer(path);
    assert.deepEqual(tailer.read().lines, ["one", "two", "three"]);
    truncateSync(path, 0);
    assert.deepEqual(tailer.read(), { lines: [], reset: true, more: false });
    appendFileSync(path, "x\ny\n");
    assert.deepEqual(tailer.read(), { lines: ["x", "y"], reset: false, more: false });
    writeFileSync(path, "p\n");
    assert.deepEqual(tailer.read(), { lines: ["p"], reset: true, more: false });
    assert.deepEqual(tailer.read(), { lines: [], reset: false, more: false });
  });
});

test("a replaced file is read from the start, even when the new one is bigger, and the old half line is forgotten", () => {
  withDir((dir) => {
    const path = join(dir, "events.jsonl");
    writeFileSync(path, "old 1\nold 2\nhalf");
    const tailer = new LineTailer(path);
    assert.deepEqual(tailer.read().lines, ["old 1", "old 2"]);
    writeFileSync(join(dir, "next.jsonl"), "new 1\nnew 2\nnew 3\nnew 4\n");
    renameSync(join(dir, "next.jsonl"), path);
    assert.deepEqual(tailer.read(), { lines: ["new 1", "new 2", "new 3", "new 4"], reset: true, more: false });
  });
});

test("a file rewritten in place with a different beginning is read from the start", () => {
  withDir((dir) => {
    const path = join(dir, "events.jsonl");
    writeFileSync(path, "AAAA 1\nAAAA 2\n");
    const tailer = new LineTailer(path);
    assert.deepEqual(tailer.read().lines, ["AAAA 1", "AAAA 2"]);
    writeFileSync(path, "BBBB 1\nBBBB 2\nBBBB 3\n");
    assert.deepEqual(tailer.read(), { lines: ["BBBB 1", "BBBB 2", "BBBB 3"], reset: true, more: false });
    appendFileSync(path, "BBBB 4\n");
    assert.deepEqual(tailer.read(), { lines: ["BBBB 4"], reset: false, more: false });
  });
});

test("a file that is deleted and made again is a reset, not an error", () => {
  withDir((dir) => {
    const path = join(dir, "events.jsonl");
    writeFileSync(path, "a\nb\n");
    const tailer = new LineTailer(path);
    tailer.read();
    rmSync(path);
    assert.deepEqual(tailer.read(), { lines: [], reset: false, more: false });
    writeFileSync(path, "c\n");
    assert.deepEqual(tailer.read(), { lines: ["c"], reset: true, more: false });
  });
});

test("a big file is read in pieces of at most maxBytesPerRead and the chunk says more", () => {
  withDir((dir) => {
    const path = join(dir, "events.jsonl");
    const lines = Array.from({ length: 50 }, (_, i) => `line ${String(i).padStart(3, "0")}`); // 每行连换行符 9 字节
    writeFileSync(path, `${lines.join("\n")}\n`);
    const tailer = new LineTailer(path, { maxBytesPerRead: 100 });
    const got: string[] = [];
    const chunks: { count: number; more: boolean }[] = [];
    for (let guard = 0; guard < 100; guard++) {
      const chunk = tailer.read();
      got.push(...chunk.lines);
      chunks.push({ count: chunk.lines.length, more: chunk.more });
      assert.equal(chunk.reset, false);
      if (!chunk.more) break;
    }
    assert.deepEqual(got, lines);
    assert.ok(chunks.length >= 5, `${chunks.length} reads`);
    assert.ok(chunks.every((chunk) => chunk.count <= 12));
    assert.deepEqual(
      chunks.map((chunk) => chunk.more),
      chunks.map((_, i) => i < chunks.length - 1),
    );
  });
});

test("a line longer than maxBytesPerRead is delivered once, when it is complete, and UTF-8 split between reads stays intact", () => {
  withDir((dir) => {
    const path = join(dir, "events.jsonl");
    const long = "汉".repeat(20);
    writeFileSync(path, `${long}\nend\n`);
    const tailer = new LineTailer(path, { maxBytesPerRead: 7 });
    const got: string[] = [];
    for (let guard = 0; guard < 100; guard++) {
      const chunk = tailer.read();
      got.push(...chunk.lines);
      if (!chunk.more) break;
    }
    assert.deepEqual(got, [long, "end"]);
  });
});

test("TextTailer keeps a UTF-8 character split across two reads intact and reports whether the file exists", () => {
  withDir((dir) => {
    const path = join(dir, "c1.out");
    const tailer = new TextTailer(path, { maxBytesPerRead: 2 });
    assert.deepEqual(tailer.read(), { text: "", reset: false, more: false, exists: false });
    writeFileSync(path, "");
    assert.deepEqual(tailer.read(), { text: "", reset: false, more: false, exists: true });
    writeFileSync(path, "a汉字b");
    let text = "";
    for (let guard = 0; guard < 100; guard++) {
      const chunk = tailer.read();
      assert.equal(chunk.exists, true);
      assert.ok(!chunk.text.includes("\ufffd"));
      text += chunk.text;
      if (!chunk.more) break;
    }
    assert.equal(text, "a汉字b");
    assert.equal(tailer.path, path);
  });
});

test("TextTailer hands the text over as it is: colour codes, carriage returns and half lines", () => {
  withDir((dir) => {
    const path = join(dir, "c1.out");
    writeFileSync(path, "\x1b[32mok\x1b[0m\r 10%\r 20%\r\npartial");
    const tailer = new TextTailer(path);
    assert.equal(tailer.read().text, "\x1b[32mok\x1b[0m\r 10%\r 20%\r\npartial");
    appendFileSync(path, " line\n");
    assert.equal(tailer.read().text, " line\n");
    assert.deepEqual(tailer.read(), { text: "", reset: false, more: false, exists: true });
  });
});

test("TextTailer reports reset when the file is truncated or replaced, and exists false when it is deleted", () => {
  withDir((dir) => {
    const path = join(dir, "c1.out");
    writeFileSync(path, "first run\n汉");
    const tailer = new TextTailer(path);
    assert.equal(tailer.read().text, "first run\n汉");
    writeFileSync(path, "again\n");
    assert.deepEqual(tailer.read(), { text: "again\n", reset: true, more: false, exists: true });
    rmSync(path);
    assert.deepEqual(tailer.read(), { text: "", reset: false, more: false, exists: false });
    writeFileSync(path, "third\n");
    assert.deepEqual(tailer.read(), { text: "third\n", reset: true, more: false, exists: true });
  });
});

test("a half character left over from before a reset is not glued to the new text", () => {
  withDir((dir) => {
    const path = join(dir, "c1.out");
    writeFileSync(path, Buffer.from([0x61, 0xe6, 0xb1])); // "a" 和 "汉" 的前两个字节
    const tailer = new TextTailer(path);
    assert.equal(tailer.read().text, "a");
    writeFileSync(path, "9");
    assert.deepEqual(tailer.read(), { text: "9", reset: true, more: false, exists: true });
  });
});
