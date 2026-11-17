// 排版：每一块从第几行开始、占几行，名单显示哪些列。纯函数。
//
// 从上到下：顶行、提示行（有 statusNotice 时）、名单（条目、“上下还有几个”、“收起了几个”）、内容区的标题行（半框的上边）、
// 内容区、提示行（Notice：翻看、搜索、操作结果）、输入行上面的分隔线、输入行、按键提示行。

import {
  COLLAPSE_LIST_BELOW_ROWS,
  HIDE_MODEL_BELOW_COLS,
  HIDE_TOKENS_BELOW_COLS,
  INPUT_MAX_ROWS,
} from "../../constants.ts";
import type { AppState, ViewData } from "../../types/app.ts";
import { agentKey, commandKey, isEnded, type ListEntry } from "../../types/model.ts";
import type { Size } from "../../types/ui.ts";
import { renderInputLines } from "./input.ts";
import { pageOffset } from "./rowkit.ts";
import { statusNoticeOf } from "./top.ts";

export interface Layout {
  /** 顶行固定在第 0 行；顶行下面的异常提示行是 statusRow，没有提示（或 pane 太矮）是 -1。有它时名单少一行。 */
  statusRow: number;
  listTop: number;
  /** 名单里条目占几行（不含下面的“还有几个”和“收起了几个”）。放大时是 0。 */
  listRows: number;
  /** 名单从第几个条目开始显示（条目多于 listRows 时，保证选中的在可见范围内）。 */
  listOffset: number;
  /** 名单收起（按了 z，或 pane 矮于 COLLAPSE_LIST_BELOW_ROWS 行）：名单一行都不显示，标题行紧接在顶行（和提示行）下面。 */
  listCollapsed: boolean;
  /** 选中的条目在 data.entries 里的下标；没有选中或已经不在名单里是 -1。 */
  selectedIndex: number;
  /** 名单被截时，条目下面写“↑ 上面还有 N 个”的那一行；不用写是 -1。 */
  hintRow: number;
  /** 收起了已结束的条目时，名单最后写“… 收起了 N 个已结束的”的那一行；不用写是 -1。 */
  hiddenRow: number;
  /** 被 c 键收起的已结束条目数（数得出来的）。 */
  hiddenEnded: number;
  /** 内容区的标题行（半框的上边）；pane 太矮时没有，是 -1。 */
  titleRow: number;
  /** 内容区（过程记录或终端）的起始行和行数，不含提示行和输入行。 */
  contentTop: number;
  contentRows: number;
  /** 提示行（Notice，没有提示时是只有竖线的空行）；pane 太矮时没有，是 -1。 */
  noticeRow: number;
  /** 输入行上面的分隔线；pane 太矮时没有，是 -1。 */
  dividerRow: number;
  /** 输入行的起始行和行数（子 agent 的输入框多行时向上长高，最多 INPUT_MAX_ROWS 行，挤掉内容区的行）。 */
  inputTop: number;
  inputRows: number;
  /** 按键提示行，固定在最后一行。 */
  keysRow: number;
  /** pane 不窄于 HIDE_MODEL_BELOW_COLS（60）列时显示模型列。 */
  showModel: boolean;
  /** pane 不窄于 HIDE_TOKENS_BELOW_COLS（48）列时显示 token 列。 */
  showTokens: boolean;
}

/** 选中的条目；没有选中或不在名单里是 null。 */
export function findSelected(state: AppState, data: ViewData): { entry: ListEntry; index: number } | null {
  if (state.selected === null) return null;
  const index = data.entries.findIndex((e) => e.key === state.selected);
  return index < 0 ? null : { entry: data.entries[index]!, index };
}

/**
 * 被收起的已结束条目数：状态库里已结束、却不在名单上的子 agent，和留下来的失败命令里不在名单上的。
 * 数据里没有直接给这个数，所以从状态库推；只在收起时用。
 */
export function hiddenEndedCount(data: ViewData): number {
  const store = data.store;
  if (!store) return 0;
  const shown = new Set(data.entries.map((e) => e.key));
  let count = 0;
  for (const agent of store.agents()) if (isEnded(agent.status) && !shown.has(agentKey(agent.id))) count++;
  for (const command of store.commands()) if (command.keptAsFailed && isEnded(command.status) && !shown.has(commandKey(command.toolCallId))) count++;
  return count;
}

/** 输入框占几行：问输入行的画法，免得两边算的不一样。 */
function measureInputRows(state: AppState, data: ViewData, size: Size): number {
  const entry = findSelected(state, data)?.entry ?? null;
  const rows = renderInputLines(entry, state, data.extension.kind === "readonly", Math.max(0, size.cols - 2), data.now).lines.length;
  return Math.min(INPUT_MAX_ROWS, Math.max(1, rows));
}

/**
 * 排版规则：顶行 1 行，提示行 0 或 1 行；名单（含上下还有几个、收起了几个）不超过 (rows - 6 - 提示行) 的 40%（向上取整，至少 3 行），
 * 收起时 0 行，没有条目时 1 行（写一句说明）；然后标题行 1 行、内容区、Notice 行、分隔线、输入行；最后一行是按键提示。
 * pane 太矮时按这个顺序保：输入行、标题行、提示行、名单、分隔线、Notice 行，内容区最后才被挤到 0 行。
 * 多出来的名单条目按页翻，选中的那一页在屏内。inputRows 是输入框的行数，renderFrame 已经画过输入行时传进来；不传就自己问输入行。
 */
export function computeLayout(state: AppState, data: ViewData, size: Size, inputRows?: number): Layout {
  const rows = Math.max(0, Math.floor(size.rows));
  const cols = Math.max(0, Math.floor(size.cols));
  const count = data.entries.length;
  const selected = findSelected(state, data);
  const collapsed = state.zoom || rows < COLLAPSE_LIST_BELOW_ROWS;
  const showModel = cols >= HIDE_MODEL_BELOW_COLS;
  const showTokens = cols >= HIDE_TOKENS_BELOW_COLS;
  const hasStatus = statusNoticeOf(data) !== null;
  const hiddenEnded = state.collapseEnded ? hiddenEndedCount(data) : 0;

  const cap = Math.max(3, Math.ceil((rows - 6 - (hasStatus ? 1 : 0)) * 0.4));
  const hiddenWanted = !collapsed && hiddenEnded > 0 ? 1 : 0;
  let listWanted = 0;
  if (!collapsed) {
    if (count === 0) listWanted = hiddenWanted > 0 ? 0 : 1;
    else listWanted = count + hiddenWanted <= cap ? count : Math.max(1, cap - hiddenWanted - 1);
  }
  const inputWanted = Math.min(INPUT_MAX_ROWS, Math.max(1, inputRows ?? measureInputRows(state, data, size)));

  let left = Math.max(0, rows - 2);
  const take = (n: number): number => {
    const t = Math.min(n, left);
    left -= t;
    return t;
  };
  const input = take(inputWanted);
  const title = take(1);
  const status = take(hasStatus ? 1 : 0);
  const list = take(listWanted);
  const hint = count > list && list > 0 ? take(1) : 0;
  const hidden = take(hiddenWanted);
  const divider = take(1);
  const notice = take(1);
  const content = left;

  const statusRow = status > 0 ? 1 : -1;
  const listTop = 1 + status;
  const hintRow = hint > 0 ? listTop + list : -1;
  const hiddenRow = hidden > 0 ? listTop + list + hint : -1;
  const titleRow = title > 0 ? listTop + list + hint + hidden : -1;
  const contentTop = listTop + list + hint + hidden + title;
  const noticeRow = notice > 0 ? contentTop + content : -1;
  const dividerRow = divider > 0 ? contentTop + content + notice : -1;
  const inputTop = contentTop + content + notice + divider;

  return {
    statusRow,
    listTop,
    listRows: list,
    listOffset: pageOffset(selected?.index ?? -1, count, list),
    listCollapsed: collapsed,
    selectedIndex: selected?.index ?? -1,
    hintRow,
    hiddenRow,
    hiddenEnded,
    titleRow,
    contentTop,
    contentRows: content,
    noticeRow,
    dividerRow,
    inputTop,
    inputRows: input,
    keysRow: Math.max(0, rows - 1),
    showModel,
    showTokens,
  };
}
