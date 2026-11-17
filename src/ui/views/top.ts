// 顶行和它下面的提示行。顶行只说“这是哪个 session、一共多少在跑”；异常状态（只读、session 已结束等）单独占提示行，写明原因和怎么恢复。
// 顶行：左边是 `<目录名>  ›  <session 标题>`（目录名粗体，› 三档，标题一档，放不下时截断标题）；
// 右边是 `N 个在跑`（N 大于 0 时一档，否则三档）和 token 合计（三档），最左边可能有 `另有 N 个在别的 session 跑（按 s）`（二档，宽度不够时最先去掉）。

import type { ViewData } from "../../types/app.ts";
import type { Line, Span } from "../../types/ui.ts";
import { formatTokens } from "../format.ts";
import { fitLine, lineWidth, span } from "../line.ts";
import { clipText, textWidth } from "../width.ts";

export const SESSION_ENDED_TEXT = "session 已结束";

/** 标题至少留这么多列才写。 */
const MIN_TITLE_COLS = 4;
/** 写“另有 N 个在别的 session 跑”时，左边至少还要留的列数（项目名和标题的一部分）。 */
const MIN_LEFT_WITH_OTHER = 24;

export type StatusNotice = NonNullable<ViewData["statusNotice"]>;

/** 顶行下面要显示的提示：数据里的 statusNotice（只读的原因和怎么恢复都在里面）；没有或是 null 就没有这一行。session 已结束时数据给 null，顶行右边写“session 已结束”。 */
export function statusNoticeOf(data: ViewData): StatusNotice | null {
  return data.statusNotice ?? null;
}

/** 提示行：attention 橙色，muted 三档；放不下时末尾截成 "…"。 */
export function renderStatusNotice(notice: StatusNotice, cols: number): Line {
  return fitLine([span(notice.text, { fg: notice.tone === "attention" ? "orange" : "grey" })], cols);
}

export function renderTopLine(data: ViewData, cols: number): Line {
  const ended = data.sessionEnded === true;
  const running = ended ? SESSION_ENDED_TEXT : `${data.runningCount} 个在跑`;
  const right: Span[] = [span(running, data.runningCount > 0 && !ended ? undefined : { fg: "grey" })];
  if (data.totalTokens !== null) right.push(span("  "), span(`${formatTokens(data.totalTokens)} token`, { fg: "grey" }));

  const project = data.session?.project ?? "";
  const title = data.session?.title ?? "";
  const leftFull = textWidth(project) + (title !== "" ? 5 + textWidth(title) : 0);

  const other = data.otherSessions;
  const otherLine: Span[] =
    other && other.running > 0 ? [span(`另有 ${other.running} 个在别的 session 跑（按 s）`, { fg: "text2" }), span("  ")] : [];
  const withOther = otherLine.length > 0 && cols - lineWidth(otherLine) - lineWidth(right) - 2 >= Math.min(leftFull, MIN_LEFT_WITH_OTHER);
  const rightLine: Line = withOther ? [...otherLine, ...right] : right;

  const leftRoom = Math.max(0, cols - lineWidth(rightLine) - 2);
  const left: Span[] = project === "" ? [] : [span(project, { bold: true })];
  const titleRoom = leftRoom - textWidth(project) - (project === "" ? 0 : 5);
  if (title !== "" && titleRoom >= MIN_TITLE_COLS) {
    if (project !== "") left.push(span("  "), span("›", { fg: "grey" }), span("  "));
    left.push(span(clipText(title, titleRoom)));
  }

  const fitted = fitLine(left, leftRoom);
  const gap = span(" ".repeat(Math.max(0, leftRoom - lineWidth(fitted)) + 2));
  return fitLine([...fitted, gap, ...rightLine], cols);
}
