import assert from "node:assert/strict";
import { test } from "node:test";
import { INPUT_MAX_ROWS } from "../../src/constants.ts";
import type { AppState } from "../../src/types/app.ts";
import { lineText, lineWidth } from "../../src/ui/line.ts";
import {
  COMMAND_NO_INPUT_NOTICE,
  renderInputLines,
  renderNoticeLine,
} from "../../src/ui/views/input.ts";
import { baseState, entryOf } from "./body-support.ts";

const AGENT = entryOf();
const draftState = (text: string, cursor = text.length, over: Partial<AppState> = {}): AppState =>
  baseState({ focus: "content", selected: AGENT.key, drafts: new Map([[AGENT.key, { text, cursor }]]), ...over });
const text = (line: readonly { text: string }[]) => line.map((s) => s.text).join("");

test("a sub-agent's empty input shows the grey hint that fits its state", () => {
  const state = baseState({ focus: "content" });
  const running = renderInputLines(AGENT, state, false, 80);
  assert.equal(lineText(running.lines[0]!), "› 插一句话给 fix-login，它做完手上这一步就会看到");
  assert.deepEqual(running.lines[0]!.map((s) => s.style), [{ fg: "violet" }, { fg: "grey" }]);
  assert.deepEqual(running.cursor, { row: 0, col: 2 });

  const idle = renderInputLines(entryOf({ status: "idle" }), state, false, 80);
  assert.equal(lineText(idle.lines[0]!), "› 给 fix-login 发消息，它会接着做");

  for (const status of ["done", "failed", "stopped"] as const) {
    const ended = renderInputLines(entryOf({ status }), state, false, 80);
    assert.equal(lineText(ended.lines[0]!), "fix-login 已经结束，不能再发消息");
    assert.deepEqual(ended.lines[0]!.map((s) => s.style), [{ fg: "grey" }]);
    assert.equal(ended.cursor, null);
  }

  const readOnly = renderInputLines(AGENT, state, true, 80);
  assert.equal(lineText(readOnly.lines[0]!), "只读，不能发消息：扩展没有加载");
  assert.deepEqual(readOnly.lines[0]!.map((s) => s.style), [{ fg: "orange" }]);
  assert.equal(readOnly.cursor, null);

  const withCause = renderInputLines(AGENT, state, true, 80, undefined, "这个 session 启动时还没装扩展");
  assert.equal(lineText(withCause.lines[0]!), "只读，不能发消息：这个 session 启动时还没装扩展");
  const runningCommand = renderInputLines(entryOf({ kind: "command", key: "cmd:c1", id: "c1", name: "npm run build" }), state, true, 80, undefined, "x");
  assert.equal(lineText(runningCommand.lines[0]!), "只读，不能中断：x");
});

test("a hint that does not fit is cut with … and never exceeds the width", () => {
  for (const width of [8, 20, 33]) {
    const { lines } = renderInputLines(AGENT, baseState({ focus: "content" }), false, width);
    assert.equal(lines.length, 1);
    assert.ok(lineWidth(lines[0]!) <= width);
    assert.ok(lineText(lines[0]!).endsWith("…"));
  }
});

test("the cursor is hidden unless the focus is in the content area with no overlay", () => {
  assert.equal(renderInputLines(AGENT, draftState("你好", 2, { focus: "list" }), false, 40).cursor, null);
  assert.equal(renderInputLines(AGENT, draftState("你好", 2, { overlay: "help" }), false, 40).cursor, null);
  assert.deepEqual(renderInputLines(AGENT, draftState("你好", 2), false, 40).cursor, { row: 0, col: 6 });
});

test("the cursor row and column are right with Chinese text and wrapped rows (a Chinese character is 2 columns)", () => {
  // 内容宽 12，减去“› ”还剩 10 列，每行放 5 个汉字。
  const cases: { text: string; cursor: number; rows: string[]; at: { row: number; col: number } }[] = [
    { text: "你好", cursor: 1, rows: ["› 你好"], at: { row: 0, col: 4 } },
    { text: "ab你好", cursor: 3, rows: ["› ab你好"], at: { row: 0, col: 6 } },
    { text: "你好世界你好世界", cursor: 8, rows: ["› 你好世界你", "  好世界"], at: { row: 1, col: 8 } },
    { text: "你好世界你好世界", cursor: 2, rows: ["› 你好世界你", "  好世界"], at: { row: 0, col: 6 } },
    { text: "你好世界你好世界", cursor: 6, rows: ["› 你好世界你", "  好世界"], at: { row: 1, col: 4 } },
    // 光标在刚好占满的一行末尾时，落到下一行行首。
    { text: "你好世界你", cursor: 5, rows: ["› 你好世界你", ""], at: { row: 1, col: 2 } },
    { text: "第一行\n第二行", cursor: 7, rows: ["› 第一行", "  第二行"], at: { row: 1, col: 8 } },
  ];
  for (const c of cases) {
    const { lines, cursor } = renderInputLines(AGENT, draftState(c.text, c.cursor), false, 12);
    assert.deepEqual(lines.map(text), c.rows, c.text);
    assert.deepEqual(cursor, c.at, `${c.text} @${c.cursor}`);
    assert.ok(lines.every((line) => lineWidth(line) <= 12));
  }
});

test("the box grows upward to at most 6 rows and keeps the cursor row inside it", () => {
  const long = "字".repeat(100);
  const { lines, cursor } = renderInputLines(AGENT, draftState(long), false, 12);
  assert.equal(lines.length, INPUT_MAX_ROWS);
  assert.ok(cursor && cursor.row >= 0 && cursor.row < lines.length);
  assert.ok(lines.every((line) => lineWidth(line) <= 12));
  assert.equal(renderInputLines(AGENT, draftState("一\n二\n三"), false, 12).lines.length, 3);
});

test("a command that runs shows the Ctrl+C hint, and after a signal the escalation hint with a countdown", () => {
  const cmd = entryOf({ key: "cmd:c1", kind: "command", name: "sleep 100" });
  const state = baseState({ focus: "content", selected: cmd.key });
  const idle = renderInputLines(cmd, state, false, 80, 5000);
  assert.equal(lineText(idle.lines[0]!), "Ctrl+C 中断这条命令");
  assert.equal(idle.cursor, null);

  type Signal = "SIGINT" | "SIGTERM" | "SIGKILL";
  const sent = (signal: Signal) => baseState({ focus: "content", interrupts: new Map([[cmd.key, { signal, at: 10_000 }]]) });
  const hint = (signal: Signal, now?: number) => lineText(renderInputLines(cmd, sent(signal), false, 80, now).lines[0]!);
  assert.equal(hint("SIGINT", 10_000), "已发中断信号。3 秒后还在运行的话，再按一次 Ctrl+C 强制结束");
  assert.equal(hint("SIGINT", 11_500), "已发中断信号。2 秒后还在运行的话，再按一次 Ctrl+C 强制结束");
  assert.equal(hint("SIGINT", 13_000), "还在运行，再按一次 Ctrl+C 强制结束");
  assert.equal(hint("SIGTERM", 11_000), "已发终止信号。2 秒后还在运行的话，再按一次 Ctrl+C 强杀");
  assert.equal(hint("SIGTERM", 20_000), "还在运行，再按一次 Ctrl+C 强杀");
  assert.equal(hint("SIGKILL", 10_500), "已发强杀信号，等它退出");
  assert.equal(hint("SIGINT"), "已发中断信号。还在运行的话，再按一次 Ctrl+C 强制结束");

  const readOnly = renderInputLines(cmd, state, true, 80);
  assert.equal(lineText(readOnly.lines[0]!), "只读，不能中断：扩展没有加载");
  assert.deepEqual(readOnly.lines[0]!.map((s) => s.style), [{ fg: "orange" }]);
});

test("a command that ended says how: exit code in red for a failure, grey when interrupted", () => {
  const ended = (over: Parameters<typeof entryOf>[0], state = baseState({ focus: "content" })) =>
    renderInputLines(entryOf({ key: "cmd:c1", kind: "command", name: "npm run build", ...over }), state, false, 80, 0).lines[0]!;

  const failed = ended({ status: "failed", exitCode: 1, elapsedMs: 12_000 });
  assert.equal(lineText(failed), "已退出，退出码 1，用时 12s");
  assert.deepEqual(failed.map((s) => s.style), [{ fg: "grey" }, { fg: "red" }, { fg: "grey" }]);

  const ok = ended({ status: "done", exitCode: 0, elapsedMs: 3000 });
  assert.equal(lineText(ok), "已退出，退出码 0，用时 3s");
  assert.deepEqual(ok.map((s) => s.style), [{ fg: "grey" }, { fg: "grey" }, { fg: "grey" }]);

  const byCode = ended({ status: "failed", exitCode: 130, elapsedMs: 65_000 });
  assert.equal(lineText(byCode), "已中断，退出码 130，用时 1m05s");
  assert.deepEqual(byCode.map((s) => s.style), [{ fg: "grey" }, { fg: "grey" }, { fg: "grey" }]);

  const stopped = ended({ status: "stopped", exitCode: null, elapsedMs: 5000 });
  assert.equal(lineText(stopped), "已中断，用时 5s");

  const marked = baseState({ interrupts: new Map([["cmd:c1", { signal: "SIGINT" as const, at: 1 }]]) });
  assert.equal(lineText(ended({ status: "failed", exitCode: 2, elapsedMs: 5000 }, marked)), "已中断，退出码 2，用时 5s");
  assert.equal(lineText(ended({ status: "failed", exitCode: null, elapsedMs: 5000 })), "已失败，用时 5s");
});

test("while editing a search the input line is the search box with its own cursor", () => {
  const search = { query: { text: "你好", cursor: 1 }, editing: true, index: 0 };
  const { lines, cursor } = renderInputLines(AGENT, baseState({ focus: "content", search }), false, 40);
  assert.equal(lineText(lines[0]!), "/ 你好");
  assert.deepEqual(cursor, { row: 0, col: 4 });
  const cmd = entryOf({ key: "cmd:c1", kind: "command" });
  assert.equal(lineText(renderInputLines(cmd, baseState({ focus: "content", search }), false, 40).lines[0]!), "/ 你好");
  assert.equal(renderInputLines(null, baseState(), false, 40).lines.length, 1);
});

test("the line above the input shows the notice, then the search state, then how far up you scrolled", () => {
  const scroll = { below: 12, fresh: 5 };
  assert.deepEqual(renderNoticeLine(baseState(), 100, 40), []);

  const notice = baseState({ notice: { text: "已发给 fix-login", tone: "info", until: 200 } });
  assert.equal(lineText(renderNoticeLine(notice, 100, 40, scroll)), "已发给 fix-login");
  assert.deepEqual(renderNoticeLine(notice, 100, 40)[0]!.style, { fg: "grey" });
  const failed = baseState({ notice: { text: "扩展没有回应", tone: "error", until: 200 } });
  assert.deepEqual(renderNoticeLine(failed, 100, 40)[0]!.style, { fg: "red" });
  assert.equal(lineText(renderNoticeLine(notice, 200, 40, scroll)), "↓ 还有 5 行新内容");

  assert.equal(lineText(renderNoticeLine(baseState(), 0, 40, { below: 12, fresh: 0 })), "↓ 下面还有 12 行");
  assert.deepEqual(renderNoticeLine(baseState(), 0, 40, { below: 0, fresh: 0 }), []);

  const searching = baseState({ search: { query: { text: "bug", cursor: 3 }, editing: false, index: 1, matches: 4 } });
  assert.equal(lineText(renderNoticeLine(searching, 0, 40, scroll)), "/ bug  第 2/4 个");
  const none = baseState({ search: { query: { text: "bug", cursor: 3 }, editing: false, index: 0, matches: 0 } });
  assert.equal(lineText(renderNoticeLine(none, 0, 40)), "/ bug  没有匹配");

  assert.equal(COMMAND_NO_INPUT_NOTICE, "这条命令不接受输入，只能中断");
  assert.ok(lineWidth(renderNoticeLine(notice, 0, 6)) <= 6);
});

test("an orphaned agent or command shows that the session has ended, whatever the read-only state", () => {
  for (const readOnly of [false, true]) {
    const agent = renderInputLines(entryOf({ status: "stopped", orphaned: true }), baseState({ focus: "content" }), readOnly, 80);
    assert.equal(lineText(agent.lines[0]!), "这个 session 已经结束");
    assert.deepEqual(agent.lines[0]!.map((s) => s.style), [{ fg: "grey" }]);
    assert.equal(agent.cursor, null);
    const cmd = renderInputLines(entryOf({ kind: "command", key: "cmd:c1", id: "c1", status: "stopped", orphaned: true }), baseState({ focus: "content" }), readOnly, 80);
    assert.equal(lineText(cmd.lines[0]!), "这个 session 已经结束");
  }
});
