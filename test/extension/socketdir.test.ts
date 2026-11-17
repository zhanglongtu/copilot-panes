import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, statSync, symlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import { assertOwnDirectory, chooseSocket, removeCreatedDir } from "../../extension/src/socketdir.ts";
import { tempDir } from "../helpers/tmp.ts";

const LONG = "a-rather-long-directory-name-to-push-the-socket-path-over-the-limit-of-one-hundred-bytes";
const uid = process.getuid?.() ?? 1000;

test("a short path is used as it is and no directory is made", () => {
  const tmp = tempDir("sd");
  try {
    const chosen = chooseSocket(join(tmp.path, "data"), "s1", { runtimeDir: tmp.path, tmpDir: tmp.path, uid });
    assert.equal(chosen.path, join(tmp.path, "data", "sessions", "s1.sock"));
    assert.equal(chosen.createdDir, null);
  } finally {
    tmp.cleanup();
  }
});

test("a too-long path with XDG_RUNTIME_DIR uses <runtime>/copilot-panes, made 0700, or tightened to 0700 when it exists with looser permissions", () => {
  const tmp = tempDir("sd");
  try {
    const opts = { runtimeDir: tmp.path, tmpDir: tmp.path, uid };
    const first = chooseSocket(join(tmp.path, LONG, "data"), "s1", opts);
    assert.equal(dirname(first.path), join(tmp.path, "copilot-panes"));
    assert.equal(statSync(dirname(first.path)).mode & 0o777, 0o700);
    chmodSync(dirname(first.path), 0o775);
    chooseSocket(join(tmp.path, LONG, "data"), "s1", opts);
    assert.equal(statSync(dirname(first.path)).mode & 0o777, 0o700);
  } finally {
    tmp.cleanup();
  }
});

test("a fallback directory that is a symlink is refused and the link's target keeps its permissions", () => {
  const tmp = tempDir("sd");
  try {
    const target = join(tmp.path, "elsewhere");
    mkdirSync(target);
    chmodSync(target, 0o755);
    symlinkSync(target, join(tmp.path, "copilot-panes"));
    assert.throws(() => chooseSocket(join(tmp.path, LONG, "data"), "s1", { runtimeDir: tmp.path, tmpDir: tmp.path, uid }), /不是真目录/);
    assert.equal(statSync(target).mode & 0o777, 0o755);
    assert.throws(() => assertOwnDirectory(join(tmp.path, "copilot-panes"), uid), /不是真目录/);
    assert.throws(() => assertOwnDirectory(tmp.path, uid + 1), /不属于当前用户/);
  } finally {
    tmp.cleanup();
  }
});

test("without XDG_RUNTIME_DIR a too-long path gets a fresh mkdtemp directory (random, 0700), reused on retry, and removeCreatedDir only removes such a directory", () => {
  const tmp = tempDir("sd");
  try {
    const opts = { runtimeDir: null, tmpDir: tmp.path, uid };
    const a = chooseSocket(join(tmp.path, LONG, "data"), "s1", opts);
    const b = chooseSocket(join(tmp.path, LONG, "data"), "s1", opts);
    assert.ok(a.createdDir && b.createdDir);
    assert.notEqual(a.createdDir, b.createdDir, "a guessable name would let another user take the directory first");
    assert.match(basename(a.createdDir), /^copilot-panes-\d+-[A-Za-z0-9]{6}$/);
    assert.equal(statSync(a.createdDir).mode & 0o777, 0o700);
    assert.equal(a.path, join(a.createdDir, "s.sock"));
    const again = chooseSocket(join(tmp.path, LONG, "data"), "s1", opts, a.createdDir);
    assert.equal(again.createdDir, a.createdDir, "a retry reuses the directory it made");
    removeCreatedDir(a.createdDir);
    assert.equal(existsSync(a.createdDir), false);
    const stranger = join(tmp.path, "keep-me");
    mkdirSync(stranger);
    removeCreatedDir(stranger);
    assert.equal(existsSync(stranger), true, "a directory with another name is never removed");
  } finally {
    tmp.cleanup();
  }
});
