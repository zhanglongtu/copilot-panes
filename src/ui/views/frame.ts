// 视图：从界面状态、数据和 pane 尺寸得出一帧。纯函数。
//
// 画面从上到下：顶行、提示行（有异常时）、名单、内容区的标题行、内容区、Notice 行、输入行上面的分隔线、输入行、按键提示行。
// 内容区是一个半框：标题行是上边（带标题的横线），左边是竖线（内容区每一行含输入行的最左边），右边和下边不封口。
// 半框的颜色表示键盘输入发给谁（子 agent 藤紫，命令青），粗细和明暗表示焦点在不在内容区（见 title.ts）。
// 选中的名单行整行铺底色，是全屏唯一的底色条（见 list.ts）。

import type { AppState, ViewData } from "../../types/app.ts";
import { isEnded } from "../../types/model.ts";
import type { Cursor, Frame, Line, Size } from "../../types/ui.ts";
import { fitLine, span } from "../line.ts";
import { agentContentWindow } from "./agent.ts";
import { commandContentWindow } from "./command.ts";
import type { ScrollInfo, SearchHighlight } from "./content.ts";
import { renderHelp } from "./help.ts";
import { renderInputLines, renderNoticeLine } from "./input.ts";
import { renderKeysLine } from "./keys.ts";
import { computeLayout, findSelected } from "./layout.ts";
import { hiddenEndedLine, listColumns, listScrollHint, renderListRow } from "./list.ts";
import { spinnerFrameAt, trimLineEnd } from "./rowkit.ts";
import { renderSessionPicker } from "./sessions.ts";
import { frameBar, renderDividerLine, renderTitleLine } from "./title.ts";
import { renderStatusNotice, renderTopLine, statusNoticeOf } from "./top.ts";
import { renderWaiting } from "./waiting.ts";

/** 画内容区、输入行和提示行用的函数。真实的在 agent.ts、command.ts、input.ts；测试可以换成假的。 */
export interface FrameDeps {
  agentWindow: typeof agentContentWindow;
  commandWindow: typeof commandContentWindow;
  inputLines: typeof renderInputLines;
  noticeLine: typeof renderNoticeLine;
}

export const REAL_DEPS: FrameDeps = {
  agentWindow: agentContentWindow,
  commandWindow: commandContentWindow,
  inputLines: renderInputLines,
  noticeLine: renderNoticeLine,
};

export const EMPTY_LIST_TEXT = "还没有子 agent 或后台命令";

const NO_SCROLL: ScrollInfo = { below: 0, fresh: 0 };

function searchHighlight(state: AppState): SearchHighlight | undefined {
  const search = state.search;
  if (!search || search.query.text === "") return undefined;
  return { query: search.query.text, currentRow: search.currentRow ?? null };
}

/**
 * 得出一帧：没有 session 画等待画面（waiting.ts）；overlay 为 help、sessions 时，名单和内容区换成帮助、session 列表
 * （顶行和按键提示行不变）；其余按 layout.ts 排版，各块分别由 top.ts、list.ts、title.ts、agent.ts 或 command.ts、input.ts、keys.ts 画。
 * 光标：用 input.ts 给的位置（焦点在内容区、选中子 agent 且能发消息，或在编辑搜索词），加上行首竖线占的 2 列；其余隐藏。
 * 转动符号是第 floor(data.now / SPINNER_FRAME_MS) % 10 帧，见 rowkit.ts 的 spinnerFrameAt。
 */
export function renderFrame(state: AppState, data: ViewData, size: Size): Frame {
  return renderFrameWith(REAL_DEPS, state, data, size);
}

export function renderFrameWith(deps: FrameDeps, state: AppState, data: ViewData, size: Size): Frame {
  if (data.session === null) return renderWaiting(size);
  const rows = Math.max(0, Math.floor(size.rows));
  const cols = Math.max(0, Math.floor(size.cols));
  if (rows === 0) return { lines: [], cursor: null };

  const selected = findSelected(state, data);
  const entry = selected?.entry ?? null;
  const readOnly = data.extension.kind === "readonly";
  const cause = data.extension.kind === "readonly" ? data.extension.cause : undefined;
  const width = Math.max(0, cols - 2);
  const now = data.now;

  const input = deps.inputLines(entry, state, readOnly, width, now, cause);
  const layout = computeLayout(state, data, { cols, rows }, input.lines.length);
  const lines: Line[] = Array.from({ length: rows }, () => []);
  const put = (row: number, line: Line) => {
    if (row >= 0 && row < rows) lines[row] = line;
  };

  put(0, renderTopLine(data, cols));
  put(
    layout.keysRow,
    renderKeysLine(state, entry, now, cols, {
      readOnly,
      noticeVisible: layout.noticeRow >= 0,
      hasEnded: data.entries.some((e) => isEnded(e.status)),
    }),
  );

  if (state.overlay !== "none") {
    const area = Math.max(0, layout.keysRow - 1);
    const overlay =
      state.overlay === "help"
        ? renderHelp(readOnly, cols, area, state.helpScroll ?? 0)
        : renderSessionPicker(data.sessions, state.pickerIndex, now, cols, area);
    overlay.slice(0, area).forEach((line, i) => put(1 + i, line));
    return finish(lines, cols, null);
  }

  const notice = statusNoticeOf(data);
  if (layout.statusRow >= 0 && notice) put(layout.statusRow, renderStatusNotice(notice, cols));

  // 名单
  const spinner = spinnerFrameAt(now);
  const columns = listColumns(cols, layout.showModel, layout.showTokens);
  const entries = data.entries;
  const rowFor = (e: (typeof entries)[number], isSelected: boolean) =>
    renderListRow(e, { selected: isSelected, unread: state.unread.has(e.key), focus: state.focus, spinnerFrame: spinner, columns });
  if (entries.length === 0) {
    if (layout.listRows > 0) put(layout.listTop, [span("  " + EMPTY_LIST_TEXT, { fg: "grey" })]);
    else if (layout.hiddenRow < 0 && layout.titleRow >= 0) put(layout.titleRow, [span("  " + EMPTY_LIST_TEXT, { fg: "grey" })]);
  } else {
    for (let i = 0; i < layout.listRows; i++) {
      const e = entries[layout.listOffset + i];
      if (e) put(layout.listTop + i, rowFor(e, layout.listOffset + i === layout.selectedIndex));
    }
  }
  if (layout.hintRow >= 0) {
    const from = layout.listOffset + layout.listRows;
    const countRunning = (items: typeof entries) => items.filter((e) => e.status === "running").length;
    const above = entries.slice(0, layout.listOffset);
    const below = entries.slice(from);
    put(layout.hintRow, listScrollHint(above.length, below.length, countRunning(above), countRunning(below)));
  }
  if (layout.hiddenRow >= 0) put(layout.hiddenRow, hiddenEndedLine(layout.hiddenEnded));

  // 标题行、内容区、Notice 行、分隔线、输入行：内容区每行前面是竖线和一个空格
  if (entry !== null && layout.titleRow >= 0) {
    const tail = layout.listCollapsed && entries.length > 1 && layout.selectedIndex >= 0 ? `第 ${layout.selectedIndex + 1} 个，共 ${entries.length} 个` : "";
    put(layout.titleRow, renderTitleLine(entry, state, cols, tail));
  }
  if (entry !== null && layout.dividerRow >= 0) put(layout.dividerRow, renderDividerLine(entry.kind, state.focus, cols));

  const bar = entry === null ? span(" ") : frameBar(entry.kind, state.focus);
  const barLine = (content: Line): Line => trimLineEnd([bar, span(" "), ...fitLine(content, width)]);
  let scroll = NO_SCROLL;
  let content: Line[] = [];
  if (entry !== null && layout.contentRows > 0) {
    const search = searchHighlight(state);
    if (entry.kind === "agent") {
      if (data.store) {
        const w = deps.agentWindow(data.store, entry.id, {
          width,
          expanded: state.expanded.has(entry.key),
          now,
          spinnerFrame: spinner,
          rows: layout.contentRows,
          scroll: state.scroll,
          scrollTotal: state.scrollTotal,
          ...(search ? { search } : {}),
        });
        content = w.lines;
        scroll = w.scroll;
      }
    } else {
      const w = deps.commandWindow(
        {
          terminal: data.terminal,
          eventOutput: data.store?.command(entry.id)?.eventOutput ?? null,
          command: state.expanded.has(entry.key) ? (data.store?.command(entry.id)?.command ?? null) : null,
          orphaned: entry.orphaned === true,
        },
        { width, rows: layout.contentRows, scroll: state.scroll, scrollTotal: state.scrollTotal, ...(search ? { search } : {}) },
      );
      content = w.lines;
      scroll = w.scroll;
    }
  }
  for (let i = 0; i < layout.contentRows; i++) put(layout.contentTop + i, barLine(content[i] ?? []));
  if (layout.noticeRow >= 0) put(layout.noticeRow, barLine(deps.noticeLine(state, now, width, scroll)));
  input.lines.slice(0, layout.inputRows).forEach((line, i) => put(layout.inputTop + i, barLine(line)));

  let cursor: Cursor | null = null;
  if (input.cursor !== null && input.cursor.row < layout.inputRows) {
    cursor = { row: layout.inputTop + input.cursor.row, col: Math.min(Math.max(0, cols - 1), 2 + input.cursor.col) };
  }
  return finish(lines, cols, cursor);
}

/** 最后一道保证：每一行都不超过 pane 的列数，行尾没有空格（选中行铺的底色除外）。 */
function finish(lines: Line[], cols: number, cursor: Cursor | null): Frame {
  return { lines: lines.map((l) => trimLineEnd(fitLine(l, cols))), cursor };
}
