// 测试用的合成事件和小工具。字段照真实事件的样子：顶层 type / data / agentId / id / timestamp / parentId。

import type { AgentUsage, TaskAgentInfo, TaskShellInfo } from "../../src/protocol.ts";
import { buildList } from "../../src/model/merge.ts";
import { SessionStore } from "../../src/model/store.ts";
import type { BuildListInput, EntryKey, ListEntry, TasksSnapshot } from "../../src/types/model.ts";

/** 2026-11-13T07:00:00Z，Unix 毫秒。事件的 at 参数是相对它的秒数。 */
export const BASE = Date.UTC(2026, 10, 13, 7, 0, 0);

let counter = 0;

export function iso(seconds: number): string {
  return new Date(BASE + seconds * 1000).toISOString();
}

export function ev(type: string, data: Record<string, unknown> = {}, agent: string | null = null, at = 0): string {
  const event: Record<string, unknown> = { type, data, id: `ev-${++counter}`, timestamp: iso(at), parentId: null };
  if (agent) event.agentId = agent;
  return JSON.stringify(event);
}

export function started(agent: string, name: string, opts: { model?: string; task?: string; mode?: string; at?: number; desc?: string } = {}): string {
  return ev(
    "subagent.started",
    {
      toolCallId: opts.task ?? `t-${agent}`,
      agentName: "explore",
      agentDisplayName: name,
      agentDescription: opts.desc ?? "",
      model: opts.model ?? "provider/small-1.0",
      agentType: "explore",
      executionMode: opts.mode ?? "sync",
    },
    agent,
    opts.at ?? 0,
  );
}

export function taskCall(callId: string, owner: string | null = null, at = 0, args: Record<string, unknown> = {}): string {
  return ev("tool.execution_start", { toolCallId: callId, toolName: "task", arguments: { name: "x", ...args } }, owner, at);
}

export function bashStart(callId: string, command: string, agent: string | null = null, at = 0, args: Record<string, unknown> = {}): string {
  return ev("tool.execution_start", { toolCallId: callId, toolName: "bash", arguments: { command, description: "d", ...args }, shellToolInfo: {} }, agent, at);
}

/** 同步命令正常结束：带 shellExecution.exitCode 和 content 末尾的退出标记。 */
export function bashEnd(callId: string, output: string, code = 0, agent: string | null = null, at = 0, marker = true): string {
  const content = output + (marker ? `<shellId: 0 completed with exit code ${code}>` : "");
  return ev("tool.execution_complete", { toolCallId: callId, success: true, shellExecution: { exitCode: code }, result: { content } }, agent, at);
}

/** 后台命令（或前台转后台）的调用结果：没有 shellExecution，structuredContent.shellId 有值。 */
export function bashBackground(callId: string, shellId: string, agent: string | null = null, at = 0, content = "<command started in background>"): string {
  return ev("tool.execution_complete", { toolCallId: callId, success: true, result: { content, structuredContent: { shellId } } }, agent, at);
}

export function shellNotice(shellId: string, exitCode: number | null, at = 0, type = "shell_completed"): string {
  const kind: Record<string, unknown> = { type, shellId };
  if (exitCode !== null) kind.exitCode = exitCode;
  return ev("system.notification", { content: "x", kind }, null, at);
}

export function shellCall(callId: string, tool: string, shellId: string, content: string, at: number, agent: string | null = null, success = true): string[] {
  return [
    ev("tool.execution_start", { toolCallId: callId, toolName: tool, arguments: { shellId, delay: 0 } }, agent, at),
    ev("tool.execution_complete", { toolCallId: callId, success, result: { content } }, agent, at + 0.1),
  ];
}

export function completed(agent: string, task: string, opts: { calls?: number; tokens?: number; ms?: number; at?: number } = {}): string {
  return ev("subagent.completed", { toolCallId: task, totalToolCalls: opts.calls ?? 3, totalTokens: opts.tokens ?? 38000, durationMs: opts.ms ?? 12000 }, agent, opts.at ?? 0);
}

export function failedEvent(agent: string, task: string, error: unknown, at = 0): string {
  const data: Record<string, unknown> = { toolCallId: task };
  if (error !== undefined) data.error = error;
  return ev("subagent.failed", data, agent, at);
}

export function say(agent: string | null, content: string, at = 0, reasoning?: string): string {
  const data: Record<string, unknown> = { content };
  if (reasoning !== undefined) data.reasoningText = reasoning;
  return ev("assistant.message", data, agent, at);
}

export function toolStart(callId: string, name: string, args: unknown, agent: string | null = null, at = 0): string {
  return ev("tool.execution_start", { toolCallId: callId, toolName: name, arguments: args }, agent, at);
}

export function toolEnd(callId: string, content: string, agent: string | null = null, at = 0, extra: Record<string, unknown> = {}): string {
  return ev("tool.execution_complete", { toolCallId: callId, success: true, result: { content }, ...extra }, agent, at);
}

export function storeOf(...lines: (string | string[])[]): SessionStore {
  const store = new SessionStore("s1");
  feed(store, ...lines);
  return store;
}

export function feed(store: SessionStore, ...lines: (string | string[])[]): void {
  for (const line of lines.flat()) store.feedLine(line);
}

// ───── 任务列表和名单 ─────

export function agentTask(id: string, status: TaskAgentInfo["status"], extra: Partial<TaskAgentInfo> = {}): TaskAgentInfo {
  return { type: "agent", id, toolCallId: `t-${id}`, description: "", status, startedAt: iso(0), agentType: "explore", prompt: "", executionMode: "background", ...extra };
}

export function shellTask(id: string, status: TaskShellInfo["status"], extra: Partial<TaskShellInfo> = {}): TaskShellInfo {
  return { type: "shell", id, description: "", status, startedAt: iso(0), command: "x", attachmentMode: "attached", ...extra };
}

export function snapshot(tasks: TasksSnapshot["tasks"], receivedAt: number, extra: Partial<TasksSnapshot> = {}): TasksSnapshot {
  return { tasks, shellCalls: {}, receivedAt, connected: true, ...extra };
}

/** 事件之后 100 秒的时刻，测试里统一的“现在”。 */
export const NOW = BASE + 100_000;

export function listOf(store: SessionStore, extra: Partial<BuildListInput> = {}): ListEntry[] {
  return buildList({ store, tasks: null, usage: null, now: NOW, collapseEnded: false, keep: new Set<EntryKey>(), lastOutputLine: () => "", ...extra });
}

export function shape(list: ListEntry[]): [string, string, number][] {
  return list.map((entry) => [entry.kind, entry.name, entry.depth]);
}

export function usageOf(inputTokens: number, outputTokens: number, extra: Partial<AgentUsage> = {}): AgentUsage {
  return { inputTokens, outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0, calls: 1, ...extra };
}
