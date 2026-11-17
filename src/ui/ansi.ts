// 样式到转义码，以及输出层要用的各种控制序列。纯函数和常量。

import type { Color, Line, Style, Theme } from "../types/ui.ts";
import { resolveColor } from "./theme.ts";

export const CSI = "\x1b[";

/** 进出备用屏幕、显示和隐藏光标、鼠标（按下、拖动、滚轮，SGR 1006 格式）、括号粘贴。 */
export const SEQ = {
  altScreenOn: "\x1b[?1049h",
  altScreenOff: "\x1b[?1049l",
  cursorHide: "\x1b[?25l",
  cursorShow: "\x1b[?25h",
  mouseOn: "\x1b[?1000h\x1b[?1002h\x1b[?1006h",
  mouseOff: "\x1b[?1006l\x1b[?1002l\x1b[?1000l",
  pasteOn: "\x1b[?2004h",
  pasteOff: "\x1b[?2004l",
  clearScreen: "\x1b[2J",
  clearToLineEnd: "\x1b[K",
  reset: "\x1b[0m",
  bell: "\x07",
  /** 同步输出：一帧的开头和结尾。不支持的终端会忽略它。 */
  syncBegin: "\x1b[?2026h",
  syncEnd: "\x1b[?2026l",
} as const;

/** 把光标移到第 row 行第 col 列（都从 0 起）。 */
export function moveTo(row: number, col: number): string {
  return `${CSI}${row + 1};${col + 1}H`;
}

const byte = (n: number) => Math.max(0, Math.min(255, Math.round(n)));

function colorParams(base: 38 | 48, color: Color, theme: Theme): string {
  const c = resolveColor(color, theme);
  return typeof c === "number" ? `${base};5;${byte(c)}` : `${base};2;${byte(c.r)};${byte(c.g)};${byte(c.b)}`;
}

/**
 * 一个样式的 SGR 序列，总是以 0（重置）开头，例如 { fg: "violet", bold: true } 在深色主题下是 "\x1b[0;1;38;5;141m"。
 * 前景：256 色编号用 38;5;N，RGB 用 38;2;R;G;B；背景同理用 48。dim 是 2，italic 3，underline 4，inverse 7。
 * style 为 undefined 或空对象时返回 "\x1b[0m"。
 */
export function sgr(style: Style | undefined, theme: Theme): string {
  const parts = ["0"];
  if (style) {
    if (style.bold) parts.push("1");
    if (style.dim) parts.push("2");
    if (style.italic) parts.push("3");
    if (style.underline) parts.push("4");
    if (style.inverse) parts.push("7");
    if (style.fg !== undefined) parts.push(colorParams(38, style.fg, theme));
    if (style.bg !== undefined) parts.push(colorParams(48, style.bg, theme));
  }
  return `${CSI}${parts.join(";")}m`;
}

const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;

/**
 * 一行的转义串：每个片段前面加它的 sgr（和前一个片段样式相同时省掉），最后加 "\x1b[0m"。
 * 片段文字里的控制字符（ESC 等）一律去掉，防止命令输出里的序列混进来。
 */
export function lineToAnsi(line: Line, theme: Theme): string {
  let out = "";
  let previous: string | null = null;
  for (const s of line) {
    const text = s.text.replace(CONTROL_CHARS, "");
    if (text === "") continue;
    const code = sgr(s.style, theme);
    if (code !== previous) {
      out += code;
      previous = code;
    }
    out += text;
  }
  return out + SEQ.reset;
}
