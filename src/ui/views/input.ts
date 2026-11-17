// 输入行（内容区最下面，多行输入时向上长高）和它上面的提示行。纯函数。

import { INPUT_MAX_ROWS, INTERRUPT_ESCALATE_MS } from "../../constants.ts";
import type { AppState, InterruptSignal } from "../../types/app.ts";
import type { ListEntry } from "../../types/model.ts";
import { isEnded } from "../../types/model.ts";
import type { Cursor, Line, Span } from "../../types/ui.ts";
import { formatDuration } from "../format.ts";
import { fitLine, span } from "../line.ts";
import { layoutInput } from "../textinput.ts";
import { GREY, ORANGE, RED } from "./content.ts";
import type { ScrollInfo } from "./content.ts";

/** 用户在命令的内容区里敲了别的字时的临时提示（状态机把它写进 Notice）。 */
export const COMMAND_NO_INPUT_NOTICE = "这条命令不接受输入，只能中断";
export const SESSION_ENDED_INPUT_TEXT = "这个 session 已经结束";
/** 只读时输入行写“只读，不能发消息：<原因>”；数据里没有给原因（ExtensionState 的 cause）时用这个。 */
export const READONLY_DEFAULT_CAUSE = "扩展没有加载";
export const readOnlySendText = (cause = READONLY_DEFAULT_CAUSE): string => `只读，不能发消息：${cause}`;
export const readOnlyInterruptText = (cause = READONLY_DEFAULT_CAUSE): string => `只读，不能中断：${cause}`;

const VIOLET = { fg: "violet" } as const;
/** 命令被信号结束时的退出码：128 加信号编号（SIGINT、SIGKILL、SIGTERM）。 */
const SIGNAL_EXIT_CODES = new Set([130, 137, 143]);
const PROMPT_WIDTH = 2;

const one = (spans: Span[], width: number): Line => fitLine(spans, width);

/** 发过信号之后的提示：now 已知时写还要等几秒；不知道时不写秒数。 */
function interruptHint(signal: InterruptSignal, sentAt: number, now: number | undefined): string {
  const remaining = now === undefined ? null : INTERRUPT_ESCALATE_MS - Math.max(0, now - sentAt);
  const waiting = remaining === null || remaining > 0;
  const seconds = remaining === null ? "" : `${Math.max(1, Math.ceil(remaining / 1000))} 秒后`;
  switch (signal) {
    case "SIGINT":
      return waiting ? `已发中断信号。${seconds}还在运行的话，再按一次 Ctrl+C 强制结束` : "还在运行，再按一次 Ctrl+C 强制结束";
    case "SIGTERM":
      return waiting ? `已发终止信号。${seconds}还在运行的话，再按一次 Ctrl+C 强杀` : "还在运行，再按一次 Ctrl+C 强杀";
    case "SIGKILL":
      return waiting ? "已发强杀信号，等它退出" : "还在运行，再按一次 Ctrl+C 重发强杀信号";
  }
}

/** 已结束的命令是怎么结束的：被中断（停了、取消了、你按过 Ctrl+C、被信号杀掉），失败（退出码不是 0），还是正常退出。名单的标题行和输入行共用。 */
export function commandOutcome(entry: ListEntry, state: Pick<AppState, "interrupts">): "interrupted" | "failed" | "exited" {
  const code = entry.exitCode;
  const interrupted =
    entry.status === "stopped" || entry.status === "cancelled" || state.interrupts?.has(entry.key) === true || (code !== null && SIGNAL_EXIT_CODES.has(code));
  if (interrupted) return "interrupted";
  return entry.status === "failed" || (code !== null && code !== 0) ? "failed" : "exited";
}

function commandLine(entry: ListEntry, state: AppState, readOnly: boolean, cause: string | undefined, now: number | undefined, width: number): Line {
  if (!isEnded(entry.status)) {
    if (readOnly) return one([span(readOnlyInterruptText(cause), ORANGE)], width);
    const mark = state.interrupts?.get(entry.key);
    return one([span(mark ? interruptHint(mark.signal, mark.at, now) : "Ctrl+C 中断这条命令", GREY)], width);
  }
  const code = entry.exitCode;
  const outcome = commandOutcome(entry, state);
  const interrupted = outcome === "interrupted";
  const failed = outcome === "failed";
  const verb = interrupted ? "已中断" : failed && code === null ? "已失败" : "已退出";
  const took = `用时 ${formatDuration(entry.elapsedMs)}`;
  if (code === null) return one([span(`${verb}，${took}`, failed ? RED : GREY)], width);
  return one([span(`${verb}，`, GREY), span(`退出码 ${code}`, failed ? RED : GREY), span(`，${took}`, GREY)], width);
}

/** 带提示符的输入框：第一行是 prefix 加文字，其余行缩进同样宽。返回行和光标（相对这几行）。 */
function boxLines(prefix: Span, text: { text: string; cursor: number }, width: number): { lines: Line[]; cursor: Cursor } {
  const layout = layoutInput(text, Math.max(1, width - PROMPT_WIDTH), INPUT_MAX_ROWS);
  const lines = layout.rows.map((row, i): Line => {
    if (i === 0) return one([prefix, span(` ${row}`)], width);
    return row === "" ? [] : one([span(`  ${row}`)], width);
  });
  return { lines, cursor: { row: layout.cursorRow, col: Math.min(width - 1, PROMPT_WIDTH + layout.cursorCol) } };
}

/**
 * 输入行的内容（不含行首竖线和空格），以及光标位置（相对这几行；列也不含竖线和空格，画的一方要加 2；null 表示不放光标）。
 * width 是内容宽度（pane 列数减去竖线和一个空格）。每行都不超过 width 列，输入框最多 INPUT_MAX_ROWS 行。
 * - 正在编辑搜索词：“/ ” 加搜索框内容。
 * - session 的进程没了、这条停在半路（orphaned）：灰色“这个 session 已经结束”，没有输入框（子 agent 和命令都一样）。
 * - 子 agent 已结束：灰色“<名字> 已经结束，不能再发消息”，没有输入框。
 * - 只读（readOnly，扩展没连上）：子 agent 没有输入框，橙色“只读，不能发消息：<cause>”；命令在跑时橙色“只读，不能中断：<cause>”。
 *   cause 是 ExtensionState 的 cause（如“这个 session 启动时还没装扩展”），没给时写“扩展没有加载”。
 * - 子 agent 在跑：没打字时是 violet 的 "›" 加灰色“ 插一句话给 <名字>，它做完手上这一步就会看到”（放不下时截断）；
 *   idle：“给 <名字> 发消息，它会接着做”；打了字是 "› " 加输入框内容（按宽度折行，向上长高）。
 * - 命令在跑：灰色“Ctrl+C 中断这条命令”；state.interrupts 里记着发过信号时，按升级规则写“已发中断信号。3 秒后还在运行的话，
 *   再按一次 Ctrl+C 强制结束”和 3 秒后的“还在运行，再按一次 Ctrl+C 强制结束”（now 不给时不写秒数）。
 * - 命令已结束：灰色“已退出，”、红色“退出码 N”、灰色“，用时 <formatDuration>”；被中断的写“已中断，”，退出码不标红。
 * 光标只在焦点在内容区、没有盖着覆盖层、并且有输入框时出现（汉字占 2 列）；其余返回 null。
 */
export function renderInputLines(
  entry: ListEntry | null,
  state: AppState,
  readOnly: boolean,
  width: number,
  now?: number,
  cause?: string,
): { lines: Line[]; cursor: Cursor | null } {
  const w = Math.max(1, Math.floor(width));
  const cursorVisible = state.focus === "content" && state.overlay === "none";
  const result = (lines: Line[], cursor: Cursor) => ({ lines, cursor: cursorVisible ? cursor : null });

  if (state.search?.editing) {
    const box = boxLines(span("/", GREY), state.search.query, w);
    return result(box.lines, box.cursor);
  }
  if (!entry) return { lines: [[]], cursor: null };

  if (entry.orphaned === true) return { lines: [one([span(SESSION_ENDED_INPUT_TEXT, GREY)], w)], cursor: null };
  if (entry.kind === "command") return { lines: [commandLine(entry, state, readOnly, cause, now, w)], cursor: null };

  if (isEnded(entry.status)) return { lines: [one([span(`${entry.name} 已经结束，不能再发消息`, GREY)], w)], cursor: null };
  if (readOnly) return { lines: [one([span(readOnlySendText(cause), ORANGE)], w)], cursor: null };

  const draft = state.drafts.get(entry.key);
  if (!draft || draft.text === "") {
    const hint = entry.status === "running" ? `插一句话给 ${entry.name}，它做完手上这一步就会看到` : `给 ${entry.name} 发消息，它会接着做`;
    return result([one([span("›", VIOLET), span(` ${hint}`, GREY)], w)], { row: 0, col: Math.min(w - 1, PROMPT_WIDTH) });
  }
  const box = boxLines(span("›", VIOLET), draft, w);
  return result(box.lines, box.cursor);
}

/** 搜索结果的一句话：不在编辑搜索词、搜索词不空时用。 */
function searchText(state: AppState): string | null {
  const search = state.search;
  if (!search || search.editing || search.query.text === "") return null;
  const matches = search.matches;
  const found = matches === undefined ? "" : matches === 0 ? "  没有匹配" : `  第 ${Math.min(search.index, matches - 1) + 1}/${matches} 个`;
  return `/ ${search.query.text}${found}`;
}

/**
 * 提示行：有未到期的 Notice 时写它的文字（error 用红色，info 用灰色）；没有时，搜索着就写搜索词和第几个匹配；
 * 再没有，内容区翻到了上面就写灰色“↓ 还有 N 行新内容”（翻看之后有新行）或“↓ 下面还有 N 行”；都没有是空行。
 * scroll 是 agentContentWindow、commandContentWindow 返回的 scroll。
 */
export function renderNoticeLine(state: AppState, now: number, width: number, scroll?: ScrollInfo): Line {
  const w = Math.max(1, Math.floor(width));
  const notice = state.notice;
  if (notice && notice.until > now) return one([span(notice.text, notice.tone === "error" ? RED : GREY)], w);
  const found = searchText(state);
  if (found !== null) return one([span(found, GREY)], w);
  if (scroll && scroll.below > 0) {
    return one([span(scroll.fresh > 0 ? `↓ 还有 ${scroll.fresh} 行新内容` : `↓ 下面还有 ${scroll.below} 行`, GREY)], w);
  }
  return [];
}
