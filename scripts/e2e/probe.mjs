#!/usr/bin/env node
// 探针：像界面一样连上扩展的 socket，把收到的东西原样打印出来，并能发请求。只用 src/protocol.ts、src/paths.ts 和 src/bridge/signals.ts。
//
//   probe.mjs info                          登记记录、进程号对不对、socket 在不在
//   probe.mjs watch [--session ID] [--log F]  长期运行：打印 hello、每次 tasks 推送、usage 推送、.out 文件大小变化、登记记录和连接的变化
//   probe.mjs tasks [--json]                连上取一次任务列表
//   probe.mjs find <agent|shell> <状态> [模式]  打印符合条件的任务 id（模式可写 detached、attached、sync、background），没有时退出码 1
//   probe.mjs send <taskId> <文字>          请求：给子 agent 发消息
//   probe.mjs cancel|promote|remove <taskId>  请求：取消 / 转后台 / 移除
//   probe.mjs refresh                       请求：立刻刷新任务列表
//   probe.mjs sigint <taskId>               用任务列表里的 pid 给 shell 任务的进程组发 SIGINT（Interrupter，和界面同一套逻辑）
//   probe.mjs raw <方法> [JSON 参数]        经旁观者扩展直接调用 session.rpc 的方法（如 tasks.sendMessage），打印原样结果或错误；方法写 getEvents 时回历史事件的概要
//   probe.mjs wait [秒数]                   等登记记录出现，出现后打印并返回
// 公共参数：--data-dir（默认 $COPILOT_PANES_HOME，再默认 .scratch/e2e/data）、--session ID（默认选最近更新的那条登记记录）。
// 一次性命令的退出码：请求成功 0，失败或超时 1。

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LineDecoder, parseExtensionMessage, parseRegistration, serializeMessage, PROTOCOL_VERSION } from "../../src/protocol.ts";
import { dataDir as resolveDataDir, outDir, sessionStateDir as resolveStateDir, sessionsDir } from "../../src/paths.ts";
import { Interrupter, procAccess } from "../../src/bridge/signals.ts";
import { realClock } from "../../src/types/clock.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const E2E_DIR = process.env.E2E_DIR || join(ROOT, ".scratch/e2e");

// ───── 参数 ─────
const argv = process.argv.slice(2);
function takeOption(name, fallback) {
  const i = argv.indexOf(name);
  if (i === -1) return fallback;
  const value = argv[i + 1];
  argv.splice(i, 2);
  return value ?? fallback;
}
function takeFlag(name) {
  const i = argv.indexOf(name);
  if (i !== -1) argv.splice(i, 1);
  return i !== -1;
}
const wantJson = takeFlag("--json");
const sessionOpt = takeOption("--session", null);
const logFile = takeOption("--log", join(E2E_DIR, "logs", "probe.jsonl"));
const dataDirOpt = takeOption("--data-dir", null);
const DATA = dataDirOpt || process.env.COPILOT_PANES_HOME || join(E2E_DIR, "data");
const DATA_DIR = resolveDataDir({}, homedir(), DATA);
const STATE_DIR = resolveStateDir(process.env, homedir());
const [command = "info", ...rest] = argv;

// ───── 输出 ─────
const stamp = () => new Date().toISOString().slice(11, 23);
const out = (sid, text) => console.log(`${stamp()} ${sid ? `[${sid.slice(0, 8)}] ` : ""}${text}`);
const short = (s, n = 80) => (typeof s === "string" && s.length > n ? `${JSON.stringify(s.slice(0, n))}…(${s.length})` : JSON.stringify(s));
mkdirSync(dirname(logFile), { recursive: true });
const record = (sid, dir, message) => appendFileSync(logFile, JSON.stringify({ t: Date.now(), sid, dir, message }) + "\n");

// ───── 登记记录和进程信息 ─────
function readRegistrations() {
  const dir = sessionsDir(DATA_DIR);
  const found = [];
  let names = [];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".json"));
  } catch {
    return found;
  }
  for (const name of names) {
    try {
      const parsed = parseRegistration(readFileSync(join(dir, name), "utf8"));
      if (parsed.ok) found.push(parsed.value);
      else found.push({ invalid: parsed.error, file: name });
    } catch {
      // 读的瞬间文件被换掉或删掉，下一轮再读
    }
  }
  return found.filter((r) => !r.invalid);
}

function pickRegistration() {
  const all = readRegistrations();
  const chosen = sessionOpt ? all.filter((r) => r.sessionId.startsWith(sessionOpt)) : all;
  // 按启动时间取最新的（心跳每 5 秒都在变，不能用 updatedAt 比）。
  return chosen.sort((a, b) => b.startedAt - a.startedAt)[0] ?? null;
}

/** /proc/<pid>/stat 括号后的字段：[1] 父进程号，[2] 进程组号，[3] 会话号。 */
function procInfo(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const f = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const cmd = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" ").trim();
    let cwd = "";
    try {
      cwd = readlinkSync(`/proc/${pid}/cwd`);
    } catch {
      // 读不到就空着
    }
    return { pid, state: f[0], ppid: Number(f[1]), pgid: Number(f[2]), sid: Number(f[3]), leader: Number(f[2]) === pid, cmd: cmd.slice(0, 120), cwd };
  } catch {
    return null;
  }
}

function lockFiles(sessionId) {
  try {
    return readdirSync(join(STATE_DIR, sessionId)).filter((n) => /^inuse\..*\.lock$/.test(n));
  } catch {
    return [];
  }
}

function describeRegistration(reg) {
  const locks = lockFiles(reg.sessionId);
  const lockPids = locks.map((n) => Number(/^inuse\.(\d+)\.lock$/.exec(n)?.[1]));
  const ext = procInfo(reg.extensionPid);
  const cli = procInfo(reg.copilotPid);
  return {
    sessionId: reg.sessionId,
    updatedAgoMs: Date.now() - reg.updatedAt,
    registration: reg,
    lockFiles: locks,
    copilotPidHoldsLock: lockPids.includes(reg.copilotPid),
    extensionParentIsCopilotPid: ext ? ext.ppid === reg.copilotPid : null,
    extensionProc: ext,
    copilotProc: cli,
    socketExists: existsSync(reg.socketPath),
  };
}

// ───── 连接 ─────
function summarizeTask(t) {
  const common = `${t.type} id=${t.id} status=${t.status}`;
  if (t.type === "agent") {
    return `${common} mode=${t.executionMode ?? "-"} agentType=${t.agentType} model=${t.model ?? "-"} toolCallId=${t.toolCallId} canPromote=${t.canPromoteToBackground ?? "-"} name=${short(t.displayName ?? "", 30)} desc=${short(t.description, 40)}`;
  }
  if (t.type === "shell") {
    return `${common} mode=${t.executionMode ?? "-"} attach=${t.attachmentMode} pid=${t.pid ?? "-"} canPromote=${t.canPromoteToBackground ?? "-"} log=${t.logPath ?? "-"} cmd=${short(t.command, 70)}`;
  }
  return `${common} (client task)`;
}

function printMessage(sid, message, state) {
  switch (message.type) {
    case "hello":
      out(sid, `hello ${JSON.stringify(message)}`);
      break;
    case "tasks": {
      const body = JSON.stringify({ tasks: message.tasks, shellCalls: message.shellCalls, error: message.error });
      const changed = body !== state.lastTasksBody;
      state.lastTasksBody = body;
      state.tasksPushes = (state.tasksPushes ?? 0) + 1;
      out(sid, `tasks #${state.tasksPushes} n=${message.tasks.length} changed=${changed ? "yes" : "no"} shellCalls=${JSON.stringify(message.shellCalls)} error=${JSON.stringify(message.error)}`);
      if (changed) for (const t of message.tasks) out(sid, `  ${summarizeTask(t)}`);
      break;
    }
    case "usage":
      out(sid, `usage ${Object.keys(message.agents).length} agent(s)`);
      for (const [id, u] of Object.entries(message.agents)) out(sid, `  ${id} ${JSON.stringify(u)}`);
      break;
    case "result":
      out(sid, `result ${JSON.stringify(message)}`);
      break;
  }
}

/** 连上 socket，把每条解析好的消息交给 onMessage；返回 { socket, send }。 */
function connect(reg, { onMessage, onClose }) {
  const socket = createConnection(reg.socketPath);
  const decoder = new LineDecoder();
  socket.on("data", (chunk) => {
    for (const line of decoder.push(chunk)) {
      const parsed = parseExtensionMessage(line);
      if (parsed.ok) onMessage(parsed.value);
      else out(reg.sessionId, `!! 解析失败 ${parsed.code}: ${parsed.error} 原文=${line.slice(0, 200)}`);
    }
  });
  socket.on("error", (e) => onClose(e));
  socket.on("close", () => onClose(null));
  return { socket, send: (message) => socket.write(serializeMessage(message)) };
}

// ───── watch ─────
function watch() {
  const sessions = new Map(); // sessionId → { reg, conn, state, outSizes, regSig }
  const retryMs = 300;

  const ensure = (reg) => {
    let s = sessions.get(reg.sessionId);
    if (!s) {
      s = { reg, conn: null, state: {}, outSizes: new Map(), regSig: "", connecting: false, lastAttempt: 0, connectedAt: 0 };
      sessions.set(reg.sessionId, s);
      out(reg.sessionId, `登记记录出现 ${JSON.stringify(describeRegistration(reg))}`);
    }
    const sig = JSON.stringify([reg.copilotPid, reg.extensionPid, reg.socketPath, reg.tmuxPane, reg.startedAt]);
    if (s.regSig && s.regSig !== sig) out(reg.sessionId, `登记记录变了 ${sig}（旧 ${s.regSig}）`);
    s.regSig = sig;
    s.reg = reg;
    return s;
  };

  const tryConnect = (s) => {
    if (s.conn || s.connecting || Date.now() - s.lastAttempt < retryMs) return;
    s.connecting = true;
    s.lastAttempt = Date.now();
    const sid = s.reg.sessionId;
    const conn = connect(s.reg, {
      onMessage: (message) => {
        record(sid, "in", message);
        if (message.type === "hello") s.connectedAt = Date.now();
        printMessage(sid, message, s.state);
      },
      onClose: (error) => {
        if (s.conn === conn || s.connecting) {
          if (s.connectedAt) out(sid, `连接断开${error ? `：${error.code ?? error.message}` : ""}（连了 ${Date.now() - s.connectedAt} ms）`);
          s.conn = null;
          s.connecting = false;
          s.connectedAt = 0;
        }
      },
    });
    conn.socket.on("connect", () => {
      s.conn = conn;
      s.connecting = false;
      out(sid, `已连上 ${s.reg.socketPath}`);
    });
  };

  const pollOutputs = (s) => {
    const dir = outDir(DATA_DIR, s.reg.sessionId);
    let names = [];
    try {
      names = readdirSync(dir).filter((n) => n.endsWith(".out"));
    } catch {
      return;
    }
    for (const name of names) {
      let size;
      try {
        size = statSync(join(dir, name)).size;
      } catch {
        continue;
      }
      const before = s.outSizes.get(name);
      if (before === undefined) out(s.reg.sessionId, `out ${name} 新文件 ${size} 字节`);
      else if (before !== size) out(s.reg.sessionId, `out ${name} ${before} → ${size} 字节（+${size - before}）`);
      s.outSizes.set(name, size);
    }
  };

  setInterval(() => {
    const regs = readRegistrations().filter((r) => !sessionOpt || r.sessionId.startsWith(sessionOpt));
    const present = new Set(regs.map((r) => r.sessionId));
    for (const reg of regs) {
      const s = ensure(reg);
      tryConnect(s);
      pollOutputs(s);
    }
    for (const [sid, s] of sessions) {
      if (!present.has(sid)) {
        out(sid, `登记记录消失（socket 文件${existsSync(s.reg.socketPath) ? "还在" : "也没了"}）`);
        s.conn?.socket.destroy();
        sessions.delete(sid);
      }
    }
  }, 250);
  out(null, `watch：数据目录 ${DATA_DIR}，日志 ${logFile}，session-state ${STATE_DIR}`);
}

// ───── 一次性命令 ─────
/** 连上、等 hello 和第一条 tasks，然后交给 action；action 返回的退出码当作进程退出码。 */
async function oneShot(action) {
  const reg = pickRegistration();
  if (!reg) {
    console.error(`没有找到登记记录（数据目录 ${DATA_DIR}）`);
    process.exit(1);
  }
  const sid = reg.sessionId;
  let hello = null;
  let tasks = null;
  const waiters = [];
  const conn = connect(reg, {
    onMessage: (message) => {
      record(sid, "in", message);
      if (message.type === "hello") hello = message;
      if (message.type === "tasks") tasks = message;
      for (const w of waiters.splice(0)) w(message);
    },
    onClose: (error) => {
      if (error) {
        console.error(`连不上 ${reg.socketPath}：${error.code ?? error.message}`);
        process.exit(1);
      }
    },
  });
  const nextMessage = (timeoutMs) =>
    new Promise((res) => {
      const timer = setTimeout(() => res(null), timeoutMs);
      waiters.push((m) => {
        clearTimeout(timer);
        res(m);
      });
    });
  const deadline = Date.now() + 5000;
  while ((!hello || !tasks) && Date.now() < deadline) await nextMessage(500);
  if (!hello || !tasks) {
    console.error("5 秒内没有收到 hello 和 tasks");
    process.exit(1);
  }
  const request = async (op) => {
    const requestId = `probe-${Date.now()}`;
    const started = Date.now();
    conn.send({ type: "request", v: PROTOCOL_VERSION, requestId, ...op });
    for (;;) {
      const left = 12000 - (Date.now() - started);
      if (left <= 0) return { timedOut: true, ms: Date.now() - started };
      const m = await nextMessage(left);
      if (m === null) return { timedOut: true, ms: Date.now() - started };
      if (m.type === "result" && m.requestId === requestId) return { result: m, ms: Date.now() - started };
    }
  };
  const code = await action({ reg, hello, tasks: () => tasks, request, nextMessage });
  conn.socket.destroy();
  process.exit(code);
}

function printResult(label, r) {
  if (r.timedOut) {
    out(null, `${label}：${r.ms} ms 内没有收到 result`);
    return 1;
  }
  out(null, `${label}：${JSON.stringify(r.result)}（${r.ms} ms）`);
  return r.result.ok ? 0 : 1;
}

async function main() {
  switch (command) {
    case "info": {
      const regs = readRegistrations();
      if (regs.length === 0) console.log(`没有登记记录（数据目录 ${DATA_DIR}，session-state ${STATE_DIR}）`);
      for (const reg of regs) console.log(JSON.stringify(describeRegistration(reg), null, 2));
      return;
    }
    case "wait": {
      const limit = Number(rest[0] ?? 60);
      for (let i = 0; i < limit * 4; i++) {
        const reg = pickRegistration();
        if (reg) {
          console.log(JSON.stringify(describeRegistration(reg), null, 2));
          return;
        }
        await new Promise((r) => setTimeout(r, 250));
      }
      console.error(`${limit} 秒内没有登记记录出现`);
      process.exit(1);
    }
    case "watch":
      watch();
      return;
    case "tasks":
      return oneShot(async ({ hello, tasks }) => {
        const t = tasks();
        if (wantJson) console.log(JSON.stringify({ hello, tasks: t }, null, 2));
        else {
          out(null, `hello ${JSON.stringify(hello)}`);
          out(null, `shellCalls ${JSON.stringify(t.shellCalls)} error ${JSON.stringify(t.error)}`);
          for (const task of t.tasks) {
            out(null, summarizeTask(task));
            if (task.type === "shell" && task.pid) out(null, `    pid ${task.pid}: ${JSON.stringify(procInfo(task.pid))}`);
          }
        }
        return 0;
      });
    case "find": {
      // find <agent|shell> <状态> [detached|attached|sync|background]：打印符合条件的任务 id，每行一个（脚本里取 id 用）
      const [kind, status, extra] = rest;
      return oneShot(async ({ tasks }) => {
        const hits = tasks().tasks.filter(
          (t) => t.type === kind && t.status === status && (!extra || t.attachmentMode === extra || t.executionMode === extra),
        );
        for (const t of hits) console.log(t.id);
        return hits.length > 0 ? 0 : 1;
      });
    }
    case "send":
      return oneShot(async ({ request }) =>
        printResult("sendMessage", await request({ op: "sendMessage", taskId: rest[0], message: rest.slice(1).join(" ") })),
      );
    case "cancel":
    case "remove":
      return oneShot(async ({ request }) => printResult(command, await request({ op: command, taskId: rest[0] })));
    case "promote":
      return oneShot(async ({ request }) => printResult("promoteToBackground", await request({ op: "promoteToBackground", taskId: rest[0] })));
    case "refresh":
      return oneShot(async ({ request }) => printResult("refreshTasks", await request({ op: "refreshTasks" })));
    case "raw": {
      const reg = pickRegistration();
      if (!reg) {
        console.error("没有找到登记记录");
        process.exit(1);
      }
      const spyDir = join(E2E_DIR, "spy");
      const id = `raw-${Date.now()}`;
      appendFileSync(join(spyDir, `${reg.sessionId}.rpc-in.jsonl`), JSON.stringify({ id, method: rest[0], params: rest[1] ? JSON.parse(rest[1]) : {} }) + "\n");
      const outFile = join(spyDir, `${reg.sessionId}.rpc-out.jsonl`);
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 250));
        let lines = [];
        try {
          lines = readFileSync(outFile, "utf8").split("\n").filter(Boolean);
        } catch {
          // 还没有输出文件
        }
        const hit = lines.map((l) => JSON.parse(l)).find((o) => o.id === id);
        if (hit) {
          out(null, `${rest[0]} ${rest[1] ?? ""} → ${JSON.stringify(hit.error !== undefined ? { error: hit.error } : hit.result).slice(0, 600)}`);
          return;
        }
      }
      console.error("10 秒内旁观者没有回应（没装旁观者扩展，或扩展还没重新加载？）");
      process.exit(1);
    }
    case "sigint":
      return oneShot(async ({ hello, tasks }) => {
        const t = tasks();
        const task = t.tasks.find((x) => x.type === "shell" && (x.id === rest[0] || t.shellCalls[x.id] === rest[0]));
        if (!task) {
          out(null, `任务列表里没有 shell 任务 ${rest[0]}`);
          return 1;
        }
        const toolCallId = t.shellCalls[task.id] ?? task.id;
        out(null, `目标 ${summarizeTask(task)} toolCallId=${toolCallId}`);
        if (task.pid) out(null, `发信号前 ${JSON.stringify(procInfo(task.pid))}`);
        const outcome = new Interrupter(procAccess(), realClock, 3000).press(toolCallId, task.pid ?? null, hello.copilotPid);
        out(null, `Interrupter.press → ${JSON.stringify(outcome)}`);
        for (const wait of [500, 1500]) {
          await new Promise((r) => setTimeout(r, wait));
          out(null, `+${wait} ms 进程 ${task.pid ?? "-"}：${task.pid ? JSON.stringify(procInfo(task.pid)) : "-"}`);
        }
        return outcome.kind === "sent" ? 0 : 1;
      });
    default:
      console.error(`不认识的命令 ${command}。看文件开头的用法说明。`);
      process.exit(2);
  }
}

await main();
