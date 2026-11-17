import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ErrorLog } from "../../extension/src/errors.ts";
import { OutputRecorder, OUTPUT_CAP_NOTE } from "../../extension/src/outputs.ts";
import { outDir, outPath } from "../../src/paths.ts";
import { tempDir } from "../helpers/tmp.ts";
import { bashStart, FakeSession, FakeTime, shellOutput, shellTask, toolComplete } from "./fake.ts";

function setup(options: { maxBytes?: number; realTimers?: boolean } = {}) {
  const tmp = tempDir("o");
  const time = new FakeTime();
  const errors = new ErrorLog(time);
  const dataDir = join(tmp.path, "data");
  const dir = outDir(dataDir, "s1");
  const recorder = new OutputRecorder({ dir, maxBytes: options.maxBytes ?? 1 << 20, clock: time, errors, detachedWaitMs: 5, timers: options.realTimers ? undefined : time, gapWaitMs: 500, retryMs: 2 });
  const session = new FakeSession();
  const file = (id: string) => outPath(dataDir, "s1", id);
  const read = (id: string) => readFileSync(file(id), "utf8");
  const feed = (...events: Parameters<typeof recorder.onEvent>[0][]) => {
    for (const e of events) recorder.onEvent(e, session.rpc.tasks);
  };
  return { tmp, time, errors, dir, recorder, session, file, read, feed };
}

test("tool.shell_output text is appended in order to <toolCallId>.out with colour codes and carriage returns kept", (t) => {
  const { tmp, dir, file, read, feed } = setup();
  t.after(tmp.cleanup);
  feed(
    bashStart("call-1", "make"),
    shellOutput("call-1", 0, "\x1b[31mred\x1b[0m\n"),
    shellOutput("call-1", 1, "progress 10%\rprogress 50%\r"),
    shellOutput("call-1", 2, "oops\n", "stderr"),
    shellOutput("call-1", 3, "tty line\r\n", "terminal"),
    shellOutput("call-2", 0, "other command\n"),
  );
  assert.equal(read("call-1"), "\x1b[31mred\x1b[0m\nprogress 10%\rprogress 50%\roops\ntty line\r\n");
  assert.equal(read("call-2"), "other command\n");
  assert.equal(statSync(file("call-1")).mode & 0o777, 0o600);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
});

test("a bash call gets an empty .out as soon as it starts; powershell only when output arrives", (t) => {
  const { tmp, file, read, feed } = setup();
  t.after(tmp.cleanup);
  feed(bashStart("b1", "sleep 5"));
  assert.equal(read("b1"), "");
  feed({ type: "tool.execution_start", data: { toolCallId: "p1", toolName: "powershell", arguments: { command: "Get-Date" } } });
  feed({ type: "tool.execution_start", data: { toolCallId: "v1", toolName: "view", arguments: { path: "/x" } } });
  assert.equal(existsSync(file("p1")), false);
  assert.equal(existsSync(file("v1")), false);
  feed(shellOutput("p1", 0, "Monday\n"));
  assert.equal(read("p1"), "Monday\n");
  // 重新加载后同一个命令的开始事件再来一次，已有的内容不能被清掉
  feed(bashStart("b1", "sleep 5"));
  feed(shellOutput("b1", 0, "x"));
  feed(bashStart("b1", "sleep 5"));
  assert.equal(read("b1"), "x");
});

test("a command too fast for tool.shell_output gets the complete event's content without the exit marker", (t) => {
  const { tmp, file, read, feed } = setup();
  t.after(tmp.cleanup);
  feed(
    bashStart("fast", "echo hi"),
    toolComplete("fast", { shellExecution: { exitCode: 0 }, result: { content: "hi\nthere\n<shellId: 7 completed with exit code 0>", structuredContent: { shellId: "7" } } }),
  );
  assert.equal(read("fast"), "hi\nthere");

  // 已经收到过 shell_output 的命令，完成事件里的内容不再写一遍
  feed(
    bashStart("slow", "make"),
    shellOutput("slow", 0, "building\n"),
    toolComplete("slow", { shellExecution: { exitCode: 0 }, result: { content: "building\n<shellId: 8 completed with exit code 0>" } }),
  );
  assert.equal(read("slow"), "building\n");

  // 后台命令（只回了“已启动”）和没有 shellExecution 的完成事件（命令还在跑）都不写
  feed(bashStart("bg", "server"), toolComplete("bg", { shellExecution: { exitCode: 0 }, result: { content: "<command started in background with shellId: bg>" } }));
  feed(bashStart("running", "sleep 500"), toolComplete("running", { result: { content: "<command with shellId: 9 is still running after 30 seconds.>" } }));
  assert.equal(read("bg"), "");
  assert.equal(read("running"), "");
  // 没见过开始事件的完成事件不建文件
  feed(toolComplete("unknown", { shellExecution: { exitCode: 0 }, result: { content: "x" } }));
  assert.equal(existsSync(file("unknown")), false);
});

test("past the size cap one note line is written and later output is dropped", (t) => {
  const { tmp, read, feed } = setup({ maxBytes: 10 });
  t.after(tmp.cleanup);
  feed(bashStart("big", "yes"), shellOutput("big", 0, "12345678"), shellOutput("big", 1, "abcdef"), shellOutput("big", 2, "more"), shellOutput("big", 3, "and more"));
  assert.equal(read("big"), `12345678ab${OUTPUT_CAP_NOTE}`);
  assert.equal(OUTPUT_CAP_NOTE.trim().startsWith("[copilot-panes:"), true);
});

test("the cap never cuts a multi-byte character in half, and output that fits exactly is not capped", (t) => {
  const { tmp, read, feed } = setup({ maxBytes: 10 });
  t.after(tmp.cleanup);
  feed(shellOutput("zh", 0, "你好吗"), shellOutput("zh", 1, "ab"), shellOutput("zh", 2, "好"));
  // "你好吗" 占 9 字节，上限 10：只剩 1 字节，装得下 "a" 装不下 "b"，后面的 "好" 被丢掉
  assert.equal(read("zh"), `你好吗a${OUTPUT_CAP_NOTE}`);

  feed(shellOutput("exact", 0, "1234567890"));
  assert.equal(read("exact"), "1234567890");
  feed(shellOutput("exact", 1, "x"));
  assert.equal(read("exact"), `1234567890${OUTPUT_CAP_NOTE}`);

  feed(shellOutput("wide", 0, "12345678"), shellOutput("wide", 1, "你好"));
  assert.equal(read("wide"), `12345678${OUTPUT_CAP_NOTE}`);
});

test("a recorder that starts on an existing file counts the bytes already in it", (t) => {
  const { tmp, dir, file, read, feed } = setup({ maxBytes: 10 });
  t.after(tmp.cleanup);
  feed(bashStart("old", "x"));
  writeFileSync(file("old"), "123456");
  assert.equal(dir.length > 0, true);
  feed(shellOutput("old", 0, "abcdefgh"));
  assert.equal(read("old"), `123456abcd${OUTPUT_CAP_NOTE}`);
});

test("chunks that arrive out of order are written in sequence order and duplicates are dropped", (t) => {
  const { tmp, read, feed } = setup();
  t.after(tmp.cleanup);
  feed(bashStart("c", "x"), shellOutput("c", 2, "C"), shellOutput("c", 0, "A"));
  assert.equal(read("c"), "A");
  feed(shellOutput("c", 1, "B"));
  assert.equal(read("c"), "ABC");
  feed(shellOutput("c", 1, "B"), shellOutput("c", 0, "A"), shellOutput("c", 2, "C"), shellOutput("c", 3, "D"), shellOutput("c", 3, "D"));
  assert.equal(read("c"), "ABCD");

  // 重复的同时还在等空缺：不能重复写
  feed(shellOutput("d", 0, "a"), shellOutput("d", 2, "c"), shellOutput("d", 2, "c"), shellOutput("d", 1, "b"));
  assert.equal(read("d"), "abc");
});

test("a gap in the sequence is waited for briefly, then the chunks that did arrive are written", (t) => {
  const { tmp, time, read, feed } = setup();
  t.after(tmp.cleanup);
  feed(shellOutput("g", 0, "A"), shellOutput("g", 2, "C"), shellOutput("g", 4, "E"));
  assert.equal(read("g"), "A");
  time.tick(499);
  assert.equal(read("g"), "A");
  time.tick(1);
  assert.equal(read("g"), "ACE");
  // 之后的接着写；空缺里迟到的丢掉
  feed(shellOutput("g", 5, "F"), shellOutput("g", 3, "late"));
  assert.equal(read("g"), "ACEF");
  assert.equal(time.pendingTimers, 0);
});

test("a recorder that joined late (first sequence is not 0) writes after the wait and then carries on", (t) => {
  const { tmp, time, read, feed } = setup();
  t.after(tmp.cleanup);
  feed(shellOutput("late", 7, "H"), shellOutput("late", 6, "G"));
  time.tick(500);
  assert.equal(read("late"), "GH");
  feed(shellOutput("late", 8, "I"));
  assert.equal(read("late"), "GHI");
});

test("output without a sequence is written in arrival order; the complete event and stop() do not leave chunks behind", (t) => {
  const { tmp, recorder, read, feed } = setup();
  t.after(tmp.cleanup);
  feed(shellOutput("n", undefined, "one "), shellOutput("n", undefined, "two"));
  assert.equal(read("n"), "one two");

  feed(bashStart("w", "x"), shellOutput("w", 0, "A"), shellOutput("w", 2, "C"), toolComplete("w", { shellExecution: { exitCode: 0 }, result: { content: "AC" } }));
  assert.equal(read("w"), "AC");

  feed(shellOutput("s", 0, "A"), shellOutput("s", 3, "D"));
  recorder.stop();
  assert.equal(read("s"), "AD");
  recorder.stop();
});

test("events with missing or mistyped fields are ignored", (t) => {
  const { tmp, dir, errors, feed } = setup();
  t.after(tmp.cleanup);
  feed(
    { type: "tool.shell_output" },
    { type: "tool.shell_output", data: null },
    { type: "tool.shell_output", data: { toolCallId: 5, text: "x" } },
    { type: "tool.shell_output", data: { toolCallId: "a", text: 5 } },
    { type: "tool.shell_output", data: { toolCallId: "", text: "x" } },
    { type: "tool.execution_start", data: { toolName: "bash" } },
    { type: "tool.execution_complete", data: { toolCallId: 3 } },
    { type: "tool.execution_complete", data: "oops" },
    { type: "assistant.message", data: { content: "hi" } },
  );
  assert.equal(existsSync(dir), false);
  assert.equal(errors.last(), null);
});

test("a failing write is recorded in the error log and does not throw; a removed directory is recreated", (t) => {
  const { tmp, dir, errors, recorder, read, feed } = setup();
  t.after(tmp.cleanup);
  feed(bashStart("r", "x"), shellOutput("r", 0, "A"));
  rmSync(dir, { recursive: true });
  feed(shellOutput("r", 1, "B"));
  assert.equal(read("r"), "B");
  assert.equal(errors.last(), null);

  // 输出目录的位置被一个普通文件占了：写不进去，记下错误，接着往下走
  const blocked = join(tmp.path, "blocked");
  writeFileSync(blocked, "file");
  const broken = new OutputRecorder({ dir: join(blocked, "out"), maxBytes: 100, clock: new FakeTime(), errors, detachedWaitMs: 5 });
  assert.doesNotThrow(() => broken.append("x", "text"));
  assert.equal(errors.last()?.step, "output.append");
  assert.doesNotThrow(() => broken.onEvent(bashStart("y", "cmd"), new FakeSession().rpc.tasks));
  assert.equal(errors.last()?.step, "output.create");
  assert.doesNotThrow(() => recorder.stop());
});

// ───── detach 命令 ─────

const detachStart = (toolCallId: string, command: string) => bashStart(toolCallId, command, { mode: "async", detach: true, shellId: "gw" });
const detachDone = (toolCallId: string, content: string, structured?: string) =>
  toolComplete(toolCallId, { result: { content, ...(structured ? { structuredContent: { shellId: structured } } : {}) } });

async function until(condition: () => boolean, what: string, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`等不到：${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("a detach command's output is copied with tasks.readOutput until it reports exit", async (t) => {
  const { tmp, session, read, feed } = setup({ realTimers: true });
  t.after(tmp.cleanup);
  const answers = [
    { text: "out 1\n", cursor: "c1" },
    { text: "", cursor: "c1" },
    { text: "out 2\r\n", cursor: "c2" },
    { text: "bye\n", cursor: "c3", exit: { status: "completed" as const, exitCode: 0 } },
    { text: "never read", cursor: "c4" },
  ];
  session.overrides.readOutput = async () => answers.shift()!;
  feed(detachStart("d1", "python3 server.py"), detachDone("d1", "<command started in detached background with shellId: gw>", "gw"));
  await until(() => answers.length === 1, "pump reads until exit");
  assert.equal(read("d1"), "out 1\nout 2\r\nbye\n");
  assert.deepEqual(session.callsOf("readOutput"), [
    { id: "gw", cursor: undefined, waitMs: 5 },
    { id: "gw", cursor: "c1", waitMs: 5 },
    { id: "gw", cursor: "c1", waitMs: 5 },
    { id: "gw", cursor: "c2", waitMs: 5 },
  ]);
});

test("resumeDetached continues the .out of a detach command after a reload and skips the bytes already in the file", async (t) => {
  const { tmp, dir, session, recorder, file, read } = setup({ realTimers: true });
  t.after(tmp.cleanup);
  mkdirSync(dir, { recursive: true });
  writeFileSync(file("d1"), "héllo\nline 2\n");
  const answers = [
    { text: "héllo\nline 2\nline 3\n", cursor: "c1" },
    { text: "line 4\n", cursor: "c2", exit: { status: "completed" as const, exitCode: 0 } },
  ];
  session.overrides.readOutput = async () => answers.shift()!;
  recorder.resumeDetached(session.rpc.tasks, "d1", "gw");
  recorder.resumeDetached(session.rpc.tasks, "d1", "gw"); // 同一个 shell 已经在抄，第二次不再起
  await until(() => answers.length === 0, "pump reads until exit");
  assert.equal(read("d1"), "héllo\nline 2\nline 3\nline 4\n");
  assert.equal(session.callsOf("readOutput").length, 2);
});

test("the shellId of a detach command comes from the 'with shellId: X>' text, or from the task list when the event has none", async (t) => {
  const { tmp, time, session, read, feed } = setup({ realTimers: true });
  t.after(tmp.cleanup);
  const exitNow = (text: string) => async () => ({ text, cursor: "z", exit: { status: "completed" as const } });

  session.overrides.readOutput = exitNow("from text");
  feed(detachStart("d1", "job one"), detachDone("d1", "<command started in detached background with shellId: job1>"));
  await until(() => session.callsOf("readOutput").length === 1, "first pump");
  assert.deepEqual(session.callsOf("readOutput")[0], { id: "job1", cursor: undefined, waitMs: 5 });
  assert.equal(read("d1"), "from text");

  const start = new Date(time.now()).toISOString();
  session.tasks = [
    shellTask("job1", "job two", start, { attachmentMode: "detached" }),
    shellTask("old", "job two", new Date(time.now() - 5000).toISOString(), { attachmentMode: "detached" }),
    shellTask("attached", "job two", start),
    shellTask("other", "another", start, { attachmentMode: "detached" }),
  ];
  session.overrides.readOutput = exitNow("from list");
  feed(detachStart("d2", "job two"), detachDone("d2", "no id in here"));
  await until(() => session.callsOf("readOutput").length === 2, "second pump");
  // job1 已经在抄给 d1，所以认领最晚启动、没被认领的那个：old
  assert.deepEqual(session.callsOf("readOutput")[1], { id: "old", cursor: undefined, waitMs: 5 });
});

test("a detach command whose start failed, or whose shell is already being copied, is not copied again", async (t) => {
  const { tmp, session, feed } = setup({ realTimers: true });
  t.after(tmp.cleanup);
  session.overrides.readOutput = async () => ({ text: "", cursor: "z", exit: { status: "completed" as const } });
  feed(detachStart("d1", "x"), toolComplete("d1", { success: false, error: { message: "failed" } }));
  feed(detachStart("d2", "x"), detachDone("d2", "started", "gw"), detachStart("d3", "x"), detachDone("d3", "started", "gw"));
  await until(() => session.callsOf("readOutput").length >= 1, "pump for gw");
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(session.callsOf("readOutput").length, 1);
});

test("copying a detach command's output gives up after three failures in a row and records the error", async (t) => {
  const { tmp, errors, session, read, feed } = setup({ realTimers: true });
  t.after(tmp.cleanup);
  let n = 0;
  session.overrides.readOutput = async () => {
    n += 1;
    if (n === 1) return { text: "first\n", cursor: "c1" };
    throw new Error("task gone");
  };
  feed(detachStart("d1", "x"), detachDone("d1", "started", "gw"));
  await until(() => errors.last() !== null, "error recorded");
  assert.equal(errors.last()?.step, "detached.output");
  assert.equal(errors.last()?.message, "task gone");
  assert.equal(n, 4);
  assert.equal(read("d1"), "first\n");
});

test("a failure that is followed by a success does not count towards the limit, and stop() ends the loop", async (t) => {
  const { tmp, recorder, errors, session, feed } = setup({ realTimers: true });
  t.after(tmp.cleanup);
  let n = 0;
  session.overrides.readOutput = async () => {
    n += 1;
    if (n % 2 === 1) throw new Error("flaky");
    return { text: `t${n}`, cursor: `c${n}` };
  };
  feed(detachStart("d1", "x"), detachDone("d1", "started", "gw"));
  await until(() => n >= 8, "eight calls, four of them failing");
  assert.equal(errors.last(), null);
  recorder.stop();
  const seen = n;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.ok(n <= seen + 1, `stop() did not end the loop (${seen} → ${n})`);
});
