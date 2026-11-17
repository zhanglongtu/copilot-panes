// 数据变化时的处理：换 session 清状态、跟随最新、选中的条目消失、未读和响铃。

import type { AppContext, AppEffect, AppState, AppUpdate } from "../types/app.ts";
import type { EntryKey, EntryStatus } from "../types/model.ts";
import { isEnded } from "../types/model.ts";
import { findEntry, initialState, label, newestKey, selectEntry, withNotice } from "./app-core.ts";

/** 条目变成这几种状态时用户该去看一眼：已结束，或做完一轮在等你发话。 */
const needsAttention = (status: EntryStatus): boolean => isEnded(status) || status === "idle";

/**
 * 换 session（包括第一次认到 session）时，丢掉和旧 session 有关的状态：选中、未读、草稿、翻看位置、搜索、等待中的请求。
 * 用户的偏好（跟随、收起已结束的、放大）和打开着的覆盖层不动。adopted 为 true 时调用方要用 baseline 方式处理一次数据。
 */
export function syncSession(state: AppState, ctx: AppContext): { state: AppState; adopted: boolean } {
  const id = ctx.data.session?.sessionId ?? null;
  if (state.sessionId !== undefined && state.sessionId === id) return { state, adopted: false };
  const fresh = initialState();
  return {
    state: {
      ...fresh,
      followLatest: state.followLatest,
      collapseEnded: state.collapseEnded,
      zoom: state.zoom,
      overlay: state.overlay,
      pickerIndex: state.pickerIndex,
      nextRequestId: state.nextRequestId,
      // 自动换 session 时的提示（“已切到「…」”）是在换之前发出的，要带到新 session 上
      notice: state.notice,
      sessionId: id,
    },
    adopted: true,
  };
}

/** 选中的条目 gone 之后选哪个：按上一次的名单顺序，取它后面最近还在的，没有再取它前面最近还在的。 */
function neighbour(gone: EntryKey, order: readonly EntryKey[], present: ReadonlySet<EntryKey>): EntryKey | null {
  const at = order.indexOf(gone);
  if (at < 0) return null;
  for (let i = at + 1; i < order.length; i++) if (present.has(order[i]!)) return order[i]!;
  for (let i = at - 1; i >= 0; i--) if (present.has(order[i]!)) return order[i]!;
  return null;
}

/**
 * 处理 ViewData 的变化。baseline 为 true 时只记下现状：刚认到 session 时已经在名单上的条目不算“新出现”，不标未读、不响铃。
 * session 的进程没了（sessionEnded）时也只记下现状：条目被统一改成“已停”不是它们各自出了事，不该满屏标未读。
 * 跟随最新只在焦点在名单、没有搜索时才改选中，免得用户正在输入时焦点下的条目被换掉。
 */
export function applyData(state: AppState, ctx: AppContext, baseline: boolean): AppUpdate {
  const entries = ctx.data.entries;
  const quiet = baseline || ctx.data.sessionEnded === true;
  const present = new Set(entries.map((e) => e.key));
  const lastStatus = new Map(state.lastStatus);
  const newKeys: EntryKey[] = [];
  const attention: EntryKey[] = [];
  let failed = false;

  for (const e of entries) {
    const before = state.lastStatus.get(e.key);
    lastStatus.set(e.key, e.status);
    if (quiet) continue;
    if (before === undefined) newKeys.push(e.key);
    if (needsAttention(e.status) && !(before !== undefined && needsAttention(before))) attention.push(e.key);
    if (e.status === "failed" && before !== "failed") failed = true;
  }

  let next: AppState = state;
  const selected = state.selected;
  if (entries.length === 0) {
    if (selected !== null) next = { ...selectEntry(next, null, { oldGone: true }), focus: "list" };
  } else if (selected === null || !present.has(selected)) {
    const target = (selected === null ? null : neighbour(selected, state.order ?? [], present)) ?? newestKey(entries);
    next = selectEntry(next, target, { oldGone: selected !== null });
    if (next.focus === "content") next = { ...next, focus: "list" };
  } else if (state.followLatest && state.focus === "list" && state.search === null && newKeys.length > 0) {
    const fresh = entries.filter((e) => newKeys.includes(e.key));
    const target = newestKey(fresh);
    if (target !== null && target !== selected) next = selectEntry(next, target);
  }

  const unread = new Set(next.unread);
  for (const key of attention) if (key !== next.selected) unread.add(key);
  if (next.selected !== null) unread.delete(next.selected);

  const stop = next.confirmStop;
  const stopStillValid = stop !== null && findEntry(ctx, stop.key)?.status === "running";
  const sessionCount = ctx.data.sessions.length;

  next = {
    ...next,
    unread,
    lastStatus,
    order: entries.map((e) => e.key),
    confirmStop: stopStillValid ? stop : null,
    pickerIndex: Math.min(next.pickerIndex, sessionCount),
  };

  // 跟随关着时新任务不会自动选中：提示一句，免得用户不知道有新东西
  if (!state.followLatest && newKeys.length > 0 && !(state.notice !== null && state.notice.tone === "error" && state.notice.until > ctx.now)) {
    const fresh = entries.filter((e) => newKeys.includes(e.key));
    const newest = fresh.find((e) => e.key === newestKey(fresh));
    if (newest) next = withNotice(next, ctx, fresh.length > 1 ? `新任务 ${label(newest)} 等 ${fresh.length} 个开始了，按 f 跳过去` : `新任务 ${label(newest)} 开始了，按 f 跳过去`);
  }

  const effects: AppEffect[] = failed && ctx.data.bellEnabled ? [{ type: "bell" }] : [];
  return { state: next, effects };
}
