// 内容区的半框：上边是一条带标题的横线（同时是名单和内容区的分隔线），左边是竖线，右边和下边不封口；
// 输入行上面有一条细的分隔线。颜色表示键盘输入发给谁（子 agent 藤紫，命令青），粗细和明暗表示焦点在不在内容区。

import type { Focus } from "../../types/app.ts";
import type { ListEntry } from "../../types/model.ts";
import type { AppState } from "../../types/app.ts";
import type { ColorRole, Line, Span } from "../../types/ui.ts";
import { formatDuration } from "../format.ts";
import { fitLine, lineWidth, span } from "../line.ts";
import { clipText, textWidth } from "../width.ts";
import { commandOutcome } from "./input.ts";

/** 焦点在内容区用粗线，在名单用细线。 */
const GLYPHS = {
  content: { corner: "┏", fill: "━", bar: "┃", divider: "┠" },
  list: { corner: "┌", fill: "─", bar: "│", divider: "├" },
} as const;

/** 半框的种类色：焦点在内容区用亮的，否则用暗的。 */
export function frameColor(kind: ListEntry["kind"], focus: Focus): ColorRole {
  if (kind === "command") return focus === "content" ? "cyan" : "cyanDim";
  return focus === "content" ? "violet" : "violetDim";
}

/** 内容区每一行行首的竖线（后面再跟一个空格）。 */
export function frameBar(kind: ListEntry["kind"], focus: Focus): Span {
  return span(GLYPHS[focus === "content" ? "content" : "list"].bar, { fg: frameColor(kind, focus) });
}

/** 输入行上面的分隔线：画到最右一列，不管焦点在哪都用暗的种类色。 */
export function renderDividerLine(kind: ListEntry["kind"], focus: Focus, cols: number): Line {
  const glyphs = GLYPHS[focus === "content" ? "content" : "list"];
  const color: ColorRole = kind === "command" ? "cyanDim" : "violetDim";
  return cols <= 0 ? [] : [span(glyphs.divider + "─".repeat(cols - 1), { fg: color })];
}

/** 状态的说法：在跑、等你发话、已结束、失败、已取消、已停（stopped：随 session 结束而停）。命令结束后在后面写退出码。 */
export function statusWord(entry: ListEntry, state: Pick<AppState, "interrupts">): string {
  if (entry.orphaned === true || entry.status === "stopped") return "已停";
  const isCommand = entry.kind === "command";
  const code = entry.exitCode;
  const withCode = (word: string) => (isCommand && code !== null ? `${word}（退出码 ${code}）` : word);
  switch (entry.status) {
    case "running":
      return "在跑";
    case "idle":
      return "等你发话";
    case "cancelled":
      return isCommand ? withCode("已中断") : "已取消";
    case "failed":
    case "done": {
      if (!isCommand) return entry.status === "failed" ? "失败" : "已结束";
      const outcome = commandOutcome(entry, state);
      return withCode(outcome === "interrupted" ? "已中断" : outcome === "failed" ? "失败" : "已结束");
    }
  }
}

const oneLine = (text: string | undefined): string => (text ?? "").replace(/\s+/g, " ").trim();

interface TitleParts {
  /** 名字（命令带 "$ "）。 */
  name: string;
  description: string;
  model: string;
  /** 状态和用时。 */
  status: string;
}

/** 标题内容的片段，从左到右：名字（粗体、种类色·亮）、简述（一档）、模型（三档）、状态和用时（二档），之间两个空格；空的项不写。 */
function titleSpans(parts: TitleParts, kind: ColorRole): Line {
  const out: Span[] = [span(parts.name, { fg: kind, bold: true })];
  if (parts.description !== "") out.push(span("  "), span(parts.description));
  if (parts.model !== "") out.push(span("  "), span(parts.model, { fg: "grey" }));
  out.push(span("  "), span(parts.status, { fg: "text2" }));
  return out;
}

/** 放不下时按这个顺序去掉：模型、简述，然后截断名字。 */
function fitTitle(parts: TitleParts, kind: ColorRole, room: number): Line {
  const attempts: TitleParts[] = [parts, { ...parts, model: "" }, { ...parts, model: "", description: "" }];
  for (const attempt of attempts) {
    const line = titleSpans(attempt, kind);
    if (lineWidth(line) <= room) return line;
  }
  const bare = { ...parts, model: "", description: "" };
  const nameRoom = room - 2 - textWidth(bare.status);
  if (nameRoom < 1) return fitLine([span(bare.status, { fg: "text2" })], room);
  return titleSpans({ ...bare, name: clipText(bare.name, nameRoom) }, kind);
}

/**
 * 内容区的标题行：焦点在内容区是 `┏━ <标题内容> ━━━…━`，在名单是 `┌─ <标题内容> ───…─`，线画到最右一列，颜色见 frameColor。
 * 标题内容：子 agent 是 `<名字>  <简述>  <模型>  <状态> <用时>`；命令是 `$ <命令名>  <状态> <用时>`。
 * tail 不空时（放大模式的“第 2 个，共 7 个”）写在线的末尾，三档，前面留一个空格；线不够长（少于 2 格）就不写。
 */
export function renderTitleLine(entry: ListEntry, state: Pick<AppState, "focus" | "interrupts">, cols: number, tail = ""): Line {
  if (cols <= 0) return [];
  const focus = state.focus;
  const glyphs = GLYPHS[focus === "content" ? "content" : "list"];
  const color = frameColor(entry.kind, focus);
  const kind: ColorRole = entry.kind === "command" ? "cyan" : "violet";
  const isCommand = entry.kind === "command";
  const parts: TitleParts = {
    name: isCommand ? `$ ${entry.name}` : entry.name,
    description: isCommand ? "" : oneLine(entry.description),
    model: isCommand ? "" : oneLine(entry.model ?? ""),
    status: `${statusWord(entry, state)} ${formatDuration(entry.elapsedMs)}`,
  };

  const lead = glyphs.corner + glyphs.fill;
  const room = cols - textWidth(lead) - 2 - 1;
  const content = room >= 1 ? fitTitle(parts, kind, room) : [];
  const used = textWidth(lead) + 1 + lineWidth(content) + 1;
  const left = Math.max(0, cols - used);
  const showTail = tail !== "" && left >= textWidth(tail) + 1 + 2;
  const fill = showTail ? left - textWidth(tail) - 1 : left;
  const line: Span[] = [span(lead, { fg: color }), span(" ")];
  if (content.length > 0) line.push(...content, span(" "));
  line.push(span(glyphs.fill.repeat(fill), { fg: color }));
  if (showTail) line.push(span(" "), span(tail, { fg: "grey" }));
  return fitLine(line, cols);
}
