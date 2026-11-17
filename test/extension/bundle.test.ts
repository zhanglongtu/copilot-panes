// 打包后的 extension.mjs：除了 Copilot CLI 提供的 SDK，不能有别的外部导入；node --check 通过；
// 并且真的能在一个子进程里跑起来：开 socket、写登记记录和输出文件，SIGTERM 后清理干净，被 SIGKILL 后下一个进程能接管。
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { build } from "esbuild";
import { versionOnly } from "../../scripts/version-plugin.mjs";
import { parseRegistration } from "../../src/protocol.ts";
import type { Registration, UsageMessage } from "../../src/protocol.ts";
import { REPO_ROOT, tempDir } from "../helpers/tmp.ts";
import { request, TestClient } from "./fake.ts";

/** 和 build.mjs 里扩展那一段相同的选项（包里的 version.ts 换成常量，不然运行时要找旁边的 package.json）。 */
async function bundleExtension(outfile: string) {
  return build({
    absWorkingDir: REPO_ROOT,
    entryPoints: ["extension/src/extension.ts"],
    outfile,
    plugins: [versionOnly("0.0.0-test")],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    external: ["@github/copilot-sdk", "@github/copilot-sdk/*"],
    metafile: true,
    logLevel: "silent",
  });
}

/** 一个文件里所有静态 import 和字面量动态 import 的模块名。 */
function importedModules(source: string): string[] {
  const found: string[] = [];
  for (const m of source.matchAll(/(?:^|[;\s])import\s*(?:[^"'()]*?\sfrom\s*)?["']([^"']+)["']/g)) found.push(m[1]!);
  for (const m of source.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)) found.push(m[1]!);
  for (const m of source.matchAll(/\b(?:__)?require\(\s*["']([^"']+)["']\s*\)/g)) found.push(m[1]!);
  return found;
}

function assertSelfContained(source: string): void {
  const modules = importedModules(source);
  assert.ok(modules.length > 0, "found some imports to check");
  for (const name of modules) {
    assert.ok(name.startsWith("node:") || name.startsWith("@github/copilot-sdk"), `unexpected external import: ${name}`);
  }
  assert.match(source, /["']@github\/copilot-sdk\/extension["']/, "the SDK is still loaded at run time, by name");
}

test("the bundled extension imports only node builtins and the SDK that Copilot CLI provides, and passes node --check", async (t) => {
  const tmp = tempDir("b");
  t.after(tmp.cleanup);
  const outfile = join(tmp.path, "extension.mjs");
  const result = await bundleExtension(outfile);
  assert.deepEqual(result.errors, []);

  const output = Object.values(result.metafile.outputs)[0]!;
  assert.ok(output.imports.length > 0);
  for (const imported of output.imports) {
    assert.equal(imported.external, true, `${imported.path} is bundled, not external`);
    assert.ok(imported.path.startsWith("node:") || imported.path.startsWith("@github/copilot-sdk"), `unexpected import ${imported.path}`);
  }
  assertSelfContained(readFileSync(outfile, "utf8"));

  const check = spawnSync(process.execPath, ["--check", outfile], { encoding: "utf8" });
  assert.equal(check.status, 0, check.stderr);
});

test("dist/extension.mjs, when it has been built, is self-contained too", (t) => {
  const dist = join(REPO_ROOT, "dist", "extension.mjs");
  if (!existsSync(dist)) {
    t.skip("dist/extension.mjs has not been built; run npm run build");
    return;
  }
  assertSelfContained(readFileSync(dist, "utf8"));
  const check = spawnSync(process.execPath, ["--check", dist], { encoding: "utf8" });
  assert.equal(check.status, 0, check.stderr);
});

// ───── 真的跑一个扩展进程 ─────

const FAKE_SDK = `
export async function joinSession() {
  const handlers = new Set();
  const ok = (value) => async () => value;
  const session = {
    sessionId: "e2e",
    rpc: { tasks: {
      list: ok({ tasks: [] }),
      cancel: ok({ cancelled: true }),
      remove: ok({ removed: true }),
      sendMessage: ok({ sent: true }),
      promoteToBackground: ok({ promoted: true }),
      readOutput: ok({ text: "", cursor: "c", exit: { status: "completed" } }),
    } },
    on(handler) { handlers.add(handler); return () => handlers.delete(handler); },
    async log() {},
  };
  setTimeout(() => {
    const emit = (event) => handlers.forEach((h) => h(event));
    emit({ type: "tool.execution_start", data: { toolCallId: "c1", toolName: "bash", arguments: { command: "make" } } });
    emit({ type: "tool.shell_output", data: { toolCallId: "c1", sequence: 1, text: "B\\r" } });
    emit({ type: "tool.shell_output", data: { toolCallId: "c1", sequence: 0, text: "\\u001b[1mA\\u001b[0m " } });
    emit({ type: "subagent.started", agentId: "a1", data: { toolCallId: "t1" } });
    emit({ type: "assistant.usage", agentId: "a1", data: { inputTokens: 3, outputTokens: 1 } });
  }, 100);
  return session;
}
`;

interface Running {
  child: ChildProcess;
  stdout: string[];
  stderr: string[];
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

function startExtension(bundle: string, dataDir: string, runtimeDir: string): Running {
  const env: NodeJS.ProcessEnv = { ...process.env, SESSION_ID: "e2e", COPILOT_PANES_HOME: dataDir, XDG_RUNTIME_DIR: runtimeDir };
  delete env.COPILOT_PANES_NO_START;
  delete env.COPILOT_EXTENSION_PARENT_PID;
  const child = spawn(process.execPath, [bundle], { env, stdio: ["pipe", "pipe", "pipe"] });
  const stdout: string[] = [];
  const stderr: string[] = [];
  child.stdout!.on("data", (d: Buffer) => stdout.push(d.toString()));
  child.stderr!.on("data", (d: Buffer) => stderr.push(d.toString()));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  return { child, stdout, stderr, exited };
}

async function waitFor<T>(what: string, probe: () => T | null | undefined | false, timeoutMs = 8000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`等不到：${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function readRegistration(path: string, wantPid: number): Registration | null {
  try {
    const parsed = parseRegistration(readFileSync(path, "utf8"));
    return parsed.ok && parsed.value.extensionPid === wantPid ? parsed.value : null;
  } catch {
    return null;
  }
}

test("the built extension runs as a real process: serves a client, records output, and cleans up on SIGTERM; after SIGKILL the next process takes over", async (t) => {
  const tmp = tempDir("b");
  const running: Running[] = [];
  t.after(async () => {
    for (const r of running) if (r.child.exitCode === null && r.child.signalCode === null) r.child.kill("SIGKILL");
    for (const r of running) await r.exited;
    tmp.cleanup();
  });
  const bundle = join(tmp.path, "extension.mjs");
  await bundleExtension(bundle);
  const sdkDir = join(tmp.path, "node_modules", "@github", "copilot-sdk");
  mkdirSync(sdkDir, { recursive: true });
  writeFileSync(join(sdkDir, "package.json"), JSON.stringify({ name: "@github/copilot-sdk", type: "module", exports: { "./extension": "./extension.mjs" } }));
  writeFileSync(join(sdkDir, "extension.mjs"), FAKE_SDK);

  const dataDir = join(tmp.path, "d");
  const registrationFile = join(dataDir, "sessions", "e2e.json");
  const socketFile = join(dataDir, "sessions", "e2e.sock");

  // 第一个进程：正常工作，SIGTERM 结束
  const first = startExtension(bundle, dataDir, tmp.path);
  running.push(first);
  const registration = await waitFor("the registration file", () => readRegistration(registrationFile, first.child.pid!));
  assert.equal(registration.sessionId, "e2e");
  assert.equal(registration.copilotPid, process.pid, "the parent of the extension is the Copilot CLI");
  assert.equal(registration.socketPath, socketFile);

  const client = await TestClient.connect(registration.socketPath);
  const [hello, tasks] = await client.take(2);
  assert.equal(hello?.type === "hello" && hello.extensionPid, first.child.pid);
  assert.equal(tasks?.type, "tasks");
  const usage = (await client.takeMatching((m) => m.type === "usage" && "a1" in m.agents, 5000)) as UsageMessage;
  assert.equal(usage.agents.a1?.inputTokens, 3);
  assert.equal(readFileSync(join(dataDir, "out", "e2e", "c1.out"), "utf8"), "\x1b[1mA\x1b[0m B\r");
  client.send(request("r1", "sendMessage", "a1", "hi"));
  assert.deepEqual(await client.takeMatching((m) => m.type === "result"), { type: "result", v: 1, requestId: "r1", ok: true });

  first.child.kill("SIGTERM");
  assert.deepEqual(await first.exited, { code: 0, signal: null });
  assert.equal(existsSync(registrationFile), false);
  assert.equal(existsSync(socketFile), false);
  await client.close();
  assert.equal(first.stdout.join(""), "", "stdout is the JSON-RPC channel and must stay empty");

  // 第二个进程被 SIGKILL：来不及清理，文件留下
  const second = startExtension(bundle, dataDir, tmp.path);
  running.push(second);
  await waitFor("the second registration", () => readRegistration(registrationFile, second.child.pid!));
  second.child.kill("SIGKILL");
  await second.exited;
  assert.equal(existsSync(registrationFile), true);
  assert.equal(existsSync(socketFile), true);
  await assert.rejects(TestClient.connect(socketFile), /ECONNREFUSED/);

  // 第三个进程接管同一个 session
  const third = startExtension(bundle, dataDir, tmp.path);
  running.push(third);
  const takenOver = await waitFor("the third registration", () => readRegistration(registrationFile, third.child.pid!));
  assert.equal(takenOver.extensionPid, third.child.pid);
  const again = await TestClient.connect(takenOver.socketPath!);
  const [hello3] = await again.take(3);
  assert.equal(hello3?.type === "hello" && hello3.extensionPid, third.child.pid);
  await again.close();
  third.child.kill("SIGTERM");
  assert.deepEqual(await third.exited, { code: 0, signal: null });
  assert.equal(existsSync(registrationFile), false);
  assert.equal(existsSync(socketFile), false);
  assert.equal(third.stdout.join(""), "");
  assert.equal(third.stderr.join(""), "", "a healthy run writes nothing to stderr");
});

test("without a working SDK the extension process says so on stderr, writes nothing to stdout, and exits", async (t) => {
  const tmp = tempDir("b");
  t.after(tmp.cleanup);
  const bundle = join(tmp.path, "extension.mjs");
  await bundleExtension(bundle);
  const run = startExtension(bundle, join(tmp.path, "d"), tmp.path);
  const { code } = await run.exited;
  assert.equal(code, 0);
  assert.equal(run.stdout.join(""), "");
  assert.match(run.stderr.join(""), /copilot-panes 扩展没有启动/);
});
