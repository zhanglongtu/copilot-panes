// 活的演示：把演示数据当作一个真的 session 喂给界面。事件、命令输出、扩展的任务列表和用量都走和真实数据相同的接口
// （SessionIO），只是来源是内存里的脚本：score 每秒多打印一行进度，pytest 每 4 秒多跑一个用例，用时在走；
// 开始 4 秒后 migrate-db 失败、8 秒后 write-docs 做完一轮，界面把它们标成未读，演示里各种状态都看得到；
// Ctrl+C 经真正的 Interrupter 和一份假的进程表“中断”命令；给子 agent 发的消息会进它的过程记录并得到一句回复。

import { INTERRUPT_ESCALATE_MS } from "./constants.ts";
import { Interrupter } from "./bridge/signals.ts";
import type { BridgeState } from "./bridge/client.ts";
import type { ProcAccess } from "./bridge/signals.ts";
import type { BridgeLike, EventSource, OutputSource, SessionIO } from "./feed.ts";
import type { LineChunk, TextChunk } from "./model/tail.ts";
import { PROTOCOL_VERSION } from "./protocol.ts";
import type { RequestOp, TaskInfo } from "./protocol.ts";
import type { RequestOutcome } from "./types/app.ts";
import type { Clock, Timers } from "./types/clock.ts";
import {
  DEMO_COPILOT_PID,
  DEMO_IDS,
  DEMO_PYTEST_PID,
  DEMO_SCORE_PID,
  DEMO_SESSION_ID,
  assistantMessageLine,
  demoEventLines,
  demoOutputs,
  demoTasks,
  demoUsage,
  eventLine,
  isoTime,
  migrateDbEndingLines,
  shellCompletedLine,
  toolCompleteLine,
  userMessageLine,
  writeDocsEndingLines,
} from "./demo-script.ts";

const SCORE_TOTAL = 40;
const PYTEST_TOTAL = 23;
const PYTEST_STEP_MS = 4000;
/** 演示开始多久之后，migrate-db 失败、write-docs 做完一轮（界面把它们标成未读）。 */
const MIGRATE_FAILS_AFTER_MS = 4000;
const WRITE_DOCS_DONE_AFTER_MS = 8000;

function duration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

/** score 的一行进度，格式和其他进度行相同。 */
function scoreLine(n: number, elapsedSeconds: number): string {
  const percent = Math.floor((n * 100) / SCORE_TOTAL);
  const hashes = Math.max(1, Math.floor(percent / 10));
  const eta = n >= SCORE_TOTAL ? 0 : (elapsedSeconds / n) * (SCORE_TOTAL - n);
  return `[${"#".repeat(hashes)}${"-".repeat(10 - hashes)}] ${n}/${SCORE_TOTAL} ${percent}% 已用 ${duration(elapsedSeconds)} 还要约 ${duration(eta)} task_${String(n).padStart(3, "0")}`;
}

function pytestLine(n: number): string {
  const percent = Math.floor((n * 100) / PYTEST_TOTAL);
  const name = `tests/test_auth.py::test_case_${String(n).padStart(2, "0")} PASSED`.padEnd(54);
  return `${name}${`${n}/${PYTEST_TOTAL}`.padEnd(16)}[${String(percent).padStart(3)}%]`;
}

class MemoryEvents implements EventSource {
  #pending: string[] = [];

  push(...lines: string[]): void {
    this.#pending.push(...lines);
  }

  read(): LineChunk {
    const lines = this.#pending;
    this.#pending = [];
    return { lines, reset: false, more: false };
  }
}

class MemoryOutput implements OutputSource {
  readonly #outputs: Map<string, string>;
  readonly #id: string;
  #pos = 0;

  constructor(outputs: Map<string, string>, id: string) {
    this.#outputs = outputs;
    this.#id = id;
  }

  read(): TextChunk {
    const all = this.#outputs.get(this.#id);
    if (all === undefined) return { text: "", reset: false, more: false, exists: false };
    const text = all.slice(this.#pos);
    this.#pos = all.length;
    return { text, reset: false, more: false, exists: true };
  }
}

class DemoBridge implements BridgeLike {
  readonly #listeners = new Set<() => void>();
  readonly #handle: (op: RequestOp) => RequestOutcome;
  readonly #timers: Timers;
  state: BridgeState;

  constructor(handle: (op: RequestOp) => RequestOutcome, timers: Timers) {
    this.#handle = handle;
    this.#timers = timers;
    this.state = {
      status: "connected",
      hello: { type: "hello", v: PROTOCOL_VERSION, sessionId: DEMO_SESSION_ID, copilotPid: DEMO_COPILOT_PID, extensionPid: DEMO_COPILOT_PID + 1, extensionVersion: "demo" },
      tasks: null,
      usage: demoUsage(),
      extensionError: null,
      problem: null,
    };
  }

  publish(tasks: TaskInfo[], shellCalls: Record<string, string>, receivedAt: number): void {
    this.state = { ...this.state, tasks: { tasks, shellCalls, receivedAt, connected: true } };
    queueMicrotask(() => {
      for (const listener of [...this.#listeners]) listener();
    });
  }

  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  request(_requestId: string, op: RequestOp): Promise<RequestOutcome> {
    return new Promise((resolve) => {
      this.#timers.setTimeout(() => resolve(this.#handle(op)), 150);
    });
  }

  stop(): void {}
}

/** 活的演示，实现 SessionIO。start() 之后每秒走一步，close() 停下。 */
export class DemoSession implements SessionIO {
  readonly sessionId = DEMO_SESSION_ID;
  readonly bridgeNote = "演示数据";
  readonly events = new MemoryEvents();
  readonly bridge: DemoBridge;
  readonly interrupter: Interrupter;
  readonly #clock: Clock;
  readonly #timers: Timers;
  readonly #outputs = new Map<string, string>(Object.entries(demoOutputs()));
  readonly #startedAt: number;
  /** 已经结束的命令的 toolCallId。 */
  readonly #ended = new Set<string>();
  readonly #agentTasks = new Map<string, Partial<TaskInfo>>();
  readonly #scheduled = new Set<unknown>();
  #timer: unknown = null;
  #scoreN = 12;
  #pytestN = 7;
  #pytestAt: number;
  #migrateFailed = false;

  constructor(clock: Clock, timers: Timers) {
    this.#clock = clock;
    this.#timers = timers;
    this.#startedAt = clock.now();
    this.#pytestAt = this.#startedAt;
    this.events.push(...demoEventLines(this.#startedAt));
    this.#later(MIGRATE_FAILS_AFTER_MS, () => this.#failMigrate());
    this.#later(WRITE_DOCS_DONE_AFTER_MS, () => this.#finishWriteDocs());
    this.bridge = new DemoBridge((op) => this.#handleRequest(op), timers);
    this.#publish();
    const proc: ProcAccess = {
      exists: (pid) => pid === DEMO_COPILOT_PID || this.#pidCommand(pid) !== null,
      parentOf: (pid) => (pid === DEMO_COPILOT_PID ? 1 : this.#pidCommand(pid) !== null ? DEMO_COPILOT_PID : null),
      processGroupOf: (pid) => (this.#pidCommand(pid) !== null ? pid : null),
      kill: (target) => {
        const id = this.#pidCommand(Math.abs(target));
        if (id !== null) this.#interruptCommand(id);
      },
    };
    this.interrupter = new Interrupter(proc, clock, INTERRUPT_ESCALATE_MS);
  }

  /** 开始走：每秒一步。 */
  start(): void {
    if (this.#timer === null) this.#timer = this.#timers.setInterval(() => this.#step(), 1000);
  }

  openOutput(toolCallId: string): OutputSource {
    return new MemoryOutput(this.#outputs, toolCallId);
  }

  lastLine(toolCallId: string): string {
    const lines = (this.#outputs.get(toolCallId) ?? "").split("\n").filter((text) => text.trim() !== "");
    return lines.at(-1) ?? "";
  }

  outputFile(): string | null {
    return null;
  }

  copilotPid(): number {
    return DEMO_COPILOT_PID;
  }

  close(): void {
    if (this.#timer !== null) this.#timers.clearInterval(this.#timer);
    this.#timer = null;
    for (const handle of this.#scheduled) this.#timers.clearTimeout(handle);
    this.#scheduled.clear();
  }

  #pidCommand(pid: number): string | null {
    const id = pid === DEMO_SCORE_PID ? DEMO_IDS.score : pid === DEMO_PYTEST_PID ? DEMO_IDS.pytest : null;
    return id !== null && !this.#ended.has(id) ? id : null;
  }

  #later(ms: number, fn: () => void): void {
    const handle = this.#timers.setTimeout(() => {
      this.#scheduled.delete(handle);
      fn();
    }, ms);
    this.#scheduled.add(handle);
  }

  #append(id: string, text: string): void {
    this.#outputs.set(id, (this.#outputs.get(id) ?? "") + text);
  }

  #publish(): void {
    const now = this.#clock.now();
    const { tasks, shellCalls } = demoTasks(now);
    const live: TaskInfo[] = [];
    for (const task of tasks) {
      if (task.type === "shell") {
        if (this.#ended.has(shellCalls[task.id] ?? "")) continue;
        live.push(task);
      } else {
        const patch = this.#agentTasks.get(task.id);
        live.push(patch ? ({ ...task, ...patch } as TaskInfo) : task);
      }
    }
    this.bridge.publish(live, shellCalls, now);
  }

  #step(): void {
    const now = this.#clock.now();
    const elapsed = (now - this.#startedAt) / 1000;
    if (!this.#ended.has(DEMO_IDS.score)) {
      if (this.#scoreN < SCORE_TOTAL) {
        this.#scoreN++;
        this.#append(DEMO_IDS.score, `${scoreLine(this.#scoreN, 80 + elapsed)}\n`);
      } else {
        this.#append(DEMO_IDS.score, "全部完成：40 个任务，平均分 0.87\n");
        this.#finishShell(DEMO_IDS.score, "score", 0);
      }
    }
    if (!this.#ended.has(DEMO_IDS.pytest) && now - this.#pytestAt >= PYTEST_STEP_MS) {
      this.#pytestAt = now;
      if (this.#pytestN < PYTEST_TOTAL) {
        this.#pytestN++;
        this.#append(DEMO_IDS.pytest, `${pytestLine(this.#pytestN)}\n`);
      } else {
        this.#finishPytest(0);
      }
    }
    this.#publish();
  }

  #finishShell(toolCallId: string, shellId: string, exitCode: number): void {
    this.#ended.add(toolCallId);
    this.events.push(shellCompletedLine(this.#clock.now(), shellId, exitCode));
  }

  /** pytest 是前台命令：结束时写 tool.execution_complete。全部通过时 run-tests 和 fix-login 接着收尾。 */
  #finishPytest(exitCode: number): void {
    const now = this.#clock.now();
    this.#ended.add(DEMO_IDS.pytest);
    if (exitCode === 0) this.#append(DEMO_IDS.pytest, `\n============================== ${PYTEST_TOTAL} passed in 96.40s ==============================\n`);
    this.events.push(
      toolCompleteLine(now, DEMO_IDS.pytest, { content: `${PYTEST_TOTAL} passed\n<shellId: pytest completed with exit code ${exitCode}>`, structuredContent: { shellId: "pytest" } }, DEMO_IDS.runTests, {
        shellExecution: { exitCode },
      }),
    );
    if (exitCode !== 0) return;
    const { runTests, fixLogin } = DEMO_IDS;
    this.events.push(
      assistantMessageLine(now + 1, runTests, "测试全部通过，23 个用例没有失败。"),
      eventLine("subagent.completed", now + 2, { toolCallId: DEMO_IDS.taskRunTests, agentDisplayName: "run-tests", model: "provider/small-1.0", totalToolCalls: 3, totalTokens: 12400, durationMs: 140000 }, runTests),
      toolCompleteLine(now + 2, DEMO_IDS.taskRunTests, { content: "测试全部通过。" }, fixLogin),
      assistantMessageLine(now + 3, fixLogin, "测试全部通过，登录失败的问题修好了。"),
    );
    this.#agentTasks.set(runTests, { status: "completed" });
  }

  #failMigrate(): void {
    this.#migrateFailed = true;
    this.events.push(...migrateDbEndingLines(this.#clock.now()));
    this.#agentTasks.set(DEMO_IDS.migrateDb, { status: "failed" });
    this.#publish();
  }

  #finishWriteDocs(): void {
    const now = this.#clock.now();
    this.events.push(...writeDocsEndingLines(now));
    this.#agentTasks.set(DEMO_IDS.writeDocs, { status: "idle", idleSince: isoTime(now) } as Partial<TaskInfo>);
    this.#publish();
  }

  #interruptCommand(toolCallId: string): void {
    this.#append(toolCallId, "^C\nKeyboardInterrupt\n");
    if (toolCallId === DEMO_IDS.score) this.#finishShell(toolCallId, "score", 130);
    else this.#finishPytest(130);
    this.#publish();
  }

  #agentName(taskId: string): string | null {
    const names: Record<string, string> = {
      [DEMO_IDS.findBug]: "find-bug",
      [DEMO_IDS.fixLogin]: "fix-login",
      [DEMO_IDS.runTests]: "run-tests",
      [DEMO_IDS.review]: "review",
      [DEMO_IDS.writeDocs]: "write-docs",
      [DEMO_IDS.migrateDb]: "migrate-db",
    };
    return names[taskId] ?? null;
  }

  #handleRequest(op: RequestOp): RequestOutcome {
    const now = this.#clock.now();
    switch (op.op) {
      case "refreshTasks":
        this.#publish();
        return { ok: true };
      case "sendMessage": {
        const name = this.#agentName(op.taskId);
        if (name === null) return { ok: false, reason: "找不到这个子 agent" };
        if (op.taskId === DEMO_IDS.findBug || (op.taskId === DEMO_IDS.migrateDb && this.#migrateFailed)) return { ok: false, reason: `${name} 已经结束，不能再发消息` };
        this.events.push(userMessageLine(now, op.taskId, op.message));
        if (op.taskId === DEMO_IDS.review) {
          this.#agentTasks.set(op.taskId, { status: "running" });
          this.#later(2500, () => {
            const done = this.#clock.now();
            this.events.push(
              assistantMessageLine(done, op.taskId, "好的，我再看一遍测试。"),
              eventLine("subagent.completed", done + 1, { toolCallId: DEMO_IDS.taskReview, agentDisplayName: "review", model: "provider/medium-1.0", totalToolCalls: 10, totalTokens: 225000, durationMs: 224000 }, op.taskId),
            );
            this.#agentTasks.set(op.taskId, { status: "idle", idleSince: isoTime(done) } as Partial<TaskInfo>);
            this.#publish();
          });
        } else {
          this.#later(1500, () => {
            this.events.push(assistantMessageLine(this.#clock.now(), op.taskId, "收到，我做完手上这一步就看。"));
          });
        }
        this.#publish();
        return { ok: true };
      }
      case "cancel": {
        const toolCallId = op.taskId === "score" ? DEMO_IDS.score : op.taskId === "pytest" ? DEMO_IDS.pytest : null;
        if (toolCallId !== null) {
          if (!this.#ended.has(toolCallId)) this.#interruptCommand(toolCallId);
          return { ok: true };
        }
        const name = this.#agentName(op.taskId);
        if (name === null) return { ok: false, reason: "找不到这个任务" };
        this.events.push(eventLine("subagent.completed", now, { cancelled: true }, op.taskId));
        this.#agentTasks.set(op.taskId, { status: "cancelled" });
        this.#publish();
        return { ok: true };
      }
      case "promoteToBackground":
        return { ok: true };
      case "remove":
        return { ok: true };
    }
  }
}
