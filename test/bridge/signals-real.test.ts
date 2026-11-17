// 用真的进程验证“给进程组发 SIGINT”：命令用 detached:true 起，和 Copilot CLI 的后台命令一样，
// 自己是进程组和会话的组长、没有伪终端、标准输入不是终端。只给自己起的进程发信号。
// 跑完会打印一张结果表。
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { Interrupter, procAccess } from "../../src/bridge/signals.ts";
import type { InterruptOutcome } from "../../src/types/app.ts";
import { selfAndDescendants, readProc, readProcTable } from "../../src/discover/procs.ts";
import { tempDir } from "../helpers/tmp.ts";

const ESCALATE_MS = 300;
const PYTHON = process.env.PANES_TEST_PYTHON || "python3";
const noPython = spawnSync(PYTHON, ["--version"]).status !== 0;
const needsPython = noPython && "python3 is not installed (set PANES_TEST_PYTHON to try another interpreter)";

interface Tracked {
  pid: number;
  startTicks: number;
  name: string;
}

interface CaseSpec {
  label: string;
  command: string;
  args: string[];
  cwd?: string;
  /** 至少要有这么多个进程在树里才算起好了。 */
  minProcs: number;
  /** 起好之前标准输出里要先出现的文字。 */
  readyText?: string;
}

interface Row {
  label: string;
  processes: string;
  /** SIGINT 之后整棵树退出了吗；没有的话，下面是还活着的进程。 */
  intGone: boolean;
  survivors: string;
  /** 最终靠哪个信号收场（SIGINT、SIGTERM、SIGKILL），或“没有”。 */
  endedBy: string;
  leaderExit: string;
  note: string;
}

const rows: Row[] = [];

function stateOf(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3);
  } catch {
    return null;
  }
}

function isRunning(t: Tracked): boolean {
  const info = readProc(t.pid);
  if (!info || info.startTicks !== t.startTicks) return false;
  const state = stateOf(t.pid);
  return state !== null && state !== "Z" && state !== "X";
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitUntil(condition: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await sleep(20);
  }
  return condition();
}

function treeOf(rootPid: number): Tracked[] {
  const table = readProcTable();
  const pids = new Set(selfAndDescendants(rootPid, table));
  for (const info of table.values()) if (info.pgid === rootPid) pids.add(info.pid);
  const tracked: Tracked[] = [];
  for (const pid of pids) {
    const info = table.get(pid);
    if (info) tracked.push({ pid, startTicks: info.startTicks, name: basename(info.argv[0] ?? info.comm) });
  }
  return tracked;
}

const describe = (list: Tracked[]) => list.map((t) => t.name).join(" + ") || "-";

async function runCase(spec: CaseSpec): Promise<Row> {
  const child = spawn(spec.command, spec.args, { detached: true, stdio: ["ignore", "pipe", "pipe"], cwd: spec.cwd });
  let stdout = "";
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
  child.stderr.on("data", () => {});
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
  const rootPid = child.pid!;
  const everSeen = new Map<number, Tracked>();
  const remember = (list: Tracked[]) => list.forEach((t) => everSeen.set(t.pid, t));
  try {
    // 起好的标志：进程数够了，并且所有进程都在睡眠（状态 S）超过 150 毫秒
    let stable = 0;
    const settled = await waitUntil(() => {
      const tree = treeOf(rootPid);
      remember(tree);
      const ok = tree.length >= spec.minProcs && tree.every((t) => stateOf(t.pid) === "S") && (!spec.readyText || stdout.includes(spec.readyText));
      stable = ok ? stable + 1 : 0;
      return stable >= 8;
    }, 15_000);
    assert.ok(settled, `${spec.label}: the command did not settle (${describe(treeOf(rootPid))})`);
    const tree = treeOf(rootPid);
    remember(tree);

    const interrupter = new Interrupter(procAccess(), { now: () => Date.now() }, ESCALATE_MS);
    const attempts: InterruptOutcome[] = [];
    const press = () => {
      const outcome = interrupter.press(spec.label, rootPid, process.pid);
      attempts.push(outcome);
      return outcome;
    };
    const aliveNow = () => [...everSeen.values()].filter(isRunning);

    assert.deepEqual(press(), { kind: "sent", signal: "SIGINT", target: "group" }, spec.label);
    // 第二次按得太早，要等
    assert.equal(press().kind, "wait", spec.label);

    const intGone = await waitUntil(() => aliveNow().length === 0, 1500);
    const survivors = describe(aliveNow());
    let endedBy = intGone ? "SIGINT" : "没有";
    let note = "";
    for (const next of ["SIGTERM", "SIGKILL"] as const) {
      if (aliveNow().length === 0) break;
      await sleep(ESCALATE_MS + 50);
      const outcome = press();
      if (outcome.kind === "fallback") {
        note = `第二次按被拒绝：${outcome.reason}`;
        break;
      }
      assert.deepEqual(outcome, { kind: "sent", signal: next, target: "group" }, spec.label);
      if (await waitUntil(() => aliveNow().length === 0, 1500)) endedBy = next;
    }
    const leader = await Promise.race([exit, sleep(1500).then(() => null)]);
    const leaderExit = leader === null ? "还在" : leader.signal ? `信号 ${leader.signal}` : `退出码 ${leader.code}`;
    const row = { label: spec.label, processes: describe(tree), intGone, survivors: intGone ? "-" : survivors, endedBy, leaderExit, note };
    rows.push(row);
    return row;
  } finally {
    // 不管结果如何，把这个命令起的所有进程清干净（只发给自己记下的、启动时刻对得上的进程）
    for (const t of everSeen.values()) {
      if (!isRunning(t)) continue;
      try {
        process.kill(t.pid, "SIGKILL");
      } catch {
        // 已经没了
      }
    }
    await waitUntil(() => [...everSeen.values()].every((t) => !isRunning(t)), 3000);
    child.stdout.destroy();
    child.stderr.destroy();
    assert.deepEqual([...everSeen.values()].filter(isRunning), [], `${spec.label}: left processes behind`);
  }
}

test("python3 sleeping: SIGINT to the group ends it", { skip: needsPython }, async () => {
  const row = await runCase({ label: "python3 -c sleep", command: "python3", args: ["-c", "import time; time.sleep(60)"], minProcs: 1 });
  assert.equal(row.intGone, true);
  assert.equal(row.endedBy, "SIGINT");
});

test("a shell wrapping python3: the whole tree ends on SIGINT", { skip: needsPython }, async () => {
  const row = await runCase({ label: "sh -c python3", command: "sh", args: ["-c", 'python3 -c "import time; time.sleep(60)"'], minProcs: 1 });
  assert.equal(row.intGone, true);
});

test("a pipeline: every stage ends on SIGINT", async () => {
  const row = await runCase({ label: "sh -c 'sleep | cat'", command: "sh", args: ["-c", "sleep 60 | cat"], minProcs: 3 });
  assert.equal(row.intGone, true);
});

test("node with a pending timer ends on SIGINT", async () => {
  const row = await runCase({ label: "node -e setTimeout", command: "node", args: ["-e", "setTimeout(()=>{}, 60000)"], minProcs: 1 });
  assert.equal(row.intGone, true);
});

test("bash with a '&' background child: what SIGINT does to it", async () => {
  const row = await runCase({ label: "bash -c 'sleep & wait'", command: "bash", args: ["-c", "sleep 60 & wait"], minProcs: 2 });
  // bash 本身一定会退出；sleep 是 & 起的后台子进程，非交互 shell 里它忽略 SIGINT，所以可能活下来，靠后面的信号收场
  assert.notEqual(row.leaderExit, "还在");
});

test("a process that ignores SIGINT is ended by the escalation to SIGTERM", async () => {
  const row = await runCase({ label: "sh trap '' INT", command: "sh", args: ["-c", 'trap "" INT; sleep 60'], minProcs: 2 });
  assert.equal(row.intGone, false);
  assert.equal(row.endedBy, "SIGTERM");
});

const noPytest = noPython || spawnSync(PYTHON, ["-m", "pytest", "--version"]).status !== 0;
test("pytest running a test that sleeps ends on SIGINT", { skip: noPytest && "pytest is not installed for python3 (set PANES_TEST_PYTHON to try another interpreter)" }, async () => {
  const dir = tempDir("t");
  try {
    writeFileSync(join(dir.path, "test_sleep.py"), 'import time\n\ndef test_sleep():\n    print("ready-for-sigint", flush=True)\n    time.sleep(60)\n');
    const row = await runCase({
      label: "python3 -m pytest",
      command: PYTHON,
      args: ["-m", "pytest", "-s", "-p", "no:cacheprovider", "test_sleep.py"],
      cwd: dir.path,
      minProcs: 1,
      readyText: "ready-for-sigint",
    });
    assert.equal(row.intGone, true);
  } finally {
    dir.cleanup();
  }
});

after(() => {
  const header = ["命令", "进程树", "SIGINT 后整棵树退出", "还活着的", "收场信号", "主进程的退出"];
  const lines = rows.map((r) => [r.label, r.processes, r.intGone ? "是" : "否", r.survivors, r.endedBy, r.leaderExit + (r.note ? `；${r.note}` : "")]);
  console.log("\n给进程组发 SIGINT 的结果（detached:true，无伪终端）：");
  console.log(header.join(" | "));
  for (const line of lines) console.log(line.join(" | "));
});
