// 最后一行：按键提示。键名二档，说明三档，各项之间两个空格；写成“按这个键会做什么”，模式开关（跟随最新、收起已结束的）也放在这里。
// 放不下时从右边开始去掉，名单里的 “? 帮助” 最后去掉。

import type { AppState } from "../../types/app.ts";
import { isEnded, type ListEntry } from "../../types/model.ts";
import type { ColorRole, Line, Span } from "../../types/ui.ts";
import { fitLine, lineWidth, span } from "../line.ts";

/** 一项提示：键名和这个键做什么。 */
export type Hint = readonly [key: string, does: string];

export const HINTS_AGENT: readonly Hint[] = [["Enter", "发送"], ["Esc", "回名单"], ["PgUp", "翻看"]];
export const HINTS_COMMAND: readonly Hint[] = [["Ctrl+C", "中断"], ["Esc", "回名单"], ["PgUp", "翻看"]];
/** 不能发消息、不能中断时：去掉用不了的那一项。 */
export const HINTS_CONTENT_LIMITED: readonly Hint[] = [["Esc", "回名单"], ["PgUp", "翻看"]];
export const HINT_HELP: Hint = ["?", "帮助"];
export const HINTS_HELP_OVERLAY: readonly Hint[] = [["Esc 或 ?", "关闭"]];
export const HINTS_SESSIONS_OVERLAY: readonly Hint[] = [["↑↓", "选择"], ["Enter", "切换"], ["Esc", "取消"]];
export const HINTS_SEARCH: readonly Hint[] = [["Enter", "搜索"], ["Esc", "取消"]];

export interface KeysOptions {
  /** 扩展没连上：x、发消息都不可用，提示里不写。 */
  readOnly?: boolean;
  /** 提示行上方有没有显示 Notice 的那一行；没有（pane 太矮）时，Notice 改写在这一行。默认 true。 */
  noticeVisible?: boolean;
  /** 名单里有已结束的条目：没收起时才有“c 收起已结束的”这一项。默认 false。 */
  hasEnded?: boolean;
}

/** 名单的提示：↑↓ 选择、Enter 进入、x 停止、z 放大；没在跟随最新时加“f 跟随最新任务”；收起了已结束的加“c 显示已结束的”，没收起而且有已结束的加“c 收起已结束的”；最后是“? 帮助”。 */
export function listHints(state: Pick<AppState, "followLatest" | "collapseEnded">, options: Pick<KeysOptions, "readOnly" | "hasEnded"> = {}): Hint[] {
  const hints: Hint[] = [["↑↓", "选择"], ["Enter", "进入"]];
  if (options.readOnly !== true) hints.push(["x", "停止"]);
  hints.push(["z", "放大"]);
  if (!state.followLatest) hints.push(["f", "跟随最新任务"]);
  if (state.collapseEnded) hints.push(["c", "显示已结束的"]);
  else if (options.hasEnded === true) hints.push(["c", "收起已结束的"]);
  hints.push(HINT_HELP);
  return hints;
}

function hintSpans(hints: readonly Hint[]): Span[] {
  const out: Span[] = [];
  hints.forEach(([key, does], i) => {
    if (i > 0) out.push(span("  "));
    out.push(span(key, { fg: "text2" }), span(" "), span(does, { fg: "grey" }));
  });
  return out;
}

/** 放得下就全写；放不下从右边开始去掉，pinLast 时最后一项（? 帮助）留到最后才去掉。 */
export function fitHints(hints: readonly Hint[], cols: number, pinLast = false): Line {
  const list = hints.slice();
  while (list.length > 1 && lineWidth(hintSpans(list)) > cols) list.splice(pinLast ? list.length - 2 : list.length - 1, 1);
  return fitLine(hintSpans(list), cols);
}

/**
 * 焦点在名单用 listHints；焦点在内容区按选中条目的种类用 HINTS_AGENT 或 HINTS_COMMAND。名单里第一次按 x 之后写“再按一次 x 停止 <名字>”，
 * 第一次按 Ctrl+C 之后写“再按一次 Ctrl+C 退出”（都用橙色，到期后恢复）。截到 cols 列。
 * 优先级：停止确认、退出确认、（Notice 没有地方显示时的）Notice、盖在上面的帮助或 session 列表、搜索词输入、各焦点的提示。
 * 已结束的子 agent、只读时的子 agent 没有输入框，已结束的命令不能再中断，这几种情况不写 Enter 发送、Ctrl+C 中断。
 */
export function renderKeysLine(state: AppState, entry: ListEntry | null, now: number, cols: number, options: KeysOptions = {}): Line {
  const { readOnly = false, noticeVisible = true, hasEnded = false } = options;
  const plain = (text: string, color: ColorRole): Line => fitLine([span(text, { fg: color })], cols);

  if (state.confirmStop !== null && now < state.confirmStop.until && entry !== null && entry.key === state.confirmStop.key) {
    return plain(`再按一次 x 停止 ${entry.name}`, "orange");
  }
  if (state.quitArmedUntil !== null && now < state.quitArmedUntil) return plain("再按一次 Ctrl+C 退出", "orange");
  if (!noticeVisible && state.notice !== null && now < state.notice.until) {
    return plain(state.notice.text, state.notice.tone === "error" ? "red" : "grey");
  }
  if (state.overlay === "help") return fitHints(HINTS_HELP_OVERLAY, cols);
  if (state.overlay === "sessions") return fitHints(HINTS_SESSIONS_OVERLAY, cols);
  if (state.search?.editing) return fitHints(HINTS_SEARCH, cols);
  if (state.focus === "list" || entry === null) return fitHints(listHints(state, { readOnly, hasEnded }), cols, true);
  if (entry.kind === "agent") return fitHints(readOnly || isEnded(entry.status) ? HINTS_CONTENT_LIMITED : HINTS_AGENT, cols);
  return fitHints(isEnded(entry.status) ? HINTS_CONTENT_LIMITED : HINTS_COMMAND, cols);
}
