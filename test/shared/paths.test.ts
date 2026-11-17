import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_SOCKET_PATH_BYTES,
  copilotHome,
  dataDir,
  eventsPath,
  extensionInstallPath,
  outPath,
  registrationPath,
  safeName,
  sessionStateDir,
  socketFallbackDir,
  socketPath,
  workspacePath,
} from "../../src/paths.ts";

const HOME = "/home/u";
const SID = "3f2b8e1a-7c4d-4e59-9a06-d1b5c8e27f40";
const socketOptions = { runtimeDir: "/run/user/1000", tmpDir: "/var/tmp-x", uid: 1000 };

test("COPILOT_HOME moves everything and an empty value counts as unset", () => {
  assert.equal(copilotHome({}, HOME), "/home/u/.copilot");
  assert.equal(copilotHome({ COPILOT_HOME: "" }, HOME), "/home/u/.copilot");
  assert.equal(copilotHome({ COPILOT_HOME: "/c" }, HOME), "/c");
  assert.equal(dataDir({ COPILOT_HOME: "/c" }, HOME), "/c/copilot-panes");
  assert.equal(sessionStateDir({ COPILOT_HOME: "/c" }, HOME), "/c/session-state");
  assert.equal(extensionInstallPath({ COPILOT_HOME: "/c" }, HOME), "/c/extensions/copilot-panes/extension.mjs");
});

test("a command-line directory beats the environment variable, which beats the default", () => {
  const env = { COPILOT_PANES_HOME: "/env-data", COPILOT_PANES_STATE_DIR: "/env-state" };
  assert.equal(dataDir(env, HOME, "/flag-data"), "/flag-data");
  assert.equal(dataDir(env, HOME, null), "/env-data");
  assert.equal(dataDir({}, HOME), "/home/u/.copilot/copilot-panes");
  assert.equal(sessionStateDir(env, HOME, "/flag-state"), "/flag-state");
  assert.equal(sessionStateDir(env, HOME), "/env-state");
});

test("the files of one session sit where the layout says", () => {
  assert.equal(eventsPath("/s", SID), `/s/${SID}/events.jsonl`);
  assert.equal(workspacePath("/s", SID), `/s/${SID}/workspace.yaml`);
  assert.equal(registrationPath("/d", SID), `/d/sessions/${SID}.json`);
  assert.equal(outPath("/d", SID, "toolu_01Abc"), `/d/out/${SID}/toolu_01Abc.out`);
});

test("awkward ids become safe file names", () => {
  assert.equal(safeName("toolu_01Abc-x.y"), "toolu_01Abc-x.y");
  assert.equal(safeName("a/b"), "a_b");
  assert.equal(safeName("../x"), ".._x");
  assert.equal(safeName(".."), "_");
  assert.equal(safeName(""), "_");
  assert.equal(safeName("中文"), "__");
  assert.equal(safeName("😀"), "__", "a character above U+FFFF becomes two underscores, like the old extension");
  assert.equal(safeName("a\u0000b"), "a_b");
  assert.equal(outPath("/d", "../../etc", "x/y"), "/d/out/.._.._etc/x_y.out");
});

test("a very long id is shortened, stays distinct and is the same every time", () => {
  const a = "a".repeat(300);
  const b = "a".repeat(299) + "b";
  assert.equal(safeName(a).length, 197);
  assert.ok(safeName(a).startsWith("a".repeat(180) + "-"));
  assert.notEqual(safeName(a), safeName(b));
  assert.equal(safeName(a), safeName("a".repeat(300)));
});

test("the socket sits next to the registration unless that path is too long", () => {
  assert.equal(socketPath("/home/u/.copilot/copilot-panes", SID, socketOptions), `/home/u/.copilot/copilot-panes/sessions/${SID}.sock`);
  const deep = "/home/u/projects/some/very/deep/checkout/.scratch/tests/data";
  const long = socketPath(deep, SID, socketOptions) as string;
  assert.match(long, /^\/run\/user\/1000\/copilot-panes\/[0-9a-f]{16}\.sock$/);
  assert.ok(Buffer.byteLength(long) <= MAX_SOCKET_PATH_BYTES);
  assert.equal(socketPath(deep, SID, socketOptions), long, "both sides compute the same path");
  assert.notEqual(socketPath(deep, SID.replace("3f", "4f"), socketOptions), long);
  // 没有 XDG_RUNTIME_DIR 就没有现成的私有目录：不再给一个名字猜得到的临时目录，由扩展 mkdtemp（extension/src/socketdir.ts）
  assert.equal(socketPath(deep, SID, { ...socketOptions, runtimeDir: null }), null);
  assert.equal(socketFallbackDir({ ...socketOptions, runtimeDir: null }), null);
  assert.equal(socketPath("/home/u/.copilot/copilot-panes", SID, { ...socketOptions, runtimeDir: null }), `/home/u/.copilot/copilot-panes/sessions/${SID}.sock`);
});
