// 只读 events.jsonl 的末尾一段，粗略回答另一个 session 的两个问题：用户最近一次发言是什么时候、现在有几个条目在跑。
// 选哪个 session 要看这两个数；每个候选都完整读进来太贵，所以只读末尾，文件没变就不重读。

import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { SessionStore } from "../model/store.ts";

const CHUNK_BYTES = 256 * 1024;
const MAX_BACKWARD_BYTES = 32 * 1024 * 1024;
const MAX_INCREMENT_BYTES = 8 * 1024 * 1024;
const PARTIAL_LINE_WINDOW = 64 * 1024;
/** 算“在跑的条目”只读末尾这么多字节：更早开始又没有结束的条目看不到，这是粗略的数。 */
export const ACTIVITY_TAIL_BYTES = 512 * 1024;
/** 最近一次事件比这更早的 session 不算有条目在跑：Copilot CLI 被强行结束时，子 agent 没来得及写结束事件。 */
export const ACTIVITY_RECENT_MS = 5 * 60 * 1000;
const USER_MESSAGE = '"type":"user.message"';

function readRange(fd: number, start: number, end: number): Buffer {
  const buffer = Buffer.allocUnsafe(Math.max(0, end - start));
  let got = 0;
  while (got < buffer.length) {
    const n = readSync(fd, buffer, got, buffer.length - got, start + got);
    if (n === 0) break;
    got += n;
  }
  return buffer.subarray(0, got);
}

/**
 * 这一行是不是真人发的消息：user.message，没有 agentId（不是子 agent 收到的），source 没有、是 user 或以 command- 开头
 * （system、memory、schedule-<n>、agent-<id> 都是程序发的）。返回它的时间（Unix 毫秒），不是返回 0。
 */
export function realUserMessageAt(line: string): number {
  if (!line.includes(USER_MESSAGE)) return 0;
  try {
    const event = JSON.parse(line) as { type?: unknown; agentId?: unknown; timestamp?: unknown; data?: { source?: unknown } };
    if (event.type !== "user.message" || (event.agentId !== undefined && event.agentId !== null && event.agentId !== "")) return 0;
    const source = event.data?.source;
    const human = source === undefined || source === null || source === "" || source === "user" || (typeof source === "string" && source.startsWith("command-"));
    if (!human || typeof event.timestamp !== "string") return 0;
    const at = Date.parse(event.timestamp);
    return Number.isFinite(at) ? at : 0;
  } catch {
    return 0;
  }
}

/** 文件里最后一个完整行的结尾位置（第一个字节在它之后）：最后一行可能还没写完。 */
function completeLinesEnd(fd: number, size: number): number {
  const last = readRange(fd, Math.max(0, size - 1), size);
  if (last.length === 0 || last[0] === 0x0a) return size;
  const windowStart = Math.max(0, size - PARTIAL_LINE_WINDOW);
  const window = readRange(fd, windowStart, size);
  const newline = window.lastIndexOf(0x0a);
  return newline < 0 ? windowStart : windowStart + newline + 1;
}

interface UserScan {
  ino: bigint;
  /** 已经看过的位置（总在一行的开头）。 */
  pos: number;
  at: number;
}

/**
 * 每个 session 里真人最近一次发言的时间。第一次从文件末尾往前一块一块读，直到找到一条（最多往前 32 MB）；之后只读新增的部分，
 * 文件没变就不碰。用 events.jsonl 的路径做键。
 */
export class LastUserMessages {
  readonly #scans = new Map<string, UserScan>();

  /** 没有发言、文件不存在或读不了是 0。 */
  lastAt(path: string): number {
    let fd: number;
    try {
      fd = openSync(path, "r");
    } catch {
      this.#scans.delete(path);
      return 0;
    }
    try {
      const stat = fstatSync(fd, { bigint: true });
      const size = Number(stat.size);
      const known = this.#scans.get(path);
      if (known && known.ino === stat.ino && size >= known.pos) {
        if (size === known.pos) return known.at;
        const start = Math.max(known.pos, size - MAX_INCREMENT_BYTES);
        const chunk = readRange(fd, start, size);
        const lastNewline = chunk.lastIndexOf(0x0a);
        if (lastNewline < 0) return known.at;
        for (const line of chunk.subarray(0, lastNewline + 1).toString("utf8").split("\n")) known.at = Math.max(known.at, realUserMessageAt(line));
        known.pos = start + lastNewline + 1;
        return known.at;
      }
      const scan = this.#scanBackward(fd, size, stat.ino);
      this.#scans.set(path, scan);
      return scan.at;
    } catch {
      return 0;
    } finally {
      closeSync(fd);
    }
  }

  #scanBackward(fd: number, size: number, ino: bigint): UserScan {
    const boundary = completeLinesEnd(fd, size);
    let end = boundary;
    let chunk = CHUNK_BYTES;
    let scanned = 0;
    while (end > 0 && scanned < MAX_BACKWARD_BYTES) {
      const start = Math.max(0, end - chunk);
      const bytes = readRange(fd, start, end);
      // 块开头可能是半行：丢掉第一个换行之前的部分，那一段留给下一块；块里没有完整的行（一行比块还长）就把块加大
      const firstNewline = start === 0 ? -1 : bytes.indexOf(0x0a);
      if (start > 0 && (firstNewline < 0 || start + firstNewline + 1 >= end)) {
        chunk *= 2;
        continue;
      }
      const lines = bytes.subarray(firstNewline + 1).toString("utf8").split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        const at = realUserMessageAt(lines[i]!);
        if (at > 0) return { ino, pos: boundary, at };
      }
      scanned += end - start;
      if (start === 0) break;
      end = start + firstNewline + 1;
    }
    return { ino, pos: boundary, at: 0 };
  }
}

interface ActivityScan {
  size: number;
  mtimeMs: number;
  running: number;
}

/** 每个 session 里有几个条目（子 agent 和命令）在跑，只读 events.jsonl 末尾 ACTIVITY_TAIL_BYTES，大小和修改时间没变就不重读。 */
export class SessionActivity {
  readonly #scans = new Map<string, ActivityScan>();

  /** 粗略的在跑条目数。文件读不了、最近 ACTIVITY_RECENT_MS 没有事件是 0。 */
  running(path: string, sessionId: string, now: number): number {
    let fd: number;
    try {
      fd = openSync(path, "r");
    } catch {
      this.#scans.delete(path);
      return 0;
    }
    try {
      const stat = fstatSync(fd);
      if (now - stat.mtimeMs > ACTIVITY_RECENT_MS) return 0;
      const known = this.#scans.get(path);
      if (known && known.size === stat.size && known.mtimeMs === stat.mtimeMs) return known.running;
      const start = Math.max(0, stat.size - ACTIVITY_TAIL_BYTES);
      const bytes = readRange(fd, start, stat.size);
      const firstNewline = start === 0 ? -1 : bytes.indexOf(0x0a);
      const store = new SessionStore(sessionId);
      for (const line of bytes.subarray(firstNewline + 1).toString("utf8").split("\n")) if (line !== "") store.feedLine(line);
      const running = store.agents().filter((agent) => agent.status === "running").length + store.commands().filter((command) => command.status === "running").length;
      this.#scans.set(path, { size: stat.size, mtimeMs: stat.mtimeMs, running });
      return running;
    } catch {
      return 0;
    } finally {
      closeSync(fd);
    }
  }
}
