#!/usr/bin/env node
// 对照：把旁观者扩展（spy-extension.mjs）记下的真实事件，和被测扩展写的 .out 文件逐条比对。
// 用法：compare-out.mjs [--session ID] [--verbose]
// 每条 shell 命令一行：toolCallId、哪个 agent 起的、参数、tool.shell_output 的 sequence 情况（起点、是否乱序、重复、空缺）、
// 和 .out 是否一致（MATCH / DIFF）。没有 tool.shell_output 的命令，拿完成事件的 result.content 去掉末尾的 <shellId…> 标记来比。
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { outPath } from "../../src/paths.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const E2E_DIR = process.env.E2E_DIR || join(ROOT, ".scratch/e2e");
const DATA = process.env.COPILOT_PANES_HOME || join(E2E_DIR, "data");
const argv = process.argv.slice(2);
const verbose = argv.includes("--verbose");
const sessionArg = argv.includes("--session") ? argv[argv.indexOf("--session") + 1] : null;

const spyDir = join(E2E_DIR, "spy");
const files = readdirSync(spyDir).filter((n) => n.endsWith(".events.jsonl") && (!sessionArg || n.startsWith(sessionArg)));
if (files.length === 0) {
  console.error(`没有旁观者记录（${spyDir}）`);
  process.exit(1);
}

/** 旁观者记下的任务列表里，这个 shell 任务最后一次出现时的 logPath。 */
function logPathOf(sessionId, shellId) {
  let found;
  try {
    for (const line of readFileSync(join(spyDir, `${sessionId}.tasks.jsonl`), "utf8").trim().split("\n")) {
      const task = JSON.parse(line).tasks?.tasks?.find((t) => t.type === "shell" && t.id === shellId);
      if (task?.logPath) found = task.logPath;
    }
  } catch {
    // 没有任务列表记录
  }
  return found;
}

const visible = (s) => s.replace(/\x1b/g, "^[").replace(/\r/g, "^M");
let bad = 0;
for (const file of files) {
  const sessionId = file.replace(/\.events\.jsonl$/, "");
  const rows = readFileSync(join(spyDir, file), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const calls = new Map();
  const get = (id) => {
    if (!calls.has(id)) calls.set(id, { id, outputs: [], start: null, complete: null });
    return calls.get(id);
  };
  for (const row of rows) {
    const e = row.event;
    if (!e?.data) continue;
    if (e.type === "tool.execution_start" && ["bash", "powershell"].includes(e.data.toolName)) get(e.data.toolCallId).start = { ...e, t: row.t };
    if (e.type === "tool.shell_output") get(e.data.toolCallId).outputs.push({ ...e.data, t: row.t, agentId: e.agentId });
    if (e.type === "tool.execution_complete" && calls.has(e.data.toolCallId)) calls.get(e.data.toolCallId).complete = { ...e, t: row.t };
  }
  console.log(`session ${sessionId}：${calls.size} 条 shell 调用`);
  for (const call of calls.values()) {
    const args = call.start?.data?.arguments ?? {};
    const seqs = call.outputs.map((o) => o.sequence);
    const sorted = [...new Set(seqs)].sort((a, b) => a - b);
    const inOrder = seqs.every((s, i) => i === 0 || s > seqs[i - 1]);
    const dupes = seqs.length - sorted.length;
    const gaps = sorted.length ? sorted[sorted.length - 1] - sorted[0] + 1 - sorted.length : 0;
    const bySeq = new Map();
    for (const o of call.outputs) if (!bySeq.has(o.sequence)) bySeq.set(o.sequence, o.text);
    const expectedFromEvents = [...bySeq.entries()].sort((a, b) => a[0] - b[0]).map(([, t]) => t).join("");
    const content = call.complete?.data?.result?.content ?? "";
    let expected = expectedFromEvents;
    let source = "tool.shell_output";
    if (args.detach === true) {
      // detach 命令没有 tool.shell_output；真相是 Copilot CLI 写的日志文件（任务的 logPath）
      const shellId = call.complete?.data?.result?.structuredContent?.shellId;
      const logPath = shellId === undefined ? undefined : logPathOf(sessionId, String(shellId));
      expected = logPath && existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
      source = `任务的日志文件 ${logPath ?? "（找不到 logPath）"}`;
    } else if (call.outputs.length === 0) {
      expected = content.replace(/\n?<shellId: [^>]*>\s*$/, "");
      source = "完成事件的 result.content";
    }
    const path = outPath(DATA, sessionId, call.id);
    const actual = existsSync(path) ? readFileSync(path, "utf8") : null;
    const verdict = actual === null ? "NO-FILE" : actual === expected ? "MATCH" : "DIFF";
    if (verdict !== "MATCH") bad += 1;
    const who = call.start?.agentId ? `agent ${call.start.agentId.slice(0, 8)}` : "main";
    const streams = [...new Set(call.outputs.map((o) => o.stream))].join(",") || "-";
    console.log(
      `${verdict.padEnd(7)} ${call.id} ${who} mode=${args.mode ?? "-"} detach=${args.detach ?? false} shellId=${call.complete?.data?.result?.structuredContent?.shellId ?? "-"}\n` +
        `        cmd=${JSON.stringify(String(args.command ?? "").slice(-60))} success=${call.complete?.data?.success ?? "-"}\n` +
        `        events=${call.outputs.length} stream=${streams} seq=${sorted.length ? `${sorted[0]}..${sorted[sorted.length - 1]}` : "-"} inOrder=${inOrder} dupes=${dupes} gaps=${gaps} 对照来源=${source}\n` +
        `        .out ${actual === null ? "不存在" : `${Buffer.byteLength(actual)} 字节`}，期望 ${Buffer.byteLength(expected)} 字节`,
    );
    if (verdict === "DIFF" || verbose) {
      console.log(`        期望开头 ${JSON.stringify(visible(expected.slice(0, 120)))}`);
      if (actual !== null) console.log(`        实际开头 ${JSON.stringify(visible(actual.slice(0, 120)))}`);
      if (actual !== null && actual !== expected) {
        let i = 0;
        while (i < actual.length && i < expected.length && actual[i] === expected[i]) i++;
        console.log(`        第一处不同在第 ${i} 个字符：期望 ${JSON.stringify(visible(expected.slice(i, i + 30)))}，实际 ${JSON.stringify(visible(actual.slice(i, i + 30)))}`);
      }
    }
  }
}
process.exit(bad === 0 ? 0 : 1);
