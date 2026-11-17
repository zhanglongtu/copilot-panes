// 扩展启动后清理旧东西：过期的命令输出目录、失效的登记记录和 socket。多个 Copilot CLI 进程可能同时清理，删不到（ENOENT）不算出错。

import { lstatSync, readdirSync, readFileSync, rmdirSync, rmSync } from "node:fs";
import type { Stats } from "node:fs";
import { basename, dirname, join } from "node:path";
import { parseRegistration } from "../../src/protocol.ts";
import { outRoot, safeName, sessionsDir } from "../../src/paths.ts";

export interface CleanupOptions {
  dataDir: string;
  /** 自己的 session ID：它的目录和登记记录永远不删。 */
  selfSessionId: string;
  now: number;
  /** 输出目录最后修改早于 now - retentionMs 就删（OUT_RETENTION_MS，7 天）。 */
  retentionMs: number;
  /** 判断进程是否活着。 */
  isPidAlive(pid: number): boolean;
}

export interface CleanupReport {
  /** 删掉的 out/<session ID> 目录名。 */
  removedOutDirs: string[];
  /** 删掉的登记记录对应的 session ID。 */
  removedRegistrations: string[];
  /** 没删成的文件和原因（ENOENT 不算），给调用方写日志用。 */
  errors: string[];
}

/** 没有登记记录的 socket 和临时文件，至少这么久没动才删：另一个扩展可能刚开好 socket、还没来得及写登记记录。 */
const ORPHAN_GRACE_MS = 60_000;

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

/**
 * 清理：
 * - <dataDir>/out/ 下最后修改早于 now - retentionMs 的子目录（整个删掉）。目录的修改时间取它自己和它里面各文件中最新的，
 *   因为往已有文件里追加不会改目录的修改时间；登记记录还有效的 session 的目录不删。
 * - <dataDir>/sessions/ 下的登记记录：copilotPid 已经不在的，删掉它和它的 socketPath 指向的 socket 文件；
 *   解析不了的登记记录，最后修改早于 now - retentionMs 才删。
 * - <dataDir>/sessions/ 下没有对应登记记录的 .sock 文件和残留的 .tmp 文件（超过 60 秒没动的）。
 * 出错的单个文件跳过，不中断清理。从不抛异常。
 */
export function cleanupStale(options: CleanupOptions): CleanupReport {
  const report: CleanupReport = { removedOutDirs: [], removedRegistrations: [], errors: [] };
  try {
    const liveSessions = cleanupRegistrations(options, report);
    cleanupOutDirs(options, report, liveSessions);
  } catch (e) {
    report.errors.push(`cleanup: ${e instanceof Error ? e.message : String(e)}`);
  }
  return report;
}

function remove(path: string, report: CleanupReport, recursive: boolean = false): boolean {
  try {
    rmSync(path, { force: true, recursive });
    return true;
  } catch (e) {
    report.errors.push(`${path}: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

/** 处理 sessions/ 目录，返回登记记录仍然有效的 session 目录名（safeName 之后的）。 */
function cleanupRegistrations(options: CleanupOptions, report: CleanupReport): Set<string> {
  const live = new Set<string>();
  const dir = sessionsDir(options.dataDir);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return live;
  }
  const own = safeName(options.selfSessionId);
  const registered = new Set<string>();
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const base = name.slice(0, -".json".length);
    registered.add(base);
    const path = join(dir, name);
    if (base === own) {
      live.add(base);
      continue;
    }
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    const parsed = parseRegistration(text);
    if (!parsed.ok) {
      const st = lstatOrNull(path);
      if (st && options.now - st.mtimeMs > options.retentionMs) remove(path, report);
      continue;
    }
    const registration = parsed.value;
    if (options.isPidAlive(registration.copilotPid)) {
      live.add(base);
      continue;
    }
    if (registration.socketPath !== null && lstatOrNull(registration.socketPath)?.isSocket()) {
      remove(registration.socketPath, report);
      // 没有 XDG_RUNTIME_DIR 时 socket 放在 mkdtemp 建的随机目录里（socketdir.ts）；进程没了没清掉的空目录一起删（非空删不掉，不管）
      const dir = dirname(registration.socketPath);
      if (/^copilot-panes-\d+-[A-Za-z0-9]+$/.test(basename(dir))) {
        try {
          rmdirSync(dir);
        } catch {
          // 不是空的或已经没了
        }
      }
    }
    if (remove(path, report)) report.removedRegistrations.push(registration.sessionId);
  }
  for (const name of names) {
    const isSocket = name.endsWith(".sock");
    const isTemp = name.endsWith(".tmp");
    if (!isSocket && !isTemp) continue;
    if (isSocket && registered.has(name.slice(0, -".sock".length))) continue;
    const path = join(dir, name);
    const st = lstatOrNull(path);
    if (!st || (isSocket && !st.isSocket()) || (isTemp && !st.isFile())) continue;
    if (options.now - st.mtimeMs > ORPHAN_GRACE_MS) remove(path, report);
  }
  return live;
}

function cleanupOutDirs(options: CleanupOptions, report: CleanupReport, liveSessions: ReadonlySet<string>): void {
  const root = outRoot(options.dataDir);
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return;
  }
  const own = safeName(options.selfSessionId);
  for (const name of names) {
    if (name === own || liveSessions.has(name)) continue;
    const path = join(root, name);
    const st = lstatOrNull(path);
    if (!st?.isDirectory()) continue;
    let newest = st.mtimeMs;
    try {
      for (const file of readdirSync(path)) {
        const child = lstatOrNull(join(path, file));
        if (child) newest = Math.max(newest, child.mtimeMs);
      }
    } catch {
      continue;
    }
    if (options.now - newest > options.retentionMs && remove(path, report, true)) report.removedOutDirs.push(name);
  }
}
