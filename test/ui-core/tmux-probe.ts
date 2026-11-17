// 核对显示宽度用的 tmux 小工具：开一个独立的 tmux 服务（socket 名带进程号，绝不碰默认服务），在里面运行 tmux-pane.mjs 量宽度。
// 不是测试文件；width-tmux.test.ts 和 gen-width-table.ts 导入它。
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { tempDir } from "../helpers/tmp.ts";

const PANE_SCRIPT = fileURLToPath(new URL("./tmux-pane.mjs", import.meta.url));
const ENV = { ...process.env, LC_ALL: "C.UTF-8", LANG: "C.UTF-8" };
let serial = 0;

export function tmuxAvailable(): boolean {
  return spawnSync("tmux", ["-V"], { encoding: "utf8" }).status === 0;
}

/** src/ui/width-table.ts 是用这个版本的 tmux 逐个码点测出来的。 */
export const MEASURED_TMUX_VERSION = "3.4";

/** 和 tmux 逐个比较宽度的测试要不要跳过：没有 tmux，或者 tmux 的版本和测宽度表时的不一样（不同版本对个别字符的宽度算法不同）。 */
export function widthCheckSkipReason(): string | false {
  const result = spawnSync("tmux", ["-V"], { encoding: "utf8" });
  if (result.status !== 0) return "tmux is not installed";
  const version = /^tmux\s+(\S+)/.exec(result.stdout)?.[1] ?? "unknown";
  if (version !== MEASURED_TMUX_VERSION) return `tmux ${version} is installed; the width table was measured with tmux ${MEASURED_TMUX_VERSION}, other versions may count some characters differently`;
  return false;
}

const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

/** 一个独立的 tmux 服务，里面只有一个 100 列 30 行的 session "w"。 */
export class TmuxServer {
  readonly socket = `cp-uicore-${process.pid}-${serial++}`;
  private socketPath: string | null = null;

  tmux(...args: string[]): string {
    return execFileSync("tmux", ["-u", "-L", this.socket, ...args], { encoding: "utf8", env: ENV, stdio: ["ignore", "pipe", "pipe"] });
  }

  start(command: string): void {
    this.tmux("-f", "/dev/null", "new-session", "-d", "-s", "w", "-x", "100", "-y", "30", command);
    this.socketPath = this.tmux("display-message", "-p", "-t", "w", "#{socket_path}").trim();
  }

  /** 关掉服务并删掉它的 socket 文件（tmux 的 kill-server 不一定删）。可以重复调用。 */
  kill(): void {
    try {
      this.tmux("kill-server");
    } catch {
      // 服务已经退出
    }
    if (this.socketPath) rmSync(this.socketPath, { force: true });
    this.socketPath = null;
  }
}

/** 在独立的 tmux 里运行 tmux-pane.mjs，等它写出 outFile 再读回来。 */
async function runPane<T>(args: string[], outFile: string, timeoutMs: number): Promise<T> {
  const server = new TmuxServer();
  try {
    server.start(`node ${quote(PANE_SCRIPT)} ${args.map(quote).join(" ")}`);
    const deadline = Date.now() + timeoutMs;
    while (!existsSync(outFile)) {
      if (Date.now() > deadline) throw new Error(`tmux-pane ${args[0]} timed out`);
      await sleep(20);
    }
    await sleep(20);
    return JSON.parse(readFileSync(outFile, "utf8")) as T;
  } finally {
    server.kill();
  }
}

/** tmux 对每个码点（跳过控制字符和代理对）报告的宽度，合并成 [起点, 终点, 宽度] 区间。 */
export async function scanCodePoints(): Promise<[number, number, number][]> {
  const dir = tempDir("w");
  try {
    return await runPane(["scan", join(dir.path, "o.json")], join(dir.path, "o.json"), 120_000);
  } finally {
    dir.cleanup();
  }
}

/** tmux 对每个字符串报告的宽度（每个字符串从行首开始打印）。 */
export async function measureStrings(strings: string[]): Promise<number[]> {
  const dir = tempDir("w");
  try {
    const input = join(dir.path, "i.json");
    const output = join(dir.path, "o.json");
    writeFileSync(input, JSON.stringify(strings));
    return await runPane(["strings", input, output], output, 120_000);
  } finally {
    dir.cleanup();
  }
}

/** 逐个打印字符串，每个都用 `tmux display-message -p '#{cursor_x}'` 读光标列。 */
export async function measureWithDisplayMessage(strings: string[]): Promise<number[]> {
  const dir = tempDir("w");
  const server = new TmuxServer();
  try {
    const input = join(dir.path, "i.json");
    writeFileSync(input, JSON.stringify(strings));
    server.start(`node ${quote(PANE_SCRIPT)} serve ${quote(input)}`);
    const widths: number[] = [];
    for (let i = 0; i < strings.length; i++) {
      const deadline = Date.now() + 10_000;
      for (;;) {
        const [title, x] = server.tmux("display-message", "-p", "-t", "w", "#{pane_title} #{cursor_x}").trim().split(" ");
        if (title === `done-${i}`) {
          widths.push(Number(x));
          break;
        }
        if (Date.now() > deadline) throw new Error(`no output for string ${i}`);
        await sleep(2);
      }
      server.tmux("send-keys", "-t", "w", "x");
    }
    return widths;
  } finally {
    server.kill();
    dir.cleanup();
  }
}
