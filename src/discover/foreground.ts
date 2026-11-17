// 前台线索：用户在 Copilot CLI 里正看着哪个 session。扩展的接口没有可靠办法知道，所以从两处旁证读：
// - 进程日志 <COPILOT_HOME>/logs/process-<启动毫秒>-<进程号>.log 里的 “Registering foreground session: <ID>”：切换 session 时写。
// - Copilot CLI 所在 tmux pane 的标题：“<当前 session 的名字> - GitHub Copilot”。
// 这两处都是旁证，不保证可靠。选哪个 session 的规则在 choose.ts（纯函数），这里只读线索。

import { closeSync, fstatSync, openSync, readSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ForegroundHint } from "../types/session.ts";
import type { TmuxRunner } from "./tmux.ts";

const CHUNK_BYTES = 1024 * 1024;
const MAX_BACKWARD_BYTES = 16 * 1024 * 1024;
const MAX_INCREMENT_BYTES = 8 * 1024 * 1024;
const PARTIAL_LINE_WINDOW = 64 * 1024;
/** 找不到某个进程的日志文件时，隔这么久再列一次目录。 */
const RELIST_MS = 10_000;
// session ID 是 UUID；要求写全 36 个字符，没写完的半行不会被当成一条记录。
const MARKER = /\[INFO\] (Registering|Unregistering) foreground session: ([0-9a-fA-F-]{36})/g;
export const COPILOT_TITLE_SUFFIX = " - GitHub Copilot";
// 终端控制码和方向控制符：pane 标题谁都能设，不能原样当作文字用。
const CONTROL = /[\x00-\x1f\x7f-\x9f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g;

interface Followed {
  path: string | null;
  ino: bigint | null;
  /** 已经读到的位置（总在一行的开头）。 */
  pos: number;
  /** 日志里最后登记的前台 session；最后一件事是注销它（后面没有接着登记别的）时是 null。 */
  session: string | null;
  checkedAt: number;
  started: boolean;
}

/** 按顺序扫一段文字里的登记和注销，接在 from 后面。seen 表示这段里有没有登记或注销。 */
function applyMarkers(text: string, from: string | null): { session: string | null; seen: boolean } {
  let session = from;
  let seen = false;
  for (const match of text.matchAll(MARKER)) {
    seen = true;
    if (match[1] === "Registering") session = match[2]!;
    else if (session === match[2]) session = null;
  }
  return { session, seen };
}

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
 * 跟着读 Copilot CLI 进程日志里的前台 session。第一次从文件末尾往前一块一块读，直到找到登记记录（最多往前 16 MB）；
 * 之后只读新增的部分。日志文件按进程号找（process-*-<pid>.log，同一个进程号取启动时刻最新的），找不到时每 10 秒再列一次目录。
 */
export class ForegroundLog {
  readonly #logsDir: string;
  readonly #files = new Map<number, Followed>();

  constructor(logsDir: string) {
    this.#logsDir = logsDir;
  }

  /** 这个进程的日志里最后登记的前台 session 的 ID；读不到或没有登记记录是 null。 */
  foreground(pid: number, now: number): string | null {
    let state = this.#files.get(pid);
    if (!state) {
      state = { path: null, ino: null, pos: 0, session: null, checkedAt: Number.NEGATIVE_INFINITY, started: false };
      this.#files.set(pid, state);
    }
    try {
      if (state.path === null) {
        if (now >= state.checkedAt && now - state.checkedAt < RELIST_MS) return null;
        state.checkedAt = now;
        state.path = this.#find(pid);
        if (state.path === null) return null;
      }
      this.#update(state);
    } catch {
      state.path = null;
      state.started = false;
      state.session = null;
    }
    return state.session;
  }

  #find(pid: number): string | null {
    const wanted = new RegExp(`^process-(\\d+)-${pid}\\.log$`);
    let best: { name: string; startedMs: number } | null = null;
    for (const name of readdirSync(this.#logsDir)) {
      const match = wanted.exec(name);
      if (!match) continue;
      const startedMs = Number(match[1]);
      if (best === null || startedMs > best.startedMs) best = { name, startedMs };
    }
    return best === null ? null : join(this.#logsDir, best.name);
  }

  #update(state: Followed): void {
    const fd = openSync(state.path!, "r");
    try {
      const stat = fstatSync(fd, { bigint: true });
      const size = Number(stat.size);
      if (state.started && (state.ino !== stat.ino || size < state.pos)) state.started = false;
      state.ino = stat.ino;
      if (!state.started) {
        this.#firstRead(fd, size, state);
        return;
      }
      if (size === state.pos) return;
      const start = Math.max(state.pos, size - MAX_INCREMENT_BYTES);
      const chunk = readRange(fd, start, size);
      const lastNewline = chunk.lastIndexOf(0x0a);
      if (lastNewline < 0) return;
      state.session = applyMarkers(chunk.subarray(0, lastNewline + 1).toString("utf8"), state.session).session;
      state.pos = start + lastNewline + 1;
    } finally {
      closeSync(fd);
    }
  }

  #firstRead(fd: number, size: number, state: Followed): void {
    state.session = null;
    for (let end = size, scanned = 0; end > 0 && scanned < MAX_BACKWARD_BYTES; ) {
      const start = Math.max(0, end - CHUNK_BYTES);
      // 往后多读一点，免得一条记录正好被块的边界切开
      const found = applyMarkers(readRange(fd, start, Math.min(size, end + 512)).toString("utf8"), null);
      if (found.seen) {
        state.session = found.session;
        break;
      }
      scanned += end - start;
      end = start;
    }
    // 位置放在最后一个换行之后：最后一行可能还没写完，下次从它的开头读
    const windowStart = Math.max(0, size - PARTIAL_LINE_WINDOW);
    const window = readRange(fd, windowStart, size);
    const newline = window.lastIndexOf(0x0a);
    state.pos = window.length > 0 && window[window.length - 1] === 0x0a ? size : newline < 0 ? windowStart : windowStart + newline + 1;
    state.started = true;
  }
}

/** pane 标题去掉 “ - GitHub Copilot” 后缀和控制字符后的名字；不是 Copilot CLI 设的标题（没有后缀）或没有名字时是 null。 */
export function sessionNameFromPaneTitle(paneTitle: string): string | null {
  const clean = paneTitle.replace(CONTROL, "").trim();
  if (!clean.endsWith(COPILOT_TITLE_SUFFIX)) return null;
  const name = clean.slice(0, -COPILOT_TITLE_SUFFIX.length).trim();
  return name === "" ? null : name;
}

/** 读 pane 的标题（只读：tmux display-message -p）；出错返回 null。 */
export async function readPaneTitle(paneId: string, run: TmuxRunner): Promise<string | null> {
  try {
    return (await run(["display-message", "-p", "-t", paneId, "#{pane_title}"])).replace(/\n$/, "");
  } catch {
    return null;
  }
}

/** 日志线索：每个有登记记录的进程一条。 */
export function logHints(pids: readonly number[], log: ForegroundLog, now: number): ForegroundHint[] {
  const hints: ForegroundHint[] = [];
  for (const pid of pids) {
    const sessionId = log.foreground(pid, now);
    if (sessionId !== null) hints.push({ kind: "log", copilotPid: pid, sessionId });
  }
  return hints;
}

/** 标题线索：每个知道 pane 的进程一条。 */
export async function titleHints(panesByPid: Readonly<Record<number, string>>, pids: readonly number[], run: TmuxRunner): Promise<ForegroundHint[]> {
  const hints: ForegroundHint[] = [];
  for (const pid of pids) {
    const pane = panesByPid[pid];
    if (pane === undefined) continue;
    const title = await readPaneTitle(pane, run);
    const name = title === null ? null : sessionNameFromPaneTitle(title);
    if (name !== null) hints.push({ kind: "title", copilotPid: pid, title: name });
  }
  return hints;
}

/** 把线索合成一个字符串：两次相同说明前台没变。 */
export function hintsSignature(hints: readonly ForegroundHint[]): string {
  return hints.map((hint) => (hint.kind === "log" ? `log:${hint.copilotPid}:${hint.sessionId}` : `title:${hint.copilotPid}:${hint.title}`)).join("|");
}
