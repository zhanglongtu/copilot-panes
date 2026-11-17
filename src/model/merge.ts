// 把状态库和扩展推来的任务列表、用量合成名单。纯函数，不碰文件系统（命令的最后一行由调用方通过 lastOutputLine 给）。
// 规则的全貌见 docs/architecture.md。

import { FOREGROUND_LIST_AFTER_MS, TASKS_STALE_MS } from "../constants.ts";
import type { TaskAgentInfo, TaskShellInfo } from "../protocol.ts";
import {
  agentKey,
  commandKey,
  isEnded,
  type AgentRecord,
  type BuildListInput,
  type CommandRecord,
  type EntryKey,
  type EntryStatus,
  type ListEntry,
  type TaskRef,
  type TasksSnapshot,
} from "../types/model.ts";
import { agentStep, commandStep, shortModel } from "./describe.ts";
import { parseTimestamp } from "./events.ts";
import { commandDisplayName } from "./command-name.ts";
import { tokensByAgent, tokensPartial } from "./tokens.ts";

/**
 * 任务列表新不新鲜：连接还在（connected），并且 now - receivedAt 不超过 TASKS_STALE_MS（恰好 15 秒仍新鲜）。
 * tasks 为 null 时不新鲜。
 */
export function isTasksFresh(tasks: TasksSnapshot | null, now: number): boolean {
  return tasks !== null && tasks.connected && now - tasks.receivedAt <= TASKS_STALE_MS;
}

/**
 * 命令该不该上名单（不算 keep 和 collapseEnded）：
 * - 在跑：后台命令一启动就上；前台命令 now - startedAt 满 FOREGROUND_LIST_AFTER_MS（2 秒）才上。
 * - 已结束：keptAsFailed 的上（最多 5 条，由状态库维护）；其余不上（成功结束就消失）。
 */
export function isCommandListed(command: CommandRecord, now: number): boolean {
  if (command.status === "running") return command.background || now - command.startedAt >= FOREGROUND_LIST_AFTER_MS;
  return command.keptAsFailed;
}

/** 子 agent 到 now 为止的用时：activeMs + (busySince 不为空时 now - busySince)。 */
export function agentElapsedMs(agent: AgentRecord, now: number): number {
  return agent.activeMs + (agent.busySince === null ? 0 : Math.max(0, now - agent.busySince));
}

/** 命令的用时：(endedAt 或 now) - startedAt，不小于 0。 */
export function commandElapsedMs(command: CommandRecord, now: number): number {
  return Math.max(0, (command.endedAt ?? now) - command.startedAt);
}

/** 名单里命令的名字：去掉 cd、env、timeout、bash -c 这些包装和末尾的 `| tee log`，多行的取第一条有意义的命令（command-name.ts）。 */
function commandName(command: CommandRecord): string {
  return commandDisplayName(command.command) || command.toolName;
}

interface Node {
  key: EntryKey;
  parentKey: EntryKey | null;
  startedAt: number;
  id: string;
  shown: boolean;
  /** 只给要显示的条目调用：名单里多数条目（成千上万条已结束的命令）不需要算各列。 */
  build: () => Omit<ListEntry, "depth" | "parentKey">;
}

/**
 * 得出名单，按显示顺序排好（父在前、子紧跟其后），每行带缩进层数。
 *
 * 哪些行：状态库里所有子 agent；isCommandListed 为真的命令；keep 里的条目（即使按规则该消失）。
 * 任务列表新鲜时（isTasksFresh），另外：所属子 agent 结束时被丢掉的后台命令（endReason 为 "agent-ended"），
 * 对上的 shell 任务说它还 running 的，照样列出、状态写 running（任务列表说还在跑，就以它为准）。
 *
 * 状态：子 agent 先取事件状态；任务列表新鲜、有 type 为 agent 且 id 等于 agentId 的任务时，任务说 running 就是 running、
 * 说 idle 就是 idle、说 cancelled 就是 cancelled（agentEntryStatus），其他任务状态仍用事件状态。
 * 命令的状态只看事件（上面那条例外）；被取消的（stop_bash、中断主会话、任务列表说 cancelled）是 cancelled，不是 stopped。
 *
 * description 和 promptFoldChars：见 ListEntry；description 取子 agent 的 description，没有时取任务的 description。
 *
 * 对上任务（ListEntry.task）：任务列表新鲜时才有。子 agent 找 type 为 agent、id 等于 agentId 的任务；命令找 shellCalls 里
 * 值等于 toolCallId 的那个 shell 任务 id，再找这个 id 的 type 为 shell 的任务。对不上是 null。
 *
 * 层级：子 agent 挂在 parentId 的子 agent 下面；命令挂在 agentId 的子 agent 下面；找不到上一级的挂最外层。
 * 上一级不在名单上（被 collapseEnded 收起）时，下级往上顶一层。
 * ListEntry.parentKey 是名单上离它最近的上一级，往上顶之后就是更高一级的键，最外层是 null。
 *
 * 顺序：同一个上一级下面的子 agent 和命令混在一起，按 startedAt 从早到晚排；startedAt 相同按 id 排。
 * 不按“失败的在前、在跑的其次”分组排序，因为行会随状态跳动。
 * 被收起的上一级的下级顶上来之后，仍排在那个上一级原来的位置。
 *
 * collapseEnded：收起状态是 done、failed、stopped、cancelled 的条目（keep 里的不收），它们在跑的下级照样显示并往上顶。
 *
 * 各列：name、model（describe.ts 的 shortModel）、elapsedMs（任务列表说 idle 且带 idleSince 时，停在 idleSince）、
 * tokens（tokens.ts 的 tokensByAgent，含下级）、step（describe.ts 的 agentStep、commandStep）、exitCode。
 */
export function buildList(input: BuildListInput): ListEntry[] {
  const { store, tasks, usage, now, collapseEnded, keep, lastOutputLine, usageSince } = input;
  const agentTasks = new Map<string, TaskAgentInfo>();
  const shellTasks = new Map<string, TaskShellInfo>();
  const shellOfCall = new Map<string, string>();
  if (tasks && isTasksFresh(tasks, now)) {
    for (const task of tasks.tasks) {
      if (task.type === "agent") agentTasks.set(task.id, task);
      else if (task.type === "shell") shellTasks.set(task.id, task);
    }
    for (const [shellId, toolCallId] of Object.entries(tasks.shellCalls)) shellOfCall.set(toolCallId, shellId);
  }

  const tokens = tokensByAgent(store, usage);
  const nodes: Node[] = [];
  for (const agent of store.agents()) {
    const task = agentTasks.get(agent.id);
    const status = agentEntryStatus(agent, task);
    const description = agent.description !== "" ? agent.description : (task?.description ?? "");
    const key = agentKey(agent.id);
    const idleAt = status === "idle" && task?.idleSince ? parseTimestamp(task.idleSince) : 0;
    nodes.push({
      key,
      parentKey: agent.parentId !== null && store.agent(agent.parentId) ? agentKey(agent.parentId) : null,
      startedAt: agent.startedAt,
      id: agent.id,
      shown: keep.has(key) || !(collapseEnded && isEnded(status)),
      build: () => ({
        key,
        kind: "agent",
        id: agent.id,
        status,
        name: agent.name,
        ...(description !== "" ? { description } : {}),
        ...((agent.promptFoldChars ?? 0) > 0 ? { promptFoldChars: agent.promptFoldChars } : {}),
        model: shortModel(agent.model),
        startedAt: agent.startedAt,
        elapsedMs: agentElapsedMs(agent, idleAt > 0 ? idleAt : now),
        tokens: tokens.get(agent.id) ?? null,
        ...(tokensPartial(agent, status, usage?.[agent.id], usageSince) ? { tokensPartial: true } : {}),
        step: agentStep(agent, status, store),
        exitCode: null,
        task: task
          ? { id: task.id, status: task.status, executionMode: task.executionMode ?? null, canPromoteToBackground: task.canPromoteToBackground === true, pid: null }
          : null,
      }),
    });
  }
  for (const command of store.commands()) {
    const shellTaskId = shellOfCall.get(command.toolCallId);
    const task = shellTaskId === undefined ? undefined : shellTasks.get(shellTaskId);
    const revived = command.status === "stopped" && command.endReason === "agent-ended" && task?.status === "running";
    const viaTask = command.status === "running" ? endedByTask(task, now) : null;
    const status: EntryStatus = revived ? "running" : (viaTask?.status ?? commandEntryStatus(command));
    const key = commandKey(command.toolCallId);
    // 被 tasks.cancel 停掉的命令事件日志里没有结束通知（实测），只能看任务列表；这样结束的命令不上名单，选中时由 keep 留着
    const listed = revived || (viaTask === null && isCommandListed(command, now));
    const shown = keep.has(key) || (listed && !(collapseEnded && isEnded(status)));
    if (!shown) continue; // 命令没有下级，不显示就不用进树
    nodes.push({
      key,
      parentKey: command.agentId !== null && store.agent(command.agentId) ? agentKey(command.agentId) : null,
      startedAt: command.startedAt,
      id: command.toolCallId,
      shown,
      build: () => ({
        key,
        kind: "command",
        id: command.toolCallId,
        status,
        name: commandName(command),
        model: null,
        startedAt: command.startedAt,
        elapsedMs: revived ? Math.max(0, now - command.startedAt) : viaTask ? Math.max(0, viaTask.endedAt - command.startedAt) : commandElapsedMs(command, now),
        tokens: null,
        step: commandStep(command, status, status === "running" ? safeLastLine(lastOutputLine, command.toolCallId) : ""),
        exitCode: command.exitCode,
        task: task ? shellRef(task) : null,
      }),
    });
  }

  const children = new Map<EntryKey | null, Node[]>();
  for (const node of nodes) {
    const siblings = children.get(node.parentKey);
    if (siblings) siblings.push(node);
    else children.set(node.parentKey, [node]);
  }
  for (const siblings of children.values()) siblings.sort(byStart);

  const out: ListEntry[] = [];
  const visited = new Set<Node>();
  const walk = (node: Node, depth: number, shownParent: EntryKey | null): void => {
    if (visited.has(node)) return;
    visited.add(node);
    if (node.shown) {
      out.push({ ...node.build(), depth, parentKey: shownParent });
      for (const child of children.get(node.key) ?? []) walk(child, depth + 1, node.key);
    } else {
      for (const child of children.get(node.key) ?? []) walk(child, depth, shownParent);
    }
  };
  for (const node of children.get(null) ?? []) walk(node, 0, null);
  // 上一级互相指着对方的怪事件：够不着的条目当作最外层，不丢
  for (const node of [...nodes].sort(byStart)) walk(node, 0, null);
  return out;
}

function byStart(a: Node, b: Node): number {
  if (a.startedAt !== b.startedAt) return a.startedAt - b.startedAt;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * 事件日志说命令还在跑，而任务列表里它的 shell 任务已经结束（cancelled、failed、completed）：命令是被 tasks.cancel 停掉的、
 * 或结束通知还没来。返回按任务算出的状态和结束时刻（completedAt，没有就用 now）；任务还在跑或对不上返回 null。
 */
function endedByTask(task: TaskShellInfo | undefined, now: number): { status: EntryStatus; endedAt: number } | null {
  if (!task || task.status === "running" || task.status === "idle") return null;
  const status: EntryStatus = task.status === "cancelled" ? "cancelled" : task.status === "failed" ? "failed" : "done";
  const completed = task.completedAt ? parseTimestamp(task.completedAt) : 0;
  return { status, endedAt: completed > 0 ? completed : now };
}

/**
 * 子 agent 在名单上的状态。任务列表新鲜时：任务说 running 就是 running、说 idle 就是 idle、说 cancelled 就是 cancelled
 * （事件是 running、stopped 或 done 时；事件里的取消记录可能晚一点才来）。其他按事件：stopped 并且带取消记录的是 cancelled，
 * 随 session 结束或续接而停的仍是 stopped。
 */
function agentEntryStatus(agent: AgentRecord, task: TaskAgentInfo | undefined): EntryStatus {
  if (task?.status === "running") return "running";
  if (task?.status === "idle") return "idle";
  if (task?.status === "cancelled" && agent.status !== "failed") return "cancelled";
  return agent.status === "stopped" && agent.cancelled === true ? "cancelled" : agent.status;
}

/** 命令在名单上的状态：stop_bash 停掉的和用户中断主会话时取消的是 cancelled；所属子 agent 结束时被丢掉、session 结束时停掉的仍是 stopped。 */
function commandEntryStatus(command: CommandRecord): EntryStatus {
  return command.status === "stopped" && (command.endReason === "stopped" || command.endReason === "aborted") ? "cancelled" : command.status;
}

function shellRef(task: TaskShellInfo): TaskRef {
  return {
    id: task.id,
    status: task.status,
    executionMode: task.executionMode ?? null,
    canPromoteToBackground: task.canPromoteToBackground === true,
    pid: typeof task.pid === "number" ? task.pid : null,
    ...(task.attachmentMode === "detached" ? { detached: true as const } : {}),
  };
}

function safeLastLine(lastOutputLine: (toolCallId: string) => string, toolCallId: string): string {
  try {
    return lastOutputLine(toolCallId);
  } catch {
    return "";
  }
}
