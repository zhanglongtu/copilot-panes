// 显示宽度：汉字和全角符号占 2 列，组合字符和零宽字符占 0 列，其余 1 列。截断、折行、补齐都按显示宽度算。
// 标准答案是 tmux 实际显示的宽度：表来自 tmux 3.4 逐个码点实测（src/ui/width-table.ts，由 test/ui-core/gen-width-table.ts 生成），
// 字符怎么并进同一个格子照 tmux 3.4 的 screen_write_combine。test/ui-core/width-tmux.test.ts 拿真的 tmux 核对。纯函数。

import { WIDE, ZERO_WIDTH } from "./width-table.ts";

function inTable(table: readonly number[], cp: number): boolean {
  let lo = 0;
  let hi = (table.length >> 1) - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cp < table[mid * 2]!) hi = mid - 1;
    else if (cp > table[mid * 2 + 1]!) lo = mid + 1;
    else return true;
  }
  return false;
}

/**
 * 一个码点单独占几列（tmux 的 utf8_width：glibc 的 wcwidth，加 tmux 自己强制按 2 列算的一批表情符号）。
 * 2 列：汉字、假名、谚文、全角符号、表情符号等；0 列：组合附加符号、零宽字符、U+200D、U+FE0F、控制字符；其余 1 列。
 * 这只是单个码点的宽度；一串字符的宽度要用 textWidth（U+FE0F、肤色修饰符、国旗字母会和前一个字符并成一个格子）。
 */
export function charWidth(codePoint: number): 0 | 1 | 2 {
  if (codePoint < 0x7f) return codePoint < 0x20 ? 0 : 1;
  if (codePoint < 0x300) return codePoint <= 0x9f ? 0 : 1;
  if (inTable(WIDE, codePoint)) return 2;
  return inTable(ZERO_WIDTH, codePoint) ? 0 : 1;
}

const ZWJ = 0x200d;
const VS16 = 0xfe0f;
/** tmux 一个格子最多存 21 个字节的 UTF-8。 */
const CELL_BYTES = 21;

const utf8Size = (cp: number) => (cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4);
/** 国旗字母和肤色修饰符：tmux 把它们并进前一个（非 ASCII 的）格子，并把那个格子撑到 2 列。 */
const isModifier = (cp: number) => (cp >= 0x1f1e6 && cp <= 0x1f1ff) || (cp >= 0x1f3fb && cp <= 0x1f3ff);

interface Cell {
  w: number;
  size: number;
  zwj: boolean;
  pad: boolean;
}
const BLANK: Cell = { w: 1, size: 1, zwj: false, pad: false };
const PADDING: Cell = { w: 0, size: 1, zwj: false, pad: true };

/**
 * 在内存里模拟 tmux 3.4 的一行格子，一个码点一个码点地算一段文字从行首打印后光标走到第几列。
 * 照 tmux 的 screen_write_combine 和 screen_write_cell，包括它的怪脾气，所以结果和 tmux 一致，不是各字符宽度之和：
 * - 宽度 0 的字符、U+200D、U+FE0F 并进前一个格子；行首没有前一个格子、或自己是 ASCII 时丢掉。
 * - U+FE0F、肤色修饰符、国旗字母并进前一个格子后，把 1 列的格子撑成 2 列。修饰符要求前一个格子不是单个 ASCII 字符。
 * - 前一个格子以 U+200D 结尾时，下一个非 ASCII 字符也并进去（宽度不变）。
 * - 并进去之后格子超过 21 个字节就不并：宽度 0 的字符不显示，其他字符另起一个格子。
 * - 撑宽之后 tmux 把光标多移一格、占位格放在光标处（差了一格），所以紧接着的“前一个格子”是一个空白格，不是刚撑宽的那个。
 * push 之后 width 就是到目前为止这一串的宽度，只增不减，所以截断和折行可以边放边量。
 */
export class CellMeter {
  /** 光标列，也就是到目前为止的宽度。 */
  width = 0;
  private cells: Cell[] = [];

  copy(): CellMeter {
    const c = new CellMeter();
    c.width = this.width;
    c.cells = this.cells.slice();
    return c;
  }

  private cell(col: number): Cell {
    return this.cells[col] ?? BLANK;
  }

  private set(col: number, cell: Cell): void {
    for (let i = this.cells.length; i < col; i++) this.cells[i] = BLANK;
    this.cells[col] = cell;
  }

  push(cp: number): void {
    const size = utf8Size(cp);
    const w = charWidth(cp);
    const isVs = cp === VS16;
    const zeroWidth = w === 0;
    let forceWide = isVs;
    if (size < 2 || this.width === 0) return zeroWidth ? undefined : this.write(w, size);

    let n = 1;
    let last = this.cell(this.width - 1);
    if (this.width !== 1 && last.pad) {
      n = 2;
      last = this.cell(this.width - 2);
    }
    if (n !== last.w || last.pad) return zeroWidth ? undefined : this.write(w, size);

    if (!zeroWidth) {
      if (isModifier(cp)) {
        if (last.size < 2) return this.write(w, size);
        forceWide = true;
      } else if (!last.zwj) {
        return this.write(w, size);
      }
    }
    if (last.size + size > CELL_BYTES) return this.write(w, size);

    const merged: Cell = { w: last.w, size: last.size + size, zwj: cp === ZWJ, pad: false };
    if (last.w === 1 && forceWide) {
      merged.w = 2;
      this.width++;
      this.set(this.width - 2, merged);
      this.set(this.width, PADDING);
    } else {
      this.set(this.width - n, merged);
    }
  }

  /** 照 tmux 的 screen_write_cell 把一个字符写进光标处的格子（含清掉被盖住的占位格）。 */
  private write(w: number, size: number): void {
    const now = this.cell(this.width);
    if (now.pad) {
      let xx = this.width + 1;
      while (--xx > 0) {
        if (!this.cell(xx).pad) break;
        this.set(xx, BLANK);
      }
      this.set(xx, BLANK);
    }
    if (w !== 1 || now.w !== 1 || now.pad) {
      for (let xx = this.width + w; this.cell(xx).pad; xx++) this.set(xx, BLANK);
    }
    for (let xx = this.width + 1; xx < this.width + w; xx++) this.set(xx, PADDING);
    this.set(this.width, { w, size, zwj: false, pad: false });
    this.width += w;
  }
}

const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;

/** 一段文字（不含换行）的显示宽度，等于 tmux 里这段文字从行首打印后光标走过的列数。 */
export function textWidth(text: string): number {
  if (PRINTABLE_ASCII.test(text)) return text.length;
  const meter = new CellMeter();
  for (const ch of text) meter.push(ch.codePointAt(0)!);
  return meter.width;
}

let segmenter: Intl.Segmenter | undefined;

/** 拆成字素（用户眼里的一个字符，例如带肤色的表情、带组合符号的字母），用 Intl.Segmenter。光标和截断都不能切开字素。 */
export function graphemes(text: string): string[] {
  if (PRINTABLE_ASCII.test(text)) return text.split("");
  segmenter ??= new Intl.Segmenter(undefined, { granularity: "grapheme" });
  return Array.from(segmenter.segment(text), (s) => s.segment);
}

/** 把字素 g 的每个码点喂给 meter 的一份拷贝，返回拷贝。 */
export function meterAfter(meter: CellMeter, g: string): CellMeter {
  const next = meter.copy();
  for (const ch of g) next.push(ch.codePointAt(0)!);
  return next;
}

/**
 * 截到 width 列以内：放得下原样返回；放不下时取前面不超过 width - 1 列的字素，末尾加 "…"。
 * width ≤ 0 返回 ""。汉字放不下一半时整个去掉（不会出现半个汉字）。
 */
export function clipText(text: string, width: number): string {
  if (width <= 0) return "";
  if (textWidth(text) <= width) return text;
  if (PRINTABLE_ASCII.test(text)) return text.slice(0, width - 1) + "…";
  const kept: string[] = [];
  let meter = new CellMeter();
  for (const g of graphemes(text)) {
    const next = meterAfter(meter, g);
    if (next.width > width - 1) break;
    meter = next;
    kept.push(g);
  }
  // 前一个格子以 U+200D 结尾时，"…" 会并进去；极少见，量一次再决定要不要多去掉一个字素。
  while (kept.length > 0 && textWidth(kept.join("") + "…") > width) kept.pop();
  return kept.join("") + "…";
}

/** 用空格补到 width 列（超出时先 clipText）。align 为 "right" 时空格补在左边。 */
export function padText(text: string, width: number, align: "left" | "right" = "left"): string {
  const clipped = clipText(text, width);
  const gap = " ".repeat(Math.max(0, width - textWidth(clipped)));
  return align === "right" ? gap + clipped : clipped + gap;
}

/**
 * 折行的核心：units 是字素（换行用 "\n" 这一个单元），返回每一行占 units 里的哪一段 [起, 止)（不含换行单元、不含行尾空格）。
 * 规则见 wrapText。一个字素比 width 还宽时单独占一行。
 */
export function wrapUnits(units: readonly string[], width: number): [number, number][] {
  const w = Math.max(1, Math.floor(width));
  const rows: [number, number][] = [];
  const trimEnd = (from: number, to: number) => {
    while (to > from && units[to - 1] === " ") to--;
    return to;
  };

  let start = 0;
  for (;;) {
    let end = start;
    while (end < units.length && units[end] !== "\n") end++;

    let rowStart = start;
    let meter = new CellMeter();
    let cumulative: number[] = [];
    let continuation = false;
    let k = start;
    while (k < end) {
      const unit = units[k]!;
      if (continuation && k === rowStart && unit === " ") {
        rowStart = ++k;
        continue;
      }
      const next = meterAfter(meter, unit);
      if (next.width <= w || k === rowStart) {
        meter = next;
        cumulative.push(next.width);
        k++;
        continue;
      }
      let breakAt = -1;
      for (let j = k - 1; j > rowStart; j--) {
        if (units[j] === " ") {
          breakAt = j;
          break;
        }
      }
      // 空格前的部分不到一行的一半时不在这个空格断，免得中文长句前面的一个空格让首行提前结束。
      if (breakAt >= 0 && cumulative[breakAt - rowStart - 1]! * 2 >= w) {
        rows.push([rowStart, trimEnd(rowStart, breakAt)]);
        rowStart = breakAt + 1;
      } else {
        rows.push([rowStart, trimEnd(rowStart, k)]);
        rowStart = k;
      }
      continuation = true;
      meter = new CellMeter();
      cumulative = [];
      for (let j = rowStart; j < k; j++) {
        meter = meterAfter(meter, units[j]!);
        cumulative.push(meter.width);
      }
    }
    rows.push([rowStart, trimEnd(rowStart, end)]);
    if (end >= units.length) break;
    start = end + 1;
  }
  return rows;
}

/**
 * 折成每行不超过 width 列的若干行。原有的换行保留；英文单词尽量在空格处断开，但空格靠近行首时（断开后这一行不到 width 的一半）
 * 不在那里断，接着放字（中文长句前部的空格不让首行提前断开）；比一行还长的单词在放不下处硬切。行尾空格去掉；折行处的空格不留到下一行行首。
 * 空串得 [""]。\r\n 和 \r 当作换行。
 */
export function wrapText(text: string, width: number): string[] {
  const units = graphemes(text.replace(/\r\n?/g, "\n"));
  return wrapUnits(units, width).map(([from, to]) => units.slice(from, to).join(""));
}
