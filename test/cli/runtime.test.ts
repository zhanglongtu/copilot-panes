// 整个界面的端到端测试：--demo 的数据、真实的状态机和视图、真实的输出层，输入输出换成假的终端。
// 输出交给 xterm（TermView）还原成屏幕，再和视图直接画出的同一帧逐行对照。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { runApp } from "../../src/runtime.ts";
import { TermView } from "../../src/term/terminal.ts";
import { DISCOVER_FOLLOW_MS, DISCOVER_STEADY_MS } from "../../src/constants.ts";
import { realTimers } from "../../src/types/clock.ts";
import type { Timers } from "../../src/types/clock.ts";
import { tempDir } from "../helpers/tmp.ts";
import { DEMO_KEYS, demoData } from "../helpers/demo-data.ts";
import { frameText } from "../../src/ui/line.ts";
import { renderFrame } from "../../src/ui/views/frame.ts";
import { baseState } from "../ui/body-support.ts";

/** 转动符号取第 2 帧（⠹）；时间冻住，用时就是演示数据里的数。 */
const FROZEN_NOW = 1_800_000_000_250;

/** 演示刚开始时的画面：焦点在名单，选中 fix-login，review 没看过（runtime.ts 的演示这样起头）。 */
function firstFrame(cols: number, rows = 22): string[] {
  const state = baseState({ focus: "list", selected: DEMO_KEYS.fixLogin, unread: new Set([DEMO_KEYS.review]) });
  return frameText(renderFrame(state, demoData(FROZEN_NOW), { cols, rows })).split("\n");
}

function startApp(overrides: Partial<Parameters<typeof runApp>[0]> = {}, size = { cols: 80, rows: 22 }) {
  const stdout = Object.assign(new PassThrough(), { isTTY: true, columns: size.cols, rows: size.rows });
  const rawModes: boolean[] = [];
  const stdin = Object.assign(new PassThrough(), {
    isTTY: true,
    setRawMode(mode: boolean) {
      rawModes.push(mode);
      return this;
    },
  });
  let output = "";
  stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString("utf8");
  });
  const done = runApp({
    sessionId: null,
    stateDir: "/nonexistent/state",
    dataDir: "/nonexistent/data",
    themeFlag: "dark",
    bell: true,
    demo: true,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: new PassThrough() as unknown as NodeJS.WriteStream,
    env: {},
    clock: { now: () => FROZEN_NOW },
    timers: realTimers,
    ...overrides,
  });
  /** 从 from 起的输出还原成屏幕。 */
  const screen = async (from = 0, cols: number = stdout.columns, rows: number = stdout.rows): Promise<string[]> => {
    const term = new TermView({ cols, rows, scrollback: 0 });
    await term.write(output.slice(from));
    const lines = term.plainText().split("\n");
    term.dispose();
    return lines;
  };
  const until = async (condition: (lines: string[]) => boolean, what: string, from = 0, cols?: number): Promise<string[]> => {
    const deadline = Date.now() + 12_000;
    for (;;) {
      const lines = await screen(from, cols);
      if (condition(lines)) return lines;
      if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}\n${lines.join("\n")}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };
  return { stdin, stdout, rawModes, done, until, screen, output: () => output };
}

/** 一个看起来像 Copilot CLI 的进程（参数里有以 /copilot 结尾的路径），并在 session 目录里放它的锁文件：session 就算“有人开着”。 */
function openWithFakeCopilot(...sessionDirs: string[]) {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e6)", "/fake/bin/copilot"], { stdio: "ignore" });
  for (const sessionDir of sessionDirs) writeFileSync(join(sessionDir, `inuse.${child.pid}.lock`), "");
  return { pid: child.pid!, kill: () => child.kill("SIGKILL") };
}

/** 一个装好扩展、实验功能开着的 COPILOT_HOME：只读的原因就只会是“这个 session 没加载扩展”。 */
function copilotHomeWithExtension(root: string): string {
  const home = join(root, "copilot-home");
  mkdirSync(join(home, "extensions", "copilot-panes"), { recursive: true });
  writeFileSync(join(home, "extensions", "copilot-panes", "extension.mjs"), "// installed\n");
  writeFileSync(join(home, "settings.json"), JSON.stringify({ experimental: true }));
  return home;
}

const startDemo = (size?: { cols: number; rows: number }) => startApp({}, size);

test("--demo draws the first frame of the sample data, and q puts the terminal back", async () => {
  const app = startDemo();
  const lines = await app.until((screen) => screen[0]?.startsWith("webshop") ?? false, "the first frame");
  assert.deepEqual(lines, firstFrame(80));
  assert.ok(app.output().includes("\x1b[?1049h"), "enters the alternate screen");
  assert.ok(app.output().includes("\x1b[?1006h"), "turns the mouse on");
  assert.deepEqual(app.rawModes, [true]);

  app.stdin.write("q");
  assert.equal(await app.done, 0);
  const tail = app.output().slice(-200);
  assert.ok(tail.includes("\x1b[?1049l"), "leaves the alternate screen");
  assert.ok(tail.includes("\x1b[?1006l") && tail.includes("\x1b[?25h"), "mouse off, cursor back");
  assert.deepEqual(app.rawModes, [true, false]);
});

test("a narrower pane redraws the whole frame, and it is the 50-column frame", async () => {
  const app = startDemo();
  await app.until((screen) => screen[0]?.startsWith("webshop") ?? false, "the first frame");
  const mark = app.output().length;
  app.stdout.columns = 50;
  app.stdout.emit("resize");
  // 改尺寸后整屏重画：清屏之后的内容就是 50 列的一帧
  const clear = "\x1b[2J";
  while (!app.output().slice(mark).includes(clear)) await new Promise((resolve) => setTimeout(resolve, 10));
  await new Promise((resolve) => setTimeout(resolve, 100));
  const from = mark + app.output().slice(mark).lastIndexOf(clear);
  const narrow = await app.screen(from, 50, 22);
  assert.equal(narrow.length, 22);
  assert.deepEqual(narrow, firstFrame(50));
  app.stdin.write("q");
  await app.done;
});

test("keys: Enter moves into the content, a message to fix-login appears in its record, and Ctrl+C interrupts a command", async () => {
  const app = startDemo();
  await app.until((screen) => screen[0]?.startsWith("webshop") ?? false, "the first frame");

  app.stdin.write("\r");
  const inContent = await app.until((screen) => screen.some((line) => line.startsWith("┏━ fix-login")), "the heavy frame around the content");
  assert.ok(inContent.some((line) => line.startsWith("▌ ⠹ fix-login")), "the selected row stays marked");

  app.stdin.write("你好 hello");
  await app.until((screen) => screen.some((line) => line.includes("› 你好 hello")), "the typed text");
  app.stdin.write("\r");
  await app.until((screen) => screen.some((line) => line.includes("已发给 fix-login")), "the notice");
  await app.until((screen) => screen.some((line) => line.startsWith("┃ › 你好 hello")), "the message in the record");

  app.stdin.write("\x1b");
  await app.until((screen) => screen.some((line) => line.startsWith("┌─ fix-login")), "back to the list");
  app.stdin.write("jjjjj\r");
  const score = await app.until((screen) => screen.some((line) => line.startsWith("┃ [")), "score output");
  assert.ok(score.some((line) => line.includes("task_012")));
  app.stdin.write("\x03");
  const stopped = await app.until((screen) => screen.some((line) => line.includes("退出码 130")), "the interrupted command");
  assert.ok(stopped.some((line) => line.includes("已中断")));

  app.stdin.write("\x1b");
  await app.until((screen) => screen.some((line) => line.startsWith("┌─ $ python3")), "back to the list");
  app.stdin.write("q");
  assert.equal(await app.done, 0);
});

test("closing the help overlay brings back exactly the first frame", async () => {
  const app = startDemo();
  await app.until((screen) => screen[0]?.startsWith("webshop") ?? false, "the first frame");
  app.stdin.write("?");
  const help = await app.until((screen) => screen.some((line) => line.includes("这份说明")), "the help");
  assert.equal(help.length, 22);
  app.stdin.write("?");
  const back = await app.until((screen) => screen.some((line) => line.includes("fix-login")) && !screen.some((line) => line.includes("这份说明")), "back from help");
  assert.deepEqual(back, firstFrame(80));
  app.stdin.write("q");
  await app.done;
});

test("when stdout is not a terminal it explains and exits with 1 without writing escape codes", async () => {
  const stdout = Object.assign(new PassThrough(), { isTTY: false });
  const stderr = new PassThrough();
  let text = "";
  stderr.on("data", (chunk: Buffer) => {
    text += chunk.toString("utf8");
  });
  const code = await runApp({
    sessionId: null,
    stateDir: "/x",
    dataDir: "/y",
    themeFlag: null,
    bell: true,
    demo: true,
    stdin: new PassThrough() as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: stderr as unknown as NodeJS.WriteStream,
    env: {},
  });
  assert.equal(code, 1);
  assert.match(text, /标准输出不是终端/);
  assert.ok(!text.includes("\x1b"));
  assert.equal(stdout.read(), null);
});

test("a real session without the extension: the name from workspace.yaml, the list from events.jsonl, new events show up, and it is read-only", async () => {
  const dir = tempDir("rt-");
  let copilot: { kill: () => void } | undefined;
  try {
    const stateDir = join(dir.path, "state");
    mkdirSync(join(stateDir, "s1"), { recursive: true });
    writeFileSync(join(stateDir, "s1", "workspace.yaml"), "id: s1\ncwd: /work/proj\nname: 我的 session\n");
    copilot = openWithFakeCopilot(join(stateDir, "s1"));
    const eventsPath = join(stateDir, "s1", "events.jsonl");
    const started = (name: string, id: string, at: string) =>
      `${JSON.stringify({ type: "subagent.started", data: { toolCallId: `t_${id}`, agentDisplayName: name, agentType: "x", model: "provider/small-1.0" }, agentId: id, timestamp: at })}\n`;
    writeFileSync(eventsPath, started("first-agent", "a1", "2026-11-16T05:00:00.000Z"));
    const app = startApp({ demo: false, sessionId: "s1", stateDir, dataDir: join(dir.path, "data"), env: { COPILOT_HOME: copilotHomeWithExtension(dir.path) }, clock: undefined });
    const lines = await app.until((screen) => screen.some((line) => line.includes("first-agent")), "the first agent");
    assert.ok(lines.some((line) => line.includes("只读：这个 session 启动时还没装扩展。对它说“重新加载扩展”")), lines.join("\n"));

    appendFileSync(eventsPath, started("second-agent", "a2", "2026-11-16T05:00:05.000Z"));
    await app.until((screen) => screen.some((line) => line.includes("second-agent")), "the appended agent");

    // 文件被换成全新的内容：旧的子 agent 要消失
    rmSync(eventsPath);
    writeFileSync(eventsPath, started("third-agent", "a3", "2026-11-16T05:01:00.000Z"));
    const replaced = await app.until((screen) => screen.some((line) => line.includes("third-agent")) && !screen.some((line) => line.includes("first-agent")), "the replaced file");
    assert.ok(!replaced.some((line) => line.includes("second-agent")));

    app.stdin.write("x");
    await app.until((screen) => screen.some((line) => line.includes("只读，不能停止：这个 session 启动时还没装扩展")), "the read-only notice with its reason");
    app.stdin.write("q");
    assert.equal(await app.done, 0);
  } finally {
    copilot?.kill();
    dir.cleanup();
  }
});

test("--session accepts the first characters of an ID; one that matches nothing or several sessions exits with 2 and says why, before any screen", async () => {
  const dir = tempDir("rt-");
  try {
    const stateDir = join(dir.path, "state");
    const ids = ["ab010000-0000-4000-8000-000000000001", "ab020000-0000-4000-8000-000000000002"];
    for (const [i, id] of ids.entries()) {
      mkdirSync(join(stateDir, id), { recursive: true });
      writeFileSync(join(stateDir, id, "workspace.yaml"), `id: ${id}\ncwd: /work/proj\nname: 第${i + 1}个\n`);
      writeFileSync(
        join(stateDir, id, "events.jsonl"),
        `${JSON.stringify({ type: "subagent.started", data: { toolCallId: `t${i}`, agentDisplayName: `agent-of-${i + 1}`, agentType: "x" }, agentId: `a${i}`, timestamp: "2026-11-16T05:00:00.000Z" })}\n`,
      );
    }
    const base = { demo: false, stateDir, dataDir: join(dir.path, "data"), env: { COPILOT_HOME: copilotHomeWithExtension(dir.path) }, clock: undefined };

    const unique = startApp({ ...base, sessionId: "ab02" });
    await unique.until((screen) => screen.some((line) => line.includes("agent-of-2")) && !screen.some((line) => line.includes("agent-of-1")), "the session the prefix names");
    unique.stdin.write("q");
    assert.equal(await unique.done, 0);

    for (const [prefix, expected] of [
      ["ab", /^有 2 个 session 的 ID 以 ab 开头，请多写几位：\n  ab010000-0000-4000-8000-000000000001  第1个\n  ab020000-0000-4000-8000-000000000002  第2个\n$/],
      ["zz", /^没有 ID 以 zz 开头的 session\n$/],
    ] as const) {
      const stderr = new PassThrough();
      let text = "";
      stderr.on("data", (chunk: Buffer) => (text += chunk.toString("utf8")));
      const app = startApp({ ...base, sessionId: prefix, stderr: stderr as unknown as NodeJS.WriteStream });
      assert.equal(await app.done, 2, prefix);
      assert.match(text, expected);
      assert.equal(app.output(), "", "nothing was drawn");
    }
  } finally {
    dir.cleanup();
  }
});

test("the session that the Copilot CLI log says is in the foreground is shown, and a switch there is followed with a notice", async () => {
  const dir = tempDir("rt-");
  let copilot: { pid: number; kill: () => void } | undefined;
  try {
    const stateDir = join(dir.path, "state");
    const first = "11111111-1111-4111-8111-111111111111";
    const second = "22222222-2222-4222-8222-222222222222";
    const started = (name: string, id: string, at: string) =>
      `${JSON.stringify({ type: "subagent.started", data: { toolCallId: `t_${id}`, agentDisplayName: name, agentType: "x", model: "provider/small-1.0" }, agentId: id, timestamp: at })}\n`;
    for (const [id, title, agent] of [[first, "第一个", "agent-one"], [second, "第二个", "agent-two"]] as const) {
      mkdirSync(join(stateDir, id), { recursive: true });
      writeFileSync(join(stateDir, id, "workspace.yaml"), `id: ${id}\ncwd: ${process.cwd()}\nname: ${title}\n`);
      writeFileSync(join(stateDir, id, "events.jsonl"), started(agent, `a-${agent}`, "2026-11-16T05:00:00.000Z"));
    }
    copilot = openWithFakeCopilot(join(stateDir, first), join(stateDir, second));
    // 第一个 session 的事件更新（它在后台忙），但日志说用户正看着第二个
    const home = copilotHomeWithExtension(dir.path);
    mkdirSync(join(home, "logs"), { recursive: true });
    const log = join(home, "logs", `process-1-${copilot.pid}.log`);
    writeFileSync(log, `2026-11-16T13:00:00.000Z [INFO] Registering foreground session: ${second}\n`);
    appendFileSync(join(stateDir, first, "events.jsonl"), started("agent-busy", "a-busy", "2026-11-16T05:05:00.000Z"));

    const app = startApp({ demo: false, sessionId: null, stateDir, dataDir: join(dir.path, "data"), env: { COPILOT_HOME: home }, clock: undefined });
    await app.until((screen) => screen.some((line) => line.includes("agent-two")) && !screen.some((line) => line.includes("agent-busy")), "the foreground session");

    // 用户在 Copilot CLI 里切到第一个 session：不用等下一轮 5 秒的查找，界面跟过去并说一声
    appendFileSync(log, `2026-11-16T13:01:00.000Z [INFO] Unregistering foreground session: ${second}\n2026-11-16T13:01:00.001Z [INFO] Registering foreground session: ${first}\n`);
    const followed = await app.until((screen) => screen.some((line) => line.includes("agent-busy")), "the switch to the first session");
    assert.ok(followed.some((line) => line.includes("已切到「第一个」：左边切到了这个 session")), followed.join("\n"));
    app.stdin.write("q");
    assert.equal(await app.done, 0);
  } finally {
    copilot?.kill();
    dir.cleanup();
  }
});

test("when the Copilot CLI process is killed without session.shutdown, its running entries stop spinning and the screen says the session has ended", async () => {
  const dir = tempDir("rt-");
  let copilot: { kill: () => void } | undefined;
  try {
    const stateDir = join(dir.path, "state");
    mkdirSync(join(stateDir, "s1"), { recursive: true });
    writeFileSync(join(stateDir, "s1", "workspace.yaml"), "id: s1\ncwd: /work/proj\nname: 我的 session\n");
    copilot = openWithFakeCopilot(join(stateDir, "s1"));
    const event = (type: string, data: object, at: string, agentId?: string) => `${JSON.stringify({ type, data, ...(agentId ? { agentId } : {}), timestamp: at })}\n`;
    writeFileSync(
      join(stateDir, "s1", "events.jsonl"),
      event("subagent.started", { toolCallId: "t_a1", agentDisplayName: "worker", agentType: "x", model: "provider/small-1.0" }, "2026-11-16T05:00:00.000Z", "a1") +
        event("assistant.message", { content: "还在查" }, "2026-11-16T05:01:30.000Z", "a1"),
    );
    const app = startApp({ demo: false, sessionId: "s1", stateDir, dataDir: join(dir.path, "data"), clock: undefined });
    const alive = await app.until((screen) => screen.some((line) => line.includes("worker") && /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(line)), "the running worker");
    assert.ok((alive[0] ?? "").includes("1 个在跑"), alive[0] ?? "");

    copilot.kill();
    const ended = await app.until((screen) => (screen[0] ?? "").includes("session 已结束"), "the ended session");
    assert.ok(!(ended[0] ?? "").includes("个在跑"));
    const row = ended.find((line) => line.includes("worker"))!;
    assert.match(row, /◌ worker +small-1\.0 +1m30s .*已停$/);
    assert.ok(!/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(row));

    app.stdin.write("\r");
    await app.until((screen) => screen.some((line) => line.startsWith("┃ 这个 session 已经结束")), "the input line in the content focus");
    app.stdin.write("\x1b");
    await app.until((screen) => screen.some((line) => line.startsWith("┌─ worker")), "back to the list");
    await new Promise((resolve) => setTimeout(resolve, 80));
    app.stdin.write("q");
    assert.equal(await app.done, 0);
  } finally {
    copilot?.kill();
    dir.cleanup();
  }
});

test("discovery runs every 5 seconds, not every 2, while a live session is shown", async () => {
  const dir = tempDir("rt-");
  let copilot: { kill: () => void } | undefined;
  try {
    const stateDir = join(dir.path, "state");
    mkdirSync(join(stateDir, "s1"), { recursive: true });
    copilot = openWithFakeCopilot(join(stateDir, "s1"));
    writeFileSync(
      join(stateDir, "s1", "events.jsonl"),
      `${JSON.stringify({ type: "subagent.started", data: { toolCallId: "t_a1", agentDisplayName: "worker", agentType: "x" }, agentId: "a1", timestamp: "2026-11-16T05:00:00.000Z" })}\n`,
    );
    const delays: number[] = [];
    const timers: Timers = { ...realTimers, setTimeout: (fn, ms) => (delays.push(ms), realTimers.setTimeout(fn, ms)) };
    const app = startApp({ demo: false, sessionId: "s1", stateDir, dataDir: join(dir.path, "data"), clock: undefined, timers });
    await app.until((screen) => screen.some((line) => line.includes("worker")), "the worker");
    // 第一次找 session 在界面启动时做，找完之后排的下一次间隔取决于 session 活不活着
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(delays.includes(DISCOVER_STEADY_MS), `delays: ${delays.join(",")}`);
    assert.ok(!delays.includes(DISCOVER_FOLLOW_MS), `delays: ${delays.join(",")}`);
    app.stdin.write("q");
    assert.equal(await app.done, 0);
  } finally {
    copilot?.kill();
    dir.cleanup();
  }
});
