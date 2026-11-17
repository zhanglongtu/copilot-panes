// 执行界面发来的请求：调用对应的 session.rpc.tasks.*，把结果写成给人看的一句话。

import { PROTOCOL_VERSION } from "../../src/protocol.ts";
import type { RequestMessage, ResultMessage } from "../../src/protocol.ts";
import { describeError } from "./errors.ts";
import type { TasksRpc } from "./sdk.ts";

/** 界面等 10 秒没有结果就放弃，所以扩展自己的超时要更短，好让界面看到具体原因。 */
const DEFAULT_TIMEOUT_MS = 8000;
const REASON_MAX_CHARS = 300;

function ok(requestId: string): ResultMessage {
  return { type: "result", v: PROTOCOL_VERSION, requestId, ok: true };
}

function failed(requestId: string, reason: string, uncertain = false): ResultMessage {
  return { type: "result", v: PROTOCOL_VERSION, requestId, ok: false, reason, ...(uncertain ? { uncertain: true as const } : {}) };
}

/** SDK 调用等超时了：调用本身还在进行，操作可能已经生效，所以结果要标 uncertain。 */
class CallTimeout extends Error {}

function callWithTimeout<T>(call: () => Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new CallTimeout(`${Math.round(ms / 1000)} 秒没有回应`)), ms);
  });
  return Promise.race([Promise.resolve().then(call), timeout]).finally(() => clearTimeout(timer));
}

/**
 * 执行一条请求，返回带同一个 requestId 的 result。从不抛异常。
 * - sendMessage → tasks.sendMessage({ id: taskId, message, fromAgentId: "" })。sent 为 false 时：
 *   error 含 "not found" 或 "not accepting"（不分大小写）写“它已经不在 Copilot CLI 的任务列表里，收不到消息”，
 *   其他写“没送到：<error，没有就写 Copilot CLI 没有说明原因>”。
 * - cancel → tasks.cancel；cancelled 为 false 写“没停掉：Copilot CLI 说它已经不在跑了”。
 * - promoteToBackground → tasks.promoteToBackground；promoted 为 false 写“没转后台：它已经在后台，或者已经结束”。
 * - remove → tasks.remove；removed 为 false 写“没移除：它还在跑，或者已经被移除了”。
 * - refreshTasks → 调用 refresh()（立刻查一次任务列表并推送），成功即 ok。
 * 调用抛异常时写“扩展调用 tasks.<方法名> 出错：<异常的 message，折成一行>”。
 * cancel、promoteToBackground、remove、sendMessage 成功后也调用一次 refresh()，让界面尽快看到新状态。
 * timeoutMs 是每次 SDK 调用的最长等待，省略时 8 秒。
 */
export async function runRequest(
  rpc: TasksRpc,
  request: RequestMessage,
  refresh: () => Promise<void>,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<ResultMessage> {
  const id = request.requestId;
  const refreshQuietly = async () => {
    try {
      await refresh();
    } catch {
      // 动作已经做完，刷新失败只会让界面晚一点看到新状态，下一轮定时查询会补上
    }
  };
  if (request.op === "refreshTasks") {
    try {
      await refresh();
      return ok(id);
    } catch (e) {
      return failed(id, `扩展刷新任务列表出错：${describeError(e, REASON_MAX_CHARS)}`);
    }
  }

  const method = request.op;
  try {
    let refusal: string | null = null;
    switch (request.op) {
      case "sendMessage": {
        const r = await callWithTimeout(() => rpc.sendMessage({ id: request.taskId, message: request.message, fromAgentId: "" }), timeoutMs);
        if (r?.sent !== true) {
          const error = typeof r?.error === "string" ? describeError(r.error, REASON_MAX_CHARS) : "";
          refusal = /not found|not accepting/i.test(error) ? "它已经不在 Copilot CLI 的任务列表里，收不到消息" : `没送到：${error || "Copilot CLI 没有说明原因"}`;
        }
        break;
      }
      case "cancel": {
        const r = await callWithTimeout(() => rpc.cancel({ id: request.taskId }), timeoutMs);
        if (r?.cancelled !== true) refusal = "没停掉：Copilot CLI 说它已经不在跑了";
        break;
      }
      case "promoteToBackground": {
        const r = await callWithTimeout(() => rpc.promoteToBackground({ id: request.taskId }), timeoutMs);
        if (r?.promoted !== true) refusal = "没转后台：它已经在后台，或者已经结束";
        break;
      }
      case "remove": {
        const r = await callWithTimeout(() => rpc.remove({ id: request.taskId }), timeoutMs);
        if (r?.removed !== true) refusal = "没移除：它还在跑，或者已经被移除了";
        break;
      }
    }
    if (refusal !== null) return failed(id, refusal);
  } catch (e) {
    return failed(id, `扩展调用 tasks.${method} 出错：${describeError(e, REASON_MAX_CHARS)}`, e instanceof CallTimeout);
  }
  // 刷新不等它做完再回结果：刷新卡住不该拖慢结果
  void refreshQuietly();
  return ok(id);
}
