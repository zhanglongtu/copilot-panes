import assert from "node:assert/strict";
import { test } from "node:test";
import { DEMO_KEYS, demoData } from "../helpers/demo-data.ts";
import type { AppState, ViewData } from "../../src/types/app.ts";
import { frameText, lineText, lineWidth } from "../../src/ui/line.ts";
import { renderFrame } from "../../src/ui/views/frame.ts";
import { computeLayout } from "../../src/ui/views/layout.ts";
import { spinnerFrameAt } from "../../src/ui/views/rowkit.ts";
import { WAITING_TEXT } from "../../src/ui/views/waiting.ts";
import { baseState } from "./body-support.ts";

/** 转动符号停在 ⠹（第 2 帧）的时刻。 */
const NOW = 1_800_000_000_250;
const DATA = demoData(NOW, { settled: true });
const UNREAD = new Set([DEMO_KEYS.review, DEMO_KEYS.migrateDb]);

const listState = (): AppState => baseState({ focus: "list", selected: DEMO_KEYS.fixLogin, unread: UNREAD });
const commandState = (): AppState => baseState({ focus: "content", selected: DEMO_KEYS.score, unread: UNREAD });
const rows = (state: AppState, data: ViewData, cols: number, height = 24) => frameText(renderFrame(state, data, { cols, rows: height })).split("\n");

test("the spinner stands on ⠹ at the frozen time", () => {
  assert.equal(spinnerFrameAt(NOW), 2);
});

test("the unread entries have a dot in column 0 and the selected one a block; nothing else on the list has a background", () => {
  const frame = renderFrame(listState(), DATA, { cols: 80, rows: 24 });
  const text = frameText(frame).split("\n");
  assert.deepEqual(
    text.slice(1, 9).map((line) => line.slice(0, 1)),
    [" ", " ", "▌", " ", " ", "•", "•", " "],
  );
  const painted = frame.lines.flatMap((line, row) => (line.some((s) => s.style?.bg !== undefined) ? [row] : []));
  assert.deepEqual(painted, [3]);
  const blurred = renderFrame({ ...listState(), focus: "content" }, DATA, { cols: 80, rows: 24 });
  assert.equal(blurred.lines[3]![0]!.style?.bg, "selBlur", "the background is dimmer when the keyboard is in the content");
  assert.equal(frame.lines[3]![0]!.style?.bg, "selFocus");
});

test("the cursor sits in the input box only when the keyboard is in an agent's content", () => {
  const size = { cols: 80, rows: 24 };
  assert.equal(renderFrame(listState(), DATA, size).cursor, null);
  assert.equal(renderFrame(commandState(), DATA, size).cursor, null);

  const state = baseState({ focus: "content", selected: DEMO_KEYS.fixLogin });
  const at = renderFrame(state, DATA, size);
  assert.deepEqual(at.cursor, { row: computeLayout(state, DATA, size).inputTop, col: 4 });

  const draft = { text: "你好\nab", cursor: 5 };
  const typed = baseState({ focus: "content", selected: DEMO_KEYS.fixLogin, drafts: new Map([[DEMO_KEYS.fixLogin, draft]]) });
  const tall = renderFrame(typed, DATA, size);
  const layout = computeLayout(typed, DATA, size);
  assert.equal(layout.inputRows, 2);
  assert.equal(layout.contentRows, 9);
  assert.deepEqual(tall.cursor, { row: layout.inputTop + 1, col: 2 + 2 + 2 });
  const lines = frameText(tall).split("\n");
  assert.equal(lines.length, 24);
  assert.equal(lines[layout.dividerRow]!.slice(0, 2), "┠─");
  assert.equal(lines[layout.inputTop], "┃ › 你好");
  assert.equal(lines[layout.inputTop + 1], "┃   ab");
});

test("below 20 rows, or after z, no list is shown: the title row follows the top row and ends with the position", () => {
  for (const [state, height] of [
    [listState(), 19],
    [{ ...listState(), zoom: true }, 24],
  ] as const) {
    const lines = rows(state, DATA, 80, height);
    assert.equal(lines.length, height);
    assert.ok(lines[0]!.startsWith("webshop"));
    assert.ok(lines[1]!.startsWith("┌─ fix-login  修登录失败的 bug  medium-1.0  在跑 2m14s ─"), String(lines[1]));
    assert.ok(lines[1]!.endsWith("─ 第 3 个，共 9 个"), String(lines[1]));
    assert.ok(lines[2]!.startsWith("│ 任务："), "the content starts right after the title");
  }
  const zoomed = computeLayout({ ...listState(), zoom: true }, DATA, { cols: 80, rows: 24 });
  assert.equal(zoomed.listRows, 0);
  assert.equal(zoomed.contentRows, 18);
  const single = { ...DATA, entries: DATA.entries.slice(0, 1) };
  const alone = rows(baseState({ selected: single.entries[0]!.key, zoom: true }), single, 80);
  assert.equal(alone[1]!.includes("第 1 个"), false, "one entry needs no position");
});

test("with more entries than rows the list pages, keeps the selection in view and says how many are hidden", () => {
  const entries = Array.from({ length: 30 }, (_, i) => ({ ...DATA.entries[0]!, key: `agent:n${i}`, id: `n${i}`, name: `agent-${i}` }));
  const many = { ...DATA, entries };
  const state = baseState({ selected: "agent:n25" });
  const lines = rows(state, many, 60, 20);
  const layout = computeLayout(state, many, { cols: 60, rows: 20 });
  assert.equal(layout.listRows, 5);
  assert.equal(layout.listOffset, 25);
  assert.deepEqual(
    lines.slice(1, 6).map((l) => l.slice(0, 12).trim()),
    ["▌ ✓ agent-25", "✓ agent-26", "✓ agent-27", "✓ agent-28", "✓ agent-29"],
  );
  assert.equal(lines[6], "  ↑ 上面还有 25 个");

  const top = rows(baseState({ selected: "agent:n0" }), many, 60, 20);
  assert.equal(top[6], "  ↓ 下面还有 25 个");
  assert.ok(top[7]!.startsWith("┌─ agent-0"), "the title row follows the hint row");
});

test("hidden entries that are running are counted in the hint, and the hint is second tier", () => {
  const frame = renderFrame(listState(), DATA, { cols: 80, rows: 24 });
  assert.equal(lineText(frame.lines[8]!), "  ↓ 下面还有 2 个，其中 1 个在跑");
  assert.equal(frame.lines[8]![1]!.style?.fg, "text2");
});

test("collapsed ended entries: the list ends with a third-tier line saying how many and how to show them", () => {
  const entries = DATA.entries.filter((e) => e.status !== "done" && e.status !== "failed");
  const lines = rows(baseState({ selected: DEMO_KEYS.fixLogin, collapseEnded: true }), { ...DATA, entries }, 80);
  assert.equal(lines[7], "  … 收起了 3 个已结束的，按 c 显示");
  assert.ok(lines[8]!.startsWith("┌─ fix-login"));
  const frame = renderFrame(baseState({ selected: DEMO_KEYS.fixLogin, collapseEnded: true }), { ...DATA, entries }, { cols: 80, rows: 24 });
  assert.equal(frame.lines[7]![0]!.style?.fg, "grey");
  assert.ok(lineText(frame.lines[23]!).includes("c 显示已结束的"));
});

test("an empty list says so", () => {
  const data = { ...DATA, entries: [], runningCount: 0, totalTokens: null };
  const lines = rows(baseState({ selected: DEMO_KEYS.fixLogin }), data, 60, 12);
  assert.ok(lines[0]!.startsWith("webshop  ›  修登录失败的 bug ") && lines[0]!.endsWith(" 0 个在跑"), String(lines[0]));
  assert.equal(lineWidth([{ text: lines[0]! }]), 60);
  assert.equal(lines[1], "  还没有子 agent 或后台命令");
  assert.ok(lines.slice(2, 11).every((l) => l === ""));
});

test("read-only: an orange line under the top row says why, there is no input box and no stop hint", () => {
  const data: ViewData = {
    ...DATA,
    extension: { kind: "readonly", reason: "只读：这个 session 没加载扩展", cause: "这个 session 启动时还没装扩展" },
    statusNotice: { tone: "attention", text: "只读：这个 session 启动时还没装扩展。对它说“重新加载扩展”就能接上" },
  };
  const frame = renderFrame(listState(), data, { cols: 80, rows: 24 });
  const text = frameText(frame).split("\n");
  assert.equal(text[1], "只读：这个 session 启动时还没装扩展。对它说“重新加载扩展”就能接上");
  assert.equal(frame.lines[1]![0]!.style?.fg, "orange");
  assert.equal(text[0]!.includes("只读"), false, "the top row does not mention it");
  assert.equal(text[23], "↑↓ 选择  Enter 进入  z 放大  c 收起已结束的  ? 帮助");
  const typing = renderFrame(baseState({ focus: "content", selected: DEMO_KEYS.fixLogin }), data, { cols: 80, rows: 24 });
  assert.equal(typing.cursor, null);
  assert.equal(frameText(typing).split("\n")[22], "┃ 只读，不能发消息：这个 session 启动时还没装扩展");
  // 有提示行时名单少一行
  assert.equal(computeLayout(listState(), data, { cols: 80, rows: 24 }).listRows, 6);
});

test("a status notice from the data is shown as given: attention in orange, muted in third tier, cut with … when too long", () => {
  const muted = renderFrame(listState(), { ...DATA, statusNotice: { tone: "muted", text: "Copilot CLI 已退出" } }, { cols: 80, rows: 24 });
  assert.deepEqual(muted.lines[1], [{ text: "Copilot CLI 已退出", style: { fg: "grey" } }]);
  const long = renderFrame(listState(), { ...DATA, statusNotice: { tone: "attention", text: "这是一个很长很长的提示".repeat(5) } }, { cols: 30, rows: 24 });
  assert.ok(lineText(long.lines[1]!).endsWith("…") && lineWidth(long.lines[1]!) <= 30);
  assert.equal(long.lines[1]![0]!.style?.fg, "orange");
  const none = frameText(renderFrame(listState(), { ...DATA, statusNotice: null }, { cols: 80, rows: 24 })).split("\n");
  assert.ok(none[1]!.startsWith("  ✓ find-bug"), "no notice, no extra row");
});

test("help and the session picker replace the list and the content, and hide the cursor", () => {
  const help = renderFrame({ ...listState(), overlay: "help", focus: "content" }, DATA, { cols: 80, rows: 24 });
  const helpText = frameText(help).split("\n");
  assert.equal(helpText[0], rows(listState(), DATA, 80)[0]);
  assert.equal(helpText[1], "  名单里");
  assert.equal(helpText[23], "Esc 或 ? 关闭");
  assert.equal(help.cursor, null);

  const picker = rows({ ...listState(), overlay: "sessions", pickerIndex: 1 }, DATA, 80);
  assert.equal(picker[1], "选择 session（● 是当前显示的）");
  assert.ok(picker[2]!.startsWith(" ● 修登录失败的 bug"));
  assert.ok(picker[3]!.startsWith("▌  恢复自动选择"));
  assert.equal(picker[23], "↑↓ 选择  Enter 切换  Esc 取消");
});

test("with no session the frame is the waiting screen", () => {
  const frame = renderFrame(baseState(), { ...DATA, session: null }, { cols: 80, rows: 24 });
  const lines = frameText(frame).split("\n");
  assert.equal(lines.length, 24);
  assert.ok(lines.join("").includes(WAITING_TEXT.slice(0, 10)));
  assert.equal(lines[23], "  q 退出");
  assert.equal(frame.cursor, null);
});

test("every frame has exactly the pane's rows and no line is wider than the pane", () => {
  const readonly: ViewData = { ...DATA, extension: { kind: "readonly", reason: "只读：扩展没有加载" }, otherSessions: { sessions: 2, running: 1 } };
  const states: [string, AppState, ViewData][] = [
    ["list", listState(), DATA],
    ["content", commandState(), DATA],
    ["agent content", baseState({ focus: "content", selected: DEMO_KEYS.fixLogin }), DATA],
    ["zoom", { ...listState(), zoom: true }, DATA],
    ["help", { ...listState(), overlay: "help" }, DATA],
    ["sessions", { ...listState(), overlay: "sessions" }, DATA],
    ["modes", { ...listState(), followLatest: false, collapseEnded: true }, readonly],
    ["waiting", baseState(), { ...DATA, session: null }],
  ];
  for (const [name, state, view] of states) {
    for (const cols of [1, 5, 10, 20, 30, 47, 48, 49, 59, 60, 61, 80, 130]) {
      for (const height of [1, 2, 3, 4, 5, 6, 8, 12, 19, 20, 22, 24, 40]) {
        const frame = renderFrame(state, view, { cols, rows: height });
        assert.equal(frame.lines.length, height, `${name} ${cols}x${height}`);
        frame.lines.forEach((line, row) => assert.ok(lineWidth(line) <= cols, `${name} ${cols}x${height} row ${row}: ${lineText(line)}`));
      }
    }
  }
});
