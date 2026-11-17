// 选扩展 socket 的位置，并保证放它的目录是安全的。
// 路径太长又没有 XDG_RUNTIME_DIR 时，不能用 <临时目录>/copilot-panes-<uid>/ 这种猜得到的名字：别的用户先建好同名目录，扩展就 listen 失败，
// 或者在别人的目录里放 socket。所以这种情况用 mkdtemp 建随机名的 0700 目录，实际路径写进登记记录，退出时删掉。
// 目录一律用 lstat 检查（不跟随符号链接）：必须是真目录、属于当前用户；不满足就不用它，也绝不对它 chmod。

import { chmodSync, lstatSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { socketFallbackDir, socketPath } from "../../src/paths.ts";
import type { SocketPathOptions } from "../../src/paths.ts";

export interface ChosenSocket {
  path: string;
  /** 这次用 mkdtemp 建的目录（没有 XDG_RUNTIME_DIR 且路径太长时才有）；退出时要删掉。 */
  createdDir: string | null;
}

/** 目录是当前用户自己的真目录（不是符号链接）。不是就抛异常，调用方放弃这个目录。 */
export function assertOwnDirectory(dir: string, uid: number): void {
  const st = lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`${dir} 不是真目录（符号链接或别的东西），不用它放 socket`);
  if (typeof process.getuid === "function" && st.uid !== uid) throw new Error(`${dir} 不属于当前用户，不用它放 socket`);
}

/** 确保 dir 是自己的私有目录：不存在就建成 0700；存在就要通过 assertOwnDirectory，权限宽了改成 0700（改的是真目录，不是链接的目标）。 */
function ensurePrivateDir(dir: string, uid: number): void {
  try {
    lstatSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    mkdirSync(dir, { mode: 0o700 });
  }
  assertOwnDirectory(dir, uid);
  if ((lstatSync(dir).mode & 0o077) !== 0) chmodSync(dir, 0o700);
}

/**
 * 选 socket 的路径和目录：
 * - socketPath() 有结果：用它。结果在 XDG_RUNTIME_DIR 下的退路目录里时，先确保这个目录是自己的私有目录。
 * - 路径太长又没有 XDG_RUNTIME_DIR（socketPath() 是 null）：在 tmpDir 里 mkdtemp 建 copilot-panes-<uid>-XXXXXX（0700），socket 叫 s.sock。
 *   reuseDir 是上一次建的目录：还是自己的真目录就接着用，免得重试时留下一堆目录。
 * 目录不安全时抛异常；调用方记错、登记记录里 socketPath 写 null、过一会儿重试。
 */
export function chooseSocket(dataDir: string, sessionId: string, opts: SocketPathOptions, reuseDir: string | null = null): ChosenSocket {
  const direct = socketPath(dataDir, sessionId, opts);
  if (direct !== null) {
    if (dirname(direct) === socketFallbackDir(opts)) ensurePrivateDir(dirname(direct), opts.uid);
    return { path: direct, createdDir: null };
  }
  if (reuseDir !== null) {
    try {
      assertOwnDirectory(reuseDir, opts.uid);
      return { path: join(reuseDir, "s.sock"), createdDir: reuseDir };
    } catch {
      // 不能接着用就重新建一个
    }
  }
  const dir = mkdtempSync(join(opts.tmpDir, `copilot-panes-${opts.uid}-`));
  assertOwnDirectory(dir, opts.uid);
  return { path: join(dir, "s.sock"), createdDir: dir };
}

/** 删掉 mkdtemp 建的目录（里面最多一个 socket 文件）。名字不像是自己建的就不动。 */
export function removeCreatedDir(dir: string | null): void {
  if (dir === null || !/^copilot-panes-\d+-[A-Za-z0-9]+$/.test(basename(dir))) return;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // 删不掉就留给下一个扩展进程的清理
  }
}

/**
 * 数据目录里的子目录（sessions、out、out/<session ID>）里放着登记记录、socket 和命令输出，只许本人读写：
 * 已经存在而权限宽了（别的程序或用户自己建的）并且是自己的真目录时，改成 0700。符号链接、别人的目录不动。
 * 数据目录本身不动：COPILOT_PANES_HOME 可能指向一个用户有别的用途的目录，里面的子目录是 0700 就够了。
 */
export function tightenDirectory(dir: string, uid: number): void {
  try {
    const st = lstatSync(dir);
    if (!st.isDirectory() || st.isSymbolicLink()) return;
    if (typeof process.getuid === "function" && st.uid !== uid) return;
    if ((st.mode & 0o077) !== 0) chmodSync(dir, 0o700);
  } catch {
    // 不存在或读不了：之后真正用它的时候会报错
  }
}
