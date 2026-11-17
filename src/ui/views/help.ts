// ? 键：全部按键的说明，盖在名单和内容区上面。Esc 或 ? 关掉。段标题粗体一档，键名二档，说明三档。

import type { Line, Span } from "../../types/ui.ts";
import { fitLine, span } from "../line.ts";
import { textWidth, wrapText } from "../width.ts";

interface HelpItem {
  keys: string;
  /** 两列排版时用的短说明。 */
  text: string;
  /** 一列排版（pane 窄）时用的详细说明；没有就用 text。 */
  long?: string;
}

interface HelpGroup {
  title: string;
  items: readonly HelpItem[];
}

export const HELP_GROUPS: readonly HelpGroup[] = [
  {
    title: "名单里",
    items: [
      { keys: "↑↓ / j k", text: "选择", long: "选上一个、下一个条目" },
      { keys: "Home g / End G", text: "到头 / 到尾", long: "选第一个 / 最后一个条目" },
      { keys: "Enter / → / Tab", text: "进入内容区" },
      { keys: "PgUp / PgDn", text: "翻看内容区", long: "不进入内容区，直接翻看它" },
      { keys: "x", text: "停止（按两次）", long: "停止选中的条目（2 秒内再按一次确认）" },
      { keys: "b", text: "转到后台", long: "把选中的前台命令转到后台" },
      { keys: "c", text: "收起已结束的", long: "收起、展开已结束的条目；收起时名单最后有一行说明" },
      { keys: "f", text: "跟随最新", long: "开关“跟随最新”：新起的条目自动选中；没在跟随时，底部提示里有“f 跟随最新任务”" },
      { keys: "z", text: "放大内容区", long: "名单收成一行，内容区占满（再按恢复）" },
      { keys: "s", text: "换 session", long: "选另一个 session，或恢复自动选择" },
      { keys: "/", text: "搜索", long: "在选中条目的内容里搜索，Enter 确定" },
      { keys: "n / N", text: "下一处 / 上一处", long: "跳到下一处 / 上一处匹配" },
      { keys: "y", text: "复制全文", long: "把全文复制到 tmux 缓冲区" },
      { keys: "o", text: "用 less 打开", long: "在弹出窗口里用 less 打开全文" },
      { keys: "e", text: "展开细节", long: "展开、收起细节：完整任务说明、工具结果、命令原文" },
      { keys: "?", text: "这份说明" },
      { keys: "q", text: "退出" },
      { keys: "Ctrl+C", text: "按两次退出" },
    ],
  },
  {
    title: "子 agent 的内容区里",
    items: [
      { keys: "Enter", text: "发送消息", long: "发送消息（它做完手上这一步就会看到）" },
      { keys: "Ctrl+J / Alt+Enter", text: "输入框换行" },
      { keys: "Esc", text: "回名单", long: "回名单（要搜索先回名单，这里 / 是普通文字）" },
      { keys: "PgUp / PgDn", text: "翻页" },
      { keys: "↑ / ↓", text: "翻看一行", long: "光标在第一行按 ↑、最后一行按 ↓ 时翻看一行" },
      { keys: "Home / End", text: "到顶 / 到底", long: "输入框是空的时候，翻到记录的最前面 / 最后面" },
      { keys: "Ctrl+C", text: "清空输入框" },
    ],
  },
  {
    title: "命令的内容区里",
    items: [
      { keys: "Ctrl+C", text: "中断（再按升级）", long: "中断；3 秒后还在跑，再按发 SIGTERM，再按发 SIGKILL" },
      { keys: "Esc", text: "回名单" },
      { keys: "↑ / ↓", text: "翻一行" },
      { keys: "PgUp / PgDn", text: "翻页" },
      { keys: "Home / End", text: "到顶 / 到底" },
      { keys: "/", text: "搜索", long: "搜索，Enter 确定" },
      { keys: "n / N", text: "下一处 / 上一处", long: "跳到下一处 / 上一处匹配" },
      { keys: "y", text: "复制全文" },
      { keys: "o", text: "用 less 打开", long: "在弹出窗口里用 less 打开全文" },
      { keys: "e", text: "看命令原文", long: "在输出上面显示命令原文（名单上的名字去掉了 cd、timeout 这些）" },
    ],
  },
];

const FOOTERS: readonly string[] = [
  "鼠标：点名单的一行选中它，点内容区进入，滚轮翻看（指针在名单上时滚轮移动选择）。",
  "没在跟随最新、收起了已结束的条目时，底部按键提示里会多一项 f、c，按它恢复。",
];

const READ_ONLY_TEXT = [
  { text: "扩展没有加载，只能看，不能发消息、停止、转后台。", color: "orange" as const },
  { text: "运行 copilot-panes install 装上扩展，再运行 copilot-panes doctor 检查。", color: "grey" as const },
];

const INDENT = 2;
const GAP = 2;

const pad = (text: string, width: number) => text + " ".repeat(Math.max(0, width - textWidth(text)));

/** 一个条目：按键列（二档）加说明（三档）。 */
function itemSpans(item: HelpItem, keyWidth: number, text: string, textWidthCols: number): Span[] {
  return [span(pad(item.keys, keyWidth), { fg: "text2" }), span(pad(text, textWidthCols), { fg: "grey" })];
}

function groupLines(group: HelpGroup, columns: 1 | 2, keyWidth: number, shortWidth: number, width: number): Line[] {
  const title: Line = [span(" ".repeat(INDENT)), span(group.title, { bold: true })];
  const out: Line[] = [title];
  if (columns === 1) {
    const room = width - INDENT - keyWidth;
    for (const item of group.items) {
      const text = item.long !== undefined && textWidth(item.long) <= room ? item.long : item.text;
      out.push([span(" ".repeat(INDENT)), ...itemSpans(item, keyWidth, text, 0)]);
    }
    return out;
  }
  const rows = Math.ceil(group.items.length / 2);
  for (let r = 0; r < rows; r++) {
    const left = group.items[r]!;
    const right = group.items[r + rows];
    const row: Span[] = [span(" ".repeat(INDENT)), ...itemSpans(left, keyWidth, left.text, shortWidth)];
    if (right) row.push(span(" ".repeat(GAP)), ...itemSpans(right, keyWidth, right.text, shortWidth));
    out.push(row);
  }
  return out;
}

export interface HelpWindow {
  /** 要画的行，最多 rows 行。 */
  lines: Line[];
  /** 帮助一共多少行（放不下、要翻看时是完整的那一份）。 */
  total: number;
  /** 放不下，要翻看：最后一行是位置提示。 */
  scrollable: boolean;
  /** 实际从第几行起（夹在合法范围内）。 */
  scroll: number;
  /** 最多能翻到第几行起；不用翻看是 0。 */
  maxScroll: number;
}

const SCROLL_KEYS = "↑↓ PgUp PgDn 翻看";

/** 翻看时最下面一行：上面、下面各还有几行，写得下的话加上怎么翻。 */
function positionLine(above: number, below: number, width: number): Line {
  const parts = [above > 0 ? `↑ 上面${below > 0 ? " " : "还有 "}${above} 行` : "", below > 0 ? `↓ 下面${above > 0 ? " " : "还有 "}${below} 行` : ""].filter(Boolean);
  const base = parts.join("  ");
  const room = Math.max(1, width - INDENT);
  const text = [`${base}  ${SCROLL_KEYS}`, base, `${above > 0 ? `↑${above}` : ""}${above > 0 && below > 0 ? " " : ""}${below > 0 ? `↓${below}` : ""}`].find((t) => textWidth(t) <= room) ?? "";
  return text === "" ? [] : [span(" ".repeat(INDENT) + text, { fg: "grey" })];
}

/**
 * 分三段列出：名单（↑/k、↓/j、Enter/→/Tab、x、b、c、f、z、s、/、y、o、e、?、q、Ctrl+C 两次）、
 * 子 agent 的内容区（Enter、Ctrl+J 或 Alt+Enter、Esc、PgUp/PgDn、Ctrl+C）、命令的内容区（Ctrl+C 三级升级、Esc、PgUp/PgDn/Home/End、/、y、o、e）。
 * 只读时开头加一段：扩展没有加载，运行 copilot-panes install 和 copilot-panes doctor。截到 width 列。
 * 排版：pane 够宽（两列各放得下按键和短说明）时每段排两列，否则一列、用详细说明。放不下 rows 行时依次去掉末尾的补充说明、段与段之间的空行；
 * 还放不下就翻看：显示完整的那一份中从第 scroll 行起的 rows - 1 行，最后一行写上面、下面各还有几行（scroll 夹在合法范围内）。
 */
export function helpWindow(readOnly: boolean, width: number, rows: number, scroll = 0): HelpWindow {
  const allItems = HELP_GROUPS.flatMap((g) => g.items);
  const keyWidth = Math.max(...allItems.map((i) => textWidth(i.keys))) + 2;
  const shortWidth = Math.max(...allItems.map((i) => textWidth(i.text)));
  const columns = width >= INDENT + 2 * (keyWidth + shortWidth) + GAP ? 2 : 1;

  const head: Line[] = [];
  if (readOnly) {
    for (const part of READ_ONLY_TEXT) {
      for (const text of wrapText(part.text, Math.max(1, width - INDENT))) {
        head.push([span(" ".repeat(INDENT)), span(text, { fg: part.color })]);
      }
    }
  }
  const groups = HELP_GROUPS.map((g) => groupLines(g, columns, keyWidth, shortWidth, width));
  const footers: Line[] = FOOTERS.flatMap((f) =>
    wrapText(f, Math.max(1, width - INDENT)).map((text): Line => [span(" ".repeat(INDENT)), span(text, { fg: "grey" })]),
  );

  const build = (blanks: boolean, withFooters: boolean): Line[] => {
    const out: Line[] = [...head];
    const gap: Line[] = blanks ? [[]] : [];
    if (head.length > 0) out.push(...gap);
    groups.forEach((g, i) => {
      if (i > 0) out.push(...gap);
      out.push(...g);
    });
    if (withFooters && footers.length > 0) out.push(...gap, ...footers);
    return out;
  };

  const room = Math.max(0, rows);
  const full = build(true, true);
  for (const lines of [full, build(true, false), build(false, false)]) {
    if (lines.length <= room) return { lines: lines.map((l) => fitLine(l, width)), total: lines.length, scrollable: false, scroll: 0, maxScroll: 0 };
  }
  const shown = Math.max(0, room - 1);
  const maxScroll = Math.max(0, full.length - shown);
  const at = Math.max(0, Math.min(maxScroll, Math.floor(scroll) || 0));
  const lines = full.slice(at, at + shown).map((l) => fitLine(l, width));
  if (room > 0) lines.push(fitLine(positionLine(at, full.length - at - shown, width), width));
  return { lines, total: full.length, scrollable: true, scroll: at, maxScroll };
}

/** ? 键的帮助画面：见 helpWindow。 */
export function renderHelp(readOnly: boolean, width: number, rows: number, scroll = 0): Line[] {
  return helpWindow(readOnly, width, rows, scroll).lines;
}
