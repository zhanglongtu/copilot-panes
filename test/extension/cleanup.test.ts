import assert from "node:assert/strict";
import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { cleanupStale } from "../../extension/src/cleanup.ts";
import { outDir, registrationPath, sessionsDir } from "../../src/paths.ts";
import { PROTOCOL_VERSION, REGISTRATION_VERSION } from "../../src/protocol.ts";
import { tempDir } from "../helpers/tmp.ts";

const NOW = 1_800_000_000_000;
const DAY = 24 * 3600 * 1000;
const RETENTION = 7 * DAY;

function age(path: string, msAgo: number): void {
  const t = (NOW - msAgo) / 1000;
  utimesSync(path, t, t);
}

function addOutDir(dataDir: string, sessionId: string, files: Array<[name: string, msAgo: number]>, dirMsAgo: number): string {
  const dir = outDir(dataDir, sessionId);
  mkdirSync(dir, { recursive: true });
  for (const [name, msAgo] of files) {
    writeFileSync(join(dir, name), "out");
    age(join(dir, name), msAgo);
  }
  age(dir, dirMsAgo);
  return dir;
}

function addRegistration(dataDir: string, sessionId: string, copilotPid: number, socketPath: string | null): string {
  mkdirSync(sessionsDir(dataDir), { recursive: true });
  const path = registrationPath(dataDir, sessionId);
  writeFileSync(
    path,
    JSON.stringify({
      v: REGISTRATION_VERSION,
      protocol: PROTOCOL_VERSION,
      sessionId,
      copilotPid,
      extensionPid: copilotPid + 1,
      tmuxPane: null,
      cwd: "/x",
      socketPath,
      extensionVersion: "0",
      startedAt: NOW - 1000,
      updatedAt: NOW - 1000,
    }),
  );
  return path;
}

/** 开一个真的 socket，留下一个 socket 文件（测试结束时关掉）。 */
async function makeSocket(path: string, t: { after(fn: () => void): void }): Promise<void> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(path, resolve));
  t.after(() => server.close());
}

const alive = (...pids: number[]) => (pid: number) => pids.includes(pid);
const options = (dataDir: string, isPidAlive: (pid: number) => boolean) => ({ dataDir, selfSessionId: "self", now: NOW, retentionMs: RETENTION, isPidAlive });

test("output directories older than seven days are removed and the own session's directory is kept", (t) => {
  const tmp = tempDir("c");
  t.after(tmp.cleanup);
  addOutDir(tmp.path, "old", [["a.out", 9 * DAY]], 9 * DAY);
  addOutDir(tmp.path, "self", [["a.out", 30 * DAY]], 30 * DAY);
  addOutDir(tmp.path, "fresh", [["a.out", DAY]], DAY);
  addOutDir(tmp.path, "appended", [["a.out", DAY]], 20 * DAY);
  addOutDir(tmp.path, "empty-old", [], 8 * DAY);
  writeFileSync(join(tmp.path, "out", "stray-file"), "x");
  age(join(tmp.path, "out", "stray-file"), 30 * DAY);

  const report = cleanupStale(options(tmp.path, alive()));
  assert.deepEqual(report.removedOutDirs.sort(), ["empty-old", "old"]);
  assert.equal(existsSync(outDir(tmp.path, "old")), false);
  assert.equal(existsSync(outDir(tmp.path, "self")), true);
  assert.equal(existsSync(outDir(tmp.path, "fresh")), true);
  assert.equal(existsSync(outDir(tmp.path, "appended")), true, "a file in it was written a day ago");
  assert.equal(existsSync(join(tmp.path, "out", "stray-file")), true, "only directories are removed");
  assert.deepEqual(report.errors, []);
});

test("the output directory of a session whose registration is still valid is kept however old it is", (t) => {
  const tmp = tempDir("c");
  t.after(tmp.cleanup);
  addOutDir(tmp.path, "busy", [["a.out", 20 * DAY]], 20 * DAY);
  addRegistration(tmp.path, "busy", 500, join(tmp.path, "busy.sock"));
  assert.deepEqual(cleanupStale(options(tmp.path, alive(500))).removedOutDirs, []);
  assert.equal(existsSync(outDir(tmp.path, "busy")), true);
});

test("registrations whose Copilot CLI process is gone are removed together with their socket", async (t) => {
  const tmp = tempDir("c");
  t.after(tmp.cleanup);
  const deadSocket = join(sessionsDir(tmp.path), "dead.sock");
  const liveSocket = join(sessionsDir(tmp.path), "live.sock");
  mkdirSync(sessionsDir(tmp.path), { recursive: true });
  await makeSocket(deadSocket, t);
  await makeSocket(liveSocket, t);
  const dead = addRegistration(tmp.path, "dead", 100, deadSocket);
  const live = addRegistration(tmp.path, "live", 200, liveSocket);
  const self = addRegistration(tmp.path, "self", 100, join(sessionsDir(tmp.path), "self.sock"));

  const report = cleanupStale(options(tmp.path, alive(200)));
  assert.deepEqual(report.removedRegistrations, ["dead"]);
  assert.equal(existsSync(dead), false);
  assert.equal(existsSync(deadSocket), false);
  assert.equal(existsSync(live), true);
  assert.equal(existsSync(liveSocket), true);
  assert.equal(existsSync(self), true, "the own registration is never removed");
});

test("a dead registration whose socket sat in a mkdtemp directory also loses that directory; one with socketPath null is just removed", async (t) => {
  const tmp = tempDir("c");
  t.after(tmp.cleanup);
  const dir = join(tmp.path, "copilot-panes-1000-AbC123");
  const other = join(tmp.path, "my-sockets");
  mkdirSync(dir);
  mkdirSync(other);
  await makeSocket(join(dir, "s.sock"), t);
  await makeSocket(join(other, "s.sock"), t);
  const mkdtemped = addRegistration(tmp.path, "a", 100, join(dir, "s.sock"));
  const foreign = addRegistration(tmp.path, "b", 100, join(other, "s.sock"));
  const none = addRegistration(tmp.path, "c", 100, null);
  cleanupStale(options(tmp.path, alive()));
  assert.equal(existsSync(mkdtemped) || existsSync(foreign) || existsSync(none), false);
  assert.equal(existsSync(dir), false, "the directory the extension made is removed with its socket");
  assert.equal(existsSync(other), true, "a directory with another name is never touched");
});

test("a dead registration whose socketPath is not a socket leaves that file alone", (t) => {
  const tmp = tempDir("c");
  t.after(tmp.cleanup);
  const precious = join(tmp.path, "precious.txt");
  writeFileSync(precious, "keep me");
  const dead = addRegistration(tmp.path, "dead", 100, precious);
  cleanupStale(options(tmp.path, alive()));
  assert.equal(existsSync(dead), false);
  assert.equal(existsSync(precious), true);
});

test("an unreadable registration is removed only when it is older than the retention period", (t) => {
  const tmp = tempDir("c");
  t.after(tmp.cleanup);
  mkdirSync(sessionsDir(tmp.path), { recursive: true });
  const young = join(sessionsDir(tmp.path), "young.json");
  const old = join(sessionsDir(tmp.path), "old.json");
  writeFileSync(young, "{ not json");
  writeFileSync(old, JSON.stringify({ v: 99 }));
  age(young, DAY);
  age(old, 8 * DAY);
  cleanupStale(options(tmp.path, alive()));
  assert.equal(existsSync(young), true);
  assert.equal(existsSync(old), false);
});

test("sockets without a registration and leftover temp files go away once they are older than a minute", async (t) => {
  const tmp = tempDir("c");
  t.after(tmp.cleanup);
  const dir = sessionsDir(tmp.path);
  mkdirSync(dir, { recursive: true });
  const orphan = join(dir, "orphan.sock");
  const fresh = join(dir, "fresh.sock");
  const registered = join(dir, "reg.sock");
  await makeSocket(orphan, t);
  await makeSocket(fresh, t);
  await makeSocket(registered, t);
  age(orphan, 120_000);
  age(registered, 120_000);
  age(fresh, 5_000);
  addRegistration(tmp.path, "reg", 200, registered);
  const tmpOld = join(dir, "x.json.77.tmp");
  const tmpNew = join(dir, "y.json.78.tmp");
  writeFileSync(tmpOld, "{}");
  writeFileSync(tmpNew, "{}");
  age(tmpOld, 120_000);
  age(tmpNew, 1_000);
  const notSocket = join(dir, "notes.sock");
  writeFileSync(notSocket, "a regular file");
  age(notSocket, 120_000);

  cleanupStale(options(tmp.path, alive(200)));
  assert.equal(existsSync(orphan), false);
  assert.equal(existsSync(fresh), true);
  assert.equal(existsSync(registered), true);
  assert.equal(existsSync(tmpOld), false);
  assert.equal(existsSync(tmpNew), true);
  assert.equal(existsSync(notSocket), true);
});

test("a data directory that does not exist yet is fine, and so is cleanup running twice", (t) => {
  const tmp = tempDir("c");
  t.after(tmp.cleanup);
  const missing = join(tmp.path, "nothing-here");
  assert.deepEqual(cleanupStale(options(missing, alive())), { removedOutDirs: [], removedRegistrations: [], errors: [] });
  addOutDir(tmp.path, "old", [["a.out", 9 * DAY]], 9 * DAY);
  assert.deepEqual(cleanupStale(options(tmp.path, alive())).removedOutDirs, ["old"]);
  assert.deepEqual(cleanupStale(options(tmp.path, alive())).removedOutDirs, []);
});
