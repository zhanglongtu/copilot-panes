// 对“一行带样式的片段”（Line）的操作：量宽度、截断、补齐、折行，以及把一帧变成纯文字（快照测试用）。纯函数。

import type { Frame, Line, Span, Style } from "../types/ui.ts";
import { clipText, graphemes, textWidth, wrapUnits } from "./width.ts";

/** 造一个片段。style 为 undefined 时片段不带 style 字段。 */
export function span(text: string, style?: Style): Span {
  return style === undefined ? { text } : { text, style };
}

/** 一行的显示宽度：各片段的宽度相加（每个片段从自己的开头量起）。 */
export function lineWidth(line: Line): number {
  let total = 0;
  for (const s of line) total += textWidth(s.text);
  return total;
}

/** 一行的纯文字（片段文字连起来）。 */
export function lineText(line: Line): string {
  let text = "";
  for (const s of line) text += s.text;
  return text;
}

/**
 * 截到 width 列以内：从左到右放片段，某个片段放不下时用 clipText 截断它（末尾 "…"，样式跟着这个片段），
 * 后面的片段全部丢掉。空文字的片段去掉。
 */
export function fitLine(line: Line, width: number): Line {
  const out: Span[] = [];
  let left = width;
  for (const s of line) {
    if (s.text === "") continue;
    const text = clipText(s.text, left);
    if (text !== "") out.push(span(text, s.style));
    left -= textWidth(text);
    if (text !== s.text) break;
  }
  return out;
}

/** fitLine 之后用空格补满 width 列。align 为 "right" 时空格补在左边。补的空格不带样式。 */
export function cell(line: Line, width: number, align: "left" | "right" = "left"): Line {
  const fitted = fitLine(line, width);
  const gap = width - lineWidth(fitted);
  if (gap <= 0) return fitted;
  const pad = span(" ".repeat(gap));
  return align === "right" ? [pad, ...fitted] : [...fitted, pad];
}

/** 按 width 列折行（规则同 width.ts 的 wrapText），每个字保留原来的样式。 */
export function wrapLine(line: Line, width: number): Line[] {
  const units: string[] = [];
  const owner: number[] = [];
  line.forEach((s, i) => {
    for (const g of graphemes(s.text)) {
      units.push(g);
      owner.push(i);
    }
  });
  return wrapUnits(units, width).map(([from, to]) => {
    const row: Span[] = [];
    let k = from;
    while (k < to) {
      const who = owner[k]!;
      let text = "";
      while (k < to && owner[k] === who) text += units[k++];
      if (text !== "") row.push(span(text, line[who]!.style));
    }
    return row;
  });
}

/** 一帧的纯文字：每行的文字去掉行尾空格，用 "\n" 连起来。界面的快照测试（test/ui/snapshots）存的就是它。 */
export function frameText(frame: Frame): string {
  return frame.lines.map((line) => lineText(line).trimEnd()).join("\n");
}
