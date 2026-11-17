import assert from "node:assert/strict";
import { test } from "node:test";
import { demoData } from "../helpers/demo-data.ts";
import type { ViewData } from "../../src/types/app.ts";
import { lineText, lineWidth } from "../../src/ui/line.ts";
import { fitHints, listHints, renderKeysLine } from "../../src/ui/views/keys.ts";
import { renderStatusNotice, renderTopLine, statusNoticeOf } from "../../src/ui/views/top.ts";
import { baseState } from "./body-support.ts";
import { command, entry } from "./views-support.ts";

const data = (over: Partial<ViewData> = {}): ViewData => ({ ...demoData(1_800_000_000_250), runningCount: 4, ...over });
const readonly = { kind: "readonly", reason: "只读：扩展没有加载" } as const;
const shape = (line: ReturnType<typeof renderTopLine>) => line.filter((s) => s.text.trim() !== "").map((s) => [s.text, s.style?.fg ?? null, s.style?.bold === true] as const);

test("top line: the bold directory name, a third-tier ›, the first-tier title; the first-tier count and third-tier tokens at the right edge", () => {
  const line = renderTopLine(data({ runningCount: 4, totalTokens: 823_000 }), 80);
  assert.equal(lineText(line), "webshop  ›  修登录失败的 bug                              4 个在跑  82.3万 token");
  assert.equal(lineWidth(line), 80);
  assert.deepEqual(shape(line), [
    ["webshop", null, true],
    ["›", "grey", false],
    ["修登录失败的 bug", null, false],
    ["4 个在跑", null, false],
    ["82.3万 token", "grey", false],
  ]);
});

test("top line: the count is third-tier at zero; no tokens means no token text", () => {
  const line = renderTopLine(data({ runningCount: 0, totalTokens: null }), 60);
  assert.equal(shape(line).at(-1)!.join(), "0 个在跑,grey,false");
  assert.equal(lineText(line).includes("token"), false);
});

test("top line: a title that does not fit is cut with …, and left out when only a few columns remain", () => {
  const long = data({ session: { sessionId: "s1", project: "webshop", title: "把登录失败的问题彻底查清楚并且修好再补上测试" } });
  assert.equal(lineText(renderTopLine(long, 60)), "webshop  ›  把登录失败的问题彻底查…   4 个在跑  82.3万 token");
  assert.equal(lineText(renderTopLine(long, 34)).startsWith("webshop"), true);
  assert.equal(lineText(renderTopLine(long, 34)).includes("›"), false);
  assert.ok(lineText(renderTopLine(long, 34)).endsWith("4 个在跑  82.3万 token"));
});

test("top line: no more read-only or not-following text, whatever the data says", () => {
  const text = lineText(renderTopLine(data({ extension: readonly, statusNotice: { tone: "attention", text: "只读：x" } }), 100));
  for (const gone of ["只读", "未跟随", "已收起结束项"]) assert.equal(text.includes(gone), false, gone);
});

test("top line: other sessions that are running come first in the right group, in second tier, and go first when the width is short", () => {
  const view = data({ otherSessions: { sessions: 3, running: 2 } });
  const wide = renderTopLine(view, 110);
  assert.ok(lineText(wide).endsWith("另有 2 个在别的 session 跑（按 s）  4 个在跑  82.3万 token"), lineText(wide));
  assert.equal(wide.find((s) => s.text.startsWith("另有"))?.style?.fg, "text2");
  assert.equal(lineWidth(wide), 110);
  // 80 列放得下左边的全部，就不丢
  assert.ok(lineText(renderTopLine(view, 90)).includes("另有 2 个"));
  // 放不下时最先去掉它，左边的标题还在
  const tight = lineText(renderTopLine(view, 60));
  assert.equal(tight.includes("另有"), false);
  assert.ok(tight.startsWith("webshop  ›  修登录失败的 bug"));
  // 没有在跑的，或者没有其他 session，不写
  assert.equal(lineText(renderTopLine(data({ otherSessions: { sessions: 3, running: 0 } }), 110)).includes("另有"), false);
  assert.equal(lineText(renderTopLine(data({ otherSessions: null }), 110)).includes("另有"), false);
});

test("top line never exceeds the pane", () => {
  const view = data({ otherSessions: { sessions: 3, running: 2 }, session: { sessionId: "s1", project: "webshop", title: "名".repeat(30) } });
  for (let cols = 0; cols <= 140; cols++) assert.ok(lineWidth(renderTopLine(view, cols)) <= cols, `${cols}`);
});

test("top line: an ended session says so on the right instead of the running count, tokens stay", () => {
  const text = lineText(renderTopLine(data({ sessionEnded: true, runningCount: 0 }), 80));
  assert.ok(text.endsWith("session 已结束  82.3万 token"), text);
  assert.equal(text.includes("个在跑"), false);
  assert.equal(lineWidth(renderTopLine(data({ sessionEnded: true }), 30)) <= 30, true);
});

test("status notice: attention is orange and muted is third-tier; a long text is cut with …", () => {
  const attention = renderStatusNotice({ tone: "attention", text: "只读：这个 session 没有加载扩展。运行 copilot-panes install 装上扩展" }, 80);
  assert.equal(lineText(attention), "只读：这个 session 没有加载扩展。运行 copilot-panes install 装上扩展");
  assert.equal(attention[0]!.style?.fg, "orange");
  const muted = renderStatusNotice({ tone: "muted", text: "已经结束" }, 40);
  assert.deepEqual(muted, [{ text: "已经结束", style: { fg: "grey" } }]);
  const cut = renderStatusNotice({ tone: "attention", text: "只读：这个 session 没有加载扩展。运行 copilot-panes install 装上扩展" }, 30);
  assert.equal(lineText(cut), "只读：这个 session 没有加载扩…");
  assert.ok(lineWidth(cut) <= 30);
});

test("status notice: only what the data gives; a read-only extension without one (an ended session) shows no second row", () => {
  const own = { tone: "muted", text: "x" } as const;
  assert.deepEqual(statusNoticeOf(data({ statusNotice: own, extension: readonly })), own);
  assert.equal(statusNoticeOf(data({ statusNotice: null, extension: readonly })), null);
  assert.equal(statusNoticeOf(data({ extension: readonly })), null);
  assert.equal(statusNoticeOf(data({ extension: { kind: "connected" } })), null);
});

const keys = (state = baseState(), e: ReturnType<typeof entry> | null = entry(), options = {}, cols = 100) => renderKeysLine(state, e, 0, cols, options);
const texts = (state = baseState(), e: ReturnType<typeof entry> | null = entry(), options = {}, cols = 100) => lineText(keys(state, e, options, cols));

test("keys line: key names are second-tier and what they do third-tier, two spaces between items", () => {
  const line = keys();
  assert.equal(lineText(line), "↑↓ 选择  Enter 进入  x 停止  z 放大  ? 帮助");
  const styled = line.filter((s) => s.text.trim() !== "");
  assert.deepEqual(styled.slice(0, 4).map((s) => [s.text, s.style?.fg]), [["↑↓", "text2"], ["选择", "grey"], ["Enter", "text2"], ["进入", "grey"]]);
});

test("keys line: the hint follows the focus and the kind of the selected entry", () => {
  const key = (focus: "list" | "content", e: ReturnType<typeof entry> | null = entry()) => texts(baseState({ focus }), e);
  assert.equal(key("content"), "Enter 发送  Esc 回名单  PgUp 翻看");
  assert.equal(key("content", command()), "Ctrl+C 中断  Esc 回名单  PgUp 翻看");
  assert.equal(key("list", command()), "↑↓ 选择  Enter 进入  x 停止  z 放大  ? 帮助");
  assert.equal(key("content", null), "↑↓ 选择  Enter 进入  x 停止  z 放大  ? 帮助");
});

test("keys line: what cannot be done is left out (ended entry, read-only)", () => {
  const line = (e: ReturnType<typeof entry>, focus: "list" | "content", readOnly = false) => texts(baseState({ focus }), e, { readOnly });
  assert.equal(line(entry({ status: "done" }), "content"), "Esc 回名单  PgUp 翻看");
  assert.equal(line(entry({ status: "cancelled" }), "content"), "Esc 回名单  PgUp 翻看");
  assert.equal(line(command({ status: "failed" }), "content"), "Esc 回名单  PgUp 翻看");
  assert.equal(line(entry({ status: "idle" }), "content"), "Enter 发送  Esc 回名单  PgUp 翻看");
  assert.equal(line(entry(), "content", true), "Esc 回名单  PgUp 翻看");
  assert.equal(line(entry(), "list", true), "↑↓ 选择  Enter 进入  z 放大  ? 帮助");
  assert.equal(line(command(), "content", true), "Ctrl+C 中断  Esc 回名单  PgUp 翻看");
});

test("keys line: not following the latest task adds 'f 跟随最新任务'; following shows nothing", () => {
  assert.equal(texts(baseState({ followLatest: false })), "↑↓ 选择  Enter 进入  x 停止  z 放大  f 跟随最新任务  ? 帮助");
  assert.equal(texts(baseState({ followLatest: true })).includes("f 跟随"), false);
  // 在内容区里敲 f 是普通文字，不写这一项
  assert.equal(texts(baseState({ followLatest: false, focus: "content" })), "Enter 发送  Esc 回名单  PgUp 翻看");
});

test("keys line: collapsed ended entries add 'c 显示已结束的'; otherwise 'c 收起已结束的' when the list has ended ones", () => {
  assert.equal(texts(baseState({ collapseEnded: true })), "↑↓ 选择  Enter 进入  x 停止  z 放大  c 显示已结束的  ? 帮助");
  assert.equal(texts(baseState(), entry(), { hasEnded: true }), "↑↓ 选择  Enter 进入  x 停止  z 放大  c 收起已结束的  ? 帮助");
  assert.equal(texts(baseState(), entry(), { hasEnded: false }).includes("c "), false);
  assert.equal(texts(baseState({ followLatest: false, collapseEnded: true })), "↑↓ 选择  Enter 进入  x 停止  z 放大  f 跟随最新任务  c 显示已结束的  ? 帮助");
});

test("keys line: when it does not fit, items go from the right and '? 帮助' goes last", () => {
  const hints = listHints(baseState({ followLatest: false, collapseEnded: true }));
  const at = (cols: number) => lineText(fitHints(hints, cols, true));
  assert.equal(at(80), "↑↓ 选择  Enter 进入  x 停止  z 放大  f 跟随最新任务  c 显示已结束的  ? 帮助");
  assert.equal(at(60), "↑↓ 选择  Enter 进入  x 停止  z 放大  f 跟随最新任务  ? 帮助");
  assert.equal(at(38), "↑↓ 选择  Enter 进入  x 停止  ? 帮助");
  assert.equal(at(20), "↑↓ 选择  ? 帮助");
  assert.equal(at(6), "? 帮助");
  assert.equal(lineText(fitHints(hints, 3, true)).length <= 3, true);
  // 内容区的提示没有“? 帮助”，直接从右边去
  assert.equal(lineText(fitHints([["Enter", "发送"], ["Esc", "回名单"], ["PgUp", "翻看"]], 22)), "Enter 发送  Esc 回名单");
  for (let cols = 0; cols < 90; cols++) assert.ok(lineWidth(fitHints(hints, cols, true)) <= cols, `${cols}`);
});

test("keys line: the x and Ctrl+C confirmations are orange and go away when they expire", () => {
  const e = entry();
  const stop = baseState({ confirmStop: { key: e.key, until: 2000 } });
  const armed = renderKeysLine(stop, e, 1000, 80);
  assert.equal(lineText(armed), "再按一次 x 停止 fix-login");
  assert.equal(armed[0]!.style?.fg, "orange");
  assert.equal(lineText(renderKeysLine(stop, e, 2000, 80)), "↑↓ 选择  Enter 进入  x 停止  z 放大  ? 帮助");
  assert.equal(lineText(renderKeysLine(stop, entry({ key: "agent:other" }), 1000, 80)), "↑↓ 选择  Enter 进入  x 停止  z 放大  ? 帮助");

  const quit = baseState({ quitArmedUntil: 2000 });
  assert.equal(lineText(renderKeysLine(quit, e, 1000, 80)), "再按一次 Ctrl+C 退出");
  assert.equal(renderKeysLine(quit, e, 1000, 80)[0]!.style?.fg, "orange");
});

test("keys line: a Notice moves here only when its own row is missing; overlays and search have their own hints", () => {
  const notice = baseState({ notice: { text: "已发给 fix-login", tone: "info", until: 5000 } });
  assert.equal(lineText(renderKeysLine(notice, entry(), 0, 80)).startsWith("↑↓ 选择"), true);
  assert.equal(lineText(renderKeysLine(notice, entry(), 0, 80, { noticeVisible: false })), "已发给 fix-login");
  assert.equal(lineText(renderKeysLine(notice, entry(), 5000, 80, { noticeVisible: false })).startsWith("↑↓ 选择"), true);
  const error = baseState({ notice: { text: "扩展没有回应", tone: "error", until: 5000 } });
  assert.equal(renderKeysLine(error, entry(), 0, 80, { noticeVisible: false })[0]!.style?.fg, "red");

  assert.equal(lineText(renderKeysLine(baseState({ overlay: "help" }), entry(), 0, 80)), "Esc 或 ? 关闭");
  assert.equal(lineText(renderKeysLine(baseState({ overlay: "sessions" }), entry(), 0, 80)), "↑↓ 选择  Enter 切换  Esc 取消");
  const search = baseState({ search: { query: { text: "x", cursor: 1 }, editing: true, index: 0 } });
  assert.equal(lineText(renderKeysLine(search, entry(), 0, 80)), "Enter 搜索  Esc 取消");
});

test("keys line is cut to the pane width", () => {
  assert.equal(lineText(renderKeysLine(baseState({ focus: "content" }), entry(), 0, 14)), "Enter 发送");
  assert.equal(lineText(renderKeysLine(baseState({ focus: "content" }), entry(), 0, 8)), "Enter …");
  assert.ok(lineWidth(renderKeysLine(baseState(), entry(), 0, 1)) <= 1);
});
