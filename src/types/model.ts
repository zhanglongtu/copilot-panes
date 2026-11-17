// 事件模型的数据形状：状态库（src/model/store.ts）存的子 agent 和命令、过程记录的条目，以及合并任务列表后给界面的名单条目。
// 只放类型和几个很小的公用函数。

import type { AgentUsage, TaskInfo, TaskStatus } from "../protocol.ts";

/**
 * 名单条目和过程记录用的状态。idle（做完一轮、等你发话）只能从任务列表得知，事件日志里没有。
 * stopped：没有下文就结束了（session 结束或续接、被上级丢掉）；cancelled：被你或主 agent 取消（事件里有取消的记录，或任务列表说 cancelled）。
 * 过程记录（EndItem）里取消仍记作 stopped。
 */
export type EntryStatus = "running" | "idle" | "done" | "failed" | "stopped" | "cancelled";
/** 只由事件日志得出的状态（没有 idle）。 */
export type EventStatus = "running" | "done" | "failed" | "stopped";

export type EntryKind = "agent" | "command";
/** 名单条目的键：子 agent 是 "agent:<agentId>"，命令是 "cmd:<toolCallId>"。两种 id 可能撞名，所以加前缀。 */
export type EntryKey = string;

export function agentKey(agentId: string): EntryKey {
  return `agent:${agentId}`;
}

export function commandKey(toolCallId: string): EntryKey {
  return `cmd:${toolCallId}`;
}

/** 拆开名单条目的键；不是 agentKey 或 commandKey 生成的返回 null。 */
export function parseEntryKey(key: EntryKey): { kind: EntryKind; id: string } | null {
  if (key.startsWith("agent:") && key.length > 6) return { kind: "agent", id: key.slice(6) };
  if (key.startsWith("cmd:") && key.length > 4) return { kind: "command", id: key.slice(4) };
  return null;
}

/** 已结束：做完、失败、停了、取消了。running 和 idle 都不算结束（idle 的子 agent 还能收消息）。 */
export function isEnded(status: EntryStatus): boolean {
  return status === "done" || status === "failed" || status === "stopped" || status === "cancelled";
}

// ───── 状态库里的记录 ─────

/** 一个子 agent，由 subagent.* 和带它 agentId 的事件得出。 */
export interface AgentRecord {
  /** 事件信封的 agentId；subagent.started 没带 agentId 时用 data.toolCallId，再没有用 "?"。 */
  id: string;
  /** 发起它的 task 调用的 toolCallId（subagent.started 的 data.toolCallId），没有是 null。 */
  toolCallId: string | null;
  /** agentDisplayName，没有用 agentName；还没收到 subagent.started 的占位记录是 id 的前 8 个字符。 */
  name: string;
  /** agentType，没有用 agentName。 */
  agentType: string;
  /** agentDescription：起它的 task 调用的 description 参数（三五个词的简述）；没有是 ""。 */
  description: string;
  /**
   * 可选。任务说明开头有多少个字符和这个 session 里其他子 agent 的任务说明相同、可以折叠（按段落取公共前缀，
   * 见 src/model/prompt-fold.ts）；没有公共开头时是 0 或不写。
   */
  promptFoldChars?: number;
  /** 可选。它是被取消的（subagent.completed 的 cancelled 为 true，或收到 subagent_cancelled 的 abort），不是做完或随 session 结束。 */
  cancelled?: true;
  /** 完整的模型名（如 "provider/medium-1.0"）；subagent.completed 的 model 非空时覆盖。没有是 null。 */
  model: string | null;
  executionMode: "sync" | "background" | null;
  /** 上一级子 agent 的 id；主会话起的是 null。按发起 task 调用的 agentId 定，不读 data.parentId。 */
  parentId: string | null;
  status: EventStatus;
  /** subagent.started 的时间（Unix 毫秒）。 */
  startedAt: number;
  /** 最近一次结束的时间；在跑时是 null。 */
  endedAt: number | null;
  /** 已累计的活跃毫秒数：各轮之和；首次结束且带 durationMs 时取 durationMs。 */
  activeMs: number;
  /** 当前这一轮开始的时刻；不在跑时是 null。用时 = activeMs + (now - busySince)。 */
  busySince: number | null;
  /** 自己数到的工具调用次数；完成事件的 totalToolCalls 是整数时整个替换。 */
  toolCalls: number;
  /**
   * subagent.completed 或 subagent.failed 的 totalTokens；还没结束过是 null。它是发出事件那一刻的累计用量（输入加输出，全程各轮），
   * 不是只算最近一轮；但追加消息后跑的后续几轮只有 agent_idle 通知、没有新的完成事件，所以它可能比现在的真实用量小。
   */
  totalTokens: number | null;
  /**
   * 可选。events.jsonl 里带这个子 agent 的 agentId 的 session.usage_record 累加的输入加输出（不含缓存）：全程各轮，和每条完成事件的
   * totalTokens 逐字相同（实测），没有扩展也有。一条用量记录都没读到时不写。
   */
  eventTokens?: number;
  /** subagent.failed 的 error，折成一行；没有是 null。 */
  error: string | null;
  /** 最后一条有文字的 assistant.message 的 content，去首尾空白，最多 600 个字符；没有是 ""。 */
  lastReply: string;
  /** 最近一次工具调用的 toolCallId，能在它的过程记录里找到对应的 ToolItem；没有是 null。 */
  lastToolCallId: string | null;
}

/** 命令为什么结束。agent-ended：所属子 agent 结束时被丢掉（日志里没有它自己的结束通知）。 */
export type CommandEndReason = "exit" | "stopped" | "agent-ended" | "session-ended" | "aborted";

/** 一条 bash 或 powershell 调用，以 toolCallId 为键。 */
export interface CommandRecord {
  toolCallId: string;
  toolName: string;
  /** arguments.command 原文（多行、多空格都保留）。 */
  command: string;
  /** arguments.description。 */
  description: string;
  /** 发起它的子 agent 的 id；主会话的命令是 null。只在 tool.execution_start 时定。 */
  agentId: string | null;
  /** 一开始就是后台（mode 为 async），或者后来转了后台。 */
  background: boolean;
  /** 前台命令转了后台。 */
  promoted: boolean;
  /** arguments.detach 为 true。 */
  detach: boolean;
  /** Copilot CLI 给的 shellId：来自调用参数、结果的 structuredContent，或结果文字里的 “shellId: …>” 标记；还不知道是 null。 */
  shellId: string | null;
  status: EventStatus;
  endReason: CommandEndReason | null;
  startedAt: number;
  endedAt: number | null;
  exitCode: number | null;
  /** 调用失败又没有退出码时的 error.message；没有是 null。 */
  error: string | null;
  /**
   * 事件日志里能拿到的输出：前台命令是完成事件的 result.content 去掉末尾退出标记；后台命令是 read_bash、write_bash
   * 读到的输出拼起来（最多 BG_EVENT_OUTPUT_CAP 个字符）。没有 .out 文件时界面用它。
   */
  eventOutput: string;
  /** 在“留下的失败命令”里（最多 5 条）。 */
  keptAsFailed: boolean;
}

// ───── 过程记录 ─────

interface ItemBase {
  /** 在这个子 agent 的过程记录里的序号，从 0 起。 */
  seq: number;
  /** 事件时间（Unix 毫秒）。 */
  at: number;
}

/** 子 agent 收到的第一条 user.message：任务说明。默认只显示前 2 行，e 展开。 */
export interface TaskItem extends ItemBase {
  kind: "task";
  text: string;
}

/** 子 agent 说的话（assistant.message 的 content，去首尾空白后非空）。 */
export interface SayItem extends ItemBase {
  kind: "say";
  text: string;
}

/** 子 agent 的思考（assistant.message 的 reasoningText）。同一条事件里先于 say。默认不显示，e 展开。 */
export interface ThinkItem extends ItemBase {
  kind: "think";
  text: string;
}

/** 一次工具调用，tool.execution_start 时建，tool.execution_complete 时补结果。 */
export interface ToolItem extends ItemBase {
  kind: "tool";
  toolCallId: string;
  toolName: string;
  /** 调用参数原样（JSON 值，类型不定，用前要检查）。 */
  args: unknown;
  status: "running" | "ok" | "failed";
  endedAt: number | null;
  /** 结果文字（detailedContent，没有用 content），最多 TOOL_RESULT_KEEP_CHARS 个字符；还没完成是 null。 */
  resultText: string | null;
  /** 失败时的 error.message。 */
  errorText: string | null;
  /** 完成事件的 toolTelemetry 原样（grep 的匹配数之类），没有是 null。 */
  telemetry: unknown;
  /** task 调用起的子 agent 的 id（收到 subagent.started 后才有）。 */
  childAgentId: string | null;
}

/** 子 agent 第二条及以后的 user.message。from 看 data.source：没有或空串是 you（你从界面发的），agent-<id> 是子 agent 或主会话，其余是 other。 */
export interface MessageItem extends ItemBase {
  kind: "message";
  from: "you" | "main" | "agent" | "other";
  /** “你”、“主会话”、发消息的子 agent 的名字，或 source 第一个 "-" 之前的词。 */
  fromName: string;
  text: string;
}

/** 子 agent 不在跑时又收到消息，接着跑。 */
export interface ResumeItem extends ItemBase {
  kind: "resume";
}

/** 子 agent 结束一轮或彻底结束。数字是事件当时的值（不是最新值）。 */
export interface EndItem extends ItemBase {
  kind: "end";
  status: "done" | "failed" | "stopped";
  durationMs: number | null;
  toolCalls: number | null;
  tokens: number | null;
  error: string | null;
  /** 可选。status 是 stopped 而且是被取消的（不是随 session 结束）时为 true。 */
  cancelled?: true;
}

export type TranscriptItem = TaskItem | SayItem | ThinkItem | ToolItem | MessageItem | ResumeItem | EndItem;

/** 工具调用一行文字的三段：▸ <verb>  <target>  <detail>。detail 可以是空串。 */
export interface ToolLine {
  verb: string;
  target: string;
  detail: string;
}

// ───── 状态库的只读接口 ─────

/** 状态库对外的只读接口。src/model/store.ts 的 SessionStore 实现它；名单合并和界面都只用这个接口。 */
export interface StoreView {
  readonly sessionId: string;
  /** 每次内容有变化加 1。界面拿它判断要不要重算名单。 */
  readonly version: number;
  /** session.start 的 data.context.cwd；没有是 null。 */
  readonly cwd: string | null;
  /** 主会话的模型（session.start 或 session.resume 的 selectedModel，session.model_change 的 newModel）。 */
  readonly mainModel: string | null;
  /** 读到的最新一条事件的时间（Unix 毫秒）；还没有事件是 0。自动跟随比较 session 新旧时用。 */
  readonly lastEventAt: number;
  /** 所有子 agent，按 subagent.started 的先后。 */
  agents(): readonly AgentRecord[];
  /** 所有命令，按开始的先后。 */
  commands(): readonly CommandRecord[];
  agent(id: string): AgentRecord | undefined;
  command(toolCallId: string): CommandRecord | undefined;
  /** 按 shellId 找命令（read_bash、stop_bash 的那一行要写出它读的是哪条命令）；同一个 shellId 后登记的覆盖先登记的。 */
  commandByShellId(shellId: string): CommandRecord | undefined;
  /** 子 agent 的过程记录，按事件顺序；不认识的 id 返回空数组。 */
  transcript(agentId: string): readonly TranscriptItem[];
}

// ───── 任务列表和名单 ─────

/** 界面手里最近一次的任务列表：来自 socket 的 tasks 消息，加上收到的时刻和连接是否还在。 */
export interface TasksSnapshot {
  tasks: readonly TaskInfo[];
  shellCalls: Readonly<Record<string, string>>;
  /** 界面收到这条 tasks 消息的时刻（界面自己的时钟，Unix 毫秒）。 */
  receivedAt: number;
  /** socket 现在是否连着。断开后旧的列表立刻作废。 */
  connected: boolean;
}

/** 名单条目对上的 Copilot CLI 任务。 */
export interface TaskRef {
  /** TaskInfo.id，发请求时用。 */
  id: string;
  status: TaskStatus;
  executionMode: "sync" | "background" | null;
  canPromoteToBackground: boolean;
  /** shell 任务的进程号；没有或不是 shell 任务是 null。 */
  pid: number | null;
  /** detach 出去的 shell 任务（独立的后台进程，pid 不是进程组组长，发信号停不掉）才有，值为 true。 */
  detached?: true;
}

/** 名单上的一行。由 src/model/merge.ts 的 buildList 得出，界面只负责截断和上色。 */
export interface ListEntry {
  key: EntryKey;
  kind: EntryKind;
  /** agentId 或 toolCallId。 */
  id: string;
  /** 缩进层数：最外层是 0。 */
  depth: number;
  parentKey: EntryKey | null;
  /** 合并任务列表之后的状态。 */
  status: EntryStatus;
  /** 子 agent 的名字；命令是去掉 cd、env、timeout 等包装后的命令名（见 src/model/command-name.ts），空白折成一个空格，不带 "$ "。原文在内容区按 e 看。 */
  name: string;
  /** 模型短名（如 "medium-1.0"）；命令是 null。 */
  model: string | null;
  startedAt: number;
  /** 到 now 为止的用时（毫秒）；已结束的停在结束时。 */
  elapsedMs: number;
  /** 这个子 agent 的 token 数；命令和不知道的是 null。 */
  tokens: number | null;
  /** 可选。task 调用的 description（三五个词的简述，如“查右侧面板如何常驻”）；命令和没有简述的子 agent 不写。 */
  description?: string;
  /** 可选。任务说明开头有多少个字符和这个 session 里其他任务相同、可以折叠；没有或 0 表示不折叠。只有子 agent 有。 */
  promptFoldChars?: number;
  /** “最近一步”一栏的文字，如 "跑 pytest"、"等 run-tests 交回结果"、"12/40 30%"、"退出码 1"、"做完一轮，等你发话"。 */
  step: string;
  /** 命令的退出码；子 agent 和不知道的是 null。 */
  exitCode: number | null;
  /** 对上的任务；扩展没连上、任务列表不新鲜或对不上时是 null。 */
  task: TaskRef | null;
  /**
   * 可选。这个 session 的 Copilot CLI 进程已经不在，而这条原本是 running 或 idle：status 写 stopped，step 写“已停”，
   * 名单上用灰色的中性符号、不转动，用时停在 session 最后一个事件的时间。
   */
  orphaned?: boolean;
  /**
   * 可选。tokens 只是个下限：这个子 agent 在扩展加载之前就开始了，扩展手里的累加值只含加载之后的，它还没结束；
   * 名单上写成“≥12.3万”，结束后换成事件里的 totalTokens，这个标记就没了。
   */
  tokensPartial?: boolean;
}

/** buildList 的输入。 */
export interface BuildListInput {
  store: StoreView;
  /** 最近一次的任务列表；从没收到过是 null。是否新鲜由 buildList 用 now 判断。 */
  tasks: TasksSnapshot | null;
  /** 扩展推来的用量，键是 agentId；没有是 null。 */
  usage: Readonly<Record<string, AgentUsage>> | null;
  now: number;
  /** c 键：收起已结束的条目（失败的命令和子 agent 也收起）。 */
  collapseEnded: boolean;
  /** 必须留在名单上的条目（例如当前选中的），即使按规则该消失。 */
  keep: ReadonlySet<EntryKey>;
  /** 可选。扩展的启动时刻（登记记录里的 startedAt，Unix 毫秒）：usage 只含这之后的用量，更早开始又没结束的子 agent 的 tokens 标成下限。不写就不标。 */
  usageSince?: number;
  /** 取命令输出的最后一行非空文字（已清理）；没有输出返回 ""。buildList 用它得出进度。 */
  lastOutputLine: (toolCallId: string) => string;
}
