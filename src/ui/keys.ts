// 把终端送来的字节流解析成按键、粘贴和鼠标事件。纯状态机：字符串进，事件出，不碰 stdin。

import type { InputEvent, KeyEvent, MouseEvent, SpecialKey } from "../types/ui.ts";

/** 括号粘贴最多攒这么多字符；结束标记丢了时，超过就把已攒的当作一次粘贴交出，避免吞掉之后的所有按键。 */
export const MAX_PASTE_CHARS = 1_000_000;

const ESC = "\x1b";
const PASTE_END = "\x1b[201~";
/** 一个没有结束符的转义序列攒到这么长还没完，就当它是乱码丢掉。 */
const MAX_SEQUENCE_CHARS = 4096;

interface Mods {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
}

const key = (k: SpecialKey | "char", text = "", ctrl = false, alt = false, shift = false): KeyEvent => ({
  type: "key",
  key: k,
  text,
  ctrl,
  alt,
  shift,
});

/** CSI 序列里 ";" 后第二段的修饰键：1 起头，加 1 的位掩码（Shift 1、Alt 2、Ctrl 4、Meta 8）。 */
function modifiers(field: string | undefined): Mods {
  const m = Number((field ?? "").split(":")[0]) - 1;
  return m > 0 ? { shift: (m & 1) !== 0, alt: (m & 10) !== 0, ctrl: (m & 4) !== 0 } : { shift: false, alt: false, ctrl: false };
}

const LETTER_KEYS: Record<string, SpecialKey> = { A: "up", B: "down", C: "right", D: "left", H: "home", F: "end" };
const TILDE_KEYS: Record<number, SpecialKey> = { 1: "home", 2: "insert", 3: "delete", 4: "end", 5: "pageup", 6: "pagedown", 7: "home", 8: "end" };

/** 数字键码（CSI u 和 modifyOtherKeys 的写法）换成按键；认不出返回 null。 */
function keyFromCode(code: number, mods: Mods): KeyEvent | null {
  const { ctrl, alt, shift } = mods;
  if (code === 13) return key("enter", "", ctrl, alt, shift);
  if (code === 9) return shift ? key("backtab", "", ctrl, alt, true) : key("tab", "", ctrl, alt, false);
  if (code === 27) return key("escape", "", ctrl, alt, shift);
  if (code === 127 || code === 8) return key("backspace", "", ctrl, alt, shift);
  if (!(code >= 32) || (code >= 127 && code <= 159) || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return null;
  const text = String.fromCodePoint(code);
  return key("char", shift && !ctrl && !alt ? text.toUpperCase() : text, ctrl, alt, false);
}

/**
 * 输入解析器。要认的：
 * - 可打印字符（含中文，一次来多个字时拆成多个 key "char" 事件）。
 * - 控制字符：\r 是 enter，\t 是 tab，\n 是 Ctrl+J，0x7f 和 0x08 是 backspace，其余 0x01–0x1a 是 Ctrl+字母，0x1b 见下。
 * - 转义序列：方向键（ESC [ A–D 和 ESC O A–D）、Home、End（ESC [ H/F、ESC [ 1~/4~/7~/8~）、PgUp、PgDn（ESC [ 5~/6~）、
 *   Insert、Delete（ESC [ 2~/3~）、Shift+Tab（ESC [ Z）、带修饰键的形式（ESC [ 1;5A 是 Ctrl+上），
 *   以及 tmux 开了 extended-keys 时的 ESC [ 13;3u 和 ESC [ 27;3;13~（Alt+Enter）。
 * - Alt 组合：ESC 后面跟一个字符（ESC \r 是 Alt+Enter）。
 * - 括号粘贴：ESC [ 200~ 到 ESC [ 201~ 之间的内容合成一个 paste 事件（\r\n 和 \r 换成 \n）。
 * - SGR 鼠标：ESC [ < b ; x ; y M（按下、拖动、滚轮）或 m（松开）；x、y 从 1 起，事件里换成从 0 起。
 * - 认不出的转义序列整段丢掉，不产生事件；终端对查询的回答（OSC、DSR、光标位置）也是这样丢掉。
 * 单独一个 ESC 不能马上判断（可能是序列的开头），留着等 flush()：调用方在 ESC_TIMEOUT_MS 内没有新数据时调用 flush()，把它当 Esc 键。
 * 序列被切在两次 feed 之间时，留着等下一次。
 */
export class InputParser {
  private buf = "";
  private inPaste = false;
  private paste = "";
  /** parseOne 遇到半截序列时，记下它在 buf 里的起点。 */
  private pendingFrom = 0;

  feed(data: string): InputEvent[] {
    this.buf += data;
    const out: InputEvent[] = [];
    let i = 0;
    for (;;) {
      if (this.inPaste) {
        this.buf = this.buf.slice(i);
        i = 0;
        if (!this.drainPaste(out)) break;
        continue;
      }
      if (i >= this.buf.length) break;
      const next = this.parseOne(i, out);
      if (next < 0) {
        i = this.pendingFrom;
        break;
      }
      i = next;
    }
    this.buf = this.buf.slice(i);
    return out;
  }

  /** 有没有还没交出的半截序列（调用方据此决定要不要排一个 ESC_TIMEOUT_MS 的定时器来调用 flush）。 */
  get hasPending(): boolean {
    return this.buf.length > 0;
  }

  /** 把留着的半截当作已经结束：单独的 ESC 交出成 Esc 键，其余半截序列丢掉。粘贴进行到一半时什么也不做。 */
  flush(): InputEvent[] {
    if (this.inPaste) return [];
    const out: InputEvent[] = [];
    if (this.buf === ESC) out.push(key("escape"));
    this.buf = "";
    return out;
  }

  /** 粘贴中：找结束标记。返回 true 表示粘贴结束了，可以接着解析 buf 里剩下的字节。 */
  private drainPaste(out: InputEvent[]): boolean {
    const end = this.buf.indexOf(PASTE_END);
    if (end >= 0) {
      this.paste += this.buf.slice(0, end);
      this.buf = this.buf.slice(end + PASTE_END.length);
      this.finishPaste(out);
      return true;
    }
    // 结尾可能是结束标记的前半截，留着；其余并进粘贴内容。
    let keep = Math.min(PASTE_END.length - 1, this.buf.length);
    while (keep > 0 && !PASTE_END.startsWith(this.buf.slice(this.buf.length - keep))) keep--;
    this.paste += this.buf.slice(0, this.buf.length - keep);
    this.buf = this.buf.slice(this.buf.length - keep);
    if (this.paste.length > MAX_PASTE_CHARS) {
      this.finishPaste(out);
      return true;
    }
    return false;
  }

  private finishPaste(out: InputEvent[]): void {
    out.push({ type: "paste", text: this.paste.replace(/\r\n?/g, "\n") });
    this.paste = "";
    this.inPaste = false;
  }

  /** 解析 buf 从 i 开始的一个单元，返回下一个位置；序列不完整返回 -1。 */
  private parseOne(i: number, out: InputEvent[]): number {
    const buf = this.buf;
    const c = buf.charCodeAt(i);
    if (c === 0x1b) return this.parseEscape(i, out);
    if (c < 0x20 || c === 0x7f) {
      this.control(c, false, out);
      return i + 1;
    }
    if (c >= 0x80 && c <= 0x9f) return i + 1;
    if (c >= 0xd800 && c <= 0xdbff && i + 1 >= buf.length) return this.incomplete(i);
    const cp = buf.codePointAt(i)!;
    if (cp >= 0xd800 && cp <= 0xdfff) return i + 1;
    out.push(key("char", String.fromCodePoint(cp)));
    return i + (cp > 0xffff ? 2 : 1);
  }

  private incomplete(from: number): number {
    this.pendingFrom = from;
    return -1;
  }

  /** 一个控制字符（alt 为 true 时前面有 ESC）。 */
  private control(c: number, alt: boolean, out: InputEvent[]): void {
    if (c === 0x0d) out.push(key("enter", "", false, alt));
    else if (c === 0x09) out.push(key("tab", "", false, alt));
    else if (c === 0x7f || c === 0x08) out.push(key("backspace", "", false, alt));
    else if (c === 0x00) out.push(key("char", " ", true, alt));
    else if (c <= 0x1a) out.push(key("char", String.fromCharCode(0x60 + c), true, alt));
  }

  private parseEscape(i: number, out: InputEvent[]): number {
    const buf = this.buf;
    if (i + 1 >= buf.length) return this.incomplete(i);
    const next = buf[i + 1]!;
    if (next === "[") return this.parseCsi(i, out);
    if (next === "O") {
      if (i + 2 >= buf.length) return this.incomplete(i);
      const named = LETTER_KEYS[buf[i + 2]!];
      if (named) out.push(key(named));
      return i + 3;
    }
    if (next === "]" || next === "P" || next === "X" || next === "^" || next === "_") return this.skipString(i);
    if (next === ESC) {
      out.push(key("escape"));
      return i + 1;
    }
    const c = buf.charCodeAt(i + 1);
    if (c < 0x20 || c === 0x7f) {
      this.control(c, true, out);
      return i + 2;
    }
    if (c >= 0x80 && c <= 0x9f) return i + 2;
    if (c >= 0xd800 && c <= 0xdbff && i + 2 >= buf.length) return this.incomplete(i);
    const cp = buf.codePointAt(i + 1)!;
    if (cp >= 0xd800 && cp <= 0xdfff) return i + 2;
    out.push(key("char", String.fromCodePoint(cp), false, true));
    return i + 1 + (cp > 0xffff ? 2 : 1);
  }

  /** OSC、DCS 等以 BEL 或 ESC \ 结尾的序列：整段丢掉。 */
  private skipString(i: number): number {
    const buf = this.buf;
    for (let j = i + 2; j < buf.length; j++) {
      const c = buf[j];
      if (c === "\x07") return j + 1;
      if (c === ESC) {
        if (j + 1 >= buf.length) return this.incomplete(i);
        return buf[j + 1] === "\\" ? j + 2 : j;
      }
    }
    return buf.length - i > MAX_SEQUENCE_CHARS ? buf.length : this.incomplete(i);
  }

  private parseCsi(i: number, out: InputEvent[]): number {
    const buf = this.buf;
    let j = i + 2;
    while (j < buf.length) {
      const c = buf.charCodeAt(j);
      if (c >= 0x40 && c <= 0x7e) break;
      if (c < 0x20 || c > 0x3f) return j;
      j++;
    }
    if (j >= buf.length) return buf.length - i > MAX_SEQUENCE_CHARS ? buf.length : this.incomplete(i);

    const params = buf.slice(i + 2, j);
    const final = buf[j]!;
    const fields = params.split(";");
    if (final === "~" && params === "200") {
      this.inPaste = true;
      this.paste = "";
    } else if (params.startsWith("<") && (final === "M" || final === "m")) {
      const mouse = this.mouse(params.slice(1), final);
      if (mouse) out.push(mouse);
    } else if (final === "Z" && fields.length <= 2) {
      out.push(key("backtab", "", false, false, true));
    } else if (final in LETTER_KEYS) {
      const m = modifiers(fields[1]);
      out.push(key(LETTER_KEYS[final]!, "", m.ctrl, m.alt, m.shift));
    } else if (final === "~") {
      const code = Number(fields[0]);
      if (code === 27) {
        const k = keyFromCode(Number(fields[2]), modifiers(fields[1]));
        if (k) out.push(k);
      } else {
        const named = TILDE_KEYS[code];
        if (named) {
          const m = modifiers(fields[1]);
          out.push(key(named, "", m.ctrl, m.alt, m.shift));
        }
      }
    } else if (final === "u") {
      const k = keyFromCode(Number((fields[0] ?? "").split(":")[0]), modifiers(fields[1]));
      if (k) out.push(k);
    }
    return j + 1;
  }

  private mouse(params: string, final: string): MouseEvent | null {
    const [b, x, y] = params.split(";").map(Number);
    if (b === undefined || x === undefined || y === undefined || [b, x, y].some((n) => !Number.isFinite(n))) return null;
    const mods = { shift: (b & 4) !== 0, alt: (b & 8) !== 0, ctrl: (b & 16) !== 0 };
    const row = Math.max(0, Math.floor(y) - 1);
    const col = Math.max(0, Math.floor(x) - 1);
    const low = b & 3;
    if ((b & 64) !== 0) {
      if (final !== "M" || low > 1) return null;
      return { type: "mouse", action: low === 0 ? "wheelup" : "wheeldown", button: null, row, col, ...mods };
    }
    const button = low === 0 ? "left" : low === 1 ? "middle" : low === 2 ? "right" : null;
    const action = final === "m" ? "up" : (b & 32) !== 0 ? "drag" : "down";
    return { type: "mouse", action, button, row, col, ...mods };
  }
}
