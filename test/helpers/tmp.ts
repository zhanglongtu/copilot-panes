// 测试用的临时目录，建在仓库的 .scratch/tmp/ 下（.scratch/ 不进 git），不碰系统临时目录和真实的 ~/.copilot。

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** 仓库根目录。 */
export const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** 建一个空的临时目录，名字以 prefix 开头（保持很短，unix socket 路径不能超过约 100 字节）。用完调用 cleanup()。 */
export function tempDir(prefix: string): { path: string; cleanup: () => void } {
  const root = join(REPO_ROOT, ".scratch", "tmp");
  mkdirSync(root, { recursive: true });
  const path = mkdtempSync(join(root, prefix));
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}
