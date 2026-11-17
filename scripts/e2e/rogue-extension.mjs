#!/usr/bin/env node
// 冒充扩展的假服务：验证界面不会被“对端报来的进程号”骗去给不相干的进程发信号。只在自己的数据目录里写登记记录，不碰真的数据目录。
// 用法：rogue-extension.mjs --data-dir D --session ID --copilot-pid N --shell-pid P --tool-call-id T [--claim-pid M]
//   登记记录写 copilotPid=N（真的 Copilot CLI 进程）；hello 里报 M（默认 N，写 1 就是“祖先检查永远通过”的那种骗法）；
//   任务列表里有一个 shell 任务，pid 是 P（别的进程，比如一个 sleep），shellCalls 把它对到命令 T。收到的请求打印出来并回 ok。
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { LineDecoder, parseUiMessage, PROTOCOL_VERSION, REGISTRATION_VERSION, serializeMessage, serializeRegistration } from "../../src/protocol.ts";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1]);
const need = (name) => args.get(name) ?? (console.error(`缺 ${name}`), process.exit(2));
const dataDir = need("--data-dir");
const sessionId = need("--session");
const copilotPid = Number(need("--copilot-pid"));
const shellPid = Number(need("--shell-pid"));
const toolCallId = need("--tool-call-id");
const claimPid = Number(args.get("--claim-pid") ?? copilotPid);

const sessions = join(dataDir, "sessions");
mkdirSync(sessions, { recursive: true, mode: 0o700 });
chmodSync(sessions, 0o700);
chmodSync(dataDir, 0o700);
const socketPath = join(dataDir, "s.sock"); // 登记记录里的路径可以放在别处；放在数据目录下面，路径才不会超过 socket 路径的长度上限
rmSync(socketPath, { force: true });
const startedAt = Date.now();
const writeRegistration = () =>
  writeFileSync(join(sessions, `${sessionId}.json`), serializeRegistration({ v: REGISTRATION_VERSION, protocol: PROTOCOL_VERSION, sessionId, copilotPid, extensionPid: process.pid, tmuxPane: null, cwd: process.cwd(), socketPath, extensionVersion: "rogue", startedAt, updatedAt: Date.now() }), { mode: 0o600 });

const tasks = () => ({
  type: "tasks",
  v: PROTOCOL_VERSION,
  at: Date.now(),
  tasks: [{ type: "shell", id: "9", description: "rogue", status: "running", startedAt: new Date(startedAt).toISOString(), command: "x", attachmentMode: "attached", executionMode: "background", pid: shellPid }],
  shellCalls: { 9: toolCallId },
  error: null,
});

const server = createServer((socket) => {
  console.log(`[rogue] 界面连上了，发 hello（copilotPid ${claimPid}）和 shell 任务 pid ${shellPid}`);
  socket.write(serializeMessage({ type: "hello", v: PROTOCOL_VERSION, sessionId, copilotPid: claimPid, extensionPid: process.pid, extensionVersion: "rogue" }));
  socket.write(serializeMessage(tasks()));
  const timer = setInterval(() => socket.write(serializeMessage(tasks())), 2000);
  const decoder = new LineDecoder();
  socket.on("data", (chunk) => {
    for (const line of decoder.push(chunk)) {
      const parsed = parseUiMessage(line);
      console.log(`[rogue] 收到请求 ${parsed.ok ? JSON.stringify(parsed.value) : `坏请求 ${line}`}`);
      if (parsed.ok) socket.write(serializeMessage({ type: "result", v: PROTOCOL_VERSION, requestId: parsed.value.requestId, ok: true }));
    }
  });
  socket.on("close", () => clearInterval(timer));
  socket.on("error", () => {});
});
server.listen(socketPath, () => {
  chmodSync(socketPath, 0o600);
  writeRegistration();
  setInterval(writeRegistration, 5000);
  console.log(`[rogue] 在听 ${socketPath}，登记记录 copilotPid=${copilotPid}`);
});
process.on("SIGTERM", () => {
  rmSync(socketPath, { force: true });
  rmSync(join(sessions, `${sessionId}.json`), { force: true });
  process.exit(0);
});
