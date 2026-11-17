// 视图共用的几个小函数：行的拼接、去行尾空格、列表翻页。纯函数。

import { SPINNER_FRAMES, SPINNER_FRAME_MS } from "../../constants.ts";
import type { ColorRole, Line, Span } from "../../types/ui.ts";
import { lineWidth, span } from "../line.ts";

/** 把若干块用一个空格连起来。 */
export function joinCells(cells: readonly Line[]): Line {
  const out: Span[] = [];
  cells.forEach((c, i) => {
    if (i > 0) out.push(span(" "));
    out.push(...c);
  });
  return out;
}

/** 去掉行尾的空格，只有空格的片段整个去掉。带底色的片段（选中行铺满的底色）原样留下。 */
export function trimLineEnd(line: Line): Line {
  const out = line.slice();
  while (out.length > 0) {
    const last = out[out.length - 1]!;
    if (last.style?.bg !== undefined) break;
    const text = last.text.trimEnd();
    if (text === "") {
      out.pop();
    } else {
      if (text !== last.text) out[out.length - 1] = span(text, last.style);
      break;
    }
  }
  return out;
}

/** 选中行里文字提一档：三档变二档，二档变一档（不写颜色），暗色的符号变亮；其余不变。 */
export function liftColor(color: ColorRole | undefined): ColorRole | undefined {
  switch (color) {
    case "grey":
      return "text2";
    case "text2":
      return undefined;
    case "violetDim":
      return "violet";
    case "cyanDim":
      return "cyan";
    case "redDim":
      return "red";
    default:
      return color;
  }
}

/** 整行铺底色：每个片段加上 bg，再用带底色的空格补到 width 列（行已经够宽就不补）。 */
export function paintRow(line: Line, width: number, bg: ColorRole): Line {
  const out = line.map((s) => span(s.text, { ...s.style, bg }));
  const gap = width - lineWidth(line);
  if (gap > 0) out.push(span(" ".repeat(gap), { bg }));
  return out;
}

/** 转动符号第几帧：按时刻算，不存在状态里。 */
export function spinnerFrameAt(now: number): number {
  return Math.floor(Math.max(0, now) / SPINNER_FRAME_MS) % SPINNER_FRAMES.length;
}

/**
 * 条目多于一屏时从第几个开始显示：按页翻。选中的那一项所在的页就是显示的页，最后一页向前靠齐、补满一屏。
 * 页只由选中项的位置决定，所以在一页里上下移动、用鼠标点一行，都不会让名单自己滚动。
 */
export function pageOffset(index: number, count: number, rows: number): number {
  if (rows <= 0 || count <= rows || index < 0) return 0;
  return Math.min(Math.floor(index / rows) * rows, count - rows);
}
