import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { isExperimentalOn, readExtensionEnv } from "../../src/bridge/extension-env.ts";
import { CONNECTING_GRACE_MS, explainReadonly } from "../../src/bridge/readonly.ts";
import type { ReadonlyInput } from "../../src/bridge/readonly.ts";
import { textWidth } from "../../src/ui/width.ts";
import { tempDir } from "../helpers/tmp.ts";

const READY = { installed: true, experimental: true };
const NOW = 1_000_000;

function explain(over: Partial<ReadonlyInput>) {
  return explainReadonly({ registered: false, bridge: null, env: READY, now: NOW, ...over });
}

test("connected is not read-only", () => {
  assert.equal(explain({ registered: true, bridge: { status: "connected" } }), null);
});

test("a registration whose socket is not connected yet, or dropped less than 3 seconds ago, says it is connecting", () => {
  const connecting = { tone: "muted", text: "正在连接扩展…" };
  assert.deepEqual(explain({ registered: true, bridge: { status: "connecting", statusSince: NOW - 1000 } })?.notice, connecting);
  assert.deepEqual(explain({ registered: true, bridge: { status: "connecting", statusSince: NOW - (CONNECTING_GRACE_MS - 1) } })?.notice, connecting);
  assert.deepEqual(explain({ registered: true, bridge: { status: "idle" } })?.notice, connecting);
  assert.deepEqual(explain({ registered: true, bridge: null })?.notice, connecting, "a registration, the client not built yet");
  const why = explain({ registered: true, bridge: { status: "connecting" } });
  assert.deepEqual([why?.why, why?.reason, why?.cause], ["connecting", "正在连接扩展…", "扩展正在连接"]);
});

test("still not connected after 3 seconds is a problem with a way forward", () => {
  const why = explain({ registered: true, bridge: { status: "connecting", statusSince: NOW - CONNECTING_GRACE_MS } });
  assert.equal(why?.why, "unreachable");
  assert.equal(why?.notice.tone, "attention");
  assert.match(why?.notice.text ?? "", /^只读：连不上扩展。重启 Copilot CLI，或运行 copilot-panes doctor/);
  assert.equal(explain({ registered: true, bridge: { status: "connecting", statusSince: NOW - 100 }, settled: true })?.why, "unreachable", "doctor has already waited");
});

test("a registration with no socket says the extension could not open one", () => {
  const why = explain({ registered: true, noSocket: true, bridge: null });
  assert.equal(why?.why, "no-socket");
  assert.match(why?.notice.text ?? "", /^只读：扩展没能开成连接，正在重试/);
});

test("no registration: the extension file is missing, experimental is off, or this session started before the extension was there", () => {
  const missing = explain({ env: { installed: false, experimental: true } });
  assert.deepEqual(missing?.notice, { tone: "attention", text: "只读：还没装扩展。运行 copilot-panes install，再重启 Copilot CLI" });
  assert.equal(missing?.cause, "还没装扩展");

  // 没装扩展又没开实验功能：先说没装，装好之后才说得到实验功能
  assert.equal(explain({ env: { installed: false, experimental: false } })?.why, "not-installed");

  const off = explain({ env: { installed: true, experimental: false } });
  assert.deepEqual(off?.notice, { tone: "attention", text: "只读：实验功能没开，扩展不会加载。运行 /settings experimental on 后重启" });
  assert.equal(off?.reason, "只读：实验功能没开");

  const late = explain({});
  assert.deepEqual(late?.notice, { tone: "attention", text: "只读：这个 session 启动时还没装扩展。对它说“重新加载扩展”，或重启 Copilot CLI" });
  assert.deepEqual([late?.reason, late?.cause], ["只读：这个 session 没加载扩展", "这个 session 启动时还没装扩展"]);
});

test("a protocol version that does not match, and a connection the safety check refused, are told apart", () => {
  const version = explain({ registered: true, bridge: { status: "incompatible", problemKind: "version" } });
  assert.deepEqual(version?.notice, { tone: "attention", text: "只读：扩展和界面的版本不一致。运行 copilot-panes install，再重启 Copilot CLI" });

  const unsafe = explain({ registered: true, bridge: { status: "incompatible", problemKind: "unsafe", problemDetail: "/x/s.sock 对组或其他人可写" } });
  assert.deepEqual(unsafe?.notice, { tone: "attention", text: "只读：扩展的连接没通过安全检查（/x/s.sock 对组或其他人可写）" });
  const mismatch = explain({ registered: true, bridge: { status: "incompatible", problemKind: "mismatch", problemDetail: "socket 属于另一个 session" } });
  assert.equal(mismatch?.why, "unsafe");
  assert.match(mismatch?.notice.text ?? "", /（socket 属于另一个 session）$/);
  // 原因很长（带路径）时截短，不让一行撑爆
  const long = explain({ registered: true, bridge: { status: "incompatible", problemKind: "unsafe", problemDetail: `socket 所在的目录 /home/${"x".repeat(100)} 对组或其他人可写` } });
  assert.ok(textWidth(long?.notice.text ?? "") <= 80, long?.notice.text ?? "");
});

test("every notice fits in 80 columns", () => {
  const all = [
    explain({ registered: true, bridge: { status: "connecting" } }),
    explain({ registered: true, bridge: { status: "connecting", statusSince: 0 } }),
    explain({ registered: true, noSocket: true, bridge: null }),
    explain({ env: { installed: false, experimental: true } }),
    explain({ env: { installed: true, experimental: false } }),
    explain({}),
    explain({ registered: true, bridge: { status: "incompatible", problemKind: "version" } }),
    explain({ registered: true, bridge: { status: "incompatible", problemKind: "unsafe", problemDetail: "x".repeat(200) } }),
  ];
  for (const why of all) assert.ok(textWidth(why?.notice.text ?? "") <= 80, `${textWidth(why?.notice.text ?? "")} columns: ${why?.notice.text}`);
});

test("settings.json: experimental has to be true; an unreadable file or invalid JSON falls back to a text match", () => {
  assert.equal(isExperimentalOn('{"experimental": true, "x": 1}'), true);
  assert.equal(isExperimentalOn('{"experimental": false}'), false);
  assert.equal(isExperimentalOn('{"experimental": "true"}'), false);
  assert.equal(isExperimentalOn("{}"), false);
  assert.equal(isExperimentalOn('{ "experimental": true, // comment\n}'), true);
  assert.equal(isExperimentalOn("not json"), false);
});

test("the extension environment is read from COPILOT_HOME", () => {
  const dir = tempDir("ee-");
  try {
    const env = { COPILOT_HOME: dir.path };
    assert.deepEqual(readExtensionEnv(env, "/nonexistent-home"), { installed: false, experimental: false });
    writeFileSync(join(dir.path, "settings.json"), JSON.stringify({ experimental: true }));
    assert.deepEqual(readExtensionEnv(env, "/nonexistent-home"), { installed: false, experimental: true });
    mkdirSync(join(dir.path, "extensions", "copilot-panes"), { recursive: true });
    writeFileSync(join(dir.path, "extensions", "copilot-panes", "extension.mjs"), "//");
    assert.deepEqual(readExtensionEnv(env, "/nonexistent-home"), { installed: true, experimental: true });
  } finally {
    dir.cleanup();
  }
});
