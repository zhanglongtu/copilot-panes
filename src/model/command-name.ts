// 名单上命令的名字：去掉包在外面的东西，让窄窄的名字列里留下的是“这是什么命令”。纯函数。
// 去掉：开头的 `cd 目录 &&`、`VAR=值`、`env`、`timeout 300`、`stdbuf -oL`、`nohup`、`time`、`nice`；`bash -c '…'` 这类取引号里的脚本再处理一遍；
// 末尾 `| tee log`、`| head` 这类只是处理输出的管道和 `2>&1`、`> log`、`&`。
// 多行的命令取第一行有意义的命令（跳过空行、注释、`set -e`、`export`、单独一行的 `cd`）；`set -e; pytest` 这样一行里的开头几句也跳过。
// 不去：`python3 -u script.py …` 的参数，`a && b` 这样的连接。原文在内容区按 e 展开能看到。

import { oneLine } from "./output.ts";

interface Token {
  /** 源文里的原样。 */
  raw: string;
  /** 去掉引号和转义之后的文字。 */
  value: string;
  start: number;
  end: number;
  kind: "word" | "op" | "newline";
}

const WRAPPERS = new Set(["env", "timeout", "stdbuf", "nohup", "time", "nice", "setsid"]);
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh"]);
/** 单独成一行时不算“有意义”的命令。 */
const PREAMBLE = new Set(["set", "export", "cd", "source", ".", "unset", "shopt", "umask", "ulimit", "trap"]);
/** 管道末端只是处理输出的命令：去掉它们，主命令是前面的。 */
const OUTPUT_FILTERS = new Set(["tee", "head", "tail", "cat", "less", "more", "grep", "egrep", "fgrep", "sed", "awk", "wc", "sort", "uniq", "cut", "tr", "ts", "column", "nl", "pv", "jq"]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** 写到别处的输出：`2>&1`、`> log`、`>> log`、`&> log`，加上单独成词的 `>` 之类（目标在下一个词）。 */
const OUTPUT_REDIRECT = /^(?:\d*>>?&\d+|&>>?\S+|\d*>>?\S+)$/;
const REDIRECT_OPERATOR = /^(?:\d*>>?|&>>?)$/;

const baseName = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

/** 按 shell 的习惯切词：引号和 $( ) 里的空白、符号不切；&&、||、;、|、& 和换行单独成词。续行的反斜杠当作空白。 */
function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = source.length;
  while (i < n) {
    const ch = source[i]!;
    if (ch === "\\" && source[i + 1] === "\n") {
      i += 2;
      continue;
    }
    if (ch === "\n") {
      tokens.push({ raw: "\n", value: "\n", start: i, end: i + 1, kind: "newline" });
      i++;
      continue;
    }
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === ";" || ch === "|" || (ch === "&" && source[i + 1] !== ">")) {
      let end = i + 1;
      if (ch !== ";" && source[end] === ch) end++;
      tokens.push({ raw: source.slice(i, end), value: source.slice(i, end), start: i, end, kind: "op" });
      i = end;
      continue;
    }
    const start = i;
    let value = "";
    let depth = 0;
    while (i < n) {
      const c = source[i]!;
      if (depth === 0 && (/\s/.test(c) || c === ";" || c === "|" || (c === "&" && !/[<>]$/.test(source.slice(start, i)) && source[i + 1] !== ">"))) break;
      if (c === "\\" && i + 1 < n) {
        if (source[i + 1] === "\n") {
          i += 2;
          continue;
        }
        value += source[i + 1];
        i += 2;
      } else if (c === "'") {
        const close = source.indexOf("'", i + 1);
        const stop = close < 0 ? n : close;
        value += source.slice(i + 1, stop);
        i = stop + 1;
      } else if (c === '"') {
        i++;
        while (i < n && source[i] !== '"') {
          if (source[i] === "\\" && i + 1 < n) {
            const next = source[i + 1]!;
            value += /["\\$`]/.test(next) ? next : `\\${next}`;
            i += 2;
          } else value += source[i++];
        }
        i++;
      } else if (c === "$" && source[i + 1] === "(") {
        depth++;
        value += "$(";
        i += 2;
      } else if (c === "(" && depth > 0) {
        depth++;
        value += c;
        i++;
      } else if (c === ")" && depth > 0) {
        depth--;
        value += c;
        i++;
      } else {
        value += c;
        i++;
      }
    }
    tokens.push({ raw: source.slice(start, Math.min(i, n)), value, start, end: Math.min(i, n), kind: "word" });
  }
  return tokens;
}

function splitLines(tokens: readonly Token[]): Token[][] {
  const lines: Token[][] = [[]];
  for (const token of tokens) {
    if (token.kind === "newline") lines.push([]);
    else lines[lines.length - 1]!.push(token);
  }
  return lines;
}

const isOp = (token: Token | undefined, ...ops: string[]): boolean => token !== undefined && token.kind === "op" && ops.includes(token.value);
const isFlag = (token: Token | undefined): boolean => token !== undefined && token.kind === "word" && /^-./.test(token.value);

/** 开头的 `cd 目录 &&` 或 `cd 目录 ;`（可以连着几个）：返回它们之后第一个词的下标。 */
function skipCd(words: readonly Token[], from: number): number {
  let i = from;
  for (;;) {
    if (words[i]?.value !== "cd" || words[i]?.kind !== "word") return i;
    let j = i + 1;
    while (j < words.length && words[j]!.kind === "word") j++;
    if (!isOp(words[j], "&&", ";")) return i;
    i = j + 1;
  }
}

/** 一个包装命令（env、timeout、stdbuf …）自己占的词，返回它们之后第一个词的下标。 */
function skipWrapper(words: readonly Token[], at: number, name: string): number {
  let i = at + 1;
  if (name === "env") {
    while (i < words.length && words[i]!.kind === "word") {
      const word = words[i]!.value;
      if (word === "-u" || word === "-C" || word === "-S") i += 2;
      else if (word === "--") {
        i++;
        break;
      } else if (word.startsWith("-") || ASSIGNMENT.test(word)) i++;
      else break;
    }
    return i;
  }
  if (name === "timeout") {
    while (isFlag(words[i])) i += /^-[ks]$/.test(words[i]!.value) ? 2 : 1;
    return words[i]?.kind === "word" ? i + 1 : i;
  }
  if (name === "stdbuf") {
    while (isFlag(words[i])) i += /^-[ioe]$/.test(words[i]!.value) ? 2 : 1;
    return i;
  }
  if (name === "nice") {
    while (isFlag(words[i])) i += words[i]!.value === "-n" ? 2 : 1;
    return i;
  }
  while (isFlag(words[i])) i++;
  return i;
}

/** `bash -c 'script'`、`sh -lc "script"`：返回脚本在 words 里的下标，不是这种写法返回 -1。 */
function shellScriptAt(words: readonly Token[], at: number): number {
  if (!SHELLS.has(baseName(words[at]!.value))) return -1;
  for (let i = at + 1; i < words.length && words[i]!.kind === "word"; i++) {
    const word = words[i]!.value;
    if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(word)) return words[i + 1]?.kind === "word" ? i + 1 : -1;
    if (word === "-o" || word === "+o") i++; // set 选项的名字（-o pipefail）
    else if (!word.startsWith("-") && !word.startsWith("+")) return -1;
  }
  return -1;
}

/** 末尾的 `| tee log`、`2>&1`、`> out`、`&` 之前的位置（源文下标）。 */
function trimTail(words: readonly Token[], from: number): number {
  let end = words.length;
  for (let i = from; i < words.length; i++) {
    if (!isOp(words[i], "|")) continue;
    const next = words[i + 1];
    if (next !== undefined && next.kind === "word" && OUTPUT_FILTERS.has(baseName(next.value))) {
      end = i;
      break;
    }
  }
  while (end > from) {
    const last = words[end - 1]!;
    const before = words[end - 2];
    if (isOp(last, "&", ";")) end--;
    else if (last.kind === "word" && OUTPUT_REDIRECT.test(last.raw)) end--;
    else if (last.kind === "word" && before?.kind === "word" && REDIRECT_OPERATOR.test(before.raw)) end -= 2;
    else break;
  }
  return end > from ? words[end - 1]!.end : words[from]!.start;
}

/** 一行（已经切成词）的名字；这一行不是一条有意义的命令（空、注释、cd、set …）返回 ""。 */
function lineName(source: string, words: readonly Token[], depth: number): string {
  let i = skipCd(words, 0);
  for (let guard = 0; guard < 24; guard++) {
    while (i < words.length && words[i]!.kind === "word" && ASSIGNMENT.test(words[i]!.value)) i++;
    const word = words[i];
    if (word === undefined || word.kind !== "word") return "";
    const name = baseName(word.value);
    if (WRAPPERS.has(name)) {
      i = skipWrapper(words, i, name);
      continue;
    }
    const script = depth < 4 ? shellScriptAt(words, i) : -1;
    if (script >= 0) {
      const inner = displayName(words[script]!.value, depth + 1);
      if (inner !== "") return inner;
    }
    if (word.value.startsWith("#")) return "";
    if (PREAMBLE.has(name)) {
      // `set -e; pytest`、`export A=1 && pytest`：跳过这一句，看后面的；整行都是这类句子就不是一条有意义的命令
      const next = words.findIndex((token, at) => at > i && isOp(token, "&&", ";"));
      if (next < 0) return "";
      i = skipCd(words, next + 1);
      continue;
    }
    const end = trimTail(words, i);
    return source.slice(word.start, end).replace(/\\\r?\n/g, " ").replace(/\s+/g, " ").trim();
  }
  return "";
}

function displayName(source: string, depth: number): string {
  const lines = splitLines(tokenize(source));
  for (const words of lines) {
    const name = lineName(source, words, depth);
    if (name !== "") return name;
  }
  return "";
}

/** 名单上命令的名字：见文件开头。去完什么都不剩时用原文折成一行。 */
export function commandDisplayName(command: string): string {
  try {
    return displayName(command, 0) || oneLine(command);
  } catch {
    return oneLine(command);
  }
}
