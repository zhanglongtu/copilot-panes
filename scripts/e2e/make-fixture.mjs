#!/usr/bin/env node
// 把一次真实联调留下的东西整理成一组记录，方便离线对照。用法：make-fixture.mjs <session ID> [输出目录，默认 .scratch/e2e/fixture]
// 输入：<COPILOT_HOME 或 ~/.copilot>/session-state/<ID>/events.jsonl、.scratch/e2e/data/out/<ID>/、.scratch/e2e/spy/<ID>.*、.scratch/e2e/logs/probe.jsonl、
// .scratch/e2e/registration-info.json（运行中 `probe.mjs info > .scratch/e2e/registration-info.json` 存的）。
// 输出：events.jsonl、extension-events.jsonl、out/、tasks-pushes.jsonl、sdk-tasks.jsonl、raw-rpc.jsonl、registration.json。
// 默认输出在 .scratch/ 下，不进 git：真实记录含本机路径、session ID 和模型信息，要放进仓库先自己改成虚构的内容。
// 最后扫一遍密钥、令牌和主目录路径，发现可疑内容就以退出码 1 结束。
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const E2E_DIR = process.env.E2E_DIR || join(ROOT, ".scratch/e2e");
const [sessionId, outArg] = process.argv.slice(2);
if (!sessionId) {
  console.error("用法：make-fixture.mjs <session ID> [输出目录]");
  process.exit(2);
}
const OUT = resolve(outArg || join(E2E_DIR, "fixture"));
const lines = (file) => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const write = (name, rows) => writeFileSync(join(OUT, name), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
mkdirSync(join(OUT, "out"), { recursive: true });

// events.jsonl：Copilot CLI 自己写的。system.message 是 Copilot 的系统提示，体积大又和界面无关，换成一行说明。
const events = lines(join(process.env.COPILOT_HOME || join(homedir(), ".copilot"), "session-state", sessionId, "events.jsonl")).map((e) => {
  if (e.type === "system.message" && e.data) e.data.content = "[removed: Copilot CLI system prompt]";
  return e;
});
write("events.jsonl", events);

// extension-events.jsonl：扩展进程实际收到的事件（旁观者原样记下），只留和界面有关的类型。
const KEEP = new Set([
  "tool.shell_output",
  "tool.execution_start",
  "tool.execution_complete",
  "subagent.started",
  "subagent.configured",
  "subagent.completed",
  "subagent.failed",
  "assistant.usage",
  "system.notification",
  "session.background_tasks_changed",
  "session.extensions_loaded",
]);
write(
  "extension-events.jsonl",
  lines(join(E2E_DIR, "spy", `${sessionId}.events.jsonl`)).filter((r) => r.kind === "start" || KEEP.has(r.event?.type)),
);

for (const name of existsSync(join(E2E_DIR, "data/out", sessionId)) ? readdirSync(join(E2E_DIR, "data/out", sessionId)) : []) {
  copyFileSync(join(E2E_DIR, "data/out", sessionId, name), join(OUT, "out", name));
}

// tasks-pushes.jsonl：探针从 socket 收到的消息。连续内容相同的 tasks 推送只留第一条（保活推送每 5 秒一条，没有信息量）。
let lastBody = "";
write(
  "tasks-pushes.jsonl",
  lines(join(E2E_DIR, "logs", "probe.jsonl")).filter((r) => {
    if (r.sid !== sessionId || r.message?.type !== "tasks") return r.sid === sessionId;
    const body = JSON.stringify({ tasks: r.message.tasks, shellCalls: r.message.shellCalls, error: r.message.error });
    if (body === lastBody) return false;
    lastBody = body;
    return true;
  }),
);

write("sdk-tasks.jsonl", lines(join(E2E_DIR, "spy", `${sessionId}.tasks.jsonl`)));

const rpcOut = new Map(lines(join(E2E_DIR, "spy", `${sessionId}.rpc-out.jsonl`)).map((o) => [o.id, o]));
write(
  "raw-rpc.jsonl",
  lines(join(E2E_DIR, "spy", `${sessionId}.rpc-in.jsonl`)).map((c) => ({ method: c.method, params: c.params, ...(rpcOut.get(c.id) ?? {}), id: undefined })),
);

const info = join(E2E_DIR, "registration-info.json");
if (existsSync(info)) copyFileSync(info, join(OUT, "registration.json"));

// 扫描：密钥、令牌和主目录路径。
const SUSPECT = [
  /ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|ghu_[A-Za-z0-9]{20,}|ghs_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}/,
  /sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY/,
  /Bearer [A-Za-z0-9._-]{20,}/,
  /"(api[_-]?key|apiKey|token|password|secret)"\s*:\s*"[^"]{8,}"/i,
  /\/(home|Users)\/[A-Za-z0-9_.-]+/,
  /\/root\//,
];
let bad = 0;
const scan = (file) => {
  const text = readFileSync(file, "utf8");
  for (const re of SUSPECT) {
    const hit = re.exec(text);
    if (hit) {
      bad += 1;
      console.error(`可疑内容 ${file}：${hit[0].slice(0, 80)}`);
    }
  }
};
for (const name of readdirSync(OUT)) if (name.endsWith(".jsonl") || name.endsWith(".json")) scan(join(OUT, name));
for (const name of readdirSync(join(OUT, "out"))) scan(join(OUT, "out", name));
console.log(`样本写到 ${OUT}：events ${events.length} 条，扫描发现 ${bad} 处可疑内容`);
process.exit(bad === 0 ? 0 : 1);
