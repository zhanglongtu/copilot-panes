// --demo 的样本脚本：9 个条目（find-bug、fix-login、run-tests、pytest、review、write-docs、migrate-db、score、npm run build），
// 名单上各种状态都出现一次：在跑、等你发话、失败、已结束。以真实 events.jsonl 的形状写成事件行，加上假的任务列表、用量和命令输出。
// 交给真正的 SessionStore 和 buildList，所以 --demo 同时是对事件模型的一次整合测试。
// write-docs 和 migrate-db 有两种样子：默认是刚开始演示时的样子（都在跑），演示里过几秒才分别变成“等你发话”和“失败”，
// 这样界面会把它们标成未读；settled 为 true 时是已经变好之后的样子（快照测试和文档用）。

import type { AgentUsage, TaskInfo } from "./protocol.ts";
import type { EntryKey } from "./types/model.ts";
import { agentKey, commandKey } from "./types/model.ts";

export const DEMO_SESSION_ID = "demo-session";
export const DEMO_CWD = "/work/webshop";
export const DEMO_TITLE = "修登录失败的 bug";
export const DEMO_COPILOT_PID = 4000;
export const DEMO_SCORE_PID = 4242;
export const DEMO_PYTEST_PID = 4301;

/** 样本里各个子 agent 和命令的编号。 */
export const DEMO_IDS = {
  findBug: "agent-find-bug",
  fixLogin: "agent-fix-login",
  runTests: "agent-run-tests",
  review: "agent-review",
  writeDocs: "agent-write-docs",
  migrateDb: "agent-migrate-db",
  taskFindBug: "toolu_task_find_bug",
  taskFixLogin: "toolu_task_fix_login",
  taskRunTests: "toolu_task_run_tests",
  taskReview: "toolu_task_review",
  taskWriteDocs: "toolu_task_write_docs",
  taskMigrateDb: "toolu_task_migrate_db",
  pytest: "toolu_pytest",
  score: "toolu_score",
  build: "toolu_build",
} as const;

export const DEMO_KEYS = {
  findBug: agentKey(DEMO_IDS.findBug),
  fixLogin: agentKey(DEMO_IDS.fixLogin),
  runTests: agentKey(DEMO_IDS.runTests),
  review: agentKey(DEMO_IDS.review),
  writeDocs: agentKey(DEMO_IDS.writeDocs),
  migrateDb: agentKey(DEMO_IDS.migrateDb),
  pytest: commandKey(DEMO_IDS.pytest),
  score: commandKey(DEMO_IDS.score),
  build: commandKey(DEMO_IDS.build),
} satisfies Record<string, EntryKey>;

/** score 终端开头的 6 行进度。 */
export const DEMO_SCORE_LINES: readonly string[] = [
  "[#---------] 2/40 5% 已用 13s 还要约 4m07s task_002",
  "[#---------] 4/40 10% 已用 27s 还要约 4m03s task_004",
  "[#---------] 6/40 15% 已用 40s 还要约 3m47s task_006",
  "[##--------] 8/40 20% 已用 53s 还要约 3m32s task_008",
  "[##--------] 10/40 25% 已用 1m07s 还要约 3m21s task_010",
  "[###-------] 12/40 30% 已用 1m20s 还要约 3m10s task_012",
];

export const DEMO_PYTEST_LINES: readonly string[] = [
  "============================= test session starts ==============================",
  "collected 23 items",
  "",
  "tests/test_auth.py::test_login_ok PASSED                                 [  4%]",
  "tests/test_auth.py::test_login_bad_password PASSED                       [  8%]",
  "tests/test_auth.py::test_refresh_keeps_session PASSED                    [ 13%]",
  "tests/test_auth.py::test_logout_clears_session PASSED                    [ 17%]",
  "tests/test_auth.py::test_token_expiry PASSED                             [ 21%]",
  "tests/test_auth.py::test_refresh_after_logout PASSED                     [ 26%]",
  "tests/test_auth.py::test_concurrent_refresh PASSED       7/23            [ 30%]",
];

export const DEMO_BUILD_OUTPUT = [
  "> webshop@1.4.0 build",
  "> tsc -p . && vite build",
  "",
  "src/auth.ts(71,5): error TS2304: Cannot find name 'clearSession'.",
  "npm ERR! code 1",
  "npm ERR! command failed: npm run build",
].join("\n");

const SEC = 1000;

export function isoTime(at: number): string {
  return new Date(at).toISOString();
}

export function eventLine(type: string, at: number, data: Record<string, unknown>, agentId?: string): string {
  return JSON.stringify({ type, data, ...(agentId ? { agentId } : {}), timestamp: isoTime(at) });
}

/** source 不传表示你从界面发的消息。 */
export function userMessageLine(at: number, agentId: string, content: string, source?: string): string {
  return eventLine("user.message", at, { content, ...(source === undefined ? {} : { source }) }, agentId);
}

export function assistantMessageLine(at: number, agentId: string, content: string): string {
  return eventLine("assistant.message", at, { content }, agentId);
}

/** 后台命令的结束通知（Copilot CLI 写的 system.notification）。 */
export function shellCompletedLine(at: number, shellId: string, exitCode: number): string {
  return eventLine("system.notification", at, { kind: { type: "shell_completed", shellId, exitCode, description: shellId } });
}

function started(toolCallId: string, at: number, agentId: string, name: string, model: string, description: string, mode: "sync" | "background"): string {
  return eventLine(
    "subagent.started",
    at,
    { toolCallId, agentName: "general-purpose", agentDisplayName: name, agentDescription: description, model, agentType: "general-purpose", executionMode: mode },
    agentId,
  );
}

function toolStart(at: number, toolCallId: string, toolName: string, args: Record<string, unknown>, agentId?: string): string {
  return eventLine("tool.execution_start", at, { toolCallId, toolName, arguments: args }, agentId);
}

export function toolCompleteLine(at: number, toolCallId: string, result: unknown, agentId?: string, extra: Record<string, unknown> = {}): string {
  return eventLine("tool.execution_complete", at, { toolCallId, success: true, result, ...extra }, agentId);
}

/** 命令的 .out 文件里一开始的内容，键是 toolCallId。 */
export function demoOutputs(): Record<string, string> {
  return {
    [DEMO_IDS.score]: DEMO_SCORE_LINES.map((text) => `${text}\n`).join(""),
    [DEMO_IDS.pytest]: DEMO_PYTEST_LINES.map((text) => `${text}\n`).join(""),
    [DEMO_IDS.build]: `${DEMO_BUILD_OUTPUT}\n`,
  };
}

/** write-docs 做完一轮（演示里变成“等你发话”）的事件，at 是完成的时刻。 */
export function writeDocsEndingLines(at: number): string[] {
  const { writeDocs } = DEMO_IDS;
  return [
    toolCompleteLine(at - 2 * SEC, "toolu_wd_create", { content: "File created" }, writeDocs),
    assistantMessageLine(at - SEC, writeDocs, "文档写好了，放在 docs/login.md。"),
    eventLine(
      "subagent.completed",
      at,
      { toolCallId: DEMO_IDS.taskWriteDocs, agentDisplayName: "write-docs", model: "provider/medium-1.0", totalToolCalls: 6, totalTokens: 36000, durationMs: 96000 },
      writeDocs,
    ),
    toolCompleteLine(at, DEMO_IDS.taskWriteDocs, { content: "文档写好了。" }),
  ];
}

/** migrate-db 失败的事件，at 是失败的时刻。 */
export function migrateDbEndingLines(at: number): string[] {
  const { migrateDb } = DEMO_IDS;
  return [
    toolCompleteLine(at - SEC, "toolu_md_view", { content: "1.   ALTER TABLE users ADD COLUMN token TEXT;" }, migrateDb),
    eventLine(
      "subagent.failed",
      at,
      { toolCallId: DEMO_IDS.taskMigrateDb, agentDisplayName: "migrate-db", error: "迁移第 3 步报错：users 表已经有 token 列", totalToolCalls: 5, totalTokens: 18200, durationMs: 61000 },
      migrateDb,
    ),
    toolCompleteLine(at, DEMO_IDS.taskMigrateDb, { content: "迁移失败。" }),
  ];
}

export interface DemoOptions {
  /** true：write-docs 已经做完一轮、migrate-db 已经失败。默认 false，两个都还在跑。 */
  settled?: boolean;
}

/** 全部历史，以 base（“现在”）为基准反推各事件的时间。 */
export function demoEventLines(base: number, options: DemoOptions = {}): string[] {
  const at = (secondsAgo: number): number => base - secondsAgo * SEC;
  const { findBug, fixLogin, runTests, review, writeDocs, migrateDb } = DEMO_IDS;
  const lines: string[] = [];
  const push = (...more: string[]) => lines.push(...more);

  push(eventLine("session.start", at(400), { sessionId: DEMO_SESSION_ID, selectedModel: "provider/large-1.0", startTime: isoTime(at(400)), context: { cwd: DEMO_CWD } }));

  // find-bug：做完了，用时 1m29s，40.9 万 token
  push(
    toolStart(at(330), DEMO_IDS.taskFindBug, "task", {
      name: "find-bug",
      description: "找出登录失败的原因",
      agent_type: "explore",
      model: "provider/small-1.0",
      mode: "background",
      prompt: "找出登录失败的原因，只读代码，不要改。",
    }),
    started(DEMO_IDS.taskFindBug, at(330), findBug, "find-bug", "provider/small-1.0", "找出登录失败的原因", "background"),
    userMessageLine(at(329.9), findBug, "找出登录失败的原因，只读代码，不要改。", "agent-main"),
    assistantMessageLine(at(245), findBug, "交回了报告\n登录失败的原因在 src/auth.ts 的 refreshToken()：它在刷新令牌之前先清空了会话。"),
    eventLine(
      "subagent.completed",
      at(241),
      { toolCallId: DEMO_IDS.taskFindBug, agentDisplayName: "find-bug", model: "provider/small-1.0", totalToolCalls: 14, totalTokens: 409000, durationMs: 89000 },
      findBug,
    ),
    toolCompleteLine(at(241), DEMO_IDS.taskFindBug, { content: "交回了报告。" }),
  );

  // fix-login：在跑，2m14s，18.3 万 token；它起了 run-tests
  const auth = `${DEMO_CWD}/src/auth.ts`;
  const fixPrompt = "登录失败是因为 src/auth.ts 里的 refreshToken() 提前清空了会话。\n把清空动作移到 logout() 里，再跑测试。";
  push(
    toolStart(at(134), DEMO_IDS.taskFixLogin, "task", {
      name: "fix-login",
      description: "修登录失败的 bug",
      agent_type: "general-purpose",
      model: "provider/medium-1.0",
      mode: "background",
      prompt: fixPrompt,
    }),
    started(DEMO_IDS.taskFixLogin, at(134), fixLogin, "fix-login", "provider/medium-1.0", "修登录失败的 bug", "background"),
    userMessageLine(at(133.9), fixLogin, fixPrompt, "agent-main"),
    assistantMessageLine(at(130), fixLogin, "先看 refreshToken() 现在在哪里清空会话。"),
    toolStart(at(129), "toolu_fl_view", "view", { path: auth, view_range: [40, 96] }, fixLogin),
    toolCompleteLine(at(128.5), "toolu_fl_view", { content: "40.   async function refreshToken() {\n..." }, fixLogin),
    toolStart(at(122), "toolu_fl_grep", "grep", { pattern: "clearSession(", path: `${DEMO_CWD}/src` }, fixLogin),
    toolCompleteLine(at(121.5), "toolu_fl_grep", { content: "[grep content: 3 matches in 2 files]\nsrc/auth.ts:71: clearSession(" }, fixLogin),
    assistantMessageLine(at(110), fixLogin, "清空会话的调用在第 71 行。我把它移到 logout()，再补一条测试。"),
    toolStart(at(100), "toolu_fl_edit", "edit", { path: auth, old_str: "clearSession()", new_str: "" }, fixLogin),
    toolCompleteLine(at(99), "toolu_fl_edit", { content: "File edited" }, fixLogin, { toolTelemetry: { metrics: { linesAdded: 4, linesRemoved: 3 } } }),
    toolStart(
      at(48),
      DEMO_IDS.taskRunTests,
      "task",
      { name: "run-tests", description: "跑测试", agent_type: "task", model: "provider/small-1.0", mode: "sync", prompt: "跑 pytest -v tests/，把失败的用例报给我。" },
      fixLogin,
    ),
  );

  // run-tests：在跑，48s，1.1 万 token；pytest 跑了 41s
  push(
    started(DEMO_IDS.taskRunTests, at(48), runTests, "run-tests", "provider/small-1.0", "跑测试", "sync"),
    userMessageLine(at(47.9), runTests, "跑 pytest -v tests/，把失败的用例报给我。", `agent-${fixLogin}`),
    toolStart(at(41), DEMO_IDS.pytest, "bash", { command: "pytest -v tests/", description: "Run tests" }, runTests),
  );

  // review：做完一轮，等你发话，3m40s，22.0 万 token（idle 只有任务列表知道）
  push(
    toolStart(at(132), DEMO_IDS.taskReview, "task", {
      name: "review",
      description: "审查改动",
      agent_type: "code-review",
      model: "provider/medium-1.0",
      mode: "background",
      prompt: "审查 src/auth.ts 的改动。",
    }),
    started(DEMO_IDS.taskReview, at(132), review, "review", "provider/medium-1.0", "审查改动", "background"),
    userMessageLine(at(131.9), review, "审查 src/auth.ts 的改动。", "agent-main"),
    assistantMessageLine(at(100), review, "改动没有问题。要我再看看测试吗？"),
    eventLine(
      "subagent.completed",
      at(98),
      { toolCallId: DEMO_IDS.taskReview, agentDisplayName: "review", model: "provider/medium-1.0", totalToolCalls: 9, totalTokens: 220000, durationMs: 220000 },
      review,
    ),
  );

  // write-docs：写文档，在跑（演示里 8 秒后做完一轮）；migrate-db：迁移，在跑（演示里 4 秒后失败）
  push(
    toolStart(at(150), DEMO_IDS.taskWriteDocs, "task", {
      name: "write-docs",
      description: "补登录流程的文档",
      agent_type: "general-purpose",
      model: "provider/medium-1.0",
      mode: "background",
      prompt: "给登录流程写一份说明，放在 docs/login.md。",
    }),
    started(DEMO_IDS.taskWriteDocs, at(150), writeDocs, "write-docs", "provider/medium-1.0", "补登录流程的文档", "background"),
    userMessageLine(at(149.9), writeDocs, "给登录流程写一份说明，放在 docs/login.md。", "agent-main"),
    toolStart(at(90), DEMO_IDS.taskMigrateDb, "task", {
      name: "migrate-db",
      description: "迁移用户表",
      agent_type: "general-purpose",
      model: "provider/small-1.0",
      mode: "background",
      prompt: "给 users 表加上 token 列，跑迁移并确认结果。",
    }),
    started(DEMO_IDS.taskMigrateDb, at(90), migrateDb, "migrate-db", "provider/small-1.0", "迁移用户表", "background"),
    userMessageLine(at(89.9), migrateDb, "给 users 表加上 token 列，跑迁移并确认结果。", "agent-main"),
    toolStart(at(60), "toolu_wd_create", "create", { path: `${DEMO_CWD}/docs/login.md`, file_text: "# 登录流程\n" }, writeDocs),
    toolStart(at(20), "toolu_md_view", "view", { path: `${DEMO_CWD}/migrations/003_add_token.sql` }, migrateDb),
  );
  if (options.settled === true) push(...writeDocsEndingLines(at(40)), ...migrateDbEndingLines(at(30)));

  // score：后台命令，1m20s；build：失败的前台命令，12s
  push(
    toolStart(at(80), DEMO_IDS.score, "bash", { command: "python3 -u score.py --run nov15", description: "Score run nov15", mode: "async", shellId: "score" }),
    toolCompleteLine(at(79.9), DEMO_IDS.score, { content: "<command started in background with shellId: score>", structuredContent: { shellId: "score" } }),
    toolStart(at(14), DEMO_IDS.build, "bash", { command: "npm run build", description: "Build" }),
    toolCompleteLine(
      at(2),
      DEMO_IDS.build,
      { content: `${DEMO_BUILD_OUTPUT}\n<shellId: build completed with exit code 1>`, structuredContent: { shellId: "build" } },
      undefined,
      { shellExecution: { exitCode: 1 } },
    ),
  );
  return lines;
}

/** 假的任务列表：在跑的子 agent 和命令是 running，review 是 idle（write-docs 在 settled 时也是）。shellCalls 把 shell 任务对应到命令的 toolCallId。 */
export function demoTasks(now: number, options: DemoOptions = {}): { tasks: TaskInfo[]; shellCalls: Record<string, string> } {
  const settled = options.settled === true;
  const agent = (id: string, toolCallId: string, name: string, status: "running" | "idle" | "completed" | "failed", secondsAgo: number, extra: Record<string, unknown> = {}): TaskInfo => ({
    type: "agent",
    id,
    toolCallId,
    displayName: name,
    description: name,
    status,
    startedAt: isoTime(now - secondsAgo * SEC),
    agentType: "general-purpose",
    prompt: "",
    executionMode: "background",
    ...extra,
  });
  const shell = (id: string, command: string, pid: number, secondsAgo: number, canPromote: boolean): TaskInfo => ({
    type: "shell",
    id,
    description: command,
    status: "running",
    startedAt: isoTime(now - secondsAgo * SEC),
    command,
    attachmentMode: "attached",
    executionMode: canPromote ? "sync" : "background",
    canPromoteToBackground: canPromote,
    pid,
  });
  const tasks: TaskInfo[] = [
    agent(DEMO_IDS.findBug, DEMO_IDS.taskFindBug, "find-bug", "completed", 330),
    agent(DEMO_IDS.fixLogin, DEMO_IDS.taskFixLogin, "fix-login", "running", 134),
    agent(DEMO_IDS.runTests, DEMO_IDS.taskRunTests, "run-tests", "running", 48, { executionMode: "sync" }),
    agent(DEMO_IDS.review, DEMO_IDS.taskReview, "review", "idle", 132, { idleSince: isoTime(now - 98 * SEC) }),
    settled
      ? agent(DEMO_IDS.writeDocs, DEMO_IDS.taskWriteDocs, "write-docs", "idle", 150, { idleSince: isoTime(now - 40 * SEC) })
      : agent(DEMO_IDS.writeDocs, DEMO_IDS.taskWriteDocs, "write-docs", "running", 150),
    agent(DEMO_IDS.migrateDb, DEMO_IDS.taskMigrateDb, "migrate-db", settled ? "failed" : "running", 90),
  ];
  tasks.push(shell("score", "python3 -u score.py --run nov15", DEMO_SCORE_PID, 80, false));
  tasks.push(shell("pytest", "pytest -v tests/", DEMO_PYTEST_PID, 41, true));
  return { tasks, shellCalls: { score: DEMO_IDS.score, pytest: DEMO_IDS.pytest } };
}

/** 假的用量：fix-login 18.3 万、run-tests 1.1 万（扩展累加的 assistant.usage）。 */
export function demoUsage(): Record<string, AgentUsage> {
  const usage = (input: number, output: number): AgentUsage => ({ inputTokens: input, outputTokens: output, cacheReadTokens: 0, cacheWriteTokens: 0, calls: 10 });
  return { [DEMO_IDS.fixLogin]: usage(150000, 33000), [DEMO_IDS.runTests]: usage(9000, 2000) };
}
