// 命令内容区的终端模拟器：包装 @xterm/headless，把 .out 的原文喂进去，取出带样式的行和回滚缓冲。
// @xterm/headless 是 CommonJS 包：写 `import xterm from "@xterm/headless"; const { Terminal } = xterm;`，类型用 `import type`。

import xterm from "@xterm/headless";
import type { IBufferCell, IBufferLine, Terminal as XTerminal } from "@xterm/headless";
import type { Color, Line, Span, Style, TerminalLines } from "../types/ui.ts";

const { Terminal } = xterm;

export interface TermOptions {
  cols: number;
  rows: number;
  /** 回滚缓冲保留多少行（TERM_SCROLLBACK_LINES）。 */
  scrollback: number;
}

/** write 每次交给 xterm 的字符数；喂完一块就让出一次事件循环。 */
const WRITE_CHUNK_CHARS = 64 * 1024;

const FLAG_BOLD = 1;
const FLAG_DIM = 2;
const FLAG_ITALIC = 4;
const FLAG_UNDERLINE = 8;
const FLAG_INVERSE = 16;

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function rgb(value: number): Color {
  return { r: (value >> 16) & 0xff, g: (value >> 8) & 0xff, b: value & 0xff };
}

function makeStyle(fg: Color | undefined, bg: Color | undefined, flags: number): Style | undefined {
  if (fg === undefined && bg === undefined && flags === 0) return undefined;
  const style: Style = {};
  if (fg !== undefined) style.fg = fg;
  if (bg !== undefined) style.bg = bg;
  if (flags & FLAG_BOLD) style.bold = true;
  if (flags & FLAG_DIM) style.dim = true;
  if (flags & FLAG_ITALIC) style.italic = true;
  if (flags & FLAG_UNDERLINE) style.underline = true;
  if (flags & FLAG_INVERSE) style.inverse = true;
  return style;
}

/** 行尾的空白只有看得见时（有背景色、反显、下划线）才保留。 */
function isInvisibleTail(style: Style | undefined): boolean {
  return style === undefined || (style.bg === undefined && !style.inverse && !style.underline);
}

/**
 * 一条命令的终端。Terminal 的选项：cols、rows、scrollback、allowProposedApi: true、convertEol: true
 * （后台命令的输出来自管道，只有 \n 没有 \r，不转换会变成阶梯状；伪终端的 \r\n 转换后不受影响）。
 */
export class TermView implements TerminalLines {
  readonly #scrollback: number;
  #term: XTerminal;
  /** reset 一次加 1。喂到一半的 write 看到它变了就放弃剩下的内容。 */
  #epoch = 0;
  /** 前面所有 write 都处理完后兑现；write 排队，保证交给 xterm 的顺序和调用顺序一致。 */
  #tail: Promise<void> = Promise.resolve();
  /** 已交给 xterm、回调还没来的块；reset 时直接兑现，免得等一个永远不来的回调。 */
  readonly #inflight = new Set<() => void>();
  #disposed = false;

  constructor(options: TermOptions) {
    this.#scrollback = options.scrollback;
    this.#term = this.#createTerminal(options.cols, options.rows);
  }

  #createTerminal(cols: number, rows: number): XTerminal {
    return new Terminal({
      cols: Math.max(2, Math.floor(cols)),
      rows: Math.max(1, Math.floor(rows)),
      scrollback: this.#scrollback,
      allowProposedApi: true,
      convertEol: true,
    });
  }

  get cols(): number {
    return this.#term.cols;
  }

  get rows(): number {
    return this.#term.rows;
  }

  /** 回滚缓冲加屏幕的总行数（buffer.active.length）。 */
  get totalLines(): number {
    return this.#term.buffer.active.length;
  }

  /**
   * 喂原文（保留颜色码、回车符）。xterm 的 write 是异步的，Promise 在这段处理完后兑现。
   * 大段内容切成块，每块处理完让出一次事件循环；多次调用按顺序排队。reset 或 dispose 之后，还没喂完的部分被丢弃。
   */
  write(data: string): Promise<void> {
    if (this.#disposed || data === "") return this.#tail;
    const epoch = this.#epoch;
    const job = this.#tail.then(() => this.#feed(data, epoch));
    this.#tail = job.catch(() => {});
    return job;
  }

  async #feed(data: string, epoch: number): Promise<void> {
    let pos = 0;
    while (pos < data.length) {
      if (epoch !== this.#epoch) return;
      let end = Math.min(pos + WRITE_CHUNK_CHARS, data.length);
      // 不把代理对拆开：块尾是高位代理时少带一个字符。
      if (end < data.length) {
        const last = data.charCodeAt(end - 1);
        if (last >= 0xd800 && last <= 0xdbff) end -= 1;
      }
      await this.#writeChunk(data.slice(pos, end));
      pos = end;
      if (pos < data.length) await yieldToEventLoop();
    }
  }

  #writeChunk(chunk: string): Promise<void> {
    return new Promise<void>((resolve) => {
      const done = () => {
        this.#inflight.delete(done);
        resolve();
      };
      this.#inflight.add(done);
      this.#term.write(chunk, done);
    });
  }

  #abandonPendingWrites(): void {
    this.#epoch += 1;
    for (const done of [...this.#inflight]) done();
  }

  /** 清空所有内容（.out 被截短或替换时，TextTailer 报 reset 之后调用）。 */
  reset(): void {
    if (this.#disposed) return;
    this.#abandonPendingWrites();
    const old = this.#term;
    this.#term = this.#createTerminal(old.cols, old.rows);
    old.dispose();
  }

  /** 改尺寸（内容区大小变了）。 */
  resize(cols: number, rows: number): void {
    if (this.#disposed) return;
    this.#term.resize(Math.max(2, Math.floor(cols)), Math.max(1, Math.floor(rows)));
  }

  /**
   * 从 start 起取 count 行，每行转成片段：相邻且样式相同的格子合成一个片段；前景、背景按颜色模式转成 Style 的颜色
   * （默认色不写，调色板写 0–255 的数字，真彩色写 Rgb）；bold、dim、italic、underline、inverse 原样带上。
   * 宽字符后面那个宽度为 0 的格子跳过。行尾的空白格子去掉，但带背景色、反显或下划线的空白格子看得见，保留。
   * 超出范围的行不返回。
   */
  lines(start: number, count: number): Line[] {
    const buffer = this.#term.buffer.active;
    const first = Math.max(0, Math.floor(start));
    const last = Math.min(buffer.length, Math.floor(start) + Math.floor(count));
    const result: Line[] = [];
    if (first >= last) return result;
    const cell = buffer.getNullCell();
    for (let y = first; y < last; y++) {
      const line = buffer.getLine(y);
      if (line) result.push(this.#spansOf(line, cell));
    }
    return result;
  }

  #spansOf(line: IBufferLine, cell: IBufferCell): Span[] {
    const spans: Span[] = [];
    const length = line.length;
    let text = "";
    let curFg = 0;
    let curBg = 0;
    let curFgMode = -1;
    let curBgMode = 0;
    let curFlags = 0;
    let curStyle: Style | undefined;
    for (let x = 0; x < length; x++) {
      const c = line.getCell(x, cell);
      if (!c || c.getWidth() === 0) continue;
      const fgMode = c.getFgColorMode();
      const bgMode = c.getBgColorMode();
      const fg = c.getFgColor();
      const bg = c.getBgColor();
      const flags =
        (c.isBold() ? FLAG_BOLD : 0) |
        (c.isDim() ? FLAG_DIM : 0) |
        (c.isItalic() ? FLAG_ITALIC : 0) |
        (c.isUnderline() ? FLAG_UNDERLINE : 0) |
        (c.isInverse() ? FLAG_INVERSE : 0);
      if (fgMode !== curFgMode || bgMode !== curBgMode || fg !== curFg || bg !== curBg || flags !== curFlags) {
        if (text !== "") spans.push(curStyle ? { text, style: curStyle } : { text });
        text = "";
        curFgMode = fgMode;
        curBgMode = bgMode;
        curFg = fg;
        curBg = bg;
        curFlags = flags;
        curStyle = makeStyle(
          c.isFgRGB() ? rgb(fg) : c.isFgPalette() ? fg : undefined,
          c.isBgRGB() ? rgb(bg) : c.isBgPalette() ? bg : undefined,
          flags,
        );
      }
      const chars = c.getChars();
      text += chars === "" ? " " : chars;
    }
    if (text !== "") spans.push(curStyle ? { text, style: curStyle } : { text });
    while (spans.length > 0) {
      const tail = spans[spans.length - 1]!;
      if (!isInvisibleTail(tail.style)) break;
      const trimmed = tail.text.trimEnd();
      if (trimmed === "") {
        spans.pop();
        continue;
      }
      if (trimmed !== tail.text) spans[spans.length - 1] = tail.style ? { text: trimmed, style: tail.style } : { text: trimmed };
      break;
    }
    return spans;
  }

  /** 从底部往上翻 scrollFromBottom 行时，屏幕上该显示的 rows 行（scrollFromBottom 超出范围时停在最顶上）。 */
  viewport(scrollFromBottom: number): Line[] {
    const rows = this.#term.rows;
    const maxScroll = Math.max(0, this.totalLines - rows);
    const scroll = Math.min(Math.max(0, Math.floor(scrollFromBottom) || 0), maxScroll);
    return this.lines(this.totalLines - rows - scroll, rows);
  }

  /** 一个屏幕行的文字；下一行是它折下来的后半截时保留行尾空格，否则去掉行尾空白。 */
  #rowText(line: IBufferLine, continues: boolean): string {
    if (!continues) return line.translateToString(true);
    const full = line.translateToString(false);
    // 宽字符放不下最后一列时，xterm 留一个空格子把它折到下一行；这个空格子不是内容。
    const lastCell = line.getCell(line.length - 1);
    return lastCell && lastCell.getChars() === "" ? full.slice(0, -1) : full;
  }

  /** 最后一行非空文字（纯文字，去首尾空白）；没有返回 ""。因窗口太窄而折行的一行当作一行。 */
  lastNonEmptyLine(): string {
    const buffer = this.#term.buffer.active;
    let y = buffer.length - 1;
    while (y >= 0 && (buffer.getLine(y)?.translateToString(true).trim() ?? "") === "") y--;
    if (y < 0) return "";
    const parts: string[] = [];
    let continues = false;
    for (;;) {
      const line = buffer.getLine(y);
      if (!line) break;
      parts.push(this.#rowText(line, continues));
      if (!line.isWrapped || y === 0) break;
      continues = true;
      y--;
    }
    return parts.reverse().join("").trim();
  }

  /**
   * 全部纯文字（回滚缓冲加屏幕），每行去掉行尾空白，用 "\n" 连起来，末尾的空行去掉。y 和 o 键用。
   * 因窗口宽度折下来的几个屏幕行接回成原来的一行，复制出去的文字不随窗口宽度变。
   */
  plainText(): string {
    const buffer = this.#term.buffer.active;
    const out: string[] = [];
    let current = "";
    for (let y = 0; y < buffer.length; y++) {
      const line = buffer.getLine(y);
      if (!line) continue;
      const continues = buffer.getLine(y + 1)?.isWrapped === true;
      current += this.#rowText(line, continues);
      if (!continues) {
        out.push(current.trimEnd());
        current = "";
      }
    }
    if (current !== "") out.push(current.trimEnd());
    while (out.length > 0 && out[out.length - 1] === "") out.pop();
    return out.join("\n");
  }

  /** 包含 query 的行号（从 0 起，从早到晚），不分大小写；query 为空返回 []。/ 键用。行号是屏幕行，和 lines() 一致。 */
  find(query: string): number[] {
    if (query === "") return [];
    const needle = query.toLowerCase();
    const buffer = this.#term.buffer.active;
    const found: number[] = [];
    for (let y = 0; y < buffer.length; y++) {
      const text = buffer.getLine(y)?.translateToString(true);
      if (text && text.toLowerCase().includes(needle)) found.push(y);
    }
    return found;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#abandonPendingWrites();
    this.#term.dispose();
  }
}
