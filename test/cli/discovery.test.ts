// 找 session 的整条路：登记记录、跟随最新、s 键手选并固定、session 消失后留着最后的画面。
import assert from "node:assert/strict";
import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { registrationPath } from "../../src/paths.ts";
import { PROTOCOL_VERSION, REGISTRATION_VERSION, serializeRegistration } from "../../src/protocol.ts";
import { runApp } from "../../src/runtime.ts";
import { TermView } from "../../src/term/terminal.ts";
import { realTimers } from "../../src/types/clock.ts";
import { WAITING_TITLE } from "../../src/ui/views/waiting.ts";
import { tempDir } from "../helpers/tmp.ts";

const CWD = process.cwd();

test("it follows the newest session in the working directory, s picks another and pins it, and a vanished session leaves its last screen", async () => {
  const dir = tempDir("ds-");
  const stateDir = join(dir.path, "state");
  const dataDir = join(dir.path, "data");
  const register = (sessionId: string) => {
    mkdirSync(join(dataDir, "sessions"), { recursive: true });
    writeFileSync(
      registrationPath(dataDir, sessionId),
      serializeRegistration({
        v: REGISTRATION_VERSION,
        protocol: PROTOCOL_VERSION,
        sessionId,
        copilotPid: process.pid,
        extensionPid: process.pid,
        tmuxPane: null,
        cwd: CWD,
        socketPath: join(dir.path, `${sessionId}.sock`),
        extensionVersion: "0.0.0",
        startedAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
  };
  const makeSession = (sessionId: string, title: string, agent: string, ageSeconds: number) => {
    mkdirSync(join(stateDir, sessionId), { recursive: true });
    writeFileSync(join(stateDir, sessionId, "workspace.yaml"), `id: ${sessionId}\ncwd: ${CWD}\nname: ${title}\n`);
    const events = join(stateDir, sessionId, "events.jsonl");
    const at = new Date(Date.now() - ageSeconds * 1000);
    writeFileSync(
      events,
      `${JSON.stringify({ type: "subagent.started", data: { toolCallId: `t_${agent}`, agentDisplayName: agent, agentType: "x" }, agentId: agent, timestamp: at.toISOString() })}\n`,
    );
    utimesSync(events, at, at);
    register(sessionId);
  };
  makeSession("older", "旧的", "agent-old", 60);
  makeSession("newer", "新的", "agent-new", 5);

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
    const deadline = Date.now() + 15_000;
    for (;;) {
      const lines = await screen();
      if (condition(lines)) return lines;
      if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}\n${lines.join("\n")}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };
  const done = runApp({
    sessionId: null,
    stateDir,
    dataDir,
    themeFlag: "dark",
    bell: true,
    demo: false,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: new PassThrough() as unknown as NodeJS.WriteStream,
    env: { COPILOT_HOME: join(dir.path, "copilot-home") },
    timers: realTimers,
  });
  try {
    await until((rows) => rows.some((row) => row.includes("agent-new")), "the newest session");
    stdin.write("s");
    const list = await until((rows) => rows.some((row) => row.includes("选择 session")), "the picker");
    assert.ok(list.some((row) => row.includes("新的")) && list.some((row) => row.includes("旧的")), list.join("\n"));
    assert.ok(list.some((row) => row.includes("恢复自动选择")));

    // 选中旧的并固定：即使新的更新，也不换回去
    stdin.write("j");
    stdin.write("\r");
    const pinned = await until((rows) => rows.some((row) => row.includes("agent-old")), "the pinned session");
    assert.match(pinned[0] ?? "", /旧的/);
    await new Promise((resolve) => setTimeout(resolve, 2300));
    const stillPinned = await screen();
    assert.ok(stillPinned.some((row) => row.includes("agent-old")), "stays on the pinned session");

    // 固定的 session 结束（登记记录没了）：不会回到等待画面，要么留着要么换到还在的那个
    rmSync(registrationPath(dataDir, "older"));
    await new Promise((resolve) => setTimeout(resolve, 2300));
    const after = await screen();
    assert.ok(after.some((row) => row.includes("agent-old")) || after.some((row) => row.includes("agent-new")), after.join("\n"));
    assert.ok(!after.some((row) => row.includes(WAITING_TITLE)), "no waiting screen while a session is still shown");
  } finally {
    stdin.write("q");
    await Promise.race([done, new Promise((resolve) => setTimeout(resolve, 2000))]);
    dir.cleanup();
  }
});

test("with no session it shows the waiting screen, and attaches by itself when one appears", async () => {
  const dir = tempDir("dw-");
  const stateDir = join(dir.path, "state");
  const dataDir = join(dir.path, "data");
  mkdirSync(stateDir, { recursive: true });
  const stdout = Object.assign(new PassThrough(), { isTTY: true, columns: 80, rows: 22 });
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => stdin });
  let output = "";
  stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString("utf8");
  });
  const screen = async (): Promise<string> => {
    const term = new TermView({ cols: 80, rows: 22, scrollback: 0 });
    await term.write(output);
    const text = term.plainText();
    term.dispose();
    return text;
  };
  const until = async (condition: (text: string) => boolean, what: string): Promise<string> => {
    const deadline = Date.now() + 15_000;
    for (;;) {
      const text = await screen();
      if (condition(text)) return text;
      if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}\n${text}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };
  const done = runApp({
    sessionId: null,
    stateDir,
    dataDir,
    themeFlag: "dark",
    bell: true,
    demo: false,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: new PassThrough() as unknown as NodeJS.WriteStream,
    env: { COPILOT_HOME: join(dir.path, "copilot-home") },
    timers: realTimers,
  });
  try {
    await until((text) => text.includes("还没有 Copilot CLI"), "the waiting screen");
    mkdirSync(join(stateDir, "late"), { recursive: true });
    writeFileSync(join(stateDir, "late", "workspace.yaml"), `id: late\ncwd: ${CWD}\nname: 后来的\n`);
    writeFileSync(
      join(stateDir, "late", "events.jsonl"),
      `${JSON.stringify({ type: "subagent.started", data: { toolCallId: "t1", agentDisplayName: "late-agent", agentType: "x" }, agentId: "a1", timestamp: new Date().toISOString() })}\n`,
    );
    mkdirSync(join(dataDir, "sessions"), { recursive: true });
    writeFileSync(
      registrationPath(dataDir, "late"),
      serializeRegistration({
        v: REGISTRATION_VERSION,
        protocol: PROTOCOL_VERSION,
        sessionId: "late",
        copilotPid: process.pid,
        extensionPid: process.pid,
        tmuxPane: null,
        cwd: CWD,
        socketPath: join(dir.path, "late.sock"),
        extensionVersion: "0.0.0",
        startedAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
    const text = await until((t) => t.includes("late-agent"), "the session that appeared");
    assert.ok(!text.includes("还没有 Copilot CLI"));
  } finally {
    stdin.write("q");
    await Promise.race([done, new Promise((resolve) => setTimeout(resolve, 2000))]);
    dir.cleanup();
  }
});
