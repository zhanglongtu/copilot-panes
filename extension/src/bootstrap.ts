// 进程层的接线：从环境变量和 process 算出 startPanes 的依赖，注册信号和未捕获异常的处理。
// 入口 extension.ts 只负责 joinSession；这里的东西都接受假的环境，所以能用假 session 测试。

import { homedir, tmpdir } from "node:os";
import { dataDir } from "../../src/paths.ts";
import { realClock, realTimers } from "../../src/types/clock.ts";
import type { Clock, Timers } from "../../src/types/clock.ts";
import { version } from "../../src/version.ts";
import { describeError } from "./errors.ts";
import { startPanes } from "./main.ts";
import type { ExtensionDeps, PanesHandle } from "./main.ts";
import type { PanesSession } from "./sdk.ts";

/** 进程上要挂处理函数的事件。 */
export type ProcessEvent = "SIGTERM" | "SIGINT" | "SIGHUP" | "exit" | "uncaughtException" | "unhandledRejection";

/** 扩展需要的进程环境。真的实现是 realHost()，测试传假的。 */
export interface HostEnvironment {
  env: Readonly<Record<string, string | undefined>>;
  pid: number;
  ppid: number;
  cwd: string;
  homeDir: string;
  tmpDir: string;
  uid: number;
  clock: Clock;
  timers: Timers;
  isPidAlive(pid: number): boolean;
  /** 写 stderr。不能写 stdout：stdout 是和 Copilot CLI 之间的 JSON-RPC 通道。 */
  writeStderr(text: string): void;
  onProcess(event: ProcessEvent, listener: (...args: unknown[]) => void): void;
  exit(code: number): void;
}

/** 收到 SIGTERM 后最多等 stop() 这么久，不管有没有做完都退出。Copilot CLI 给的宽限期可能只有 1 秒，stop() 自己通常在 0.3 秒内做完。 */
export const SHUTDOWN_WAIT_MS = 3000;

export function realHost(): HostEnvironment {
  return {
    env: process.env,
    pid: process.pid,
    ppid: process.ppid,
    cwd: process.cwd(),
    homeDir: homedir(),
    tmpDir: tmpdir(),
    uid: typeof process.getuid === "function" ? process.getuid() : 0,
    clock: realClock,
    timers: realTimers,
    isPidAlive: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (e) {
        return (e as NodeJS.ErrnoException).code === "EPERM";
      }
    },
    writeStderr: (text) => {
      try {
        process.stderr.write(text);
      } catch {
        // stderr 写不进去也不能影响扩展
      }
    },
    onProcess: (event, listener) => {
      process.on(event as never, listener as never);
    },
    exit: (code) => process.exit(code),
  };
}

function positiveInt(text: string | undefined): number | null {
  const n = Number(text);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** 算出 startPanes 的依赖。Copilot CLI 的进程号：环境变量 COPILOT_EXTENSION_PARENT_PID（Copilot CLI 设的），没有时是父进程。 */
export function buildDeps(host: HostEnvironment): ExtensionDeps {
  return {
    dataDir: dataDir(host.env, host.homeDir),
    socketOptions: { runtimeDir: host.env.XDG_RUNTIME_DIR || null, tmpDir: host.tmpDir, uid: host.uid },
    clock: host.clock,
    timers: host.timers,
    pid: host.pid,
    copilotPid: positiveInt(host.env.COPILOT_EXTENSION_PARENT_PID) ?? host.ppid,
    tmuxPane: host.env.TMUX_PANE || null,
    cwd: host.cwd,
    version,
    isPidAlive: (pid) => host.isPidAlive(pid),
    logError: (message) => host.writeStderr(`copilot-panes 扩展：${message}\n`),
  };
}

/**
 * 用一个 session 启动扩展，并挂好进程级的处理：
 * - SIGTERM、SIGINT、SIGHUP：调用 stop()（最多等 SHUTDOWN_WAIT_MS），然后退出。
 * - exit：同步删掉登记记录和 socket 文件。Copilot CLI 被强杀时，SDK 的看门狗会直接 process.exit，走不到信号处理。
 * - uncaughtException、unhandledRejection：只记录，不退出。扩展里任何异常都不能拖垮 Copilot CLI 的 session。
 * 这些处理函数先于 startPanes 挂上，所以启动期间的异常也兜得住。
 */
export async function runWithSession(session: PanesSession, host: HostEnvironment = realHost()): Promise<PanesHandle> {
  let handle: PanesHandle | null = null;
  let starting: Promise<PanesHandle> | null = null;
  const report = (step: string, error: unknown) => {
    if (handle) {
      try {
        handle.reportError(step, error); // 它的 ErrorLog 也会写 stderr
      } catch {
        // 记录出错本身不能再出错
      }
      return;
    }
    host.writeStderr(`copilot-panes 扩展：${step}: ${describeError(error)}\n`);
  };
  host.onProcess("uncaughtException", (e) => report("uncaught", e));
  host.onProcess("unhandledRejection", (e) => report("unhandled.rejection", e));

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    let exited = false;
    const finish = () => {
      if (exited) return;
      exited = true;
      try {
        handle?.cleanupSync();
      } catch {
        // 已经在退出了，清理不成也只能算了
      }
      host.exit(0);
    };
    host.timers.setTimeout(finish, SHUTDOWN_WAIT_MS);
    // 还在启动时收到信号：等启动做完再停，免得留下登记记录和 socket 文件
    const stopping = starting ? starting.then((h) => h.stop()) : Promise.resolve();
    stopping.then(finish, finish);
  };
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) host.onProcess(signal, shutdown);
  host.onProcess("exit", () => {
    try {
      handle?.cleanupSync();
    } catch {
      // 同上
    }
  });

  starting = startPanes(session, buildDeps(host));
  handle = await starting;
  return handle;
}
