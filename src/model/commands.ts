// 状态库里 shell 命令的部分：哪些在跑、后台命令的 shellId、三个结束来源、留下的失败命令、read_bash 读到的输出。
// 子 agent 的状态不在这里（见 store.ts）。

import { FAILED_COMMANDS_KEPT, FOREGROUND_LIST_AFTER_MS } from "../constants.ts";
import type { CommandEndReason, CommandRecord, EventStatus } from "../types/model.ts";
import { EVENT_OUTPUT_KEEP_CHARS, SHRUNK_KEEP_CHARS, TOOL_TEXT_KEEP_CHARS, type TextBudget, clipHead, clipTail, noteCut } from "./limits.ts";
import { stripExitMarker, stripTrailingNotice } from "./output.ts";

const BG_MARKER = /shellId: (\S+?)>/;

type ShellCall = { tool: string; shellId: string };

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function textOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function isInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

/** 一个 session 的全部命令。 */
export class CommandBook {
  private readonly byId = new Map<string, CommandRecord>();
  private readonly all: CommandRecord[] = [];
  private readonly running = new Set<CommandRecord>();
  /** shellId → 命令；同一个 shellId 后登记的覆盖先登记的。命令结束后仍留着，供 read_bash 的那一行查。 */
  private readonly byShell = new Map<string, CommandRecord>();
  /** read_bash、write_bash、stop_bash 调用的 toolCallId → 它们动的是哪个 shell；完成时取出。 */
  private readonly calls = new Map<string, ShellCall>();
  private readonly failedKept: CommandRecord[] = [];
  private readonly budget: TextBudget | null;

  constructor(budget?: TextBudget) {
    this.budget = budget ?? null;
  }

  list(): readonly CommandRecord[] {
    return this.all;
  }

  get(toolCallId: string): CommandRecord | undefined {
    return this.byId.get(toolCallId);
  }

  byShellId(shellId: string): CommandRecord | undefined {
    return this.byShell.get(shellId);
  }

  /** read_bash、write_bash、stop_bash 的调用：结束时要知道它们动的是哪个 shell。 */
  noteCall(toolCallId: string, toolName: string, args: Record<string, unknown>): void {
    if ((toolName === "stop_bash" || toolName === "read_bash" || toolName === "write_bash") && args.shellId != null) {
      this.calls.set(toolCallId, { tool: toolName, shellId: String(args.shellId) });
    }
  }

  start(toolCallId: string, toolName: string, args: Record<string, unknown>, agentId: string | null, at: number): void {
    const command = clipHead(textOf(args.command), TOOL_TEXT_KEEP_CHARS);
    const description = clipHead(textOf(args.description), TOOL_TEXT_KEEP_CHARS);
    const record: CommandRecord = {
      toolCallId,
      toolName,
      command: command.text,
      description: description.text,
      agentId,
      background: args.mode === "async",
      promoted: false,
      detach: args.detach === true,
      shellId: args.shellId != null ? String(args.shellId) : null,
      status: "running",
      endReason: null,
      startedAt: at,
      endedAt: null,
      exitCode: null,
      error: null,
      eventOutput: "",
      keptAsFailed: false,
    };
    noteCut(record, "command", command.cut);
    this.budget?.add(command.text.length, () => {
      const shrunk = clipHead(record.command, SHRUNK_KEEP_CHARS);
      record.command = shrunk.text;
      noteCut(record, "command", shrunk.cut);
    });
    noteCut(record, "description", description.cut);
    const previous = this.byId.get(toolCallId);
    if (previous) {
      this.all.splice(this.all.indexOf(previous), 1);
      this.running.delete(previous);
    }
    this.byId.set(toolCallId, record);
    this.all.push(record);
    this.running.add(record);
    if (record.shellId) this.byShell.set(record.shellId, record);
  }

  /** tool.execution_complete。返回状态有没有变。 */
  complete(toolCallId: string, data: Record<string, unknown>, at: number): boolean {
    const call = this.calls.get(toolCallId);
    if (call) {
      this.calls.delete(toolCallId);
      return this.completeShellCall(call, data, at);
    }
    const command = this.byId.get(toolCallId);
    if (!command || command.status !== "running") return false;
    const result = isRecord(data.result) ? data.result : {};
    const content = textOf(result.content);
    const shellId = shellIdOf(result, data, content);
    const execution = data.shellExecution;
    const hasExit = isRecord(execution) && isInt(execution.exitCode);
    if (shellId !== null && !hasExit && data.success) {
      // 后台命令，或前台命令等不到结果被转入后台：调用返回了，命令还在跑，结束要等通知
      if (!command.background) {
        command.promoted = true;
        this.keepOutput(command, stripTrailingNotice(content));
      }
      command.background = true;
      command.shellId = shellId;
      this.byShell.set(shellId, command);
      return true;
    }
    const marker = stripExitMarker(content);
    this.setOutput(command, marker.text);
    if (hasExit) command.exitCode = execution.exitCode as number;
    else if (marker.exitCode !== null) command.exitCode = marker.exitCode;
    const error = data.error;
    const errorText = isRecord(error) ? textOf(error.message) : textOf(error);
    command.error = command.exitCode === null && errorText ? errorText : null;
    this.finish(command, "done", "exit", at);
    return true;
  }

  /** 后台命令的结束通知（system.notification 的 shell_completed 和 shell_detached_completed）。 */
  endByNotification(shellId: string, exitCode: unknown, at: number): boolean {
    return this.endBackground(shellId, exitCode, at, false);
  }

  /** 子 agent 做完时，丢掉它名下还在跑的后台命令：日志里没有它们自己的结束通知。 */
  dropBackground(agentId: string, at: number): boolean {
    let changed = false;
    for (const command of [...this.running]) {
      if (command.agentId === agentId && command.background) {
        this.finish(command, "stopped", "agent-ended", at);
        changed = true;
      }
    }
    return changed;
  }

  /** 进程退出或会话续接：之前没结束的命令都不会再有下文。 */
  stopAll(at: number): boolean {
    const changed = this.running.size > 0;
    for (const command of [...this.running]) this.finish(command, "stopped", "session-ended", at);
    return changed;
  }

  /** 用户中断了主会话的这一轮：它等着的前台命令都被取消。 */
  stopMainForeground(at: number): boolean {
    let changed = false;
    for (const command of [...this.running]) {
      if (command.agentId === null && !command.background) {
        this.finish(command, "stopped", "aborted", at);
        changed = true;
      }
    }
    return changed;
  }

  private completeShellCall(call: ShellCall, data: Record<string, unknown>, at: number): boolean {
    if (call.tool === "stop_bash") return this.endBackground(call.shellId, null, at, true);
    const result = data.result;
    const content = isRecord(result) ? textOf(result.content) : "";
    let changed = false;
    if (data.success) {
      const command = this.byShell.get(call.shellId);
      if (command && command.status === "running") changed = this.keepOutput(command, stripTrailingNotice(content));
    }
    const marker = stripExitMarker(content);
    if (marker.exitCode !== null) changed = this.endBackground(call.shellId, marker.exitCode, at, false) || changed;
    return changed;
  }

  private endBackground(shellId: string, exitCode: unknown, at: number, stopped: boolean): boolean {
    const command = this.byShell.get(shellId);
    if (!command || command.status !== "running") return false;
    command.exitCode = isInt(exitCode) ? exitCode : null;
    this.finish(command, stopped ? "stopped" : "done", stopped ? "stopped" : "exit", at);
    return true;
  }

  /** read_bash、write_bash 读到的一段输出记在后台命令上：没有 .out 文件时界面只能用它。只留末尾 EVENT_OUTPUT_KEEP_CHARS 个字符。 */
  private keepOutput(command: CommandRecord, text: string): boolean {
    if (text.trim() === "") return false;
    // 末尾的换行常被结束说明连带去掉；每次读到的都从新的一行开始
    this.setOutput(command, command.eventOutput + (text.endsWith("\n") ? text : `${text}\n`));
    return true;
  }

  /** 事件输出只留末尾；累计被截掉的字符数记在命令上。 */
  private setOutput(command: CommandRecord, text: string): void {
    const clipped = clipTail(text, EVENT_OUTPUT_KEEP_CHARS);
    const before = command.eventOutput.length;
    command.eventOutput = clipped.text;
    noteCut(command, "eventOutput", clipped.cut);
    this.budget?.add(Math.max(0, clipped.text.length - before), () => {
      const shrunk = clipTail(command.eventOutput, SHRUNK_KEEP_CHARS);
      command.eventOutput = shrunk.text;
      noteCut(command, "eventOutput", shrunk.cut);
    });
  }

  private finish(command: CommandRecord, status: EventStatus, reason: CommandEndReason, at: number): void {
    command.status = status;
    command.endReason = reason;
    command.endedAt = at;
    this.running.delete(command);
    this.noteExit(command);
  }

  /**
   * 命令正常结束了：退出码不是 0 就算失败；结束前名单里显示过它的（后台命令，或前台命令跑满 FOREGROUND_LIST_AFTER_MS），
   * 记下来，名单结束后继续列它，最多 FAILED_COMMANDS_KEPT 条。
   */
  private noteExit(command: CommandRecord): void {
    if (command.status !== "done" || !command.exitCode) return;
    command.status = "failed";
    if (command.background || (command.endedAt ?? 0) - command.startedAt >= FOREGROUND_LIST_AFTER_MS) {
      command.keptAsFailed = true;
      this.failedKept.push(command);
      while (this.failedKept.length > FAILED_COMMANDS_KEPT) {
        const dropped = this.failedKept.shift();
        if (dropped) dropped.keptAsFailed = false;
      }
    }
  }
}

/** 调用返回的结果里有没有 shellId（后台命令，或转入后台的命令）；没有是 null。 */
function shellIdOf(result: Record<string, unknown>, data: Record<string, unknown>, content: string): string | null {
  const structured = result.structuredContent;
  if (isRecord(structured) && structured.shellId != null) return String(structured.shellId);
  if (data.success && !isRecord(data.shellExecution)) {
    const match = BG_MARKER.exec(content);
    return match ? (match[1] as string) : null;
  }
  return null;
}
