// 界面状态机（src/ui/app.ts）和视图（src/ui/views）共用的数据形状。
// 状态机：update(状态, 输入, 上下文) → { 新状态, 要执行的动作 }；视图：renderFrame(状态, 数据, 尺寸) → 一帧。
// 两者都是纯函数，读文件、连 socket、发信号这些事由 src/runtime.ts 根据动作去做。

import type { RequestOp } from "../protocol.ts";
import type { EntryKey, EntryStatus, ListEntry, StoreView } from "./model.ts";
import type { InputEvent, Size, TerminalLines, TextInputState } from "./ui.ts";

export type Focus = "list" | "content";
/** 盖在内容区上面的东西：? 键的全部按键说明，s 键的 session 选择列表。 */
export type Overlay = "none" | "help" | "sessions";

/** 输入行上方的一行提示（“已发给 fix-login”、失败原因、“这条命令不接受输入，只能中断”等），until 之后消失。 */
export interface Notice {
  text: string;
  tone: "info" | "error";
  until: number;
}

/** / 键：在选中条目的内容里搜索。editing 为 true 时输入行在编辑搜索词；index 是当前跳到第几个匹配。 */
export interface SearchState {
  query: TextInputState;
  editing: boolean;
  index: number;
  /** 可选。按 Enter、n、N 时状态机数出的匹配行数；还没搜过不写。 */
  matches?: number;
  /** 可选。当前匹配所在的行号（内容区全部行里从 0 起，0 是最上面一行）；没有匹配或还没搜过是 null 或不写。视图据此高亮当前匹配。 */
  currentRow?: number | null;
}

/** 发出去还没回结果的请求。label 用来写结果提示，例如子 agent 的名字。 */
export interface PendingRequest {
  op: RequestOp["op"];
  entryKey: EntryKey | null;
  label: string;
  /** 可选。发给子 agent 的原文；发送失败时放回输入框。 */
  text?: string;
}

/** 某个条目翻看到的位置：离底部的行数，和当时内容区的总行数。 */
export interface SavedScroll {
  scroll: number;
  total: number | null;
}

/** Ctrl+C 对一条命令发出的最近一个信号和发出的时刻，输入行据此写“已发中断信号…”和升级提示。 */
export interface InterruptMark {
  signal: InterruptSignal;
  at: number;
}

export interface AppState {
  focus: Focus;
  /** 选中的条目；名单为空是 null。 */
  selected: EntryKey | null;
  /** 跟随最新：新起的条目自动选中。用户动过选择后变 false，按 f 恢复。 */
  followLatest: boolean;
  /** c 键：收起已结束的条目。 */
  collapseEnded: boolean;
  /** z 键：名单收成一行，内容区占满。 */
  zoom: boolean;
  /** e 键：展开细节（完整的任务说明和工具结果）的条目。 */
  expanded: ReadonlySet<EntryKey>;
  /** 未读：条目结束或变成 idle 时用户没有选中它；选中后去掉。 */
  unread: ReadonlySet<EntryKey>;
  /** 上一次看到的各条目状态，用来发现新条目、刚结束的、刚变 idle 的、刚失败的（响铃）。 */
  lastStatus: ReadonlyMap<EntryKey, EntryStatus>;
  /** 每个子 agent 各自的输入框草稿。 */
  drafts: ReadonlyMap<EntryKey, TextInputState>;
  /** 内容区从底部往上翻了多少行；0 表示贴着底部、跟着新内容走。 */
  scroll: number;
  /**
   * 可选。scroll 大于 0 时，用户翻看那一刻内容区的总行数。视图用现在的总行数减去它得出翻看之后新来的行数，
   * 把窗口往上挪同样多行，所以画面停在原处，并提示“还有 N 行新内容”。scroll 回到 0 时设为 null 或不设。
   * 总行数由 src/ui/views/agent.ts 的 agentRowCount、command.ts 的 commandRowCount 给出。
   */
  scrollTotal?: number | null;
  /** 可选。没有选中的条目各自翻看到的位置；选中的条目用 scroll 和 scrollTotal，切走时存进来，切回来时取出。 */
  scrolls?: ReadonlyMap<EntryKey, SavedScroll>;
  /** 可选。状态机现在对应的 session（ViewData.session 的 sessionId，没有 session 是 null）；变了就清掉和旧 session 有关的状态。 */
  sessionId?: string | null;
  /** 可选。上一次看到的名单顺序；选中的条目消失时据此选相邻的条目。 */
  order?: readonly EntryKey[];
  /** 可选。Ctrl+C 对各命令发出的最近一个信号；发了信号的命令才有。 */
  interrupts?: ReadonlyMap<EntryKey, InterruptMark>;
  notice: Notice | null;
  /** 第一次按 x 之后等第二次：对哪个条目、到什么时候。 */
  confirmStop: { key: EntryKey; until: number } | null;
  /** 名单里第一次按 Ctrl+C 之后，到这个时刻之前再按才退出；没按过是 null。 */
  quitArmedUntil: number | null;
  search: SearchState | null;
  overlay: Overlay;
  /** s 列表里高亮的是第几项。 */
  pickerIndex: number;
  /** 可选。? 帮助放不下时翻到第几行起；打开帮助时是 0。不写当作 0。 */
  helpScroll?: number;
  /** 下一个请求编号（requestId 是 "r" 加这个数）。 */
  nextRequestId: number;
  /** requestId → 等结果的请求。 */
  pending: ReadonlyMap<string, PendingRequest>;
}

/** 顶行左边：项目名（session 工作目录的最后一段）和 session 的名字。 */
export interface SessionHeader {
  sessionId: string;
  project: string;
  title: string | null;
}

/**
 * 扩展的状态。readonly 时所有操作不可用，顶行用橙色写 reason（如“只读：这个 session 没加载扩展”；正在连接时是“正在连接扩展…”）。
 * cause 是同一个原因的另一种说法，给输入行和被拒绝的按键用：“只读，不能发消息：<cause>”，如“这个 session 启动时还没装扩展”；没有时用“扩展没有加载”。
 * 原因和怎么恢复的完整说明在 ViewData.statusNotice。
 */
export type ExtensionState = { kind: "connected" } | { kind: "readonly"; reason: string; cause?: string };

/** s 键列表里的一项。 */
export interface SessionChoice {
  sessionId: string;
  title: string | null;
  cwd: string | null;
  lastEventAt: number;
  current: boolean;
  /** 这个 session 里状态是 running 的条目数；runtime 没算出来时不写，s 列表就不显示这一列。 */
  runningCount?: number;
}

/** 视图和状态机要读的数据，由 src/runtime.ts 每次数据变化时组装。 */
export interface ViewData {
  now: number;
  /** 还没找到 session 时是 null，画等待画面。 */
  session: SessionHeader | null;
  extension: ExtensionState;
  entries: readonly ListEntry[];
  /** 名单上状态是 running 的条目数（子 agent 和命令都算）。 */
  runningCount: number;
  /** 这个 session 所有子 agent 的 token 合计；一个都不知道时是 null。 */
  totalTokens: number | null;
  /** 当前 session 的状态库，画子 agent 的过程记录用；没有 session 是 null。 */
  store: StoreView | null;
  /** 选中命令时它的终端内容；选中的不是命令、或者终端还没建好是 null。 */
  terminal: TerminalLines | null;
  /** s 键列表：同一个候选范围里的 session。 */
  sessions: readonly SessionChoice[];
  /** --no-bell 时为 false。 */
  bellEnabled: boolean;
  /** 可选。这个 session 的 Copilot CLI 进程已经不在（没来得及写 session.shutdown 就被结束）：顶行写“session 已结束”。不写当作 false。 */
  sessionEnded?: boolean;
  /** 顶行下面的提示行。null 或缺省时不显示。只读的原因和恢复办法就放在这里。 */
  statusNotice?: { tone: "attention" | "muted"; text: string } | null;
  /** 同一个 Copilot CLI 里其他 session 的情况；没有其他 session 时为 null。 */
  otherSessions?: { sessions: number; running: number } | null;
}

/** uncertain：超时没等到结果，操作可能已经生效（消息可能已经送到）；界面据此不说“没发出去”。 */
export type RequestOutcome = { ok: true } | { ok: false; reason: string; uncertain?: true };

export type InterruptSignal = "SIGINT" | "SIGTERM" | "SIGKILL";

/**
 * 按一次 Ctrl+C 中断命令的结果（src/bridge/signals.ts 的 Interrupter 给出）。
 * sent：发了信号，target 说明发给了整个进程组还是单个进程；wait：上一个信号发出不到 3 秒，这次没发；
 * fallback：拿不到能用的进程号，调用方应改为请扩展 tasks.cancel；failed：发信号出错。
 */
export type InterruptOutcome =
  | { kind: "sent"; signal: InterruptSignal; target: "group" | "process" }
  | { kind: "wait"; signal: InterruptSignal; remainingMs: number }
  | { kind: "fallback"; reason: string }
  | { kind: "failed"; reason: string };

/** 状态机的输入。 */
export type AppInput =
  | { type: "input"; event: InputEvent }
  /** 时钟走了（提示到期、转动符号换帧）。 */
  | { type: "tick" }
  /** ViewData 变了（名单、状态、扩展连接）。状态机借此跟随最新、标未读、失败时响铃。 */
  | { type: "data" }
  | { type: "result"; requestId: string; outcome: RequestOutcome }
  | { type: "interrupted"; entryKey: EntryKey; outcome: InterruptOutcome }
  /** runtime 要在提示行写一句话：y 复制失败（不在 tmux 里）、o 打不开 less 等动作失败时用。durationMs 不写用 NOTICE_MS。 */
  | { type: "notify"; text: string; tone: "info" | "error"; durationMs?: number };

/** 状态机要 runtime 去做的事。 */
export type AppEffect =
  /** 经 socket 请扩展做事；结果回来时 runtime 再喂一个 result 输入。 */
  | { type: "request"; requestId: string; op: RequestOp }
  /** 中断命令（Ctrl+C）；runtime 交给 Interrupter，结果喂回 interrupted 输入。 */
  | { type: "interrupt"; entryKey: EntryKey; toolCallId: string; pid: number | null; taskId: string | null }
  /** y：把条目的全文复制到 tmux 缓冲区。 */
  | { type: "copy"; entryKey: EntryKey }
  /** o：在 tmux 弹出窗口里用 less -R 打开全文。 */
  | { type: "pager"; entryKey: EntryKey }
  | { type: "bell" }
  /** s 列表里选了一个 session：换过去并固定。 */
  | { type: "pinSession"; sessionId: string }
  /** s 列表里选了“恢复自动选择”：取消固定，回到自动找 session。 */
  | { type: "unpinSession" }
  | { type: "quit" };

/** update 的上下文：当前数据、pane 尺寸、当前时刻。 */
export interface AppContext {
  data: ViewData;
  size: Size;
  now: number;
}

export interface AppUpdate {
  state: AppState;
  effects: AppEffect[];
}
