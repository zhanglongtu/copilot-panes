// 等待画面：还没找到 Copilot CLI 时显示，每秒重新找一次。

import type { Frame, Line, Size } from "../../types/ui.ts";
import { fitLine, span } from "../line.ts";
import { wrapText } from "../width.ts";

export const WAITING_TITLE = "左边的 pane 里还没有 Copilot CLI。";
export const WAITING_HELP = "运行 copilot，这里会自动接上。";
export const WAITING_TEXT = WAITING_TITLE + WAITING_HELP;
export const WAITING_KEYS = "q 退出";

const MARGIN = 2;

/**
 * 整屏只有这两句（按宽度折行、靠左空两列、在 pane 约三分之一高处）：第一句粗体一档，第二句三档；
 * 最后一行是“q 退出”（键名二档，说明三档）。光标隐藏。
 */
export function renderWaiting(size: Size): Frame {
  const rows = Math.max(0, size.rows);
  const cols = Math.max(0, size.cols);
  const lines: Line[] = Array.from({ length: rows }, () => []);
  if (rows === 0) return { lines, cursor: null };

  const room = Math.max(1, cols - MARGIN * 2);
  const body: Line[] = [
    ...wrapText(WAITING_TITLE, room).map((text): Line => [span(" ".repeat(MARGIN) + text, { bold: true })]),
    ...wrapText(WAITING_HELP, room).map((text): Line => [span(" ".repeat(MARGIN) + text, { fg: "grey" })]),
  ];
  const space = Math.max(0, rows - 1);
  const shown = body.slice(0, space);
  const top = Math.max(0, Math.min(Math.floor((rows - 1 - shown.length) / 3), space - shown.length));
  shown.forEach((line, i) => {
    lines[top + i] = fitLine(line, cols);
  });
  const [key, does] = WAITING_KEYS.split(" ") as [string, string];
  lines[rows - 1] = fitLine([span(" ".repeat(MARGIN)), span(key, { fg: "text2" }), span(" "), span(does, { fg: "grey" })], cols);
  return { lines, cursor: null };
}
