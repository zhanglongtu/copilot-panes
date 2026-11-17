// 文本输入框：纯状态机，按键进，文字和光标位置出。给子 agent 发消息和 / 搜索都用它。
// 要支持中文、粘贴、光标左右移动、删除、多行（Ctrl+J 或 Alt+Enter 换行，最多显示 INPUT_MAX_ROWS 行）。

import type { KeyEvent, PasteEvent, TextInputState } from "../types/ui.ts";
import { CellMeter, graphemes, meterAfter, textWidth } from "./width.ts";

export function emptyInput(): TextInputState {
  return { text: "", cursor: 0 };
}

export interface InputResult {
  state: TextInputState;
  /** 按了 Enter 且文字去掉首尾空白后非空：要发送的文字（原文，不去空白）。输入框不清空，由调用方决定（发出去后清空，失败时保留）。 */
  submit: string | null;
  /** 这个按键输入框用掉了。没用掉的（Esc、Tab、PgUp、PgDn、Ctrl+C、在第一行按上、在最后一行按下等）由调用方处理。 */
  handled: boolean;
}

const used = (state: TextInputState): InputResult => ({ state, submit: null, handled: true });
const unused = (state: TextInputState): InputResult => ({ state, submit: null, handled: false });

/** text 里所有字素边界的 UTF-16 下标，含 0 和 text.length。 */
function boundaries(text: string): number[] {
  const out = [0];
  let at = 0;
  for (const g of graphemes(text)) {
    at += g.length;
    out.push(at);
  }
  return out;
}

/** 把下标挪到下一个字素边界（已经在边界上就不动），并限制在 0 到 text.length 之间。 */
function snap(text: string, index: number): number {
  const at = Math.max(0, Math.min(text.length, index));
  return boundaries(text).find((b) => b >= at) ?? text.length;
}

const lineStartOf = (text: string, at: number) => (at <= 0 ? 0 : text.lastIndexOf("\n", at - 1) + 1);
const lineEndOf = (text: string, at: number) => {
  const i = text.indexOf("\n", at);
  return i < 0 ? text.length : i;
};

/** 把 [from, to) 换成 insert，光标放在插入内容之后。 */
function replace(state: TextInputState, from: number, to: number, insert = ""): TextInputState {
  const text = state.text.slice(0, from) + insert + state.text.slice(to);
  return { text, cursor: snap(text, from + insert.length) };
}

/** 粘贴的文字：\r\n 和 \r 换成 \n，制表符换成 4 个空格，其他控制字符去掉。 */
function cleanPaste(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, "    ")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, "");
}

let wordSegmenter: Intl.Segmenter | undefined;

/** 光标前一个词的起点（同一行内）：先跳过空白，再取一个词（中文按词典分词，所以“删一个词”不会删掉整句）。 */
function wordStart(text: string, cursor: number): number {
  const start = lineStartOf(text, cursor);
  wordSegmenter ??= new Intl.Segmenter(undefined, { granularity: "word" });
  let result = start;
  for (const s of wordSegmenter.segment(text.slice(start, cursor))) {
    if (s.segment.trim() !== "") result = start + s.index;
  }
  return result;
}

/** 把光标移到 text 里 from 到 to 这一行上显示列最接近 column（不超过）的字素边界。 */
function columnIn(text: string, from: number, to: number, column: number): number {
  let meter = new CellMeter();
  let at = from;
  for (const g of graphemes(text.slice(from, to))) {
    meter = meterAfter(meter, g);
    if (meter.width > column) break;
    at += g.length;
  }
  return at;
}

/**
 * 处理一个按键或一次粘贴：
 * - 可打印字符（没有 Ctrl、Alt）：在光标处插入。粘贴：插入整段，\r\n 和 \r 换成 \n，制表符换成 4 个空格，其他控制字符去掉。
 * - Ctrl+J、Alt+Enter（和 Shift+Enter）：插入换行。Enter：submit（文字非空白时）。
 * - 左、右：按字素移动一格；Home、End、Ctrl+A、Ctrl+E：到当前行的行首、行尾（Ctrl+Home、Ctrl+End：全文的开头、结尾）；
 *   上、下：到上一行、下一行（按换行符分的行）的同一列附近，已经在第一行或最后一行时不处理。
 * - Backspace、Delete：删光标前、后一个字素；Ctrl+U：删到行首；Ctrl+K：删到行尾；Ctrl+W、Alt+Backspace：删光标前一个词
 *   （光标在行首时删掉前面的换行）。
 */
export function applyInput(state: TextInputState, event: KeyEvent | PasteEvent): InputResult {
  const text = state.text;
  const cursor = snap(text, state.cursor);
  const at: TextInputState = cursor === state.cursor ? state : { text, cursor };

  if (event.type === "paste") {
    const clean = cleanPaste(event.text);
    return used(clean === "" ? at : replace(at, cursor, cursor, clean));
  }

  const lineStart = lineStartOf(text, cursor);
  const lineEnd = lineEndOf(text, cursor);
  const edges = () => boundaries(text);

  if (event.key === "char") {
    if (event.ctrl && !event.alt) {
      switch (event.text.toLowerCase()) {
        case "j":
          return used(replace(at, cursor, cursor, "\n"));
        case "u":
          return used(replace(at, lineStart, cursor));
        case "k":
          return used(replace(at, cursor, lineEnd));
        case "w":
          return used(cursor === lineStart ? (cursor > 0 ? replace(at, cursor - 1, cursor) : at) : replace(at, wordStart(text, cursor), cursor));
        case "a":
          return used({ text, cursor: lineStart });
        case "e":
          return used({ text, cursor: lineEnd });
        default:
          return unused(at);
      }
    }
    if (event.ctrl || event.alt) return unused(at);
    const clean = cleanPaste(event.text);
    return used(clean === "" ? at : replace(at, cursor, cursor, clean));
  }

  switch (event.key) {
    case "enter":
      if (event.alt || event.shift) return used(replace(at, cursor, cursor, "\n"));
      return { state: at, submit: text.trim() === "" ? null : text, handled: true };
    case "left":
      return used({ text, cursor: [...edges()].reverse().find((b) => b < cursor) ?? 0 });
    case "right":
      return used({ text, cursor: edges().find((b) => b > cursor) ?? text.length });
    case "home":
      return used({ text, cursor: event.ctrl ? 0 : lineStart });
    case "end":
      return used({ text, cursor: event.ctrl ? text.length : lineEnd });
    case "up": {
      if (lineStart === 0) return unused(at);
      const column = textWidth(text.slice(lineStart, cursor));
      return used({ text, cursor: columnIn(text, lineStartOf(text, lineStart - 1), lineStart - 1, column) });
    }
    case "down": {
      if (lineEnd >= text.length) return unused(at);
      const column = textWidth(text.slice(lineStart, cursor));
      return used({ text, cursor: columnIn(text, lineEnd + 1, lineEndOf(text, lineEnd + 1), column) });
    }
    case "backspace": {
      if (event.alt) return used(cursor === lineStart ? (cursor > 0 ? replace(at, cursor - 1, cursor) : at) : replace(at, wordStart(text, cursor), cursor));
      const previous = [...edges()].reverse().find((b) => b < cursor);
      return used(previous === undefined ? at : replace(at, previous, cursor));
    }
    case "delete": {
      const next = edges().find((b) => b > cursor);
      return used(next === undefined ? at : replace(at, cursor, next));
    }
    default:
      return unused(at);
  }
}

export interface InputLayout {
  /** 要显示的行（已按 width 折行），最多 maxRows 行；超出时取包含光标的那一段。 */
  rows: string[];
  /** 光标在 rows 里的第几行、第几列（显示列）。 */
  cursorRow: number;
  cursorCol: number;
}

/**
 * 排版：每个逻辑行按 width 列折行（按字素硬折，汉字 2 列），光标落在折行后的位置。光标正好在一行末尾且该行占满 width 时，
 * 光标放到下一行行首。空输入得一行空串、光标在 (0, 0)。
 * 超过 maxRows 行时显示以光标所在行为最后一行的那一段（光标在开头附近时从第一行显示）。
 */
export function layoutInput(state: TextInputState, width: number, maxRows: number): InputLayout {
  const w = Math.max(1, Math.floor(width));
  const max = Math.max(1, Math.floor(maxRows));
  const cursor = snap(state.text, state.cursor);
  const rows: string[] = [];
  let cursorRow = 0;
  let cursorCol = 0;

  let offset = 0;
  for (const line of state.text.split("\n")) {
    const firstRow = rows.length;
    const starts: number[] = [];
    let current = "";
    let meter = new CellMeter();
    let pos = 0;
    starts.push(0);
    for (const g of graphemes(line)) {
      let next = meterAfter(meter, g);
      if (next.width > w && current !== "") {
        rows.push(current);
        starts.push(pos);
        current = "";
        next = meterAfter(new CellMeter(), g);
      }
      current += g;
      meter = next;
      pos += g.length;
    }
    rows.push(current);

    if (cursor >= offset && cursor <= offset + line.length) {
      const local = cursor - offset;
      let r = starts.length - 1;
      while (r > 0 && starts[r]! > local) r--;
      cursorRow = firstRow + r;
      cursorCol = textWidth(rows[cursorRow]!.slice(0, local - starts[r]!));
      if (local === line.length && cursorCol >= w) {
        rows.push("");
        cursorRow = rows.length - 1;
        cursorCol = 0;
      }
    }
    offset += line.length + 1;
  }

  if (rows.length <= max) return { rows, cursorRow, cursorCol };
  const top = Math.max(0, Math.min(rows.length - max, cursorRow - max + 1));
  return { rows: rows.slice(top, top + max), cursorRow: cursorRow - top, cursorCol };
}
