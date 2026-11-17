import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ErrorLog } from "../../extension/src/errors.ts";
import { Registrar } from "../../extension/src/registry.ts";
import { parseRegistration, PROTOCOL_VERSION, REGISTRATION_VERSION } from "../../src/protocol.ts";
import type { Registration } from "../../src/protocol.ts";
import { registrationPath } from "../../src/paths.ts";
import { tempDir } from "../helpers/tmp.ts";
import { FakeTime } from "./fake.ts";

const record = (extra: Partial<Registration> = {}): Omit<Registration, "updatedAt"> => ({
  v: REGISTRATION_VERSION,
  protocol: PROTOCOL_VERSION,
  sessionId: "s1",
  copilotPid: 4242,
  extensionPid: 4243,
  tmuxPane: "%3",
  cwd: "/work/demo",
  socketPath: "/x/s1.sock",
  extensionVersion: "0.0.0",
  startedAt: 1_700_000_000_000,
  ...extra,
});

function setup(extra: Partial<Registration> = {}) {
  const tmp = tempDir("r");
  const time = new FakeTime(1_700_000_000_000);
  const errors = new ErrorLog(time);
  const path = registrationPath(tmp.path, "s1");
  const registrar = new Registrar({ path, record: record(extra), clock: time, timers: time, heartbeatMs: 5000, errors });
  const read = () => {
    const parsed = parseRegistration(readFileSync(path, "utf8"));
    assert.ok(parsed.ok, "the registration parses");
    return parsed.value;
  };
  return { tmp, time, errors, path, registrar, read };
}

test("the registration is written atomically with mode 0600 and parses with parseRegistration", (t) => {
  const { tmp, path, registrar, read } = setup();
  t.after(tmp.cleanup);
  registrar.write();
  assert.deepEqual(read(), { ...record(), updatedAt: 1_700_000_000_000 });
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(statSync(join(path, "..")).mode & 0o777, 0o700);
  // 临时文件改名之后不留下
  assert.deepEqual(readdirSync(join(path, "..")), ["s1.json"]);
});

test("the heartbeat rewrites updatedAt every interval (fake timers)", (t) => {
  const { tmp, time, registrar, read } = setup();
  t.after(tmp.cleanup);
  registrar.start();
  assert.equal(read().updatedAt, 1_700_000_000_000);
  time.tick(4999);
  assert.equal(read().updatedAt, 1_700_000_000_000);
  time.tick(1);
  assert.equal(read().updatedAt, 1_700_000_005_000);
  time.tick(10_000);
  assert.equal(read().updatedAt, 1_700_000_015_000);
  assert.equal(read().startedAt, 1_700_000_000_000);
  registrar.start();
  assert.equal(time.pendingTimers, 1, "start() twice does not add a second heartbeat");
  registrar.stop();
});

test("a heartbeat recreates the file if something deleted it", (t) => {
  const { tmp, time, path, registrar } = setup();
  t.after(tmp.cleanup);
  registrar.start();
  tmp.cleanup();
  mkdirSync(tmp.path, { recursive: true });
  time.tick(5000);
  assert.equal(existsSync(path), true);
});

test("stop() deletes the file and a missing file is not an error", (t) => {
  const { tmp, time, errors, path, registrar } = setup();
  t.after(tmp.cleanup);
  registrar.start();
  registrar.stop();
  assert.equal(existsSync(path), false);
  assert.equal(time.pendingTimers, 0);
  time.tick(20_000);
  assert.equal(existsSync(path), false, "no heartbeat after stop");
  registrar.stop();

  const second = setup();
  t.after(second.tmp.cleanup);
  second.registrar.stop();
  assert.equal(second.errors.last(), null);
  assert.equal(errors.last(), null);
});

test("a registration written by a newer extension process for the same session is neither overwritten nor deleted", (t) => {
  const { tmp, time, path, registrar, read } = setup();
  t.after(tmp.cleanup);
  registrar.start();
  // 同一个 session 的扩展重新加载：新进程写了自己的记录
  const newer: Registration = { ...record({ extensionPid: 9999, startedAt: 1_700_000_003_000 }), updatedAt: 1_700_000_003_000 };
  writeFileSync(path, JSON.stringify(newer));
  time.tick(5000);
  assert.equal(read().extensionPid, 9999, "the old process's heartbeat leaves the newer record alone");
  registrar.stop();
  assert.equal(read().extensionPid, 9999, "the old process's stop() leaves the newer record alone");
});

test("a leftover registration from an older, killed process is replaced", (t) => {
  const { tmp, path, registrar, read } = setup();
  t.after(tmp.cleanup);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify({ ...record({ extensionPid: 1111, startedAt: 1_600_000_000_000 }), updatedAt: 1_600_000_000_000 }));
  registrar.write();
  assert.equal(read().extensionPid, 4243);
});

test("a write that fails is recorded under registration.write and does not throw", (t) => {
  const { tmp, errors, registrar } = setup();
  t.after(tmp.cleanup);
  // sessions 目录的位置被普通文件占着
  const blocked = join(tmp.path, "blocked");
  writeFileSync(blocked, "file");
  const broken = new Registrar({ path: join(blocked, "s1.json"), record: record(), clock: new FakeTime(), timers: new FakeTime(), heartbeatMs: 5000, errors });
  assert.doesNotThrow(() => broken.start());
  assert.equal(errors.last()?.step, "registration.write");
  assert.doesNotThrow(() => broken.stop());
  assert.doesNotThrow(() => registrar.stop());
});
