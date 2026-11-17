// 内容区（子 agent 的过程记录、命令的终端）共用的辅助：翻看的窗口、搜索命中的行和高亮、几个常用样式。纯函数。
// 子 agent 和命令的内容区（agent.ts、command.ts）以及输入行上方的提示行（input.ts）都用这里的东西。

import type { Line, Span, Style } from "../../types/ui.ts";
import { lineText } from "../line.ts";

export const GREY: Style = { fg: "grey" };
export const RED: Style = { fg: "red" };
export const ORANGE: Style = { fg: "orange" };
export const BOLD: Style = { bold: true };

/** 窗口没有贴着底部时的位置：below 是窗口下面还有几行，fresh 是其中翻看之后新来的几行。 */
export interface ScrollInfo {
  below: number;
  fresh: number;
}

/** rows 行内容（不够的在末尾补空行）和窗口的位置。 */
export interface ContentWindow {
  lines: Line[];
  scroll: ScrollInfo;
}

/**
 * 搜索高亮：query 在每一行里的所有命中都加下划线；currentRow 那一行（全部行里的行号，没有是 null）的命中改成反色加粗，
 * 好找到“当前跳到的这个匹配”。不分大小写。
 */
export interface SearchHighlight {
  query: string;
  currentRow: number | null;
}

/** 在 total 行里取 rows 行的窗口。scroll 是离底部的行数（超出范围时夹到合法值）；scrollTotal 见 AppState.scrollTotal。 */
export function resolveScroll(
  total: number,
  rows: number,
  scroll: number,
  scrollTotal?: number | null,
): { start: number; info: ScrollInfo } {
  const max = Math.max(0, total - rows);
  const want = Math.max(0, Math.floor(scroll) || 0);
  const growth = want > 0 && scrollTotal != null ? Math.max(0, total - scrollTotal) : 0;
  const below = Math.min(max, want + growth);
  return { start: max - below, info: { below, fresh: want > 0 ? Math.min(below, growth) : 0 } };
}

/** 让第 row 行大致出现在窗口中间的 scroll 值（离底部的行数）。搜索跳到某个匹配时用。 */
export function scrollForRow(total: number, rows: number, row: number): number {
  const max = Math.max(0, total - rows);
  const start = Math.max(0, Math.min(max, Math.floor(row) - Math.floor(rows / 2)));
  return max - start;
}

/** 补空行补到 rows 行；多出的不动。 */
export function padRows(lines: Line[], rows: number): Line[] {
  const out = lines.slice();
  while (out.length < rows) out.push([]);
  return out;
}

/** 看不见任何东西的行：没有文字，或只有空白且没有背景色、反显、下划线。 */
export function isBlankLine(line: Line): boolean {
  return line.every((s) => s.text.trim() === "" && (s.style === undefined || (s.style.bg === undefined && !s.style.inverse && !s.style.underline)));
}

function ranges(text: string, needle: string): [number, number][] {
  const out: [number, number][] = [];
  const hay = text.toLowerCase();
  // 个别字符变小写后长度会变（如 İ），下标对不上，这样的行不高亮。
  if (hay.length !== text.length) return out;
  for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + needle.length)) out.push([at, at + needle.length]);
  return out;
}

/** 包含 query 的行号（从 0 起，从上到下），不分大小写；query 为空返回 []。和 TermView.find 同一规则：一行只算一个匹配。 */
export function matchRows(lines: readonly Line[], query: string): number[] {
  if (query === "") return [];
  const needle = query.toLowerCase();
  const found: number[] = [];
  lines.forEach((line, i) => {
    if (lineText(line).toLowerCase().includes(needle)) found.push(i);
  });
  return found;
}

function marked(style: Style | undefined, current: boolean): Style {
  return current ? { ...style, inverse: !style?.inverse, bold: true } : { ...style, underline: true };
}

/** 把一行里 query 的命中都高亮；没有命中时原样返回。 */
export function highlightLine(line: Line, query: string, current: boolean): Line {
  if (query === "") return line;
  const found = ranges(lineText(line), query.toLowerCase());
  if (found.length === 0) return line;
  const out: Span[] = [];
  let offset = 0;
  for (const s of line) {
    const end = offset + s.text.length;
    let at = 0;
    for (const [from, to] of found) {
      const a = Math.max(from, offset) - offset;
      const b = Math.min(to, end) - offset;
      if (a >= b) continue;
      if (a > at) out.push({ text: s.text.slice(at, a), ...(s.style ? { style: s.style } : {}) });
      out.push({ text: s.text.slice(a, b), style: marked(s.style, current) });
      at = b;
    }
    if (at < s.text.length) out.push({ text: s.text.slice(at), ...(s.style ? { style: s.style } : {}) });
    offset = end;
  }
  return out;
}

/** 给一段连续的行（第一行是全部行里的第 firstRow 行）加搜索高亮。 */
export function highlightRows(lines: readonly Line[], search: SearchHighlight | undefined, firstRow: number): Line[] {
  if (!search || search.query === "") return lines.slice();
  return lines.map((line, i) => highlightLine(line, search.query, search.currentRow === firstRow + i));
}
