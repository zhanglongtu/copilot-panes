// 内容区的翻看和搜索：总行数、翻到哪里、搜索匹配。行数和匹配行号用视图那边的函数得出，所以和画面上看到的一致。

import type { AppContext, AppState, SearchState } from "../types/app.ts";
import type { ListEntry } from "../types/model.ts";
import { agentContentLines, agentRowCount, agentRowCountExact, agentScrollPosition } from "./views/agent.ts";
import { commandEventRows, commandHeaderRows, commandRowCount } from "./views/command.ts";
import type { CommandSource } from "./views/command.ts";
import { matchRows, scrollForRow } from "./views/content.ts";
import { computeLayout } from "./views/layout.ts";
import type { AppUpdate } from "../types/app.ts";

const contentWidth = (ctx: AppContext) => Math.max(1, ctx.size.cols - 2);

/** 内容区能放几行。 */
export function viewportRows(state: AppState, ctx: AppContext): number {
  return Math.max(1, computeLayout(state, ctx.data, ctx.size).contentRows);
}

function eventOutputOf(entry: ListEntry, ctx: AppContext): string {
  return ctx.data.store?.command(entry.id)?.eventOutput ?? "";
}

/** 命令内容区的来源；展开细节（e）时带上命令原文，视图把它放在输出上面。 */
function commandSourceOf(entry: ListEntry, state: AppState, ctx: AppContext): CommandSource {
  const record = ctx.data.store?.command(entry.id);
  return {
    terminal: ctx.data.terminal,
    eventOutput: record?.eventOutput ?? "",
    command: state.expanded.has(entry.key) ? (record?.command ?? null) : null,
    orphaned: entry.orphaned === true,
  };
}

/**
 * 选中条目的内容区一共多少行；拿不到数据（没有状态库、没有终端）时是 null。
 * 很长的子 agent 过程记录（见 views/agent.ts 的 Layout）这个数是估的，只用来记 scrollTotal；要精确的总行数用 contentTotalExact。
 */
export function contentTotal(entry: ListEntry, state: AppState, ctx: AppContext): number | null {
  const { store, terminal } = ctx.data;
  if (entry.kind === "agent") {
    return store === null ? null : agentRowCount(store, entry.id, { width: contentWidth(ctx), expanded: state.expanded.has(entry.key) });
  }
  if (store === null && terminal === null) return null;
  return commandRowCount(commandSourceOf(entry, state, ctx), contentWidth(ctx));
}

/** 精确的总行数：翻到顶、跳到搜索命中的行（行号是精确的）时用；很长的过程记录要把每条都折一遍，所以不常用。 */
function contentTotalExact(entry: ListEntry, state: AppState, ctx: AppContext): number | null {
  const { store } = ctx.data;
  if (entry.kind !== "agent") return contentTotal(entry, state, ctx);
  return store === null ? null : agentRowCountExact(store, entry.id, { width: contentWidth(ctx), expanded: state.expanded.has(entry.key) });
}

/** 包含 query 的行号，从上到下；一行只算一个匹配。 */
export function findRows(entry: ListEntry, state: AppState, ctx: AppContext, query: string): number[] {
  const { store, terminal } = ctx.data;
  if (query === "") return [];
  if (entry.kind === "agent") {
    if (store === null) return [];
    const lines = agentContentLines(store, entry.id, {
      width: contentWidth(ctx),
      expanded: state.expanded.has(entry.key),
      now: ctx.now,
      spinnerFrame: 0,
    });
    return matchRows(lines, query);
  }
  const source = commandSourceOf(entry, state, ctx);
  const head = commandHeaderRows(source.command, contentWidth(ctx));
  const fromHead = matchRows(head, query);
  if (terminal !== null) return [...fromHead, ...(terminal.find?.(query) ?? []).map((row) => row + head.length)];
  return [...fromHead, ...matchRows(commandEventRows(eventOutputOf(entry, ctx), contentWidth(ctx)), query).map((row) => row + head.length)];
}

/** 画面上现在实际离底部多少行：用户翻看之后又来了新内容时，视图会把窗口往上挪同样多行。 */
function effectiveScroll(state: AppState, entry: ListEntry, ctx: AppContext, total: number | null, rows: number): number {
  if (state.scroll <= 0) return 0;
  if (entry.kind === "agent" && ctx.data.store !== null) {
    const options = { width: contentWidth(ctx), expanded: state.expanded.has(entry.key), now: ctx.now, spinnerFrame: 0, rows, scroll: state.scroll, scrollTotal: state.scrollTotal };
    return agentScrollPosition(ctx.data.store, entry.id, options).below;
  }
  const growth = total !== null && state.scrollTotal != null ? Math.max(0, total - state.scrollTotal) : 0;
  const max = total === null ? Number.POSITIVE_INFINITY : Math.max(0, total - rows);
  return Math.min(max, state.scroll + growth);
}

/** 翻看内容区：by 为正往上（看更早的），为负往下；to 直接指定离底部的行数（0 贴底，Infinity 到最上）。 */
export function scrollView(state: AppState, ctx: AppContext, entry: ListEntry, change: { by: number } | { to: number }): AppState {
  const rows = viewportRows(state, ctx);
  const total = contentTotal(entry, state, ctx);
  const wanted = "by" in change ? effectiveScroll(state, entry, ctx, total, rows) + change.by : change.to;
  let max = total === null ? 1_000_000_000 : Math.max(0, total - rows);
  // 很长的过程记录的总行数是估的：快翻到顶时换成精确的，翻到顶才准
  if (entry.kind === "agent" && total !== null && wanted > max * 0.6) max = Math.max(0, (contentTotalExact(entry, state, ctx) ?? total) - rows);
  const scroll = Math.max(0, Math.min(max, Math.floor(wanted)));
  const scrollTotal = scroll > 0 ? total : null;
  if (scroll === state.scroll && scrollTotal === (state.scrollTotal ?? null)) return state;
  return { ...state, scroll, scrollTotal };
}

/** 一页：内容区行数减 1，留一行衔接。 */
export function pageSize(state: AppState, ctx: AppContext): number {
  return Math.max(1, viewportRows(state, ctx) - 1);
}

// ───── 搜索 ─────

/** 把第 row 行翻进窗口：已经看得见就不动，否则放到窗口中间。 */
function revealRow(state: AppState, ctx: AppContext, entry: ListEntry, row: number): AppState {
  const rows = viewportRows(state, ctx);
  const total = contentTotalExact(entry, state, ctx);
  if (total === null) return state;
  const top = Math.max(0, total - rows - effectiveScroll(state, entry, ctx, total, rows));
  if (row >= top && row < top + rows) return state;
  return scrollView(state, ctx, entry, { to: scrollForRow(total, rows, row) });
}

export type SearchStep = "first" | "next" | "prev";

/**
 * 搜索跳转。first：Enter 确定搜索词后，跳到窗口顶上这一行或它之后的第一个匹配（没有就回到最前面）；
 * next、prev：按当前匹配的行号找下一个、上一个，到头了绕回另一头。每次重新数匹配，内容变长了也对得上。
 * 匹配数和当前行写进 SearchState（matches、currentRow），第几个匹配由视图在提示行写，状态机不另发提示。
 */
export function searchJump(state: AppState, ctx: AppContext, entry: ListEntry, step: SearchStep): AppUpdate {
  const search = state.search;
  if (search === null) return { state, effects: [] };
  const query = search.query.text;
  if (query === "") return { state: { ...state, search: null }, effects: [] };
  const rows = findRows(entry, state, ctx, query);
  if (rows.length === 0) {
    const empty: SearchState = { ...search, editing: false, index: 0, matches: 0, currentRow: null };
    return { state: { ...state, search: empty }, effects: [] };
  }
  const viewRows = viewportRows(state, ctx);
  const total = contentTotalExact(entry, state, ctx);
  const top = total === null ? 0 : Math.max(0, total - viewRows - effectiveScroll(state, entry, ctx, total, viewRows));
  const current = search.currentRow ?? null;
  let chosen: number;
  if (step === "first" || current === null) {
    chosen = step === "prev" ? (rows.findLast((r) => r < top) ?? rows[rows.length - 1]!) : (rows.find((r) => r >= top) ?? rows[0]!);
  } else if (step === "next") {
    chosen = rows.find((r) => r > current) ?? rows[0]!;
  } else {
    chosen = rows.findLast((r) => r < current) ?? rows[rows.length - 1]!;
  }
  const index = rows.indexOf(chosen);
  const next: SearchState = { ...search, editing: false, index, matches: rows.length, currentRow: chosen };
  const moved = revealRow({ ...state, search: next }, ctx, entry, chosen);
  return { state: moved, effects: [] };
}
