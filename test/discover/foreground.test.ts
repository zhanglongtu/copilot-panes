import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ForegroundLog, hintsSignature, logHints, readPaneTitle, sessionNameFromPaneTitle, titleHints } from "../../src/discover/foreground.ts";
import { tempDir } from "../helpers/tmp.ts";

const A = "3f2b8e1a-7c4d-4e59-9a06-d1b5c8e27f40";
const B = "8a1d6c3e-52b7-4f08-b3e9-0c7a4d915e26";
const C = "c47e0b92-1f3a-4d68-85b1-9e2f6a03d7c8";

const stamp = (n: number) => `2026-11-16T13:${String(n % 60).padStart(2, "0")}:00.000Z`;
const register = (id: string, n = 0) => `${stamp(n)} [INFO] Registering foreground session: ${id}\n`;
const unregister = (id: string, n = 0) => `${stamp(n)} [INFO] Unregistering foreground session: ${id}\n`;
const noise = (lines: number) => "2026-11-16T13:00:00.000Z [WARNING] [rust:rt_git] uncached git root lookup failed; reporting no result {}\n".repeat(lines);

function logsDir(root: string): string {
  const dir = join(root, "logs");
  mkdirSync(dir, { recursive: true });
  return dir;
}

test("the last registered session in the process log is the foreground one, found from the end of a large file", () => {
  const dir = tempDir("fg-");
  try {
    const logs = logsDir(dir.path);
    // 切换了几次，最后一次的后面是 3 MB 别的日志
    writeFileSync(join(logs, "process-1772442000000-4321.log"), register(A) + unregister(A) + register(B, 1) + unregister(B, 1) + register(C, 2) + noise(30_000));
    const log = new ForegroundLog(logs);
    assert.equal(log.foreground(4321, 0), C);
    assert.equal(log.foreground(4321, 1), C);
  } finally {
    dir.cleanup();
  }
});

test("new registrations are picked up by reading only what was appended; a half-written last line waits", () => {
  const dir = tempDir("fg-");
  try {
    const logs = logsDir(dir.path);
    const file = join(logs, "process-1-77.log");
    writeFileSync(file, register(A) + noise(5));
    const log = new ForegroundLog(logs);
    assert.equal(log.foreground(77, 0), A);

    appendFileSync(file, unregister(A, 1) + register(B, 1).slice(0, 60)); // 登记那一行还没写完
    assert.equal(log.foreground(77, 1), null, "the old one was unregistered and the new one is not complete yet");
    appendFileSync(file, register(B, 1).slice(60));
    assert.equal(log.foreground(77, 2), B);
    appendFileSync(file, noise(3));
    assert.equal(log.foreground(77, 3), B);
  } finally {
    dir.cleanup();
  }
});

test("a log without a registration, a missing log, and the newest log of a reused pid", () => {
  const dir = tempDir("fg-");
  try {
    const logs = logsDir(dir.path);
    writeFileSync(join(logs, "process-1-10.log"), noise(3));
    writeFileSync(join(logs, "process-5-20.log"), register(A));
    writeFileSync(join(logs, "process-9-20.log"), register(B)); // 同一个进程号后来又被别的进程用了：取启动时刻最新的
    writeFileSync(join(logs, "process-9-200.log"), register(C)); // 进程号 200 不是 20
    const log = new ForegroundLog(logs);
    assert.equal(log.foreground(10, 0), null);
    assert.equal(log.foreground(20, 0), B);
    assert.equal(log.foreground(999, 0), null);
    // 日志后来才出现：隔一阵再列目录时找到
    writeFileSync(join(logs, "process-3-999.log"), register(C));
    assert.equal(log.foreground(999, 1_000), null, "does not list the directory again right away");
    assert.equal(log.foreground(999, 20_000), C);
  } finally {
    dir.cleanup();
  }
});

test("a log that is replaced by a shorter file is read again from its end", () => {
  const dir = tempDir("fg-");
  try {
    const logs = logsDir(dir.path);
    const file = join(logs, "process-1-77.log");
    writeFileSync(file, register(A) + noise(50));
    const log = new ForegroundLog(logs);
    assert.equal(log.foreground(77, 0), A);
    writeFileSync(file, register(B));
    assert.equal(log.foreground(77, 1), B);
  } finally {
    dir.cleanup();
  }
});

test("a pane title gives the session name only when Copilot CLI set it, and control characters are removed", () => {
  assert.equal(sessionNameFromPaneTitle("修登录失败的 bug - GitHub Copilot"), "修登录失败的 bug");
  assert.equal(sessionNameFromPaneTitle("a - b - GitHub Copilot"), "a - b");
  assert.equal(sessionNameFromPaneTitle("\x1b]0;名字\x07 - GitHub Copilot\n"), "]0;名字");
  assert.equal(sessionNameFromPaneTitle("GitHub Copilot"), null);
  assert.equal(sessionNameFromPaneTitle(" - GitHub Copilot"), null);
  assert.equal(sessionNameFromPaneTitle("zsh"), null);
});

test("hints: the pane title is read with a read-only tmux command, and a failing tmux just gives no hint", async () => {
  const calls: string[][] = [];
  const run = async (args: readonly string[]) => {
    calls.push([...args]);
    if (args.includes("%1")) return "甲 - GitHub Copilot\n";
    if (args.includes("%2")) return "zsh\n";
    throw new Error("no such pane");
  };
  assert.equal(await readPaneTitle("%1", run), "甲 - GitHub Copilot");
  assert.equal(await readPaneTitle("%9", run), null);
  const hints = await titleHints({ 10: "%1", 20: "%2", 30: "%9" }, [10, 20, 30, 40], run);
  assert.deepEqual(hints, [{ kind: "title", copilotPid: 10, title: "甲" }]);
  assert.deepEqual(calls[0], ["display-message", "-p", "-t", "%1", "#{pane_title}"]);
  assert.ok(calls.every((args) => args[0] === "display-message"), "only display-message is used");
});

test("log hints, and a signature that changes when the foreground session changes", () => {
  const dir = tempDir("fg-");
  try {
    const logs = logsDir(dir.path);
    const file = join(logs, "process-1-77.log");
    writeFileSync(file, register(A));
    const log = new ForegroundLog(logs);
    const first = logHints([77, 88], log, 0);
    assert.deepEqual(first, [{ kind: "log", copilotPid: 77, sessionId: A }]);
    appendFileSync(file, unregister(A, 1) + register(B, 1));
    const second = logHints([77, 88], log, 1);
    assert.notEqual(hintsSignature(first), hintsSignature(second));
    assert.equal(hintsSignature(second), hintsSignature(logHints([77, 88], log, 2)));
    assert.equal(hintsSignature([]), "");
  } finally {
    dir.cleanup();
  }
});
