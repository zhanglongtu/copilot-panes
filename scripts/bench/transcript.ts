// 基准：很长的子 agent 过程记录画一帧要多久。运行：node scripts/bench/transcript.ts [条数，默认 10000]
// 每个场景一行，数字是毫秒。目标（1 万条）：第一帧 ≤16，之后每帧 ≤2。
import { SessionStore } from "../../src/model/store.ts";
import type { AppState, ViewData } from "../../src/types/app.ts";
import type { ListEntry } from "../../src/types/model.ts";
import { initialState } from "../../src/ui/app.ts";
import { agentRowCount } from "../../src/ui/views/agent.ts";
import { renderFrame } from "../../src/ui/views/frame.ts";
import { BASE, ev, say, started, taskCall, toolEnd, toolStart } from "../../test/model/support.ts";

const COUNT = Number(process.argv[2] ?? 10_000);
const SIZE = { cols: 80, rows: 24 };

const WORDS = "the quick brown fox jumps over the lazy dog while checking login handler tokens and session cookies in the auth module".split(" ");

function sentence(n: number, words: number): string {
  const out: string[] = [];
  for (let i = 0; i < words; i++) out.push(WORDS[(n * 7 + i * 3) % WORDS.length]!);
  return out.join(" ");
}

/** 每 5 条：一段 3 行左右的话、两次读文件、一次 grep、一条你发的消息。 */
function transcriptLines(agent: string, count: number): string[] {
  const lines = [taskCall(`t-${agent}`, null, 0), started(agent, agent, { task: `t-${agent}`, at: 0.1 }), ev("user.message", { content: "查一下登录失败的原因\n再给出修复建议" }, agent, 0.2)];
  let items = 1;
  for (let n = 0; items < count; n++) {
    const at = 1 + n * 0.01;
    switch (n % 5) {
      case 0:
        lines.push(say(agent, `${sentence(n, 30)}。${sentence(n + 1, 25)}。`, at));
        break;
      case 1:
      case 2:
        lines.push(toolStart(`v-${agent}-${n}`, "view", { path: `/work/demo/src/auth/file${n}.ts`, view_range: [1, 120] }, agent, at));
        lines.push(toolEnd(`v-${agent}-${n}`, "line\n".repeat(20), agent, at + 0.001));
        break;
      case 3:
        lines.push(toolStart(`g-${agent}-${n}`, "grep", { pattern: "refreshToken", path: "/work/demo/src" }, agent, at));
        lines.push(toolEnd(`g-${agent}-${n}`, "a.ts:1\nb.ts:2", agent, at + 0.001));
        break;
      default:
        lines.push(ev("user.message", { content: `请继续，注意 ${sentence(n, 12)}`, source: "" }, agent, at));
    }
    items++;
  }
  return lines;
}

function buildStore(agents: string[]): SessionStore {
  const store = new SessionStore("bench");
  for (const agent of agents) for (const line of transcriptLines(agent, COUNT)) store.feedLine(line);
  return store;
}

function entryOf(id: string): ListEntry {
  return {
    key: `agent:${id}`,
    kind: "agent",
    id,
    depth: 0,
    parentKey: null,
    status: "running",
    name: id,
    model: "medium-1.0",
    startedAt: BASE,
    elapsedMs: 1000,
    tokens: null,
    step: "",
    exitCode: null,
    task: null,
  };
}

function dataOf(store: SessionStore, ids: string[], now: number): ViewData {
  const entries = ids.map(entryOf);
  return {
    now,
    session: { sessionId: "bench", project: "bench", title: null },
    extension: { kind: "readonly", reason: "只读" },
    entries,
    runningCount: entries.length,
    totalTokens: null,
    store,
    terminal: null,
    sessions: [],
    bellEnabled: false,
  };
}

function ms(from: number): number {
  return performance.now() - from;
}

function stats(samples: number[]): string {
  const sorted = [...samples].sort((a, b) => a - b);
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  return `平均 ${mean.toFixed(2)}  p95 ${sorted[Math.floor(sorted.length * 0.95)]!.toFixed(2)}  最大 ${sorted[sorted.length - 1]!.toFixed(2)}`;
}

const store = buildStore(["alpha", "beta"]);
const items = store.transcript("alpha").length;
console.log(`过程记录 ${items} 条，${SIZE.cols}x${SIZE.rows}`);

const state = (key: string, extra: Partial<AppState> = {}): AppState => ({ ...initialState(), selected: key, ...extra });
let now = BASE + 60_000;

let t = performance.now();
renderFrame(state("agent:alpha"), dataOf(store, ["alpha", "beta"], now), SIZE);
console.log(`第一帧（贴底）：${ms(t).toFixed(1)} ms`);

const later: number[] = [];
for (let i = 0; i < 200; i++) {
  now += 125;
  t = performance.now();
  renderFrame(state("agent:alpha"), dataOf(store, ["alpha", "beta"], now), SIZE);
  later.push(ms(t));
}
console.log(`之后的帧（每帧换转动符号，共 200 帧）：${stats(later)}`);

const appended: number[] = [];
for (let i = 0; i < 50; i++) {
  store.feedLine(say("alpha", `新的一句 ${i}：${sentence(i, 20)}`, 2000 + i));
  now += 125;
  t = performance.now();
  renderFrame(state("agent:alpha"), dataOf(store, ["alpha", "beta"], now), SIZE);
  appended.push(ms(t));
}
console.log(`新来一条后的帧（50 次）：${stats(appended)}`);

t = performance.now();
renderFrame(state("agent:beta"), dataOf(store, ["alpha", "beta"], now), SIZE);
console.log(`另一个长记录的第一帧：${ms(t).toFixed(1)} ms`);

const switched: number[] = [];
for (let i = 0; i < 40; i++) {
  now += 125;
  t = performance.now();
  renderFrame(state(i % 2 === 0 ? "agent:alpha" : "agent:beta"), dataOf(store, ["alpha", "beta"], now), SIZE);
  switched.push(ms(t));
}
console.log(`在两个长记录之间来回切换（40 次）：${stats(switched)}`);

t = performance.now();
const total = agentRowCount(store, "alpha", { width: SIZE.cols - 2, expanded: false });
const totalMs = ms(t);
const scrolled: number[] = [];
for (let i = 0; i < 20; i++) {
  t = performance.now();
  renderFrame(state("agent:alpha", { scroll: Math.floor(total / 2) + i, scrollTotal: total }), dataOf(store, ["alpha", "beta"], now), SIZE);
  scrolled.push(ms(t));
}
console.log(`总行数 ${total}，算一次 ${totalMs.toFixed(2)} ms；翻到中间的帧（20 次）：${stats(scrolled)}`);

t = performance.now();
renderFrame(state("agent:alpha", { scroll: total, scrollTotal: total }), dataOf(store, ["alpha", "beta"], now), SIZE);
console.log(`翻到最顶的帧：${ms(t).toFixed(2)} ms`);

const expanded: number[] = [];
for (let i = 0; i < 3; i++) {
  t = performance.now();
  renderFrame(state("agent:alpha", { expanded: new Set(["agent:alpha"]) }), dataOf(store, ["alpha", "beta"], now), SIZE);
  expanded.push(ms(t));
}
console.log(`展开细节后的第一帧和之后：${expanded.map((v) => v.toFixed(1)).join(" / ")} ms`);
