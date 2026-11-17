// 手工样本和生成的虚构日志：样本的说明写在 test/fixtures/events/README.md 里。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parseEventLine, parseTimestamp } from "../../src/model/events.ts";
import { agentElapsedMs, buildList } from "../../src/model/merge.ts";
import { SessionStore } from "../../src/model/store.ts";
import type { TaskInfo } from "../../src/protocol.ts";
import type { AgentRecord, CommandRecord, EndItem, EntryKey } from "../../src/types/model.ts";
import { REPO_ROOT, tempDir } from "../helpers/tmp.ts";

const DIR = join(REPO_ROOT, "test", "fixtures", "events");

function fixtureLines(name: string): string[] {
  return readFileSync(join(DIR, name), "utf8").split("\n").filter(Boolean);
}

function load(name: string): SessionStore {
  const store = new SessionStore("fixture");
  for (const line of fixtureLines(name)) store.feedLine(line);
  return store;
}

const byName = (store: SessionStore, name: string): AgentRecord => {
  const agent = store.agents().find((a) => a.name === name);
  assert.ok(agent, name);
  return agent;
};

const byCommand = (store: SessionStore, command: string): CommandRecord => {
  const found = store.commands().find((c) => c.command === command);
  assert.ok(found, command);
  return found;
};

const AFTER = Date.parse("2026-11-16T06:00:00.000Z");

test("subagent-sync-completed: done, 2 tool calls, 38120 tokens, 12.0 seconds", () => {
  const store = load("subagent-sync-completed.jsonl");
  const agent = byName(store, "scan-files");
  assert.deepEqual([agent.status, agent.toolCalls, agent.totalTokens, agentElapsedMs(agent, AFTER), agent.executionMode, agent.parentId], ["done", 2, 38_120, 12_000, "sync", null]);
  assert.equal(agent.lastReply, "扫描完成：共 2 个文件。");
  assert.equal(store.mainModel, "provider/large-1.0");
  assert.equal(store.cwd, "/work/demo");
});

test("subagent-nested: the parent follows the agent that made the task call, not data.parentId", () => {
  const store = load("subagent-nested.jsonl");
  const writer = byName(store, "writer");
  const checker = byName(store, "checker");
  assert.deepEqual([writer.status, checker.status, writer.parentId, checker.parentId], ["done", "done", null, writer.id]);
  const list = buildList({ store, tasks: null, usage: null, now: AFTER, collapseEnded: false, keep: new Set<EntryKey>(), lastOutputLine: () => "" });
  assert.deepEqual(
    list.map((e) => [e.name, e.depth, e.parentKey]),
    [
      ["writer", 0, null],
      ["checker", 1, `agent:${writer.id}`],
    ],
  );
});

test("subagent-failed: failed after 5.0 seconds, the multi-line error on one line", () => {
  const store = load("subagent-failed.jsonl");
  const agent = byName(store, "flaky");
  assert.deepEqual([agent.status, agent.error, agentElapsedMs(agent, AFTER)], ["failed", "模型超时 重试失败", 5000]);
});

test("subagent-multi-turn: done, running, done, 30.0 seconds in all, the first agent_idle is ignored", () => {
  const store = new SessionStore("fixture");
  const seen: string[] = [];
  for (const line of fixtureLines("subagent-multi-turn.jsonl")) {
    store.feedLine(line);
    const agent = store.agents()[0];
    if (agent && seen[seen.length - 1] !== agent.status) seen.push(agent.status);
  }
  assert.deepEqual(seen, ["running", "done", "running", "done"]);
  const agent = byName(store, "helper");
  assert.equal(agentElapsedMs(agent, AFTER), 30_000);
  const ends = store.transcript(agent.id).filter((item): item is EndItem => item.kind === "end");
  assert.deepEqual(
    ends.map((item) => [item.status, item.durationMs]),
    [
      ["done", 10_000],
      ["done", 30_000],
    ],
  );
  assert.deepEqual(
    store.transcript(agent.id).map((item) => item.kind),
    ["task", "say", "tool", "end", "message", "resume", "say", "end"],
  );
});

test("subagent-cancelled: both agents are stopped", () => {
  const store = load("subagent-cancelled.jsonl");
  assert.deepEqual([byName(store, "cancel-flag").status, byName(store, "cancel-abort").status], ["stopped", "stopped"]);
});

test("bash-async-read-stop: int-test failed with 130 and was kept, 6 output lines; tail-log stopped without a code", () => {
  const store = load("bash-async-read-stop.jsonl");
  const intTest = byCommand(store, store.commands()[0]?.command ?? "");
  assert.deepEqual([intTest.shellId, intTest.background, intTest.status, intTest.exitCode, intTest.keptAsFailed], ["int-test", true, "failed", 130, true]);
  assert.equal(intTest.eventOutput, "tick 1\ntick 2\ntick 3\ntick 4\ntick 5\ngot-INT\n");
  const tail = byCommand(store, "tail -f app.log");
  assert.deepEqual([tail.status, tail.exitCode, tail.keptAsFailed, tail.endReason, tail.eventOutput], ["stopped", null, false, "stopped", "line 1\nline 2\n"]);
});

test("bash-detach: gw ends by shell_detached_completed without a code, job by read_bash with exit code 0", () => {
  const store = load("bash-detach.jsonl");
  const gw = byCommand(store, "python3 server.py --port 8000");
  const job = byCommand(store, "python3 job.py");
  assert.deepEqual([gw.detach, gw.status, gw.exitCode, gw.keptAsFailed], [true, "done", null, false]);
  assert.deepEqual([job.detach, job.status, job.exitCode, job.eventOutput], [true, "done", 0, "out 1\n"]);
});

test("bash-sync-completed: make build ran 3 seconds with exit code 0 and is not kept", () => {
  const store = load("bash-sync-completed.jsonl");
  const build = byCommand(store, "make build");
  assert.deepEqual([build.status, build.exitCode, build.promoted, build.keptAsFailed, (build.endedAt ?? 0) - build.startedAt, build.eventOutput], ["done", 0, false, false, 3000, "building\nok"]);
});

test("bash-sync-failed: only make test (2.0 seconds, exit code 2) is kept, grep x y (1.9 seconds) is not", () => {
  const store = load("bash-sync-failed.jsonl");
  const make = byCommand(store, "make test");
  const grep = byCommand(store, "grep x y");
  assert.deepEqual([make.status, make.exitCode, make.keptAsFailed, (make.endedAt ?? 0) - make.startedAt], ["failed", 2, true, 2000]);
  assert.deepEqual([grep.status, grep.exitCode, grep.keptAsFailed, (grep.endedAt ?? 0) - grep.startedAt], ["failed", 1, false, 1900]);
});

test("bash-sync-promoted-to-background: the 30 second timeout moves it to the background, stop_bash stops it", () => {
  const store = load("bash-sync-promoted-to-background.jsonl");
  const sleep = byCommand(store, "sleep 500");
  assert.deepEqual([sleep.promoted, sleep.background, sleep.shellId, sleep.status, sleep.endReason, sleep.exitCode], [true, true, "7", "stopped", "stopped", null]);
});

test("subagent-with-bash: builder's two commands and main's one are told apart, and the background one is dropped with its agent", () => {
  const store = load("subagent-with-bash.jsonl");
  const builder = byName(store, "builder");
  const watch = byCommand(store, "sleep 60");
  const ls = byCommand(store, "ls -l");
  const echo = byCommand(store, "echo main");
  assert.deepEqual([watch.agentId, ls.agentId, echo.agentId], [builder.id, builder.id, null]);
  assert.deepEqual([watch.status, watch.endReason], ["stopped", "agent-ended"]);
  assert.deepEqual([ls.status, ls.exitCode, echo.status, echo.exitCode], ["done", 0, "done", 0]);
});

function sampleTasks(): { tasks: TaskInfo[]; shellCalls: Record<string, string> } {
  const sample = JSON.parse(readFileSync(join(DIR, "tasks-sample.json"), "utf8")) as { tasks: (TaskInfo & { toolCallId?: string })[] };
  const shellCalls: Record<string, string> = {};
  for (const task of sample.tasks) if (task.type === "shell" && task.toolCallId) shellCalls[task.id] = task.toolCallId;
  return { tasks: sample.tasks, shellCalls };
}

test("tasks-json-merge with tasks-sample.json: beta turns idle, the order is by start time, make test hangs under alpha", () => {
  const store = load("tasks-json-merge.jsonl");
  const now = Date.parse("2026-11-16T05:01:00.000Z");
  const { tasks, shellCalls } = sampleTasks();
  const input = { store, usage: null, now, collapseEnded: false, keep: new Set<EntryKey>(), lastOutputLine: () => "" };

  const without = buildList({ ...input, tasks: null });
  assert.deepEqual(
    without.map((e) => [e.name, e.status, e.depth]),
    [
      ["alpha", "running", 0],
      ["make test", "running", 1],
      ["beta", "done", 0],
      ["gamma", "done", 0],
      ["delta", "failed", 0],
    ],
  );
  const merged = buildList({ ...input, tasks: { tasks, shellCalls, receivedAt: now - 1000, connected: true } });
  assert.deepEqual(
    merged.map((e) => [e.name, e.status, e.depth, e.task?.id]),
    [
      ["alpha", "running", 0, "aaaaaaaa-0000-4000-8000-000000000001"],
      ["make test", "running", 1, "1"],
      ["beta", "idle", 0, "aaaaaaaa-0000-4000-8000-000000000002"],
      ["gamma", "done", 0, "aaaaaaaa-0000-4000-8000-000000000003"],
      ["delta", "failed", 0, undefined],
    ],
  );
  const make = merged.find((e) => e.name === "make test");
  assert.deepEqual([make?.task?.pid, make?.task?.canPromoteToBackground, make?.elapsedMs], [4242, true, 10_000]);
});

function loadSynthetic(): { lines: string[]; store: SessionStore } {
  const lines = fixtureLines("synthetic-session.jsonl");
  const store = new SessionStore("synthetic");
  let changed = 0;
  for (const line of lines) {
    const event = parseEventLine(line);
    assert.ok(event, line.slice(0, 80));
    assert.ok(event.at > 0, line.slice(0, 80));
    if (store.feed(event)) changed++;
  }
  assert.ok(changed > 200, `${changed} events changed the store`);
  return { lines, store };
}

test("synthetic-session.jsonl: 15 agents in three levels, statuses, multi-turn agents", () => {
  const { lines, store } = loadSynthetic();
  assert.equal(lines.length, 273);
  const agents = store.agents();
  assert.equal(agents.length, 15);
  const count = (status: string) => agents.filter((a) => a.status === status).length;
  assert.deepEqual([count("done"), count("failed"), count("stopped"), count("running")], [13, 1, 1, 0]);
  assert.equal(byName(store, "tax-worker").error, "上游税率接口超时 重试 3 次后放弃");
  assert.equal(byName(store, "docs-writer").cancelled, true);

  const helper = byName(store, "fx-helper");
  const worker = byName(store, "payment-worker");
  const lead = byName(store, "checkout-lead");
  assert.deepEqual([helper.parentId, worker.parentId, lead.parentId], [worker.id, lead.id, null]);
  const resumes = (name: string) => store.transcript(byName(store, name).id).filter((item) => item.kind === "resume").length;
  assert.deepEqual([resumes("cart-audit"), resumes("release-notes"), resumes("catalog-scan")], [1, 2, 0]);

  assert.equal(store.mainModel, "provider/large-1.0");
  assert.equal(store.cwd, "/home/user/projects/webshop");
  assert.equal(store.lastEventAt, Math.max(...lines.map((line) => parseTimestamp((JSON.parse(line) as { timestamp: string }).timestamp))));
});

test("synthetic-session.jsonl: usage records add up per agent, and the reported total includes the sub-agents", () => {
  const { lines, store } = loadSynthetic();
  const fromFile = new Map<string, number>();
  for (const line of lines) {
    const event = JSON.parse(line) as { type: string; agentId?: string; data: { usage: { inputTokens: number; outputTokens: number } } };
    if (event.type !== "session.usage_record" || !event.agentId) continue;
    fromFile.set(event.agentId, (fromFile.get(event.agentId) ?? 0) + event.data.usage.inputTokens + event.data.usage.outputTokens);
  }
  for (const agent of store.agents()) assert.equal(agent.eventTokens, fromFile.get(agent.id), agent.name);
  const family = ["checkout-lead", "payment-worker", "fx-helper", "tax-worker", "coupon-worker"];
  const own = family.reduce((sum, name) => sum + (byName(store, name).eventTokens ?? 0), 0);
  assert.equal(byName(store, "checkout-lead").totalTokens, own);
  assert.equal(byName(store, "payment-worker").totalTokens, (byName(store, "payment-worker").eventTokens ?? 0) + (byName(store, "fx-helper").eventTokens ?? 0));
});

test("synthetic-session.jsonl: sync, background and detached commands; six failures but only the latest five are kept", () => {
  const { store } = loadSynthetic();
  const commands = store.commands();
  assert.equal(commands.length, 16);
  assert.deepEqual(
    commands.filter((c) => c.background).map((c) => c.command),
    ["npx playwright test", "npm run migrate", "tail -f logs/server.log", "npm run dev", "python3 -m http.server 8000", "sleep 600"],
  );
  assert.deepEqual(
    commands.filter((c) => c.status === "failed").map((c) => c.command),
    ["npm run migrate", "npm test -- payment", "npm run lint", "npm test", "npm run build", "npm run e2e:smoke"],
  );
  assert.deepEqual(
    commands.filter((c) => c.keptAsFailed).map((c) => c.command),
    ["npm run migrate", "npm run lint", "npm test", "npm run build", "npm run e2e:smoke"],
  );
  assert.deepEqual([byCommand(store, "python3 -m http.server 8000").detach, byCommand(store, "python3 -m http.server 8000").exitCode], [true, null]);
  assert.equal(byCommand(store, "tail -f logs/server.log").endReason, "agent-ended");
  const sleep = byCommand(store, "sleep 600");
  assert.deepEqual([sleep.promoted, sleep.status], [true, "running"]);
});

test("synthetic-session.jsonl feeds the same line by line as event by event, and matches its generator", () => {
  const { lines, store } = loadSynthetic();
  const again = new SessionStore("synthetic");
  for (const line of lines) again.feedLine(line);
  assert.deepEqual(JSON.parse(JSON.stringify(again.agents())), JSON.parse(JSON.stringify(store.agents())));
  assert.equal(again.version, store.version);

  const out = tempDir("syn");
  try {
    const target = join(out.path, "again.jsonl");
    execFileSync(process.execPath, [join(DIR, "gen-synthetic-session.mjs"), target], { stdio: "ignore" });
    assert.equal(readFileSync(target, "utf8"), readFileSync(join(DIR, "synthetic-session.jsonl"), "utf8"));
  } finally {
    out.cleanup();
  }
});
