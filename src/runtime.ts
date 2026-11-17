// 把所有部分接起来跑：终端、输入解析、找 session、读事件、读命令输出、连扩展、状态机、视图、输出层。
//
// 全部由事件和定时器驱动，没有忙等：
// - stdin（raw 模式）→ InputParser → update → 执行动作 → 请求重画。
// - 重新找 session：没接上时每 DISCOVER_WAITING_MS，接上了活着的每 DISCOVER_STEADY_MS，接上的已经结束每 DISCOVER_FOLLOW_MS；换 session 时新建 SessionFeed。
// - 每 POLL_MS 读一次 events.jsonl 和要看的命令的 .out；有变化就请求重画。
// - 有在跑的条目时每 SPINNER_FRAME_MS 喂一次 tick（转动符号、用时），否则只在有提示等着到期时喂；FrameScheduler 限制每秒最多约 30 帧。
// - stdout 的 resize 事件：Screen.invalidate、终端模拟器跟着改尺寸、重画。
// - 退出（q、两次 Ctrl+C、SIGINT、SIGTERM、SIGHUP、未捕获的异常）：恢复终端、停掉扩展客户端。

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { cwd as processCwd } from "node:process";
import {
  DISCOVER_FOLLOW_MS,
  DISCOVER_STEADY_MS,
  DISCOVER_WAITING_MS,
  ESC_TIMEOUT_MS,
  EXTENSION_ENV_REFRESH_MS,
  FOREGROUND_CHECK_MS,
  FRAME_MIN_INTERVAL_MS,
  LOCATE_SELF_REFRESH_MS,
  OTHER_SESSIONS_REFRESH_MS,
  SPINNER_FRAME_MS,
  SWITCH_NOTICE_MS,
} from "./constants.ts";
import { readExtensionEnv } from "./bridge/extension-env.ts";
import type { ExtensionEnv } from "./bridge/extension-env.ts";
import { isPidAlive, readProcTable } from "./discover/procs.ts";
import { candidateScope, chooseSession, switchNotice } from "./discover/choose.ts";
import { locateSelf, readWorkspace, resolveSessionArg, scanCandidates } from "./discover/candidates.ts";
import { ForegroundLog, hintsSignature, logHints, titleHints } from "./discover/foreground.ts";
import { LastUserMessages, SessionActivity } from "./discover/session-tail.ts";
import { LazyProcTable } from "./discover/lazy-procs.ts";
import { realTmux } from "./discover/tmux.ts";
import { DemoSession } from "./demo-live.ts";
import { DEMO_COPILOT_PID, DEMO_CWD, DEMO_KEYS, DEMO_SESSION_ID, DEMO_TITLE } from "./demo-script.ts";
import { markOrphaned } from "./model/orphans.ts";
import { copyText, openPager, openPagerInline, removePagerFile, writePagerFile } from "./effects.ts";
import { RealSession, SessionFeed } from "./feed.ts";
import { copilotHome, eventsPath, scratchDir } from "./paths.ts";
import type { AppEffect, AppInput, AppState, ExtensionState, SessionChoice, SessionHeader, ViewData } from "./types/app.ts";
import { realClock, realTimers } from "./types/clock.ts";
import type { Clock, Timers } from "./types/clock.ts";
import { parseEntryKey } from "./types/model.ts";
import type { EntryKey, ListEntry } from "./types/model.ts";
import type { InputEvent, Size, Theme, ThemeName } from "./types/ui.ts";
import { SEQ } from "./ui/ansi.ts";
import { initialState, update } from "./ui/app.ts";
import { InputParser } from "./ui/keys.ts";
import { FrameScheduler, installTerminalGuard, Screen } from "./ui/output.ts";
import { detectTheme } from "./ui/theme.ts";
import { agentPlainText } from "./ui/views/agent.ts";
import { renderFrame } from "./ui/views/frame.ts";
import { computeLayout } from "./ui/views/layout.ts";
import type { ChooseResult, SelfLocation, SessionCandidate } from "./types/session.ts";

export interface RuntimeOptions {
  /** --session 指定的 ID；没指定是 null。 */
  sessionId: string | null;
  stateDir: string;
  dataDir: string;
  /** --light 或 --dark；null 时看环境变量、问终端背景色、COLORFGBG，默认深色。 */
  themeFlag: ThemeName | null;
  bell: boolean;
  /** --demo：用 src/demo-live.ts 的样本数据，不找 session、不连扩展。 */
  demo: boolean;
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
  stderr?: NodeJS.WriteStream;
  env: Readonly<Record<string, string | undefined>>;
  /** 测试用：换掉真的时钟和定时器。 */
  clock?: Clock;
  timers?: Timers;
}

/** 读事件和命令输出的间隔。 */
const POLL_MS = 200;
const NOTICE_TICK_MS = 250;
const IDLE_TICK_MS = 1000;
/** 查 Copilot CLI 进程还在不在的间隔：比找 session 的间隔短，进程一没就能发现。 */
const PROCESS_CHECK_MS = 1000;

/** 进程还在跑：/proc/<pid> 在，并且不是已经退出、等着被回收的僵尸。 */
function processRunning(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const state = stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3);
    return state !== "Z" && state !== "X";
  } catch {
    return false;
  }
}

const SIGNAL_NUMBER = { SIGINT: 2, SIGTERM: 15, SIGHUP: 1 } as const;

/** 运行界面直到退出，返回进程退出码（正常退出是 0）。stdout 不是终端时打印一句说明并返回 1。 */
export async function runApp(options: RuntimeOptions): Promise<number> {
  const { stdin, stdout, env } = options;
  const stderr = options.stderr ?? process.stderr;
  if (!stdout.isTTY) {
    stderr.write("copilot-panes 要在终端里运行：标准输出不是终端。请在 tmux 的一个 pane 里直接运行 copilot-panes。\n");
    return 1;
  }
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
    stderr.write("copilot-panes 要在终端里运行：标准输入不是终端。\n");
    return 1;
  }
  // --session 可以只写 ID 的前几位：在画界面之前认出是哪个，认不出就直接报错退出
  let sessionId = options.sessionId;
  if (sessionId !== null && !options.demo) {
    const resolved = resolveSessionArg(options.stateDir, sessionId);
    if (!resolved.ok) {
      stderr.write(`${resolved.error}\n`);
      return 2;
    }
    sessionId = resolved.sessionId;
  }
  const clock = options.clock ?? realClock;
  const timers = options.timers ?? realTimers;

  stdin.setRawMode(true);
  stdin.setEncoding("utf8");
  stdin.resume();
  const theme = await detectTheme({
    flag: options.themeFlag,
    env,
    timers,
    probe: {
      write: (data) => void stdout.write(data),
      onData: (listener) => {
        stdin.on("data", listener);
        return () => void stdin.off("data", listener);
      },
    },
  });

  const screen = new Screen(stdout, theme);
  let finish: (code: number) => void = () => {};
  const exited = new Promise<number>((resolve) => {
    finish = resolve;
  });
  const uninstallGuard = installTerminalGuard(screen, { onSignal: (signal) => finish(128 + SIGNAL_NUMBER[signal]) });
  screen.enter();

  const runtime = new Runtime({ ...options, sessionId, theme, clock, timers, screen, finish });
  runtime.start();
  const code = await exited;
  runtime.stop();
  screen.leave();
  uninstallGuard();
  stdin.setRawMode(false);
  stdin.pause();
  return code;
}

interface RuntimeDeps extends RuntimeOptions {
  theme: Theme;
  clock: Clock;
  timers: Timers;
  screen: Screen;
  finish: (code: number) => void;
}

/** 主循环的全部状态。runApp 之外只有测试会直接用它。 */
export class Runtime {
  readonly #deps: RuntimeDeps;
  readonly #parser = new InputParser();
  readonly #scheduler: FrameScheduler;
  #state: AppState = initialState();
  #size: Size;
  #feed: SessionFeed | null = null;
  #candidates: SessionCandidate[] = [];
  #scope: readonly string[] = [];
  #pinned: string | null = null;
  #lastSignature = "";
  #lastData: ViewData | null = null;
  /** 每个 session 的名字和工作目录（workspace.yaml），找 session 时刷新，不在每一帧里读文件。 */
  #workspaces = new Map<string, { cwd: string | null; name: string | null }>();
  #choiceList: SessionChoice[] = [];
  #pollTimer: unknown = null;
  #discoverTimer: unknown = null;
  #escTimer: unknown = null;
  #tickTimer: unknown = null;
  #tickDelay = 0;
  /** 演示的第一屏要固定（选中 fix-login、review 有未读的点，仍然跟随最新）：状态机第一次看到数据之后改一次状态。 */
  #demoStart = false;
  #discovering = false;
  /** 界面自己的位置（同窗口的 Copilot CLI 进程号）：要读全部进程和问 tmux，所以缓存，见 #locate。 */
  #self: { value: SelfLocation; at: number; key: string } | null = null;
  #processCheck: { pid: number; at: number; running: boolean } | null = null;
  #foregroundLog: ForegroundLog;
  #userMessages = new LastUserMessages();
  #activity = new SessionActivity();
  /** 候选范围里每个 session 现在大约有几个条目在跑（读 events.jsonl 末尾，见 #refreshActivity）。 */
  #runningBySession = new Map<string, number>();
  #activityAt = Number.NEGATIVE_INFINITY;
  /** 上一次找 session 时的日志线索；日志里的前台 session 变了就马上再找一次。 */
  #logSignature = "";
  #scopePids: number[] = [];
  #foregroundTimer: unknown = null;
  #extensionEnv: { sessionId: string; at: number; value: ExtensionEnv } | null = null;
  #stopped = false;
  #pagerOpen = false;
  #onData: ((chunk: string) => void) | null = null;
  #onGone: (() => void) | null = null;
  #onResize: (() => void) | null = null;

  constructor(deps: RuntimeDeps) {
    this.#deps = deps;
    this.#foregroundLog = new ForegroundLog(join(copilotHome(deps.env, homedir()), "logs"));
    this.#size = this.#measure();
    this.#scheduler = new FrameScheduler(() => this.#draw(), deps.clock, deps.timers, FRAME_MIN_INTERVAL_MS);
  }

  #measure(): Size {
    const { stdout } = this.#deps;
    return { cols: Math.max(1, stdout.columns || 80), rows: Math.max(1, stdout.rows || 24) };
  }

  start(): void {
    const { stdin, stdout, timers, demo } = this.#deps;
    this.#onData = (chunk) => {
      for (const event of this.#parser.feed(chunk)) this.#onInput(event);
      this.#armEscape();
    };
    stdin.on("data", this.#onData);
    // 终端没了（pane 被关掉）：stdin 结束或 stdout 报错，没有人在看了，直接退出
    this.#onGone = () => this.#deps.finish(0);
    stdin.on("end", this.#onGone);
    stdout.on("error", this.#onGone);
    this.#onResize = () => {
      this.#size = this.#measure();
      this.#deps.screen.invalidate();
      this.#request();
    };
    stdout.on("resize", this.#onResize);

    if (demo) this.#openDemo();
    else void this.#discover().finally(() => this.#scheduleDiscover());
    if (!demo) this.#scheduleForeground();
    this.#pollTimer = timers.setInterval(() => this.#pollFeed(), POLL_MS);
    this.#scheduleTick();
    this.#request();
  }

  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    const { stdin, stdout, timers } = this.#deps;
    if (this.#onData) stdin.off("data", this.#onData);
    if (this.#onGone) {
      stdin.off("end", this.#onGone);
      stdout.off("error", this.#onGone);
    }
    if (this.#onResize) stdout.off("resize", this.#onResize);
    if (this.#pollTimer !== null) timers.clearInterval(this.#pollTimer);
    if (this.#discoverTimer !== null) timers.clearTimeout(this.#discoverTimer);
    if (this.#foregroundTimer !== null) timers.clearTimeout(this.#foregroundTimer);
    if (this.#escTimer !== null) timers.clearTimeout(this.#escTimer);
    if (this.#tickTimer !== null) timers.clearTimeout(this.#tickTimer);
    this.#scheduler.stop();
    this.#feed?.close();
    this.#feed = null;
  }

  // ───── session ─────

  #openDemo(): void {
    const session = new DemoSession(this.#deps.clock, this.#deps.timers);
    session.start();
    this.#demoStart = true;
    this.#candidates = [
      { sessionId: DEMO_SESSION_ID, copilotPid: DEMO_COPILOT_PID, tmuxPane: null, cwd: DEMO_CWD, title: DEMO_TITLE, lastEventAt: this.#deps.clock.now(), registration: null, source: "registration" },
    ];
    this.#scope = [DEMO_SESSION_ID];
    this.#feed = new SessionFeed(session, { clock: this.#deps.clock, onChange: () => this.#request() });
    this.#feed.poll();
    this.#refreshWorkspaces();
  }

  #candidateOf(sessionId: string): SessionCandidate | undefined {
    return this.#candidates.find((candidate) => candidate.sessionId === sessionId);
  }

  #switchTo(sessionId: string): void {
    this.#feed?.close();
    const candidate = this.#candidateOf(sessionId);
    const io = new RealSession({
      sessionId,
      stateDir: this.#deps.stateDir,
      dataDir: this.#deps.dataDir,
      copilotPid: candidate?.copilotPid ?? null,
      clock: this.#deps.clock,
      timers: this.#deps.timers,
    });
    this.#feed = new SessionFeed(io, { clock: this.#deps.clock, onChange: () => this.#request() });
    this.#lastSignature = "";
    this.#feed.poll();
    this.#refreshWorkspaces();
  }

  /** 找一次 session：有变化时换过去；当前 session 的登记记录变了就重连扩展。 */
  async #discover(): Promise<void> {
    if (this.#discovering || this.#stopped || this.#deps.demo) return;
    this.#discovering = true;
    try {
      const { clock, dataDir, stateDir, env, sessionId } = this.#deps;
      const now = clock.now();
      const scanned = scanCandidates({ dataDir, stateDir, now, isPidAlive: (pid) => isPidAlive(pid), procTable: new LazyProcTable() });
      const pane = env.TMUX && env.TMUX_PANE ? env.TMUX_PANE : null;
      const self = await this.#locate(pane, scanned, now);
      if (this.#stopped) return;
      // 用户最近一次发言和前台线索只对候选范围里的 session 读：别的窗口的 Copilot CLI 与这里无关
      const inScope = new Set(candidateScope(scanned, self).scope.map((candidate) => candidate.sessionId));
      const candidates = scanned.map((candidate) =>
        inScope.has(candidate.sessionId) ? { ...candidate, lastUserMessageAt: this.#userMessages.lastAt(eventsPath(stateDir, candidate.sessionId)) } : candidate,
      );
      this.#scopePids = [...new Set(scanned.filter((candidate) => inScope.has(candidate.sessionId) && candidate.copilotPid !== null).map((candidate) => candidate.copilotPid!))];
      const hints = [...logHints(this.#scopePids, this.#foregroundLog, now), ...(await titleHints(self.tmux?.panesByPid ?? {}, this.#scopePids, realTmux()))];
      if (this.#stopped) return;
      this.#logSignature = hintsSignature(hints.filter((hint) => hint.kind === "log"));
      this.#candidates = candidates;
      const feed = this.#feed;
      const current = feed ? { sessionId: feed.io.sessionId, pinned: this.#pinned === feed.io.sessionId, lastEventAt: feed.store.lastEventAt } : null;
      const result = chooseSession({ candidates, explicitId: sessionId, self, current, foreground: hints });
      if (result.kind === "session") {
        this.#scope = result.scope;
        if (!feed || feed.io.sessionId !== result.sessionId) {
          this.#switchTo(result.sessionId);
          if (feed) this.#announceSwitch(feed.io.sessionId, result);
        }
        const registration = this.#candidateOf(result.sessionId)?.registration ?? null;
        const io = this.#feed?.io;
        if (io instanceof RealSession) io.bridge.target(registration);
      } else {
        this.#scope = [];
        // 当前的 session 结束了、又没有别的：留着最后的画面，等下一个出现。
      }
      this.#refreshActivity(now, true);
      this.#refreshWorkspaces();
      this.#request();
    } catch {
      // 这一轮没找成（/proc 读不了等）：留着现在的画面，下一轮再试
    } finally {
      this.#discovering = false;
    }
  }

  /** 自动换了 session（不是命令行指定或手选的）：提示换到了哪个、为什么。 */
  #announceSwitch(previousId: string, result: Extract<ChooseResult, { kind: "session" }>): void {
    if (result.reason === "explicit" || result.reason === "pinned") return;
    const title = this.#candidateOf(result.sessionId)?.title ?? result.sessionId.slice(0, 8);
    this.#notify(switchNotice(title, result.reason, !result.scope.includes(previousId)), "info", SWITCH_NOTICE_MS);
  }

  #scheduleForeground(): void {
    if (this.#deps.demo || this.#stopped) return;
    this.#foregroundTimer = this.#deps.timers.setTimeout(() => {
      this.#checkForeground();
      this.#scheduleForeground();
    }, FOREGROUND_CHECK_MS);
  }

  /** 日志里的前台 session 变了（用户在 Copilot CLI 里切了 session）：不等下一轮，马上重新找。 */
  #checkForeground(): void {
    if (this.#feed === null || this.#discovering || this.#stopped) return;
    try {
      const signature = hintsSignature(logHints(this.#scopePids, this.#foregroundLog, this.#deps.clock.now()));
      if (signature !== this.#logSignature) void this.#discover();
    } catch {
      // 读不了日志：下一轮再试
    }
  }

  /** 候选范围里每个 session 大约有几个条目在跑。force 为 false 时隔 OTHER_SESSIONS_REFRESH_MS 才重读。 */
  #refreshActivity(now: number, force: boolean): void {
    if (!force && now >= this.#activityAt && now - this.#activityAt < OTHER_SESSIONS_REFRESH_MS) return;
    this.#activityAt = now;
    const counts = new Map<string, number>();
    for (const id of this.#scope) counts.set(id, this.#activity.running(eventsPath(this.#deps.stateDir, id), id, now));
    this.#runningBySession = counts;
  }

  /** 扩展装了没有、实验功能开了没有：换 session 时查一次，之后每 EXTENSION_ENV_REFRESH_MS 查一次。 */
  #readExtensionEnv(sessionId: string, now: number): ExtensionEnv {
    const cached = this.#extensionEnv;
    if (cached !== null && cached.sessionId === sessionId && now >= cached.at && now - cached.at < EXTENSION_ENV_REFRESH_MS) return cached.value;
    const value = readExtensionEnv(this.#deps.env, homedir());
    this.#extensionEnv = { sessionId, at: now, value };
    return value;
  }

  /**
   * 这个 session 的 Copilot CLI 进程已经不在：当前 session 不是候选（没有有效的登记记录，也没有活着的锁文件进程），
   * 或者候选里记的进程已经退出。Copilot CLI 被强行结束时来不及写 session.shutdown，只能靠这个知道。演示不算。
   */
  #sessionEnded(feed: SessionFeed, now: number): boolean {
    if (this.#deps.demo) return false;
    const pid = this.#candidateOf(feed.io.sessionId)?.copilotPid;
    if (pid === undefined) return true;
    if (pid === null) return false;
    const last = this.#processCheck;
    if (last === null || last.pid !== pid || now - last.at >= PROCESS_CHECK_MS || now < last.at) {
      this.#processCheck = { pid, at: now, running: processRunning(pid) };
    }
    return !this.#processCheck!.running;
  }

  /**
   * 界面自己在哪。不在 tmux 里不用读进程；在 tmux 里要读全部进程才能找到同窗口 pane 里的 Copilot CLI（约 40 毫秒），
   * 所以只在候选 session 的进程变了（有新的 Copilot CLI 起来或退出）或隔了 LOCATE_SELF_REFRESH_MS 之后才重量，其余沿用上一次。
   */
  async #locate(pane: string | null, candidates: readonly SessionCandidate[], now: number): Promise<SelfLocation> {
    const cwd = processCwd();
    if (pane === null) return { cwd, tmux: null };
    const key = candidates.map((candidate) => `${candidate.sessionId}:${candidate.copilotPid}`).join(",");
    const cached = this.#self;
    if (cached !== null && cached.key === key && now - cached.at < LOCATE_SELF_REFRESH_MS && now >= cached.at) return cached.value;
    const value = await locateSelf({ cwd, tmuxPane: pane, run: realTmux(), procTable: readProcTable() });
    this.#self = { value, at: now, key };
    return value;
  }

  /** 没接上 session 时每秒找；接上了但它已经结束时每 2 秒找；接上了活着的 session，找到的东西很少变，每 5 秒找。 */
  #discoverDelay(): number {
    const feed = this.#feed;
    if (!feed) return DISCOVER_WAITING_MS;
    return this.#sessionEnded(feed, this.#deps.clock.now()) ? DISCOVER_FOLLOW_MS : DISCOVER_STEADY_MS;
  }

  #scheduleDiscover(): void {
    if (this.#deps.demo || this.#stopped) return;
    this.#discoverTimer = this.#deps.timers.setTimeout(() => {
      void this.#discover().finally(() => this.#scheduleDiscover());
    }, this.#discoverDelay());
  }

  // ───── 读数据 ─────

  #pollFeed(): void {
    const feed = this.#feed;
    if (!feed) return;
    if (feed.poll()) this.#request();
    if (feed.more) setImmediate(() => this.#pollFeed());
  }

  // ───── 画面 ─────

  #request(): void {
    if (!this.#stopped) this.#scheduler.request();
  }

  #refreshWorkspaces(): void {
    const ids = new Set(this.#scope);
    if (this.#feed) ids.add(this.#feed.io.sessionId);
    for (const id of ids) {
      const candidate = this.#candidateOf(id);
      this.#workspaces.set(id, candidate ? { cwd: candidate.cwd, name: candidate.title } : readWorkspace(this.#deps.stateDir, id));
    }
    const currentId = this.#feed?.io.sessionId ?? null;
    this.#choiceList = this.#scope.map((id) => ({
      sessionId: id,
      title: this.#workspaces.get(id)?.name ?? null,
      cwd: this.#workspaces.get(id)?.cwd ?? null,
      lastEventAt: this.#candidateOf(id)?.lastEventAt ?? 0,
      current: id === currentId,
    }));
  }

  /** s 键的列表。currentRunning 是当前 session 名单上在跑的条目数（其他 session 的数是粗略读 events.jsonl 末尾得出的）。 */
  #choices(currentRunning: number | null = null): SessionChoice[] {
    const feed = this.#feed;
    return this.#choiceList.map((choice) => {
      if (feed && choice.current) {
        return { ...choice, lastEventAt: Math.max(choice.lastEventAt, feed.store.lastEventAt), ...(currentRunning === null ? {} : { runningCount: currentRunning }) };
      }
      const running = this.#runningBySession.get(choice.sessionId);
      return running === undefined ? choice : { ...choice, runningCount: running };
    });
  }

  /** 同一个候选范围里其他 session 的个数和它们大约一共有几个条目在跑；没有其他 session 是 null。 */
  #otherSessions(currentId: string): { sessions: number; running: number } | null {
    const others = this.#scope.filter((id) => id !== currentId);
    if (others.length === 0) return null;
    return { sessions: others.length, running: others.reduce((sum, id) => sum + (this.#runningBySession.get(id) ?? 0), 0) };
  }

  #header(feed: SessionFeed): SessionHeader {
    const id = feed.io.sessionId;
    const workspace = this.#workspaces.get(id);
    const cwd = feed.store.cwd ?? workspace?.cwd ?? null;
    return { sessionId: id, project: cwd ? basename(cwd) || cwd : id.slice(0, 8), title: workspace?.name ?? null };
  }

  /** 组装 ViewData；顺便让终端模拟器和选中、在跑的命令、内容区的尺寸一致。 */
  #buildData(now: number): ViewData {
    const feed = this.#feed;
    const bellEnabled = this.#deps.bell;
    if (!feed) {
      return {
        now,
        session: null,
        extension: { kind: "readonly", reason: "只读：扩展没有加载" },
        entries: [],
        runningCount: 0,
        totalTokens: null,
        store: null,
        terminal: null,
        sessions: this.#choices(),
        bellEnabled,
        statusNotice: null,
        otherSessions: null,
      };
    }
    this.#refreshActivity(now, false);
    const selected = this.#state.selected;
    const ended = this.#sessionEnded(feed, now);
    const listed = feed.entries(now, this.#state.collapseEnded, selected ? new Set([selected]) : new Set());
    const entries = ended ? markOrphaned(listed, feed.store) : listed;
    const runningCount = entries.filter((entry) => entry.status === "running").length;
    const why = feed.explainReadonly(this.#readExtensionEnv(feed.io.sessionId, now), now);
    const extension: ExtensionState = why === null ? { kind: "connected" } : { kind: "readonly", reason: why.reason, cause: why.cause };
    const base: ViewData = {
      now,
      session: this.#header(feed),
      extension,
      entries,
      runningCount,
      totalTokens: feed.totalTokens(),
      store: feed.store,
      terminal: null,
      sessions: this.#choices(runningCount),
      bellEnabled,
      sessionEnded: ended,
      statusNotice: ended || why === null ? null : why.notice,
      otherSessions: this.#otherSessions(feed.io.sessionId),
    };
    const layout = computeLayout(this.#state, base, this.#size);
    feed.syncTerminals(wantedTerminals(entries, selected), Math.max(2, this.#size.cols - 2), Math.max(1, layout.contentRows));
    const picked = selected ? parseEntryKey(selected) : null;
    return picked?.kind === "command" ? { ...base, terminal: feed.terminalOf(picked.id) } : base;
  }

  #signature(data: ViewData): string {
    return [data.session?.sessionId ?? "", data.extension.kind, this.#state.selected ?? "", ...data.entries.map((entry) => `${entry.key}:${entry.status}`)].join("|");
  }

  #draw(): void {
    if (this.#stopped) return;
    const now = this.#deps.clock.now();
    let data = this.#buildData(now);
    // 数据变了（名单、状态、选中的条目）就让状态机看一眼；它可能换选中的条目，那样终端内容要重新备好。
    // 第一次加载还没读完时名单是半截的（子 agent 先“在跑”后“做完”），不当作变化，免得把历史都标成未读
    for (let round = 0; round < 3 && (this.#feed?.caughtUp ?? true); round++) {
      const signature = this.#signature(data);
      if (signature === this.#lastSignature) break;
      this.#lastSignature = signature;
      this.#dispatch({ type: "data" }, data);
      data = this.#buildData(now);
    }
    if (this.#demoStart && data.entries.length > 0) {
      this.#demoStart = false;
      this.#state = { ...this.#state, selected: DEMO_KEYS.fixLogin, unread: new Set([DEMO_KEYS.review]) };
      data = this.#buildData(now);
      this.#lastSignature = this.#signature(data);
    }
    this.#lastData = data;
    this.#deps.screen.draw(renderFrame(this.#state, data, this.#size));
    this.#scheduleTick();
  }

  // ───── 输入、时钟和动作 ─────

  #armEscape(): void {
    const { timers } = this.#deps;
    if (this.#escTimer !== null) timers.clearTimeout(this.#escTimer);
    this.#escTimer = null;
    if (!this.#parser.hasPending) return;
    this.#escTimer = timers.setTimeout(() => {
      this.#escTimer = null;
      for (const event of this.#parser.flush()) this.#onInput(event);
    }, ESC_TIMEOUT_MS);
  }

  #onInput(event: InputEvent): void {
    if (this.#stopped || this.#pagerOpen) return;
    this.#dispatch({ type: "input", event });
    this.#request();
  }

  /** 把一个输入交给状态机，执行它要的动作。data 不传就现组装。 */
  #dispatch(input: AppInput, data?: ViewData): void {
    const now = this.#deps.clock.now();
    let seen = data ?? this.#buildData(now);
    // 第一次加载还没读完时状态机只看到“没有 session”：它认到 session 的那一刻要拿到完整的名单当基线，不然半截的状态会被当成变化
    if (this.#feed && !this.#feed.caughtUp) seen = { ...seen, session: null, entries: [], runningCount: 0 };
    const result = update(this.#state, input, { data: seen, size: this.#size, now });
    this.#state = result.state;
    for (const effect of result.effects) this.#run(effect);
  }

  /** 在跑的条目要转动符号和走用时，每 SPINNER_FRAME_MS 一次；只有提示等着到期时每 NOTICE_TICK_MS 一次；否则隔一秒看一眼。 */
  #scheduleTick(): void {
    if (this.#stopped) return;
    const state = this.#state;
    // “正在连接扩展…”几秒后要变成具体原因，没有别的事件会触发重画
    const pending = state.notice !== null || state.confirmStop !== null || state.quitArmedUntil !== null || this.#lastData?.statusNotice?.tone === "muted";
    const running = (this.#lastData?.runningCount ?? 0) > 0;
    const delay = running ? SPINNER_FRAME_MS : pending ? NOTICE_TICK_MS : IDLE_TICK_MS;
    if (this.#tickTimer !== null) {
      if (delay >= this.#tickDelay) return;
      this.#deps.timers.clearTimeout(this.#tickTimer);
    }
    this.#tickDelay = delay;
    this.#tickTimer = this.#deps.timers.setTimeout(() => {
      this.#tickTimer = null;
      if (this.#stopped) return;
      this.#dispatch({ type: "tick" }, this.#lastData ?? undefined);
      if ((this.#lastData?.runningCount ?? 0) > 0 || this.#state.notice !== null || this.#state.confirmStop !== null || this.#state.quitArmedUntil !== null || this.#lastData?.statusNotice?.tone === "muted") this.#request();
      this.#scheduleTick();
    }, delay);
  }

  #notify(text: string, tone: "info" | "error" = "error", durationMs?: number): void {
    if (this.#stopped) return;
    this.#dispatch({ type: "notify", text, tone, ...(durationMs === undefined ? {} : { durationMs }) });
    this.#request();
  }

  #write(data: string): void {
    try {
      this.#deps.stdout.write(data);
    } catch {
      // 终端没了，退出流程会处理
    }
  }

  #run(effect: AppEffect): void {
    const feed = this.#feed;
    switch (effect.type) {
      case "request": {
        if (!feed) return;
        void feed.request(effect.requestId, effect.op).then((outcome) => {
          if (this.#feed !== feed || this.#stopped) return;
          this.#dispatch({ type: "result", requestId: effect.requestId, outcome });
          this.#request();
        });
        return;
      }
      case "interrupt": {
        if (!feed) return;
        const task = this.#lastData?.entries.find((entry) => entry.key === effect.entryKey)?.task;
        const outcome = feed.io.interrupter.press(effect.toolCallId, effect.pid, feed.io.copilotPid(), { detached: task?.detached === true });
        this.#dispatch({ type: "interrupted", entryKey: effect.entryKey, outcome });
        return;
      }
      case "copy": {
        const text = this.#fullText(effect.entryKey);
        if (text === null) return;
        void copyText(text, this.#deps.env, (data) => this.#write(data)).then(
          (how) => this.#notify(how === "tmux" ? `已复制 ${[...text].length} 个字符到 tmux 缓冲区` : `已复制 ${[...text].length} 个字符（终端剪贴板）`, "info"),
          (error: unknown) => this.#notify(`复制失败：${error instanceof Error ? error.message : String(error)}`),
        );
        return;
      }
      case "pager":
        this.#openPager(effect.entryKey);
        return;
      case "bell":
        if (this.#deps.bell) this.#write(SEQ.bell);
        return;
      case "pinSession":
        this.#pinned = effect.sessionId;
        if (this.#deps.demo) return;
        if (this.#feed?.io.sessionId !== effect.sessionId) this.#switchTo(effect.sessionId);
        this.#request();
        return;
      case "unpinSession":
        this.#pinned = null;
        void this.#discover();
        return;
      case "quit":
        this.#deps.finish(0);
        return;
    }
  }

  /** y、o 要的全文；条目已经不在了返回 null。 */
  #fullText(key: EntryKey): string | null {
    const feed = this.#feed;
    const picked = parseEntryKey(key);
    if (!feed || !picked) return null;
    if (picked.kind === "agent") return agentPlainText(feed.store, picked.id, this.#state);
    return feed.plainTextOf(picked.id);
  }

  #openPager(key: EntryKey): void {
    const feed = this.#feed;
    const picked = parseEntryKey(key);
    if (!feed || !picked) return;
    let file = picked.kind === "command" && feed.terminalOf(picked.id) ? feed.io.outputFile(picked.id) : null;
    let temporary = false;
    if (file === null) {
      const text = this.#fullText(key);
      if (text === null) return;
      try {
        file = writePagerFile(scratchDir(this.#deps.dataDir), text);
      } catch (error) {
        this.#notify(`打不开全文：${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      temporary = true;
    }
    const path = file;
    const cleanup = () => {
      if (temporary) removePagerFile(path);
    };
    if (this.#deps.env.TMUX) {
      void openPager(path).then(cleanup, (error: unknown) => {
        cleanup();
        this.#notify(`tmux 弹不出窗口：${error instanceof Error ? error.message : String(error)}`);
      });
      return;
    }
    const { stdin, screen } = this.#deps;
    this.#pagerOpen = true;
    const failure = openPagerInline(path, {
      before: () => {
        this.#write(SEQ.mouseOff + SEQ.pasteOff + SEQ.cursorShow + SEQ.reset + SEQ.altScreenOff);
        stdin.setRawMode(false);
        stdin.pause();
      },
      after: () => {
        stdin.setRawMode(true);
        stdin.resume();
        this.#write(SEQ.altScreenOn + SEQ.cursorHide + SEQ.mouseOn + SEQ.pasteOn);
        screen.invalidate();
      },
    });
    this.#pagerOpen = false;
    cleanup();
    this.#size = this.#measure();
    if (failure) this.#notify(failure);
    this.#request();
  }
}

/** 要保留终端模拟器的命令：选中的，加上名单上在跑的。 */
function wantedTerminals(entries: readonly ListEntry[], selected: EntryKey | null): Set<string> {
  const wanted = new Set<string>();
  for (const entry of entries) {
    if (entry.kind === "command" && (entry.status === "running" || entry.key === selected)) wanted.add(entry.id);
  }
  return wanted;
}
