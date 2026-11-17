// 状态机的公用小函数：初始状态、提示、选中条目、请求、按键判断。app.ts 和 app-*.ts 共用。

import { NOTICE_MS } from "../constants.ts";
import type { RequestOp } from "../protocol.ts";
import type { AppContext, AppState, AppUpdate, Notice } from "../types/app.ts";
import type { EntryKey, ListEntry } from "../types/model.ts";
import type { KeyEvent } from "../types/ui.ts";
import { clipText } from "./width.ts";

export function initialState(): AppState {
  return {
    focus: "list",
    selected: null,
    followLatest: true,
    collapseEnded: false,
    zoom: false,
    expanded: new Set(),
    unread: new Set(),
    lastStatus: new Map(),
    drafts: new Map(),
    scroll: 0,
    notice: null,
    confirmStop: null,
    quitArmedUntil: null,
    search: null,
    overlay: "none",
    pickerIndex: 0,
    nextRequestId: 1,
    pending: new Map(),
  };
}

export const noop = (state: AppState): AppUpdate => ({ state, effects: [] });

export function withNotice(state: AppState, ctx: AppContext, text: string, tone: Notice["tone"] = "info", durationMs: number = NOTICE_MS): AppState {
  return { ...state, notice: { text, tone, until: ctx.now + durationMs } };
}

/** 提示一句话，不产生动作。 */
export function say(state: AppState, ctx: AppContext, text: string, tone: Notice["tone"] = "info"): AppUpdate {
  return noop(withNotice(state, ctx, text, tone));
}

export function findEntry(ctx: AppContext, key: EntryKey | null): ListEntry | null {
  if (key === null) return null;
  return ctx.data.entries.find((e) => e.key === key) ?? null;
}

export function selectedEntry(state: AppState, ctx: AppContext): ListEntry | null {
  return findEntry(ctx, state.selected);
}

export const isReadOnly = (ctx: AppContext): boolean => ctx.data.extension.kind === "readonly";

/** 只读的原因，接在“只读，不能发消息：”后面；ViewData.extension.cause，没有时是“扩展没有加载”。 */
export function readOnlyCause(ctx: AppContext): string {
  const extension = ctx.data.extension;
  return extension.kind === "readonly" && extension.cause !== undefined && extension.cause !== "" ? extension.cause : "扩展没有加载";
}

/** 只读时按键被拒绝的提示：“只读，不能停止：这个 session 启动时还没装扩展”。 */
export const readOnlyRefusal = (ctx: AppContext, what: string): string => `只读，不能${what}：${readOnlyCause(ctx)}`;

/** 写进提示里的名字：子 agent 用名字，命令写 "$ " 加命令，太长截断。 */
export function label(entry: ListEntry): string {
  return entry.kind === "command" ? `$ ${clipText(entry.name, 30)}` : clipText(entry.name, 30);
}

/** 最近开始的条目；开始时间相同取名单里靠后的。 */
export function newestKey(entries: readonly ListEntry[]): EntryKey | null {
  let best: ListEntry | null = null;
  for (const e of entries) if (best === null || e.startedAt >= best.startedAt) best = e;
  return best?.key ?? null;
}

/** 产生一个发给扩展的请求，并把它记成“已发出、等结果”。 */
export function makeRequest(state: AppState, op: RequestOp, entry: ListEntry | null, text?: string): AppUpdate {
  const requestId = `r${state.nextRequestId}`;
  const pending = new Map(state.pending);
  pending.set(requestId, { op: op.op, entryKey: entry?.key ?? null, label: entry ? label(entry) : "", ...(text === undefined ? {} : { text }) });
  return { state: { ...state, nextRequestId: state.nextRequestId + 1, pending }, effects: [{ type: "request", requestId, op }] };
}

/** 选中另一个条目：存下旧条目的翻看位置，取出新条目的；清掉新条目的未读、搜索和等待确认的 x。焦点和跟随不动。 */
export function selectEntry(state: AppState, key: EntryKey | null, options: { oldGone?: boolean } = {}): AppState {
  if (state.selected === key) return state;
  const scrolls = new Map(state.scrolls ?? []);
  if (state.selected !== null) {
    if (!options.oldGone && state.scroll > 0) scrolls.set(state.selected, { scroll: state.scroll, total: state.scrollTotal ?? null });
    else scrolls.delete(state.selected);
  }
  const saved = key === null ? undefined : scrolls.get(key);
  if (key !== null) scrolls.delete(key);
  const unread = new Set(state.unread);
  if (key !== null) unread.delete(key);
  return {
    ...state,
    selected: key,
    unread,
    scrolls,
    scroll: saved?.scroll ?? 0,
    scrollTotal: saved?.total ?? null,
    search: null,
    confirmStop: null,
  };
}

/** 用户移动选择：by 是相对现在的位置，index 是名单里的绝对位置，都夹在名单范围内。选中的真的变了才关掉跟随最新。 */
export function moveSelection(state: AppState, ctx: AppContext, to: { by: number } | { index: number }): AppState {
  const entries = ctx.data.entries;
  if (entries.length === 0) return state;
  const at = entries.findIndex((e) => e.key === state.selected);
  const wanted = "by" in to ? at + to.by : to.index;
  const key = entries[Math.max(0, Math.min(entries.length - 1, wanted))]!.key;
  if (key === state.selected) return state;
  return { ...selectEntry(state, key), followLatest: false };
}

// ───── 按键判断 ─────

export const isKey = (e: KeyEvent, key: KeyEvent["key"]): boolean => e.key === key && !e.ctrl && !e.alt;

/** 没有 Ctrl、Alt 的可打印字符 text（区分大小写）。 */
export const isChar = (e: KeyEvent, text: string): boolean => e.key === "char" && !e.ctrl && !e.alt && e.text === text;

export const isCtrl = (e: KeyEvent, letter: string): boolean => e.key === "char" && e.ctrl && !e.alt && e.text.toLowerCase() === letter;

/** 会往输入框里写字的按键：可打印字符。 */
export const isPrintable = (e: KeyEvent): boolean => e.key === "char" && !e.ctrl && !e.alt && e.text !== "";
