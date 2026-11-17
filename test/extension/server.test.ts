import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, renameSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { PanesServer } from "../../extension/src/server.ts";
import type { PanesServerOptions } from "../../extension/src/server.ts";
import { PROTOCOL_VERSION } from "../../src/protocol.ts";
import type { ExtensionMessage, RequestMessage, ResultMessage } from "../../src/protocol.ts";
import { tempDir } from "../helpers/tmp.ts";
import { request, TestClient } from "./fake.ts";

const hello: ExtensionMessage = { type: "hello", v: PROTOCOL_VERSION, sessionId: "s1", copilotPid: 10, extensionPid: 11, extensionVersion: "0.0.0" };
const tasks: ExtensionMessage = { type: "tasks", v: PROTOCOL_VERSION, at: 1, tasks: [], shellCalls: {}, error: null };
const usage: ExtensionMessage = { type: "usage", v: PROTOCOL_VERSION, at: 2, agents: {} };

async function startServer(t: { after(fn: () => void | Promise<void>): void }, overrides: Partial<PanesServerOptions> = {}) {
  const tmp = tempDir("v");
  const path = join(tmp.path, "sessions", "s1.sock");
  const requests: RequestMessage[] = [];
  const errors: Array<[string, unknown]> = [];
  const server = new PanesServer({
    path,
    greeting: () => [hello, tasks, usage],
    onRequest: async (r) => {
      requests.push(r);
      return { type: "result", v: PROTOCOL_VERSION, requestId: r.requestId, ok: true };
    },
    onError: (step, e) => errors.push([step, e]),
    ...overrides,
  });
  await server.listen();
  t.after(async () => {
    await server.close();
    tmp.cleanup();
  });
  return { tmp, path, server, requests, errors };
}

async function untilTrue(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 8000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`等不到：${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("a new connection first receives hello, then tasks, then usage", async (t) => {
  const { path } = await startServer(t);
  const client = await TestClient.connect(path);
  assert.deepEqual(await client.take(3), [hello, tasks, usage]);
  await client.expectQuiet();
  await client.close();
});

test("two clients connected at once both receive broadcasts, and a client that went away does not disturb the other", async (t) => {
  const { path, server } = await startServer(t);
  const a = await TestClient.connect(path);
  const b = await TestClient.connect(path);
  await a.take(3);
  await b.take(3);
  await untilTrue(() => server.connectionCount === 2, "two connections");
  server.broadcast({ ...usage, at: 3 });
  assert.deepEqual(await a.take(), [{ ...usage, at: 3 }]);
  assert.deepEqual(await b.take(), [{ ...usage, at: 3 }]);

  await a.close();
  await untilTrue(() => server.connectionCount === 1, "one connection left");
  server.broadcast({ ...usage, at: 4 });
  assert.deepEqual(await b.take(), [{ ...usage, at: 4 }]);
  await b.close();
});

test("a request gets its result, and a result goes only to the connection that asked", async (t) => {
  const { path, requests } = await startServer(t);
  const asker = await TestClient.connect(path);
  const other = await TestClient.connect(path);
  await asker.take(3);
  await other.take(3);
  asker.send(request("r1", "sendMessage", "a1", "hello"));
  assert.deepEqual(await asker.take(), [{ type: "result", v: PROTOCOL_VERSION, requestId: "r1", ok: true }]);
  assert.deepEqual(requests, [{ type: "request", v: PROTOCOL_VERSION, requestId: "r1", op: "sendMessage", taskId: "a1", message: "hello" }]);
  await other.expectQuiet();
  await asker.close();
  await other.close();
});

test("an unreadable request with a readable requestId gets a failed result; one without is ignored", async (t) => {
  const { path, requests } = await startServer(t);
  const client = await TestClient.connect(path);
  await client.take(3);

  client.sendRaw(`${JSON.stringify({ type: "request", v: PROTOCOL_VERSION, requestId: "bad1", op: "explode" })}\n`);
  const [first] = await client.take();
  assert.equal(first?.type, "result");
  assert.equal(first?.type === "result" && first.requestId, "bad1");
  assert.equal(first?.type === "result" && !first.ok && first.reason.startsWith("请求看不懂："), true);

  client.sendRaw(`${JSON.stringify({ type: "request", v: 99, requestId: "bad2", op: "refreshTasks" })}\n`);
  const [versioned] = await client.take();
  assert.equal(versioned?.type === "result" && !versioned.ok && versioned.reason.includes("协议版本"), true);

  // 读不出 requestId 的（坏 JSON、没有编号、编号不合格）什么都不回；紧跟着的好请求照常处理
  client.sendRaw("this is not json\n");
  client.sendRaw(`${JSON.stringify({ type: "request", v: PROTOCOL_VERSION, op: "refreshTasks" })}\n`);
  client.sendRaw(`${JSON.stringify({ type: "request", v: PROTOCOL_VERSION, requestId: "has space", op: "refreshTasks" })}\n`);
  client.sendRaw("\n\r\n");
  client.send(request("good", "refreshTasks"));
  assert.deepEqual(await client.take(), [{ type: "result", v: PROTOCOL_VERSION, requestId: "good", ok: true }]);
  assert.equal(requests.length, 1);
  await client.close();
});

test("a request split over several writes, or two requests in one write, are both handled", async (t) => {
  const { path, requests } = await startServer(t);
  const client = await TestClient.connect(path);
  await client.take(3);
  const line = `${JSON.stringify(request("split", "cancel", "a1"))}\n`;
  client.sendRaw(line.slice(0, 20));
  await new Promise((resolve) => setTimeout(resolve, 20));
  client.sendRaw(line.slice(20));
  client.sendRaw(`${JSON.stringify(request("p1", "refreshTasks"))}\n${JSON.stringify(request("p2", "refreshTasks"))}\n`);
  const results = await client.take(3);
  assert.deepEqual(results.map((m) => m.type === "result" && m.requestId).sort(), ["p1", "p2", "split"]);
  assert.equal(requests.length, 3);
  await client.close();
});

test("the same requestId on one connection is executed once and answered each time; another connection may reuse it", async (t) => {
  let release: () => void = () => {};
  let runs = 0;
  const { path } = await startServer(t, {
    onRequest: (r) => {
      runs += 1;
      return new Promise<ResultMessage>((resolve) => {
        release = () => resolve({ type: "result", v: PROTOCOL_VERSION, requestId: r.requestId, ok: false, reason: `run ${runs}` });
      });
    },
  });
  const client = await TestClient.connect(path);
  await client.take(3);
  client.send(request("dup", "cancel", "a1"));
  client.send(request("dup", "cancel", "a1"));
  await untilTrue(() => runs === 1, "first run started");
  release();
  const answers = await client.take(2);
  assert.deepEqual(answers, [
    { type: "result", v: PROTOCOL_VERSION, requestId: "dup", ok: false, reason: "run 1" },
    { type: "result", v: PROTOCOL_VERSION, requestId: "dup", ok: false, reason: "run 1" },
  ]);
  client.send(request("dup", "cancel", "a1"));
  assert.deepEqual((await client.take())[0], answers[0]);
  assert.equal(runs, 1);

  const second = await TestClient.connect(path);
  await second.take(3);
  second.send(request("dup", "cancel", "a1"));
  await untilTrue(() => runs === 2, "second connection runs it again");
  release();
  assert.deepEqual((await second.take())[0], { type: "result", v: PROTOCOL_VERSION, requestId: "dup", ok: false, reason: "run 2" });
  await client.close();
  await second.close();
});

test("a request handler that throws gives a failed result and an error report, and the server keeps working", async (t) => {
  const { path, errors } = await startServer(t, {
    onRequest: async () => {
      throw new Error("handler broke");
    },
  });
  const client = await TestClient.connect(path);
  await client.take(3);
  client.send(request("r1", "refreshTasks"));
  const [result] = await client.take();
  assert.equal(result?.type === "result" && !result.ok && result.reason, "扩展处理请求出错：handler broke");
  assert.equal(errors[0]?.[0], "server.request");
  client.send(request("r2", "refreshTasks"));
  assert.equal((await client.take())[0]?.type, "result");
  await client.close();
});

test("a greeting that throws is reported and the connection still works", async (t) => {
  let fail = true;
  const { path, errors } = await startServer(t, {
    greeting: () => {
      if (fail) throw new Error("no greeting");
      return [hello];
    },
  });
  const client = await TestClient.connect(path);
  client.send(request("r1", "refreshTasks"));
  assert.equal((await client.take())[0]?.type, "result");
  assert.equal(errors[0]?.[0], "server.greeting");
  fail = false;
  const next = await TestClient.connect(path);
  assert.deepEqual(await next.take(), [hello]);
  await client.close();
  await next.close();
});

test("an old socket file at the path is replaced; close() removes the socket file; the file mode is 0600", async (t) => {
  const tmp = tempDir("v");
  t.after(tmp.cleanup);
  const path = join(tmp.path, "sessions", "s1.sock");
  mkdirSync(join(tmp.path, "sessions"));

  // 上一个进程被 SIGKILL 后留下的 socket 文件：文件在，没人监听
  const dead = net.createServer();
  await new Promise<void>((resolve) => dead.listen(path, resolve));
  renameSync(path, `${path}.moved`);
  dead.close();
  renameSync(`${path}.moved`, path);
  assert.equal(statSync(path).isSocket(), true);
  await assert.rejects(TestClient.connect(path), /ECONNREFUSED/);

  const server = new PanesServer({ path, greeting: () => [hello], onRequest: async (r) => ({ type: "result", v: 1, requestId: r.requestId, ok: true }), onError: () => {} });
  await server.listen();
  assert.equal(statSync(path).mode & 0o777, 0o600);
  const client = await TestClient.connect(path);
  assert.deepEqual(await client.take(), [hello]);

  await server.close();
  assert.equal(existsSync(path), false);
  await untilTrue(() => client.closed, "client sees the connection closed");
  await server.close();
});

test("an existing socket directory that others can write to is tightened to 0700", async (t) => {
  const tmp = tempDir("v");
  t.after(tmp.cleanup);
  const dir = join(tmp.path, "shared");
  mkdirSync(dir);
  chmodSync(dir, 0o777);
  const server = new PanesServer({ path: join(dir, "s1.sock"), greeting: () => [], onRequest: async (r) => ({ type: "result", v: 1, requestId: r.requestId, ok: true }), onError: () => {} });
  await server.listen();
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  await server.close();
});

test("the socket directory is created with mode 0700 when it does not exist", async (t) => {
  const tmp = tempDir("v");
  t.after(tmp.cleanup);
  const path = join(tmp.path, "deep", "er", "s1.sock");
  const server = new PanesServer({ path, greeting: () => [], onRequest: async (r) => ({ type: "result", v: 1, requestId: r.requestId, ok: true }), onError: () => {} });
  await server.listen();
  assert.equal(statSync(join(tmp.path, "deep", "er")).mode & 0o777, 0o700);
  await server.close();
});

test("a new server at the same path takes over; the old server closing afterwards does not remove the new socket", async (t) => {
  const tmp = tempDir("v");
  t.after(tmp.cleanup);
  const path = join(tmp.path, "s1.sock");
  const make = (name: string) =>
    new PanesServer({
      path,
      greeting: () => [{ ...hello, sessionId: name }],
      onRequest: async (r) => ({ type: "result", v: 1, requestId: r.requestId, ok: true }),
      onError: () => {},
    });
  const oldServer = make("old");
  await oldServer.listen();
  const newServer = make("new");
  await newServer.listen();

  await oldServer.close();
  assert.equal(existsSync(path), true, "the new socket file survives the old server's close");
  const client = await TestClient.connect(path);
  const [greeting] = await client.take();
  assert.equal(greeting?.type === "hello" && greeting.sessionId, "new", "clients reach the new server");
  await client.close();
  assert.equal(existsSync(`${path}.${process.pid}.keep`), false, "no leftover file from moving the socket aside");

  await newServer.close();
  assert.equal(existsSync(path), false);
});

test("close() drops every connection, and removeSocketFile() only removes our own file", async (t) => {
  const { path, server } = await startServer(t);
  const client = await TestClient.connect(path);
  await client.take(3);
  server.removeSocketFile();
  assert.equal(existsSync(path), false);
  await server.close();
  await untilTrue(() => client.closed, "client sees the connection closed");
  assert.equal(server.connectionCount, 0);

  const other = tempDir("v");
  t.after(other.cleanup);
  const stranger = join(other.path, "x.sock");
  const never = new PanesServer({ path: stranger, greeting: () => [], onRequest: async (r) => ({ type: "result", v: 1, requestId: r.requestId, ok: true }), onError: () => {} });
  writeFileSync(stranger, "not ours");
  never.removeSocketFile();
  assert.equal(existsSync(stranger), true);
  await never.close();
  assert.equal(existsSync(stranger), true);
});

test("listen() rejects when the path cannot be used, so the caller can record it", async (t) => {
  const tmp = tempDir("v");
  t.after(tmp.cleanup);
  const blocked = join(tmp.path, "blocked");
  writeFileSync(blocked, "a file where the directory should be");
  const server = new PanesServer({ path: join(blocked, "s1.sock"), greeting: () => [], onRequest: async (r) => ({ type: "result", v: 1, requestId: r.requestId, ok: true }), onError: () => {} });
  await assert.rejects(server.listen());
  await server.close();
});

test("a socket directory that is a symlink is refused and its target is not chmod-ed", async (t) => {
  const tmp = tempDir("v");
  t.after(tmp.cleanup);
  const target = join(tmp.path, "target");
  mkdirSync(target);
  chmodSync(target, 0o755);
  const link = join(tmp.path, "link");
  symlinkSync(target, link);
  const server = new PanesServer({ path: join(link, "s1.sock"), greeting: () => [], onRequest: async (r) => ({ type: "result", v: PROTOCOL_VERSION, requestId: r.requestId, ok: true }), onError: () => {} });
  await assert.rejects(server.listen(), /不是真目录/);
  assert.equal(statSync(target).mode & 0o777, 0o755, "the link's target keeps its permissions");
  assert.equal(existsSync(join(target, "s1.sock")), false);
  await server.close();
});

test("a failed listen can be retried on another path", async (t) => {
  const tmp = tempDir("v");
  t.after(tmp.cleanup);
  const blocked = join(tmp.path, "sessions", "s1.sock");
  mkdirSync(blocked, { recursive: true });
  const server = new PanesServer({ path: blocked, greeting: () => [hello], onRequest: async (r) => ({ type: "result", v: PROTOCOL_VERSION, requestId: r.requestId, ok: true }), onError: () => {} });
  t.after(() => server.close());
  await assert.rejects(server.listen());
  const good = join(tmp.path, "other", "s1.sock");
  await server.listen(good);
  const client = await TestClient.connect(good);
  assert.equal((await client.take(1))[0]?.type, "hello");
  await client.close();
});
