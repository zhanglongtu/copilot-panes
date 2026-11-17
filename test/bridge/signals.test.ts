import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Interrupter, checkTarget, isDescendantOf, nextSignal, procAccess } from "../../src/bridge/signals.ts";
import type { ProcAccess } from "../../src/bridge/signals.ts";
import type { InterruptSignal } from "../../src/types/app.ts";
import { tempDir } from "../helpers/tmp.ts";

const ESCALATE = 3000;

/** 假的进程表：pid → 父进程号和进程组号；kill 只记录，不真的发。 */
class FakeProc implements ProcAccess {
  readonly kills: Array<{ target: number; signal: InterruptSignal }> = [];
  killError: Error | null = null;
  readonly table = new Map<number, { ppid: number; pgid: number }>();

  add(pid: number, ppid: number, pgid = pid): this {
    this.table.set(pid, { ppid, pgid });
    return this;
  }
  exists(pid: number): boolean {
    return this.table.has(pid);
  }
  parentOf(pid: number): number | null {
    return this.table.get(pid)?.ppid ?? null;
  }
  processGroupOf(pid: number): number | null {
    return this.table.get(pid)?.pgid ?? null;
  }
  kill(target: number, signal: InterruptSignal): void {
    if (this.killError) throw this.killError;
    this.kills.push({ target, signal });
  }
}

const COPILOT = 100;
/** Copilot CLI(100) → 命令的 shell(200，自己进程组的组长) → 它的子进程(201，同一个进程组)。 */
function sessionTree(): FakeProc {
  return new FakeProc().add(COPILOT, 1, 1).add(200, COPILOT, 200).add(201, 200, 200);
}

const clockAt = (start = 0) => {
  const clock = { t: start, now: () => clock.t };
  return clock;
};

test("nextSignal escalates SIGINT, SIGTERM, SIGKILL and waits within three seconds", () => {
  assert.deepEqual(nextSignal(undefined, 0, ESCALATE), { send: "SIGINT" });
  assert.deepEqual(nextSignal({ signal: "SIGINT", sentAt: 1000 }, 1000, ESCALATE), { wait: 3000, last: "SIGINT" });
  assert.deepEqual(nextSignal({ signal: "SIGINT", sentAt: 1000 }, 3999, ESCALATE), { wait: 1, last: "SIGINT" });
  assert.deepEqual(nextSignal({ signal: "SIGINT", sentAt: 1000 }, 4000, ESCALATE), { send: "SIGTERM" });
  assert.deepEqual(nextSignal({ signal: "SIGTERM", sentAt: 1000 }, 2000, ESCALATE), { wait: 2000, last: "SIGTERM" });
  assert.deepEqual(nextSignal({ signal: "SIGTERM", sentAt: 1000 }, 9000, ESCALATE), { send: "SIGKILL" });
  assert.deepEqual(nextSignal({ signal: "SIGKILL", sentAt: 1000 }, 9000, ESCALATE), { send: "SIGKILL" });
  assert.deepEqual(nextSignal({ signal: "SIGKILL", sentAt: 1000 }, 1500, ESCALATE), { wait: 2500, last: "SIGKILL" });
});

test("press never signals a detached command: its pid is not a group leader and a lone SIGINT does nothing, so the caller falls back to tasks.cancel", () => {
  const proc = sessionTree();
  const interrupter = new Interrupter(proc, clockAt(10_000), ESCALATE);
  assert.deepEqual(interrupter.press("c1", 200, COPILOT, { detached: true }), { kind: "fallback", reason: "这是 detach 出去的命令，发信号停不掉它" });
  assert.deepEqual(proc.kills, []);
  assert.equal(interrupter.press("c1", 200, COPILOT, { detached: false }).kind, "sent");
});

test("press walks the escalation: SIGINT, wait, SIGTERM, SIGKILL, and forget starts over", () => {
  const proc = sessionTree();
  const clock = clockAt(10_000);
  const interrupter = new Interrupter(proc, clock, ESCALATE);
  assert.deepEqual(interrupter.press("c1", 200, COPILOT), { kind: "sent", signal: "SIGINT", target: "group" });
  clock.t += 1000;
  assert.deepEqual(interrupter.press("c1", 200, COPILOT), { kind: "wait", signal: "SIGINT", remainingMs: 2000 });
  clock.t += 2000;
  assert.deepEqual(interrupter.press("c1", 200, COPILOT), { kind: "sent", signal: "SIGTERM", target: "group" });
  clock.t += 3000;
  assert.deepEqual(interrupter.press("c1", 200, COPILOT), { kind: "sent", signal: "SIGKILL", target: "group" });
  assert.deepEqual(
    proc.kills.map((k) => [k.target, k.signal]),
    [[-200, "SIGINT"], [-200, "SIGTERM"], [-200, "SIGKILL"]],
  );
  // 另一条命令的记录互不影响；忘掉之后重新从 SIGINT 开始
  assert.deepEqual(interrupter.press("c2", 200, COPILOT), { kind: "sent", signal: "SIGINT", target: "group" });
  interrupter.forget("c1");
  assert.deepEqual(interrupter.press("c1", 200, COPILOT), { kind: "sent", signal: "SIGINT", target: "group" });
});

test("a group leader gets the signal on its process group, any other process just itself", () => {
  const proc = sessionTree();
  const interrupter = new Interrupter(proc, clockAt(), ESCALATE);
  assert.deepEqual(interrupter.press("leader", 200, COPILOT), { kind: "sent", signal: "SIGINT", target: "group" });
  assert.deepEqual(interrupter.press("member", 201, COPILOT), { kind: "sent", signal: "SIGINT", target: "process" });
  assert.deepEqual(proc.kills, [
    { target: -200, signal: "SIGINT" },
    { target: 201, signal: "SIGINT" },
  ]);
});

test("a pid that is gone or not under the Copilot CLI process is refused (pid reuse)", () => {
  const proc = sessionTree().add(300, 1, 300).add(400, 300, 300);
  const interrupter = new Interrupter(proc, clockAt(), ESCALATE);
  assert.deepEqual(interrupter.press("gone", 999, COPILOT), { kind: "fallback", reason: "命令已经退出了" });
  assert.deepEqual(interrupter.press("reused", 300, COPILOT), { kind: "fallback", reason: "这个进程号已经不属于这个 session 的 Copilot CLI" });
  assert.deepEqual(interrupter.press("reused-child", 400, COPILOT), { kind: "fallback", reason: "这个进程号已经不属于这个 session 的 Copilot CLI" });
  assert.deepEqual(interrupter.press("other-copilot", 200, 555), { kind: "fallback", reason: "这个进程号已经不属于这个 session 的 Copilot CLI" });
  assert.deepEqual(interrupter.press("pid1", 1, COPILOT), { kind: "fallback", reason: "命令已经退出了" });
  assert.deepEqual(proc.kills, []);
  assert.deepEqual(checkTarget(200, COPILOT, proc), { ok: true, group: true });
  assert.deepEqual(checkTarget(201, COPILOT, proc), { ok: true, group: false });
});

test("without a pid press() returns fallback so the caller can ask tasks.cancel", () => {
  const proc = sessionTree();
  const interrupter = new Interrupter(proc, clockAt(), ESCALATE);
  assert.equal(interrupter.press("c1", null, COPILOT).kind, "fallback");
  assert.equal(interrupter.press("c1", 200, null).kind, "fallback");
  assert.deepEqual(proc.kills, []);
});

test("a failing kill is reported and does not count as a signal sent", () => {
  const proc = sessionTree();
  const interrupter = new Interrupter(proc, clockAt(), ESCALATE);
  proc.killError = Object.assign(new Error("no such process"), { code: "ESRCH" });
  assert.deepEqual(interrupter.press("c1", 200, COPILOT), { kind: "failed", reason: "命令已经退出了" });
  proc.killError = Object.assign(new Error("operation not permitted"), { code: "EPERM" });
  const result = interrupter.press("c1", 200, COPILOT);
  assert.equal(result.kind, "failed");
  assert.match(result.kind === "failed" ? result.reason : "", /operation not permitted/);
  proc.killError = null;
  assert.deepEqual(interrupter.press("c1", 200, COPILOT), { kind: "sent", signal: "SIGINT", target: "group" });
});

test("isDescendantOf follows the parent chain, stops at a broken or circular chain", () => {
  const proc = new FakeProc().add(1, 0).add(10, 1).add(20, 10).add(30, 20).add(40, 50).add(50, 40);
  assert.equal(isDescendantOf(30, 10, proc), true);
  assert.equal(isDescendantOf(30, 1, proc), true);
  assert.equal(isDescendantOf(30, 30, proc), false);
  assert.equal(isDescendantOf(10, 30, proc), false);
  assert.equal(isDescendantOf(999, 1, proc), false);
  assert.equal(isDescendantOf(40, 1, proc), false);
});

test("procAccess reads a fake /proc, including program names with spaces and parentheses, and refuses dangerous kill targets", () => {
  const dir = tempDir("p");
  try {
    const put = (pid: number, stat: string) => {
      mkdirSync(join(dir.path, String(pid)));
      writeFileSync(join(dir.path, String(pid), "stat"), stat);
    };
    put(10, "10 (bash) S 1 10 10 34816 10 4194304 100 0 0 0 1 1 0 0 20 0 1 0 5000 1 1 18446744073709551615");
    put(20, "20 (my (odd) name) S 10 10 10 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 5001 1 1 0");
    put(30, "garbage");
    const proc = procAccess(dir.path);
    assert.equal(proc.exists(10), true);
    assert.equal(proc.exists(11), false);
    assert.equal(proc.parentOf(20), 10);
    assert.equal(proc.processGroupOf(20), 10);
    assert.equal(proc.parentOf(10), 1);
    assert.equal(proc.processGroupOf(10), 10);
    assert.equal(proc.parentOf(30), null);
    assert.equal(proc.parentOf(99), null);
    for (const target of [0, 1, -1, Number.NaN, 1.5]) assert.throws(() => proc.kill(target, "SIGINT"), RangeError);
  } finally {
    dir.cleanup();
  }
});

test("checkTarget does not trust a Copilot CLI pid of 1 or less, and never targets the interface itself, its ancestors or its process group", () => {
  const UI = 300;
  // init(1) → Copilot CLI(100) → 命令(200，组长)；init → tmux 的 shell(400，组长) → 界面(300，在 400 的进程组里)
  const proc = new FakeProc().add(1, 0, 1).add(COPILOT, 1, COPILOT).add(200, COPILOT, 200).add(400, 1, 400).add(UI, 400, 400);
  // 对端报进程号 1：所有进程的祖先，检查本来永远通过
  assert.deepEqual(checkTarget(200, 1, proc, UI), { ok: false, reason: "Copilot CLI 的进程号不可信" });
  assert.deepEqual(checkTarget(200, 0, proc, UI), { ok: false, reason: "Copilot CLI 的进程号不可信" });
  assert.deepEqual(checkTarget(200, COPILOT, proc, UI), { ok: true, group: true });
  // 目标是界面自己、界面的祖先、或者信号会落进界面所在的进程组
  const crowded = new FakeProc().add(COPILOT, 1, COPILOT).add(UI, COPILOT, UI).add(310, UI, 310).add(320, COPILOT, UI);
  assert.deepEqual(checkTarget(UI, COPILOT, crowded, UI), { ok: false, reason: "这个进程号是界面自己或它的祖先" });
  assert.deepEqual(checkTarget(310, COPILOT, crowded.add(310, UI, 310), 310), { ok: false, reason: "这个进程号是界面自己或它的祖先" });
  const lowest = new FakeProc().add(COPILOT, 1, COPILOT).add(500, COPILOT, 500).add(UI, 500, 500);
  assert.deepEqual(checkTarget(500, COPILOT, lowest, UI), { ok: false, reason: "这个进程号是界面自己或它的祖先" });
  assert.deepEqual(checkTarget(320, COPILOT, crowded, UI), { ok: false, reason: "信号会发到界面自己所在的进程组" });
  // Interrupter 默认的 selfPid 是界面自己的 process.pid：对着自己按 Ctrl+C 只会退回 fallback，不会发信号
  const self = new FakeProc().add(COPILOT, 1, COPILOT).add(process.pid, COPILOT, process.pid);
  const interrupter = new Interrupter(self, clockAt(), ESCALATE);
  assert.equal(interrupter.press("c1", process.pid, COPILOT).kind, "fallback");
  assert.deepEqual(self.kills, []);
});
