// 按键和粘贴：覆盖层、搜索输入、名单、子 agent 的内容区、命令的内容区各有一套。

import { COLLAPSE_LIST_BELOW_ROWS, CONFIRM_WINDOW_MS, QUIT_WINDOW_MS } from "../constants.ts";
import type { AppContext, AppState, AppUpdate } from "../types/app.ts";
import { isEnded } from "../types/model.ts";
import type { ListEntry } from "../types/model.ts";
import type { KeyEvent, PasteEvent } from "../types/ui.ts";
import { pageSize, scrollView, searchJump, contentTotal } from "./app-content.ts";
import {
  isChar,
  isCtrl,
  isKey,
  isPrintable,
  isReadOnly,
  label,
  makeRequest,
  moveSelection,
  newestKey,
  noop,
  readOnlyCause,
  readOnlyRefusal,
  say,
  selectEntry,
  selectedEntry,
  withNotice,
} from "./app-core.ts";
import { applyInput, emptyInput } from "./textinput.ts";
import { helpWindow } from "./views/help.ts";
import { COMMAND_NO_INPUT_NOTICE, SESSION_ENDED_INPUT_TEXT } from "./views/input.ts";

export function handleKey(state: AppState, e: KeyEvent, ctx: AppContext): AppUpdate {
  if (state.overlay !== "none") return overlayKey(state, e, ctx);

  // 等待第二次按键的 x 和 Ctrl+C，中间按了别的键就作废，免得隔了几个操作之后一次误按就执行。
  let s = state;
  if (s.confirmStop !== null && !isChar(e, "x")) s = { ...s, confirmStop: null };
  if (s.quitArmedUntil !== null && !isCtrl(e, "c")) s = { ...s, quitArmedUntil: null };

  if (s.search?.editing) return searchEditKey(s, e, ctx);
  const entry = selectedEntry(s, ctx);
  if (s.focus === "content" && entry !== null) {
    return entry.kind === "agent" ? agentKey(s, e, ctx, entry) : commandKey(s, e, ctx, entry);
  }
  return listKey(s, e, ctx);
}

export function handlePaste(state: AppState, e: PasteEvent, ctx: AppContext): AppUpdate {
  if (state.overlay !== "none") return noop(state);
  if (state.search?.editing) {
    const r = applyInput(state.search.query, e);
    return noop({ ...state, search: { ...state.search, query: r.state } });
  }
  const entry = selectedEntry(state, ctx);
  if (state.focus !== "content" || entry === null) return noop(state);
  if (entry.kind === "command") return say(state, ctx, COMMAND_NO_INPUT_NOTICE);
  const blocked = inputBlockedNotice(entry, ctx, "没粘贴进去");
  if (blocked !== null) return say(state, ctx, blocked);
  return noop(editDraft(state, entry, applyInput(state.drafts.get(entry.key) ?? emptyInput(), e).state));
}

// ───── 覆盖层 ─────

function overlayKey(state: AppState, e: KeyEvent, ctx: AppContext): AppUpdate {
  const closes =
    isKey(e, "escape") || isChar(e, "q") || isCtrl(e, "c") || isChar(e, state.overlay === "help" ? "?" : "s");
  if (closes) return noop({ ...state, overlay: "none" });
  if (state.overlay === "help") return noop(scrollHelp(state, ctx, e));

  const sessions = ctx.data.sessions;
  // 最后一项（sessions.length）是“恢复自动选择”。
  const last = sessions.length;
  const at = state.pickerIndex;
  const go = (index: number) => noop({ ...state, pickerIndex: Math.max(0, Math.min(last, index)) });
  if (isKey(e, "up") || isChar(e, "k")) return go(at - 1);
  if (isKey(e, "down") || isChar(e, "j")) return go(at + 1);
  if (isKey(e, "home") || isChar(e, "g")) return go(0);
  if (isKey(e, "end") || isChar(e, "G")) return go(last);
  if (isKey(e, "enter")) {
    const closed: AppState = { ...state, overlay: "none" };
    const chosen = sessions[at];
    return { state: closed, effects: [chosen ? { type: "pinSession", sessionId: chosen.sessionId } : { type: "unpinSession" }] };
  }
  return noop(state);
}

/** 帮助放不下时翻看：↑↓（j k）一行，PgUp PgDn 一页，Home End（g G）到头到尾。 */
function scrollHelp(state: AppState, ctx: AppContext, e: KeyEvent): AppState {
  const area = Math.max(0, ctx.size.rows - 2);
  const shown = helpWindow(ctx.data.extension.kind === "readonly", ctx.size.cols, area, state.helpScroll ?? 0);
  if (!shown.scrollable) return state;
  const page = Math.max(1, area - 2);
  let to: number;
  if (isKey(e, "up") || isChar(e, "k")) to = shown.scroll - 1;
  else if (isKey(e, "down") || isChar(e, "j")) to = shown.scroll + 1;
  else if (isKey(e, "pageup")) to = shown.scroll - page;
  else if (isKey(e, "pagedown")) to = shown.scroll + page;
  else if (isKey(e, "home") || isChar(e, "g")) to = 0;
  else if (isKey(e, "end") || isChar(e, "G")) to = shown.maxScroll;
  else return state;
  const next = Math.max(0, Math.min(shown.maxScroll, to));
  return next === (state.helpScroll ?? 0) ? state : { ...state, helpScroll: next };
}

// ───── 搜索词输入 ─────

function searchEditKey(state: AppState, e: KeyEvent, ctx: AppContext): AppUpdate {
  const search = state.search!;
  if (isKey(e, "escape") || isCtrl(e, "c")) return noop({ ...state, search: null });
  if (e.key === "enter" && (e.alt || e.shift)) return noop(state);
  const r = applyInput(search.query, e);
  const typed: AppState = { ...state, search: { ...search, query: r.state } };
  const entry = selectedEntry(state, ctx);
  if (r.submit !== null && entry !== null) return searchJump(typed, ctx, entry, "first");
  if (e.key === "enter") return noop({ ...state, search: null });
  return noop(r.handled ? typed : state);
}

function startSearch(state: AppState, entry: ListEntry | null): AppUpdate {
  if (entry === null) return noop(state);
  return noop({ ...state, search: { query: emptyInput(), editing: true, index: 0 } });
}

function nextMatch(state: AppState, ctx: AppContext, entry: ListEntry, step: "next" | "prev"): AppUpdate {
  if (state.search === null) return say(state, ctx, "先按 / 输入要搜索的词");
  return searchJump(state, ctx, entry, step);
}

/** 名单和命令内容区共用的几个键：/ n N y o e。不是这几个键返回 null。 */
function sharedKey(state: AppState, e: KeyEvent, ctx: AppContext, entry: ListEntry | null): AppUpdate | null {
  if (entry === null || e.key !== "char" || e.ctrl || e.alt) return null;
  switch (e.text) {
    case "/":
      return startSearch(state, entry);
    case "n":
      return nextMatch(state, ctx, entry, "next");
    case "N":
      return nextMatch(state, ctx, entry, "prev");
    case "y":
      return {
        state: withNotice(state, ctx, `已复制 ${label(entry)} 的内容到 tmux 缓冲区`),
        effects: [{ type: "copy", entryKey: entry.key }],
      };
    case "o":
      return { state, effects: [{ type: "pager", entryKey: entry.key }] };
    case "e": {
      const expanded = new Set(state.expanded);
      if (!expanded.delete(entry.key)) expanded.add(entry.key);
      const toggled: AppState = { ...state, expanded };
      // 命令的原文放在输出最上面：展开时翻到最上面，不然输出一长就看不见它
      if (entry.kind === "command" && expanded.has(entry.key)) return noop(scrollView(toggled, ctx, entry, { to: Number.POSITIVE_INFINITY }));
      // 行数变了，翻看的基准跟着换，画面才不会把多出来的行当成新内容；命令收起后少了几行，翻看的位置也要夹回去。
      const rebased = toggled.scroll > 0 ? { ...toggled, scrollTotal: contentTotal(entry, toggled, ctx) } : toggled;
      return noop(rebased.scroll > 0 && entry.kind === "command" ? scrollView(rebased, ctx, entry, { by: 0 }) : rebased);
    }
    default:
      return null;
  }
}

// ───── 名单 ─────

function listKey(state: AppState, e: KeyEvent, ctx: AppContext): AppUpdate {
  const entry = selectedEntry(state, ctx);
  const shared = sharedKey(state, e, ctx, entry);
  if (shared !== null) return shared;

  if (isCtrl(e, "c")) return ctrlCInList(state, ctx);
  if (e.ctrl || e.alt) return noop(state);

  if (e.key === "char") {
    switch (e.text) {
      case "k":
        return noop(moveSelection(state, ctx, { by: -1 }));
      case "j":
        return noop(moveSelection(state, ctx, { by: 1 }));
      case "g":
        return noop(moveSelection(state, ctx, { index: 0 }));
      case "G":
        return noop(moveSelection(state, ctx, { index: Number.MAX_SAFE_INTEGER }));
      case "x":
        return stopKey(state, ctx, entry);
      case "b":
        return backgroundKey(state, ctx, entry);
      case "c":
        return collapseKey(state);
      case "f":
        return followKey(state, ctx);
      case "z": {
        const next = { ...state, zoom: !state.zoom };
        return ctx.size.rows < COLLAPSE_LIST_BELOW_ROWS ? say(next, ctx, "pane 太矮，名单已经自动收成一行") : noop(next);
      }
      case "s":
        return openSessions(state, ctx);
      case "?":
        return ctx.data.session === null ? noop(state) : noop({ ...state, overlay: "help", helpScroll: 0 });
      case "q":
        return { state, effects: [{ type: "quit" }] };
      default:
        return noop(state);
    }
  }

  switch (e.key) {
    case "up":
      return noop(moveSelection(state, ctx, { by: -1 }));
    case "down":
      return noop(moveSelection(state, ctx, { by: 1 }));
    case "home":
      return noop(moveSelection(state, ctx, { index: 0 }));
    case "end":
      return noop(moveSelection(state, ctx, { index: Number.MAX_SAFE_INTEGER }));
    case "enter":
    case "right":
    case "tab":
      return entry === null ? noop(state) : noop({ ...state, focus: "content" });
    case "pageup":
      return entry === null ? noop(state) : noop(scrollView(state, ctx, entry, { by: pageSize(state, ctx) }));
    case "pagedown":
      return entry === null ? noop(state) : noop(scrollView(state, ctx, entry, { by: -pageSize(state, ctx) }));
    case "escape":
      return state.search === null ? noop(state) : noop({ ...state, search: null });
    default:
      return noop(state);
  }
}

function ctrlCInList(state: AppState, ctx: AppContext): AppUpdate {
  if (state.quitArmedUntil !== null && state.quitArmedUntil > ctx.now) {
    return { state: { ...state, quitArmedUntil: null }, effects: [{ type: "quit" }] };
  }
  return noop({ ...state, quitArmedUntil: ctx.now + QUIT_WINDOW_MS });
}

/** x：第一次只记下并等第二次，CONFIRM_WINDOW_MS 内对同一条再按才发 cancel。只有在跑的、对得上任务的才能停。 */
function stopKey(state: AppState, ctx: AppContext, entry: ListEntry | null): AppUpdate {
  if (entry === null) return noop(state);
  if (isReadOnly(ctx)) return say(state, ctx, readOnlyRefusal(ctx, "停止"), "error");
  if (entry.status !== "running") return say(state, ctx, `没停掉：${label(entry)} 不在跑了`, "error");
  if (entry.task === null) return say(state, ctx, "没停掉：对应不上 Copilot CLI 里的任务（扩展没有回应，或这条对不上任务）", "error");
  const armed = state.confirmStop;
  if (armed !== null && armed.key === entry.key && armed.until > ctx.now) {
    return makeRequest({ ...state, confirmStop: null }, { op: "cancel", taskId: entry.task.id }, entry);
  }
  return noop({ ...state, confirmStop: { key: entry.key, until: ctx.now + CONFIRM_WINDOW_MS } });
}

function backgroundKey(state: AppState, ctx: AppContext, entry: ListEntry | null): AppUpdate {
  if (entry === null) return noop(state);
  if (isReadOnly(ctx)) return say(state, ctx, readOnlyRefusal(ctx, "转后台"), "error");
  if (entry.status !== "running") return say(state, ctx, `没转后台：${label(entry)} 不在跑了`, "error");
  if (entry.task === null) return say(state, ctx, "没转后台：对应不上 Copilot CLI 里的任务（扩展没有回应，或这条对不上任务）", "error");
  if (!entry.task.canPromoteToBackground) return say(state, ctx, `没转后台：${label(entry)} 不能转后台（只有前台跑着的命令可以）`, "error");
  return makeRequest(state, { op: "promoteToBackground", taskId: entry.task.id }, entry);
}

function followKey(state: AppState, ctx: AppContext): AppUpdate {
  if (state.followLatest) return say({ ...state, followLatest: false }, ctx, "不再自动选中新任务，按 f 恢复");
  const newest = newestKey(ctx.data.entries);
  const selected = newest === null ? state : selectEntry(state, newest);
  return say({ ...selected, followLatest: true }, ctx, "有新任务时自动选中它");
}

/** c：收起或显示已结束的条目。不弹提示：名单最后一行自己写着“收起了 N 个已结束的，按 c 显示”。 */
function collapseKey(state: AppState): AppUpdate {
  return noop({ ...state, collapseEnded: !state.collapseEnded });
}

function openSessions(state: AppState, ctx: AppContext): AppUpdate {
  if (ctx.data.session === null) return noop(state);
  const current = ctx.data.sessions.findIndex((s) => s.current);
  return noop({ ...state, overlay: "sessions", pickerIndex: Math.max(0, current) });
}

// ───── 子 agent 的内容区 ─────

/**
 * 不能往输入框写字的原因，写成提示行的话：“没发出去：…”。能写返回 null。
 * 输入行（views/input.ts）已经写着同一个原因，所以这里换一种说法，免得上下两行一模一样。
 */
function inputBlockedNotice(entry: ListEntry, ctx: AppContext, verb: "没发出去" | "没输入进去" | "没粘贴进去"): string | null {
  if (entry.orphaned === true) return `${verb}：这个 session 已经结束`;
  if (isReadOnly(ctx)) return `${verb}：只读，${readOnlyCause(ctx)}`;
  if (isEnded(entry.status)) return `${verb}：${label(entry)} 已经结束`;
  return null;
}

/** 写回这个条目的草稿；空了就删掉。 */
function editDraft(state: AppState, entry: ListEntry, draft: { text: string; cursor: number }): AppState {
  const drafts = new Map(state.drafts);
  if (draft.text === "") drafts.delete(entry.key);
  else drafts.set(entry.key, draft);
  return { ...state, drafts };
}

function agentKey(state: AppState, e: KeyEvent, ctx: AppContext, entry: ListEntry): AppUpdate {
  const draft = state.drafts.get(entry.key) ?? emptyInput();
  if (isCtrl(e, "c")) {
    return draft.text === "" ? say(state, ctx, "按 Esc 回名单") : noop(editDraft(state, entry, emptyInput()));
  }
  if (isKey(e, "escape")) return noop(state.search === null ? { ...state, focus: "list" } : { ...state, search: null });
  if (isKey(e, "pageup")) return noop(scrollView(state, ctx, entry, { by: pageSize(state, ctx) }));
  if (isKey(e, "pagedown")) return noop(scrollView(state, ctx, entry, { by: -pageSize(state, ctx) }));
  // 输入框是空的时候 Home、End 没有光标可移，借来跳到记录的最前面、最后面
  if (draft.text === "" && isKey(e, "home")) return noop(scrollView(state, ctx, entry, { to: Number.POSITIVE_INFINITY }));
  if (draft.text === "" && isKey(e, "end")) return noop(scrollView(state, ctx, entry, { to: 0 }));

  const blocked = inputBlockedNotice(entry, ctx, isKey(e, "enter") ? "没发出去" : "没输入进去");
  if (blocked !== null && (isPrintable(e) || isKey(e, "enter"))) return say(state, ctx, blocked, "error");

  const r = blocked === null ? applyInput(draft, e) : null;
  if (r !== null && r.submit !== null) return sendMessage(state, ctx, entry, r.submit);
  if (r !== null && r.handled) return noop(editDraft(state, entry, r.state));
  // 输入框在第一行按上、在最后一行按下时不处理，借来翻看内容，一次一行。
  if (isKey(e, "up")) return noop(scrollView(state, ctx, entry, { by: 1 }));
  if (isKey(e, "down")) return noop(scrollView(state, ctx, entry, { by: -1 }));
  return noop(state);
}

/** Enter 发送：清空输入框、把这条记成已发出等结果，贴回底部好看到它；对不上任务时留着文字。 */
function sendMessage(state: AppState, ctx: AppContext, entry: ListEntry, text: string): AppUpdate {
  if (entry.task === null) {
    return say(state, ctx, "没发出去：对应不上 Copilot CLI 里的任务（扩展没有回应），文字还在输入框里", "error");
  }
  const cleared = editDraft(state, entry, emptyInput());
  return makeRequest({ ...cleared, scroll: 0, scrollTotal: null }, { op: "sendMessage", taskId: entry.task.id, message: text.trim() }, entry, text);
}

// ───── 命令的内容区 ─────

function commandKey(state: AppState, e: KeyEvent, ctx: AppContext, entry: ListEntry): AppUpdate {
  if (isCtrl(e, "c")) {
    if (entry.orphaned === true) return say(state, ctx, SESSION_ENDED_INPUT_TEXT);
    if (isEnded(entry.status)) return say(state, ctx, "这条命令已经退出了");
    if (isReadOnly(ctx)) return say(state, ctx, readOnlyRefusal(ctx, "中断"), "error");
    return {
      state,
      effects: [{ type: "interrupt", entryKey: entry.key, toolCallId: entry.id, pid: entry.task?.pid ?? null, taskId: entry.task?.id ?? null }],
    };
  }
  if (e.ctrl || e.alt) return noop(state);
  if (isKey(e, "escape")) return noop(state.search === null ? { ...state, focus: "list" } : { ...state, search: null });

  const shared = sharedKey(state, e, ctx, entry);
  if (shared !== null) return shared;

  switch (e.key) {
    case "pageup":
      return noop(scrollView(state, ctx, entry, { by: pageSize(state, ctx) }));
    case "pagedown":
      return noop(scrollView(state, ctx, entry, { by: -pageSize(state, ctx) }));
    case "home":
      return noop(scrollView(state, ctx, entry, { to: Number.POSITIVE_INFINITY }));
    case "end":
      return noop(scrollView(state, ctx, entry, { to: 0 }));
    case "up":
      return noop(scrollView(state, ctx, entry, { by: 1 }));
    case "down":
      return noop(scrollView(state, ctx, entry, { by: -1 }));
    case "char":
    case "enter":
      return say(state, ctx, COMMAND_NO_INPUT_NOTICE);
    default:
      return noop(state);
  }
}
