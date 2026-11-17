// 名单“最近一步”一栏的文字、过程记录里工具调用那一行的文字、模型短名、回复的第一句正文。纯函数。

import { homedir } from "node:os";
import type { AgentRecord, CommandRecord, EntryStatus, StoreView, ToolItem, ToolLine } from "../types/model.ts";
import { editLinesOf } from "./limits.ts";
import { oneLine } from "./output.ts";
import { extractProgress } from "./progress.ts";

/**
 * 工具名 → 中文动词。表里没有的工具，动词直接用工具名。
 * powershell 和 bash 一样是“跑”。
 */
export const TOOL_VERBS: Readonly<Record<string, string>> = {
  view: "看",
  grep: "搜",
  glob: "找",
  edit: "改",
  create: "建",
  bash: "跑",
  powershell: "跑",
  task: "起子 agent",
  read_bash: "读输出",
  stop_bash: "停命令",
  web_fetch: "取网页",
  web_search: "搜网页",
};

const PATH_KEYS = ["path", "filePath", "file_path"];
const GENERIC_KEYS = ["pattern", "query", "url", "description", "name", "agent_id", "prompt"];
const SHELL_TOOLS = new Set(["bash", "powershell"]);

interface LineOptions {
  /** 主目录；默认取当前用户的。测试里传固定值。 */
  home?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function argsOf(item: ToolItem): Record<string, unknown> {
  return isRecord(item.args) ? item.args : {};
}

/** 第一个非空字符串参数；类型不对的跳过。 */
function firstString(args: Record<string, unknown>, keys: readonly string[]): { key: string; value: string } | null {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value.trim() !== "") return { key, value };
  }
  return null;
}

function verbOf(toolName: string): string {
  return Object.hasOwn(TOOL_VERBS, toolName) ? (TOOL_VERBS[toolName] as string) : toolName;
}

function baseName(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1) || path;
}

/** 命令的第一行（跳过开头的空行），空白折成一个空格。 */
function commandFirstLine(command: string): string {
  const first = command.split("\n").find((line) => line.trim() !== "");
  return first === undefined ? "" : oneLine(first);
}

function metric(telemetry: unknown, key: string): number | null {
  if (!isRecord(telemetry) || !isRecord(telemetry.metrics)) return null;
  const value = telemetry.metrics[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function matchCount(item: ToolItem): number | null {
  if (item.status !== "ok") return null;
  const text = item.resultText ?? "";
  if (text.trim() === "No matches found.") return 0;
  const header = /^\[grep[^\]:\n]*:\s*(\d+) match/.exec(text);
  return header ? Number(header[1]) : null;
}

function fileCount(item: ToolItem): number | null {
  if (item.status !== "ok") return null;
  const fromTelemetry = metric(item.telemetry, "file_count");
  if (fromTelemetry !== null) return fromTelemetry;
  const text = item.resultText ?? "";
  if (text.trim() === "No files matched the pattern.") return 0;
  const header = /^\[glob:\s*(\d+) path/.exec(text);
  return header ? Number(header[1]) : null;
}

function editCounts(item: ToolItem): { added: number; removed: number } | null {
  if (item.status !== "ok") return null;
  const added = metric(item.telemetry, "linesAdded");
  const removed = metric(item.telemetry, "linesRemoved");
  if (added !== null && removed !== null) return { added, removed };
  return editLinesOf(item); // 存入状态库时从完整的 diff 里数好的
}

function taskName(item: ToolItem, store: StoreView): string {
  const given = oneLine(typeof argsOf(item).name === "string" ? (argsOf(item).name as string) : "");
  if (given) return given;
  const child = item.childAgentId === null ? undefined : store.agent(item.childAgentId);
  if (child?.name) return child.name;
  const description = argsOf(item).description;
  return typeof description === "string" ? oneLine(description) : "";
}

function shellCommandDetail(item: ToolItem, store: StoreView): string {
  const command = store.command(item.toolCallId);
  if (!command) return "";
  if (command.exitCode !== null) return `退出码 ${command.exitCode}`;
  return command.promoted ? "转后台" : "";
}

/** short 为真时给“最近一步”用：路径只留最后一段，不带行号范围。 */
function lineParts(item: ToolItem, store: StoreView, home: string, short: boolean): ToolLine {
  const name = item.toolName;
  const args = argsOf(item);
  const verb = verbOf(name);
  const shown = (path: string) => (short ? baseName(path) : displayPath(path, store.cwd, home));
  const pathArg = firstString(args, PATH_KEYS)?.value ?? "";
  switch (name) {
    case "view": {
      let target = pathArg ? shown(pathArg) : "";
      const range = args.view_range;
      if (!short && target && Array.isArray(range) && Number.isInteger(range[0]) && Number.isInteger(range[1])) {
        target += range[1] === -1 ? ` 第 ${range[0]} 行起` : ` 第 ${range[0]} 到 ${range[1]} 行`;
      }
      return { verb, target, detail: "" };
    }
    case "grep": {
      const count = matchCount(item);
      return { verb, target: oneLine(typeof args.pattern === "string" ? args.pattern : ""), detail: count === null ? "" : `共 ${count} 处` };
    }
    case "glob": {
      const count = fileCount(item);
      return { verb, target: oneLine(typeof args.pattern === "string" ? args.pattern : ""), detail: count === null ? "" : `共 ${count} 个` };
    }
    case "edit": {
      const counts = editCounts(item);
      return { verb, target: pathArg ? shown(pathArg) : "", detail: counts ? `+${counts.added} \u2212${counts.removed}` : "" };
    }
    case "create":
      return { verb, target: pathArg ? shown(pathArg) : "", detail: "" };
    case "bash":
    case "powershell":
      return { verb, target: typeof args.command === "string" ? commandFirstLine(args.command) : "", detail: shellCommandDetail(item, store) };
    case "task": {
      const child = item.childAgentId === null ? undefined : store.agent(item.childAgentId);
      const model = typeof args.model === "string" ? args.model : null;
      return { verb, target: taskName(item, store), detail: shortModel(child?.model ?? model) ?? "" };
    }
    case "read_bash":
    case "stop_bash": {
      const id = args.shellId;
      if (typeof id !== "string" && typeof id !== "number") return { verb, target: "", detail: "" };
      const command = store.commandByShellId(String(id));
      return { verb, target: command ? commandFirstLine(command.command) : String(id), detail: "" };
    }
    case "web_fetch":
      return { verb, target: oneLine(typeof args.url === "string" ? args.url : ""), detail: "" };
    case "web_search":
      return { verb, target: oneLine(typeof args.query === "string" ? args.query : ""), detail: "" };
    default: {
      if (pathArg) return { verb, target: shown(pathArg), detail: "" };
      const found = firstString(args, GENERIC_KEYS);
      return { verb, target: found ? oneLine(found.value) : "", detail: "" };
    }
  }
}

/**
 * 工具调用一行的三段（例：`▸ 看  src/auth.ts 第 40 到 96 行`、`▸ 搜  clearSession(  共 3 处`、`▸ 改  src/auth.ts  +4 −3`、
 * `▸ 起子 agent  run-tests  small-1.0`）。target 和 detail 按工具取：
 * - view：路径（displayPath）；有 view_range [a, b] 时 target 后接“ 第 a 到 b 行”（b 为 -1 写“ 第 a 行起”）。
 * - grep：pattern；完成后能从结果（toolTelemetry 或结果文字）得出匹配数时 detail 写“共 N 处”。
 * - glob：pattern；能得出个数时 detail 写“共 N 个”。
 * - edit：路径；能从结果得出增删行数时 detail 写“+a −b”（减号是 U+2212）。create：路径。
 * - bash、powershell：命令第一行，空白折成一个空格；结束后 detail 写“退出码 N”，转后台写“转后台”。
 * - task：子 agent 的名字（arguments.name，没有用子 agent 记录的 name，再没有用 description），detail 是子 agent 的模型短名。
 * - read_bash、stop_bash：它读或停的那条命令的第一行（store.commandByShellId），找不到写 shellId。
 * - web_fetch：url；web_search：query。
 * - 其他：按 path、pattern、query、url、description、name、prompt 的顺序取第一个非空参数，空白折成一个空格。
 * 参数类型不对时 target 为空串，不抛异常。detail 拿不准时写空串，不猜。
 * 实现上的补充：grep、glob 的个数取 toolTelemetry.metrics.file_count、结果开头的 "[grep content: N matches"、"[glob: N path(s)"
 * 和 "No matches found."；edit 的行数取 toolTelemetry.metrics.linesAdded、linesRemoved，没有时取入库时从完整 diff 里数好的（结果文字有长度上限，入库后再数不准）。
 * 其他工具的参数顺序里还有 filePath、file_path（排在 path 后）和 agent_id（排在 name 后）。
 * options.home 只给测试用，默认是当前用户的主目录。
 */
export function toolLine(item: ToolItem, store: StoreView, options?: LineOptions): ToolLine {
  return lineParts(item, store, options?.home ?? homedir(), false);
}

/** 把三段拼成一行：“▸ ” + verb + 两个空格 + target，detail 非空时再加两个空格 + detail。 */
export function toolLineText(line: ToolLine): string {
  return `\u25b8 ${line.verb}  ${line.target}${line.detail ? `  ${line.detail}` : ""}`;
}

/**
 * 工具调用还在进行、子 agent 在等它时，过程记录最后那一行“⠹ <这段文字>  48s”的文字：
 * task（同步，arguments.mode 不是 background）写“等 <子 agent 名字> 交回结果”；bash、powershell（同步）写“等 <程序名> 跑完”；
 * 其他工具或已经结束的调用返回 null。程序名的取法见 agentStep。
 */
export function waitingText(item: ToolItem, store: StoreView): string | null {
  if (item.status !== "running") return null;
  const args = argsOf(item);
  if (item.toolName === "task" && args.mode !== "background") return `等 ${taskName(item, store) || "子 agent"} 交回结果`;
  if (SHELL_TOOLS.has(item.toolName) && args.mode !== "async") {
    return `等 ${programName(typeof args.command === "string" ? args.command : "") || "命令"} 跑完`;
  }
  return null;
}

/** agent 最近一次工具调用的 ToolItem；从过程记录的末尾往前找，通常第一个就是。 */
function lastToolItem(agent: AgentRecord, store: StoreView): ToolItem | undefined {
  if (agent.lastToolCallId === null) return undefined;
  const items = store.transcript(agent.id);
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item?.kind === "tool" && item.toolCallId === agent.lastToolCallId) return item;
  }
  return undefined;
}

/**
 * 子 agent 一行的“最近一步”。status 是合并任务列表之后的状态。
 * - running：看最近一次工具调用（agent.lastToolCallId 在过程记录里的那条 ToolItem）：同步 task 还在等就写 waitingText 的结果
 *   （“等 run-tests 交回结果”）；bash、powershell 写“跑 <程序名>”（程序名：命令的第一个词，跳过 VAR=值 形式的赋值，
 *   取最后一个 "/" 之后的部分；是 python、python3、node、bash、sh、npx 这类解释器时改取后面第一个不以 "-" 开头的词）；
 *   其他工具写“<动词> <target>”，target 里的路径只留最后一段。还没有工具调用写空串。
 * - idle：“做完一轮，等你发话”。
 * - done：最后一条回复的第一句正文（firstBodyLine）；没有回复写“做完了”。
 * - failed：error 折成一行；没有写“失败了”。
 * - stopped：“停了”。
 * - cancelled：“已取消”。
 * 实现上的补充：解释器的后一个词也只留最后一段（`python3 tests/run.py` 写“跑 run.py”）；`bash -c "…"` 取引号里命令的程序名；
 * 命令以 `cd 目录 &&` 开头时跳过这一段，不然所有命令都成了“跑 cd”；`timeout 170 node …`、`stdbuf -oL make` 这类只是包一层的
 * （time、nohup、sudo、env、stdbuf、timeout）也跳过，取被它包着的那条。
 */
export function agentStep(agent: AgentRecord, status: EntryStatus, store: StoreView): string {
  switch (status) {
    case "idle":
      return "做完一轮，等你发话";
    case "done":
      return firstBodyLine(agent.lastReply) || "做完了";
    case "failed":
      return agent.error ? oneLine(agent.error) : "失败了";
    case "stopped":
      return "停了";
    case "cancelled":
      return "已取消";
    case "running":
      break;
  }
  const item = lastToolItem(agent, store);
  if (!item) return "";
  if (item.toolName === "task") {
    const waiting = waitingText(item, store);
    if (waiting) return waiting;
  }
  if (SHELL_TOOLS.has(item.toolName)) {
    const command = argsOf(item).command;
    return `跑 ${programName(typeof command === "string" ? command : "") || "命令"}`;
  }
  const { verb, target } = lineParts(item, store, homedir(), true);
  return target ? `${verb} ${target}` : verb;
}

/**
 * 命令一行的“最近一步”。lastLine 是输出的最后一行非空文字（已清理）。
 * - running：lastLine 里有进度（progress.ts 的 extractProgress）就写进度，如“12/40 30%”；否则写 lastLine。
 * - failed：“退出码 N”；没有退出码写“失败了”。
 * - done：“退出码 0”；没有退出码写“做完了”（只有被 keep 留下的已结束命令会走到这里）。
 * - stopped：“停了”。
 * - cancelled：“已取消”。
 */
export function commandStep(command: CommandRecord, status: EntryStatus, lastLine: string): string {
  switch (status) {
    case "failed":
      return command.exitCode === null ? "失败了" : `退出码 ${command.exitCode}`;
    case "done":
      return command.exitCode === null ? "做完了" : `退出码 ${command.exitCode}`;
    case "stopped":
      return "停了";
    case "cancelled":
      return "已取消";
    default:
      return extractProgress(lastLine) ?? lastLine;
  }
}

/**
 * 模型短名：取最后一个 "/" 之后的部分（去掉提供方），再去掉开头的 "claude-"。例："provider/small-1.0" → "small-1.0"，
 * "provider/claude-medium-1.0" → "medium-1.0"，"vendor/provider-b/tiny-1.0" → "tiny-1.0"（太长由界面截断）。null 或空串返回 null。
 */
export function shortModel(model: string | null): string | null {
  if (!model) return null;
  const last = model.slice(model.lastIndexOf("/") + 1);
  const short = last.startsWith("claude-") ? last.slice("claude-".length) : last;
  return short || null;
}

const HEADING = /^\s{0,3}#{1,6}(?:\s|$)/;
const FENCE = /^\s*(?:`{3,}|~{3,})/;
const RULE = /^\s*(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,}|={3,})$/;
const LIST_LEAD = /^\s*(?:[-*+]\s+|\d+[.)]\s+|>\s*)+/;
// 换行的写法和 Python 的 str.splitlines 一样宽（含 \v、\f、U+2028 等）；行里剩下的控制字符再换成空格。
const LINE_BREAKS = /\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/;
const CONTROL = /[\x00-\x1f\x7f-\x9f]/g;

/**
 * 回复的第一句正文：跳过空行、1–6 个 # 加空格的标题行、代码围栏行（围栏里的内容照取）、分隔线（---、***、___、- - -）；
 * "=====" 下划线行的上一行当正文；取第一个有字的行，去掉行首的 **、* 、+ 、- 、> （可叠加）、"1. "、"2) "，去掉行中所有 "**"。
 * "-5% 的变化" 原样保留，"#标签" 和七个 # 不是标题。只有标题或空围栏得空串。
 */
export function firstBodyLine(text: string): string {
  for (const raw of (text ?? "").split(LINE_BREAKS)) {
    const line = raw.replace(CONTROL, " ");
    if (line.trim() === "" || HEADING.test(line) || FENCE.test(line) || RULE.test(line)) continue;
    const body = line.replace(LIST_LEAD, "").replaceAll("**", "").split(/\s+/).filter(Boolean).join(" ");
    if (body) return body;
  }
  return "";
}

/** 显示用的路径：在 cwd 之下的写成相对路径；在主目录之下的写成 "~/..."；其余原样。cwd 为 null 时只做主目录替换。 */
export function displayPath(path: string, cwd: string | null, home: string): string {
  const below = (root: string): string | null => {
    const dir = root.replace(/\/+$/, "");
    if (dir === "") return null;
    if (path === dir) return "";
    return path.startsWith(`${dir}/`) ? path.slice(dir.length + 1) : null;
  };
  const relative = cwd === null ? null : below(cwd);
  if (relative !== null) return relative === "" ? "." : relative;
  const inHome = below(home);
  if (inHome !== null) return inHome === "" ? "~" : `~/${inHome}`;
  return path;
}

const OPERATORS = new Set(["&&", "||", ";", "|", "&"]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
// 只是包一层的命令：看被它包着的那条。
const WRAPPERS = new Set(["time", "nohup", "sudo", "env", "stdbuf", "timeout"]);
// 重定向（> out.txt、2>&1、<<EOF）不是解释器要跑的脚本。
const REDIRECT = /^\d*[<>]/;
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "fish"]);
const INTERPRETERS = new Set(["python", "python2", "python3", "node", "nodejs", "deno", "bun", "ruby", "perl", "php", "npx", "bunx", "pnpx", "tsx", ...SHELLS]);

/** ;、&、| 是 shell 的连接符；2>&1 和 &> 里的 & 属于重定向。 */
function isOperatorChar(ch: string, current: string, next: string | undefined): boolean {
  if (ch === ";" || ch === "|") return true;
  return ch === "&" && !/[<>]$/.test(current) && next !== ">";
}

/** 按 shell 的习惯切词：引号里的空白不切，&&、||、;、| 单独成词。只给取程序名用，不求完整。 */
function shellWords(command: string): string[] {
  const words: string[] = [];
  let current = "";
  let started = false;
  let quote = "";
  const flush = () => {
    if (started) words.push(current);
    current = "";
    started = false;
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i] as string;
    if (quote) {
      if (ch === quote) quote = "";
      else if (ch === "\\" && quote === '"' && i + 1 < command.length) current += command[++i];
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
    } else if (ch === "\\" && command[i + 1] === "\n") {
      flush(); // 行尾的反斜杠是续行
      i++;
    } else if (ch === "\\" && i + 1 < command.length) {
      current += command[++i];
      started = true;
    } else if (ch === "\n") {
      flush();
      words.push(";"); // 换行和 ; 一样，结束一条命令
    } else if (/\s/.test(ch)) {
      flush();
    } else if (isOperatorChar(ch, current, command[i + 1])) {
      flush();
      let op = ch;
      while (command[i + 1] === ch && ch !== ";") op += command[++i];
      words.push(op);
    } else {
      current += ch;
      started = true;
    }
  }
  flush();
  return words;
}

function isInterpreter(name: string): boolean {
  return INTERPRETERS.has(name) || /^python\d+(\.\d+)*$/.test(name);
}

/**
 * 命令的程序名：跳过开头的 `cd 目录 &&`、VAR=值 赋值和 timeout、stdbuf 这类只是包一层的命令，
 * 取第一个词最后一个 "/" 之后的部分；是解释器时改取后面第一个不以 "-" 开头的词。取不到返回 ""。
 */
export function programName(command: string): string {
  let words = shellWords(command);
  while (words[0] === "cd") {
    const next = words.findIndex((word) => word === "&&" || word === ";");
    if (next < 0) break;
    words = words.slice(next + 1);
  }
  let i = 0;
  let wrapper = "";
  for (;;) {
    while (i < words.length && ASSIGNMENT.test(words[i] as string)) i++;
    const word = words[i];
    if (word === undefined || OPERATORS.has(word)) return wrapper;
    const name = baseName(word);
    if (!WRAPPERS.has(name)) break;
    wrapper = name;
    i++;
    while (i < words.length && (words[i] as string).startsWith("-")) i++;
    if (name === "timeout" && i < words.length) i++; // 时限
  }
  const name = baseName(words[i] as string);
  if (!isInterpreter(name)) return name;
  const args = words.slice(i + 1);
  for (let j = 0; j < args.length; j++) {
    const word = args[j] as string;
    if (OPERATORS.has(word)) break;
    if (REDIRECT.test(word)) {
      if (/^\d*[<>]+&?$/.test(word)) j++;
      continue;
    }
    if (SHELLS.has(name) && /^-[a-z]*c$/.test(word) && args[j + 1] !== undefined) return programName(args[j + 1] as string) || name;
    if (!word.startsWith("-")) return baseName(word);
  }
  return name;
}
