import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionChoice } from "../../src/types/app.ts";
import { lineText, lineWidth } from "../../src/ui/line.ts";
import { HELP_GROUPS, helpWindow, renderHelp } from "../../src/ui/views/help.ts";
import { PICKER_AUTO, formatAgo, renderSessionPicker } from "../../src/ui/views/sessions.ts";
import { WAITING_HELP, WAITING_TEXT, WAITING_TITLE, renderWaiting } from "../../src/ui/views/waiting.ts";
import { frameText } from "../../src/ui/line.ts";

const helpText = (readOnly: boolean, width: number, rows: number) => renderHelp(readOnly, width, rows).map(lineText);

test("waiting screen: a bold title and a third-tier explanation at about a third of the height, 'q 退出' on the last row, no cursor", () => {
  const frame = renderWaiting({ cols: 80, rows: 22 });
  const lines = frameText(frame).split("\n");
  assert.equal(lines.length, 22);
  assert.equal(lines[6], "  " + WAITING_TITLE);
  assert.equal(lines[7], "  " + WAITING_HELP);
  assert.deepEqual(frame.lines[6], [{ text: "  " + WAITING_TITLE, style: { bold: true } }]);
  assert.deepEqual(frame.lines[7], [{ text: "  " + WAITING_HELP, style: { fg: "grey" } }]);
  assert.equal(lines[21], "  q 退出");
  assert.deepEqual(frame.lines[21]!.filter((s) => s.text.trim() !== ""), [
    { text: "q", style: { fg: "text2" } },
    { text: "退出", style: { fg: "grey" } },
  ]);
  assert.equal(frame.cursor, null);
});

test("waiting screen: a narrow pane wraps the sentence without losing any of it", () => {
  const frame = renderWaiting({ cols: 30, rows: 10 });
  const lines = frameText(frame).split("\n");
  const body = lines.slice(0, 9).filter((l) => l !== "");
  assert.ok(body.length >= 3);
  assert.equal(body.join("").replace(/\s/g, ""), WAITING_TEXT.replace(/\s/g, ""));
  frame.lines.forEach((l) => assert.ok(lineWidth(l) <= 30));
  assert.equal(renderWaiting({ cols: 30, rows: 0 }).lines.length, 0);
  assert.equal(frameText(renderWaiting({ cols: 30, rows: 1 })), "  q 退出");
});

test("help: at 80 columns and 22 rows all three groups and every key fit, in two columns", () => {
  const lines = helpText(false, 80, 22);
  const text = lines.join("\n");
  assert.ok(lines.length <= 22);
  for (const group of HELP_GROUPS) {
    assert.ok(text.includes(group.title), group.title);
    for (const item of group.items) assert.ok(text.includes(item.keys), item.keys);
  }
  assert.ok(!text.includes("下面还有"), "nothing is cut");
  assert.ok(lines[1]!.includes("选择") && lines[1]!.includes("Enter / → / Tab") === false, "two items on one row");
  assert.ok(lines.some((l) => l.includes("Ctrl+C") && l.includes("中断")));
});

test("help: a narrow pane gets one column with the longer explanations when they fit, and room to spare shows the footers", () => {
  const lines = helpText(false, 60, 60);
  const text = lines.join("\n");
  assert.ok(text.includes("停止选中的条目（2 秒内再按一次确认）"));
  assert.ok(text.includes("鼠标：点名单的一行选中它"));
  assert.equal(lines.filter((l) => l === "").length >= 2, true, "blank rows between the groups");
  assert.ok(lines.every((l) => l.length === 0 || l.startsWith("  ")));
});

test("help: a pane too short for it scrolls, every line can be reached, and the last row says how many are above and below", () => {
  const fits = helpWindow(false, 50, 1000);
  assert.equal(fits.scrollable, false);
  const full = fits.lines.map(lineText);
  const top = helpWindow(false, 50, 10);
  assert.equal(top.scrollable, true);
  assert.equal(top.total, full.length);
  assert.equal(top.lines.length, 10);
  assert.deepEqual(top.lines.slice(0, 9).map(lineText), full.slice(0, 9));
  assert.equal(lineText(top.lines[9]!), `  ↓ 下面还有 ${full.length - 9} 行  ↑↓ PgUp PgDn 翻看`);
  assert.equal(top.lines[9]![0]!.style?.fg, "grey");

  const middle = helpWindow(false, 50, 10, 5);
  assert.deepEqual(middle.lines.slice(0, 9).map(lineText), full.slice(5, 14));
  assert.equal(lineText(middle.lines[9]!), `  ↑ 上面 5 行  ↓ 下面 ${full.length - 14} 行  ↑↓ PgUp PgDn 翻看`);

  const bottom = helpWindow(false, 50, 10, 1_000_000);
  assert.equal(bottom.scroll, bottom.maxScroll);
  assert.deepEqual(bottom.lines.slice(0, 9).map(lineText), full.slice(-9));
  assert.equal(lineText(bottom.lines[9]!), `  ↑ 上面还有 ${full.length - 9} 行  ↑↓ PgUp PgDn 翻看`);
  assert.equal(helpWindow(false, 50, 10, -4).scroll, 0);

  // 一页一页翻下去，每一行都看得到
  const seen = new Set<string>();
  for (const at of [...Array.from({ length: Math.ceil(bottom.maxScroll / 8) }, (_, i) => i * 8), bottom.maxScroll]) {
    helpWindow(false, 50, 10, at).lines.slice(0, 9).forEach((l) => seen.add(lineText(l)));
  }
  full.forEach((line) => assert.ok(seen.has(line), line));
});

test("help: the position row gets shorter when the pane is narrow and never exceeds it", () => {
  const narrow = helpWindow(false, 24, 8, 3).lines.at(-1)!;
  assert.ok(lineWidth(narrow) <= 24);
  assert.ok(lineText(narrow).includes("↑") && lineText(narrow).includes("↓"));
  const tiny = helpWindow(false, 8, 8, 3).lines.at(-1)!;
  assert.ok(lineWidth(tiny) <= 8);
  assert.equal(helpWindow(false, 30, 1).lines.length, 1);
  assert.equal(helpWindow(false, 30, 0).lines.length, 0);
});

test("help: group titles are bold first-tier, key names second-tier and what they do third-tier", () => {
  const lines = renderHelp(false, 80, 40);
  assert.deepEqual(lines[0]!.filter((s) => s.text.trim() !== ""), [{ text: "名单里", style: { bold: true } }]);
  const first = lines[1]!.filter((s) => s.text.trim() !== "");
  assert.deepEqual(first.slice(0, 2).map((s) => [s.text.trim(), s.style?.fg]), [["↑↓ / j k", "text2"], ["选择", "grey"]]);
  const titles = lines.filter((l) => l[1]?.style?.bold).map(lineText);
  assert.deepEqual(titles, ["  名单里", "  子 agent 的内容区里", "  命令的内容区里"]);
});

test("help: read-only adds the orange explanation with the two commands first", () => {
  const lines = renderHelp(true, 80, 40);
  assert.equal(lineText(lines[0]!), "  扩展没有加载，只能看，不能发消息、停止、转后台。");
  assert.equal(lines[0]![1]!.style?.fg, "orange");
  assert.ok(lineText(lines[1]!).includes("copilot-panes install"));
  assert.ok(lineText(lines[1]!).includes("copilot-panes doctor"));
});

test("help never exceeds the pane", () => {
  for (const readOnly of [false, true]) {
    for (let width = 0; width <= 120; width += 3) {
      for (const rows of [0, 1, 5, 12, 20, 40]) {
        const lines = renderHelp(readOnly, width, rows);
        assert.ok(lines.length <= rows);
        lines.forEach((l) => assert.ok(lineWidth(l) <= width, `${width}x${rows}`));
      }
    }
  }
});

test("formatAgo: seconds, minutes, hours, days; nothing when there is no event time", () => {
  const ago = (ms: number) => formatAgo(10_000_000_000, 10_000_000_000 - ms);
  assert.deepEqual([3_000, 9_999, 10_000, 59_000, 60_000, 11 * 60_000, 3 * 3_600_000, 50 * 3_600_000].map(ago), [
    "刚刚",
    "刚刚",
    "10 秒前",
    "59 秒前",
    "1 分钟前",
    "11 分钟前",
    "3 小时前",
    "2 天前",
  ]);
  assert.equal(formatAgo(1000, 0), "");
  assert.equal(formatAgo(1000, 5000), "刚刚");
});

const NOW = 10_000_000_000;
const choice = (over: Partial<SessionChoice> = {}): SessionChoice => ({
  sessionId: "abcdef1234567890",
  title: "修登录失败的 bug",
  cwd: "/home/x/webshop",
  lastEventAt: NOW - 3000,
  current: false,
  ...over,
});
const picker = (sessions: SessionChoice[], highlighted: number, width = 80, rows = 12) => renderSessionPicker(sessions, highlighted, NOW, width, rows);

test("session picker: a title, one row per session and 'restore auto' last; current has a dot, the highlighted one a bar and bold", () => {
  const sessions = [choice({ current: true, runningCount: 4 }), choice({ sessionId: "12345678abcdef", title: null, cwd: "/home/x/api", lastEventAt: NOW - 700_000, runningCount: 0 })];
  const lines = picker(sessions, 1);
  assert.equal(lines.length, 4);
  assert.equal(lineText(lines[0]!), "选择 session（● 是当前显示的）");
  assert.deepEqual(lines[0], [{ text: "选择 session（● 是当前显示的）", style: { bold: true } }]);
  assert.ok(lineText(lines[1]!).startsWith(" ● 修登录失败的 bug"));
  assert.ok(lineText(lines[1]!).endsWith("webshop       刚刚  4 个在跑"));
  assert.ok(lineText(lines[2]!).startsWith("▌  12345678"));
  assert.ok(lineText(lines[2]!).trimEnd().endsWith("api      11 分钟前"));
  assert.ok(lineText(lines[3]!).startsWith("   " + PICKER_AUTO));

  // 高亮的一行：整行铺底色到最右一列，色块是藤紫·亮，名字粗体，文字提一档；其余的行没有底色
  assert.equal(lineWidth(lines[2]!), 80);
  assert.ok(lines[2]!.every((s) => s.style?.bg === "selFocus"));
  assert.deepEqual(lines[2]![0], { text: "▌", style: { fg: "violet", bg: "selFocus" } });
  assert.ok(lines[2]!.find((s) => s.text.startsWith("12345678"))?.style?.bold);
  assert.equal(lines[2]!.find((s) => s.text.trim() === "api")?.style?.fg, "text2", "third-tier text is lifted to second tier");
  for (const plain of [lines[1]!, lines[3]!]) assert.ok(plain.every((s) => s.style?.bg === undefined));
  assert.equal(lines[1]!.find((s) => s.text.trim() === "webshop")?.style?.fg, "grey");

  const auto = picker(sessions, 2);
  assert.ok(lineText(auto[3]!).startsWith("▌  " + PICKER_AUTO));
  assert.ok(lineText(picker(sessions, 99)[3]!).startsWith("▌"), "an index past the end lands on the last row");
});

test("session picker: without runningCount there is no such column, and with no sessions only the restore row is there", () => {
  assert.ok(!lineText(picker([choice()], 0)[1]!).includes("在跑"));
  assert.deepEqual(picker([], 0).map((l) => lineText(l).trimEnd()), ["选择 session（● 是当前显示的）", "▌  恢复自动选择  跟着最近有动静的 session"]);
  assert.deepEqual(picker([], 0, 80, 1).map((l) => lineText(l).trimEnd()), ["▌  恢复自动选择  跟着最近有动静的 session"]);
  assert.deepEqual(picker([], 0, 80, 0), []);
});

test("session picker: more sessions than rows are paged and the highlighted one is on screen", () => {
  const sessions = Array.from({ length: 20 }, (_, i) => choice({ sessionId: `s${String(i).padStart(7, "0")}`, title: `session-${i}` }));
  for (const highlighted of [0, 4, 5, 11, 19, 20]) {
    const lines = picker(sessions, highlighted, 80, 6).map(lineText);
    assert.equal(lines.length, 6);
    assert.equal(lines.filter((l) => l.startsWith("▌")).length, 1, `highlighted ${highlighted}`);
  }
});

test("session picker: narrow panes drop the directory, the running count and the time in that order; no row is too wide", () => {
  const sessions = [choice({ runningCount: 2 })];
  const at = (width: number) => lineText(picker(sessions, 0, width)[1]!);
  assert.ok(at(80).includes("webshop") && at(80).includes("2 个在跑") && at(80).includes("刚刚"));
  assert.ok(at(40).includes("webshop") && at(40).includes("2 个在跑") && at(40).includes("刚刚"));
  assert.ok(!at(34).includes("webshop") && at(34).includes("2 个在跑") && at(34).includes("刚刚"));
  assert.ok(!at(28).includes("在跑") && at(28).includes("刚刚"));
  assert.ok(!at(20).includes("刚刚"));
  for (let width = 0; width <= 100; width++) picker(sessions, 0, width).forEach((l) => assert.ok(lineWidth(l) <= width, `${width}`));
});
