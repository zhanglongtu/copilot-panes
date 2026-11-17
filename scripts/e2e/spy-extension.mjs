// 联调用的“旁观者”扩展：不依赖被测扩展，原样记下 Copilot CLI 给扩展的所有事件和每次 tasks.list() 的变化，当作对照的真相。
// start.sh 把它复制成项目级扩展 .github/extensions/e2e-spy/extension.mjs。输出目录由环境变量 E2E_SPY_DIR 指定，没设就什么都不做。
//   <E2E_SPY_DIR>/<session ID>.events.jsonl   每行 { t: 收到时刻(毫秒), pid, event: 事件原样 }；第一行是 kind=start 的进程信息
//   <E2E_SPY_DIR>/<session ID>.tasks.jsonl    每行 { t, tasks: tasks.list() 的原样结果 }，只在内容变了时记
//   <E2E_SPY_DIR>/<session ID>.rpc-in.jsonl   probe.mjs raw 往这里追加 { id, method: "tasks.cancel", params }，旁观者调用 session.rpc 并把原样结果写进 .rpc-out.jsonl
// @github/copilot-sdk 由 Copilot CLI 在加载扩展时提供，不在本项目的依赖里，所以这个文件只能作为扩展运行，不能直接用 node 运行。
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { joinSession } from "@github/copilot-sdk/extension";

const dir = process.env.E2E_SPY_DIR;
if (dir) {
  mkdirSync(dir, { recursive: true });
  const session = await joinSession({});
  const eventsFile = join(dir, `${session.sessionId}.events.jsonl`);
  process.stderr.write(`e2e-spy: started pid=${process.pid} session=${session.sessionId}\n`); // 用来确认扩展的 stderr 会进 ~/.copilot/logs/process-*-<进程号>.log
  const tasksFile = join(dir, `${session.sessionId}.tasks.jsonl`);
  const add = (file, value) => {
    try {
      appendFileSync(file, JSON.stringify({ t: Date.now(), ...value }) + "\n");
    } catch {
      // 旁观者出错不能影响 session
    }
  };
  const env = process.env;
  add(eventsFile, {
    kind: "start",
    pid: process.pid,
    ppid: process.ppid,
    cwd: process.cwd(),
    env: Object.fromEntries(
      ["COPILOT_EXTENSION_PARENT_PID", "COPILOT_EXTENSION_SANDBOXED", "COPILOT_EXTENSION_INITIALIZATION", "SESSION_ID", "TMUX_PANE", "COPILOT_PANES_HOME", "EXTENSION_PATH"].map((k) => [k, env[k] ?? null]),
    ),
  });
  session.on((event) => add(eventsFile, { pid: process.pid, event }));
  let last = "";
  setInterval(async () => {
    try {
      const result = await session.rpc.tasks.list();
      const body = JSON.stringify(result);
      if (body !== last) {
        last = body;
        add(tasksFile, { tasks: result });
      }
    } catch (e) {
      add(tasksFile, { error: String(e?.message ?? e) });
    }
  }, 1000).unref();
  const rpcIn = join(dir, `${session.sessionId}.rpc-in.jsonl`);
  const rpcOut = join(dir, `${session.sessionId}.rpc-out.jsonl`);
  const readLines = () => {
    try {
      return readFileSync(rpcIn, "utf8").split("\n").filter(Boolean);
    } catch {
      return [];
    }
  };
  let handled = readLines().length; // 重载后只处理新追加的命令
  setInterval(async () => {
    const lines = readLines();
    while (handled < lines.length) {
      const line = lines[handled++];
      let cmd;
      try {
        cmd = JSON.parse(line);
        if (cmd.method === "getEvents") {
          // session.getEvents() 的历史很大，只回事件数、各类型的个数和第一条 bash 开始事件
          const history = await session.getEvents();
          const types = {};
          for (const e of history) types[e.type] = (types[e.type] ?? 0) + 1;
          add(rpcOut, { id: cmd.id, method: cmd.method, result: { count: history.length, types, firstBashStart: history.find((e) => e.type === "tool.execution_start" && e.data?.toolName === "bash") ?? null } });
          continue;
        }
        const owner = cmd.method.split(".").slice(0, -1).reduce((o, k) => o[k], session.rpc);
        const result = await owner[cmd.method.split(".").pop()](cmd.params ?? {});
        add(rpcOut, { id: cmd.id, method: cmd.method, result });
      } catch (e) {
        add(rpcOut, { id: cmd?.id ?? null, method: cmd?.method ?? null, error: String(e?.message ?? e) });
      }
    }
  }, 300).unref();
  process.on("SIGTERM", () => process.exit(0));
}
