// 累加每个子 agent 的模型用量。assistant.usage 不写进 events.jsonl，
// 界面要显示在跑的子 agent 用了多少 token，只能由扩展从启动起累加、经 socket 推过去。

import type { AgentUsage } from "../../src/protocol.ts";
import type { SdkEvent } from "./sdk.ts";

/** toolCallId → agentId 的对应表最多留这么多条，超出时丢最早的。 */
const MAX_TOOL_CALLS = 2000;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

export class UsageBook {
  readonly #agents = new Map<string, AgentUsage>();
  /** 子 agent 的 task 调用 toolCallId → agentId。 */
  readonly #agentByToolCall = new Map<string, string>();

  /**
   * 收到一个事件时调用：
   * - subagent.started：记下 data.toolCallId → 信封 agentId，用于下一条规则。
   * - assistant.usage：归属的子 agent 取信封的 agentId；没有时用 data.parentToolCallId 经上一条的对应表找；都没有是主会话，忽略。
   *   把 inputTokens、outputTokens、cacheReadTokens、cacheWriteTokens（缺的当 0）加到这个子 agent 上，calls 加 1。
   * - subagent.completed、subagent.failed：data.totalTokens 是数字时记成 reportedTotalTokens（用来核对累加口径）。
   * 返回这次有没有改动。
   */
  onEvent(event: SdkEvent): boolean {
    const data = record(event.data);
    if (!data) return false;
    switch (event.type) {
      case "subagent.started": {
        if (typeof event.agentId === "string" && typeof data.toolCallId === "string") {
          this.#agentByToolCall.delete(data.toolCallId);
          this.#agentByToolCall.set(data.toolCallId, event.agentId);
          if (this.#agentByToolCall.size > MAX_TOOL_CALLS) {
            const oldest = this.#agentByToolCall.keys().next().value;
            if (oldest !== undefined) this.#agentByToolCall.delete(oldest);
          }
        }
        return false;
      }
      case "assistant.usage": {
        const agentId = this.#owner(event, data.parentToolCallId);
        if (agentId === null) return false;
        const usage = this.#entry(agentId);
        usage.inputTokens += count(data.inputTokens);
        usage.outputTokens += count(data.outputTokens);
        usage.cacheReadTokens += count(data.cacheReadTokens);
        usage.cacheWriteTokens += count(data.cacheWriteTokens);
        usage.calls += 1;
        return true;
      }
      case "subagent.completed":
      case "subagent.failed": {
        const total = data.totalTokens;
        if (typeof total !== "number" || !Number.isFinite(total) || total < 0) return false;
        const agentId = this.#owner(event, data.toolCallId);
        if (agentId === null) return false;
        const usage = this.#entry(agentId);
        if (usage.reportedTotalTokens === total) return false;
        usage.reportedTotalTokens = total;
        return true;
      }
      default:
        return false;
    }
  }

  /** 所有子 agent 的累计用量，键是 agentId。返回拷贝。 */
  snapshot(): Record<string, AgentUsage> {
    const result: Record<string, AgentUsage> = {};
    for (const [agentId, usage] of this.#agents) result[agentId] = { ...usage };
    return result;
  }

  #owner(event: SdkEvent, toolCallId: unknown): string | null {
    if (typeof event.agentId === "string" && event.agentId !== "") return event.agentId;
    if (typeof toolCallId === "string") return this.#agentByToolCall.get(toolCallId) ?? null;
    return null;
  }

  #entry(agentId: string): AgentUsage {
    let usage = this.#agents.get(agentId);
    if (!usage) {
      usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, calls: 0 };
      this.#agents.set(agentId, usage);
    }
    return usage;
  }
}
