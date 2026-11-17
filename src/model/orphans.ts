// session 的 Copilot CLI 进程没了（被强行结束，来不及写 session.shutdown）之后，名单里原本“在跑”的条目不能一直转圈。
// 纯函数：把还在跑的条目改成“已停”，其余原样。

import type { ListEntry, StoreView } from "../types/model.ts";
import { agentElapsedMs } from "./merge.ts";

export const ORPHANED_STEP = "已停";

/**
 * running 和 idle 的条目改成 status stopped、orphaned true、step “已停”、不对应任务（不能再发消息、停止）；
 * 在跑的条目用时停在 session 最后一个事件的时间（store.lastEventAt），idle 的用时本来就停着，不动。其余条目原样返回。
 */
export function markOrphaned(entries: readonly ListEntry[], store: StoreView): ListEntry[] {
  const stoppedAt = store.lastEventAt;
  return entries.map((entry) => {
    if (entry.status !== "running" && entry.status !== "idle") return entry;
    return { ...entry, status: "stopped", orphaned: true, step: ORPHANED_STEP, task: null, elapsedMs: frozenElapsed(entry, store, stoppedAt) };
  });
}

function frozenElapsed(entry: ListEntry, store: StoreView, stoppedAt: number): number {
  if (entry.status === "idle" || stoppedAt <= 0) return entry.elapsedMs;
  if (entry.kind === "agent") {
    const agent = store.agent(entry.id);
    return agent ? agentElapsedMs(agent, Math.max(stoppedAt, agent.busySince ?? 0)) : entry.elapsedMs;
  }
  return Math.max(0, stoppedAt - entry.startedAt);
}
