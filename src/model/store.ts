// 状态库：把一个 session 的事件逐条喂进来，得出子 agent、命令和每个子 agent 的过程记录。
// 对外只通过 StoreView 接口读。
// shell 命令的部分在 commands.ts。

import { LAST_REPLY_KEEP_CHARS } from "../constants.ts";
import type { AgentRecord, CommandRecord, EventStatus, MessageItem, SayItem, StoreView, TaskItem, ThinkItem, ToolItem, TranscriptItem } from "../types/model.ts";
import { CommandBook, isInt, isRecord, textOf } from "./commands.ts";
import { parseEventLine, parseTimestamp, type CopilotEvent } from "./events.ts";
import { MESSAGE_KEEP_CHARS, SHRUNK_KEEP_CHARS, TOOL_TEXT_KEEP_CHARS, TextBudget, clipHead, clipJson, noteCut, setEditLines } from "./limits.ts";
import { oneLine } from "./output.ts";
import { PromptFolds } from "./prompt-fold.ts";

const SHELL_TOOLS = new Set(["bash", "powershell"]);
const NO_ITEMS: readonly TranscriptItem[] = Object.freeze([]);

/** 状态库处理的事件类型。其余类型（hook.*、assistant.turn_*、session.usage_record 等占多数）不用解析整行。 */
const HANDLED = new Set([
  "session.start",
  "session.resume",
  "session.shutdown",
  "session.model_change",
  "abort",
  "subagent.started",
  "subagent.configured",
  "subagent.completed",
  "subagent.failed",
  "user.message",
  "assistant.message",
  "tool.execution_start",
  "tool.execution_complete",
  "system.notification",
  "session.usage_record",
]);
const TYPE_PREFIX = '{"type":"';
const TIMESTAMP_KEY = '"timestamp":"';
const AGENT_ID_KEY = '"agentId":"';

/**
 * 一个 session 的状态库。要点：
 * - 时间用 Unix 毫秒。
 * - 过程记录按子 agent 分开存（transcript(agentId)），每条带序号和时间；工具调用的开始和完成合成一条 ToolItem。
 * - 结束条目（EndItem）里的用时、调用次数、token 取事件当时的值，不是子 agent 的最新值（快照）。
 * - 长期保留的文字有上限（limits.ts）：工具的参数和结果每个字符串 4 KB，说的话和消息每条 64 KB，超出的截掉并记下数量（cutChars）。
 * 文件被截短或替换时（LineTailer 的 reset），调用方丢掉这个对象、新建一个从头喂，不要在旧对象上接着喂。
 */
export class SessionStore implements StoreView {
  readonly sessionId: string;
  private versionCount = 0;
  private cwdValue: string | null = null;
  private mainModelValue: string | null = null;
  private lastEventTime = 0;

  private readonly agentMap = new Map<string, AgentRecord>();
  private readonly agentList: AgentRecord[] = [];
  /** 发起子 agent 的 task 调用的 toolCallId → 子 agent。 */
  private readonly agentByTaskCall = new Map<string, AgentRecord>();
  private readonly completions = new Map<string, number>();
  private readonly transcripts = new Map<string, TranscriptItem[]>();
  private readonly toolItems = new Map<string, ToolItem>();
  /** task 调用的 toolCallId → 发起它的 agentId（主会话是 null）。 */
  private readonly taskOwner = new Map<string, string | null>();
  /** task 调用的 toolCallId → 它的 description 参数（三五个词的简述）。 */
  private readonly taskDescriptions = new Map<string, string>();
  /** 已经收到过 user.message 的 agentId；第一条是派活的话。 */
  private readonly messageSeen = new Set<string>();
  /** 各子 agent 任务说明开头的共有段落（prompt-fold.ts）。 */
  private readonly folds = new PromptFolds();
  private readonly book: CommandBook;
  private readonly budget: TextBudget;

  /** options.textBudgetChars 只给测试用：长文字的总量预算，默认 TEXT_BUDGET_CHARS。 */
  constructor(sessionId: string, options?: { textBudgetChars?: number }) {
    this.sessionId = sessionId;
    this.budget = new TextBudget(options?.textBudgetChars);
    this.book = new CommandBook(this.budget);
  }

  get version(): number {
    return this.versionCount;
  }

  get cwd(): string | null {
    return this.cwdValue;
  }

  get mainModel(): string | null {
    return this.mainModelValue;
  }

  get lastEventAt(): number {
    return this.lastEventTime;
  }

  /** 解析一行并处理。坏行、不认识的事件类型、处理时出错，都只丢这一行，不抛异常，已有状态不受影响。返回状态有没有变。 */
  feedLine(line: string): boolean {
    try {
      if (line.startsWith(TYPE_PREFIX)) {
        const end = line.indexOf('"', TYPE_PREFIX.length);
        const type = end > 0 ? line.slice(TYPE_PREFIX.length, end) : "";
        // 用量记录占事件的大多数：只有带子 agent 的 agentId 的才要解析；主会话的（没有 agentId）和别的类型一样跳过
        const skipped = !HANDLED.has(type) || (type === "session.usage_record" && !line.includes(AGENT_ID_KEY));
        if (type !== "" && !type.includes("\\") && skipped) {
          const at = peekTimestamp(line);
          if (at > this.lastEventTime) this.lastEventTime = at;
          return false;
        }
      }
      const event = parseEventLine(line);
      return event ? this.feed(event) : false;
    } catch {
      return false;
    }
  }

  /**
   * 处理一个事件，按 type 分发（处理哪些类型、读哪些字段，见下面的 switch）；此外：
   * - subagent.started 的 model 缺失时，用随后 subagent.configured 的 model 补上。
   * - 主会话（没有 agentId）的 assistant.message、user.message 不进任何过程记录；主会话的 tool 调用只用来登记命令和 task 调用的归属。
   * 处理时抛的异常在这里吞掉（只丢这一条事件）。返回状态有没有变。
   */
  feed(event: CopilotEvent): boolean {
    if (event.at > this.lastEventTime) this.lastEventTime = event.at;
    let changed: boolean;
    try {
      changed = this.dispatch(event);
    } catch {
      changed = true;
    }
    if (changed) this.versionCount++;
    return changed;
  }

  agents(): readonly AgentRecord[] {
    return this.agentList;
  }

  commands(): readonly CommandRecord[] {
    return this.book.list();
  }

  agent(id: string): AgentRecord | undefined {
    return this.agentMap.get(id);
  }

  command(toolCallId: string): CommandRecord | undefined {
    return this.book.get(toolCallId);
  }

  commandByShellId(shellId: string): CommandRecord | undefined {
    return this.book.byShellId(shellId);
  }

  transcript(agentId: string): readonly TranscriptItem[] {
    return this.transcripts.get(agentId) ?? NO_ITEMS;
  }

  // ───── 分发 ─────

  private dispatch(event: CopilotEvent): boolean {
    const { data, at } = event;
    switch (event.type) {
      case "session.start":
        return this.onSessionStart(data);
      case "session.resume":
        this.onSessionStart(data);
        this.closeAll(at);
        return true;
      case "session.shutdown":
        return this.closeAll(at);
      case "session.model_change":
        if (event.agentId === null && typeof data.newModel === "string" && data.newModel !== "") {
          this.mainModelValue = data.newModel;
          return true;
        }
        return false;
      case "abort":
        return this.onAbort(event);
      case "subagent.started":
        return this.onSubagentStarted(event);
      case "subagent.configured":
        return this.onSubagentConfigured(event);
      case "subagent.completed":
        return this.onSubagentEnded(event, false);
      case "subagent.failed":
        return this.onSubagentEnded(event, true);
      case "user.message":
        return this.onUserMessage(event);
      case "assistant.message":
        return this.onAssistantMessage(event);
      case "system.notification":
        return this.onNotification(event);
      case "session.usage_record":
        return this.onUsageRecord(event);
      case "tool.execution_start":
        return this.onToolStart(event);
      case "tool.execution_complete":
        return this.onToolComplete(event);
      default:
        return false;
    }
  }

  // ───── 会话级 ─────

  private onSessionStart(data: Record<string, unknown>): boolean {
    const model = textOf(data.selectedModel);
    if (model) this.mainModelValue = model;
    const cwd = isRecord(data.context) ? textOf(data.context.cwd) : "";
    if (cwd) this.cwdValue = cwd;
    return true;
  }

  /** 进程退出或会话续接：之前没结束的子 agent 和命令都不会再有下文，标成已停止。 */
  private closeAll(at: number): boolean {
    let changed = false;
    for (const agent of this.agentList) {
      if (agent.status === "running") {
        this.finish(agent, "stopped", at, undefined);
        this.pushEnd(agent, "stopped", at);
        changed = true;
      }
    }
    return this.book.stopAll(at) || changed;
  }

  private onAbort(event: CopilotEvent): boolean {
    const { at } = event;
    if (event.agentId !== null) {
      const agent = this.agentMap.get(event.agentId);
      if (!agent || event.data.reason !== "subagent_cancelled") return false;
      if (agent.status === "running") this.finish(agent, "stopped", at, undefined);
      else agent.status = "stopped";
      agent.cancelled = true;
      this.book.dropBackground(agent.id, at);
      this.pushEnd(agent, "stopped", at);
      return true;
    }
    // 用户中断了主会话的这一轮：它等着的前台命令和同步子 agent 都被取消。
    // 日志里没有这种情况的先例，这些子 agent 之后只要收到消息、或又来一条 subagent.started，就会重新标成在跑。
    let changed = false;
    for (const agent of this.agentList) {
      if (agent.status === "running" && agent.executionMode === "sync") {
        this.finish(agent, "stopped", at, undefined);
        agent.cancelled = true;
        this.pushEnd(agent, "stopped", at);
        changed = true;
      }
    }
    return this.book.stopMainForeground(at) || changed;
  }

  // ───── 子 agent ─────

  private ensureAgent(id: string, at: number): AgentRecord {
    let agent = this.agentMap.get(id);
    if (!agent) {
      agent = {
        id,
        toolCallId: null,
        name: id.slice(0, 8),
        agentType: "",
        description: "",
        model: null,
        executionMode: null,
        parentId: null,
        status: "running",
        startedAt: at,
        endedAt: null,
        activeMs: 0,
        busySince: at,
        toolCalls: 0,
        totalTokens: null,
        error: null,
        lastReply: "",
        lastToolCallId: null,
      };
      this.agentMap.set(id, agent);
      this.agentList.push(agent);
    }
    return agent;
  }

  private onSubagentStarted(event: CopilotEvent): boolean {
    const { data, at } = event;
    const id = event.agentId ?? (textOf(data.toolCallId) || "?");
    const agent = this.ensureAgent(id, at);
    agent.name = textOf(data.agentDisplayName) || textOf(data.agentName) || agent.name;
    agent.agentType = textOf(data.agentType) || textOf(data.agentName);
    agent.description = clipHead(textOf(data.agentDescription), TOOL_TEXT_KEEP_CHARS).text;
    delete agent.cancelled;
    agent.model = textOf(data.model) || agent.model;
    agent.toolCallId = textOf(data.toolCallId) || null;
    agent.executionMode = data.executionMode === "sync" || data.executionMode === "background" ? data.executionMode : null;
    agent.status = "running";
    agent.startedAt = at;
    agent.endedAt = null;
    agent.busySince = at;
    if (agent.toolCallId !== null) {
      this.agentByTaskCall.set(agent.toolCallId, agent);
      agent.parentId = this.taskOwner.get(agent.toolCallId) ?? null;
      const call = this.toolItems.get(agent.toolCallId);
      if (call) call.childAgentId = id;
      // 事件里没带 agentDescription 时，退回 task 调用自己的 description 参数
      if (agent.description === "") agent.description = this.taskDescriptions.get(agent.toolCallId) ?? "";
    }
    return true;
  }

  private onSubagentConfigured(event: CopilotEvent): boolean {
    const agent = event.agentId === null ? undefined : this.agentMap.get(event.agentId);
    const model = textOf(event.data.model);
    if (!agent || agent.model || !model) return false;
    agent.model = model;
    return true;
  }

  private locate(event: CopilotEvent): AgentRecord | undefined {
    const byId = event.agentId === null ? undefined : this.agentMap.get(event.agentId);
    if (byId) return byId;
    const toolCallId = textOf(event.data.toolCallId);
    return toolCallId ? this.agentByTaskCall.get(toolCallId) : undefined;
  }

  private onSubagentEnded(event: CopilotEvent, failed: boolean): boolean {
    const { data, at } = event;
    const agent = this.locate(event);
    if (!agent) return false;
    if (isInt(data.totalToolCalls)) agent.toolCalls = data.totalToolCalls;
    if (isInt(data.totalTokens)) agent.totalTokens = data.totalTokens;
    let status: EventStatus;
    if (failed) {
      status = "failed";
      const error = data.error;
      const text = typeof error === "string" ? error : error === null || error === undefined ? "" : JSON.stringify(error);
      agent.error = clipHead(oneLine(text ?? ""), TOOL_TEXT_KEEP_CHARS).text || null;
    } else {
      agent.model = textOf(data.model) || agent.model;
      // 在 /tasks 或名单里被停掉的，完成事件里带 cancelled
      status = data.cancelled === true ? "stopped" : "done";
      if (data.cancelled === true) agent.cancelled = true;
      else delete agent.cancelled;
    }
    this.finish(agent, status, at, data.durationMs);
    this.book.dropBackground(agent.id, at);
    this.pushEnd(agent, status, at);
    return true;
  }

  /** 子 agent 做完、失败或被停掉：累计这一段的活跃时间，首次结束且带 durationMs 时以它为准。 */
  private finish(agent: AgentRecord, status: EventStatus, at: number, durationMs: unknown): void {
    const first = (this.completions.get(agent.id) ?? 0) === 0;
    const reported = typeof durationMs === "number" && Number.isFinite(durationMs) ? durationMs : null;
    if (reported !== null && first) agent.activeMs = reported;
    else if (agent.busySince !== null) agent.activeMs += Math.max(0, at - agent.busySince);
    agent.busySince = null;
    agent.endedAt = at;
    agent.status = status;
    this.completions.set(agent.id, (this.completions.get(agent.id) ?? 0) + 1);
  }

  private onUserMessage(event: CopilotEvent): boolean {
    const { data, at } = event;
    if (event.agentId === null) return false;
    const agent = this.agentMap.get(event.agentId);
    const first = !this.messageSeen.has(event.agentId);
    this.messageSeen.add(event.agentId);
    let changed = false;
    const content = data.content;
    if (agent && typeof content === "string" && content.trim() !== "") {
      const raw = content.replace(/^\n+|\n+$/g, "");
      if (first) {
        const task = this.pushText(agent.id, { kind: "task", at }, raw) as TaskItem;
        this.folds.add(agent.id, task.text);
        this.refreshFolds();
      } else this.pushText(agent.id, { kind: "message", at, ...this.sender(data.source) }, raw);
      changed = true;
    }
    // 子 agent 做完后，父 agent 或用户再发来一条消息，它就重新开始干活
    if (agent && agent.status !== "running") {
      agent.status = "running";
      agent.busySince = at;
      agent.endedAt = null;
      delete agent.cancelled;
      this.push(agent.id, { kind: "resume", at });
      changed = true;
    }
    return changed;
  }

  /**
   * 消息是谁发的：没有 source 是你从界面发的；agent-<id> 里的 id 是已知子 agent 就是它（真实日志里主会话发的消息都是
   * agent-<会话 ID>，不是已知子 agent，算主会话）；其余是系统自己发的（见过 system、memory、schedule-<n>、command-<id>），
   * 取第一个“-”前的词，不把 id 带进记录。
   */
  private sender(source: unknown): { from: "you" | "main" | "agent" | "other"; fromName: string } {
    if (typeof source !== "string" || source === "") return { from: "you", fromName: "你" };
    if (source.startsWith("agent-")) {
      const known = this.agentMap.get(source.slice("agent-".length));
      return known ? { from: "agent", fromName: known.name } : { from: "main", fromName: "主会话" };
    }
    return { from: "other", fromName: source.split("-")[0] || source };
  }

  private onNotification(event: CopilotEvent): boolean {
    const { data, at } = event;
    const kind = data.kind;
    if (!isRecord(kind)) return false;
    if (kind.type === "agent_idle") {
      const agent = typeof kind.agentId === "string" ? this.agentMap.get(kind.agentId) : undefined;
      if (!agent || agent.status !== "running") return false;
      this.finish(agent, "done", at, undefined);
      this.book.dropBackground(agent.id, at);
      this.pushEnd(agent, "done", at);
      return true;
    }
    if (kind.type === "shell_completed" || kind.type === "shell_detached_completed") {
      const shellId = kind.shellId;
      if (typeof shellId !== "string" && typeof shellId !== "number") return false;
      return this.book.endByNotification(String(shellId), kind.exitCode, at);
    }
    return false;
  }

  /** 一次模型调用的用量：输入加输出（不含缓存）累加到子 agent 上。不认识的子 agent 不理（不为它建占位记录）。 */
  private onUsageRecord(event: CopilotEvent): boolean {
    const agent = event.agentId === null ? undefined : this.agentMap.get(event.agentId);
    const usage = event.data.usage;
    if (!agent || !isRecord(usage)) return false;
    const tokens = (isInt(usage.inputTokens) && usage.inputTokens > 0 ? usage.inputTokens : 0) + (isInt(usage.outputTokens) && usage.outputTokens > 0 ? usage.outputTokens : 0);
    agent.eventTokens = (agent.eventTokens ?? 0) + tokens;
    return true;
  }

  // ───── 回复和思考 ─────

  private onAssistantMessage(event: CopilotEvent): boolean {
    const { data, at } = event;
    if (event.agentId === null) return false;
    const agent = this.ensureAgent(event.agentId, at);
    let changed = false;
    const think = data.reasoningText;
    if (typeof think === "string" && think.trim() !== "") {
      this.pushText(agent.id, { kind: "think", at }, think.trim());
      changed = true;
    }
    const content = data.content;
    if (typeof content === "string" && content.trim() !== "") {
      const whole = content.trim();
      agent.lastReply = clipHead(whole, LAST_REPLY_KEEP_CHARS).text;
      this.pushText(agent.id, { kind: "say", at }, whole);
      changed = true;
    }
    return changed;
  }

  // ───── 工具调用 ─────

  private onToolStart(event: CopilotEvent): boolean {
    const { data, at } = event;
    const name = textOf(data.toolName);
    const toolCallId = textOf(data.toolCallId);
    const args = isRecord(data.arguments) ? data.arguments : {};
    let changed = false;
    const agent = event.agentId === null ? null : this.ensureAgent(event.agentId, at);
    if (agent) {
      agent.toolCalls++;
      agent.lastToolCallId = toolCallId || null;
      changed = true;
    }
    if (name === "task") {
      this.taskOwner.set(toolCallId, event.agentId);
      const description = clipHead(textOf(args.description), TOOL_TEXT_KEEP_CHARS).text;
      if (description !== "") this.taskDescriptions.set(toolCallId, description);
      const child = this.agentByTaskCall.get(toolCallId);
      if (child) child.parentId = event.agentId;
      changed = true;
    }
    this.book.noteCall(toolCallId, name, args);
    if (SHELL_TOOLS.has(name)) {
      this.book.start(toolCallId, name, args, event.agentId, at);
      changed = true;
    }
    if (agent) {
      // 命令、路径、行号范围这些一行摘要要的参数，上面已经交给 CommandBook 和 task 的归属了；这里留下的是截过的
      const clippedArgs = clipJson(data.arguments, TOOL_TEXT_KEEP_CHARS);
      const item = this.push(agent.id, {
        kind: "tool",
        at,
        toolCallId,
        toolName: name,
        args: clippedArgs.value,
        status: "running",
        endedAt: null,
        resultText: null,
        errorText: null,
        telemetry: null,
        childAgentId: null,
      });
      noteCut(item, "args", clippedArgs.cut);
      this.budget.add(clippedArgs.size, () => {
        const shrunk = clipJson((item as ToolItem).args, SHRUNK_KEEP_CHARS);
        (item as ToolItem).args = shrunk.value;
        noteCut(item, "args", shrunk.cut);
      });
      if (toolCallId) this.toolItems.set(toolCallId, item as ToolItem);
      const child = name === "task" ? this.agentByTaskCall.get(toolCallId) : undefined;
      if (child) (item as ToolItem).childAgentId = child.id;
    }
    return changed;
  }

  private onToolComplete(event: CopilotEvent): boolean {
    const { data, at } = event;
    const toolCallId = textOf(data.toolCallId);
    let changed = this.book.complete(toolCallId, data, at);
    const item = this.toolItems.get(toolCallId);
    if (item && item.status === "running") {
      const result = isRecord(data.result) ? data.result : {};
      const detailed = typeof result.detailedContent === "string" ? result.detailedContent : null;
      const content = typeof result.content === "string" ? result.content : null;
      const error = data.error;
      const errorText = isRecord(error) ? textOf(error.message) : textOf(error);
      item.status = data.success === false || errorText !== "" ? "failed" : "ok";
      item.endedAt = at;
      const full = detailed ?? content ?? "";
      if (item.toolName === "edit") setEditLines(item, full); // 增删行数要数完整的 diff，截断之前取
      const clippedResult = clipHead(full, TOOL_TEXT_KEEP_CHARS);
      item.resultText = clippedResult.text;
      noteCut(item, "resultText", clippedResult.cut);
      this.budget.add(clippedResult.text.length, () => {
        const shrunk = clipHead(item.resultText ?? "", SHRUNK_KEEP_CHARS);
        item.resultText = shrunk.text;
        noteCut(item, "resultText", shrunk.cut);
      });
      const clippedError = clipHead(errorText, TOOL_TEXT_KEEP_CHARS);
      item.errorText = clippedError.text || null;
      noteCut(item, "errorText", clippedError.cut);
      item.telemetry = metricsOf(data.toolTelemetry);
      changed = true;
    }
    return changed;
  }

  // ───── 过程记录 ─────

  /** 追加一条说的话、思考、任务说明或消息，截到 MESSAGE_KEEP_CHARS，并记进文字总量的预算。 */
  private pushText(agentId: string, item: DistributiveOmit<TaskItem | SayItem | ThinkItem | MessageItem, "seq" | "text">, raw: string): TranscriptItem {
    const { text, cut } = clipHead(raw, MESSAGE_KEEP_CHARS);
    const pushed = this.push(agentId, { ...item, text } as DistributiveOmit<TranscriptItem, "seq">) as TaskItem | SayItem | ThinkItem | MessageItem;
    noteCut(pushed, "text", cut);
    this.budget.add(text.length, () => {
      const shrunk = clipHead(pushed.text, SHRUNK_KEEP_CHARS);
      pushed.text = shrunk.text;
      noteCut(pushed, "text", shrunk.cut);
    });
    return pushed;
  }

  /** 追加一条过程记录，序号取当前条数。 */
  private push(agentId: string, item: DistributiveOmit<TranscriptItem, "seq">): TranscriptItem {
    let items = this.transcripts.get(agentId);
    if (!items) {
      items = [];
      this.transcripts.set(agentId, items);
    }
    const full = { ...item, seq: items.length } as TranscriptItem;
    items.push(full);
    return full;
  }

  /** 新来了一份任务说明：共有的开头可能变了，更新每个子 agent 的 promptFoldChars。 */
  private refreshFolds(): void {
    for (const id of this.folds.ids()) {
      const agent = this.agentMap.get(id);
      if (!agent) continue;
      const fold = this.folds.fold(id);
      if (fold > 0 || agent.promptFoldChars !== undefined) agent.promptFoldChars = fold;
    }
  }

  /** 结束条目里的数字取事件当时的值，不是子 agent 以后的最新值。被取消的记作 stopped，另外带 cancelled。 */
  private pushEnd(agent: AgentRecord, status: "done" | "failed" | "stopped", at: number): void {
    this.push(agent.id, {
      kind: "end",
      at,
      status,
      durationMs: agent.activeMs,
      toolCalls: agent.toolCalls || null,
      tokens: agent.totalTokens || null,
      error: status === "failed" ? agent.error : null,
      ...(status === "stopped" && agent.cancelled === true ? { cancelled: true as const } : {}),
    });
  }
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** toolTelemetry 里只有 metrics（数字）会用到：匹配数、文件数、增删行数。properties 和 restrictedProperties 不留。 */
function metricsOf(telemetry: unknown): { metrics: Record<string, number> } | null {
  if (!isRecord(telemetry) || !isRecord(telemetry.metrics)) return null;
  const metrics: Record<string, number> = {};
  for (const [key, value] of Object.entries(telemetry.metrics)) if (typeof value === "number") metrics[key] = value;
  return { metrics };
}

function peekTimestamp(line: string): number {
  const index = line.lastIndexOf(TIMESTAMP_KEY);
  return index < 0 ? 0 : parseTimestamp(line.slice(index + TIMESTAMP_KEY.length, index + TIMESTAMP_KEY.length + 40));
}
