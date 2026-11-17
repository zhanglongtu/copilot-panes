// copilot-panes doctor：逐项检查并给出下一步怎么做。

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ExtensionClient } from "./bridge/client.ts";
import type { BridgeState } from "./bridge/client.ts";
import { isExperimentalOn, readExtensionEnv } from "./bridge/extension-env.ts";
import { explainReadonly } from "./bridge/readonly.ts";
import { checkSocketSafety } from "./bridge/socket-safety.ts";
import { RECONNECT_MS, REQUEST_TIMEOUT_MS } from "./constants.ts";
import { locateSelf, scanCandidates } from "./discover/candidates.ts";
import { candidateScope, chooseSession } from "./discover/choose.ts";
import { ForegroundLog, logHints, titleHints } from "./discover/foreground.ts";
import { LastUserMessages } from "./discover/session-tail.ts";
import { isPidAlive, readProcTable } from "./discover/procs.ts";
import { isRegistrationLive, readRegistrations } from "./discover/registry.ts";
import { realTmux } from "./discover/tmux.ts";
import type { TmuxRunner } from "./discover/tmux.ts";
import { SessionStore } from "./model/store.ts";
import { LineTailer } from "./model/tail.ts";
import { liveTokens } from "./model/tokens.ts";
import { copilotHome, eventsPath, extensionInstallPath, settingsPath } from "./paths.ts";
import { PROTOCOL_VERSION } from "./protocol.ts";
import type { AgentUsage, Registration } from "./protocol.ts";
import { realClock, realTimers } from "./types/clock.ts";
import type { ChooseResult, ForegroundHint, SessionCandidate } from "./types/session.ts";
import { formatTokens } from "./ui/format.ts";

export interface DoctorCheck {
  /** 这一项查什么，如“实验功能”“扩展”“扩展版本”“tmux”“session”。 */
  name: string;
  ok: boolean;
  /** 可选。通过但有要留意的地方：formatDoctor 用 "!" 开头，退出码不受影响。 */
  warn?: boolean;
  /** 一句结论；不通过时写怎么修（能直接复制运行的命令）。 */
  detail: string;
}

export interface DoctorOptions {
  env: Readonly<Record<string, string | undefined>>;
  home: string;
  /** 界面自己的版本（src/version.ts）。 */
  version: string;
  dataDir: string;
  stateDir: string;
  /** 打包好的扩展（和 install 的源文件相同），用来比较装上的是不是同一个。 */
  bundledExtension: string;
  /** 默认是当前进程的 Node 版本和工作目录；测试里传固定值。 */
  nodeVersion?: string;
  cwd?: string;
  /** 默认是真的 tmux。 */
  tmux?: TmuxRunner;
  /** 默认连上每个有登记记录的扩展读一下用量；测试里关掉。 */
  probeUsage?: boolean;
}

const MIN_NODE = [22, 18] as const;
const USAGE_WAIT_MS = 2000;
const MAX_LISTED = 4;

function nodeAtLeast(version: string): boolean {
  const [major = 0, minor = 0] = version.split(".").map(Number);
  return major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]);
}

async function readBytes(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch {
    return null;
  }
}

async function checkExperimental(options: DoctorOptions): Promise<DoctorCheck> {
  const path = settingsPath(options.env, options.home);
  const fix = "在 Copilot CLI 里运行 /settings experimental on";
  const text = await readBytes(path);
  if (text === null) return { name: "实验功能", ok: false, detail: `读不到 ${path}。${fix}` };
  const enabled = isExperimentalOn(text.toString("utf8"));
  return enabled
    ? { name: "实验功能", ok: true, detail: `已打开（${path}）` }
    : { name: "实验功能", ok: false, detail: `${path} 里 experimental 不是 true。${fix}` };
}

async function checkExtension(options: DoctorOptions): Promise<DoctorCheck[]> {
  const installed = extensionInstallPath(options.env, options.home);
  const have = await readBytes(installed);
  if (have === null) {
    return [{ name: "扩展", ok: false, detail: `没装：${installed} 不存在。运行 copilot-panes install` }];
  }
  const bundled = await readBytes(options.bundledExtension);
  if (bundled === null) {
    return [
      { name: "扩展", ok: true, detail: `已装（${installed}）` },
      { name: "扩展版本", ok: true, detail: `没有打包好的扩展可比较（${options.bundledExtension} 不存在）；先在仓库里运行 npm run build` },
    ];
  }
  const same = have.equals(bundled);
  return [
    { name: "扩展", ok: true, detail: `已装（${installed}）` },
    same
      ? { name: "扩展版本", ok: true, detail: `和打包的扩展逐字节相同（界面 ${options.version}）` }
      : { name: "扩展版本", ok: false, detail: "装上的扩展和这个版本打包的不一样。运行 copilot-panes install，再重启 Copilot CLI 或让它重新加载扩展" },
  ];
}

function checkTmux(options: DoctorOptions): DoctorCheck {
  const { TMUX, TMUX_PANE } = options.env;
  if (TMUX && TMUX_PANE) return { name: "tmux", ok: true, detail: `在 tmux 里（pane ${TMUX_PANE}）；会按同一个窗口里的 Copilot CLI 选 session` };
  return { name: "tmux", ok: false, detail: "不在 tmux 里：只能按工作目录相同来选 session，复制用终端的 OSC 52，o 键直接在本终端里开 less。建议在 tmux 里运行" };
}

interface Probe {
  usage: Readonly<Record<string, AgentUsage>> | null;
  /** 探测结束时的连接状态：没连上时据此说明原因。 */
  state: BridgeState;
}

/** 连上扩展等第一份用量，最多 USAGE_WAIT_MS；连不上时 usage 是 null，state 说明停在哪。 */
function probeUsage(registration: Registration): Promise<Probe> {
  return new Promise((resolve) => {
    const client = new ExtensionClient({
      socketPath: registration.socketPath ?? "",
      expectedCopilotPid: registration.copilotPid,
      verifySocket: checkSocketSafety,
      sessionId: registration.sessionId,
      clock: realClock,
      timers: realTimers,
      reconnectMs: RECONNECT_MS,
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
    });
    const finish = (usage: Readonly<Record<string, AgentUsage>> | null) => {
      clearTimeout(timer);
      const state = client.state;
      client.stop();
      resolve({ usage, state });
    };
    const timer = setTimeout(() => finish(client.state.usage), USAGE_WAIT_MS);
    client.onChange(() => {
      if (client.state.status === "incompatible") finish(null);
      else if (client.state.usage !== null) finish(client.state.usage);
    });
    if (registration.socketPath === null) {
      finish(null);
      return;
    }
    client.start();
  });
}

/** 一个 session 里每个子 agent 开始的时刻（Unix 毫秒）和 events.jsonl 里的用量记录累加的 token（没有用量记录是 null），读不到是空表。 */
export function readAgentFacts(stateDir: string, sessionId: string): Map<string, { startedAt: number; eventTokens: number | null }> {
  const store = new SessionStore(sessionId);
  try {
    const tailer = new LineTailer(eventsPath(stateDir, sessionId));
    for (;;) {
      const chunk = tailer.read();
      for (const line of chunk.lines) store.feedLine(line);
      if (!chunk.more) break;
    }
  } catch {
    // 读不到事件：下面当作没有可以核对的子 agent
  }
  return new Map(store.agents().map((agent) => [agent.id, { startedAt: agent.startedAt, eventTokens: agent.eventTokens ?? null }]));
}

/** 一个 session 里每个子 agent 开始的时刻（Unix 毫秒），读 events.jsonl 得出；读不到是空表。 */
export function readAgentStarts(stateDir: string, sessionId: string): Map<string, number> {
  return new Map([...readAgentFacts(stateDir, sessionId)].map(([id, facts]) => [id, facts.startedAt]));
}

/**
 * 核对扩展累加的用量。扩展只累加它在场期间的调用，所以只拿扩展加载之后才开始的子 agent 核对（更早的累加值本来就不全）。
 * 有 eventTokens（events.jsonl 里各条用量记录累加的自己的用量，全程各轮）时，拿累加值和它比：两边口径相同、都含追加消息后的几轮，
 * 差超过 5% 才算不一致。没有 eventTokens（较早版本的 Copilot CLI 写的日志）时，只能和完成事件里的 totalTokens 比，而它含下级、也不含完成之后又跑的几轮：
 * 累加值比它大不算不一致，只有比它小超过 5% 才算。
 */
export function checkUsage(
  usage: Readonly<Record<string, AgentUsage>>,
  agentStartedAt: ReadonlyMap<string, number>,
  extensionStartedAt: number,
  eventTokens?: ReadonlyMap<string, number>,
): { warn: boolean; detail: string } {
  const reported = Object.entries(usage).filter(([, entry]) => entry.reportedTotalTokens !== undefined);
  if (reported.length === 0) return { warn: false, detail: `正常。有 ${Object.keys(usage).length} 个子 agent 的累加用量，还没有结束的可以核对 totalTokens` };
  const comparable = reported.filter(([id]) => (agentStartedAt.get(id) ?? Number.NEGATIVE_INFINITY) >= extensionStartedAt);
  const earlier = reported.length - comparable.length;
  const before = earlier > 0 ? `（另有 ${earlier} 个在扩展加载之前就开始了，累加值不全，没法核对）` : "";
  if (comparable.length === 0) return { warn: false, detail: "正常。扩展是在这些子 agent 结束之后才加载的，token 的累加值没法核对" };
  if (eventTokens !== undefined) {
    const withEvents = comparable.filter(([id]) => eventTokens.has(id));
    if (withEvents.length === 0) return { warn: false, detail: `正常。events.jsonl 里没有这些子 agent 的用量记录，token 的累加值没法核对${before}` };
    const off = withEvents.filter(([id, entry]) => Math.abs(liveTokens(entry) - eventTokens.get(id)!) > eventTokens.get(id)! * 0.05);
    if (off.length === 0) return { warn: false, detail: `正常。${withEvents.length} 个子 agent 的 token 累加值和 events.jsonl 里的用量记录一致（追加消息后多跑的几轮两边都算）${before}` };
    const sample = off
      .slice(0, 3)
      .map(([id, entry]) => `累加 ${formatTokens(liveTokens(entry))} / 用量记录 ${formatTokens(eventTokens.get(id)!)}`)
      .join("；");
    return { warn: true, detail: `扩展加载之后才开始的 ${withEvents.length} 个子 agent 里 ${off.length} 个累加值和 events.jsonl 里的用量记录差超过 5%（${sample}）${before}` };
  }
  const off = comparable.filter(([, entry]) => liveTokens(entry) < (entry.reportedTotalTokens ?? 0) * 0.95);
  if (off.length === 0) return { warn: false, detail: `正常。${comparable.length} 个子 agent 的 token 累加值不比 Copilot CLI 报的 totalTokens 小${before}` };
  const sample = off
    .slice(0, 3)
    .map(([, entry]) => `累加 ${formatTokens(liveTokens(entry))} / 事件 ${formatTokens(entry.reportedTotalTokens ?? 0)}`)
    .join("；");
  return { warn: true, detail: `扩展加载之后才开始的 ${comparable.length} 个子 agent 里 ${off.length} 个累加值比 totalTokens 小超过 5%（${sample}）。界面取各个数里最大的显示${before}` };
}

const REASONS = {
  explicit: "命令行 --session 指定的",
  pinned: "你在界面里按 s 手选的",
  foreground: "Copilot CLI 现在正看着它",
  "last-message": "你最近在它里面发过言（没有前台线索）",
  "last-event": "它最近有动静（没有前台线索，也没人发过言）",
  stay: "当前这个还在用",
} as const;

const SCOPES = { tmux: "在同一个 tmux 窗口里", cwd: "工作目录和这里相同" } as const;

function pickReason(chosen: Extract<ChooseResult, { kind: "session" }>): string {
  const how = chosen.reason === "foreground" ? (chosen.via === "log" ? "，依据 Copilot CLI 进程日志" : "，依据 tmux pane 标题") : "";
  const scope = chosen.scopeBy === null ? "" : `（候选范围：${SCOPES[chosen.scopeBy]}）`;
  return `${REASONS[chosen.reason]}${how}${scope}`;
}

function describeCandidate(candidate: SessionCandidate): string {
  const id = candidate.sessionId.slice(0, 8);
  const title = candidate.title ? ` ${candidate.title}` : "";
  const how = candidate.registration ? "有扩展登记" : "没有扩展登记";
  return `${id}${title}（${how}，Copilot CLI 进程 ${candidate.copilotPid ?? "?"}）`;
}

/**
 * 检查：
 * - Node 版本。
 * - settings.json 里 experimental 为 true（读不到或不是 true：提示在 Copilot CLI 里运行 /settings experimental on）。
 * - 扩展装了没有（extensionInstallPath 存在），和 bundledExtension 是否逐字节相同（不同：提示运行 copilot-panes install）。
 * - 有效的登记记录里的 extensionVersion、protocol 是否和自己一致。
 * - 在不在 tmux 里（TMUX、TMUX_PANE）。
 * - 找到了哪些 session（scanCandidates、chooseSession 的结果），各自有没有扩展在工作；有用量数据时列出累加值和 reportedTotalTokens 的对比。
 */
export async function runDoctor(options: DoctorOptions): Promise<DoctorCheck[]> {
  const nodeVersion = options.nodeVersion ?? process.versions.node;
  const checks: DoctorCheck[] = [
    nodeAtLeast(nodeVersion)
      ? { name: "Node 版本", ok: true, detail: `${nodeVersion}（需要 ${MIN_NODE.join(".")} 以上）` }
      : { name: "Node 版本", ok: false, detail: `${nodeVersion} 太旧，需要 ${MIN_NODE.join(".")} 以上。升级 Node 后重试` },
    checkTmux(options),
    await checkExperimental(options),
    ...(await checkExtension(options)),
  ];

  const now = realClock.now();
  const registrations = readRegistrations(options.dataDir);
  const live = registrations.filter((registration) => isRegistrationLive(registration, now, (pid) => isPidAlive(pid)));
  checks.push({
    name: "登记记录",
    ok: live.length > 0,
    detail:
      live.length > 0
        ? `${live.length} 条有效（共 ${registrations.length} 条）：${live.map((r) => `${r.sessionId.slice(0, 8)} 扩展 ${r.extensionVersion}`).join("，")}`
        : `没有有效的登记记录（共 ${registrations.length} 条）。扩展没加载或还没启动：装好扩展并重启 Copilot CLI 后，应该有一条`,
  });
  const mismatched = live.filter((r) => r.extensionVersion !== options.version || r.protocol !== PROTOCOL_VERSION);
  if (live.length > 0) {
    checks.push(
      mismatched.length === 0
        ? { name: "扩展和界面的版本", ok: true, detail: `扩展 ${options.version}、协议 ${PROTOCOL_VERSION}，一致` }
        : { name: "扩展和界面的版本", ok: false, detail: `${mismatched.length} 个扩展的版本或协议和界面（${options.version}、协议 ${PROTOCOL_VERSION}）不一致。运行 copilot-panes install，再重启 Copilot CLI` },
    );
  }

  const procTable = readProcTable();
  const scanned = scanCandidates({ dataDir: options.dataDir, stateDir: options.stateDir, now, isPidAlive: (pid) => isPidAlive(pid), procTable });
  const pane = options.env.TMUX && options.env.TMUX_PANE ? options.env.TMUX_PANE : null;
  const tmux = options.tmux ?? realTmux();
  const self = await locateSelf({ cwd: options.cwd ?? process.cwd(), tmuxPane: pane, run: tmux, procTable });
  // 和界面选 session 用同样的输入：范围里每个 session 的最近发言，以及前台线索（进程日志、pane 标题）
  const inScope = candidateScope(scanned, self).scope;
  const messages = new LastUserMessages();
  const candidates = scanned.map((candidate) =>
    inScope.some((c) => c.sessionId === candidate.sessionId) ? { ...candidate, lastUserMessageAt: messages.lastAt(eventsPath(options.stateDir, candidate.sessionId)) } : candidate,
  );
  const pids = [...new Set(inScope.map((c) => c.copilotPid).filter((pid): pid is number => pid !== null))];
  const hints: ForegroundHint[] = [
    ...logHints(pids, new ForegroundLog(join(copilotHome(options.env, options.home), "logs")), now),
    ...(await titleHints(self.tmux?.panesByPid ?? {}, pids, tmux)),
  ];
  const chosen = chooseSession({ candidates, explicitId: null, self, current: null, foreground: hints });
  if (candidates.length === 0) {
    checks.push({ name: "session", ok: false, detail: "没找到正在运行的 Copilot CLI session。先在另一个 pane 里运行 copilot" });
  } else {
    const shown = candidates.slice(0, MAX_LISTED).map(describeCandidate).join("；");
    const list = candidates.length > MAX_LISTED ? `${shown}；另有 ${candidates.length - MAX_LISTED} 个` : shown;
    const pick =
      chosen.kind === "session"
        ? `会选 ${chosen.sessionId.slice(0, 8)}：${pickReason(chosen)}`
        : "但没有一个在同一个 tmux 窗口或相同的工作目录里，界面会显示等待画面。到 Copilot CLI 所在的目录或窗口里运行";
    checks.push({ name: "session", ok: chosen.kind === "session", detail: `找到 ${candidates.length} 个：${list}。${pick}` });
  }
  // 会选的那个 session 没有登记记录：说明为什么没有扩展，和界面顶行下面的提示同一句话
  const picked = chosen.kind === "session" ? candidates.find((candidate) => candidate.sessionId === chosen.sessionId) : undefined;
  if (picked && picked.registration === null) {
    const why = explainReadonly({ registered: false, bridge: null, env: readExtensionEnv(options.env, options.home), now });
    if (why !== null) checks.push({ name: `扩展 ${picked.sessionId.slice(0, 8)}`, ok: false, detail: `${why.notice.text}（这个 session 没有登记记录）` });
  }

  if (options.probeUsage !== false) {
    for (const registration of live) {
      const { usage, state } = await probeUsage(registration);
      const id = registration.sessionId.slice(0, 8);
      if (usage !== null) {
        const facts = readAgentFacts(options.stateDir, registration.sessionId);
        const starts = new Map([...facts].map(([agentId, f]) => [agentId, f.startedAt]));
        const events = new Map([...facts].flatMap(([agentId, f]) => (f.eventTokens === null ? [] : [[agentId, f.eventTokens] as const])));
        checks.push({ name: `扩展连接 ${id}`, ok: true, ...checkUsage(usage, starts, registration.startedAt, events) });
        continue;
      }
      // 没连上：和界面一样说明原因（版本不一致、没通过安全检查、连不上）
      const why = explainReadonly({
        registered: true,
        noSocket: registration.socketPath === null,
        bridge: registration.socketPath === null ? null : state,
        env: readExtensionEnv(options.env, options.home),
        now: realClock.now(),
        settled: true,
      });
      checks.push({ name: `扩展连接 ${id}`, ok: false, detail: why?.notice.text ?? "没拿到用量数据，但连接没有问题。再运行一次 copilot-panes doctor" });
    }
  }
  return checks;
}

/** 排成给人看的文字：每项一行，“✓ 名称：结论”、“! 名称：结论”（通过但有要留意的）或“✗ 名称：结论”。 */
export function formatDoctor(checks: readonly DoctorCheck[]): string {
  return checks.map((check) => `${check.ok ? (check.warn === true ? "!" : "✓") : "✗"} ${check.name}：${check.detail}`).join("\n");
}
