import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LazyProcTable } from "../../src/discover/lazy-procs.ts";
import { isPidAlive, looksLikeCopilot, readProc, readProcTable, selfAndDescendants } from "../../src/discover/procs.ts";
import type { ProcInfo } from "../../src/discover/procs.ts";
import { tempDir } from "../helpers/tmp.ts";
import { putProc } from "./helpers.ts";

const info = (over: Partial<ProcInfo>): ProcInfo => ({ pid: 1, ppid: 0, pgid: 1, startTicks: 0, comm: "x", argv: [], ...over });

test("stat with spaces and parentheses in the program name is parsed from the last ')'", () => {
  const dir = tempDir("p");
  try {
    putProc(dir.path, { pid: 10, ppid: 5, pgid: 7, startTicks: 123456, comm: "weird (name) x)", argv: ["/bin/weird", "--flag", "a b"] });
    assert.deepEqual(readProc(10, dir.path), {
      pid: 10,
      ppid: 5,
      pgid: 7,
      startTicks: 123456,
      comm: "weird (name) x)",
      argv: ["/bin/weird", "--flag", "a b"],
    });
  } finally {
    dir.cleanup();
  }
});

test("unreadable or malformed processes give null, an empty cmdline gives no argv", () => {
  const dir = tempDir("p");
  try {
    putProc(dir.path, { pid: 20, comm: "kthreadd" });
    writeFileSync(join(dir.path, "20", "cmdline"), "");
    assert.deepEqual(readProc(20, dir.path)?.argv, []);
    mkdirSync(join(dir.path, "21"));
    writeFileSync(join(dir.path, "21", "stat"), "21 no parens here");
    mkdirSync(join(dir.path, "22"));
    writeFileSync(join(dir.path, "22", "stat"), "22 (x) S not numbers");
    mkdirSync(join(dir.path, "23"));
    assert.equal(readProc(21, dir.path), null);
    assert.equal(readProc(22, dir.path), null);
    assert.equal(readProc(23, dir.path), null);
    assert.equal(readProc(24, dir.path), null);
    assert.equal(readProc(-1, dir.path), null);
    // 没有 cmdline 文件（进程刚退出）时 argv 为空，其余照读
    mkdirSync(join(dir.path, "25"));
    writeFileSync(join(dir.path, "25", "stat"), "25 (y) Z 1 25 25 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 77 1 1\n");
    assert.deepEqual(readProc(25, dir.path), { pid: 25, ppid: 1, pgid: 25, startTicks: 77, comm: "y", argv: [] });
  } finally {
    dir.cleanup();
  }
});

test("readProcTable reads the numeric directories and skips the rest", () => {
  const dir = tempDir("p");
  try {
    putProc(dir.path, { pid: 1, ppid: 0, comm: "init" });
    putProc(dir.path, { pid: 300, ppid: 1, comm: "bash" });
    mkdirSync(join(dir.path, "self"));
    mkdirSync(join(dir.path, "0123abc"));
    mkdirSync(join(dir.path, "400")); // 没有 stat：读不了，跳过
    const table = readProcTable(dir.path);
    assert.deepEqual([...table.keys()].sort((a, b) => a - b), [1, 300]);
    assert.deepEqual(readProcTable(join(dir.path, "missing")).size, 0);
    assert.equal(isPidAlive(300, dir.path), true);
    assert.equal(isPidAlive(400, dir.path), true);
    assert.equal(isPidAlive(500, dir.path), false);
    assert.equal(isPidAlive(0, dir.path), false);
    assert.equal(isPidAlive(process.pid), true);
    assert.equal(readProc(process.pid)?.pid, process.pid);
  } finally {
    dir.cleanup();
  }
});

test("descendants follow the parent links of a fake /proc", () => {
  const dir = tempDir("p");
  try {
    putProc(dir.path, { pid: 1, ppid: 0 });
    putProc(dir.path, { pid: 10, ppid: 1 });
    putProc(dir.path, { pid: 11, ppid: 10 });
    putProc(dir.path, { pid: 12, ppid: 10 });
    putProc(dir.path, { pid: 20, ppid: 11 });
    putProc(dir.path, { pid: 30, ppid: 1 });
    const table = readProcTable(dir.path);
    assert.deepEqual(selfAndDescendants(10, table).sort((a, b) => a - b), [10, 11, 12, 20]);
    assert.deepEqual(selfAndDescendants(20, table), [20]);
    assert.deepEqual(selfAndDescendants(999, table), []);
    // 绕圈的父子关系也不会死循环
    const loop = new Map<number, ProcInfo>([
      [5, info({ pid: 5, ppid: 6 })],
      [6, info({ pid: 6, ppid: 5 })],
    ]);
    assert.deepEqual(selfAndDescendants(5, loop).sort(), [5, 6]);
  } finally {
    dir.cleanup();
  }
});

test("looksLikeCopilot accepts the copilot binary and node running @github/copilot, not copilot-panes", () => {
  const yes: Array<Partial<ProcInfo>> = [
    { comm: "copilot", argv: ["copilot"] },
    { comm: "node", argv: ["node", "/usr/local/bin/copilot"] },
    { comm: "MainThread", argv: ["/usr/local/lib/node_modules/@github/copilot/node_modules/@github/copilot-linux-x64/copilot", "--resume"] },
    { comm: "node", argv: ["node", "/home/u/.nvm/lib/node_modules/@github/copilot/index.js"] },
    { comm: "MainThread", argv: ["/opt/agent/pkg/node_modules/@github/copilot-linux-x64/copilot", "-p", "fix copilot-panes"] },
    { comm: "MainThread", argv: ["/usr/bin/copilot", "--add-dir", "/home/u/projects/copilot-panes-ts"] },
    { comm: "MainThread", argv: ["/usr/bin/copilot", "--resume", "copilot-panes"] },
  ];
  for (const p of yes) assert.equal(looksLikeCopilot(info(p)), true, JSON.stringify(p));
  const no: Array<Partial<ProcInfo>> = [
    { comm: "bash", argv: ["-bash"] },
    { comm: "node", argv: ["node", "/home/u/.local/bin/copilot-panes"] },
    { comm: "node", argv: ["node", "/work/node_modules/@github/copilot/x/copilot-panes.mjs"] },
    { comm: "node", argv: ["node", "--no-warnings", "/usr/lib/node_modules/copilot-panes/dist/copilot-panes.mjs"] },
    { comm: "copilot-panes", argv: ["copilot-panes"] },
    { comm: "node", argv: ["/usr/local/bin/node", "/work/copilot-panes/dist/cli.mjs"] },
    { comm: "tmux: client", argv: ["tmux", "a", "-t", "copilot-panes"] },
    { comm: "python", argv: ["python", "script.py"] },
    { comm: "x", argv: [] },
  ];
  for (const p of no) assert.equal(looksLikeCopilot(info(p)), false, JSON.stringify(p));
});

test("the lazy table reads only the process asked for, so a lock-file check does not scan all of /proc", () => {
  const table = new LazyProcTable();
  assert.equal(table.get(process.pid)?.pid, process.pid);
  assert.equal(table.has(process.pid), true);
  assert.equal(table.get(2 ** 22 + 12345), undefined);
  assert.equal(table.has(2 ** 22 + 12345), false);
  assert.equal(table.size, 0);
});
