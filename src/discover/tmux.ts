// 问 tmux：同一个窗口里有哪些 pane、各自的 shell 进程号。只读，不改任何 tmux 设置。

import { execFile } from "node:child_process";

/** 运行一条 tmux 命令，返回标准输出。测试用假的实现，不碰用户的 tmux。 */
export type TmuxRunner = (args: readonly string[]) => Promise<string>;

/** 真的 tmux：execFile("tmux", args)，超时 2 秒；失败时 Promise 被拒绝。 */
export function realTmux(): TmuxRunner {
  return (args) =>
    new Promise((resolve, reject) => {
      execFile("tmux", [...args], { timeout: 2000, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      });
    });
}

export interface TmuxPane {
  paneId: string;
  panePid: number;
  windowId: string;
}

/**
 * selfPaneId 所在窗口的所有 pane（含自己）：运行 `tmux list-panes -t <selfPaneId> -F "#{pane_id} #{pane_pid} #{window_id}"`。
 * 格式不对的行跳过；tmux 出错返回 []。
 */
export async function windowPanes(selfPaneId: string, run: TmuxRunner): Promise<TmuxPane[]> {
  let output: string;
  try {
    output = await run(["list-panes", "-t", selfPaneId, "-F", "#{pane_id} #{pane_pid} #{window_id}"]);
  } catch {
    return [];
  }
  const panes: TmuxPane[] = [];
  for (const line of output.split("\n")) {
    const match = /^(%\d+) (\d+) (@\d+)\s*$/.exec(line);
    if (!match) continue;
    const panePid = Number(match[2]);
    if (panePid > 0) panes.push({ paneId: match[1]!, panePid, windowId: match[3]! });
  }
  return panes;
}
