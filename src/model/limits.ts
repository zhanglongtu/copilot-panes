// 状态库里长期保留的文字的上限。session 可以开很久，内存不能跟着日志无限长：超出的部分在入库时就截掉，
// 并记下被截掉多少字符，界面可以显示“还有 N 字符”（用 cutChars 取）。

import type { CommandRecord, TaskItem, SayItem, ThinkItem, MessageItem, ToolItem } from "../types/model.ts";

/** 工具调用的参数和结果里，每个字符串最多留这么多个字符（从开头留）。一行摘要要的字段在这之前取出。 */
export const TOOL_TEXT_KEEP_CHARS = 4 * 1024;
/** 命令在事件里的输出（CommandRecord.eventOutput）最多留这么多个字符，从末尾留。 */
export const EVENT_OUTPUT_KEEP_CHARS = 256 * 1024;
/** 子 agent 说的话、思考、任务说明、用户发的消息，每条最多留这么多个字符（从开头留）。 */
export const MESSAGE_KEEP_CHARS = 64 * 1024;

type CutField = "text" | "args" | "resultText" | "errorText" | "eventOutput" | "command" | "description";
const cuts = new WeakMap<object, Partial<Record<CutField, number>>>();

/** 一个对象的某个字段被截掉了多少字符（没截是 0）。对象是状态库里的 TranscriptItem、CommandRecord 或 AgentRecord。 */
export function cutChars(owner: TaskItem | SayItem | ThinkItem | MessageItem, field: "text"): number;
export function cutChars(owner: ToolItem, field: "args" | "resultText" | "errorText"): number;
export function cutChars(owner: CommandRecord, field: "eventOutput" | "command" | "description"): number;
export function cutChars(owner: object, field: CutField): number {
  return cuts.get(owner)?.[field] ?? 0;
}

export function noteCut(owner: object, field: CutField, count: number): void {
  if (count <= 0) return;
  const record = cuts.get(owner);
  if (record) record[field] = (record[field] ?? 0) + count;
  else cuts.set(owner, { [field]: count });
}

/** 取出来单独存一份：slice 出来的字符串会一直拖着整个原字符串，截断就白做了。 */
function detach(text: string): string {
  return Buffer.from(text, "utf8").toString("utf8");
}

/** 最多留开头 limit 个字符。 */
export function clipHead(text: string, limit: number): { text: string; cut: number } {
  if (text.length <= limit) return { text, cut: 0 };
  const code = text.charCodeAt(limit - 1);
  const end = code >= 0xd800 && code <= 0xdbff ? limit - 1 : limit; // 不把一个代理对切成两半
  return { text: detach(text.slice(0, end)), cut: text.length - end };
}

/** 最多留末尾 limit 个字符。 */
export function clipTail(text: string, limit: number): { text: string; cut: number } {
  if (text.length <= limit) return { text, cut: 0 };
  const code = text.charCodeAt(text.length - limit);
  const start = code >= 0xdc00 && code <= 0xdfff ? text.length - limit + 1 : text.length - limit;
  return { text: detach(text.slice(start)), cut: start };
}

/**
 * JSON 值里的每个字符串最多留开头 limit 个字符，其余原样；cut 是整棵树里被截掉的字符总数，size 是留下的字符串字符总数。
 * 没有字符串超限时 value 就是原对象，不复制。
 */
export function clipJson(value: unknown, limit: number, depth = 0): { value: unknown; cut: number; size: number } {
  if (typeof value === "string") {
    const clipped = clipHead(value, limit);
    return { value: clipped.text, cut: clipped.cut, size: clipped.text.length };
  }
  if (typeof value !== "object" || value === null || depth > 16) return { value, cut: 0, size: 0 };
  let cut = 0;
  let size = 0;
  if (Array.isArray(value)) {
    let copy: unknown[] | null = null;
    value.forEach((item, i) => {
      const clipped = clipJson(item, limit, depth + 1);
      size += clipped.size;
      if (clipped.cut > 0) {
        copy ??= value.slice();
        copy[i] = clipped.value;
        cut += clipped.cut;
      }
    });
    return { value: copy ?? value, cut, size };
  }
  let copy: Record<string, unknown> | null = null;
  for (const [key, item] of Object.entries(value)) {
    const clipped = clipJson(item, limit, depth + 1);
    size += clipped.size;
    if (clipped.cut > 0) {
      copy ??= { ...(value as Record<string, unknown>) };
      copy[key] = clipped.value;
      cut += clipped.cut;
    }
  }
  return { value: copy ?? value, cut, size };
}

/** 整个状态库长期保留的文字总量的预算（字符数）。每条文字有上限，但条数没有；总量超出预算时，从最早入库的开始缩短。 */
export const TEXT_BUDGET_CHARS = 24_000_000;
/** 超出预算被缩短的文字，只留这么多个字符（开头；命令的输出留末尾）。 */
export const SHRUNK_KEEP_CHARS = 160;

/** 记着每条长文字的字符数和缩短它的办法；总量超出预算时，按入库的先后缩短，直到回到预算以内。 */
export class TextBudget {
  private entries: ({ size: number; shrink: () => void } | null)[] = [];
  private head = 0;
  private total = 0;
  private readonly budget: number;

  constructor(budget: number = TEXT_BUDGET_CHARS) {
    this.budget = budget;
  }

  add(size: number, shrink: () => void): void {
    if (size <= SHRUNK_KEEP_CHARS) return;
    this.entries.push({ size, shrink });
    this.total += size;
    while (this.total > this.budget && this.head < this.entries.length) {
      const oldest = this.entries[this.head];
      this.entries[this.head++] = null;
      if (!oldest) continue;
      oldest.shrink();
      this.total -= oldest.size;
    }
    if (this.head > 50_000) {
      this.entries = this.entries.slice(this.head);
      this.head = 0;
    }
  }
}

/** 生成一行摘要要的、从完整结果里才数得出的数字：edit 增删的行数。在结果截断之前取出。 */
const editLines = new WeakMap<ToolItem, { added: number; removed: number }>();

export function setEditLines(item: ToolItem, text: string): void {
  if (!text.includes("\n@@")) return;
  let added = 0;
  let removed = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) added++;
    else if (line.startsWith("-") && !line.startsWith("---")) removed++;
  }
  editLines.set(item, { added, removed });
}

export function editLinesOf(item: ToolItem): { added: number; removed: number } | null {
  return editLines.get(item) ?? null;
}
