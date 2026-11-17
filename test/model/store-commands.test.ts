// shell 命令：开始、结束、转后台、三个结束来源、留下的失败命令、事件里的输出。
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionStore } from "../../src/model/store.ts";
import type { CommandRecord } from "../../src/types/model.ts";
import { BASE, bashBackground, bashEnd, bashStart, completed, ev, feed, shellCall, shellNotice, started, storeOf } from "./support.ts";

function cmd(store: SessionStore, id: string): CommandRecord {
  const record = store.command(id);
  assert.ok(record, `command ${id}`);
  return record;
}

const STILL_RUNNING = "<command with shellId: b is still running after 5 seconds. Use read_bash to continue waiting, or stop_bash to stop it.>";

// ───── 开始、结束和转后台 ─────

test("a foreground command: start under its agent, end with exit code 0, output without the exit marker", () => {
  const store = storeOf(started("A", "alpha"), bashStart("c1", "echo hi", "A", 1), bashEnd("c1", "hi\n", 0, "A", 3));
  const c = cmd(store, "c1");
  assert.deepEqual([c.command, c.agentId, c.background, c.status, c.exitCode, c.eventOutput], ["echo hi", "A", false, "done", 0, "hi"]);
  assert.deepEqual([c.startedAt, c.endedAt, c.endReason], [store.agent("A")!.startedAt + 1000, c.startedAt + 2000, "exit"]);
});

test("the exit marker is removed from the output together with the newline before it", () => {
  const store = storeOf(bashStart("c1", "ls"), bashEnd("c1", "a\nb\n", 3));
  assert.deepEqual([cmd(store, "c1").eventOutput, cmd(store, "c1").exitCode, cmd(store, "c1").status], ["a\nb", 3, "failed"]);
});

test("a command of the main session has no agent; the command text, description and tool name are kept as they are", () => {
  const store = storeOf(bashStart("c1", "ls  -l\n/tmp", null, 0, { description: "list it" }));
  const c = cmd(store, "c1");
  assert.deepEqual([c.agentId, c.command, c.description, c.toolName], [null, "ls  -l\n/tmp", "list it", "bash"]);
  feed(store, ev("tool.execution_start", { toolCallId: "p1", toolName: "powershell", arguments: { command: "dir" } }));
  assert.equal(cmd(store, "p1").toolName, "powershell");
  assert.deepEqual(
    store.commands().map((c) => c.toolCallId),
    ["c1", "p1"],
  );
});

test("an async command stays running until the notification, whose exit code is used", () => {
  const store = storeOf(bashStart("c1", "make", null, 0, { mode: "async", shellId: "build" }), bashBackground("c1", "build", null, 0.1));
  const c = cmd(store, "c1");
  assert.deepEqual([c.background, c.promoted, c.status, c.shellId], [true, false, "running", "build"]);
  feed(store, shellNotice("build", 2, 60));
  assert.deepEqual([c.status, c.exitCode, c.endReason], ["failed", 2, "exit"]);
});

test("a foreground command that timed out goes on in the background and is marked as promoted", () => {
  const store = storeOf(
    bashStart("c1", "sleep 500"),
    bashBackground("c1", "7", null, 30, "partial\n<command with shellId: 7 is still running after 30 seconds>"),
  );
  const c = cmd(store, "c1");
  assert.deepEqual([c.background, c.promoted, c.status, c.shellId, c.eventOutput], [true, true, "running", "7", "partial\n"]);
  feed(store, shellNotice("7", 0, 90));
  assert.deepEqual([c.status, c.exitCode], ["done", 0]);
});

test("a read_bash result with the completion marker ends the command with that exit code", () => {
  const store = storeOf(
    bashStart("c1", "make", null, 0, { mode: "async", shellId: "b" }),
    bashBackground("c1", "b"),
    shellCall("r1", "read_bash", "b", "building\n<shellId: b completed with exit code 0>", 5),
  );
  assert.deepEqual([cmd(store, "c1").status, cmd(store, "c1").exitCode, cmd(store, "c1").eventOutput], ["done", 0, "building\n"]);
});

test("stop_bash ends the command as stopped, with no exit code, whatever the result says", () => {
  for (const success of [true, false]) {
    const store = storeOf(
      bashStart("c1", "tail -f x", null, 0, { mode: "async", shellId: "t" }),
      bashBackground("c1", "t"),
      shellCall("s1", "stop_bash", "t", "stopped", 5, null, success),
    );
    assert.deepEqual([cmd(store, "c1").status, cmd(store, "c1").exitCode, cmd(store, "c1").endReason], ["stopped", null, "stopped"], String(success));
  }
});

test("a sub-agent's background commands are dropped when it finishes, its foreground ones stay", () => {
  const store = storeOf(
    started("A", "alpha"),
    bashStart("c1", "sleep 60", "A", 1, { mode: "async", shellId: "p" }),
    bashBackground("c1", "p", "A", 1.1),
    bashStart("c2", "sleep 5", "A", 2),
    completed("A", "t-A", { at: 10 }),
  );
  assert.deepEqual([cmd(store, "c1").status, cmd(store, "c1").endReason], ["stopped", "agent-ended"]);
  assert.deepEqual([cmd(store, "c2").status, cmd(store, "c2").endReason], ["running", null]);
  assert.equal(cmd(store, "c1").keptAsFailed, false);
});

test("a command of the main session is not dropped when a sub-agent finishes", () => {
  const store = storeOf(started("A", "alpha"), bashStart("m1", "serve", null, 1, { mode: "async", shellId: "m" }), bashBackground("m1", "m", null, 1.1), completed("A", "t-A", { at: 5 }));
  assert.equal(cmd(store, "m1").status, "running");
});

test("a failed call without an exit code has the error message, ends as done and is not kept as a failure", () => {
  const store = storeOf(bashStart("c1", "kill"), ev("tool.execution_complete", { toolCallId: "c1", success: false, error: { message: "not allowed", code: "failure" } }));
  const c = cmd(store, "c1");
  assert.deepEqual([c.exitCode, c.error, c.status, c.keptAsFailed], [null, "not allowed", "done", false]);
});

test("a main-session abort stops its foreground commands, not its background ones and not a sub-agent's", () => {
  const store = storeOf(
    started("A", "alpha"),
    bashStart("fg", "make", null, 1),
    bashStart("bg", "serve", null, 1, { mode: "async", shellId: "m" }),
    bashBackground("bg", "m", null, 1.1),
    bashStart("sub", "make", "A", 1),
    ev("abort", { reason: "user_abort" }, null, 5),
  );
  assert.deepEqual([cmd(store, "fg").status, cmd(store, "fg").endReason], ["stopped", "aborted"]);
  assert.equal(cmd(store, "bg").status, "running");
  assert.equal(cmd(store, "sub").status, "running");
});

// ───── 三处最容易错的规则 ─────

test("promotion to background needs success, no integer exit code and a shellId: a sync complete with both shellId and exit code ends", () => {
  const finished = (data: Record<string, unknown>) => {
    const store = storeOf(bashStart("c1", "make"), ev("tool.execution_complete", { toolCallId: "c1", ...data }));
    return cmd(store, "c1");
  };
  // 同步命令正常结束，真实日志里同时带 structuredContent.shellId 和 shellExecution.exitCode：结束，不转后台
  const sync = finished({ success: true, shellExecution: { exitCode: 0 }, result: { content: "ok\n<shellId: 7 completed with exit code 0>", structuredContent: { shellId: "7" } } });
  assert.deepEqual([sync.status, sync.promoted, sync.background, sync.exitCode], ["done", false, false, 0]);
  const failed = finished({ success: true, shellExecution: { exitCode: 2 }, result: { content: "x", structuredContent: { shellId: "7" } } });
  assert.deepEqual([failed.status, failed.promoted, failed.exitCode], ["failed", false, 2]);

  // 三个条件都满足：转后台
  const promoted = finished({ success: true, result: { content: "x", structuredContent: { shellId: "7" } } });
  assert.deepEqual([promoted.status, promoted.promoted, promoted.shellId], ["running", true, "7"]);
  // 退出码不是整数，不算有退出码，照样转后台
  const oddExit = finished({ success: true, shellExecution: { exitCode: "0" }, result: { content: "x", structuredContent: { shellId: "7" } } });
  assert.deepEqual([oddExit.status, oddExit.promoted], ["running", true]);
  const nullExit = finished({ success: true, shellExecution: {}, result: { content: "x", structuredContent: { shellId: "7" } } });
  assert.equal(nullExit.status, "running");

  // success 不为真：不转后台，当作结束
  const notOk = finished({ success: false, result: { content: "x", structuredContent: { shellId: "7" } } });
  assert.deepEqual([notOk.status, notOk.promoted], ["done", false]);
  // 没有 shellId：结束
  const noShell = finished({ success: true, result: { content: "no id here" } });
  assert.deepEqual([noShell.status, noShell.promoted], ["done", false]);

  // shellId 的第三处来源：success 为真、没有 shellExecution 时，从 content 里的 "shellId: X>" 找
  const byText = finished({ success: true, result: { content: "<command started in detached background with shellId: sh9>" } });
  assert.deepEqual([byText.status, byText.promoted, byText.shellId], ["running", true, "sh9"]);
  // 有 shellExecution（哪怕没有退出码）就不用文字里的 shellId
  const textButExecution = finished({ success: true, shellExecution: {}, result: { content: "<command with shellId: sh9>" } });
  assert.equal(textButExecution.status, "done");
});

test("a background command ends at the first of its three sources; later ones find nothing and their exit code is dropped", () => {
  const run = (...endings: string[][]) => {
    const store = storeOf(bashStart("c1", "make", null, 0, { mode: "async", shellId: "b" }), bashBackground("c1", "b", null, 0.1), ...endings);
    return cmd(store, "c1");
  };
  const readEnd = shellCall("r1", "read_bash", "b", "out\n<shellId: b completed with exit code 3>", 5);
  const stopEnd = shellCall("s1", "stop_bash", "b", "stopped", 5);

  const notifyFirst = run([shellNotice("b", 7, 4)], readEnd);
  assert.deepEqual([notifyFirst.status, notifyFirst.exitCode, notifyFirst.endedAt], ["failed", 7, BASE + 4000]);
  const readFirst = run(readEnd, [shellNotice("b", 7, 9)]);
  assert.deepEqual([readFirst.status, readFirst.exitCode, readFirst.endedAt], ["failed", 3, BASE + 5100]);
  const stopFirst = run(stopEnd, readEnd, [shellNotice("b", 7, 9)]);
  assert.deepEqual([stopFirst.status, stopFirst.exitCode, stopFirst.endReason], ["stopped", null, "stopped"]);
  const readThenStop = run(readEnd, stopEnd);
  assert.deepEqual([readThenStop.status, readThenStop.exitCode], ["failed", 3]);
  // 通知先到且没有退出码时，之后 read_bash 标记里的退出码丢失
  const noCodeNotice = run([shellNotice("b", null, 4, "shell_detached_completed")], readEnd);
  assert.deepEqual([noCodeNotice.status, noCodeNotice.exitCode], ["done", null]);
});

// ───── 哪些失败命令会留下 ─────

test("a command that ran two seconds and exited non-zero is kept as failed", () => {
  const store = storeOf(bashStart("c1", "make", null, 10), bashEnd("c1", "boom\n", 2, null, 12));
  const c = cmd(store, "c1");
  assert.deepEqual([c.status, c.exitCode, c.keptAsFailed, (c.endedAt ?? 0) - c.startedAt], ["failed", 2, true, 2000]);
});

test("a short command that never showed in the list is not kept even if it failed", () => {
  const store = storeOf(bashStart("c1", "grep x y", null, 10), bashEnd("c1", "", 1, null, 11.9));
  assert.deepEqual([cmd(store, "c1").status, cmd(store, "c1").keptAsFailed], ["failed", false]);
});

test("a successful command is not kept, however long it ran", () => {
  const store = storeOf(bashStart("c1", "make", null, 10), bashEnd("c1", "ok\n", 0, null, 60));
  assert.deepEqual([cmd(store, "c1").status, cmd(store, "c1").keptAsFailed], ["done", false]);
});

test("a background command that fails is kept however short it ran", () => {
  const store = storeOf(bashStart("c1", "make", null, 0, { mode: "async", shellId: "b" }), bashBackground("c1", "b", null, 0.1), shellNotice("b", 7, 0.5));
  assert.deepEqual([cmd(store, "c1").status, cmd(store, "c1").exitCode, cmd(store, "c1").keptAsFailed], ["failed", 7, true]);
});

test("a stopped command and a background command dropped with its agent are not failures", () => {
  const store = storeOf(
    started("A", "alpha"),
    bashStart("c1", "tail -f x", "A", 0, { mode: "async", shellId: "t" }),
    bashBackground("c1", "t", "A", 0.1),
    shellCall("s1", "stop_bash", "t", "stopped", 5, "A"),
    bashStart("c2", "sleep 60", "A", 6, { mode: "async", shellId: "p" }),
    bashBackground("c2", "p", "A", 6.1),
    completed("A", "t-A", { at: 9 }),
  );
  assert.deepEqual(
    store.commands().map((c) => [c.status, c.keptAsFailed]),
    [
      ["stopped", false],
      ["stopped", false],
    ],
  );
});

test("at most five failed commands are kept and the earliest goes first", () => {
  const lines: string[] = [];
  for (let i = 0; i < 7; i++) lines.push(bashStart(`c${i}`, `job ${i}`, null, 10 * i), bashEnd(`c${i}`, "", 1, null, 10 * i + 5));
  const store = storeOf(lines);
  assert.deepEqual(
    store.commands().filter((c) => c.keptAsFailed).map((c) => c.toolCallId),
    ["c2", "c3", "c4", "c5", "c6"],
  );
  assert.deepEqual([cmd(store, "c0").status, cmd(store, "c0").keptAsFailed], ["failed", false]);
});

// ───── 事件里的输出（没有 .out 文件时界面用它） ─────

function startedInBackground(agent: string | null = "A", extra: Record<string, unknown> = {}): string[] {
  return [started("A", "alpha"), bashStart("c1", "make", agent, 1, { mode: "async", shellId: "b", ...extra }), bashBackground("c1", "b", agent, 1.1, "<command started in background with shellId: b>")];
}

test("a finished background command keeps what read_bash returned, in order, without the trailing notices", () => {
  const store = storeOf(
    startedInBackground(),
    shellCall("r1", "read_bash", "b", `out 1\n${STILL_RUNNING}`, 5, "A"),
    shellCall("r2", "read_bash", "b", "out 2\nout 3\n<shellId: b completed with exit code 0>", 9, "A"),
  );
  const c = cmd(store, "c1");
  assert.equal(c.eventOutput, "out 1\nout 2\nout 3\n");
  assert.deepEqual([c.status, c.exitCode], ["done", 0]);
});

test("the end notice alone still leaves the output read before it", () => {
  const store = storeOf(startedInBackground(), shellCall("r1", "read_bash", "b", "out 1\nout 2\n", 5, "A"), shellNotice("b", 2, 30));
  assert.deepEqual([cmd(store, "c1").eventOutput, cmd(store, "c1").status, cmd(store, "c1").exitCode], ["out 1\nout 2\n", "failed", 2]);
});

test("a stopped command keeps what was read before, and the stop_bash result is no output", () => {
  const store = storeOf(startedInBackground(), shellCall("r1", "read_bash", "b", "out 1\n", 5, "A"), shellCall("s1", "stop_bash", "b", "Stopped shell b", 8, "A"));
  assert.deepEqual([cmd(store, "c1").eventOutput, cmd(store, "c1").status], ["out 1\n", "stopped"]);
});

test("a detached command is the same", () => {
  const store = storeOf(startedInBackground("A", { detach: true }), shellCall("r1", "read_bash", "b", "out 1\n<shellId: b completed with exit code 0>", 5, "A"));
  assert.deepEqual([cmd(store, "c1").detach, cmd(store, "c1").eventOutput, cmd(store, "c1").status], [true, "out 1\n", "done"]);
});

test("a command moved to the background has its first part once, from the call result, and the rest from the reads", () => {
  const store = storeOf(
    started("A", "alpha"),
    bashStart("c1", "make", "A", 1),
    bashBackground("c1", "b", "A", 1.1, "out 1\nout 2\n<command started in background with shellId: b>"),
    shellCall("r1", "read_bash", "b", "out 3\n<shellId: b completed with exit code 0>", 9, "A"),
  );
  assert.equal(cmd(store, "c1").eventOutput, "out 1\nout 2\nout 3\n");
  assert.equal(cmd(store, "c1").promoted, true);
});

test("write_bash results count as output too", () => {
  const store = storeOf(startedInBackground(), shellCall("w1", "write_bash", "b", "typed answer\n", 5, "A"), shellNotice("b", 0, 30));
  assert.equal(cmd(store, "c1").eventOutput, "typed answer\n");
});

test("failed reads, the interrupted note and notice-only results are not output", () => {
  const store = storeOf(
    startedInBackground(),
    shellCall("r1", "read_bash", "b", "shell b not found", 4, "A", false),
    shellCall("r2", "read_bash", "b", "Read interrupted by user steering; shell continues in background.", 5, "A"),
    shellCall("r3", "read_bash", "b", STILL_RUNNING, 6, "A"),
    shellCall("r4", "read_bash", "b", "   \n", 7, "A"),
    shellNotice("b", 0, 30),
  );
  assert.deepEqual([cmd(store, "c1").eventOutput, cmd(store, "c1").status], ["", "done"]);
});

test("a background command nobody read has no event output", () => {
  const store = storeOf(startedInBackground(), shellNotice("b", 0, 30));
  assert.equal(cmd(store, "c1").eventOutput, "");
});

test("commandByShellId finds the latest command that has the shellId, also after it ended", () => {
  const store = storeOf(
    bashStart("c1", "one", null, 0, { mode: "async", shellId: "b" }),
    bashBackground("c1", "b", null, 0.1),
    shellNotice("b", 0, 1),
    bashStart("c2", "two", null, 2, { mode: "async", shellId: "b" }),
  );
  assert.equal(store.commandByShellId("b")?.toolCallId, "c2");
  assert.equal(store.commandByShellId("nope"), undefined);
});
