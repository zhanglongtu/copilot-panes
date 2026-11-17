// 从扩展到界面的整条路：真的扩展（startPanes，假的 Copilot SDK 会话）写登记记录、开 socket、存命令输出；
// 真的界面按登记记录找到 session、连 socket、读 events.jsonl 和 .out，用户在界面里发消息，扩展收到。
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { startPanes } from "../../extension/src/main.ts";
import { runApp } from "../../src/runtime.ts";
import { TermView } from "../../src/term/terminal.ts";
import { realTimers } from "../../src/types/clock.ts";
import { bashStart, FakeSession, FakeTime, shellOutput } from "../extension/fake.ts";
import { tempDir } from "../helpers/tmp.ts";

test("the interface finds the session through the extension's registration, shows its output, and a message reaches the extension", async () => {
  const dir = tempDir("fs-");
  const time = new FakeTime(Date.now());
  const session = new FakeSession("s1");
  const dataDir = join(dir.path, "data");
  const stateDir = join(dir.path, "state");
  const startedAt = new Date().toISOString();
  session.tasks = [
    { type: "agent", id: "a1", toolCallId: "t_a1", displayName: "worker", description: "worker", status: "running", startedAt, agentType: "x", prompt: "", executionMode: "background" },
  ];
  const handle = await startPanes(session, {
    dataDir,
    socketOptions: { runtimeDir: dir.path, tmpDir: dir.path, uid: process.getuid?.() ?? 1000 },
    clock: time,
    timers: time,
    pid: 4243,
    copilotPid: process.pid,
    tmuxPane: null,
    cwd: "/work/p",
    version: "0.0.0",
    isPidAlive: (pid) => pid === process.pid,
    logError: () => {},
  });
  // 扩展先于界面看到命令，所以 .out 里已经有输出
  session.emit(bashStart("c1", "echo hello", { mode: "async", shellId: "sh1" }));
  session.emit(shellOutput("c1", 0, "hello from the extension\n"));

  const sessionDir = join(stateDir, "s1");
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(join(sessionDir, "workspace.yaml"), "id: s1\ncwd: /work/p\nname: 全链路\n");
  const event = (type: string, data: object, at: string, agentId?: string) => `${JSON.stringify({ type, data, ...(agentId ? { agentId } : {}), timestamp: at })}\n`;
  const t0 = new Date(Date.now() - 20_000).toISOString();
  const t1 = new Date(Date.now() - 10_000).toISOString();
  writeFileSync(
    join(sessionDir, "events.jsonl"),
    event("session.start", { sessionId: "s1", context: { cwd: "/work/p" } }, t0) +
      event("subagent.started", { toolCallId: "t_a1", agentDisplayName: "worker", agentType: "x", model: "provider/small-1.0", executionMode: "background" }, t0, "a1") +
      event("tool.execution_start", { toolCallId: "c1", toolName: "bash", arguments: { command: "echo hello", mode: "async", shellId: "sh1" } }, t1),
  );

  const stdout = Object.assign(new PassThrough(), { isTTY: true, columns: 80, rows: 22 });
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => stdin });
  let output = "";
  stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString("utf8");
  });
  const screen = async (): Promise<string[]> => {
    const term = new TermView({ cols: 80, rows: 22, scrollback: 0 });
    await term.write(output);
    const lines = term.plainText().split("\n");
    term.dispose();
    return lines;
  };
  const until = async (condition: (lines: string[]) => boolean, what: string): Promise<string[]> => {
    const deadline = Date.now() + 12_000;
    for (;;) {
      const lines = await screen();
      if (condition(lines)) return lines;
      if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}\n${lines.join("\n")}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };

  const done = runApp({
    sessionId: "s1",
    stateDir,
    dataDir,
    themeFlag: "dark",
    bell: true,
    demo: false,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: new PassThrough() as unknown as NodeJS.WriteStream,
    env: {},
    timers: realTimers,
  });
  try {
    // 连上扩展：顶行没有“只读”；最新的条目（命令）被跟随选中，内容区是扩展存下来的输出
    const lines = await until((rows) => rows.some((row) => row.includes("hello from the extension")) && !(rows[0] ?? "").includes("只读"), "the command output and the connection");
    assert.match(lines[0] ?? "", /^p {2}› {2}全链路/);
    assert.ok(!(lines[0] ?? "").includes("只读"), lines[0] ?? "");
    assert.ok(lines.some((row) => row.includes("worker")));

    // 往上选到子 agent，进内容区发一条消息
    stdin.write("k");
    await until((rows) => rows.some((row) => row.startsWith("▌ ") && row.includes("worker")), "worker selected");
    stdin.write("\r");
    await until((rows) => rows.some((row) => row.includes("给 worker 发消息") || row.includes("插一句话给 worker")), "the input line");
    stdin.write("你好");
    await until((rows) => rows.some((row) => row.includes("› 你好")), "the typed text");
    stdin.write("\r");
    await until((rows) => rows.some((row) => row.includes("已发给 worker")), "the sent notice");
    assert.equal(session.callsOf("sendMessage").length, 1);
    assert.match(JSON.stringify(session.callsOf("sendMessage")[0]), /a1.*你好|你好.*a1/);
  } finally {
    stdin.write("\x1b");
    await new Promise((resolve) => setTimeout(resolve, 80));
    stdin.write("q");
    await done;
    await handle.stop();
    dir.cleanup();
  }
});
