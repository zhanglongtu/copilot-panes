// 名单的每一行：未读点、状态符号、名字（按层级缩进）、模型、用时、token、最近一步，列之间一个空格。
// 亮度表示死活：在跑的最亮，做完一轮在等的暗一档，结束的最暗；色相只表示种类（子 agent 藤紫，命令青），只有活着的才带。
// 选中的行整行铺底色，第 0 列画色块 "▌"，文字提一档。

import { SPINNER_FRAMES } from "../../constants.ts";
import type { Focus } from "../../types/app.ts";
import type { ListEntry } from "../../types/model.ts";
import type { ColorRole, Line, Style } from "../../types/ui.ts";
import { formatDuration, formatTokens, formatTokensAtLeast } from "../format.ts";
import { cell, fitLine, span } from "../line.ts";
import { joinCells, liftColor, paintRow, trimLineEnd } from "./rowkit.ts";

/** 随 session 结束而停的条目（stopped）、session 的进程没了停在半路的条目（ListEntry.orphaned）的符号。 */
export const ORPHANED_SYMBOL = "◌";
/** 被取消的条目的符号。 */
export const CANCELLED_SYMBOL = "⊘";
/** 选中行第 0 列的色块。 */
export const SELECTED_BLOCK = "▌";

/** 进度条一共几格，以及已完成、未完成的格子（都占 1 列）。 */
export const PROGRESS_CELLS = 10;
export const PROGRESS_FILLED = "▰";
export const PROGRESS_EMPTY = "▱";
/** pane 不窄于这么多列才画进度条。 */
export const PROGRESS_BAR_MIN_COLS = 80;

/**
 * 状态符号：在跑是转动的盲文点（SPINNER_FRAMES 的第 spinnerFrame 帧），idle 是 "○"，done 是 "✓"，failed 是 "✗"，
 * cancelled（被你或主 agent 取消）是 "⊘"，stopped（随 session 结束而停）和 orphaned（Copilot CLI 进程没了）是 "◌"。
 */
export function statusSymbol(entry: ListEntry, spinnerFrame: number): string {
  if (entry.orphaned === true || entry.status === "stopped") return ORPHANED_SYMBOL;
  switch (entry.status) {
    case "running": {
      const n = SPINNER_FRAMES.length;
      return SPINNER_FRAMES[((Math.trunc(spinnerFrame) % n) + n) % n]!;
    }
    case "idle":
      return "○";
    case "failed":
      return "✗";
    case "cancelled":
      return CANCELLED_SYMBOL;
    default:
      return "✓";
  }
}

export interface ListColumns {
  showModel: boolean;
  showTokens: boolean;
  /** 名字列宽：nameWidth = min(22, max(8, avail - 14))；pane 宽于 90 列时上限放宽，最多 48。 */
  nameWidth: number;
  /** 最近一步列宽：avail - nameWidth，不小于 0。 */
  lastWidth: number;
  /** 一行最多这么宽；也是选中行铺底色铺到的宽度（pane 的列数）。 */
  maxWidth?: number;
}

/** 列宽：avail = cols - (2 + 5 + 模型列 10 + token 列 6) - (列数 - 1)。 */
export function listColumns(cols: number, showModel: boolean, showTokens: boolean): ListColumns {
  const cells = 5 + (showModel ? 1 : 0) + (showTokens ? 1 : 0);
  const avail = cols - (2 + 5 + (showModel ? 10 : 0) + (showTokens ? 6 : 0)) - (cells - 1);
  const cap = cols <= 90 ? 22 : Math.min(48, 22 + Math.floor((cols - 90) / 2));
  const nameWidth = Math.min(cap, Math.max(8, avail - 14));
  return { showModel, showTokens, nameWidth, lastWidth: Math.max(0, avail - nameWidth), maxWidth: Math.max(0, cols) };
}

export interface ListRowOptions {
  selected: boolean;
  unread: boolean;
  focus: Focus;
  spinnerFrame: number;
  columns: ListColumns;
}

type Tone = ColorRole | undefined;

/** 一行各列的颜色：undefined 是一档文字（终端默认前景）。 */
interface RowTones {
  symbol: Tone;
  name: Tone;
  bold: boolean;
  model: Tone;
  time: Tone;
  tokens: Tone;
  step: Tone;
}

const all = (symbol: Tone, name: Tone, rest: Tone, step: Tone, bold = false): RowTones => ({ symbol, name, bold, model: rest, time: rest, tokens: rest, step });

/** 状态到颜色：在跑最亮，等你发话（idle）和失败看读没读过，已结束、取消、已停全是三档。 */
function tonesFor(entry: ListEntry, unread: boolean): RowTones {
  const kind: ColorRole = entry.kind === "command" ? "cyan" : "violet";
  const kindDim: ColorRole = entry.kind === "command" ? "cyanDim" : "violetDim";
  if (entry.orphaned === true) return all("grey", "grey", "grey", "grey");
  switch (entry.status) {
    case "running":
      return { symbol: kind, name: kind, bold: true, model: "grey", time: undefined, tokens: "grey", step: undefined };
    case "idle":
      return unread ? all(kind, undefined, "text2", "text2") : all(kindDim, "text2", "grey", "grey");
    case "failed":
      return unread ? all("red", "text2", "grey", "text2") : all("redDim", "grey", "grey", "grey");
    default:
      return all("grey", "grey", "grey", "grey");
  }
}

/** 一段文字的片段；文字为空时没有片段。bg 只在选中行用。 */
const styled = (text: string, fg?: Tone, bold = false): Line => {
  if (text === "") return [];
  const style: Style = {};
  if (fg) style.fg = fg;
  if (bold) style.bold = true;
  return [span(text, fg || bold ? style : undefined)];
};

/** 从“最近一步”认出进度（"12/40 30%"、"30%"），返回已完成的比例 0 到 1；认不出是 null。 */
export function progressOf(step: string): number | null {
  const fraction = /^(\d+)\/(\d+)(?: \d+%)?$/.exec(step);
  if (fraction) {
    const total = Number(fraction[2]);
    return total > 0 ? Math.min(1, Number(fraction[1]) / total) : null;
  }
  const percent = /^(\d+)%$/.exec(step);
  return percent ? Math.min(1, Number(percent[1]) / 100) : null;
}

/** 10 格的进度条文字，例如 0.3 是 "▰▰▰▱▱▱▱▱▱▱"。 */
export function progressBar(ratio: number): string {
  const filled = Math.max(0, Math.min(PROGRESS_CELLS, Math.floor(ratio * PROGRESS_CELLS)));
  return PROGRESS_FILLED.repeat(filled) + PROGRESS_EMPTY.repeat(PROGRESS_CELLS - filled);
}

/**
 * 一行：名字前每深一层缩 2 个空格；命令写 "$ " 加命令原文，显示模型列时命令的名字占 nameWidth + 11 列（不画模型列）。
 * 颜色见 tonesFor；用时右对齐 5 列，token 右对齐 6 列；在跑的命令认出进度、pane 不窄于 PROGRESS_BAR_MIN_COLS 列时，
 * “最近一步”先画 10 格进度条（青·亮）再写数字。未读（unread）的行首是橙色 "•"。
 * 选中的行：第 0 列是种类色·亮的 "▌"，名字加粗，文字提一档（liftColor），整行铺到 columns.maxWidth 列的底色
 * （焦点在名单用 selFocus，否则 selBlur）。没有选中的行去掉行尾空格。
 */
export function renderListRow(entry: ListEntry, options: ListRowOptions): Line {
  const { selected, unread, focus, spinnerFrame, columns } = options;
  const isCommand = entry.kind === "command";
  const kind: ColorRole = isCommand ? "cyan" : "violet";
  const tones = tonesFor(entry, unread);
  const tone = (t: Tone): Tone => (selected ? liftColor(t) : t);

  const lead = selected ? styled(SELECTED_BLOCK, kind) : unread ? styled("•", "orange") : [span(" ")];
  const nameText = "  ".repeat(entry.depth) + (isCommand ? "$ " + entry.name : entry.name);
  const bold = tones.bold || selected;

  const cells: Line[] = [lead, styled(statusSymbol(entry, spinnerFrame), tone(tones.symbol))];
  if (isCommand && columns.showModel) {
    cells.push(cell(styled(nameText, tone(tones.name), bold), columns.nameWidth + 11));
  } else {
    cells.push(cell(styled(nameText, tone(tones.name), bold), columns.nameWidth));
    if (columns.showModel) cells.push(cell(styled(entry.model ?? "", tone(tones.model)), 10));
  }
  cells.push(cell(styled(formatDuration(entry.elapsedMs), tone(tones.time)), 5, "right"));
  if (columns.showTokens) {
    const tokens = entry.tokens === null ? "" : entry.tokensPartial === true ? formatTokensAtLeast(entry.tokens) : formatTokens(entry.tokens);
    cells.push(cell(styled(tokens, tone(tones.tokens)), 6, "right"));
  }

  const ratio = isCommand && entry.status === "running" && entry.orphaned !== true && (columns.maxWidth ?? 0) >= PROGRESS_BAR_MIN_COLS ? progressOf(entry.step) : null;
  const step: Line = ratio === null ? styled(entry.step, tone(tones.step)) : [span(progressBar(ratio), { fg: "cyan" }), span(" "), ...styled(entry.step, tone(tones.step))];
  cells.push(cell(step, columns.lastWidth));

  const row = joinCells(cells);
  const width = columns.maxWidth;
  if (selected) return width === undefined ? row : paintRow(fitLine(row, width), width, focus === "list" ? "selFocus" : "selBlur");
  const trimmed = trimLineEnd(row);
  return width === undefined ? trimmed : trimLineEnd(fitLine(trimmed, width));
}

const NUMBER_ABOVE = "↑ 上面还有";
const NUMBER_BELOW = "↓ 下面还有";

/** 名单被截时画在最后一个条目下面的一行：上、下各还有几个；被挡住的里有在跑的，写“其中 M 个在跑”并用二档，否则三档。 */
export function listScrollHint(above: number, below: number, runningAbove: number, runningBelow: number): Line {
  const part = (label: string, count: number, running: number): Line =>
    count <= 0 ? [] : [span(`${label} ${count} 个${running > 0 ? `，其中 ${running} 个在跑` : ""}`, { fg: running > 0 ? "text2" : "grey" })];
  const up = part(NUMBER_ABOVE, above, runningAbove);
  const down = part(NUMBER_BELOW, below, runningBelow);
  if (up.length === 0 && down.length === 0) return [];
  return [span("  "), ...up, ...(up.length > 0 && down.length > 0 ? [span("  ")] : []), ...down];
}

/** 收起了已结束的条目时，名单最后一行。count 是 null（数不出来）时不写数量。 */
export function hiddenEndedLine(count: number | null): Line {
  return [span(`  … 收起了${count === null ? "" : ` ${count} 个`}已结束的，按 c 显示`, { fg: "grey" })];
}
