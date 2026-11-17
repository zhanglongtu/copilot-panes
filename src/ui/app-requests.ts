// 请求和中断的结果：写提示，发送失败时把文字放回输入框，拿不到进程号时改请扩展取消。

import { INTERRUPT_ESCALATE_MS } from "../constants.ts";
import type { AppContext, AppState, AppUpdate, InterruptOutcome, InterruptSignal, RequestOutcome } from "../types/app.ts";
import type { EntryKey } from "../types/model.ts";
import { findEntry, makeRequest, noop, say, withNotice } from "./app-core.ts";

const FAILURE_PREFIX: Record<string, string> = {
  sendMessage: "没发出去",
  cancel: "没停掉",
  promoteToBackground: "没转后台",
  remove: "没移除",
  refreshTasks: "没刷新",
};

/** 发送失败：把原文放回输入框。输入框里已经有新写的内容时，原文放在前面、换一行接上新内容，两边都不丢。 */
function restoreDraft(state: AppState, key: EntryKey, text: string): AppState {
  const current = state.drafts.get(key);
  const merged = current && current.text.trim() !== "" ? `${text}\n${current.text}` : text;
  const drafts = new Map(state.drafts);
  drafts.set(key, { text: merged, cursor: merged.length });
  return { ...state, drafts };
}

export function handleResult(state: AppState, requestId: string, outcome: RequestOutcome, ctx: AppContext): AppUpdate {
  const request = state.pending.get(requestId);
  if (request === undefined) return noop(state);
  const pending = new Map(state.pending);
  pending.delete(requestId);
  let next: AppState = { ...state, pending };

  if (outcome.ok) {
    const text =
      request.op === "sendMessage"
        ? `已发给 ${request.label}`
        : request.op === "cancel"
          ? `已请求停止 ${request.label}`
          : request.op === "promoteToBackground"
            ? `${request.label} 已转后台`
            : request.op === "remove"
              ? `已移除 ${request.label}`
              : null;
    return noop(text === null ? next : withNotice(next, ctx, text));
  }

  if (request.op === "sendMessage" && request.entryKey !== null && request.text !== undefined) {
    next = restoreDraft(next, request.entryKey, request.text);
  }
  // 超时没等到结果：操作可能已经生效。不能说“没发出去”，不然用户重发就重复了
  if (outcome.uncertain) {
    const hint = request.op === "sendMessage" ? "消息可能已经送到，先看过程记录再决定要不要重发" : "操作可能已经生效，等任务列表刷新再看";
    return say(next, ctx, `没收到结果：${outcome.reason}（${hint}）`, "error");
  }
  return say(next, ctx, `${FAILURE_PREFIX[request.op] ?? "没做成"}：${outcome.reason}`, "error");
}

const NEXT_SIGNAL: Record<InterruptSignal, InterruptSignal | null> = { SIGINT: "SIGTERM", SIGTERM: "SIGKILL", SIGKILL: null };

function escalateHint(signal: InterruptSignal, seconds: number): string {
  const next = NEXT_SIGNAL[signal];
  return next === null ? `已发送 ${signal}` : `已发送 ${signal}，${seconds} 秒后还没退出可以再按一次（升级为 ${next}）`;
}

export function handleInterrupted(state: AppState, entryKey: EntryKey, outcome: InterruptOutcome, ctx: AppContext): AppUpdate {
  switch (outcome.kind) {
    case "sent": {
      const interrupts = new Map(state.interrupts ?? []);
      interrupts.set(entryKey, { signal: outcome.signal, at: ctx.now });
      return say({ ...state, interrupts }, ctx, escalateHint(outcome.signal, Math.ceil(INTERRUPT_ESCALATE_MS / 1000)));
    }
    case "wait":
      return say(state, ctx, escalateHint(outcome.signal, Math.max(1, Math.ceil(outcome.remainingMs / 1000))));
    case "fallback": {
      const entry = findEntry(ctx, entryKey);
      if (entry?.task) {
        const requested = makeRequest(state, { op: "cancel", taskId: entry.task.id }, entry);
        return { state: withNotice(requested.state, ctx, `${outcome.reason}，改请扩展取消这条命令`), effects: requested.effects };
      }
      return say(state, ctx, `没法中断：${outcome.reason}，也没有对应的任务可以取消`, "error");
    }
    case "failed":
      return say(state, ctx, `没中断成功：${outcome.reason}`, "error");
  }
}
