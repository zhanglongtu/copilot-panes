import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { copyText, copyToTmux, openPager, osc52, pagerPopupArgs, removePagerFile, shellQuote, writePagerFile } from "../../src/effects.ts";
import { tempDir } from "../helpers/tmp.ts";

test("copy goes through `tmux load-buffer -w -` and falls back to plain `load-buffer -` on an old tmux", async () => {
  const calls: Array<{ args: readonly string[]; input: string }> = [];
  await copyToTmux("你好", { TMUX: "/tmp/tmux-1/default,1,0" }, async (args, input) => {
    calls.push({ args, input });
    if (args.includes("-w")) throw new Error("unknown flag -w");
  });
  assert.deepEqual(calls, [
    { args: ["load-buffer", "-w", "-"], input: "你好" },
    { args: ["load-buffer", "-"], input: "你好" },
  ]);
});

test("outside tmux copyText writes an OSC 52 sequence instead", async () => {
  const written: string[] = [];
  const how = await copyText("abc", {}, (data) => written.push(data), async () => assert.fail("tmux must not run outside tmux"));
  assert.equal(how, "osc52");
  assert.deepEqual(written, [`\x1b]52;c;${Buffer.from("abc").toString("base64")}\x07`]);
  assert.equal(osc52("abc"), written[0]);
});

test("inside tmux a failing load-buffer also falls back to OSC 52", async () => {
  const written: string[] = [];
  const how = await copyText("x", { TMUX: "s" }, (data) => written.push(data), async () => {
    throw new Error("no server");
  });
  assert.equal(how, "osc52");
  assert.equal(written.length, 1);
});

test("the pager runs less -R in a 90% popup with the path quoted", async () => {
  assert.deepEqual(pagerPopupArgs("/a b/it's.out"), ["display-popup", "-E", "-w", "90%", "-h", "90%", `less -R '/a b/it'\\''s.out'`]);
  assert.equal(shellQuote("a'b"), `'a'\\''b'`);
  let seen: readonly string[] = [];
  await openPager("/x.out", async (args) => {
    seen = args;
  });
  assert.equal(seen[0], "display-popup");
});

test("pager temporary files are private and removable", () => {
  const dir = tempDir("pg-");
  try {
    const path = writePagerFile(join(dir.path, "tmp"), "全文\n");
    assert.equal(readFileSync(path, "utf8"), "全文\n");
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(statSync(join(dir.path, "tmp")).mode & 0o777, 0o700);
    removePagerFile(path);
    assert.ok(!existsSync(path));
  } finally {
    dir.cleanup();
  }
});
