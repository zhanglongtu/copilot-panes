// 界面快照：用固定的演示数据和固定的时刻，在三种尺寸下各画三帧（焦点在名单、焦点在子 agent 内容区、焦点在命令内容区），
// 纯文字的结果存在 test/ui/snapshots/*.txt，样式（颜色语义名、粗体、底色）按下面 LOOKS 表逐项断言。
// 改了界面之后，用 UPDATE_SNAPSHOTS=1 node --import ./test/helpers/isolate-home.ts --test test/ui/snapshot.test.ts 重新生成快照，再看 git diff 确认变化是想要的。

import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { DEMO_KEYS, demoData } from "../helpers/demo-data.ts";
import type { AppState } from "../../src/types/app.ts";
import type { ListEntry } from "../../src/types/model.ts";
import type { ColorRole, Frame, Line, Size, Span } from "../../src/types/ui.ts";
import { frameText, lineText, lineWidth } from "../../src/ui/line.ts";
import { THEMES } from "../../src/ui/theme.ts";
import { renderFrame } from "../../src/ui/views/frame.ts";
import { computeLayout } from "../../src/ui/views/layout.ts";
import { progressOf } from "../../src/ui/views/list.ts";
import { baseState } from "./body-support.ts";
import { actualColors, contrast } from "./color-support.ts";

/** 转动符号停在 ⠹ 的时刻，一切用时按它反推。 */
const NOW = 1_800_000_000_250;
const DATA = demoData(NOW, { settled: true });
/** 演示里 review（等你发话）和 migrate-db（失败）还没看过，其余看过了。 */
const UNREAD = new Set([DEMO_KEYS.review, DEMO_KEYS.migrateDb]);

const SIZES: Size[] = [
  { cols: 110, rows: 40 },
  { cols: 80, rows: 24 },
  { cols: 50, rows: 20 },
];
type View = "list" | "agent" | "command";
const VIEWS: Record<View, Partial<AppState>> = {
  list: { focus: "list", selected: DEMO_KEYS.fixLogin },
  agent: { focus: "content", selected: DEMO_KEYS.fixLogin },
  command: { focus: "content", selected: DEMO_KEYS.score },
};

const stateOf = (view: View): AppState => baseState({ ...VIEWS[view], unread: UNREAD });
const snapshotUrl = (size: Size, view: View) => new URL(`./snapshots/${size.cols}x${size.rows}-${view}.txt`, import.meta.url);

type Fg = ColorRole | undefined;
interface Look {
  symbol: Fg;
  name: Fg;
  bold: boolean;
  model: Fg;
  time: Fg;
  tokens: Fg;
  step: Fg;
  /** 行首的橙色未读点。 */
  unread?: true;
}

const look = (symbol: Fg, name: Fg, bold: boolean, rest: { model: Fg; time: Fg; tokens: Fg }, step: Fg, unread?: true): Look => ({ symbol, name, bold, ...rest, step, ...(unread ? { unread } : {}) });
const GREY_ALL = { model: "grey", time: "grey", tokens: "grey" } as const;
const TEXT2_ALL = { model: "text2", time: "text2", tokens: "text2" } as const;
const RUNNING = (kind: "violet" | "cyan") => look(kind, kind, true, { model: "grey", time: undefined, tokens: "grey" }, undefined);

/** 演示里每个条目（按 ListEntry.name）该有的样子。 */
const LOOKS: Record<string, Look> = {
  "find-bug": look("grey", "grey", false, GREY_ALL, "grey"),
  "write-docs": look("violetDim", "text2", false, GREY_ALL, "grey"),
  "fix-login": RUNNING("violet"),
  "run-tests": RUNNING("violet"),
  "pytest -v tests/": RUNNING("cyan"),
  review: look("violet", undefined, false, TEXT2_ALL, "text2", true),
  "migrate-db": look("red", "text2", false, GREY_ALL, "text2", true),
  "python3 -u score.py --run nov15": RUNNING("cyan"),
  "npm run build": look("redDim", "grey", false, GREY_ALL, "grey"),
};

/** 选中的行里文字提一档：三档变二档，二档变一档，暗色的符号变亮。 */
const lift = (fg: Fg): Fg => (fg === "grey" ? "text2" : fg === "text2" ? undefined : fg === "violetDim" ? "violet" : fg === "cyanDim" ? "cyan" : fg === "redDim" ? "red" : fg);

const blank = (s: Span) => s.text.trim() === "";
const shape = (s: Span) => ({ text: s.text, fg: s.style?.fg, bold: s.style?.bold === true });
const spansOf = (line: Line) => line.filter((s) => !blank(s));

function checkListRow(line: Line, entry: ListEntry, selected: boolean, focus: "list" | "content", cols: number): void {
  const expect = LOOKS[entry.name];
  assert.ok(expect, `no expectation for ${entry.name}`);
  const kind: ColorRole = entry.kind === "command" ? "cyan" : "violet";
  const tone = (fg: Fg) => (selected ? lift(fg) : fg);
  const spans = spansOf(line);
  const got = spans.map(shape) as { text: string; fg: Fg; bold: boolean }[];
  const label = `${entry.name} (${selected ? "selected" : "not selected"}, ${cols} columns)`;
  let at = 0;
  const next = () => {
    const s = got[at++];
    assert.ok(s, `${label}: a column is missing`);
    return s;
  };

  if (selected) assert.deepEqual(next(), { text: "▌", fg: kind, bold: false }, `${label}: block`);
  else if (expect.unread) assert.deepEqual(next(), { text: "•", fg: "orange", bold: false }, `${label}: unread dot`);

  const symbol = next();
  assert.ok(/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏○✗✓⊘◌]$/.test(symbol.text), `${label}: symbol ${symbol.text}`);
  assert.equal(symbol.fg, tone(expect.symbol), `${label}: symbol colour`);
  assert.equal(symbol.bold, false, `${label}: symbol is not bold`);

  const name = next();
  assert.ok(name.text.includes(entry.name.slice(0, 6)), `${label}: name ${name.text}`);
  assert.equal(name.fg, tone(expect.name), `${label}: name colour`);
  assert.equal(name.bold, selected || expect.bold, `${label}: name weight`);

  if (cols >= 60 && entry.kind === "agent" && entry.model) assert.equal(next().fg, tone(expect.model), `${label}: model`);
  assert.equal(next().fg, tone(expect.time), `${label}: time`);
  if (cols >= 48 && entry.tokens !== null) assert.equal(next().fg, tone(expect.tokens), `${label}: tokens`);

  const bar = entry.kind === "command" && entry.status === "running" && cols >= 80 && progressOf(entry.step) !== null;
  if (bar) {
    const progress = next();
    assert.match(progress.text, /^▰*▱*$/, `${label}: progress bar`);
    assert.equal(progress.text.length, 10);
    assert.equal(progress.fg, "cyan", `${label}: the progress bar is bright cyan`);
  }
  assert.equal(next().fg, tone(expect.step), `${label}: last step`);
  assert.equal(at, got.length, `${label}: nothing else on the row`);

  // 底色：选中的行整行铺，其余的行一点都没有
  if (selected) {
    const bg: ColorRole = focus === "list" ? "selFocus" : "selBlur";
    assert.ok(line.every((s) => s.style?.bg === bg), `${label}: every span has the ${bg} background`);
    assert.equal(lineWidth(line), cols, `${label}: the colour runs to the last column`);
  } else {
    assert.ok(line.every((s) => s.style?.bg === undefined), `${label}: no background`);
  }
}

function checkFrame(frame: Frame, size: Size, view: View): void {
  const { cols, rows } = size;
  const state = stateOf(view);
  const layout = computeLayout(state, DATA, size);
  const entry = DATA.entries.find((e) => e.key === state.selected)!;
  const kind: ColorRole = entry.kind === "command" ? "cyan" : "violet";
  const focusOnContent = state.focus === "content";
  const frameColor: ColorRole = focusOnContent ? kind : kind === "cyan" ? "cyanDim" : "violetDim";
  const dimColor: ColorRole = kind === "cyan" ? "cyanDim" : "violetDim";
  const label = `${cols}x${rows} ${view}`;

  assert.equal(frame.lines.length, rows, `${label}: the pane's rows`);
  frame.lines.forEach((line, row) => assert.ok(lineWidth(line) <= cols, `${label} row ${row} is ${lineWidth(line)} columns wide: ${lineText(line)}`));

  // 对比度：每个文字在它的底色上不低于 4.0:1，深色和浅色主题都要
  for (const theme of [THEMES.dark, THEMES.light]) {
    frame.lines.forEach((line, row) => {
      for (const s of spansOf(line)) {
        const { fg, bg } = actualColors(s, theme);
        assert.ok(contrast(fg, bg) >= 4.0, `${label} ${theme.name} row ${row}: "${s.text}" has contrast ${contrast(fg, bg).toFixed(2)}`);
      }
    });
  }

  // 全屏唯一的底色条是选中的那一行
  const painted = frame.lines.flatMap((line, row) => (line.some((s) => s.style?.bg !== undefined) ? [row] : []));
  const selectedRow = layout.listTop + layout.selectedIndex - layout.listOffset;
  assert.deepEqual(painted, [selectedRow], `${label}: the selected row is the only one with a background`);

  // 顶行
  const top = spansOf(frame.lines[0]!);
  assert.deepEqual(shape(top[0]!), { text: "webshop", fg: undefined, bold: true }, `${label}: the directory name is bold`);
  assert.deepEqual(top.filter((s) => s.text === "›").map(shape), [{ text: "›", fg: "grey", bold: false }]);
  assert.equal(top.find((s) => s.text.endsWith("个在跑"))?.style?.fg, undefined, `${label}: a running count above zero is first-tier`);
  assert.equal(top.find((s) => s.text.endsWith("token"))?.style?.fg, "grey");
  assert.equal(top.some((s) => s.style?.bold && s !== top[0]), false, `${label}: only the directory name is bold on the top row`);

  // 名单
  DATA.entries.forEach((e, index) => {
    const row = layout.listTop + index - layout.listOffset;
    if (index < layout.listOffset || row >= layout.listTop + layout.listRows) return;
    checkListRow(frame.lines[row]!, e, e.key === state.selected, state.focus, cols);
  });
  if (layout.hintRow >= 0) {
    const hint = frame.lines[layout.hintRow]!;
    for (const s of spansOf(hint)) assert.equal(s.style?.fg, s.text.includes("在跑") ? "text2" : "grey", `${label}: hint colour of "${s.text}"`);
  }

  // 半框：标题行、竖线、输入行上面的分隔线
  const title = frame.lines[layout.titleRow]!;
  assert.ok(lineText(title).startsWith(focusOnContent ? "┏━ " : "┌─ "), `${label}: title row starts the half frame`);
  assert.equal(lineWidth(title), cols, `${label}: the title line runs to the last column`);
  assert.deepEqual(title[0]!.style, { fg: frameColor }, `${label}: frame colour`);
  const lineChar = focusOnContent ? "━" : "─";
  const last = title.at(-1)!;
  assert.ok(last.text.endsWith(lineChar) && last.style?.fg === frameColor, `${label}: the title line ends with the frame's line`);
  const name = title.find((s) => s.style?.bold);
  assert.ok(name && name.text.includes(entry.name.slice(0, 6)) && name.style?.fg === kind, `${label}: the name in the title is bold ${kind}`);
  assert.equal(title.filter((s) => s.style?.bold).length, 1, `${label}: only the name is bold in the title`);
  const status = title.find((s) => s.style?.fg === "text2");
  assert.match(status?.text ?? "", /^(在跑|等你发话|已结束|失败|已取消|已停)/, `${label}: status and time are second-tier`);
  if (cols >= 80 && entry.kind === "agent") {
    assert.equal(title.find((s) => s.text === entry.model)?.style?.fg, "grey", `${label}: the model is third-tier`);
  }

  const bar = focusOnContent ? "┃" : "│";
  for (let row = layout.contentTop; row < layout.inputTop + layout.inputRows; row++) {
    if (row === layout.dividerRow) continue;
    assert.deepEqual(frame.lines[row]![0], { text: bar, style: { fg: frameColor } }, `${label}: bar on row ${row}`);
    assert.equal(frame.lines[row]![1]?.text.startsWith(" ") ?? true, true);
  }
  const divider = frame.lines[layout.dividerRow]!;
  assert.deepEqual(divider, [{ text: (focusOnContent ? "┠" : "├") + "─".repeat(cols - 1), style: { fg: dimColor } }], `${label}: the divider is thin, dim and runs to the last column`);

  // 按键提示：键名二档，说明三档
  const keys = spansOf(frame.lines[layout.keysRow]!);
  assert.ok(keys.length >= 2 && keys.every((s) => s.style?.fg === "text2" || s.style?.fg === "grey"), `${label}: key hints`);
  assert.equal(keys[0]!.style?.fg, "text2");
}

for (const size of SIZES) {
  for (const view of ["list", "agent", "command"] as const) {
    test(`snapshot ${size.cols}x${size.rows}, ${view}: text equals the stored file and every style follows the design`, () => {
      const frame = renderFrame(stateOf(view), DATA, size);
      const text = frameText(frame) + "\n";
      const url = snapshotUrl(size, view);
      if (process.env.UPDATE_SNAPSHOTS === "1") {
        mkdirSync(new URL("./snapshots/", import.meta.url), { recursive: true });
        writeFileSync(url, text);
      }
      assert.equal(text, readFileSync(url, "utf8"), "run UPDATE_SNAPSHOTS=1 node --import ./test/helpers/isolate-home.ts --test test/ui/snapshot.test.ts if the change is wanted");
      checkFrame(frame, size, view);
    });
  }
}
