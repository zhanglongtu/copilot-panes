// 合成名单：排序和缩进、命令何时上名单、和任务列表合并、收起已结束的、保留选中的。
import assert from "node:assert/strict";
import { test } from "node:test";
import { agentElapsedMs, commandElapsedMs, isCommandListed, isTasksFresh } from "../../src/model/merge.ts";
import type { CommandRecord, EntryKey, ListEntry } from "../../src/types/model.ts";
import {
  BASE,
  NOW,
  agentTask,
  bashBackground,
  bashEnd,
  bashStart,
  completed,
  ev,
  failedEvent,
  iso,
  listOf,
  shape,
  shellTask,
  snapshot,
  started,
  storeOf,
  taskCall,
  usageOf,
} from "./support.ts";

function entry(list: ListEntry[], key: EntryKey): ListEntry {
  const found = list.find((e) => e.key === key);
  assert.ok(found, key);
  return found;
}

const statuses = (list: ListEntry[]) => Object.fromEntries(list.map((e) => [e.key, e.status]));

// ───── 排序、缩进和命令何时上名单 ─────

test("siblings are ordered by start time whatever their state, so rows do not jump when the state changes", () => {
  const store = storeOf(started("A", "first", { at: 1 }), started("B", "second", { at: 2 }), started("C", "third", { at: 3 }), completed("A", "t-A", { at: 10 }));
  assert.deepEqual(
    listOf(store).map((e) => e.name),
    ["first", "second", "third"],
  );
});

test("nested agents are indented under their parent, however deep", () => {
  const store = storeOf(
    taskCall("t-A", null, 0),
    started("A", "outer", { at: 1 }),
    taskCall("t-B", "A", 2),
    started("B", "inner", { at: 3 }),
    taskCall("t-D", "B", 3.5),
    started("D", "deepest", { at: 3.6 }),
    started("C", "other", { at: 4 }),
  );
  assert.deepEqual(shape(listOf(store)), [
    ["agent", "outer", 0],
    ["agent", "inner", 1],
    ["agent", "deepest", 2],
    ["agent", "other", 0],
  ]);
  const list = listOf(store);
  assert.deepEqual(
    list.map((e) => e.parentKey),
    [null, "agent:A", "agent:B", null],
  );
});

test("command rows appear after two seconds, background ones at once, and sit under their agent by start time", () => {
  const store = storeOf(
    started("A", "alpha", { at: 0 }),
    bashStart("quick", "ls", "A", 99.5),
    bashStart("slow", "make test", "A", 90),
    bashStart("bg", "server", "A", 99.9, { mode: "async", shellId: "s" }),
    bashBackground("bg", "s", "A", 99.95),
    bashStart("edge", "edge", "A", 98),
  );
  assert.deepEqual(shape(listOf(store)), [
    ["agent", "alpha", 0],
    ["command", "make test", 1],
    ["command", "edge", 1],
    ["command", "server", 1],
  ]);
});

test("isCommandListed: two seconds for a foreground command, background at once, ended ones only when kept as failed", () => {
  const store = storeOf(bashStart("fg", "x", null, 0), bashStart("bg", "y", null, 0, { mode: "async" }), bashStart("ok", "z", null, 0), bashEnd("ok", "", 0, null, 5), bashStart("bad", "w", null, 0), bashEnd("bad", "", 1, null, 5));
  const c = (id: string) => store.command(id) as CommandRecord;
  assert.equal(isCommandListed(c("fg"), BASE + 1999), false);
  assert.equal(isCommandListed(c("fg"), BASE + 2000), true);
  assert.equal(isCommandListed(c("bg"), BASE), true);
  assert.equal(isCommandListed(c("ok"), BASE + 9000), false);
  assert.equal(isCommandListed(c("bad"), BASE + 9000), true);
});

test("a command disappears when it ends with exit code 0", () => {
  const store = storeOf(bashStart("c1", "sleep 9", null, 50));
  assert.deepEqual(shape(listOf(store)), [["command", "sleep 9", 0]]);
  store.feedLine(bashEnd("c1", "", 0, null, 99));
  assert.deepEqual(listOf(store), []);
});

test("a command that fails stays under its agent as failed; one that never showed does not", () => {
  const store = storeOf(
    started("A", "alpha", { at: 0 }),
    bashStart("slow", "make", "A", 50),
    bashEnd("slow", "", 2, "A", 60),
    bashStart("quick", "grep x", "A", 70),
    bashEnd("quick", "", 1, "A", 71),
  );
  const list = listOf(store);
  assert.deepEqual(
    list.map((e) => [e.kind, e.id, e.status, e.depth, e.exitCode, e.step, e.elapsedMs]),
    [
      ["agent", "A", "running", 0, null, "跑 grep", 100_000],
      ["command", "slow", "failed", 1, 2, "退出码 2", 10_000],
    ],
  );
});

test("a failed command of the main session is listed at the top level and goes with the rest by start time", () => {
  const store = storeOf(started("R", "runner", { at: 1 }), bashStart("m", "make", null, 20), bashEnd("m", "", 1, null, 40), bashStart("t", "tail -f x", null, 50));
  assert.deepEqual(shape(listOf(store)), [
    ["agent", "runner", 0],
    ["command", "make", 0],
    ["command", "tail -f x", 0],
  ]);
});

test("a finished parent keeps its running child beneath it", () => {
  const store = storeOf(taskCall("t-A", null), started("A", "outer", { at: 1 }), taskCall("t-B", "A"), started("B", "inner", { at: 2 }), completed("A", "t-A", { at: 5 }));
  assert.deepEqual(
    listOf(store).map((e) => [e.name, e.depth, e.status]),
    [
      ["outer", 0, "done"],
      ["inner", 1, "running"],
    ],
  );
});

test("a failed agent keeps its commands and children under it, in start order", () => {
  const store = storeOf(
    started("R", "runner", { at: 1 }),
    taskCall("t-P", null),
    started("P", "parent", { at: 2 }),
    taskCall("t-K", "P"),
    started("K", "kid", { at: 3 }),
    bashStart("pc", "make", "P", 10),
    failedEvent("P", "t-P", "x", 40),
  );
  assert.deepEqual(shape(listOf(store)), [
    ["agent", "runner", 0],
    ["agent", "parent", 0],
    ["agent", "kid", 1],
    ["command", "make", 1],
  ]);
});

test("main-session commands sort in among the agents by start time; same start times go by id", () => {
  const store = storeOf(started("B", "beta", { at: 1 }), started("A", "alpha", { at: 1 }), bashStart("m1", "main-cmd", null, 0.5), bashStart("c-z", "cmd-z", null, 1), bashStart("a1", "alpha-cmd", "A", 50));
  assert.deepEqual(shape(listOf(store)), [
    ["command", "main-cmd", 0],
    ["agent", "alpha", 0],
    ["command", "alpha-cmd", 1],
    ["agent", "beta", 0],
    ["command", "cmd-z", 0],
  ]);
});

test("agents that name each other as parents are all still listed", () => {
  const store = storeOf(taskCall("t-A", "B"), started("A", "a", { at: 1 }), taskCall("t-B", "A"), started("B", "b", { at: 2 }));
  assert.deepEqual(
    listOf(store).map((e) => e.name),
    ["a", "b"],
  );
});

test("the columns: command name on one line, short model, tokens from the usage, exit code and step of a running command", () => {
  const store = storeOf(started("A", "alpha", { model: "provider/medium-1.0", at: 0 }), bashStart("c1", "python3   run.py --a \\\n  --b", "A", 50), bashStart("c2", "serve", "A", 60));
  const asked: string[] = [];
  const list = listOf(store, {
    usage: { A: usageOf(1000, 234) },
    lastOutputLine: (id) => {
      asked.push(id);
      return id === "c1" ? "[###-------] 12/40 30% 已用 1m20s task_012" : "";
    },
  });
  const a = entry(list, "agent:A");
  assert.deepEqual([a.model, a.tokens, a.kind, a.exitCode, a.startedAt], ["medium-1.0", 1234, "agent", null, BASE]);
  const c1 = entry(list, "cmd:c1");
  assert.deepEqual([c1.name, c1.model, c1.tokens, c1.step, c1.elapsedMs, c1.exitCode], ["python3 run.py --a --b", null, null, "12/40 30%", 50_000, null]);
  assert.equal(entry(list, "cmd:c2").step, "");
  assert.deepEqual(asked.sort(), ["c1", "c2"]);
});

test("the last output line is asked for running commands only, and a throwing callback gives an empty step", () => {
  const store = storeOf(bashStart("bad", "make", null, 0), bashEnd("bad", "", 1, null, 5), bashStart("run", "serve", null, 10));
  const asked: string[] = [];
  const list = listOf(store, {
    lastOutputLine: (id) => {
      asked.push(id);
      throw new Error("disk gone");
    },
  });
  assert.deepEqual(asked, ["run"]);
  assert.equal(entry(list, "cmd:run").step, "");
  assert.equal(entry(list, "cmd:bad").step, "退出码 1");
});

test("elapsed times: an agent adds its rounds up, a running one follows the clock, a command stops when it ends", () => {
  const store = storeOf(started("A", "a", { at: 10 }), started("B", "b", { at: 10 }), completed("B", "t-B", { ms: 5000, at: 20 }), bashStart("c1", "x", null, 0), bashEnd("c1", "", 1, null, 7));
  assert.equal(agentElapsedMs(store.agent("A")!, BASE + 70_000), 60_000);
  assert.equal(agentElapsedMs(store.agent("A")!, BASE), 0);
  assert.equal(agentElapsedMs(store.agent("B")!, BASE + 999_000), 5000);
  assert.equal(commandElapsedMs(store.command("c1")!, BASE + 999_000), 7000);
  assert.equal(commandElapsedMs(store.command("c1")!, BASE), 7000);
  const running = storeOf(bashStart("c2", "x", null, 10)).command("c2")!;
  assert.equal(commandElapsedMs(running, BASE + 25_000), 15_000);
  assert.equal(commandElapsedMs(running, BASE), 0);
});

// ───── 和任务列表合并 ─────

function mixedStore() {
  return storeOf(
    started("A", "alpha", { mode: "background", at: 0 }),
    started("B", "beta", { mode: "background", at: 1 }),
    started("C", "gamma", { mode: "background", at: 2 }),
    started("D", "delta", { mode: "background", at: 3 }),
    completed("B", "t-B", { at: 5 }),
    completed("C", "t-C", { at: 6 }),
    failedEvent("D", "t-D", "boom", 7),
  );
}

test("running and idle come from a fresh task list, the rest from the events", () => {
  const store = mixedStore();
  const tasks = snapshot([agentTask("A", "running"), agentTask("B", "idle"), agentTask("C", "completed")], NOW - 1000);
  const list = listOf(store, { tasks });
  assert.deepEqual(statuses(list), { "agent:A": "running", "agent:B": "idle", "agent:C": "done", "agent:D": "failed" });
  assert.deepEqual(
    list.map((e) => e.name),
    ["alpha", "beta", "gamma", "delta"],
  );
  assert.equal(entry(list, "agent:B").step, "做完一轮，等你发话");
});

test("a running task wins over an ended event, other task states never change a running agent except cancelled", () => {
  const store = storeOf(started("A", "a", { at: 0 }), started("B", "b", { at: 1 }), started("C", "c", { at: 2 }), started("D", "d", { at: 3 }), completed("D", "t-D", { at: 5 }));
  const tasks = snapshot([agentTask("A", "completed"), agentTask("B", "cancelled"), agentTask("C", "failed"), agentTask("D", "running")], NOW);
  // 任务列表说 cancelled：停止请求已经生效，事件里的取消记录可能晚一点才来
  assert.deepEqual(statuses(listOf(store, { tasks })), { "agent:A": "running", "agent:B": "cancelled", "agent:C": "running", "agent:D": "running" });
});

test("cancelled is told apart from done and from stopped: the event says cancelled, the task list says cancelled, or the session ended", () => {
  const store = storeOf(
    started("D", "done-one", { at: 0 }),
    started("X", "cancelled-by-event", { at: 1 }),
    started("Y", "cancelled-by-abort", { at: 2, mode: "background" }),
    started("Z", "ended-with-session", { at: 3 }),
    started("W", "cancel-in-progress", { at: 4 }),
    completed("D", "t-D", { at: 10 }),
    ev("subagent.completed", { toolCallId: "t-X", cancelled: true }, "X", 11),
    ev("abort", { reason: "subagent_cancelled" }, "Y", 12),
    ev("session.shutdown", {}, null, 20),
  );
  const list = listOf(store);
  assert.deepEqual(statuses(list), { "agent:D": "done", "agent:X": "cancelled", "agent:Y": "cancelled", "agent:Z": "stopped", "agent:W": "stopped" });
  assert.deepEqual(
    list.map((e) => [e.name, e.step]),
    [["done-one", "做完了"], ["cancelled-by-event", "已取消"], ["cancelled-by-abort", "已取消"], ["ended-with-session", "停了"], ["cancel-in-progress", "停了"]],
  );
  // 已经被任务列表确认取消的，session 结束时没来得及写取消记录也算取消
  const tasks = snapshot([agentTask("W", "cancelled")], NOW);
  assert.equal(statuses(listOf(store, { tasks }))["agent:W"], "cancelled");
  // 取消的子 agent 又收到消息、重新跑起来之后不再是 cancelled
  const resumed = storeOf(started("X", "x", { at: 0 }), ev("subagent.completed", { toolCallId: "t-X", cancelled: true }, "X", 5), ev("user.message", { content: "接着干" }, "X", 6));
  assert.equal(statuses(listOf(resumed))["agent:X"], "running");
});

test("a command stopped by stop_bash or aborted with the main turn is cancelled; one dropped with its agent or ended with the session is stopped", () => {
  const store = storeOf(
    bashStart("c1", "sleep 99", null, 1, { mode: "async" }),
    bashBackground("c1", "7", null, 1.1),
    bashStart("c2", "tail -f x", null, 2, { mode: "async" }),
    bashBackground("c2", "8", null, 2.1),
    ev("tool.execution_start", { toolCallId: "sb", toolName: "stop_bash", arguments: { shellId: "7" } }, null, 5),
    ev("tool.execution_complete", { toolCallId: "sb", success: true, result: { content: "stopped" } }, null, 5.1),
    ev("session.shutdown", {}, null, 9),
  );
  const list = listOf(store, { keep: new Set<EntryKey>(["cmd:c1", "cmd:c2"]) });
  assert.deepEqual(list.map((e) => [e.name, e.status]), [["sleep 99", "cancelled"], ["tail -f x", "stopped"]]);
  assert.equal(entry(list, "cmd:c1").step, "已取消");
});

test("description and promptFoldChars are copied to the entry only when there is something to say", () => {
  const prompt = (agent: string, task: string, at: number) => ev("user.message", { content: task }, agent, at);
  const store = storeOf(
    started("A", "a", { at: 0, desc: "查右侧面板如何常驻" }),
    started("B", "b", { at: 1, desc: "" }),
    started("C", "c", { at: 2, desc: "盘点现有代码" }),
    started("D", "d", { at: 3 }),
    prompt("A", "开始前先读说明。\n\n任务甲", 4),
    prompt("B", "开始前先读说明。\n\n任务乙", 5),
    prompt("C", "开始前先读说明。\n\n任务丙", 6),
    prompt("D", "完全不同", 7),
  );
  const list = listOf(store);
  assert.deepEqual(list.map((e) => [e.name, e.description, e.promptFoldChars]), [["a", "查右侧面板如何常驻", 10], ["b", undefined, 10], ["c", "盘点现有代码", 10], ["d", undefined, undefined]]);
  assert.ok(!("description" in entry(list, "agent:B")));
  assert.ok(!("promptFoldChars" in entry(list, "agent:D")));
  // 事件里没有描述时用任务列表里的
  const tasks = snapshot([{ ...agentTask("B", "running"), description: "任务列表里的简述" }], NOW);
  assert.equal(entry(listOf(store, { tasks }), "agent:B").description, "任务列表里的简述");
});

test("a task list older than 15 seconds or from a closed connection is ignored; exactly 15 seconds is still fresh", () => {
  assert.equal(isTasksFresh(null, NOW), false);
  assert.equal(isTasksFresh(snapshot([], NOW - 15_000), NOW), true);
  assert.equal(isTasksFresh(snapshot([], NOW - 14_999), NOW), true);
  assert.equal(isTasksFresh(snapshot([], NOW - 15_001), NOW), false);
  assert.equal(isTasksFresh(snapshot([], NOW + 5000), NOW), true);
  assert.equal(isTasksFresh(snapshot([], NOW, { connected: false }), NOW), false);

  const store = mixedStore();
  const tasks = [agentTask("A", "idle"), agentTask("B", "idle")];
  const idle = (snap: ReturnType<typeof snapshot>) => statuses(listOf(store, { tasks: snap }))["agent:B"];
  assert.equal(idle(snapshot(tasks, NOW - 14_000)), "idle");
  assert.equal(idle(snapshot(tasks, NOW - 15_000)), "idle");
  assert.equal(idle(snapshot(tasks, NOW - 16_000)), "done");
  assert.equal(idle(snapshot(tasks, NOW, { connected: false })), "done");
  const stale = listOf(store, { tasks: snapshot([agentTask("A", "idle")], NOW - 16_000) });
  assert.ok(stale.every((e) => e.task === null));
});

test("a list with no task list at all uses the event states and has no task refs", () => {
  const list = listOf(mixedStore(), { tasks: null });
  assert.deepEqual(statuses(list), { "agent:A": "running", "agent:B": "done", "agent:C": "done", "agent:D": "failed" });
  assert.ok(list.every((e) => e.task === null));
});

test("commands get their task ref and pid through shellCalls; agents through their agentId", () => {
  const store = storeOf(
    started("A", "alpha", { mode: "background", at: 0 }),
    bashStart("c1", "make test", "A", 50),
    bashStart("c2", "serve", "A", 51, { mode: "async" }),
    bashStart("c3", "other", "A", 52),
  );
  const tasks = snapshot(
    [
      agentTask("A", "running", { executionMode: "sync", canPromoteToBackground: true }),
      shellTask("1", "running", { executionMode: "sync", canPromoteToBackground: true, pid: 4242 }),
      shellTask("2", "running"),
      agentTask("7", "running"),
    ],
    NOW,
    { shellCalls: { "1": "c1", "2": "c2", "7": "c3" } },
  );
  const list = listOf(store, { tasks });
  assert.deepEqual(entry(list, "agent:A").task, { id: "A", status: "running", executionMode: "sync", canPromoteToBackground: true, pid: null });
  assert.deepEqual(entry(list, "cmd:c1").task, { id: "1", status: "running", executionMode: "sync", canPromoteToBackground: true, pid: 4242 });
  assert.deepEqual(entry(list, "cmd:c2").task, { id: "2", status: "running", executionMode: null, canPromoteToBackground: false, pid: null });
  // shellCalls 指向的任务不是 shell 任务（这里是 agent 任务），不算对上
  assert.equal(entry(list, "cmd:c3").task, null);
  assert.equal(entry(listOf(store, { tasks: { ...tasks, connected: false } }), "cmd:c1").task, null);
});

test("an idle agent's elapsed time stops at idleSince", () => {
  const store = storeOf(started("A", "alpha", { mode: "background", at: 0 }), completed("A", "t-A", { ms: 8000, at: 8 }), started("B", "beta", { mode: "background", at: 0 }));
  const tasks = snapshot([agentTask("A", "idle", { idleSince: iso(30) }), agentTask("B", "idle", { idleSince: iso(40) })], NOW);
  const list = listOf(store, { tasks });
  assert.equal(entry(list, "agent:A").elapsedMs, 8000);
  // 事件里还没来 agent_idle：任务说空闲的时刻就是这一轮结束的时刻
  assert.equal(entry(list, "agent:B").elapsedMs, 40_000);
  assert.equal(entry(listOf(store, { tasks: snapshot([agentTask("B", "idle")], NOW) }), "agent:B").elapsedMs, 100_000);
});

test("a sub-agent's background command dropped when the agent ended is listed as running while its task says running", () => {
  const store = storeOf(
    started("A", "alpha", { at: 0 }),
    bashStart("c1", "sleep 600", "A", 1, { mode: "async", shellId: "p" }),
    bashBackground("c1", "p", "A", 1.1),
    completed("A", "t-A", { at: 10 }),
  );
  assert.equal(store.command("c1")?.status, "stopped");
  assert.deepEqual(shape(listOf(store)), [["agent", "alpha", 0]]);
  const running = snapshot([shellTask("p", "running", { pid: 9 })], NOW, { shellCalls: { p: "c1" } });
  const list = listOf(store, { tasks: running });
  assert.deepEqual(
    list.map((e) => [e.key, e.status, e.depth, e.elapsedMs, e.task?.pid]),
    [
      ["agent:A", "done", 0, 12_000, undefined],
      ["cmd:c1", "running", 1, 99_000, 9],
    ],
  );
  const ended = snapshot([shellTask("p", "completed")], NOW, { shellCalls: { p: "c1" } });
  assert.deepEqual(shape(listOf(store, { tasks: ended })), [["agent", "alpha", 0]]);
  assert.deepEqual(shape(listOf(store, { tasks: snapshot(running.tasks, NOW - 20_000, { shellCalls: running.shellCalls }) })), [["agent", "alpha", 0]]);
  const unmatched = snapshot([shellTask("p", "running")], NOW);
  assert.deepEqual(shape(listOf(store, { tasks: unmatched })), [["agent", "alpha", 0]]);
});

test("a background command that tasks.cancel stopped (no end notice in the event log) ends from the task list; a detached one is marked detached", () => {
  const store = storeOf(bashStart("c1", "sleep 99", null, 1, { mode: "async" }), bashBackground("c1", "7", null, 1.1));
  const tasks = (status: "running" | "cancelled") =>
    snapshot([shellTask("7", status, { pid: 9, attachmentMode: "detached", ...(status === "cancelled" ? { completedAt: iso(31) } : {}) })], NOW, { shellCalls: { "7": "c1" } });
  const running = listOf(store, { tasks: tasks("running") });
  assert.deepEqual(running.map((e) => [e.status, e.task?.detached]), [["running", true]]);
  // 取消之后：不上名单，选中时由 keep 留着，状态“已取消”，用时停在 completedAt
  assert.deepEqual(listOf(store, { tasks: tasks("cancelled") }), []);
  const kept = listOf(store, { tasks: tasks("cancelled"), keep: new Set<EntryKey>(["cmd:c1"]) });
  assert.deepEqual(kept.map((e) => [e.status, e.step, e.elapsedMs]), [["cancelled", "已取消", 30_000]]);
  assert.equal(entry(kept, "cmd:c1").task?.status, "cancelled");
});

// ───── 收起已结束的和保留选中的 ─────

function collapsibleStore() {
  return storeOf(
    taskCall("t-P", null),
    started("P", "parent", { at: 1 }),
    taskCall("t-K", "P"),
    started("K", "kid", { at: 2 }),
    taskCall("t-G", "K"),
    started("G", "grandkid", { at: 3 }),
    started("S", "stopped-one", { at: 4 }),
    started("F", "failed-one", { at: 5 }),
    bashStart("bad", "make", "P", 10),
    bashEnd("bad", "", 1, "P", 20),
    bashStart("run", "serve", "P", 30),
    completed("P", "t-P", { at: 40 }),
    completed("K", "t-K", { at: 41 }),
    ev("subagent.completed", { toolCallId: "t-S", cancelled: true }, "S", 42),
    failedEvent("F", "t-F", "x", 43),
  );
}

test("collapseEnded hides ended entries, failed commands included, and moves their running children up", () => {
  const store = collapsibleStore();
  assert.deepEqual(
    listOf(store).map((e) => [e.name, e.depth, e.status]),
    [
      ["parent", 0, "done"],
      ["kid", 1, "done"],
      ["grandkid", 2, "running"],
      ["make", 1, "failed"],
      ["serve", 1, "running"],
      ["stopped-one", 0, "cancelled"],
      ["failed-one", 0, "failed"],
    ],
  );
  const collapsed = listOf(store, { collapseEnded: true });
  assert.deepEqual(
    collapsed.map((e) => [e.name, e.depth, e.parentKey]),
    [
      ["grandkid", 0, null],
      ["serve", 0, null],
    ],
  );
});

test("collapseEnded keeps ended entries that are in keep, with their place in the tree", () => {
  const store = collapsibleStore();
  const keep = new Set<EntryKey>(["agent:K", "cmd:bad", "agent:F"]);
  const list = listOf(store, { collapseEnded: true, keep });
  assert.deepEqual(
    list.map((e) => [e.name, e.depth, e.parentKey]),
    [
      ["kid", 0, null],
      ["grandkid", 1, "agent:K"],
      ["make", 0, null],
      ["serve", 0, null],
      ["failed-one", 0, null],
    ],
  );
});

test("keep also lists a command that the rules would not list, and entries that are not in the store are ignored", () => {
  const store = storeOf(started("A", "alpha", { at: 0 }), bashStart("quick", "ls", "A", 99.5), bashStart("ok", "make", "A", 10), bashEnd("ok", "built\n", 0, "A", 20));
  assert.deepEqual(shape(listOf(store)), [["agent", "alpha", 0]]);
  const list = listOf(store, { keep: new Set<EntryKey>(["cmd:ok", "cmd:quick", "cmd:nope", "agent:nope"]) });
  assert.deepEqual(
    list.map((e) => [e.key, e.status, e.step, e.depth]),
    [
      ["agent:A", "running", "跑 make", 0],
      ["cmd:ok", "done", "退出码 0", 1],
      ["cmd:quick", "running", "", 1],
    ],
  );
  // 在 keep 里的已成功结束的命令，收起已结束的时候也不收
  assert.deepEqual(
    listOf(store, { collapseEnded: true, keep: new Set<EntryKey>(["cmd:ok"]) }).map((e) => e.key),
    ["agent:A", "cmd:ok"],
  );
});

test("an agent that goes idle by its task is not ended, so it is not collapsed", () => {
  const store = storeOf(started("A", "alpha", { mode: "background", at: 0 }), completed("A", "t-A", { at: 5 }));
  const idle = snapshot([agentTask("A", "idle")], NOW);
  assert.equal(listOf(store, { collapseEnded: true, tasks: idle }).length, 1);
  assert.equal(listOf(store, { collapseEnded: true }).length, 0);
});

test("a command's name drops a leading `cd dir &&` because the name column is narrow", () => {
  const store = storeOf(
    bashStart("c1", "cd /home/me/project && npm test -- --watch", null, 1, { mode: "async", shellId: "s1" }),
    bashBackground("c1", "s1", null, 1.1),
    bashStart("c2", 'cd "/path with spaces"; make   build', null, 2, { mode: "async", shellId: "s2" }),
    bashBackground("c2", "s2", null, 2.1),
    bashStart("c3", "cd /only/a/dir", null, 3, { mode: "async", shellId: "s3" }),
    bashBackground("c3", "s3", null, 3.1),
  );
  const names = listOf(store).map((e) => e.name);
  assert.deepEqual(names, ["npm test -- --watch", "make build", "cd /only/a/dir"]);
});
