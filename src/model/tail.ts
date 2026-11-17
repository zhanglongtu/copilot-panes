// 增量读文件：events.jsonl 按行读，命令的 .out 按文字读。两种都是同步读，每次最多读 maxBytesPerRead 字节，
// 让调用方在两次读之间画画面（大文件第一次读完要分好几次）。
// 文件被截短或换掉时，读到的结果带 reset 标记，调用方据此清掉已有的状态重新来过。

import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
// 记下文件开头这么多字节：同一个 inode 被改写成更大的文件时，大小和 inode 都看不出来，开头对不上就知道被替换了。
const HEAD_BYTES = 128;

export interface TailOptions {
  /** 每次 read() 最多读这么多字节，默认 8 MiB。 */
  maxBytesPerRead?: number;
}

export interface LineChunk {
  /** 这次读到的整行（UTF-8 解码，坏字节换成 U+FFFD，不含换行符）。空行不交付；只含空白的行照样交付。 */
  lines: string[];
  /**
   * 文件被截短（大小小于已读位置）或被替换（inode 变了），这次从头读了。调用方必须先丢掉自己由旧内容得出的状态
   * （例如新建 SessionStore），再处理这次的 lines。
   */
  reset: boolean;
  /** 文件里还有没读的字节（这次读满了上限）。调用方可以接着再读。 */
  more: boolean;
}

interface Step {
  exists: boolean;
  reset: boolean;
  /** 这次新读到的字节；没有新字节是 null。 */
  data: Buffer | null;
  more: boolean;
}

/** 记着已读字节数、inode 和文件开头，每次从已读位置读新增的字节；两种 Tailer 共用。 */
class FileCursor {
  readonly path: string;
  private readonly maxBytes: number;
  private pos = 0;
  private ino: bigint | null = null;
  private head: Buffer = Buffer.alloc(0);
  private resetPending = false;

  constructor(path: string, maxBytes: number) {
    this.path = path;
    this.maxBytes = maxBytes;
  }

  step(): Step {
    let fd: number;
    try {
      fd = openSync(this.path, "r");
    } catch {
      return { exists: false, reset: false, data: null, more: false };
    }
    try {
      const stat = fstatSync(fd, { bigint: true });
      const size = Number(stat.size);
      if (this.pos > 0 && (this.ino !== stat.ino || size < this.pos || !this.headMatches(fd))) {
        this.pos = 0;
        this.head = Buffer.alloc(0);
        this.resetPending = true;
      }
      this.ino = stat.ino;
      if (size === this.pos) return { exists: true, reset: this.takeReset(), data: null, more: false };
      const want = Math.min(this.maxBytes, size - this.pos);
      const buffer = Buffer.allocUnsafe(want);
      let got = 0;
      while (got < want) {
        const n = readSync(fd, buffer, got, want - got, this.pos + got);
        if (n === 0) break;
        got += n;
      }
      this.pos += got;
      if (this.head.length < HEAD_BYTES && this.pos > this.head.length) this.rememberHead(fd);
      return { exists: true, reset: this.takeReset(), data: got > 0 ? buffer.subarray(0, got) : null, more: this.pos < size };
    } catch {
      // 读出错：什么都不改，复位的通知留到下一次读成功时再报
      return { exists: true, reset: false, data: null, more: false };
    } finally {
      closeSync(fd);
    }
  }

  private takeReset(): boolean {
    const reset = this.resetPending;
    this.resetPending = false;
    return reset;
  }

  private headMatches(fd: number): boolean {
    if (this.head.length === 0) return true;
    const now = Buffer.alloc(this.head.length);
    const n = readSync(fd, now, 0, now.length, 0);
    return n === now.length && now.equals(this.head);
  }

  private rememberHead(fd: number): void {
    const length = Math.min(HEAD_BYTES, this.pos);
    const head = Buffer.alloc(length);
    const n = readSync(fd, head, 0, length, 0);
    this.head = head.subarray(0, n);
  }
}

/**
 * 按行增量读一个文件。记着已读字节数和 inode；第一次从第 0 字节读起。末尾没有换行符的半行留着，等补全了再交付
 * （所以写到一半的事件不会被当成坏行丢掉）。文件不存在或读出错时什么都不改，返回空结果，下次再试。
 */
export class LineTailer {
  readonly path: string;
  private readonly cursor: FileCursor;
  private partial: Buffer = Buffer.alloc(0);

  constructor(path: string, options?: TailOptions) {
    this.path = path;
    this.cursor = new FileCursor(path, Math.max(1, options?.maxBytesPerRead ?? DEFAULT_MAX_BYTES));
  }

  read(): LineChunk {
    const step = this.cursor.step();
    if (step.reset) this.partial = Buffer.alloc(0);
    if (!step.data) return { lines: [], reset: step.reset, more: step.more };
    const data = this.partial.length > 0 ? Buffer.concat([this.partial, step.data]) : step.data;
    const lastNewline = data.lastIndexOf(0x0a);
    if (lastNewline < 0) {
      this.partial = Buffer.from(data);
      return { lines: [], reset: step.reset, more: step.more };
    }
    this.partial = Buffer.from(data.subarray(lastNewline + 1));
    const lines = data.toString("utf8", 0, lastNewline).split("\n").filter((line) => line !== "");
    return { lines, reset: step.reset, more: step.more };
  }
}

export interface TextChunk {
  /** 这次新读到的文字。按字节读、用流式 UTF-8 解码，一个汉字被切在两次读之间也不会乱码。 */
  text: string;
  /** 同 LineChunk.reset：文件被截短或替换，这次从头读了，调用方要清空终端模拟器再写 text。 */
  reset: boolean;
  more: boolean;
  /** 文件现在存不存在。命令的 .out 不存在时，界面退回用事件里的输出。 */
  exists: boolean;
}

/** 按文字增量读一个文件（命令的 .out，交给终端模拟器）。不切行，原样交出（保留颜色码、回车符、半行）。 */
export class TextTailer {
  readonly path: string;
  private readonly cursor: FileCursor;
  private decoder = new StringDecoder("utf8");

  constructor(path: string, options?: TailOptions) {
    this.path = path;
    this.cursor = new FileCursor(path, Math.max(1, options?.maxBytesPerRead ?? DEFAULT_MAX_BYTES));
  }

  read(): TextChunk {
    const step = this.cursor.step();
    if (step.reset) this.decoder = new StringDecoder("utf8");
    const text = step.data ? this.decoder.write(step.data) : "";
    return { text, reset: step.reset, more: step.more, exists: step.exists };
  }
}
