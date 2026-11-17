import assert from "node:assert/strict";
import { chmodSync, mkdirSync, symlinkSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { checkSocketSafety } from "../../src/bridge/socket-safety.ts";
import type { SafetyFs } from "../../src/bridge/socket-safety.ts";
import { tempDir } from "../helpers/tmp.ts";

type Entry = { kind: "dir" | "socket" | "file" | "symlink"; uid?: number; mode?: number };

/** 假的文件系统：路径 → 类型、属主、权限；不在表里的路径报 ENOENT。 */
function fakeFs(entries: Record<string, Entry>, uid = 1000): SafetyFs {
  return {
    uid,
    lstat: (path) => {
      const e = entries[path];
      if (!e) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return {
        uid: e.uid ?? uid,
        mode: e.mode ?? (e.kind === "dir" ? 0o700 : 0o600),
        isDirectory: () => e.kind === "dir",
        isSocket: () => e.kind === "socket",
        isSymbolicLink: () => e.kind === "symlink",
      };
    },
  };
}

const SOCK = "/run/user/1000/copilot-panes/a.sock";
const DIR = "/run/user/1000/copilot-panes";

test("a socket that is ours, in our own private directory, is safe", () => {
  assert.equal(checkSocketSafety(SOCK, fakeFs({ [DIR]: { kind: "dir" }, [SOCK]: { kind: "socket" } })), null);
  // 还没有 socket 文件、或目录还不存在：不算不安全，由连接和重连去处理
  assert.equal(checkSocketSafety(SOCK, fakeFs({ [DIR]: { kind: "dir" } })), null);
  assert.equal(checkSocketSafety(SOCK, fakeFs({})), null);
});

test("a directory that is a symlink, someone else's, or writable by group or others is refused", () => {
  assert.match(checkSocketSafety(SOCK, fakeFs({ [DIR]: { kind: "symlink" } })) ?? "", /是符号链接/);
  assert.match(checkSocketSafety(SOCK, fakeFs({ [DIR]: { kind: "file" } })) ?? "", /不是目录/);
  assert.match(checkSocketSafety(SOCK, fakeFs({ [DIR]: { kind: "dir", uid: 1001 } })) ?? "", /不属于当前用户/);
  assert.match(checkSocketSafety(SOCK, fakeFs({ [DIR]: { kind: "dir", mode: 0o770 } })) ?? "", /对组或其他人可写/);
  assert.match(checkSocketSafety(SOCK, fakeFs({ [DIR]: { kind: "dir", mode: 0o707 } })) ?? "", /对组或其他人可写/);
});

test("a socket file that is not a socket, someone else's, or writable by group or others is refused", () => {
  const dir = { [DIR]: { kind: "dir" as const } };
  assert.match(checkSocketSafety(SOCK, fakeFs({ ...dir, [SOCK]: { kind: "file" } })) ?? "", /不是 socket/);
  assert.match(checkSocketSafety(SOCK, fakeFs({ ...dir, [SOCK]: { kind: "socket", uid: 0 } })) ?? "", /不属于当前用户/);
  assert.match(checkSocketSafety(SOCK, fakeFs({ ...dir, [SOCK]: { kind: "socket", mode: 0o666 } })) ?? "", /对组或其他人可写/);
  assert.match(checkSocketSafety(SOCK, fakeFs({ ...dir, [SOCK]: { kind: "symlink" } })) ?? "", /不是 socket/);
});

test("with the real file system: a private directory with a 0600 socket passes, a symlinked or group-writable directory does not", async () => {
  const tmp = tempDir("ss-");
  try {
    const real = join(tmp.path, "real");
    mkdirSync(real, { mode: 0o700 });
    const socketPath = join(real, "x.sock");
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    try {
      chmodSync(socketPath, 0o600);
      assert.equal(checkSocketSafety(socketPath), null);
      chmodSync(socketPath, 0o666);
      assert.match(checkSocketSafety(socketPath) ?? "", /对组或其他人可写/);
      chmodSync(socketPath, 0o600);
      const link = join(tmp.path, "link");
      symlinkSync(real, link);
      assert.match(checkSocketSafety(join(link, "x.sock")) ?? "", /是符号链接/);
      chmodSync(real, 0o770);
      assert.match(checkSocketSafety(socketPath) ?? "", /对组或其他人可写/);
    } finally {
      chmodSync(real, 0o700);
      server.close();
    }
  } finally {
    tmp.cleanup();
  }
});
