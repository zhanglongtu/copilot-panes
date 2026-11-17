// 扩展和界面之间的全部约定：socket 上每行一条 JSON 消息的类型、解析和序列化，以及扩展写的登记记录。
// 扩展（extension/src）和界面（src）都从这里导入，两边永远用同一份定义。
//
// 消息一览（详见 docs/architecture.md 的 socket 协议一节）：
//   扩展 → 界面：hello（连上时一次）、tasks（任务列表）、usage（子 agent 的用量）、result（请求的结果）
//   界面 → 扩展：request（发消息、取消、转后台、移除、立刻刷新任务列表）
// 每条消息都带协议版本 v。解析函数从不抛异常：坏消息返回 { ok: false, code, error }。

/** socket 协议的版本。消息格式有不兼容的改动时加 1。 */
export const PROTOCOL_VERSION = 1;
/** 登记记录（sessions/<session ID>.json）的格式版本。 */
export const REGISTRATION_VERSION = 1;
/** 一行消息最多这么多字节（不含换行）。超长的行整行丢弃，见 LineDecoder。 */
export const MAX_LINE_BYTES = 8 * 1024 * 1024;

// ───── SDK 的任务类型 ─────
// 这些类型按 @github/copilot-sdk 的接口形状写成，只保留本工具用到的字段。

/** 任务状态。running 在跑；idle 做完一轮、等新消息；completed 做完；failed 失败；cancelled 被取消。 */
export type TaskStatus = "running" | "idle" | "completed" | "failed" | "cancelled";
/** sync：发起方在同步等它；background：在后台。 */
export type TaskExecutionMode = "sync" | "background";
/** client 任务多一个 orphaned：登记它的扩展断开了，状态未知。 */
export type TaskClientStatus = TaskStatus | "orphaned";
/** attached：shell 跑在 Copilot CLI 管理的伪终端里（同步命令）；detached：独立的后台进程。 */
export type TaskShellInfoAttachmentMode = "attached" | "detached";
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** 子 agent 任务。id 是子 agent 事件信封里的 agentId；toolCallId 是发起它的 task 工具调用。 */
export interface TaskAgentInfo {
  type: "agent";
  id: string;
  toolCallId: string;
  displayName?: string;
  description: string;
  status: TaskStatus;
  /** ISO 8601 */
  startedAt: string;
  completedAt?: string;
  activeTimeMs?: number;
  activeStartedAt?: string;
  error?: string;
  agentType: string;
  /** 最近一次交给它的消息（派活的话或后续消息）。 */
  prompt: string;
  result?: string;
  model?: string;
  resolvedModel?: string;
  executionMode?: TaskExecutionMode;
  /** 正处在发起方的同步等待里、可以转后台时为 true。 */
  canPromoteToBackground?: boolean;
  latestResponse?: string;
  idleSince?: string;
}

/** shell 任务。id 就是 shellId；没有 toolCallId 字段（扩展另在 TasksMessage.shellCalls 里给出对应关系）。 */
export interface TaskShellInfo {
  type: "shell";
  id: string;
  description: string;
  status: TaskStatus;
  startedAt: string;
  completedAt?: string;
  command: string;
  attachmentMode: TaskShellInfoAttachmentMode;
  executionMode?: TaskExecutionMode;
  canPromoteToBackground?: boolean;
  logPath?: string;
  /** 进程号（有时没有）。中断命令时用它发信号。 */
  pid?: number;
}

export interface TaskClientOwner {
  participantId: string;
  joinId: string;
  kind: "extension" | "sdk";
  displayName?: string;
  source?: string;
  presence: "connected" | "disconnected";
  disconnectedAt?: string;
}

/** 扩展或 SDK 自己登记的任务。界面不显示，只原样转发。 */
export interface TaskClientInfo {
  type: "client";
  id: string;
  clientTaskId: string;
  displayName?: string;
  description: string;
  status: TaskClientStatus;
  owner: TaskClientOwner;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  activeTimeMs: number;
  activeStartedAt?: string;
  idleSince?: string;
  orphanedAt?: string;
  reclaimedAt?: string;
  executionMode: "background";
  canCancel: boolean;
  sequence: number;
  result?: JsonValue;
  error?: string;
  errorCode?: string;
  cancellationReason?: string;
}

/** 任务：子 agent、别的扩展登记的任务或 shell 命令。按 @github/copilot-sdk 的 TaskInfo 的形状写成，只保留本工具用到的字段。 */
export type TaskInfo = TaskAgentInfo | TaskClientInfo | TaskShellInfo;

// ───── 消息 ─────

/** 扩展最近一次出错：哪一步（如 "tasks.list"、"output.append"）、原因、时间（Unix 毫秒）。 */
export interface ExtensionError {
  step: string;
  message: string;
  at: number;
}

/**
 * 一个子 agent 到目前为止的模型用量，由扩展累加 assistant.usage 事件得出。
 * assistant.usage 不写进 events.jsonl，界面只能从扩展拿到。
 * 扩展晚于子 agent 启动（例如扩展被重新加载）时，数字只含扩展看到的部分。
 */
export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** 累加了多少条 assistant.usage。 */
  calls: number;
  /** 扩展看到这个子 agent 的 subagent.completed 或 subagent.failed 时，事件里的 totalTokens；用来核对累加口径。 */
  reportedTotalTokens?: number;
}

/** 连接建立时扩展发的第一条消息。 */
export interface HelloMessage {
  type: "hello";
  v: number;
  sessionId: string;
  /** Copilot CLI 的进程号（扩展的父进程）。中断命令前用它核对进程树。 */
  copilotPid: number;
  extensionPid: number;
  /** 扩展的版本号（package.json 的 version）。界面拿它和自己的版本比，不一样时提示重新安装。 */
  extensionVersion: string;
}

/**
 * 任务列表。连接建立时推一次；之后每秒查一次 tasks.list()，内容变了才推，至少每 5 秒推一次当作保活。
 * tasks 是 SDK 的 TaskInfo 原样转发（过长的文字字段可能被截短，见 constants.ts 的 TASK_TEXT_MAX_CHARS）。
 */
export interface TasksMessage {
  type: "tasks";
  v: number;
  /** 扩展调用 tasks.list() 拿到结果的时刻（Unix 毫秒）。界面判断新不新鲜用自己收到的时刻，不用它。 */
  at: number;
  tasks: TaskInfo[];
  /**
   * shell 任务 id → 命令的 toolCallId。shell 任务没有 toolCallId 字段，由扩展按 shellId、命令文字和开始时间对应；
   * 对应不上的任务不出现在这里。
   */
  shellCalls: Record<string, string>;
  /** 扩展最近一次出错；没出过错是 null。 */
  error: ExtensionError | null;
}

/** 子 agent 的用量：键是子 agent 的 agentId。变了才推，最多每秒一次；连接建立时推一次。 */
export interface UsageMessage {
  type: "usage";
  v: number;
  at: number;
  agents: Record<string, AgentUsage>;
}

/** 请求的结果。reason 是给人看的一句中文，界面原样显示。 */
export type ResultMessage =
  | { type: "result"; v: number; requestId: string; ok: true }
  /** uncertain 为 true：没等到 Copilot CLI 的回应就超时了，操作可能已经生效（如消息已经送到），界面不能说“一定没成”。 */
  | { type: "result"; v: number; requestId: string; ok: false; reason: string; uncertain?: true };

export type ExtensionMessage = HelloMessage | TasksMessage | UsageMessage | ResultMessage;

/** 界面能请扩展做的事。taskId 是 TaskInfo.id（子 agent 的 agentId，或 shell 任务的 shellId）。 */
export type RequestOp =
  | { op: "sendMessage"; taskId: string; message: string }
  | { op: "cancel"; taskId: string }
  | { op: "promoteToBackground"; taskId: string }
  | { op: "remove"; taskId: string }
  | { op: "refreshTasks" };

/** 界面发的请求。requestId 由界面生成，1 到 64 个 A-Za-z0-9_- 字符；扩展回的 result 带同一个编号。 */
export type RequestMessage = { type: "request"; v: number; requestId: string } & RequestOp;

export type UiMessage = RequestMessage;

/** 解析失败的种类。version：协议版本不同（界面据此提示“扩展版本不对”）；type：不认识的消息类型。 */
export type ParseErrorCode = "json" | "shape" | "version" | "type";

export type ParseResult<T> = { ok: true; value: T } | { ok: false; code: ParseErrorCode; error: string };

// ───── 登记记录 ─────

/**
 * 扩展写的登记记录 sessions/<session ID>.json。扩展启动时写，每 5 秒原子地重写一次当作心跳，退出时删掉。
 * 界面用它找 session（copilotPid、tmuxPane、updatedAt）和连 socket（socketPath）。
 */
export interface Registration {
  v: number;
  /** 扩展说的 socket 协议版本，doctor 不连 socket 也能核对。 */
  protocol: number;
  sessionId: string;
  copilotPid: number;
  extensionPid: number;
  /** 环境变量 TMUX_PANE（如 "%3"），不在 tmux 里是 null。 */
  tmuxPane: string | null;
  /** 扩展进程的工作目录。它是不是 session 的工作目录没验证，找 session 时优先用 workspace.yaml 里的 cwd。 */
  cwd: string;
  /** 扩展实际在听的 socket 路径；socket 没开成（目录不安全、listen 失败）时是 null，扩展会隔一会儿重试，开成后重写登记记录。界面据此显示只读。 */
  socketPath: string | null;
  extensionVersion: string;
  /** Unix 毫秒。 */
  startedAt: number;
  updatedAt: number;
}

// ───── 解析和序列化 ─────

const TASK_STATUSES: ReadonlySet<string> = new Set(["running", "idle", "completed", "failed", "cancelled"]);
const REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
const isNonEmptyString = (v: unknown): v is string => typeof v === "string" && v !== "";
const isPositiveInt = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;
const isFiniteNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function fail<T>(code: ParseErrorCode, error: string): ParseResult<T> {
  return { ok: false, code, error };
}

function parseJsonObject(line: string): ParseResult<Record<string, unknown>> {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (e) {
    return fail("json", `不是 JSON：${e instanceof Error ? e.message : String(e)}`);
  }
  if (!isObject(value)) return fail("shape", "不是 JSON 对象");
  return { ok: true, value };
}

function checkVersion(o: Record<string, unknown>): ParseResult<never> | null {
  if (o.v === PROTOCOL_VERSION) return null;
  return fail("version", `协议版本是 ${JSON.stringify(o.v)}，这一边只认 ${PROTOCOL_VERSION}`);
}

/**
 * 校验一个任务。不是对象、type 不认识、id 不是非空字符串、status 不认识的，返回 null（调用方跳过它，保留其余任务）。
 * 通过的任务返回浅拷贝：pid 不是正整数、canPromoteToBackground 不是布尔、shell 的 command 不是字符串时，去掉或改成空串，
 * 其余字段原样保留。
 */
export function parseTaskInfo(value: unknown): TaskInfo | null {
  if (!isObject(value)) return null;
  const { type, id, status } = value;
  if (type !== "agent" && type !== "shell" && type !== "client") return null;
  if (!isNonEmptyString(id) || typeof status !== "string") return null;
  if (!TASK_STATUSES.has(status) && !(type === "client" && status === "orphaned")) return null;
  const copy: Record<string, unknown> = { ...value };
  if ("pid" in copy && !isPositiveInt(copy.pid)) delete copy.pid;
  if ("canPromoteToBackground" in copy && typeof copy.canPromoteToBackground !== "boolean") delete copy.canPromoteToBackground;
  if (type === "shell" && typeof copy.command !== "string") copy.command = "";
  if (type === "agent" && typeof copy.toolCallId !== "string") copy.toolCallId = "";
  if (typeof copy.startedAt !== "string") copy.startedAt = "";
  return copy as unknown as TaskInfo;
}

function parseExtensionError(v: unknown): ExtensionError | null {
  if (!isObject(v)) return null;
  if (typeof v.step !== "string" || typeof v.message !== "string" || !isFiniteNumber(v.at)) return null;
  return { step: v.step, message: v.message, at: v.at };
}

function parseUsage(v: unknown): AgentUsage | null {
  if (!isObject(v)) return null;
  const n = (x: unknown) => (isFiniteNumber(x) && x >= 0 ? x : 0);
  const u: AgentUsage = {
    inputTokens: n(v.inputTokens),
    outputTokens: n(v.outputTokens),
    cacheReadTokens: n(v.cacheReadTokens),
    cacheWriteTokens: n(v.cacheWriteTokens),
    calls: n(v.calls),
  };
  if (isFiniteNumber(v.reportedTotalTokens) && v.reportedTotalTokens >= 0) u.reportedTotalTokens = v.reportedTotalTokens;
  return u;
}

/** 把扩展发来的一行解析成消息。坏 JSON、缺字段、版本不同、类型不认识都返回错误，不抛异常。 */
export function parseExtensionMessage(line: string): ParseResult<ExtensionMessage> {
  const parsed = parseJsonObject(line);
  if (!parsed.ok) return parsed;
  const o = parsed.value;
  const versionError = checkVersion(o);
  if (versionError) return versionError;
  const v = PROTOCOL_VERSION;
  switch (o.type) {
    case "hello": {
      if (!isNonEmptyString(o.sessionId)) return fail("shape", "hello 缺 sessionId");
      if (!isPositiveInt(o.copilotPid) || !isPositiveInt(o.extensionPid)) return fail("shape", "hello 的进程号不对");
      if (typeof o.extensionVersion !== "string") return fail("shape", "hello 缺 extensionVersion");
      return {
        ok: true,
        value: { type: "hello", v, sessionId: o.sessionId, copilotPid: o.copilotPid, extensionPid: o.extensionPid, extensionVersion: o.extensionVersion },
      };
    }
    case "tasks": {
      if (!isFiniteNumber(o.at)) return fail("shape", "tasks 缺 at");
      if (!Array.isArray(o.tasks)) return fail("shape", "tasks 不是数组");
      const tasks: TaskInfo[] = [];
      for (const t of o.tasks) {
        const task = parseTaskInfo(t);
        if (task) tasks.push(task);
      }
      const shellCalls: Record<string, string> = {};
      if (isObject(o.shellCalls)) {
        for (const [shellId, callId] of Object.entries(o.shellCalls)) if (isNonEmptyString(callId)) shellCalls[shellId] = callId;
      }
      return { ok: true, value: { type: "tasks", v, at: o.at, tasks, shellCalls, error: parseExtensionError(o.error) } };
    }
    case "usage": {
      if (!isFiniteNumber(o.at)) return fail("shape", "usage 缺 at");
      if (!isObject(o.agents)) return fail("shape", "usage 缺 agents");
      const agents: Record<string, AgentUsage> = {};
      for (const [agentId, u] of Object.entries(o.agents)) {
        const usage = parseUsage(u);
        if (usage) agents[agentId] = usage;
      }
      return { ok: true, value: { type: "usage", v, at: o.at, agents } };
    }
    case "result": {
      if (typeof o.requestId !== "string" || !REQUEST_ID.test(o.requestId)) return fail("shape", "result 的 requestId 不对");
      if (o.ok === true) return { ok: true, value: { type: "result", v, requestId: o.requestId, ok: true } };
      if (o.ok !== false) return fail("shape", "result 缺 ok");
      const reason = isNonEmptyString(o.reason) ? o.reason : "扩展没有说明原因";
      return { ok: true, value: { type: "result", v, requestId: o.requestId, ok: false, reason, ...(o.uncertain === true ? { uncertain: true as const } : {}) } };
    }
    default:
      return fail("type", `不认识的消息类型 ${JSON.stringify(o.type)}`);
  }
}

/** 把界面发来的一行解析成请求。扩展用它；坏请求返回错误，扩展据此回一条 ok: false 的 result（requestId 能读出来时）。 */
export function parseUiMessage(line: string): ParseResult<UiMessage> {
  const parsed = parseJsonObject(line);
  if (!parsed.ok) return parsed;
  const o = parsed.value;
  const versionError = checkVersion(o);
  if (versionError) return versionError;
  if (o.type !== "request") return fail("type", `不认识的消息类型 ${JSON.stringify(o.type)}`);
  if (typeof o.requestId !== "string" || !REQUEST_ID.test(o.requestId)) return fail("shape", "request 的 requestId 不对");
  const base = { type: "request" as const, v: PROTOCOL_VERSION, requestId: o.requestId };
  switch (o.op) {
    case "refreshTasks":
      return { ok: true, value: { ...base, op: "refreshTasks" } };
    case "sendMessage":
      if (!isNonEmptyString(o.taskId)) return fail("shape", "sendMessage 缺 taskId");
      if (!isNonEmptyString(o.message)) return fail("shape", "sendMessage 缺 message");
      return { ok: true, value: { ...base, op: "sendMessage", taskId: o.taskId, message: o.message } };
    case "cancel":
    case "promoteToBackground":
    case "remove":
      if (!isNonEmptyString(o.taskId)) return fail("shape", `${o.op} 缺 taskId`);
      return { ok: true, value: { ...base, op: o.op, taskId: o.taskId } };
    default:
      return fail("shape", `不认识的请求 ${JSON.stringify(o.op)}`);
  }
}

/** 从一条坏请求里尽量读出 requestId，好让扩展回一条失败的 result；读不出来返回 null。 */
export function salvageRequestId(line: string): string | null {
  const parsed = parseJsonObject(line);
  if (!parsed.ok) return null;
  const id = parsed.value.requestId;
  return typeof id === "string" && REQUEST_ID.test(id) ? id : null;
}

/** 序列化成一行：JSON 加换行。JSON.stringify 会把字符串里的换行转义，所以一条消息永远只占一行。 */
export function serializeMessage(message: ExtensionMessage | UiMessage): string {
  return JSON.stringify(message) + "\n";
}

/** 校验并读出登记记录。字段缺失或类型不对返回错误；tmuxPane 不是字符串当作 null。 */
export function parseRegistration(text: string): ParseResult<Registration> {
  const parsed = parseJsonObject(text);
  if (!parsed.ok) return parsed;
  const o = parsed.value;
  if (o.v !== REGISTRATION_VERSION) return fail("version", `登记记录的格式版本是 ${JSON.stringify(o.v)}，这一边只认 ${REGISTRATION_VERSION}`);
  if (!isNonEmptyString(o.sessionId)) return fail("shape", "登记记录缺 sessionId");
  if (!isPositiveInt(o.copilotPid) || !isPositiveInt(o.extensionPid)) return fail("shape", "登记记录的进程号不对");
  if (o.socketPath !== null && !isNonEmptyString(o.socketPath)) return fail("shape", "登记记录缺 socketPath");
  if (!isFiniteNumber(o.startedAt) || !isFiniteNumber(o.updatedAt)) return fail("shape", "登记记录的时间不对");
  return {
    ok: true,
    value: {
      v: REGISTRATION_VERSION,
      protocol: isFiniteNumber(o.protocol) ? o.protocol : 0,
      sessionId: o.sessionId,
      copilotPid: o.copilotPid,
      extensionPid: o.extensionPid,
      tmuxPane: isNonEmptyString(o.tmuxPane) ? o.tmuxPane : null,
      cwd: typeof o.cwd === "string" ? o.cwd : "",
      socketPath: o.socketPath as string | null,
      extensionVersion: typeof o.extensionVersion === "string" ? o.extensionVersion : "",
      startedAt: o.startedAt,
      updatedAt: o.updatedAt,
    },
  };
}

export function serializeRegistration(r: Registration): string {
  return JSON.stringify(r, null, 2) + "\n";
}

/**
 * 把 socket 收到的字节切成行。按 \n 切，去掉行尾的 \r，空行不交付；没有换行结尾的半行留到下次。
 * 一行超过 maxLineBytes 时整行丢弃（droppedLines 加 1），接着从下一个换行之后继续。
 */
export class LineDecoder {
  readonly maxLineBytes: number;
  #pending: Buffer[] = [];
  #pendingBytes = 0;
  #skipping = false;
  #dropped = 0;

  constructor(maxLineBytes: number = MAX_LINE_BYTES) {
    this.maxLineBytes = maxLineBytes;
  }

  /** 至今丢掉的超长行数。 */
  get droppedLines(): number {
    return this.#dropped;
  }

  push(chunk: Buffer | string): string[] {
    const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    const lines: string[] = [];
    let start = 0;
    while (start < buf.length) {
      const nl = buf.indexOf(0x0a, start);
      const end = nl === -1 ? buf.length : nl;
      const piece = buf.subarray(start, end);
      if (!this.#skipping) {
        if (this.#pendingBytes + piece.length > this.maxLineBytes) {
          this.#skipping = true;
          this.#dropped += 1;
          this.#pending = [];
          this.#pendingBytes = 0;
        } else if (piece.length > 0) {
          this.#pending.push(piece);
          this.#pendingBytes += piece.length;
        }
      }
      if (nl === -1) break;
      if (!this.#skipping) {
        let line = Buffer.concat(this.#pending).toString("utf8");
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (line !== "") lines.push(line);
      }
      this.#pending = [];
      this.#pendingBytes = 0;
      this.#skipping = false;
      start = nl + 1;
    }
    return lines;
  }
}
