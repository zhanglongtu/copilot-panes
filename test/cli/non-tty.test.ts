// 标准输出不是终端时，界面程序不能往 stdout 和 stderr 写任何控制码：输出可能被 Copilot CLI 之类的程序原样显示，
// 一条 ESC[?1000l 就能关掉用户终端的鼠标上报。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { installTerminalGuard, Screen } from "../../src/ui/output.ts";
import { THEMES } from "../../src/ui/theme.ts";
import { REPO_ROOT } from "../helpers/tmp.ts";

function run(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("node", ["src/cli.ts", ...args], { cwd: REPO_ROOT, encoding: "utf8", input: "", stdio: ["pipe", "pipe", "pipe"], timeout: 15_000 });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test("with stdout and stdin on pipes the interface explains itself and writes no escape code", () => {
  for (const args of [["--demo"], [], ["--session", "abc"], ["--demo", "--light"]]) {
    const result = run(args);
    assert.equal(result.status, 1, args.join(" "));
    assert.ok(!result.stdout.includes("\x1b") && !result.stderr.includes("\x1b"), `${args.join(" ")}: escape code in the output`);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /标准输出不是终端/);
  }
});

test("the commands that print text write plain text", () => {
  for (const args of [["--help"], ["--version"], ["install", "--dry-run"], ["--bogus"]]) {
    const result = run(args);
    assert.ok(!result.stdout.includes("\x1b") && !result.stderr.includes("\x1b"), `${args.join(" ")}: escape code in the output`);
  }
});

test("a screen that was never entered restores nothing, whatever way the process ends", () => {
  const written: string[] = [];
  const screen = new Screen({ write: (data) => written.push(data) }, THEMES.dark);
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const exits: number[] = [];
  const stop = installTerminalGuard(screen, {
    proc: {
      on: (event, listener) => void listeners.set(event, listener),
      removeListener: (event) => void listeners.delete(event),
      exit: (code) => void exits.push(code ?? 0),
    },
  });
  for (const event of ["exit", "uncaughtExceptionMonitor", "SIGINT", "SIGTERM", "SIGHUP"]) listeners.get(event)?.();
  assert.deepEqual(written, []);
  assert.deepEqual(exits, [130, 143, 129]);
  stop();
});

test("an entered screen is restored exactly once, and only to its own output", () => {
  const written: string[] = [];
  const screen = new Screen({ write: (data) => written.push(data) }, THEMES.dark);
  screen.enter();
  screen.leave();
  screen.leave();
  assert.equal(written.length, 2);
  assert.ok(written[1]?.includes("\x1b[?1006l") && written[1]?.includes("\x1b[?1049l"));
});
