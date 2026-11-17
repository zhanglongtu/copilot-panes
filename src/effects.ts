// 状态机产生的、要碰终端和 tmux 的动作：y 复制，o 用 less 打开全文，以及它们的退路。
// 真的 tmux 用 spawn 调用，不设超时（display-popup 要等用户关掉窗口）；测试传假的函数。

import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type Env = Readonly<Record<string, string | undefined>>;

/** 运行一条 tmux 命令并把 input 写到它的标准输入；失败（含退出码不为 0）时 Promise 被拒绝，错误信息是 tmux 的 stderr。 */
export type TmuxInput = (args: readonly string[], input: string) => Promise<void>;
/** 运行一条要等很久的 tmux 命令（display-popup）；不设超时。 */
export type TmuxWait = (args: readonly string[]) => Promise<void>;

function runTmux(args: readonly string[], input: string | null, timeoutMs: number | null): Promise<void> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn("tmux", [...args], { stdio: [input === null ? "ignore" : "pipe", "ignore", "pipe"] });
    } catch (error) {
      reject(error);
      return;
    }
    let stderr = "";
    const timer = timeoutMs === null ? null : setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      if (timer) clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `tmux 退出码 ${code}`));
    });
    if (input !== null) {
      child.stdin?.on("error", () => {});
      child.stdin?.end(input);
    }
  });
}

export const realTmuxInput: TmuxInput = (args, input) => runTmux(args, input, 3000);
export const realTmuxWait: TmuxWait = (args) => runTmux(args, null, null);

/**
 * 复制到 tmux 缓冲区：`tmux load-buffer -w -`（文字从标准输入给；-w 同时按 set-clipboard 设置发给外层终端的剪贴板）。
 * 较老的 tmux 不认 -w 时退回 `tmux load-buffer -`。不在 tmux 里（没有 TMUX）或失败时 Promise 被拒绝，调用方改用 OSC 52。
 */
export async function copyToTmux(text: string, env: Env, run: TmuxInput = realTmuxInput): Promise<void> {
  if (!env.TMUX) throw new Error("不在 tmux 里");
  try {
    await run(["load-buffer", "-w", "-"], text);
  } catch {
    await run(["load-buffer", "-"], text);
  }
}

/** OSC 52：让终端自己把文字放进系统剪贴板。 */
export function osc52(text: string): string {
  return `\x1b]52;c;${Buffer.from(text, "utf8").toString("base64")}\x07`;
}

/** y 键：在 tmux 里用 tmux 缓冲区，否则（或 tmux 失败时）用 OSC 52 写到终端。返回用了哪种。 */
export async function copyText(text: string, env: Env, writeTerminal: (data: string) => void, run: TmuxInput = realTmuxInput): Promise<"tmux" | "osc52"> {
  try {
    await copyToTmux(text, env, run);
    return "tmux";
  } catch {
    writeTerminal(osc52(text));
    return "osc52";
  }
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** tmux display-popup 的参数：90% 宽高，less 退出时窗口关闭。 */
export function pagerPopupArgs(filePath: string): string[] {
  return ["display-popup", "-E", "-w", "90%", "-h", "90%", `less -R ${shellQuote(filePath)}`];
}

/** 在 tmux 弹出窗口里用 less -R 打开文件；窗口关闭后兑现。弹不出来（没有 tmux 客户端、版本太旧）时被拒绝。 */
export function openPager(filePath: string, run: TmuxWait = realTmuxWait): Promise<void> {
  return run(pagerPopupArgs(filePath));
}

/**
 * 不在 tmux 里：before() 让出终端（离开备用屏幕、关 raw 模式），同步运行 less，after() 拿回终端。
 * less 不存在或出错时返回原因。
 */
export function openPagerInline(filePath: string, hooks: { before(): void; after(): void }): string | null {
  hooks.before();
  try {
    const result = spawnSync("less", ["-R", filePath], { stdio: "inherit" });
    if (result.error) return `打不开 less：${result.error.message}`;
    return null;
  } finally {
    hooks.after();
  }
}

let pagerFiles = 0;

/** 把全文写到 <dir>/pager-<进程号>-<序号>.txt（0600，目录 0700），返回路径。用完调用 removePagerFile。 */
export function writePagerFile(dir: string, text: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `pager-${process.pid}-${++pagerFiles}.txt`);
  writeFileSync(path, text, { mode: 0o600 });
  return path;
}

export function removePagerFile(path: string): void {
  rmSync(path, { force: true });
}
