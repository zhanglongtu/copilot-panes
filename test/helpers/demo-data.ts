// 界面测试用的样本数据：9 个条目（find-bug、write-docs、fix-login、run-tests、pytest、review、migrate-db、score、npm run build），
// 名单上各种状态都出现一次，加上 fix-login、score 的内容。界面的快照测试和各视图测试都用它。
// 样本事件在 src/demo-script.ts，--demo 运行时用的活的演示在 src/demo-live.ts。

import { sessionTokens } from "../../src/model/tokens.ts";
import { buildList } from "../../src/model/merge.ts";
import { SessionStore } from "../../src/model/store.ts";
import type { ViewData } from "../../src/types/app.ts";
import type { TasksSnapshot } from "../../src/types/model.ts";
import type { Line, TerminalLines } from "../../src/types/ui.ts";
import { DEMO_CWD, DEMO_IDS, DEMO_PYTEST_LINES, DEMO_SCORE_LINES, DEMO_SESSION_ID, DEMO_TITLE, demoEventLines, demoTasks, demoUsage } from "../../src/demo-script.ts";
import type { DemoOptions } from "../../src/demo-script.ts";

export * from "../../src/demo-script.ts";

/** 纯文字的终端：行数补到 rows，和真终端一样屏幕底部有空行。 */
export function plainTerminal(lines: readonly string[], cols: number, rows: number): TerminalLines {
  const all = [...lines];
  while (all.length < rows) all.push("");
  return {
    cols,
    rows,
    totalLines: all.length,
    lines(start: number, count: number): Line[] {
      const from = Math.max(0, start);
      return all.slice(from, from + count).map((text): Line => (text === "" ? [] : [{ text }]));
    },
  };
}

/** 命令的最后一行输出：score 是 12/40，pytest 是 7/23。 */
function demoLastLine(toolCallId: string): string {
  if (toolCallId === DEMO_IDS.score) return DEMO_SCORE_LINES.at(-1) ?? "";
  if (toolCallId === DEMO_IDS.pytest) return DEMO_PYTEST_LINES.at(-1) ?? "";
  return "";
}

/**
 * 得出样本数据。now 是“现在”，各条目的 startedAt、用时按脚本里的数反推（fix-login 用时 2m14s 等）。
 * store 是喂了样本事件行的真 SessionStore，过程记录里是 fix-login 的那几条；terminal 是 score 的终端内容（6 行进度）。
 * 顶行：项目名 "webshop"、session 名字“修登录失败的 bug”、token 合计 82.3 万。
 * options.settled 见 demo-script.ts：默认是刚开始演示时的样子，settled 为 true 时 write-docs 在等你发话、migrate-db 已经失败。
 */
export function demoData(now: number, options: DemoOptions = {}): ViewData {
  const store = new SessionStore(DEMO_SESSION_ID);
  for (const text of demoEventLines(now, options)) store.feedLine(text);
  const { tasks, shellCalls } = demoTasks(now, options);
  const snapshot: TasksSnapshot = { tasks, shellCalls, receivedAt: now, connected: true };
  const usage = demoUsage();
  const entries = buildList({ store, tasks: snapshot, usage, now, collapseEnded: false, keep: new Set(), lastOutputLine: demoLastLine });
  return {
    now,
    session: { sessionId: DEMO_SESSION_ID, project: "webshop", title: DEMO_TITLE },
    extension: { kind: "connected" },
    entries,
    runningCount: entries.filter((entry) => entry.status === "running").length,
    totalTokens: sessionTokens(store, usage),
    store,
    terminal: plainTerminal(DEMO_SCORE_LINES, 78, 10),
    sessions: [{ sessionId: DEMO_SESSION_ID, title: DEMO_TITLE, cwd: DEMO_CWD, lastEventAt: now, current: true }],
    bellEnabled: true,
  };
}
