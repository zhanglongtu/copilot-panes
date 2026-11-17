// 命令的内容区：终端模拟器的可见部分，命令自己的颜色和粗体原样保留。纯函数。
// 没有输出文件（扩展没加载）时退回事件日志里的输出，当普通文字显示。

import { cleanText } from "../../model/output.ts";
import type { Line, TerminalLines } from "../../types/ui.ts";
import { fitLine, span } from "../line.ts";
import { wrapText } from "../width.ts";
import { GREY, highlightRows, isBlankLine, padRows, resolveScroll } from "./content.ts";
import type { ContentWindow, SearchHighlight } from "./content.ts";

/** 没有输出文件、只能用事件日志里的输出时，内容区第一行的灰色说明。 */
export const EVENT_OUTPUT_NOTICE = "这条命令的输出要等它结束才有：扩展没有加载";
/** 命令还没有任何输出时内容区唯一的一行。 */
export const NO_OUTPUT_TEXT = "还没有输出";
/** session 的进程没了、这条命令停在半路又没有输出时：输出不会再来了。 */
export const ORPHANED_NO_OUTPUT_TEXT = "session 已经结束，这条命令没有留下输出";

/** 展开细节（e 键）时命令原文最多占这么多行，多的写“还有 N 行”。 */
export const COMMAND_HEADER_MAX_ROWS = 12;

/** 命令内容的来源：有终端用终端；没有终端（没有 .out）但有事件日志里的输出（CommandRecord.eventOutput 原文）时用它。 */
export interface CommandSource {
  terminal: TerminalLines | null;
  eventOutput?: string | null;
  /** 展开细节（e 键）时给命令原文：显示在输出上面，保留原来的换行，后面空一行。不展开不给。 */
  command?: string | null;
  /** 这条命令停在半路（ListEntry.orphaned）：没有输出时写“没有留下输出”，不写“还没有输出”。 */
  orphaned?: boolean;
}

export interface CommandContentOptions {
  /** 内容区宽度；默认是终端的列数。比它宽的行末尾加 "…"。 */
  width?: number;
  search?: SearchHighlight;
}

const notice = (text: string): Line => [span(text, GREY)];

/** 终端里最后一个看得见的行之后的行号（屏幕底部的空行不算）；没有输出是 0。 */
function terminalRowCount(terminal: TerminalLines): number {
  const chunk = 64;
  for (let end = terminal.totalLines; end > 0; end = Math.max(0, end - chunk)) {
    const start = Math.max(0, end - chunk);
    const lines = terminal.lines(start, end - start);
    for (let i = lines.length - 1; i >= 0; i--) if (!isBlankLine(lines[i]!)) return start + i + 1;
  }
  return 0;
}

/** 命令原文的行：“$ ”加原文，原文的换行保留，每行按宽度折，最多 COMMAND_HEADER_MAX_ROWS 行；后面空一行。没有原文是 []。 */
export function commandHeaderRows(command: string | null | undefined, width: number): Line[] {
  const text = (command ?? "").replace(/\r\n?/g, "\n").trimEnd();
  if (text.trim() === "") return [];
  const w = Math.max(1, Math.floor(width));
  const rows: string[] = [];
  text.split("\n").forEach((line, i) => rows.push(...wrapText((i === 0 ? "$ " : "  ") + line, w)));
  const shown = rows.slice(0, COMMAND_HEADER_MAX_ROWS);
  const lines: Line[] = shown.map((row) => (row === "" ? [] : [span(row, GREY)]));
  if (rows.length > shown.length) lines.push([span(`  … 还有 ${rows.length - shown.length} 行`, GREY)]);
  lines.push([]);
  return lines;
}

let eventMemo: { text: string; width: number; rows: Line[] } | null = null;

/**
 * 事件日志里的输出折成的全部行：开头是 EVENT_OUTPUT_NOTICE（灰色，窄时折成几行），然后是 cleanText 清理过的输出（普通文字，按宽度折行）；
 * 输出为空时再加一行 NO_OUTPUT_TEXT。CommandRecord.eventOutput 是没清理过的原文，所以必须经过这里。
 */
export function commandEventRows(eventOutput: string, width: number): Line[] {
  const w = Math.max(1, Math.floor(width));
  if (eventMemo && eventMemo.text === eventOutput && eventMemo.width === w) return eventMemo.rows;
  const rows: Line[] = wrapText(EVENT_OUTPUT_NOTICE, w).map(notice);
  const text = cleanText(eventOutput).replace(/\s+$/, "");
  if (text.trim() === "") rows.push(notice(NO_OUTPUT_TEXT));
  else for (const row of wrapText(text, w)) rows.push(row === "" ? [] : [span(row)]);
  eventMemo = { text: eventOutput, width: w, rows };
  return rows;
}

interface Shown {
  lines: Line[];
  scroll: { below: number; fresh: number };
}

function windowOf(
  all: readonly Line[],
  rows: number,
  scroll: number,
  scrollTotal: number | null | undefined,
  options: CommandContentOptions,
): Shown {
  const { start, info } = resolveScroll(all.length, rows, scroll, scrollTotal);
  return { lines: highlightRows(all.slice(start, start + rows), options.search, start), scroll: info };
}

function show(
  source: CommandSource,
  rows: number,
  scroll: number,
  scrollTotal: number | null | undefined,
  options: CommandContentOptions,
): Shown {
  const { terminal } = source;
  const head = commandHeaderRows(source.command, options.width ?? terminal?.cols ?? 80);
  const none: Shown = { lines: rows > 0 ? [...head, notice(NO_OUTPUT_TEXT)].slice(0, rows) : [], scroll: { below: 0, fresh: 0 } };
  if (terminal) {
    const width = Math.max(1, Math.floor(options.width ?? terminal.cols));
    const body = terminalRowCount(terminal);
    if (body === 0) return head.length === 0 ? none : windowOf([...head, notice(NO_OUTPUT_TEXT)], rows, scroll, scrollTotal, options);
    const { start, info } = resolveScroll(head.length + body, rows, scroll, scrollTotal);
    const lines = head.slice(start, start + rows);
    const from = Math.max(0, start - head.length);
    if (lines.length < rows) lines.push(...terminal.lines(from, Math.min(rows - lines.length, body - from)).map((line) => fitLine(line, width)));
    return { lines: highlightRows(lines, options.search, start), scroll: info };
  }
  if (source.eventOutput == null) return none;
  if (source.orphaned === true && cleanText(source.eventOutput).trim() === "") return windowOf([...head, notice(ORPHANED_NO_OUTPUT_TEXT)], rows, scroll, scrollTotal, options);
  return windowOf([...head, ...commandEventRows(source.eventOutput, options.width ?? 80)], rows, scroll, scrollTotal, options);
}

/**
 * 内容区恰好 rows 行：贴底时显示最后 rows 行；内容不够时从上往下排，下面补空行；
 * scroll 大于 0 时往上翻 scroll 行（夹在合法范围内，停在最顶上）。scrollTotal 是翻看那一刻的总行数（AppState.scrollTotal）：
 * 翻看之后新来的行不会把窗口顶走，数量写在返回的 scroll.fresh 里。
 * 终端的行原样（颜色、粗体）；屏幕底部的空行不算内容；还没有任何输出时是一行灰色的“还没有输出”。
 * 没有终端但给了 eventOutput 时，按 commandEventRows 显示。source.command 不空时（展开细节），命令原文在最上面，行号也从它起算。
 */
export function commandContentWindow(
  source: CommandSource,
  options: CommandContentOptions & { rows: number; scroll: number; scrollTotal?: number | null },
): ContentWindow {
  const rows = Math.max(0, Math.floor(options.rows));
  const shown = show(source, rows, options.scroll, options.scrollTotal, options);
  return { lines: padRows(shown.lines, rows), scroll: shown.scroll };
}

/**
 * 内容区的 rows 行（最多 rows 行，不补空行）：规则同 commandContentWindow。终端还没有任何输出时是一行灰色的“还没有输出”。
 */
export function commandContentLines(terminal: TerminalLines, scroll: number, rows: number, options?: CommandContentOptions): Line[] {
  return show({ terminal }, Math.max(0, Math.floor(rows)), scroll, null, options ?? {}).lines;
}

/** 全部行数（屏幕底部的空行不算）。记录翻看那一刻的 AppState.scrollTotal、算 PgUp 的上限时用；没有输出是 0。 */
export function commandRowCount(source: CommandSource, width: number): number {
  const head = commandHeaderRows(source.command, width).length;
  if (source.terminal) {
    const body = terminalRowCount(source.terminal);
    return body === 0 && head > 0 ? head + 1 : head + body;
  }
  if (source.eventOutput == null) return head > 0 ? head + 1 : 0;
  if (source.orphaned === true && cleanText(source.eventOutput).trim() === "") return head + 1;
  return head + commandEventRows(source.eventOutput, width).length;
}
