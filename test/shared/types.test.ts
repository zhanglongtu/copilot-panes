import assert from "node:assert/strict";
import { test } from "node:test";
import { agentKey, commandKey, isEnded, parseEntryKey } from "../../src/types/model.ts";

test("entry keys tell agents from commands even when the ids look alike or contain colons", () => {
  assert.notEqual(agentKey("x"), commandKey("x"));
  assert.deepEqual(parseEntryKey(agentKey("a:b")), { kind: "agent", id: "a:b" });
  assert.deepEqual(parseEntryKey(commandKey("toolu_1")), { kind: "command", id: "toolu_1" });
  assert.equal(parseEntryKey("agent:"), null);
  assert.equal(parseEntryKey("toolu_1"), null);
});

test("idle and running are not ended, the other three are", () => {
  assert.deepEqual(
    (["running", "idle", "done", "failed", "stopped"] as const).map(isEnded),
    [false, false, true, true, true],
  );
});
