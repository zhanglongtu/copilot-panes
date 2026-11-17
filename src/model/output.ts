// 命令输出的文字处理：清理控制字符、取最后一行、去掉 Copilot CLI 加的结束标记。纯函数，readLastLine 除外（读文件末尾）。

import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { LAST_LINE_TAIL_BYTES } from "../constants.ts";

// 三种转义序列：CSI；以 BEL 或 ESC \ 结尾的 OSC；两字符的 ESC 序列。
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
// 除换行以外的控制字符，含 U+007F 和整个 C1 区（有的终端把 U+009B 当 ESC [ 执行）。制表符要先换成空格。
const MULTILINE_CONTROL = /[\x00-\x09\x0b-\x1f\x7f-\x9f]/g;
const EXIT_MARKER = /\n?<shellId: [^>]*? completed with exit code (-?\d+)>\s*$/;
const TRAILING_NOTICE = /\n?<[^<>]*shellId[^<>]*>\s*$/;
const READ_NOISE = "Read interrupted by user steering; shell continues in background.";

/**
 * 多行清理：删终端转义序列（CSI、以 BEL 或 ESC \ 结尾的 OSC、两字符 ESC 序列）；\r\n 换成 \n；
 * 有 \r 时每行只留最后一个 \r 之后的部分；制表符换成 4 个空格；删 \n 以外的控制字符（含 U+007F 和整个 C1 区 U+0080–U+009F）。
 * 注意：先整段换掉 \r\n 再处理 \r，所以以 \r\n 结尾的行不会变成空行。
 */
export function cleanText(text: string): string {
  let out = text.replace(ANSI, "").replaceAll("\r\n", "\n");
  if (out.includes("\r")) {
    out = out
      .split("\n")
      .map((line) => line.slice(line.lastIndexOf("\r") + 1))
      .join("\n");
  }
  return out.replaceAll("\t", "    ").replace(MULTILINE_CONTROL, "");
}

/** 单行清理：cleanText 之后所有空白折成一个空格，去首尾空白。 */
export function oneLine(text: string): string {
  return cleanText(text).split(/\s+/).filter(Boolean).join(" ");
}

/**
 * 一段文字清理后的最后一个非空行（只含空白的行不算）；没有返回 ""。
 * 以 \r 结尾的进度条（"40%|####  |\r"）取最后一个有字的一段，而不是 \r 之后的空串。
 */
export function lastNonEmptyLine(text: string): string {
  const lines = text.replace(ANSI, "").replaceAll("\r\n", "\n").split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const segments = (lines[i] ?? "").split("\r");
    for (let j = segments.length - 1; j >= 0; j--) {
      const segment = cleanText(segments[j] ?? "").trim();
      if (segment) return segment;
    }
  }
  return "";
}

/**
 * 读文件末尾 tailBytes 字节（默认 LAST_LINE_TAIL_BYTES），返回 lastNonEmptyLine 的结果。文件不存在或读不了返回 ""，不抛异常。
 * 窗口开头被切断的半行不影响结果（除非最后一行本身比窗口长，这时返回它的后半截）。
 */
export function readLastLine(path: string, tailBytes: number = LAST_LINE_TAIL_BYTES): string {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const length = Math.min(size, Math.max(0, tailBytes));
    if (length === 0) return "";
    const buffer = Buffer.alloc(length);
    let got = 0;
    while (got < length) {
      const n = readSync(fd, buffer, got, length - got, size - length + got);
      if (n === 0) break;
      got += n;
    }
    return lastNonEmptyLine(buffer.toString("utf8", 0, got));
  } catch {
    return "";
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // 关不掉也不影响结果
      }
    }
  }
}

/**
 * 去掉完成事件 result.content 末尾的 "<shellId: … completed with exit code N>" 标记（连同它前面的一个换行），并取出 N。
 * 没有标记时 exitCode 为 null、text 原样。例："a\nb\n<shellId: 0 completed with exit code 3>" → { text: "a\nb", exitCode: 3 }。
 */
export function stripExitMarker(content: string): { text: string; exitCode: number | null } {
  const match = EXIT_MARKER.exec(content);
  if (!match) return { text: content, exitCode: null };
  return { text: content.slice(0, match.index), exitCode: Number(match[1]) };
}

/**
 * 去掉 read_bash 结果末尾的一条 "<…shellId…>" 说明。整条是
 * "Read interrupted by user steering; shell continues in background." 的返回 ""。
 */
export function stripTrailingNotice(content: string): string {
  if (content === READ_NOISE) return "";
  return content.replace(TRAILING_NOTICE, "");
}
