import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { locateSelf, readWorkspace, resolveSessionArg, scanCandidates } from "../../src/discover/candidates.ts";
import type { ProcInfo } from "../../src/discover/procs.ts";
import { sessionsDir } from "../../src/paths.ts";
import { serializeRegistration } from "../../src/protocol.ts";
import type { Registration } from "../../src/protocol.ts";
import { tempDir } from "../helpers/tmp.ts";
import { registration } from "./helpers.ts";

const NOW = 1_700_000_000_000;

interface SessionFiles {
  workspace?: string;
  eventsAt?: number;
  locks?: number[];
}

function makeSession(stateDir: string, id: string, files: SessionFiles = {}): void {
  const dir = join(stateDir, id);
  mkdirSync(dir, { recursive: true });
  if (files.workspace !== undefined) writeFileSync(join(dir, "workspace.yaml"), files.workspace);
  if (files.eventsAt !== undefined) {
    writeFileSync(join(dir, "events.jsonl"), "");
    utimesSync(join(dir, "events.jsonl"), new Date(files.eventsAt), new Date(files.eventsAt));
  }
  for (const pid of files.locks ?? []) writeFileSync(join(dir, `inuse.${pid}.lock`), String(pid));
}

function putRegistration(dataDir: string, r: Registration): void {
  mkdirSync(sessionsDir(dataDir), { recursive: true });
  writeFileSync(join(sessionsDir(dataDir), `${r.sessionId}.json`), serializeRegistration(r));
}

const proc = (pid: number, over: Partial<ProcInfo> = {}): ProcInfo => ({ pid, ppid: 1, pgid: pid, startTicks: 1, comm: "bash", argv: ["bash"], ...over });
const copilotProc = (pid: number, ppid = 1): ProcInfo =>
  proc(pid, { ppid, comm: "MainThread", argv: ["/usr/local/lib/node_modules/@github/copilot/node_modules/@github/copilot-linux-x64/copilot", "--resume"] });
const table = (...procs: ProcInfo[]) => new Map(procs.map((p) => [p.pid, p]));

test("readWorkspace takes only the top-level cwd and name lines and strips quotes", () => {
  const dir = tempDir("w");
  try {
    makeSession(dir.path, "plain", { workspace: "id: plain\ncwd: /home/u/proj\ngit_root: /home/u/proj\nname: 给商品页加搜索框\nuser_named: false\n" });
    assert.deepEqual(readWorkspace(dir.path, "plain"), { cwd: "/home/u/proj", name: "给商品页加搜索框" });
    makeSession(dir.path, "quoted", { workspace: 'cwd: "/home/u/with space"\r\nname:   \'Fix: the "bug"\'  \r\n' });
    assert.deepEqual(readWorkspace(dir.path, "quoted"), { cwd: "/home/u/with space", name: 'Fix: the "bug"' });
    makeSession(dir.path, "nested", { workspace: "meta:\n  cwd: /nested\n  name: nested\nname: \n" });
    assert.deepEqual(readWorkspace(dir.path, "nested"), { cwd: null, name: null });
    // 名字里的终端控制码（这里是真的 ESC 字节）要去掉：关鼠标上报、切换备用屏幕、改标题的序列原样打出去会改用户的终端
    makeSession(dir.path, "evil", { workspace: "cwd: /w\u001b]0;pwned\u0007/x\nname: a\u001b[?1000lb\u001b[?1049l\u0007c\u202ed\n" });
    assert.deepEqual(readWorkspace(dir.path, "evil"), { cwd: "/w/x", name: "abcd" });
    makeSession(dir.path, "nofile");
    assert.deepEqual(readWorkspace(dir.path, "nofile"), { cwd: null, name: null });
    assert.deepEqual(readWorkspace(dir.path, "nodir"), { cwd: null, name: null });
  } finally {
    dir.cleanup();
  }
});

test("live registrations become candidates with cwd and title from workspace.yaml", () => {
  const dataDir = tempDir("d");
  const stateDir = tempDir("s");
  try {
    makeSession(stateDir.path, "live", { workspace: "cwd: /work/app\nname: Fix login\n", eventsAt: NOW - 3000 });
    putRegistration(dataDir.path, registration("live", { copilotPid: 4000, tmuxPane: "%3", cwd: "/ext/cwd", updatedAt: NOW - 1000 }));
    makeSession(stateDir.path, "stale-heartbeat", { workspace: "cwd: /work/app\n", eventsAt: NOW });
    putRegistration(dataDir.path, registration("stale-heartbeat", { copilotPid: 4000, updatedAt: NOW - 20_001 }));
    makeSession(stateDir.path, "dead-process", { workspace: "cwd: /work/app\n", eventsAt: NOW });
    putRegistration(dataDir.path, registration("dead-process", { copilotPid: 4999, updatedAt: NOW }));
    makeSession(stateDir.path, "no-workspace", { eventsAt: NOW - 8000 });
    putRegistration(dataDir.path, registration("no-workspace", { copilotPid: 4000, tmuxPane: null, cwd: "/ext/cwd", updatedAt: NOW }));
    putRegistration(dataDir.path, registration("no-session-dir", { copilotPid: 4000, cwd: "", updatedAt: NOW }));

    const candidates = scanCandidates({
      dataDir: dataDir.path,
      stateDir: stateDir.path,
      now: NOW,
      isPidAlive: (pid) => pid === 4000,
      procTable: new Map(),
    });
    assert.deepEqual(
      candidates.map((c) => [c.sessionId, c.source, c.copilotPid, c.tmuxPane, c.cwd, c.title, c.lastEventAt]),
      [
        ["live", "registration", 4000, "%3", "/work/app", "Fix login", NOW - 3000],
        ["no-workspace", "registration", 4000, null, "/ext/cwd", null, NOW - 8000],
        ["no-session-dir", "registration", 4000, "%3", null, null, 0],
      ],
    );
    assert.equal(candidates[0]?.registration?.sessionId, "live");
  } finally {
    dataDir.cleanup();
    stateDir.cleanup();
  }
});

test("without a registration a live copilot pid in inuse.<pid>.lock makes a lock candidate", () => {
  const dataDir = tempDir("d");
  const stateDir = tempDir("s");
  try {
    makeSession(stateDir.path, "locked", { workspace: "cwd: /work/app\nname: Locked\n", eventsAt: NOW - 1000, locks: [5000] });
    makeSession(stateDir.path, "not-copilot", { workspace: "cwd: /work/app\n", eventsAt: NOW, locks: [5001] });
    makeSession(stateDir.path, "dead", { workspace: "cwd: /work/app\n", eventsAt: NOW, locks: [5002] });
    makeSession(stateDir.path, "stale-and-live", { workspace: "cwd: /work/other\n", eventsAt: NOW - 5000, locks: [5003, 5000] });
    makeSession(stateDir.path, "no-lock", { workspace: "cwd: /work/app\n", eventsAt: NOW });
    makeSession(stateDir.path, "registered", { workspace: "cwd: /work/app\n", eventsAt: NOW - 2000, locks: [5000] });
    putRegistration(dataDir.path, registration("registered", { copilotPid: 5000, tmuxPane: "%7", updatedAt: NOW }));
    writeFileSync(join(stateDir.path, "stray-file.txt"), "not a session");

    const alive = new Set([5000, 5001, 5003]);
    const candidates = scanCandidates({
      dataDir: dataDir.path,
      stateDir: stateDir.path,
      now: NOW,
      isPidAlive: (pid) => alive.has(pid),
      procTable: table(copilotProc(5000), proc(5001, { comm: "python", argv: ["python", "x.py"] }), proc(5003, { comm: "bash" })),
    });
    assert.deepEqual(
      candidates.map((c) => [c.sessionId, c.source, c.copilotPid, c.tmuxPane, c.cwd, c.title, c.lastEventAt]),
      [
        ["locked", "lock", 5000, null, "/work/app", "Locked", NOW - 1000],
        ["registered", "registration", 5000, "%7", "/work/app", null, NOW - 2000],
        ["stale-and-live", "lock", 5000, null, "/work/other", null, NOW - 5000],
      ],
    );
    assert.equal(candidates[0]?.registration, null);
  } finally {
    dataDir.cleanup();
    stateDir.cleanup();
  }
});

test("missing data and state directories give no candidates", () => {
  const dir = tempDir("d");
  try {
    assert.deepEqual(scanCandidates({ dataDir: join(dir.path, "a"), stateDir: join(dir.path, "b"), now: NOW, isPidAlive: () => true, procTable: new Map() }), []);
  } finally {
    dir.cleanup();
  }
});

test("locateSelf finds Copilot CLI processes under the other panes of the window", async () => {
  // 窗口里三个 pane：%1 是界面自己，%2 里 shell → node 包装 → copilot 本体 → 扩展进程，%3 里是 vim
  const procTable = table(
    proc(1000, { comm: "bash" }),
    proc(2000, { comm: "bash" }),
    proc(2010, { ppid: 2000, comm: "node", argv: ["node", "/usr/local/bin/copilot"] }),
    copilotProc(2020, 2010),
    copilotProc(2030, 2020),
    proc(2040, { ppid: 2020, comm: "sh", argv: ["sh", "-c", "sleep 100"] }),
    proc(3000, { comm: "bash" }),
    proc(3010, { ppid: 3000, comm: "vim", argv: ["vim", "notes.md"] }),
    copilotProc(9000), // 别的窗口里的
  );
  const calls: string[][] = [];
  const run = async (args: readonly string[]) => {
    calls.push([...args]);
    return "%1 1000 @5\n%2 2000 @5\n%3 3000 @5\n";
  };
  const located = await locateSelf({ cwd: "/work/app", tmuxPane: "%1", run, procTable });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.[2], "%1");
  assert.equal(located.cwd, "/work/app");
  assert.equal(located.tmux?.paneId, "%1");
  assert.deepEqual(located.tmux?.windowPanes, ["%2", "%3"]);
  assert.deepEqual([...(located.tmux?.windowCopilotPids ?? [])].sort((a, b) => a - b), [2010, 2020, 2030]);
});

test("locateSelf outside tmux, or when tmux fails, reports no tmux", async () => {
  const procTable = table(copilotProc(2020));
  let called = false;
  const never = async () => {
    called = true;
    return "";
  };
  assert.deepEqual(await locateSelf({ cwd: "/w", tmuxPane: null, run: never, procTable }), { cwd: "/w", tmux: null });
  assert.equal(called, false);
  assert.deepEqual(await locateSelf({ cwd: "/w", tmuxPane: "%1", run: () => Promise.reject(new Error("no server")), procTable }), { cwd: "/w", tmux: null });
  assert.deepEqual(await locateSelf({ cwd: "/w", tmuxPane: "%1", run: async () => "nonsense\n", procTable }), { cwd: "/w", tmux: null });
});

test("--session may be the first characters of an ID: one match is used, several are listed with their titles, none is an error", () => {
  const dir = tempDir("rs-");
  try {
    const a = "d4a81b6c-9a27-4c53-a0f8-3b6e5d172c94";
    const b = "d4ee0001-0000-4000-8000-000000000001";
    const c = "6b92f0a7-3d18-4e45-b7c1-8a4d2e05f963";
    makeSession(dir.path, a, { workspace: "id: x\nname: 修登录失败\n" });
    makeSession(dir.path, b, { workspace: "id: y\nname: 另一个\n" });
    makeSession(dir.path, c);
    assert.deepEqual(resolveSessionArg(dir.path, "d4a8"), { ok: true, sessionId: a });
    assert.deepEqual(resolveSessionArg(dir.path, "D4A81B6C"), { ok: true, sessionId: a }, "case does not matter");
    assert.deepEqual(resolveSessionArg(dir.path, "6b92"), { ok: true, sessionId: c });

    const several = resolveSessionArg(dir.path, "d4");
    assert.equal(several.ok, false);
    assert.equal(
      !several.ok && several.error,
      `有 2 个 session 的 ID 以 d4 开头，请多写几位：\n  ${a}  修登录失败\n  ${b}  另一个`,
    );
    assert.deepEqual(resolveSessionArg(dir.path, "zzzz"), { ok: false, error: "没有 ID 以 zzzz 开头的 session" });
    assert.deepEqual(resolveSessionArg(dir.path, "../"), { ok: false, error: "没有 ID 以 ../ 开头的 session" });
    // 同名目录或完整的 ID 原样用，不管在不在
    makeSession(dir.path, "s1");
    assert.deepEqual(resolveSessionArg(dir.path, "s1"), { ok: true, sessionId: "s1" });
    assert.deepEqual(resolveSessionArg(dir.path, "11111111-2222-4333-8444-555555555555"), { ok: true, sessionId: "11111111-2222-4333-8444-555555555555" });
    assert.deepEqual(resolveSessionArg(join(dir.path, "missing"), "abc"), { ok: false, error: "没有 ID 以 abc 开头的 session" });
  } finally {
    dir.cleanup();
  }
});
