// 基准：界面空闲和有条目在跑时的 CPU 占用。运行：node scripts/bench/cpu.ts [空闲|在跑|演示|等待|全部] [秒数，默认 30]
// 在独立的 tmux 服务（-L cp-bench）里起一个假的 Copilot CLI 进程（名字叫 copilot 的 node）和界面，
// 数据放在 .scratch/cpu/ 下，用界面进程 /proc/<pid>/stat 的 utime+stime 算占用。不碰 ~/.copilot 和默认的 tmux。
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { bashBackground, bashStart, completed, ev, say, shellNotice, started, taskCall, toolEnd, toolStart } from "../../test/model/support.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const WORK = join(ROOT, ".scratch", "cpu");
const SOCKET = "cp-bench";
const SETTLE_S = 6;
const FILLER_SESSIONS = 260;
const SESSION_ID = "11111111-2222-3333-4444-555555555555";

const which = process.argv[2] ?? "全部";
const seconds = Number(process.argv[3] ?? 30);

const tmux = (...args: string[]): string => execFileSync("tmux", ["-L", SOCKET, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

function eventsFor(scenario: "空闲" | "在跑"): string[] {
  const lines = [
    ev("session.start", { sessionId: SESSION_ID, context: { cwd: "/work/demo" }, selectedModel: "m" }, null, 0),
    taskCall("t-1", null, 1),
    started("a1", "fix-login", { task: "t-1", at: 1.1 }),
    ev("user.message", { content: "修一下登录失败" }, "a1", 1.2),
    toolStart("v-1", "view", { path: "/work/demo/src/auth.ts" }, "a1", 2),
    toolEnd("v-1", "line\n".repeat(30), "a1", 2.1),
    say("a1", "找到原因了：refreshToken 提前清空了会话。", 3),
  ];
  if (scenario === "空闲") {
    lines.push(completed("a1", "t-1", { at: 4 }), toolEnd("t-1", "done", null, 4.1));
    lines.push(bashStart("b-1", "npm run build", null, 5, { mode: "async" }), bashBackground("b-1", "sh-1", null, 5.1), shellNotice("sh-1", 0, 6));
  } else {
    lines.push(bashStart("b-1", "npm run build", "a1", 5, { mode: "async" }), bashBackground("b-1", "sh-1", "a1", 5.1));
  }
  return lines;
}

function findPid(match: (comm: string, argv: string[]) => boolean, parent?: number): number | null {
  for (const name of readdirSync("/proc")) {
    if (!/^[1-9][0-9]*$/.test(name)) continue;
    try {
      const stat = readFileSync(`/proc/${name}/stat`, "utf8");
      const comm = stat.slice(stat.indexOf("(") + 1, stat.lastIndexOf(")"));
      const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
      if (parent !== undefined && ppid !== parent) continue;
      const argv = readFileSync(`/proc/${name}/cmdline`, "utf8").split("\0");
      if (match(comm, argv)) return Number(name);
    } catch {
      // 进程刚退出
    }
  }
  return null;
}

function cpuTicks(pid: number): number {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  return Number(fields[11]) + Number(fields[12]);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const TICKS_PER_SECOND = 100;

async function measure(scenario: "空闲" | "在跑" | "演示" | "等待"): Promise<number> {
  rmSync(WORK, { recursive: true, force: true });
  const state = join(WORK, "state");
  const data = join(WORK, "data");
  mkdirSync(join(state, SESSION_ID), { recursive: true });
  mkdirSync(data, { recursive: true });
  mkdirSync(join(WORK, "bin"), { recursive: true });
  symlinkSync(process.execPath, join(WORK, "bin", "copilot"));

  try {
    tmux("kill-server");
  } catch {
    // 没有这个服务
  }
  // 窗口里先放一个假的 Copilot CLI（comm 是 copilot），再放界面
  tmux("new-session", "-d", "-s", "bench", "-x", "170", "-y", "40", `exec ${join(WORK, "bin", "copilot")} -e "setInterval(() => {}, 1e6)"`);
  await sleep(500);
  const fake = findPid((comm) => comm === "copilot");
  if (fake === null) throw new Error("没有找到假的 copilot 进程");
  // session-state 里常有两百多个旧 session，找 session 时要逐个看
  for (let i = 0; i < FILLER_SESSIONS; i++) {
    const dir = join(state, `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "workspace.yaml"), `id: filler-${i}\ncwd: /work/old-${i}\nname: old session ${i}\n`);
    writeFileSync(join(dir, "events.jsonl"), `${eventsFor("空闲").join("\n")}\n`);
  }
  if (scenario === "空闲" || scenario === "在跑") {
    writeFileSync(join(state, SESSION_ID, "events.jsonl"), `${eventsFor(scenario).join("\n")}\n`);
    writeFileSync(join(state, SESSION_ID, "workspace.yaml"), "cwd: /work/demo\nname: bench session\n");
    writeFileSync(join(state, SESSION_ID, `inuse.${fake}.lock`), "");
  }
  const args = scenario === "演示" ? "--demo" : `--session-state-dir ${state} --data-dir ${data}`;
  const pane = tmux("split-window", "-P", "-F", "#{pane_id}", "-h", "-l", "120", `cd ${ROOT} && exec node ${process.env.CPU_PROF ? `--cpu-prof --cpu-prof-dir=${join(ROOT, ".scratch", "prof")} ` : ""}src/cli.ts ${args} --no-bell --dark 2> ${join(WORK, "ui.err")}`).trim();
  await sleep(1000);
  const ui = Number(tmux("display-message", "-p", "-t", pane, "#{pane_pid}").trim());

  await sleep(SETTLE_S * 1000);
  if (!readFileSync(`/proc/${ui}/cmdline`, "utf8").includes("src/cli.ts")) throw new Error(`界面进程退出了：${readFileSync(join(WORK, "ui.err"), "utf8")}`);
  const screen = tmux("capture-pane", "-p", "-t", pane);
  if (!screen.includes(scenario === "演示" ? "find-bug" : scenario === "等待" ? "还没有 Copilot CLI" : "fix-login")) throw new Error(`界面没有画出预期的内容：\n${screen}`);
  const startTicks = cpuTicks(ui);
  const started = Date.now();
  for (let step = 5; step <= seconds; step += 5) {
    await sleep(5000);
    const elapsed = (Date.now() - started) / 1000;
    const used = (cpuTicks(ui) - startTicks) / TICKS_PER_SECOND;
    const filled = Math.round((step / seconds) * 10);
    console.log(`[${"#".repeat(filled)}${"-".repeat(10 - filled)}] ${step}/${seconds}s ${scenario} 已用 ${elapsed.toFixed(0)}s 累计占用 ${((used / elapsed) * 100).toFixed(2)}%`);
  }
  const elapsed = (Date.now() - started) / 1000;
  const percent = ((cpuTicks(ui) - startTicks) / TICKS_PER_SECOND / elapsed) * 100;
  if (process.env.CPU_PROF) {
    tmux("send-keys", "-t", pane, "q");
    await sleep(2000);
  }
  tmux("kill-server");
  rmSync(WORK, { recursive: true, force: true });
  return percent;
}

const scenarios = which === "全部" ? (["空闲", "在跑", "演示", "等待"] as const) : ([which] as ("空闲" | "在跑" | "演示" | "等待")[]);
const results: string[] = [];
try {
  for (const scenario of scenarios) {
    const percent = await measure(scenario);
    results.push(`${scenario}：${percent.toFixed(2)}%`);
    console.log(`${scenario}：CPU ${percent.toFixed(2)}%（${seconds} 秒）`);
  }
} finally {
  try {
    tmux("kill-server");
  } catch {
    // 已经关了
  }
}
console.log(`结果 ${results.join("；")}`);
