// s 键：选 session 的列表，盖在名单和内容区上面。↑↓ 选、Enter 换过去并固定、Esc 关掉。
// 列表最后一项是“恢复自动选择”：取消固定，回到自动找 session。选中的一行和名单一样整行铺底色、第 0 列画藤紫色块；当前显示的 session 标 "●"。

import type { SessionChoice } from "../../types/app.ts";
import type { ColorRole, Line, Span, Style } from "../../types/ui.ts";
import { cell, fitLine, span } from "../line.ts";
import { textWidth } from "../width.ts";
import { liftColor, pageOffset, paintRow, trimLineEnd } from "./rowkit.ts";

export const PICKER_TITLE = "选择 session（● 是当前显示的）";
export const PICKER_AUTO = "恢复自动选择";
export const PICKER_AUTO_NOTE = "跟着最近有动静的 session";

/** 标题至少留这么多列，其余的列放不下就不画。 */
const MIN_TITLE_COLS = 12;

/** 最近事件距现在多久：刚刚、N 秒前、N 分钟前、N 小时前、N 天前；没有事件（时间不大于 0）是空串。 */
export function formatAgo(now: number, at: number): string {
  if (!(at > 0)) return "";
  const s = Math.max(0, Math.floor((now - at) / 1000));
  if (s < 10) return "刚刚";
  if (s < 60) return `${s} 秒前`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.floor(h / 24)} 天前`;
}

const lastSegment = (path: string | null): string => (path ?? "").split("/").filter(Boolean).pop() ?? "";

function sessionTitle(s: SessionChoice): string {
  const title = (s.title ?? "").replace(/\s+/g, " ").trim();
  return title !== "" ? title : s.sessionId.slice(0, 8);
}

/**
 * 每个 session 一行：名字（没有写 session ID 前 8 位）、工作目录最后一段、最新事件距今多久、在跑的条目数（runningCount 没给就没有这一列）；
 * 当前显示的行首第二格写 "●"，高亮的行整行铺底色（selFocus）、第 0 列写藤紫色块 "▌"、名字加粗、文字提一档。
 * 第一行是粗体的标题，最后一项是“恢复自动选择”（highlighted 等于 sessions.length 时高亮）。
 * 窄的时候依次去掉工作目录、在跑数、时间；多于一屏时按页翻，高亮的那一行总在屏内。最多 rows 行，每行不超过 width 列。
 */
export function renderSessionPicker(sessions: readonly SessionChoice[], highlighted: number, now: number, width: number, rows: number): Line[] {
  if (rows <= 0) return [];
  const out: Line[] = [];
  if (rows >= 2) out.push(fitLine([span(PICKER_TITLE, { bold: true })], width));
  const itemRows = rows - out.length;

  const count = sessions.length + 1;
  const index = Math.min(Math.max(0, Math.trunc(highlighted)), count - 1);
  const ago = sessions.map((s) => formatAgo(now, s.lastEventAt));
  const dirs = sessions.map((s) => lastSegment(s.cwd));
  const running = sessions.map((s) => (s.runningCount !== undefined && s.runningCount > 0 ? `${s.runningCount} 个在跑` : ""));
  const hasRunning = sessions.some((s) => s.runningCount !== undefined);
  const widest = (texts: string[]) => Math.max(0, ...texts.map(textWidth));

  // 窄的时候按“时间、在跑数、工作目录”的顺序决定画不画，剩下的都给标题。
  let titleWidth = Math.max(0, width - 3);
  const take = (w: number): boolean => {
    if (w <= 0 || titleWidth - (w + 2) < MIN_TITLE_COLS) return false;
    titleWidth -= w + 2;
    return true;
  };
  const agoWidth = widest(ago);
  const runWidth = widest(running);
  const dirWidth = Math.min(16, widest(dirs));
  const showAgo = take(agoWidth);
  const showRunning = hasRunning && take(runWidth);
  const showDir = take(dirWidth);

  const offset = pageOffset(index, count, itemRows);
  for (let i = offset; i < Math.min(count, offset + itemRows); i++) {
    const on = i === index;
    const tone = (fg: ColorRole | undefined): Style | undefined => {
      const color = on ? liftColor(fg) : fg;
      return color === undefined ? undefined : { fg: color };
    };
    const nameStyle: Style | undefined = on ? { bold: true } : undefined;
    const lead = (current: boolean): Span[] => [span(on ? "▌" : " ", on ? { fg: "violet" } : undefined), span(current ? "●" : " "), span(" ")];
    const finishRow = (row: Span[]): Line => (on ? paintRow(fitLine(row, width), width, "selFocus") : trimLineEnd(fitLine(row, width)));
    if (i === sessions.length) {
      out.push(finishRow([...lead(false), span(PICKER_AUTO, nameStyle), span("  "), span(PICKER_AUTO_NOTE, tone("grey"))]));
      continue;
    }
    const s = sessions[i]!;
    const cells: Line[] = [cell([span(sessionTitle(s), nameStyle)], titleWidth)];
    if (showDir) cells.push(cell([span(dirs[i]!, tone("grey"))], dirWidth));
    if (showAgo) cells.push(cell([span(ago[i]!, tone("grey"))], agoWidth, "right"));
    if (showRunning) cells.push(cell([span(running[i]!)], runWidth, "right"));
    const row: Span[] = [...lead(s.current)];
    cells.forEach((c, k) => {
      if (k > 0) row.push(span("  "));
      row.push(...c);
    });
    out.push(finishRow(row));
  }
  return out;
}
