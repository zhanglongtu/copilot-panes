import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { backupStamp, install } from "../../src/install.ts";
import { tempDir } from "../helpers/tmp.ts";

const NOW = new Date(2026, 10, 16, 8, 19, 32);

function setup() {
  const dir = tempDir("in-");
  const source = join(dir.path, "extension.mjs");
  const home = join(dir.path, "home");
  const target = join(home, "extensions", "copilot-panes", "extension.mjs");
  writeFileSync(source, "new extension\n");
  return { ...dir, source, target, files: () => readdirSync(join(home, "extensions", "copilot-panes")).sort() };
}

test("installs into a directory that does not exist yet and says what to do next", async () => {
  const t = setup();
  try {
    const result = await install({ source: t.source, target: t.target, now: NOW });
    assert.equal(result.exitCode, 0);
    assert.equal(result.backup, null);
    assert.equal(readFileSync(t.target, "utf8"), "new extension\n");
    assert.match(result.message, /\/settings experimental on/);
    assert.match(result.message, /重新启动 Copilot CLI/);
  } finally {
    t.cleanup();
  }
});

test("an existing different extension is renamed to extension.mjs.bak-<time> first", async () => {
  const t = setup();
  try {
    mkdirSync(join(t.target, ".."), { recursive: true });
    writeFileSync(t.target, "old extension\n");
    const result = await install({ source: t.source, target: t.target, now: NOW });
    assert.equal(result.exitCode, 0);
    assert.equal(result.backup, `${t.target}.bak-20261116-081932`);
    assert.equal(readFileSync(`${t.target}.bak-20261116-081932`, "utf8"), "old extension\n");
    assert.equal(readFileSync(t.target, "utf8"), "new extension\n");
    assert.deepEqual(t.files(), ["extension.mjs", "extension.mjs.bak-20261116-081932"]);
  } finally {
    t.cleanup();
  }
});

test("an identical extension is left alone and not backed up", async () => {
  const t = setup();
  try {
    await install({ source: t.source, target: t.target, now: NOW });
    const again = await install({ source: t.source, target: t.target, now: new Date(NOW.getTime() + 5000) });
    assert.equal(again.exitCode, 0);
    assert.equal(again.backup, null);
    assert.match(again.message, /已经是最新的/);
    assert.deepEqual(t.files(), ["extension.mjs"]);
  } finally {
    t.cleanup();
  }
});

test("a missing bundle fails with a hint to run npm run build and touches nothing", async () => {
  const t = setup();
  try {
    const result = await install({ source: join(t.path, "nope.mjs"), target: t.target, now: NOW });
    assert.equal(result.exitCode, 2);
    assert.match(result.message, /npm run build/);
    assert.ok(!existsSync(t.target));
  } finally {
    t.cleanup();
  }
});

test("--dry-run reports the plan and changes nothing", async () => {
  const t = setup();
  try {
    mkdirSync(join(t.target, ".."), { recursive: true });
    writeFileSync(t.target, "old extension\n");
    const result = await install({ source: t.source, target: t.target, now: NOW, dryRun: true });
    assert.equal(result.exitCode, 0);
    assert.match(result.message, /bak-20261116-081932/);
    assert.equal(readFileSync(t.target, "utf8"), "old extension\n");
    assert.deepEqual(t.files(), ["extension.mjs"]);
  } finally {
    t.cleanup();
  }
});

test("a failed install keeps the old extension and leaves no temporary file", async () => {
  const t = setup();
  try {
    mkdirSync(join(t.target, ".."), { recursive: true });
    writeFileSync(t.target, "old extension\n");
    // 备份名撞上一个目录：rename 失败
    mkdirSync(`${t.target}.bak-20261116-081932`);
    writeFileSync(join(`${t.target}.bak-20261116-081932`, "keep"), "x");
    const result = await install({ source: t.source, target: t.target, now: NOW });
    assert.equal(result.exitCode, 2);
    assert.equal(readFileSync(t.target, "utf8"), "old extension\n");
    assert.ok(!t.files().some((name) => name.includes(".tmp-")));
  } finally {
    t.cleanup();
  }
});

test("backupStamp uses local time without colons", () => {
  assert.equal(backupStamp(new Date(2026, 0, 2, 3, 4, 5)), "20260102-030405");
});
