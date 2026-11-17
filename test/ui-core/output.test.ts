import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import xterm from "@xterm/headless";
import type { Clock, Timers } from "../../src/types/clock.ts";
import type { Frame, Line } from "../../src/types/ui.ts";
import { lineToAnsi, moveTo, SEQ } from "../../src/ui/ansi.ts";
import { frameText, span } from "../../src/ui/line.ts";
import { diffFrames, FrameScheduler, installTerminalGuard, Screen } from "../../src/ui/output.ts";
import { THEMES } from "../../src/ui/theme.ts";

const { Terminal } = xterm;
const dark = THEMES.dark;

const frame = (lines: Line[], cursor: Frame["cursor"] = null): Frame => ({ lines, cursor });
const bar: Line = [span("┃ ", { fg: "violet" }), span("名字", { bold: true })];
const body: Line = [span("│ 内容")];

test("the first frame clears and draws everything; later frames rewrite only changed lines", () => {
  const first = frame([bar, [], body]);
  assert.equal(diffFrames(null, first, dark), SEQ.clearScreen + moveTo(0, 0) + lineToAnsi(bar, dark) + moveTo(2, 0) + lineToAnsi(body, dark) + SEQ.cursorHide);

  assert.equal(diffFrames(first, frame([bar, [], body]), dark), "");

  const changed: Line = [span("│ 新内容")];
  assert.equal(diffFrames(first, frame([bar, [], changed]), dark), moveTo(2, 0) + lineToAnsi(changed, dark) + SEQ.clearToLineEnd);

  // 十行里只变两行：输出里只出现这两行
  const many = Array.from({ length: 10 }, (_, i): Line => [span(`row-${i}`)]);
  const edited = many.map((line, i): Line => (i === 3 || i === 7 ? [span(`new-${i}`)] : line));
  const out = diffFrames(frame(many), frame(edited), dark);
  assert.equal(out, moveTo(3, 0) + lineToAnsi([span("new-3")], dark) + SEQ.clearToLineEnd + moveTo(7, 0) + lineToAnsi([span("new-7")], dark) + SEQ.clearToLineEnd);
  assert.ok(!out.includes("row-"));

  // 只有样式变了也要重写；片段切分不同但画出来一样就不写
  const restyled = diffFrames(frame([[span("ab")]]), frame([[span("ab", { fg: "red" })]]), dark);
  assert.equal(restyled, moveTo(0, 0) + lineToAnsi([span("ab", { fg: "red" })], dark) + SEQ.clearToLineEnd);
  assert.equal(diffFrames(frame([[span("a"), span("b")]]), frame([[span("ab")]]), dark), "");
  assert.equal(diffFrames(frame([[span("ab")]]), frame([[span("a\x1bb")]]), dark), "");

  // 行数变了（pane 改了大小）：清屏整帧重画
  const resized = diffFrames(first, frame([bar, body]), dark);
  assert.equal(resized, SEQ.clearScreen + moveTo(0, 0) + lineToAnsi(bar, dark) + moveTo(1, 0) + lineToAnsi(body, dark));
});

test("the cursor is shown at the frame's cursor or hidden when it is null", () => {
  const withCursor = frame([bar, body], { row: 1, col: 4 });
  const first = diffFrames(null, withCursor, dark);
  assert.ok(first.endsWith(moveTo(1, 4) + SEQ.cursorShow));

  // 光标没动、内容没变：什么也不写
  assert.equal(diffFrames(withCursor, frame([bar, body], { row: 1, col: 4 }), dark), "");
  // 只有光标动了：只移光标
  assert.equal(diffFrames(withCursor, frame([bar, body], { row: 0, col: 2 }), dark), moveTo(0, 2));
  // 光标在显示、内容变了：先藏起来，画完移回去再显示
  const edited: Line = [span("│ 内容变了")];
  assert.equal(
    diffFrames(withCursor, frame([bar, edited], { row: 1, col: 4 }), dark),
    SEQ.cursorHide + moveTo(1, 0) + lineToAnsi(edited, dark) + SEQ.clearToLineEnd + moveTo(1, 4) + SEQ.cursorShow,
  );
  // 光标没有了：隐藏，再没有就不重复写
  const hidden = frame([bar, body], null);
  assert.equal(diffFrames(withCursor, hidden, dark), SEQ.cursorHide);
  assert.equal(diffFrames(hidden, frame([bar, body], null), dark), "");
  assert.equal(diffFrames(hidden, frame([bar, edited], null), dark), moveTo(1, 0) + lineToAnsi(edited, dark) + SEQ.clearToLineEnd);
  // 光标出现：移过去并显示
  assert.equal(diffFrames(hidden, withCursor, dark), moveTo(1, 4) + SEQ.cursorShow);
  // 隐藏光标时内容变了、光标又出现
  assert.equal(
    diffFrames(hidden, frame([bar, edited], { row: 0, col: 0 }), dark),
    moveTo(1, 0) + lineToAnsi(edited, dark) + SEQ.clearToLineEnd + moveTo(0, 0) + SEQ.cursorShow,
  );
});

test("Screen enters the alternate screen, draws frames inside synchronized output and writes only what changed", () => {
  const writes: string[] = [];
  const screen = new Screen({ write: (data) => writes.push(data) }, dark);
  screen.enter();
  assert.deepEqual(writes, [SEQ.altScreenOn + SEQ.cursorHide + SEQ.mouseOn + SEQ.pasteOn]);
  screen.enter();
  assert.equal(writes.length, 1);

  const first = frame([bar, [], body], { row: 2, col: 3 });
  screen.draw(first);
  assert.equal(writes[1], SEQ.syncBegin + diffFrames(null, first, dark) + SEQ.syncEnd);
  assert.ok(writes[1]!.startsWith("\x1b[?2026h") && writes[1]!.endsWith("\x1b[?2026l"));

  screen.draw(frame([bar, [], body], { row: 2, col: 3 }));
  assert.equal(writes.length, 2, "an identical frame writes nothing");

  const changed: Line = [span("│ 只变这一行")];
  screen.draw(frame([bar, [], changed], { row: 2, col: 3 }));
  assert.equal(writes.length, 3);
  assert.ok(writes[2]!.includes("只变这一行"));
  assert.ok(!writes[2]!.includes("名字"));

  screen.invalidate();
  screen.draw(frame([bar, [], changed], { row: 2, col: 3 }));
  assert.ok(writes[3]!.includes(SEQ.clearScreen) && writes[3]!.includes("名字"), "after invalidate() the whole frame is drawn again");

  screen.setTheme(THEMES.light);
  screen.draw(frame([bar, [], changed], { row: 2, col: 3 }));
  assert.ok(writes[4]!.includes(SEQ.clearScreen) && writes[4]!.includes("38;5;56"), "a new theme redraws everything with the new colours");
});

test("leave() restores the terminal and can be called twice", () => {
  const writes: string[] = [];
  const screen = new Screen({ write: (data) => writes.push(data) }, dark);
  screen.leave();
  assert.equal(writes.length, 0, "leave() before enter() does nothing");

  screen.enter();
  screen.draw(frame([bar], { row: 0, col: 1 }));
  writes.length = 0;
  screen.leave();
  screen.leave();
  assert.equal(writes.length, 1);
  const restore = writes[0]!;
  for (const sequence of [SEQ.mouseOff, SEQ.pasteOff, SEQ.cursorShow, SEQ.reset, SEQ.altScreenOff]) assert.ok(restore.includes(sequence), JSON.stringify(sequence));
  assert.ok(restore.indexOf(SEQ.mouseOff) < restore.indexOf(SEQ.cursorShow) && restore.indexOf(SEQ.cursorShow) < restore.indexOf(SEQ.altScreenOff));
  screen.draw(frame([bar]));
  assert.equal(writes.length, 1, "nothing is drawn after leave()");

  const broken = new Screen(
    {
      write: () => {
        throw new Error("EPIPE");
      },
    },
    dark,
  );
  assert.throws(() => broken.enter());
  broken.leave();
});

/** 把输出层写出的转义串喂给 xterm.js，再读屏幕：核对真的画对了。 */
async function render(cols: number, rows: number, steps: (screen: Screen) => void) {
  const term = new Terminal({ cols, rows, allowProposedApi: true });
  const chunks: string[] = [];
  const screen = new Screen({ write: (data) => chunks.push(data) }, dark);
  steps(screen);
  await new Promise<void>((resolve) => term.write(chunks.join(""), resolve));
  const lines = Array.from({ length: rows }, (_, y) => term.buffer.active.getLine(y)?.translateToString(true) ?? "");
  const result = { lines, cursor: { x: term.buffer.active.cursorX, y: term.buffer.active.cursorY }, altScreen: term.buffer.active.type };
  term.dispose();
  return result;
}

test("what Screen writes draws the frame on a real terminal emulator, including Chinese text and the cursor", async () => {
  const f1 = frame(
    [
      [span("┃ ", { fg: "violet" }), span("fix-login", { bold: true })],
      [span("│ 你好，世界 abc")],
      [span("│ › "), span("插一句话")],
      [],
    ],
    { row: 2, col: 4 },
  );
  const f2 = frame([[span("┃ ", { fg: "violet" }), span("fix-login")], [span("│ 你好")], [span("│ › 插一句话给它")], [span("提示")]], { row: 2, col: 18 });

  const afterFirst = await render(20, 4, (screen) => {
    screen.enter();
    screen.draw(f1);
  });
  assert.equal(afterFirst.altScreen, "alternate");
  assert.deepEqual(afterFirst.lines, frameText(f1).split("\n"));
  assert.deepEqual(afterFirst.cursor, { x: 4, y: 2 });

  const afterSecond = await render(20, 4, (screen) => {
    screen.enter();
    screen.draw(f1);
    screen.draw(f2);
  });
  assert.deepEqual(afterSecond.lines, frameText(f2).split("\n"), "a shorter line leaves no old characters behind");
  assert.deepEqual(afterSecond.cursor, { x: 18, y: 2 });

  const resized = await render(20, 3, (screen) => {
    screen.enter();
    screen.draw(f1);
    screen.draw(frame([[span("a")], [span("你好")], [span("c")]], null));
  });
  assert.deepEqual(resized.lines, ["a", "你好", "c"]);

  const left = await render(20, 4, (screen) => {
    screen.enter();
    screen.draw(f1);
    screen.leave();
  });
  assert.equal(left.altScreen, "normal");
});

class FakeProcess extends EventEmitter {
  exited: number | null = null;
  exit(code?: number) {
    this.exited = code ?? 0;
  }
}

test("installTerminalGuard restores the terminal on exit, uncaught exceptions and SIGINT, SIGTERM and SIGHUP", () => {
  const cases: [string, number | null][] = [
    ["exit", null],
    ["uncaughtExceptionMonitor", null],
    ["SIGINT", 130],
    ["SIGTERM", 143],
    ["SIGHUP", 129],
  ];
  for (const [event, exitCode] of cases) {
    const writes: string[] = [];
    const screen = new Screen({ write: (data) => writes.push(data) }, dark);
    screen.enter();
    const proc = new FakeProcess();
    installTerminalGuard(screen, { proc });
    writes.length = 0;
    proc.emit(event, new Error("boom"));
    assert.equal(writes.length, 1, event);
    assert.ok(writes[0]!.includes(SEQ.altScreenOff), event);
    assert.equal(proc.exited, exitCode, event);
    proc.emit("exit");
    assert.equal(writes.length, 1, "restoring twice writes once");
  }

  // 调用方自己处理信号：输出层不抢着退出
  const writes: string[] = [];
  const screen = new Screen({ write: (data) => writes.push(data) }, dark);
  screen.enter();
  const proc = new FakeProcess();
  const seen: string[] = [];
  const remove = installTerminalGuard(screen, { proc, onSignal: (signal) => seen.push(signal) });
  proc.emit("SIGTERM");
  assert.deepEqual(seen, ["SIGTERM"]);
  assert.equal(proc.exited, null);
  assert.ok(!writes.some((w) => w.includes(SEQ.altScreenOff)));
  proc.emit("exit");
  assert.ok(writes.some((w) => w.includes(SEQ.altScreenOff)), "the exit hook still restores the terminal");

  remove();
  for (const event of ["exit", "uncaughtExceptionMonitor", "SIGINT", "SIGTERM", "SIGHUP"]) assert.equal(proc.listenerCount(event), 0, event);
});

class FakeTime implements Clock, Timers {
  time = 0;
  private items: { at: number; fn: () => void; cancelled: boolean }[] = [];
  now() {
    return this.time;
  }
  setTimeout(fn: () => void, ms: number) {
    const item = { at: this.time + ms, fn, cancelled: false };
    this.items.push(item);
    return item;
  }
  clearTimeout(handle: unknown) {
    (handle as { cancelled: boolean }).cancelled = true;
  }
  setInterval() {
    return undefined;
  }
  clearInterval() {}
  /** 往前走 ms 毫秒，到点的定时器按先后执行。 */
  advance(ms: number) {
    const target = this.time + ms;
    for (;;) {
      const due = this.items.filter((i) => !i.cancelled && i.at <= target).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.time = Math.max(this.time, due.at);
      due.cancelled = true;
      due.fn();
    }
    this.time = target;
  }
}

test("FrameScheduler draws at most once per interval and coalesces requests (fake timers)", () => {
  const time = new FakeTime();
  const drawn: number[] = [];
  const scheduler = new FrameScheduler(() => drawn.push(time.time), time, time, 33);

  // 同一轮里多次请求只画一次，而且不是当场画（等事件循环这一轮结束）
  scheduler.request();
  scheduler.request();
  scheduler.request();
  assert.deepEqual(drawn, []);
  time.advance(0);
  assert.deepEqual(drawn, [0]);

  // 太快的请求被推迟到间隔满
  time.advance(10);
  scheduler.request();
  scheduler.request();
  time.advance(22);
  assert.deepEqual(drawn, [0]);
  time.advance(1);
  assert.deepEqual(drawn, [0, 33]);

  // 画完之后又来请求：从这次画的时刻重新算间隔
  scheduler.request();
  time.advance(32);
  assert.deepEqual(drawn, [0, 33]);
  time.advance(1);
  assert.deepEqual(drawn, [0, 33, 66]);

  // 距上次画已经超过间隔：马上画（当前这一轮结束时）
  time.advance(500);
  scheduler.request();
  time.advance(0);
  assert.deepEqual(drawn, [0, 33, 66, 566]);

  // 停掉之后不再画，已排的也取消
  scheduler.request();
  scheduler.stop();
  time.advance(1000);
  scheduler.request();
  time.advance(1000);
  assert.equal(drawn.length, 4);
});
