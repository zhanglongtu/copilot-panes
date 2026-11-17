import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isRegistrationLive, readRegistrations } from "../../src/discover/registry.ts";
import { sessionsDir } from "../../src/paths.ts";
import { REGISTRATION_VERSION, serializeRegistration } from "../../src/protocol.ts";
import { tempDir } from "../helpers/tmp.ts";
import { registration } from "./helpers.ts";

test("registrations are read from the sessions directory and broken files are skipped", () => {
  const dir = tempDir("r");
  try {
    assert.deepEqual(readRegistrations(dir.path), []);
    const sessions = sessionsDir(dir.path);
    mkdirSync(sessions, { recursive: true });
    writeFileSync(join(sessions, "a.json"), serializeRegistration(registration("a")));
    writeFileSync(join(sessions, "b.json"), serializeRegistration(registration("b", { tmuxPane: null })));
    writeFileSync(join(sessions, "broken.json"), "{ not json");
    writeFileSync(join(sessions, "old-format.json"), JSON.stringify({ ...registration("old"), v: 99 }));
    writeFileSync(join(sessions, "missing-fields.json"), JSON.stringify({ v: REGISTRATION_VERSION, sessionId: "m" }));
    writeFileSync(join(sessions, "a.sock"), "not a registration");
    mkdirSync(join(sessions, "dir.json"));
    const found = readRegistrations(dir.path);
    assert.deepEqual(found.map((r) => r.sessionId), ["a", "b"]);
    assert.equal(found[1]?.tmuxPane, null);
  } finally {
    dir.cleanup();
  }
});

test("a registration is live only while its Copilot CLI process lives and the heartbeat is within 20 seconds", () => {
  const r = registration("a", { copilotPid: 4000, updatedAt: 100_000 });
  const alive = (pid: number) => pid === 4000;
  assert.equal(isRegistrationLive(r, 100_000, alive), true);
  assert.equal(isRegistrationLive(r, 120_000, alive), true);
  assert.equal(isRegistrationLive(r, 120_001, alive), false);
  assert.equal(isRegistrationLive(r, 100_000, () => false), false);
  // 时钟略有偏差，心跳比现在还新一点，仍然有效
  assert.equal(isRegistrationLive(r, 99_000, alive), true);
});
