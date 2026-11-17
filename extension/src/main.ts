// 扩展的主体：把各部分接起来。入口 extension.ts 只负责 joinSession，再把真的 session 和依赖传给 startPanes。

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { outDir, registrationPath, sessionsDir } from "../../src/paths.ts";
import type { SocketPathOptions } from "../../src/paths.ts";
import {
  OUT_FILE_MAX_BYTES,
  OUT_RETENTION_MS,
  DETACHED_READ_WAIT_MS,
  REGISTRATION_HEARTBEAT_MS,
  TASK_TEXT_MAX_CHARS,
  TASKS_IDLE_POLL_MS,
  TASKS_KEEPALIVE_MS,
  TASKS_POLL_MS,
} from "../../src/constants.ts";
import { PROTOCOL_VERSION, REGISTRATION_VERSION } from "../../src/protocol.ts";
import type { HelloMessage, ResultMessage, UsageMessage } from "../../src/protocol.ts";
import type { Clock, Timers } from "../../src/types/clock.ts";
import { runRequest } from "./actions.ts";
import { cleanupStale } from "./cleanup.ts";
import { describeError, ErrorLog } from "./errors.ts";
import { OutputRecorder } from "./outputs.ts";
import { Registrar } from "./registry.ts";
import { chooseSocket, removeCreatedDir, tightenDirectory } from "./socketdir.ts";
import type { ChosenSocket } from "./socketdir.ts";
import type { PanesSession, SdkEvent, TasksRpc } from "./sdk.ts";
import { PanesServer } from "./server.ts";
import { matchShellTasks, ShellCallBook } from "./shells.ts";
import { TaskPublisher } from "./tasks.ts";
import { UsageBook } from "./usage.ts";

/** 扩展的可替换依赖。测试用临时目录、假时钟、假定时器。 */
export interface ExtensionDeps {
  /** 运行时数据目录（src/paths.ts 的 dataDir 算出的结果）。 */
  dataDir: string;
  /** socket 路径太长时的退路需要的东西（src/paths.ts 的 socketPath）。 */
  socketOptions: SocketPathOptions;
  clock: Clock;
  timers: Timers;
  /** 扩展自己的进程号。 */
  pid: number;
  /** Copilot CLI 的进程号：非沙箱时等于 process.ppid。 */
  copilotPid: number;
  /** 环境变量 TMUX_PANE，没有是 null。 */
  tmuxPane: string | null;
  /** process.cwd()。 */
  cwd: string;
  /** 扩展的版本（package.json 的 version）。 */
  version: string;
  /** 判断进程是否还活着（清理失效的登记记录用）。真实现是 process.kill(pid, 0) 不抛异常。 */
  isPidAlive(pid: number): boolean;
  /** 写一行诊断到 stderr。不能写 stdout：stdout 是和 Copilot CLI 之间的 JSON-RPC 通道。 */
  logError(message: string): void;
}

/** 正在运行的扩展。 */
export interface PanesHandle {
  /** 选定的 socket 路径（可能是退路目录里的，也可能是 mkdtemp 建的目录里的）；没选成（目录不安全等）是空串。是否真的在听看 listening。 */
  readonly socketPath: string;
  /** socket 已经在听。没开成时登记记录里的 socketPath 是 null，扩展每 SOCKET_RETRY_MS 重试。 */
  readonly listening: boolean;
  /**
   * 停下：取消订阅、停掉定时器、关闭所有连接和 socket、删掉 socket 文件和登记记录。
   * Copilot CLI 先发 SIGTERM，只给约 1 秒宽限期，所以必须在 1 秒内做完；多次调用只做一次。
   */
  stop(): Promise<void>;
  /** 同步地删掉登记记录和 socket 文件（只删自己的）。给进程的 exit 事件用：父进程消失时 SDK 的看门狗直接 process.exit。 */
  cleanupSync(): void;
  /** 把一次出错记进 ErrorLog（进程级的未捕获异常用），不抛异常。 */
  reportError(step: string, error: unknown): void;
}

/** socket 没开成时每隔这么久重试一次。 */
const SOCKET_RETRY_MS = 5000;
/** 启动 2 秒后做一次清理。 */
const CLEANUP_DELAY_MS = 2000;
/** 记下最近这么多次 shell 调用，用来把 shell 任务对应到 toolCallId。 */
const MAX_SHELL_CALLS = 500;

/** 每次调用时才去取 session.rpc.tasks 上的方法，所以 session.rpc 暂时不可用或方法不存在，只让那一次调用失败。 */
function lazyTasksRpc(session: PanesSession): TasksRpc {
  return {
    list: () => session.rpc.tasks.list(),
    cancel: (params) => session.rpc.tasks.cancel(params),
    remove: (params) => session.rpc.tasks.remove(params),
    sendMessage: (params) => session.rpc.tasks.sendMessage(params),
    promoteToBackground: (params) => session.rpc.tasks.promoteToBackground(params),
    readOutput: (params) => session.rpc.tasks.readOutput(params),
  };
}

/**
 * 启动扩展。顺序很重要：
 * 1. 先 session.on 订阅事件，再做别的。tool.shell_output 和 assistant.usage 不落盘、晚订阅收不到。
 * 2. 建目录（0700）：<dataDir>/sessions、<dataDir>/out/<session ID>。
 * 3. 开 socket（extension/src/socketdir.ts 的 chooseSocket：路径太长时用 XDG_RUNTIME_DIR 下的退路，没有就 mkdtemp），文件权限 0600；同路径的旧 socket 文件先删掉。
 *    开不成时登记记录里 socketPath 写 null，每 5 秒重试，开成后重写登记记录。
 * 4. 写登记记录（protocol.ts 的 Registration），之后每 5 秒原子地重写一次（REGISTRATION_HEARTBEAT_MS）。
 * 5. 每秒查 tasks.list()（TASKS_POLL_MS），变了才推，至少每 5 秒推一次（TASKS_KEEPALIVE_MS）；用量变了最多每秒推一次。
 * 6. 启动 2 秒后做一次清理（cleanup.ts）。
 * 任何一步出错都不能让扩展进程退出：记进 ErrorLog（tasks 消息的 error 字段带给界面），接着做别的。
 * 输入：session 是 joinSession() 返回的 session 或测试的假 session。输出：PanesHandle。
 */
export async function startPanes(session: PanesSession, deps: ExtensionDeps): Promise<PanesHandle> {
  const { clock, timers } = deps;
  const log = (line: string) => {
    try {
      deps.logError(line);
    } catch {
      // stderr 写不进去也不能影响扩展
    }
  };
  const errors = new ErrorLog(clock, log);
  const rpc = lazyTasksRpc(session);
  let stopped = false;

  let sessionId = "unknown";
  try {
    sessionId = String(session.sessionId);
  } catch (e) {
    errors.record("session.id", e);
  }

  const usage = new UsageBook();
  const shells = new ShellCallBook(MAX_SHELL_CALLS, () => clock.now());
  const outputs = new OutputRecorder({
    dir: outDir(deps.dataDir, sessionId),
    maxBytes: OUT_FILE_MAX_BYTES,
    clock,
    errors,
    detachedWaitMs: DETACHED_READ_WAIT_MS,
    timers,
  });
  const publisher = new TaskPublisher({
    rpc,
    shells,
    clock,
    errors,
    keepaliveMs: TASKS_KEEPALIVE_MS,
    textMaxChars: TASK_TEXT_MAX_CHARS,
  });
  let usageDirty = false;

  // 1. 先订阅：启动期间发的事件也要处理
  let unsubscribe: () => void = () => {};
  try {
    const off = session.on((event: SdkEvent) => {
      if (stopped || typeof event !== "object" || event === null) return;
      try {
        outputs.onEvent(event, rpc);
      } catch (e) {
        errors.record("event.outputs", e);
      }
      try {
        shells.onEvent(event);
      } catch (e) {
        errors.record("event.shells", e);
      }
      try {
        if (usage.onEvent(event)) usageDirty = true;
      } catch (e) {
        errors.record("event.usage", e);
      }
    });
    if (typeof off === "function") unsubscribe = off;
  } catch (e) {
    errors.record("session.on", e);
  }

  // 2. 目录
  try {
    mkdirSync(sessionsDir(deps.dataDir), { recursive: true, mode: 0o700 });
    mkdirSync(outDir(deps.dataDir, sessionId), { recursive: true, mode: 0o700 });
    // 已经存在的目录权限可能宽了（别的程序或用户自己建的）：放登记记录、socket 和输出的子目录一律收紧成 0700
    for (const dir of [sessionsDir(deps.dataDir), dirname(outDir(deps.dataDir, sessionId)), outDir(deps.dataDir, sessionId)]) tightenDirectory(dir, deps.socketOptions.uid);
  } catch (e) {
    errors.record("setup.dirs", e);
  }

  const usageMessage = (): UsageMessage => ({ type: "usage", v: PROTOCOL_VERSION, at: clock.now(), agents: usage.snapshot() });
  const hello = (): HelloMessage => ({
    type: "hello",
    v: PROTOCOL_VERSION,
    sessionId,
    copilotPid: deps.copilotPid,
    extensionPid: deps.pid,
    extensionVersion: deps.version,
  });

  const pollAndPush = async (force: boolean): Promise<void> => {
    if (stopped) return;
    try {
      const message = await publisher.poll(force);
      if (message && !stopped) {
        server.broadcast(message);
        publisher.markSent(message);
      }
    } catch (e) {
      errors.record("tasks.push", e);
    }
  };

  // 3. socket：路径和目录由 chooseSocket 选并检查；开不成不影响别的，登记记录里 socketPath 写 null，隔一会儿重试
  let chosen: ChosenSocket | null = null;
  let listening = false;
  const server: PanesServer = new PanesServer({
    path: "",
    greeting: () => [hello(), publisher.latest(), usageMessage()],
    onConnect: () => void pollAndPush(false), // 没有界面连着时任务列表降到 5 秒查一次，新连上的界面要马上看到新的（有变化才推）
    onRequest: async (request): Promise<ResultMessage> => {
      try {
        return await runRequest(rpc, request, () => pollAndPush(true));
      } catch (e) {
        return { type: "result", v: PROTOCOL_VERSION, requestId: request.requestId, ok: false, reason: `扩展处理请求出错：${describeError(e, 300)}` };
      }
    },
    onError: (step, e) => errors.record(step, e),
  });
  const tryListen = async (): Promise<boolean> => {
    try {
      chosen = chooseSocket(deps.dataDir, sessionId, deps.socketOptions, chosen?.createdDir ?? null);
      await server.listen(chosen.path);
      listening = true;
    } catch (e) {
      errors.record("socket.listen", e);
    }
    return listening;
  };
  await tryListen();

  // 4. 登记记录
  const registrar = new Registrar({
    path: registrationPath(deps.dataDir, sessionId),
    record: {
      v: REGISTRATION_VERSION,
      protocol: PROTOCOL_VERSION,
      sessionId,
      copilotPid: deps.copilotPid,
      extensionPid: deps.pid,
      tmuxPane: deps.tmuxPane,
      cwd: deps.cwd,
      socketPath: listening ? ((chosen as ChosenSocket | null)?.path ?? null) : null,
      extensionVersion: deps.version,
      startedAt: clock.now(),
    },
    clock,
    timers,
    heartbeatMs: REGISTRATION_HEARTBEAT_MS,
    errors,
  });
  registrar.start();

  let retrying = false;
  const retryTimer = timers.setInterval(() => {
    if (listening || retrying || stopped) return;
    retrying = true;
    void tryListen()
      .then((ok) => {
        const current = chosen as ChosenSocket | null;
        if (ok && current && !stopped) registrar.setSocketPath(current.path);
      })
      .finally(() => {
        retrying = false;
      });
  }, SOCKET_RETRY_MS);

  // 5. 每秒查任务列表、推用量
  let ticks = 0;
  const idleEvery = Math.max(1, Math.round(TASKS_IDLE_POLL_MS / TASKS_POLL_MS));
  const tick = () => {
    if (stopped) return;
    ticks += 1;
    // 没有界面连着时没人看任务列表，降到 TASKS_IDLE_POLL_MS 查一次；界面一连上 onConnect 会马上查一次
    if (server.connectionCount > 0 || ticks % idleEvery === 0) void pollAndPush(false);
    if (usageDirty) {
      usageDirty = false;
      try {
        server.broadcast(usageMessage());
      } catch (e) {
        errors.record("usage.push", e);
      }
    }
  };
  const pollTimer = timers.setInterval(tick, TASKS_POLL_MS);
  void pollAndPush(false);

  // 6. 清理
  const cleanupTimer = timers.setTimeout(() => {
    try {
      const report = cleanupStale({
        dataDir: deps.dataDir,
        selfSessionId: sessionId,
        now: clock.now(),
        retentionMs: OUT_RETENTION_MS,
        isPidAlive: deps.isPidAlive,
      });
      for (const line of report.errors) log(`cleanup: ${line}`);
    } catch (e) {
      errors.record("cleanup", e);
    }
  }, CLEANUP_DELAY_MS);

  // 7. 补读历史：扩展重新加载（或 session 是恢复的）时，早已启动的命令没有经过本进程的订阅，shell 任务对不上 toolCallId，
  // 结束过的子 agent 也丢了 totalTokens。getEvents() 的历史不含 tool.shell_output 和 assistant.usage，所以只补这两样。
  void (async () => {
    try {
      const history = await session.getEvents?.();
      if (!Array.isArray(history) || stopped) return;
      const known = new Set(shells.calls().map((c) => c.toolCallId));
      for (const event of history) {
        if (typeof event !== "object" || event === null) continue;
        const data = event.data as { toolCallId?: unknown } | null | undefined;
        if (event.type === "tool.execution_start") {
          if (typeof data?.toolCallId === "string" && known.has(data.toolCallId)) continue; // 本进程已经亲眼看到了
          shells.onEvent(event);
        } else if (event.type === "tool.execution_complete") {
          shells.onEvent(event);
        } else if (event.type === "subagent.started" || event.type === "subagent.completed" || event.type === "subagent.failed") {
          if (usage.onEvent(event)) usageDirty = true;
        }
      }
      // 上一个进程正在抄输出的 detach 命令，接着抄；这些命令的 toolCallId 要靠上面补读的历史才对得上
      const { tasks } = await rpc.list();
      if (stopped) return;
      const matched = matchShellTasks(tasks, shells.calls(), new Map());
      for (const task of tasks) {
        const toolCallId = matched.get(task.id);
        if (task.type === "shell" && task.attachmentMode === "detached" && task.status === "running" && toolCallId !== undefined) {
          outputs.resumeDetached(rpc, toolCallId, task.id);
        }
      }
    } catch (e) {
      errors.record("backfill.events", e);
    }
  })();

  let stopping: Promise<void> | null = null;
  const doStop = async (): Promise<void> => {
    stopped = true;
    try {
      unsubscribe();
    } catch {
      // 取消订阅失败不影响后面的清理
    }
    timers.clearInterval(pollTimer);
    timers.clearInterval(retryTimer);
    timers.clearTimeout(cleanupTimer);
    outputs.stop();
    registrar.stop();
    try {
      await server.close();
    } catch (e) {
      errors.record("socket.close", e);
    }
    removeCreatedDir(chosen?.createdDir ?? null);
  };

  return {
    get socketPath() {
      return chosen?.path ?? "";
    },
    get listening() {
      return listening;
    },
    stop: () => (stopping ??= doStop()),
    cleanupSync: () => {
      registrar.stop();
      server.removeSocketFile();
      removeCreatedDir(chosen?.createdDir ?? null);
    },
    reportError: (step, error) => errors.record(step, error),
  };
}
