// 所有路径怎么拼：Copilot CLI 的目录、copilot-panes 的运行时数据目录、登记记录、socket、命令输出文件。
// 扩展和界面共用这一份，两边算出的路径一定相同。所有函数都是纯函数：环境变量、主目录、临时目录都由参数传进来。
//
// 目录布局（dataDir 默认是 $COPILOT_HOME/copilot-panes，COPILOT_HOME 没设时是 ~/.copilot）：
//   <dataDir>/sessions/<session ID>.json   扩展写的登记记录（protocol.ts 的 Registration）
//   <dataDir>/sessions/<session ID>.sock   扩展开的 unix socket（路径太长时改放别处，见 socketPath；真实路径以登记记录为准，登记记录里是 null 表示没开成）
//   <dataDir>/out/<session ID>/<toolCallId>.out   扩展追加的命令原始输出
//   <dataDir>/tmp/                          界面放临时文件（例如 o 键给 less 看的全文）
//   <sessionStateDir>/<session ID>/events.jsonl、workspace.yaml、inuse.<进程号>.lock   Copilot CLI 自己写的

import { createHash } from "node:crypto";
import { join } from "node:path";

/** 环境变量的只读视图，传 process.env 即可。 */
export type PathEnv = Readonly<Record<string, string | undefined>>;

/** 改运行时数据目录的环境变量（测试和自定义安装用）。 */
export const DATA_DIR_ENV = "COPILOT_PANES_HOME";
/** 改 session-state 目录的环境变量（测试用）。 */
export const STATE_DIR_ENV = "COPILOT_PANES_STATE_DIR";
/** unix socket 路径的上限（字节）。Linux 的上限是 107 字节，留一点余量。 */
export const MAX_SOCKET_PATH_BYTES = 100;
/** safeName 结果的上限（字符）。文件名上限是 255 字节，加上 ".out" 等后缀仍留余量。 */
export const MAX_SAFE_NAME_CHARS = 200;

/** $COPILOT_HOME，没设或为空时是 <home>/.copilot。 */
export function copilotHome(env: PathEnv, home: string): string {
  return env.COPILOT_HOME || join(home, ".copilot");
}

/** 运行时数据目录：参数指定的优先，其次环境变量 COPILOT_PANES_HOME，最后 <copilotHome>/copilot-panes。 */
export function dataDir(env: PathEnv, home: string, override?: string | null): string {
  return override || env[DATA_DIR_ENV] || join(copilotHome(env, home), "copilot-panes");
}

/** Copilot CLI 放 session 的目录：参数指定的优先，其次环境变量 COPILOT_PANES_STATE_DIR，最后 <copilotHome>/session-state。 */
export function sessionStateDir(env: PathEnv, home: string, override?: string | null): string {
  return override || env[STATE_DIR_ENV] || join(copilotHome(env, home), "session-state");
}

/**
 * 把任意字符串变成安全的文件名：A-Za-z0-9._- 以外的每个 UTF-16 单元换成 "_"（所以 U+FFFF 以上的字符变成两个 "_"），
 * 全是点的名字和空串换成 "_"，超过 200 个字符时保留前 180 个、接 "-" 和原文 SHA-256 的前 16 个十六进制字符。
 */
export function safeName(s: string): string {
  let name = s.replace(/[^A-Za-z0-9._-]/g, "_");
  if (name === "" || /^\.+$/.test(name)) name = "_";
  if (name.length > MAX_SAFE_NAME_CHARS) {
    const digest = createHash("sha256").update(s, "utf8").digest("hex").slice(0, 16);
    name = `${name.slice(0, 180)}-${digest}`;
  }
  return name;
}

/** <stateDir>/<session ID>。 */
export function sessionDir(stateDir: string, sessionId: string): string {
  return join(stateDir, safeName(sessionId));
}

/** <stateDir>/<session ID>/events.jsonl：Copilot CLI 写的事件日志。 */
export function eventsPath(stateDir: string, sessionId: string): string {
  return join(sessionDir(stateDir, sessionId), "events.jsonl");
}

/** <stateDir>/<session ID>/workspace.yaml：里面有 cwd 和 session 的名字（name）。 */
export function workspacePath(stateDir: string, sessionId: string): string {
  return join(sessionDir(stateDir, sessionId), "workspace.yaml");
}

/** <dataDir>/sessions：登记记录和默认的 socket 放这里。 */
export function sessionsDir(dataDir: string): string {
  return join(dataDir, "sessions");
}

/** <dataDir>/sessions/<session ID>.json。 */
export function registrationPath(dataDir: string, sessionId: string): string {
  return join(sessionsDir(dataDir), `${safeName(sessionId)}.json`);
}

/** socket 路径太长时的退路需要的三样东西。 */
export interface SocketPathOptions {
  /** 环境变量 XDG_RUNTIME_DIR，没有就 null。 */
  runtimeDir: string | null;
  /** os.tmpdir()。 */
  tmpDir: string;
  /** process.getuid()。 */
  uid: number;
}

/**
 * 退路目录：<XDG_RUNTIME_DIR>/copilot-panes（XDG_RUNTIME_DIR 是系统给每个用户建的私有目录 0700，别的用户在里面建不了东西）。
 * 没有 XDG_RUNTIME_DIR 时没有现成的私有目录，返回 null：临时目录是大家都能写的，名字猜得到的目录会被别的用户抢先建好，
 * 所以那时扩展用 mkdtemp 在临时目录里建一个随机名的 0700 目录（extension/src/socketdir.ts），路径写进登记记录。
 */
export function socketFallbackDir(opts: SocketPathOptions): string | null {
  return opts.runtimeDir ? join(opts.runtimeDir, "copilot-panes") : null;
}

/**
 * 扩展开 socket 的路径。默认 <dataDir>/sessions/<session ID>.sock；超过 MAX_SOCKET_PATH_BYTES 字节时改成
 * <退路目录>/<SHA-256(dataDir + "\0" + sessionId) 的前 16 个十六进制字符>.sock；路径太长又没有退路目录时返回 null（调用方改用 mkdtemp）。
 * 退路目录里的路径也超长时照样返回它，由扩展在 listen 失败时记错。界面不调用这个函数，而是读登记记录里的 socketPath。
 */
export function socketPath(dataDir: string, sessionId: string, opts: SocketPathOptions): string | null {
  const preferred = join(sessionsDir(dataDir), `${safeName(sessionId)}.sock`);
  if (Buffer.byteLength(preferred, "utf8") <= MAX_SOCKET_PATH_BYTES) return preferred;
  const dir = socketFallbackDir(opts);
  if (dir === null) return null;
  const digest = createHash("sha256").update(`${dataDir}\0${sessionId}`, "utf8").digest("hex").slice(0, 16);
  return join(dir, `${digest}.sock`);
}

/** <dataDir>/out：所有 session 的命令输出。 */
export function outRoot(dataDir: string): string {
  return join(dataDir, "out");
}

/** <dataDir>/out/<session ID>。 */
export function outDir(dataDir: string, sessionId: string): string {
  return join(outRoot(dataDir), safeName(sessionId));
}

/** <dataDir>/out/<session ID>/<toolCallId>.out：toolCallId 是命令的 tool.execution_start 的编号。 */
export function outPath(dataDir: string, sessionId: string, toolCallId: string): string {
  return join(outDir(dataDir, sessionId), `${safeName(toolCallId)}.out`);
}

/** <dataDir>/tmp：界面的临时文件。 */
export function scratchDir(dataDir: string): string {
  return join(dataDir, "tmp");
}

/** <copilotHome>/extensions/copilot-panes：copilot-panes install 把扩展装到这里。 */
export function extensionInstallDir(env: PathEnv, home: string): string {
  return join(copilotHome(env, home), "extensions", "copilot-panes");
}

/** <copilotHome>/extensions/copilot-panes/extension.mjs。 */
export function extensionInstallPath(env: PathEnv, home: string): string {
  return join(extensionInstallDir(env, home), "extension.mjs");
}

/** <copilotHome>/settings.json：doctor 检查实验功能开没开。 */
export function settingsPath(env: PathEnv, home: string): string {
  return join(copilotHome(env, home), "settings.json");
}
