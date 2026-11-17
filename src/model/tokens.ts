// 子 agent 的 token 数（含下级）：取 events.jsonl 的用量记录加下级、完成事件的 totalTokens、扩展累加的用量里最大的一个。

import type { AgentUsage } from "../protocol.ts";
import type { AgentRecord, EntryStatus, StoreView } from "../types/model.ts";

/**
 * 由扩展累加的用量算出和 totalTokens 同一口径的数：inputTokens 加 outputTokens。缓存读写已经算在 inputTokens 里，不再加。
 * 联调时核对过：totalTokens 等于各次调用的 inputTokens 加 outputTokens 之和。
 * 改口径只改这一个函数。
 */
export function liveTokens(usage: AgentUsage): number {
  return usage.inputTokens + usage.outputTokens;
}

/**
 * 每个子 agent 显示的 token 数（含它下面各级子 agent 用的），键是 agentId；一个数都不知道的是 null。取已知的几个数里最大的，
 * 所以不会比真实用量小，每个数都是真实用量的下限或恰好相等：
 * - 自己加下级：自己的用量（events.jsonl 里各条用量记录累加的 eventTokens，和扩展累加的 liveTokens 里大的那个）加上每个下级显示的数。
 * - totalTokens：最近一条完成事件那一刻的累计用量，**已经含下级各级**（实测：它等于自己的用量记录加各下级的），也是全程各轮、
 *   不是只算一轮，所以几条完成事件的数不能加起来；但追加消息后又跑的几轮没有新的完成事件，它可能偏小。
 * 扩展累加的用量只含它在场期间的调用：扩展加载之后才开始的子 agent 它是全程的数，更早的只含加载之后的。
 */
export function tokensByAgent(store: StoreView, usage: Readonly<Record<string, AgentUsage>> | null): Map<string, number | null> {
  const agents = store.agents();
  const children = new Map<string, AgentRecord[]>();
  for (const agent of agents) {
    if (agent.parentId === null || !store.agent(agent.parentId)) continue;
    const siblings = children.get(agent.parentId);
    if (siblings) siblings.push(agent);
    else children.set(agent.parentId, [agent]);
  }
  const result = new Map<string, number | null>();
  const visiting = new Set<string>();
  const rolled = (agent: AgentRecord): number | null => {
    if (result.has(agent.id)) return result.get(agent.id)!;
    if (visiting.has(agent.id)) return null; // 上一级互相指着对方的怪事件
    visiting.add(agent.id);
    const live = usage?.[agent.id];
    const own = [agent.eventTokens ?? null, live ? liveTokens(live) : null].filter((n): n is number => n !== null);
    let below = 0;
    let belowKnown = false;
    for (const child of children.get(agent.id) ?? []) {
      const tokens = rolled(child);
      if (tokens === null) continue;
      below += tokens;
      belowKnown = true;
    }
    const sum = own.length > 0 || belowKnown ? Math.max(0, ...own) + below : null;
    const known = [agent.totalTokens, sum].filter((n): n is number => n !== null);
    visiting.delete(agent.id);
    const tokens = known.length === 0 ? null : Math.max(...known);
    result.set(agent.id, tokens);
    return tokens;
  };
  for (const agent of agents) rolled(agent);
  return result;
}

/**
 * 在跑或 idle 的子 agent 开始得比扩展加载早，而且没有 events.jsonl 里的用量记录可对：扩展手里的累加值只含加载之后的，
 * 显示的数只是下限。有 eventTokens 就是全程的数，不是下限。
 */
export function tokensPartial(agent: AgentRecord, status: EntryStatus, usage: AgentUsage | undefined, usageSince: number | undefined): boolean {
  return usageSince !== undefined && usage !== undefined && agent.eventTokens === undefined && (status === "running" || status === "idle") && agent.startedAt < usageSince;
}

/**
 * 顶行的合计：最外层子 agent（上一级不在状态库里的，包括被 c 收起、不在名单上的）显示的数之和。它们的数已经含下级，
 * 所以下级不再单独加，不然每个下级算两遍。一个数都不知道是 null。
 */
export function sessionTokens(store: StoreView, usage: Readonly<Record<string, AgentUsage>> | null): number | null {
  const tokens = tokensByAgent(store, usage);
  let total = 0;
  let known = false;
  for (const agent of store.agents()) {
    if (agent.parentId !== null && store.agent(agent.parentId)) continue;
    const own = tokens.get(agent.id) ?? null;
    if (own === null) continue;
    total += own;
    known = true;
  }
  return known ? total : null;
}
