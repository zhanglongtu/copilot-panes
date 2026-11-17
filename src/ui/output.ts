// 输出层：把一帧画到终端上。和上一帧逐行比较，只重写变了的行；用备用屏幕；退出时恢复终端。

import { constants } from "node:os";
import type { Clock, Timers } from "../types/clock.ts";
import type { Frame, Theme } from "../types/ui.ts";
import { lineToAnsi, moveTo, SEQ } from "./ansi.ts";

/** 终端输出的最小接口（process.stdout 满足它）。测试用一个把写入攒成字符串的假对象。 */
export interface TerminalOutput {
  write(data: string): unknown;
}

/**
 * 纯函数：从上一帧到下一帧要写的转义串。规则：
 * - prev 为 null，或两帧行数不同：清屏后整帧重画（空行不写）。
 * - 否则只重画内容（片段和样式）变了的行：移到行首，写这一行的 lineToAnsi，再写“清到行尾”。
 *   （tmux 里整行写满之后再发“清到行尾”不会擦掉最后一个字，已在 tmux 3.4 里验证。）
 * - 最后放光标：next.cursor 不为 null 时移过去并显示光标，为 null 时隐藏光标（和上一帧一样就不重复写）。
 *   光标原来是显示的，又要重画行时，先隐藏、画完再显示，免得光标在画的过程中到处跳。
 * - 两帧完全相同时返回 ""。
 */
export function diffFrames(prev: Frame | null, next: Frame, theme: Theme): string {
  let body = "";
  if (prev === null || prev.lines.length !== next.lines.length) {
    body += SEQ.clearScreen;
    next.lines.forEach((line, row) => {
      const ansi = lineToAnsi(line, theme);
      if (ansi !== SEQ.reset) body += moveTo(row, 0) + ansi;
    });
  } else {
    next.lines.forEach((line, row) => {
      const ansi = lineToAnsi(line, theme);
      if (ansi !== lineToAnsi(prev.lines[row]!, theme)) body += moveTo(row, 0) + ansi + SEQ.clearToLineEnd;
    });
  }

  const wasShown = prev !== null && prev.cursor !== null;
  const hideWhileDrawing = body !== "" && wasShown;
  let out = hideWhileDrawing ? SEQ.cursorHide + body : body;
  const cursor = next.cursor;
  if (cursor !== null) {
    const moved = body !== "" || prev === null || prev.cursor === null || prev.cursor.row !== cursor.row || prev.cursor.col !== cursor.col;
    if (moved) out += moveTo(cursor.row, cursor.col);
    if (!wasShown || hideWhileDrawing) out += SEQ.cursorShow;
  } else if (!hideWhileDrawing && (prev === null || prev.cursor !== null)) {
    out += SEQ.cursorHide;
  }
  return out;
}

/** 管终端：进出备用屏幕、记住上一帧、画新的一帧。 */
export class Screen {
  private output: TerminalOutput;
  private theme: Theme;
  private previous: Frame | null = null;
  private entered = false;
  private left = false;

  constructor(output: TerminalOutput, theme: Theme) {
    this.output = output;
    this.theme = theme;
  }

  /** 进入：备用屏幕、隐藏光标、打开鼠标和括号粘贴。raw 模式由调用方（src/runtime.ts）对 stdin 设置。 */
  enter(): void {
    if (this.entered) return;
    this.entered = true;
    this.previous = null;
    this.output.write(SEQ.altScreenOn + SEQ.cursorHide + SEQ.mouseOn + SEQ.pasteOn);
  }

  /** 退出：关鼠标和括号粘贴、显示光标、重置样式、离开备用屏幕。多次调用只做一次。进程异常退出时也要调用。 */
  leave(): void {
    if (!this.entered || this.left) return;
    this.left = true;
    try {
      this.output.write(SEQ.syncEnd + SEQ.mouseOff + SEQ.pasteOff + SEQ.cursorShow + SEQ.reset + SEQ.altScreenOff);
    } catch {
      // 终端已经没了（pane 被关掉），没有什么可恢复的。
    }
  }

  /** 画一帧（diffFrames 的结果一次写出，外面包同步输出的转义码）。 */
  draw(frame: Frame): void {
    if (this.left) return;
    const diff = diffFrames(this.previous, frame, this.theme);
    this.previous = frame;
    if (diff !== "") this.output.write(SEQ.syncBegin + diff + SEQ.syncEnd);
  }

  /** 忘掉上一帧，下次 draw 整帧重画（pane 改尺寸、换主题之后）。 */
  invalidate(): void {
    this.previous = null;
  }

  setTheme(theme: Theme): void {
    this.theme = theme;
    this.previous = null;
  }
}

export interface GuardProcess {
  on(event: string, listener: (...args: any[]) => void): unknown;
  removeListener(event: string, listener: (...args: any[]) => void): unknown;
  exit(code?: number): unknown;
}

export interface GuardOptions {
  /** 默认是真的 process。 */
  proc?: GuardProcess;
  /**
   * 收到 SIGINT、SIGTERM、SIGHUP 时调用（调用方自己收尾并退出）。不传时：先 screen.leave()，再以 128 加信号编号退出。
   * 传了的话，调用方的收尾里要调用 screen.leave()。
   */
  onSignal?: (signal: "SIGINT" | "SIGTERM" | "SIGHUP") => void;
}

const GUARDED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

/**
 * 让终端在任何退出方式下都被恢复：进程退出（含 process.exit）、没捕获的异常（Node 先通知再打印错误，所以错误会打在恢复后的屏幕上）、
 * 收到 SIGINT、SIGTERM、SIGHUP。返回取消这些监听的函数。
 */
export function installTerminalGuard(screen: Screen, options: GuardOptions = {}): () => void {
  const proc: GuardProcess = options.proc ?? process;
  const onExit = () => screen.leave();
  const handlers: [string, (...args: any[]) => void][] = [
    ["exit", onExit],
    ["uncaughtExceptionMonitor", onExit],
  ];
  for (const signal of GUARDED_SIGNALS) {
    handlers.push([
      signal,
      () => {
        if (options.onSignal) return options.onSignal(signal);
        screen.leave();
        proc.exit(128 + constants.signals[signal]);
      },
    ]);
  }
  for (const [event, listener] of handlers) proc.on(event, listener);
  return () => {
    for (const [event, listener] of handlers) proc.removeListener(event, listener);
  };
}

/**
 * 合并重画请求：request() 可以随便调用，实际的 draw 回调两次之间至少隔 minIntervalMs（FRAME_MIN_INTERVAL_MS，约 30 帧每秒）。
 * 距上次画已经超过间隔时立刻画（同一轮事件循环里的多次请求只画一次）；否则排一个定时器到间隔满时画。
 */
export class FrameScheduler {
  private drawFrame: () => void;
  private clock: Clock;
  private timers: Timers;
  private minIntervalMs: number;
  private timer: unknown = null;
  private lastDrawAt: number | null = null;
  private stopped = false;

  constructor(draw: () => void, clock: Clock, timers: Timers, minIntervalMs: number) {
    this.drawFrame = draw;
    this.clock = clock;
    this.timers = timers;
    this.minIntervalMs = minIntervalMs;
  }

  request(): void {
    if (this.stopped || this.timer !== null) return;
    const wait = this.lastDrawAt === null ? 0 : Math.max(0, this.lastDrawAt + this.minIntervalMs - this.clock.now());
    this.timer = this.timers.setTimeout(() => {
      this.timer = null;
      this.lastDrawAt = this.clock.now();
      this.drawFrame();
    }, wait);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) this.timers.clearTimeout(this.timer);
    this.timer = null;
  }
}
