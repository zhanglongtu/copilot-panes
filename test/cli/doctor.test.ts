import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { checkUsage, formatDoctor, readAgentFacts, readAgentStarts, runDoctor } from "../../src/doctor.ts";
import type { DoctorCheck, DoctorOptions } from "../../src/doctor.ts";
import { registrationPath } from "../../src/paths.ts";
import { PROTOCOL_VERSION, REGISTRATION_VERSION, serializeRegistration } from "../../src/protocol.ts";
import { tempDir } from "../helpers/tmp.ts";

function setup() {
  const dir = tempDir("dr-");
  const home = join(dir.path, "home");
  const copilot = join(home, ".copilot");
  const dataDir = join(dir.path, "data");
  const stateDir = join(dir.path, "state");
  const bundled = join(dir.path, "extension.mjs");
  mkdirSync(copilot, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(bundled, "bundle v1\n");
  const options: DoctorOptions = {
    env: {},
    home,
    version: "1.2.3",
    dataDir,
    stateDir,
    bundledExtension: bundled,
    nodeVersion: "22.20.0",
    cwd: "/work/p",
    probeUsage: false,
  };
  const register = (sessionId: string, extra: { extensionVersion?: string; protocol?: number } = {}) => {
    mkdirSync(join(dataDir, "sessions"), { recursive: true });
    writeFileSync(
      registrationPath(dataDir, sessionId),
      serializeRegistration({
        v: REGISTRATION_VERSION,
        protocol: extra.protocol ?? PROTOCOL_VERSION,
        sessionId,
        copilotPid: process.pid,
        extensionPid: process.pid,
        tmuxPane: null,
        cwd: "/work/p",
        socketPath: join(dir.path, "x.sock"),
        extensionVersion: extra.extensionVersion ?? "1.2.3",
        startedAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
  };
  return { ...dir, options, copilot, register, installPath: join(copilot, "extensions", "copilot-panes", "extension.mjs") };
}

const byName = (checks: DoctorCheck[], name: string): DoctorCheck => {
  const found = checks.find((check) => check.name === name);
  assert.ok(found, `no check named ${name}: ${checks.map((c) => c.name).join(", ")}`);
  return found;
};

test("a fresh machine fails the experimental, extension and registration checks with a command to run", async () => {
  const t = setup();
  try {
    const checks = await runDoctor(t.options);
    assert.equal(byName(checks, "Node 版本").ok, true);
    assert.equal(byName(checks, "tmux").ok, false);
    assert.match(byName(checks, "实验功能").detail, /\/settings experimental on/);
    assert.match(byName(checks, "扩展").detail, /copilot-panes install/);
    assert.equal(byName(checks, "登记记录").ok, false);
    assert.match(byName(checks, "session").detail, /没找到/);
  } finally {
    t.cleanup();
  }
});

test("everything in place passes and the session choice is explained", async () => {
  const t = setup();
  try {
    writeFileSync(join(t.copilot, "settings.json"), JSON.stringify({ experimental: true }));
    mkdirSync(join(t.installPath, ".."), { recursive: true });
    writeFileSync(t.installPath, "bundle v1\n");
    t.register("abcdef123456");
    const checks = await runDoctor(t.options);
    assert.equal(byName(checks, "实验功能").ok, true);
    assert.equal(byName(checks, "扩展").ok, true);
    assert.equal(byName(checks, "扩展版本").ok, true);
    assert.match(byName(checks, "登记记录").detail, /1 条有效/);
    assert.equal(byName(checks, "扩展和界面的版本").ok, true);
    const session = byName(checks, "session");
    assert.equal(session.ok, true);
    assert.match(session.detail, /abcdef12/);
    assert.match(session.detail, /最近有动静（没有前台线索，也没人发过言）（候选范围：工作目录和这里相同）/);
  } finally {
    t.cleanup();
  }
});

test("a different installed extension, an old Node and a mismatched registration are reported", async () => {
  const t = setup();
  try {
    writeFileSync(join(t.copilot, "settings.json"), JSON.stringify({ experimental: false }));
    mkdirSync(join(t.installPath, ".."), { recursive: true });
    writeFileSync(t.installPath, "something else\n");
    t.register("s1", { extensionVersion: "0.0.1" });
    const checks = await runDoctor({ ...t.options, nodeVersion: "20.1.0" });
    assert.equal(byName(checks, "Node 版本").ok, false);
    assert.equal(byName(checks, "实验功能").ok, false);
    assert.match(byName(checks, "扩展版本").detail, /copilot-panes install/);
    assert.equal(byName(checks, "扩展和界面的版本").ok, false);
  } finally {
    t.cleanup();
  }
});

test("formatDoctor writes one line per check with ✓ or ✗", () => {
  const text = formatDoctor([
    { name: "a", ok: true, detail: "好" },
    { name: "b", ok: false, detail: "坏，运行 x" },
  ]);
  assert.equal(text, "✓ a：好\n✗ b：坏，运行 x");
});

const usageOf = (input: number, output: number, reported?: number) => ({ inputTokens: input, outputTokens: output, cacheReadTokens: 0, cacheWriteTokens: 0, calls: 1, ...(reported === undefined ? {} : { reportedTotalTokens: reported }) });

test("usage check: agents that finished before the extension loaded are not compared, and the line is a neutral sentence", () => {
  const usage = { a1: usageOf(0, 0, 409_000), a2: usageOf(0, 0, 493_000) };
  const starts = new Map([["a1", 1000], ["a2", 2000]]);
  const result = checkUsage(usage, starts, 5000);
  assert.deepEqual(result, { warn: false, detail: "正常。扩展是在这些子 agent 结束之后才加载的，token 的累加值没法核对" });
  assert.equal(checkUsage(usage, new Map(), 5000).warn, false, "no start time known: not compared either");
});

test("usage check: later agents are compared; agreement is reported, a real mismatch is a warning", () => {
  const starts = new Map([["old", 1000], ["a", 6000], ["b", 7000]]);
  const agree = checkUsage({ old: usageOf(0, 0, 409_000), a: usageOf(30_000, 8_000, 38_500), b: usageOf(1000, 500, 1500) }, starts, 5000);
  assert.deepEqual(agree, { warn: false, detail: "正常。2 个子 agent 的 token 累加值不比 Copilot CLI 报的 totalTokens 小（另有 1 个在扩展加载之前就开始了，累加值不全，没法核对）" });

  // 没有用量记录可对时只和 totalTokens 比：累加值更大是追加消息后多跑的几轮，不算不一致；比它小才算
  const more = checkUsage({ a: usageOf(60_000, 1_000, 38_500), b: usageOf(1000, 500, 1500) }, starts, 5000);
  assert.deepEqual(more.warn, false);
  const off = checkUsage({ a: usageOf(10_000, 0, 40_000), b: usageOf(1000, 500, 1500) }, starts, 5000);
  assert.equal(off.warn, true);
  assert.match(off.detail, /^扩展加载之后才开始的 2 个子 agent 里 1 个累加值比 totalTokens 小超过 5%（累加 1\.0万 \/ 事件 4\.0万）/);
  assert.equal(checkUsage({ a: usageOf(1, 1) }, starts, 5000).detail, "正常。有 1 个子 agent 的累加用量，还没有结束的可以核对 totalTokens");
});

test("usage check against the usage records in events.jsonl: rounds after the last completion and sub-agents below an agent are not mismatches", () => {
  const starts = new Map([["old", 1000], ["a", 6000], ["parent", 7000], ["bare", 8000]]);
  const usage = {
    old: usageOf(0, 0, 409_000),
    a: usageOf(60_000, 1_000, 48_000), // 完成之后又跑了一轮：累加值比 totalTokens 大
    parent: usageOf(500, 100, 9_000), // totalTokens 含下级，比自己的大
    bare: usageOf(1, 1, 2),
  };
  const events = new Map([["a", 61_000], ["parent", 600]]);
  const agree = checkUsage(usage, starts, 5000, events);
  assert.deepEqual(agree, { warn: false, detail: "正常。2 个子 agent 的 token 累加值和 events.jsonl 里的用量记录一致（追加消息后多跑的几轮两边都算）（另有 1 个在扩展加载之前就开始了，累加值不全，没法核对）" });

  const off = checkUsage({ ...usage, a: usageOf(10_000, 0, 48_000) }, starts, 5000, events);
  assert.equal(off.warn, true);
  assert.match(off.detail, /^扩展加载之后才开始的 2 个子 agent 里 1 个累加值和 events\.jsonl 里的用量记录差超过 5%（累加 1\.0万 \/ 用量记录 6\.1万）/);
  assert.match(checkUsage(usage, starts, 5000, new Map()).detail, /^正常。events\.jsonl 里没有这些子 agent 的用量记录/);
});

test("readAgentFacts gives each sub-agent's start time and the tokens its usage records add up to", () => {
  const t = setup();
  try {
    const dir = join(t.options.stateDir, "s1");
    mkdirSync(dir, { recursive: true });
    const line = (type: string, data: object, agentId: string, at: string) => JSON.stringify({ type, data, agentId, timestamp: at });
    writeFileSync(
      join(dir, "events.jsonl"),
      [
        line("subagent.started", { toolCallId: "t1", agentDisplayName: "a", agentType: "x" }, "a1", "2026-11-16T05:00:00.000Z"),
        line("subagent.started", { toolCallId: "t2", agentDisplayName: "b", agentType: "x" }, "a2", "2026-11-16T05:00:01.000Z"),
        line("session.usage_record", { usage: { inputTokens: 1000, outputTokens: 50, cacheReadTokens: 5 } }, "a1", "2026-11-16T05:00:02.000Z"),
      ].join("\n") + "\n",
    );
    const facts = readAgentFacts(t.options.stateDir, "s1");
    assert.deepEqual([...facts], [
      ["a1", { startedAt: Date.parse("2026-11-16T05:00:00.000Z"), eventTokens: 1050 }],
      ["a2", { startedAt: Date.parse("2026-11-16T05:00:01.000Z"), eventTokens: null }],
    ]);
    assert.deepEqual([...readAgentStarts(t.options.stateDir, "s1").values()], [Date.parse("2026-11-16T05:00:00.000Z"), Date.parse("2026-11-16T05:00:01.000Z")]);
    assert.equal(readAgentFacts(t.options.stateDir, "missing").size, 0);
  } finally {
    t.cleanup();
  }
});

test("a warning is written with ! and neither failures nor warnings are mixed up", () => {
  const text = formatDoctor([
    { name: "a", ok: true, detail: "好" },
    { name: "b", ok: true, warn: true, detail: "留意" },
    { name: "c", ok: false, detail: "坏" },
  ]);
  assert.equal(text, "✓ a：好\n! b：留意\n✗ c：坏");
});

test("readAgentStarts gives the start time of every sub-agent in the session's events", () => {
  const dir = tempDir("dr-");
  try {
    mkdirSync(join(dir.path, "s1"), { recursive: true });
    const started = (id: string, at: string) => JSON.stringify({ type: "subagent.started", data: { toolCallId: `t-${id}`, agentDisplayName: id, agentType: "x" }, agentId: id, timestamp: at });
    writeFileSync(join(dir.path, "s1", "events.jsonl"), `${started("a1", "2026-11-16T05:00:00.000Z")}\n${started("a2", "2026-11-16T05:01:00.000Z")}\n`);
    assert.deepEqual([...readAgentStarts(dir.path, "s1")], [["a1", Date.parse("2026-11-16T05:00:00.000Z")], ["a2", Date.parse("2026-11-16T05:01:00.000Z")]]);
    assert.equal(readAgentStarts(dir.path, "missing").size, 0);
  } finally {
    dir.cleanup();
  }
});

/** 一个看起来像 Copilot CLI 的进程，并在这些 session 目录里放它的锁文件：session 就算“有人开着”（没有登记记录）。 */
function fakeCopilot(sessionDirs: string[]) {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e6)", "/fake/bin/copilot"], { stdio: "ignore" });
  for (const dir of sessionDirs) writeFileSync(join(dir, `inuse.${child.pid}.lock`), "");
  return { pid: child.pid!, kill: () => child.kill("SIGKILL") };
}

function sessionDir(stateDir: string, id: string, name: string): string {
  const dir = join(stateDir, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "workspace.yaml"), `id: ${id}\ncwd: /work/p\nname: ${name}\n`);
  writeFileSync(join(dir, "events.jsonl"), "");
  return dir;
}

test("a session without a registration is explained with the same sentence the interface shows under the top line", async () => {
  const t = setup();
  const dirA = sessionDir(t.options.stateDir, "aaaaaaaa-1111-4111-8111-111111111111", "甲");
  const copilot = fakeCopilot([dirA]);
  try {
    // 扩展没装
    let checks = await runDoctor(t.options);
    assert.equal(byName(checks, "扩展 aaaaaaaa").ok, false);
    assert.match(byName(checks, "扩展 aaaaaaaa").detail, /^只读：还没装扩展。运行 copilot-panes install，再重启 Copilot CLI/);

    // 装了但实验功能没开
    mkdirSync(join(t.installPath, ".."), { recursive: true });
    writeFileSync(t.installPath, "bundle v1\n");
    checks = await runDoctor(t.options);
    assert.match(byName(checks, "扩展 aaaaaaaa").detail, /^只读：实验功能没开，扩展不会加载。运行 \/settings experimental on 后重启/);

    // 都满足：这个 session 启动时还没有扩展
    writeFileSync(join(t.copilot, "settings.json"), JSON.stringify({ experimental: true }));
    checks = await runDoctor(t.options);
    assert.match(byName(checks, "扩展 aaaaaaaa").detail, /^只读：这个 session 启动时还没装扩展。对它说“重新加载扩展”，或重启 Copilot CLI/);
    assert.match(byName(checks, "session").detail, /aaaaaaaa 甲（没有扩展登记/);
  } finally {
    copilot.kill();
    t.cleanup();
  }
});

test("doctor picks the session the Copilot CLI process log says is in the foreground, as the interface does", async () => {
  const t = setup();
  const idA = "aaaaaaaa-1111-4111-8111-111111111111";
  const idB = "bbbbbbbb-2222-4222-8222-222222222222";
  const dirA = sessionDir(t.options.stateDir, idA, "甲");
  const dirB = sessionDir(t.options.stateDir, idB, "乙");
  const copilot = fakeCopilot([dirA, dirB]);
  try {
    writeFileSync(join(dirA, "events.jsonl"), `${JSON.stringify({ type: "user.message", data: { content: "后发言" }, timestamp: "2026-11-16T13:00:00.000Z" })}\n`);
    const logs = join(t.copilot, "logs");
    mkdirSync(logs, { recursive: true });
    writeFileSync(join(logs, `process-1-${copilot.pid}.log`), `2026-11-16T13:01:00.000Z [INFO] Registering foreground session: ${idB}\n`);
    const withLog = await runDoctor(t.options);
    assert.match(byName(withLog, "session").detail, /会选 bbbbbbbb：Copilot CLI 现在正看着它，依据 Copilot CLI 进程日志/);

    writeFileSync(join(logs, `process-1-${copilot.pid}.log`), "nothing to see here\n");
    const withoutLog = await runDoctor(t.options);
    assert.match(byName(withoutLog, "session").detail, /会选 aaaaaaaa：你最近在它里面发过言（没有前台线索）/);
  } finally {
    copilot.kill();
    t.cleanup();
  }
});

test("a registered extension that speaks another protocol version is reported with the interface's sentence", async () => {
  const t = setup();
  const socketPath = join(t.path, "x.sock");
  const server = net.createServer((socket) => {
    socket.on("error", () => {});
    socket.write(JSON.stringify({ type: "hello", v: 99, sessionId: "s-version", copilotPid: process.pid, extensionPid: 1, extensionVersion: "x" }) + "\n");
  });
  try {
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    chmodSync(socketPath, 0o600);
    t.register("s-version");
    const checks = await runDoctor({ ...t.options, probeUsage: true });
    const connection = byName(checks, "扩展连接 s-versio");
    assert.equal(connection.ok, false);
    assert.equal(connection.detail, "只读：扩展和界面的版本不一致。运行 copilot-panes install，再重启 Copilot CLI");
  } finally {
    server.close();
    t.cleanup();
  }
});
