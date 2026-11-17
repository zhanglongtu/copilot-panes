// 子 agent 的内容区：任务说明、它说的话、每次工具调用（一行一条）、你发的消息、正在等的那一行。纯函数。

import { SPINNER_FRAMES, TASK_PREVIEW_ROWS } from "../../constants.ts";
import { toolLine, toolLineText, waitingText } from "../../model/describe.ts";
import { cleanText } from "../../model/output.ts";
import type { AppState } from "../../types/app.ts";
import type { StoreView, ToolItem, TranscriptItem } from "../../types/model.ts";
import type { Line, Span, Style } from "../../types/ui.ts";
import { formatDuration } from "../format.ts";
import { fitLine, span } from "../line.ts";
import { clipText, textWidth, wrapText } from "../width.ts";
import { BOLD, GREY, highlightRows, padRows, RED } from "./content.ts";
import type { ContentWindow, SearchHighlight } from "./content.ts";

/** 展开细节时，每个工具结果最多显示这么多行，多的写“还有 N 行”。 */
export const TOOL_RESULT_ROWS = 12;
/** 任务说明收起时，提示“还有 N 行”要至少这么宽才写。 */
const MIN_HINT_WIDTH = 30;

export interface AgentContentOptions {
  /** 内容区宽度（pane 列数减去竖线和一个空格）。 */
  width: number;
  /** e 键展开了细节。 */
  expanded: boolean;
  now: number;
  spinnerFrame: number;
  /** 搜索词和当前命中的行：命中的文字加下划线（当前行反色）。 */
  search?: SearchHighlight;
}

type Wrap = (text: string, width: number) => string[];

const wrapLines: Wrap = (text, width) => wrapText(text, width);
const splitLines: Wrap = (text) => text.replace(/\r\n?/g, "\n").split("\n");

/** 每个文字行变成一个带样式的片段；空行是空数组。第一行加 prefix，其余行加 indent。 */
function styled(rows: string[], style: Style | undefined, prefix = "", indent = ""): Line[] {
  return rows.map((row, i) => {
    const text = row === "" ? "" : (i === 0 ? prefix : indent) + row;
    return text === "" ? [] : [span(text, style)];
  });
}

function taskRows(text: string, expanded: boolean, width: number, wrap: Wrap, fold: number): Line[] {
  const rest = fold > 0 ? text.slice(fold).trim() : "";
  const cut = rest !== "" ? fold : 0;
  if (expanded) {
    const note: Line[] = cut > 0 ? [[span(`（开头 ${cut} 个字和其他任务相同）`, GREY)]] : [];
    return [...note, ...styled(wrap(`任务：${text.trim()}`, width), GREY)];
  }
  // 开头和其他任务相同的部分收起时不显示：从这之后的内容开始。
  const full = `任务：${cut > 0 ? rest : text.trim()}`;
  // 收起时每个原有的行只占一行，放不下的末尾加 "…"。
  const lines = splitLines(full, width).filter((line) => line.trim() !== "");
  const shown = lines.slice(0, TASK_PREVIEW_ROWS);
  const hidden = lines.length - shown.length;
  const out = shown.map((line): Line => fitLine([span(line, GREY)], width));
  if (hidden > 0 && width >= MIN_HINT_WIDTH) {
    const hint = `  （还有 ${hidden} 行，按 e 展开）`;
    out[out.length - 1] = [span(clipText(shown[shown.length - 1]!, width - textWidth(hint)), GREY), span(hint, GREY)];
  }
  return out;
}

function toolRows(item: ToolItem, store: StoreView, expanded: boolean, width: number, wrap: Wrap): Line[] {
  const spans: Span[] = [span(toolLineText(toolLine(item, store)), GREY)];
  if (item.status === "failed") spans.push(span("  失败", RED));
  const out: Line[] = [fitLine(spans, width)];
  if (!expanded) return out;
  const body = cleanText((item.status === "failed" ? (item.errorText ?? item.resultText) : item.resultText) ?? "").trim();
  if (body === "") return out;
  const rows = wrap(body, Math.max(1, width - 2));
  const shown = rows.slice(0, Number.isFinite(width) ? TOOL_RESULT_ROWS : rows.length);
  out.push(...styled(shown, GREY, "  ", "  "));
  if (rows.length > shown.length) out.push([span(`  … 还有 ${rows.length - shown.length} 行`, GREY)]);
  return out;
}

function itemRows(item: TranscriptItem, store: StoreView, expanded: boolean, width: number, wrap: Wrap, fold = 0): Line[] {
  switch (item.kind) {
    case "task":
      return item.text.trim() === "" ? [] : [...taskRows(item.text, expanded, width, wrap, fold), []];
    case "say":
      return styled(wrap(item.text.trim(), width), undefined);
    case "think":
      return expanded && item.text.trim() !== "" ? styled(wrap(`思考：${item.text.trim()}`, width), GREY) : [];
    case "tool":
      return toolRows(item, store, expanded, width, wrap);
    case "message": {
      const text = item.text.trim();
      if (item.from === "you") return styled(wrap(text, Math.max(1, width - 2)), BOLD, "› ", "  ");
      return styled(wrap(`${item.fromName}：${text}`, width), GREY);
    }
    case "end":
      if (item.status !== "failed") return [];
      return styled(wrap(item.error ? `失败：${item.error}` : "失败", width), RED);
    case "resume":
      return [];
  }
}

/**
 * 折好的行，按条目记。每个条目最多按 MEMO_VARIANTS 种（宽度、是否展开）各存一份，来回切宽度、按 e 都不用全部重排；
 * 状态库压缩旧文字时 text 变了就重算。工具调用完成时会原地改，所以它的行不存（收起时它永远只有一行，也不用排）。
 */
interface Memo {
  text: string;
  rows?: Line[];
}
const MEMO_VARIANTS = 4;
const itemMemo = new WeakMap<object, Map<string, Memo>>();

function memoOf(item: TranscriptItem, expanded: boolean, width: number, fold: number): Memo {
  const text = "text" in item ? item.text : "";
  let variants = itemMemo.get(item);
  if (!variants) {
    variants = new Map();
    itemMemo.set(item, variants);
  }
  const key = `${width}:${expanded ? 1 : 0}:${fold}`;
  let memo = variants.get(key);
  if (!memo || memo.text !== text) {
    if (!memo && variants.size >= MEMO_VARIANTS) variants.delete(variants.keys().next().value as string);
    memo = { text };
    variants.set(key, memo);
  }
  return memo;
}

function rowsOfItem(item: TranscriptItem, store: StoreView, expanded: boolean, width: number, fold = 0): Line[] {
  if (item.kind === "tool") return itemRows(item, store, expanded, width, wrapLines);
  const memo = memoOf(item, expanded, width, item.kind === "task" ? fold : 0);
  return (memo.rows ??= itemRows(item, store, expanded, width, wrapLines, fold));
}

/** 任务说明开头和其他任务相同的字符数（AgentRecord.promptFoldChars），没有是 0。 */
function foldOf(store: StoreView, agentId: string): number {
  return store.agent(agentId)?.promptFoldChars ?? 0;
}

/** 这个条目精确占几行。收起时工具调用永远是一行，不用把行排出来。 */
function heightOf(item: TranscriptItem, store: StoreView, expanded: boolean, width: number, fold = 0): number {
  if (item.kind === "tool" && !expanded) return 1;
  return rowsOfItem(item, store, expanded, width, fold).length;
}

/** 一段文字折行后大概几行：一遍扫过去数每行占几列（汉字按 2 列），再多留 10% 给断词浪费的地方；不真的折行。 */
function estimateText(text: string, width: number): number {
  const w = Math.max(1, width);
  let rows = 0;
  let columns = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 10) {
      rows += Math.max(1, Math.ceil((columns * 1.1) / w));
      columns = 0;
    } else columns += code >= 0x1100 && isWideUnit(code) ? 2 : 1;
  }
  return rows + Math.max(1, Math.ceil((columns * 1.1) / w));
}

/** UTF-16 单元占两列的主要范围：韩文字母、CJK 符号和汉字、谚文音节、兼容汉字、全角符号。星号平面的汉字（代理对）按两个单元各一列，估算够用。 */
function isWideUnit(code: number): boolean {
  return (
    code <= 0x115f ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6)
  );
}

/** 展开细节时工具调用大概几行：一行加结果的行数（最多 TOOL_RESULT_ROWS 行，多的再加一行“还有 N 行”）。 */
function estimateTool(item: ToolItem): number {
  const body = (item.status === "failed" ? (item.errorText ?? item.resultText) : item.resultText) ?? "";
  if (body.trim() === "") return 1;
  let lines = 1;
  for (let at = body.indexOf("\n"); at >= 0 && lines <= TOOL_RESULT_ROWS; at = body.indexOf("\n", at + 1)) lines++;
  return 1 + Math.min(TOOL_RESULT_ROWS, lines) + (lines > TOOL_RESULT_ROWS ? 1 : 0);
}

/** 这个条目大概几行。排起来贵的（会折行的话、展开的工具结果）按长度估，其余本来就便宜，给精确值。 */
function estimateOf(item: TranscriptItem, store: StoreView, expanded: boolean, width: number, fold = 0): number {
  switch (item.kind) {
    case "tool":
      return expanded ? estimateTool(item) : 1;
    case "think":
      if (!expanded) return 0;
    // falls through
    case "say":
    case "message":
      return estimateText(item.text, item.kind === "message" && item.from === "you" ? width - 2 : width);
    default:
      return heightOf(item, store, expanded, width, fold);
  }
}

/** 过程记录不超过这么多条时全部精确排；更长的，开始看它的那一刻已有的那些条目只估算，之后新来的精确排。 */
const EXACT_ITEMS_LIMIT = 400;
/** 每个状态库每个 session 最多存这么多份排版（按子 agent、宽度、是否展开各一份），超出时丢掉最久没用的。 */
const LAYOUTS_PER_STORE = 8;

/**
 * 一个子 agent 的过程记录在某个宽度和展开状态下的总行数，翻看用。
 * 记录很长时（超过 EXACT_ITEMS_LIMIT 条）不能为了一个总数把每条都折一遍（1 万条要 300 毫秒），所以开始看的那一刻已有的条目只估算，
 * 估算值定下来就不再改，之后新来的条目精确算：这样“总行数”前后两次的差就是新来的行数，翻看之后新来的内容不会把窗口顶走。
 * 窗口里的行一直是精确排的（从最后一行往前排够为止），总数只用来夹翻看的上限和算新来了几行。
 */
class Layout {
  readonly exact: boolean;
  readonly baseCount: number;
  #baseRows = 0;
  #version = -1;
  #length = -1;
  #total = 0;

  readonly fold: number;

  constructor(items: readonly TranscriptItem[], store: StoreView, expanded: boolean, width: number, fold: number) {
    this.fold = fold;
    this.baseCount = items.length;
    this.exact = items.length <= EXACT_ITEMS_LIMIT;
    if (!this.exact) for (const item of items) this.#baseRows += estimateOf(item, store, expanded, width, fold);
  }

  /** i 号条目在总行数里算几行。 */
  rowsInTotal(item: TranscriptItem, index: number, store: StoreView, expanded: boolean, width: number): number {
    return this.exact || index >= this.baseCount ? heightOf(item, store, expanded, width, this.fold) : estimateOf(item, store, expanded, width, this.fold);
  }

  /** 总行数（不含“正在等”那一行）；记录没变（状态库版本和条数都一样）就不重算。 */
  total(items: readonly TranscriptItem[], store: StoreView, expanded: boolean, width: number): number {
    if (store.version === this.#version && items.length === this.#length) return this.#total;
    let sum = this.exact ? 0 : this.#baseRows;
    for (let i = this.exact ? 0 : this.baseCount; i < items.length; i++) sum += heightOf(items[i]!, store, expanded, width, this.fold);
    this.#version = store.version;
    this.#length = items.length;
    this.#total = sum;
    return sum;
  }
}

const layouts = new WeakMap<StoreView, Map<string, Layout>>();

function layoutFor(store: StoreView, agentId: string, expanded: boolean, width: number, items: readonly TranscriptItem[]): Layout {
  let cache = layouts.get(store);
  if (!cache) {
    cache = new Map();
    layouts.set(store, cache);
  }
  const fold = foldOf(store, agentId);
  const key = `${agentId}|${width}|${expanded ? 1 : 0}`;
  let layout = cache.get(key);
  cache.delete(key);
  if (!layout || items.length < layout.baseCount || layout.fold !== fold) layout = new Layout(items, store, expanded, width, fold);
  cache.set(key, layout);
  if (cache.size > LAYOUTS_PER_STORE) cache.delete(cache.keys().next().value as string);
  return layout;
}

let memo: {
  store: StoreView;
  version: number;
  agentId: string;
  width: number;
  expanded: boolean;
  length: number;
  rows: Line[];
} | null = null;

/** 过程记录里除了“正在等”那一行以外的所有行（精确）；同一份记录同一个宽度只算一次。搜索和精确的总行数用，画面不用。 */
function staticRows(store: StoreView, agentId: string, expanded: boolean, width: number): Line[] {
  const items = store.transcript(agentId);
  if (
    memo &&
    memo.store === store &&
    memo.version === store.version &&
    memo.agentId === agentId &&
    memo.width === width &&
    memo.expanded === expanded &&
    memo.length === items.length
  ) {
    return memo.rows;
  }
  const fold = foldOf(store, agentId);
  const rows = items.flatMap((item) => rowsOfItem(item, store, expanded, width, fold));
  memo = { store, version: store.version, agentId, width, expanded, length: items.length, rows };
  return rows;
}

function waitingRow(store: StoreView, agentId: string, width: number, now: number, spinnerFrame: number): Line | null {
  if (store.agent(agentId)?.status !== "running") return null;
  const items = store.transcript(agentId);
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!;
    if (item.kind !== "tool") continue;
    const text = waitingText(item, store);
    if (text === null) return null;
    const n = SPINNER_FRAMES.length;
    const spin = SPINNER_FRAMES[((spinnerFrame % n) + n) % n]!;
    return fitLine([span(`${spin} ${text}  `), span(formatDuration(now - item.at), GREY)], width);
  }
  return null;
}

type RowOptions = Pick<AgentContentOptions, "width" | "expanded"> & Partial<AgentContentOptions>;

function allRows(store: StoreView, agentId: string, options: RowOptions): Line[] {
  const width = Math.max(1, Math.floor(options.width));
  const rows = staticRows(store, agentId, options.expanded, width);
  const waiting = waitingRow(store, agentId, width, options.now ?? 0, options.spinnerFrame ?? 0);
  return waiting ? [...rows, waiting] : rows;
}

/**
 * 全部行（折好行），按过程记录的顺序：
 * - 任务说明：灰色，开头加“任务：”；收起时只显示前 TASK_PREVIEW_ROWS（2）个原有的行，每行占一行、放不下的末尾加 "…"，
 *   还有更多行时第二行末尾写“（还有 N 行，按 e 展开）”；展开时全文按宽度折行；后面空一行。
 * - say：默认色，按宽度折行（汉字不切半）。think：只在展开时显示，灰色，开头加“思考：”。
 * - tool：灰色一行（超宽时末尾 “…”），文字是 toolLineText(toolLine(item, store))；失败的工具调用后面加红色“  失败”；
 *   展开时下面缩进 2 格灰色显示结果，最多 TOOL_RESULT_ROWS 行。
 * - message：from 为 "you" 时粗体、以 "› " 开头；其他来源灰色，以“<fromName>：”开头。
 * - resume、end：不单独成行；失败的 end 写一行红色“失败：<error>”。
 * - 子 agent 在跑、最后一条工具调用还在进行且 waitingText 不为 null 时，末尾加一行：转动符号、空格、文字、两个空格、灰色用时。
 * 加了 options.search 时命中的文字高亮。每一行都不超过 options.width 列。
 */
export function agentContentLines(store: StoreView, agentId: string, options: AgentContentOptions): Line[] {
  const rows = allRows(store, agentId, options);
  return options.search ? highlightRows(rows, options.search, 0) : rows;
}

type WindowOptions = AgentContentOptions & { rows: number; scroll: number; scrollTotal?: number | null };

interface Located {
  /** 窗口底下精确还有几行。 */
  below: number;
  /** 其中翻看之后新来的几行。 */
  fresh: number;
  /** 总行数（和 agentRowCount 同一个口径）；locate 的 withTotal 为 false 又没有在跟踪翻看时不算，是 0。 */
  total: number;
  /** 窗口里的行，不够 rows 行时不补空行。 */
  lines: Line[];
}

/**
 * 从最后一行往前排，排够 below + rows 行就停：画一帧只排看得见的那几条，不管记录多长。
 * 翻看之后新来的行数（growth）按总行数的差算，再数出这些行精确是几行（总行数里估算过的老条目不会再变，所以差只来自新来的条目）。
 * 一直排到了最前面还不够，就停在最前面：翻到顶时是精确的。
 */
function locate(store: StoreView, agentId: string, options: WindowOptions, withTotal: boolean): Located {
  const width = Math.max(1, Math.floor(options.width));
  const rows = Math.max(0, Math.floor(options.rows));
  const expanded = options.expanded;
  const items = store.transcript(agentId);
  const waiting = waitingRow(store, agentId, width, options.now, options.spinnerFrame);
  const fold = foldOf(store, agentId);
  const want = Math.max(0, Math.floor(options.scroll) || 0);
  // 贴底、没有翻看过的时候用不着总行数，也就不用建排版（建排版要把每条都估一遍）
  const tracking = want > 0 && options.scrollTotal != null;
  const layout = tracking || withTotal ? layoutFor(store, agentId, expanded, width, items) : null;
  const total = layout ? layout.total(items, store, expanded, width) + (waiting ? 1 : 0) : 0;
  const growth = tracking ? Math.max(0, total - options.scrollTotal!) : 0;

  const chunks: Line[][] = [];
  let exactRows = 0;
  let totalRows = 0;
  let freshRows = growth === 0 ? 0 : -1;
  if (waiting) {
    chunks.push([waiting]);
    exactRows = totalRows = 1;
  }
  if (freshRows < 0 && totalRows >= growth) freshRows = exactRows;
  let i = items.length - 1;
  for (; i >= 0; i--) {
    if (freshRows >= 0 && exactRows >= want + freshRows + rows) break;
    const item = items[i]!;
    const itemRows = rowsOfItem(item, store, expanded, width, fold);
    chunks.push(itemRows);
    exactRows += itemRows.length;
    if (layout) totalRows += layout.rowsInTotal(item, i, store, expanded, width);
    if (freshRows < 0 && totalRows >= growth) freshRows = exactRows;
  }
  if (freshRows < 0) freshRows = exactRows;
  let below = want > 0 ? want + freshRows : 0;
  if (i < 0 && exactRows - rows < below) below = Math.max(0, exactRows - rows);
  const all = chunks.reverse().flat();
  const start = Math.max(0, exactRows - below - rows);
  return { below, fresh: want > 0 ? Math.min(below, freshRows) : 0, total, lines: all.slice(start, start + rows) };
}

/**
 * 内容区恰好 rows 行：贴底时显示最后 rows 行，内容不够时从上往下排、下面补空行；scroll 大于 0 时往上翻 scroll 行（夹在合法范围内）。
 * scrollTotal 是翻看那一刻的总行数（AppState.scrollTotal）：翻看之后新来的行不会把窗口顶走，数量写在返回的 scroll.fresh 里。
 * 只排看得见的那几条（记录有 1 万条，第一帧也在 16 毫秒内）；加了 options.search 时要知道窗口第一行是全部行里的第几行，才多排一遍全部。
 */
export function agentContentWindow(store: StoreView, agentId: string, options: WindowOptions): ContentWindow {
  const rows = Math.max(0, Math.floor(options.rows));
  const found = locate(store, agentId, options, false);
  let lines = found.lines;
  if (options.search && options.search.query !== "") {
    const exactTotal = agentRowCountExact(store, agentId, options);
    lines = highlightRows(lines, options.search, Math.max(0, exactTotal - found.below - rows));
  }
  return { lines: padRows(lines, rows), scroll: { below: found.below, fresh: found.fresh } };
}

/**
 * 全部行数（含“正在等”那一行），翻看用：记录不长时是精确的；很长时（见 Layout）是估算的，但前后两次的差是新来的行数。
 * 记录翻看那一刻的 AppState.scrollTotal 用它。算翻看的上限用 agentRowCountExact。
 */
export function agentRowCount(store: StoreView, agentId: string, options: Pick<AgentContentOptions, "width" | "expanded"> & Partial<AgentContentOptions>): number {
  const width = Math.max(1, Math.floor(options.width));
  const items = store.transcript(agentId);
  const layout = layoutFor(store, agentId, options.expanded, width, items);
  const waiting = waitingRow(store, agentId, width, options.now ?? 0, options.spinnerFrame ?? 0);
  return layout.total(items, store, options.expanded, width) + (waiting ? 1 : 0);
}

/** 精确的全部行数。记录很长时要把每条都折一遍，贵：只在翻到快到顶、搜索时用，这样翻到顶是准的。 */
export function agentRowCountExact(store: StoreView, agentId: string, options: Pick<AgentContentOptions, "width" | "expanded"> & Partial<AgentContentOptions>): number {
  return allRows(store, agentId, options).length;
}

/** 翻看的位置：窗口底下现在精确还有几行（翻看之后来了新内容时比 scroll 多），和总行数。状态机算下一次翻到哪里用。 */
export function agentScrollPosition(store: StoreView, agentId: string, options: WindowOptions): { below: number; total: number } {
  const { below, total } = locate(store, agentId, options, true);
  return { below, total };
}

/** 选中条目的全文（纯文字），给 y（复制）、o（less）和 /（搜索）用：展开状态下的全部内容，不折行，不含“正在等”那一行。 */
export function agentPlainText(store: StoreView, agentId: string, state: AppState): string {
  void state;
  const rows = store.transcript(agentId).flatMap((item) => itemRows(item, store, true, Number.POSITIVE_INFINITY, splitLines));
  return rows
    .map((row) => row.map((s) => s.text).join(""))
    .join("\n")
    .trimEnd();
}
