// copilot-panes install：把 dist/extension.mjs 装到 $COPILOT_HOME/extensions/copilot-panes/extension.mjs。

import { copyFile, mkdir, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export interface InstallOptions {
  /** 要装的文件：打包后的 extension.mjs（和 copilot-panes.mjs 在同一个目录；从 src/cli.ts 运行时是 <仓库>/dist/extension.mjs）。 */
  source: string;
  /** 目标文件（src/paths.ts 的 extensionInstallPath）。 */
  target: string;
  /** 当前时刻，用于备份文件名。 */
  now: Date;
  /** 只说会做什么，不动任何文件。 */
  dryRun?: boolean;
}

export interface InstallResult {
  /** 0 装好了或已经是最新的；2 没装成。 */
  exitCode: 0 | 2;
  /** 给人看的几行说明（装到哪里、下一步做什么，或者为什么没装成）。 */
  message: string;
  /** 原有文件的备份路径；没有原有文件或内容相同时是 null。 */
  backup: string | null;
}

const NEXT_STEPS = [
  "下一步：",
  "  1. 在 Copilot CLI 里运行 /settings experimental on，打开实验功能（已经开了就跳过）。",
  "  2. 重新启动 Copilot CLI，或让它重新加载扩展。",
  "  3. 运行 copilot-panes doctor 确认。",
].join("\n");

/** 20261116-081932：本地时间，文件名里不带冒号。 */
export function backupStamp(now: Date): string {
  const two = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}-${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`;
}

async function readOrNull(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch {
    return null;
  }
}

/**
 * 安装：
 * - 源文件读不到：exitCode 2，说明写出源文件路径和“先运行 npm run build”。
 * - 目标和源逐字节相同：不动它，说“扩展已经是最新的”。
 * - 目标存在且不同：先改名备份成 extension.mjs.bak-<YYYYMMDD-HHMMSS>，再装新的。
 * - 安装用“同目录写临时文件再 rename”，任何时候目标都不是写了一半的文件；失败时删掉临时文件、保留原文件，exitCode 2。
 * - 目录不存在时建好。装好后提示：在 Copilot CLI 里运行 /settings experimental on（如果还没开），再重启 Copilot CLI 或让它重新加载扩展。
 */
export async function install(options: InstallOptions): Promise<InstallResult> {
  const { source, target, now, dryRun = false } = options;
  const wanted = await readOrNull(source);
  if (wanted === null) {
    return { exitCode: 2, backup: null, message: `找不到要装的扩展：${source}\n先在仓库里运行 npm run build，再重试。` };
  }
  const existing = await readOrNull(target);
  if (existing !== null && existing.equals(wanted)) {
    return { exitCode: 0, backup: null, message: `扩展已经是最新的：${target}\n${NEXT_STEPS}` };
  }
  const backup = existing === null ? null : `${target}.bak-${backupStamp(now)}`;
  if (dryRun) {
    const lines = [`（试运行，没有改动任何文件）`, `会把 ${source} 装到 ${target}`];
    if (backup) lines.push(`原有的文件会先备份成 ${backup}`);
    return { exitCode: 0, backup, message: lines.join("\n") };
  }

  const temporary = join(dirname(target), `.${basename(target)}.tmp-${process.pid}`);
  try {
    await mkdir(dirname(target), { recursive: true });
    await copyFile(source, temporary);
    if (backup) await rename(target, backup);
    try {
      await rename(temporary, target);
    } catch (error) {
      if (backup) await rename(backup, target).catch(() => {});
      throw error;
    }
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    const reason = error instanceof Error ? error.message : String(error);
    return { exitCode: 2, backup: null, message: `没装成：${reason}\n原有的扩展没有改动。` };
  }
  const lines = [`已安装扩展：${target}`];
  if (backup) lines.push(`原有的文件备份在 ${backup}`);
  lines.push(NEXT_STEPS);
  return { exitCode: 0, backup, message: lines.join("\n") };
}
