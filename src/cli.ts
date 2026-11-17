// copilot-panes 的命令行入口（打包成 dist/copilot-panes.mjs）。

import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { formatDoctor, runDoctor } from "./doctor.ts";
import { install } from "./install.ts";
import { dataDir as resolveDataDir, extensionInstallPath, sessionStateDir } from "./paths.ts";
import { runApp } from "./runtime.ts";
import { version } from "./version.ts";

export const USAGE = `用法：
  copilot-panes [选项]        在这个 tmux pane 里显示旁边 Copilot CLI 的子 agent 和后台命令
  copilot-panes install       把扩展装到 $COPILOT_HOME/extensions/copilot-panes/（原有文件先备份）
  copilot-panes doctor        检查实验功能、扩展、tmux 和找到的 session

选项：
  --session <ID>              只看这个 session（ID 可以只写前几位，能唯一认出就行）
  --session-state-dir <目录>  Copilot CLI 的 session 目录（默认 $COPILOT_HOME/session-state）
  --data-dir <目录>           copilot-panes 的运行时数据目录（默认 $COPILOT_HOME/copilot-panes）
  --light, --dark             浅色或深色终端的配色（默认问终端背景色，问不到就用深色）
  --no-bell                   有条目失败时不响铃
  --demo                      用内置的样本数据运行，不需要 Copilot CLI
  --dry-run                   只对 install 有用：只说会做什么，不改文件
  --version                   打印版本号
  --help                      打印这段说明

在界面里按 ? 看全部按键。没装扩展时也能看，只是只读；运行 copilot-panes install 装上扩展后才能发消息、停止。`;

export interface CliOptions {
  command: "run" | "install" | "doctor";
  sessionId: string | null;
  stateDir: string | null;
  dataDir: string | null;
  theme: "light" | "dark" | null;
  bell: boolean;
  demo: boolean;
  dryRun: boolean;
  version: boolean;
  help: boolean;
}

type Parsed = { ok: true; options: CliOptions } | { ok: false; error: string };

const VALUE_OPTIONS = new Map<string, "sessionId" | "stateDir" | "dataDir">([
  ["--session", "sessionId"],
  ["--session-state-dir", "stateDir"],
  ["--data-dir", "dataDir"],
]);

/**
 * 解析命令行（不含 node 和脚本路径）。第一个不以 "-" 开头的词是子命令（install、doctor），没有就是 run。
 * 不认识的选项、缺值的 --session 等返回 { ok: false, error }，error 是一句中文，调用方打印它和 USAGE 后以退出码 2 退出。
 * 带值的选项两种写法都认：`--session ID` 和 `--session=ID`。
 */
export function parseArgs(argv: readonly string[]): Parsed {
  const options: CliOptions = { command: "run", sessionId: null, stateDir: null, dataDir: null, theme: null, bell: true, demo: false, dryRun: false, version: false, help: false };
  let commandSeen = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (!arg.startsWith("-") || arg === "-") {
      if (commandSeen) return { ok: false, error: `多出一个参数：${arg}` };
      if (arg !== "install" && arg !== "doctor") return { ok: false, error: `不认识的子命令：${arg}（只有 install 和 doctor）` };
      options.command = arg;
      commandSeen = true;
      continue;
    }
    const equals = arg.indexOf("=");
    const name = equals > 0 ? arg.slice(0, equals) : arg;
    const field = VALUE_OPTIONS.get(name);
    if (field) {
      const value = equals > 0 ? arg.slice(equals + 1) : argv[++i];
      if (value === undefined || value === "" || (equals < 0 && value.startsWith("--"))) return { ok: false, error: `${name} 后面要跟一个值` };
      options[field] = value;
      continue;
    }
    switch (arg) {
      case "--light":
      case "--dark": {
        const theme = arg === "--light" ? "light" : "dark";
        if (options.theme !== null && options.theme !== theme) return { ok: false, error: "--light 和 --dark 只能用一个" };
        options.theme = theme;
        break;
      }
      case "--no-bell":
        options.bell = false;
        break;
      case "--demo":
        options.demo = true;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--version":
      case "-v":
        options.version = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        return { ok: false, error: `不认识的选项：${arg}` };
    }
  }
  if (options.dryRun && options.command !== "install") return { ok: false, error: "--dry-run 只能和 install 一起用" };
  if (options.demo && options.command !== "run") return { ok: false, error: "--demo 不能和子命令一起用" };
  return { ok: true, options };
}

/** 和 copilot-panes.mjs 在同一个目录的 extension.mjs；从源码运行时（src/cli.ts）是 <仓库>/dist/extension.mjs。 */
export function bundledExtensionPath(cliFile: string): string {
  const dir = dirname(cliFile);
  return basename(dir) === "src" ? join(dir, "..", "dist", "extension.mjs") : join(dir, "extension.mjs");
}

export async function main(argv: readonly string[]): Promise<number> {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    process.stderr.write(`${parsed.error}\n\n${USAGE}\n`);
    return 2;
  }
  const { options } = parsed;
  if (options.help) {
    console.log(USAGE);
    return 0;
  }
  if (options.version) {
    console.log(version);
    return 0;
  }
  const env = process.env;
  const home = homedir();
  const source = bundledExtensionPath(fileURLToPath(import.meta.url));
  if (options.command === "install") {
    const result = await install({ source, target: extensionInstallPath(env, home), now: new Date(), dryRun: options.dryRun });
    console.log(result.message);
    return result.exitCode;
  }
  const dataDir = resolveDataDir(env, home, options.dataDir);
  const stateDir = sessionStateDir(env, home, options.stateDir);
  if (options.command === "doctor") {
    const checks = await runDoctor({ env, home, version, dataDir, stateDir, bundledExtension: source });
    console.log(formatDoctor(checks));
    return checks.every((check) => check.ok) ? 0 : 1;
  }
  return runApp({
    sessionId: options.sessionId,
    stateDir,
    dataDir,
    themeFlag: options.theme,
    bell: options.bell,
    demo: options.demo,
    stdin: process.stdin,
    stdout: process.stdout,
    env,
  });
}

function isEntryPoint(): boolean {
  const script = process.argv[1];
  if (!script) return false;
  try {
    return realpathSync(script) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
      // 扩展客户端、stdin 等可能还挂着句柄；退出码已定，等输出写完就结束。
      process.stdout.write("", () => process.exit(code));
    },
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
      process.exit(1);
    },
  );
}
