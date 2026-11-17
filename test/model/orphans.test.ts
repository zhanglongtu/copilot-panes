import assert from "node:assert/strict";
import { test } from "node:test";
import { markOrphaned } from "../../src/model/orphans.ts";
import { BASE, bashBackground, bashStart, completed, ev, listOf, started, storeOf, taskCall } from "./support.ts";

const LAST = BASE + 90_000;

test("an agent and a command that were running when the process vanished stop, with their time frozen at the last event", () => {
  const store = storeOf(
    taskCall("t1", null, 0),
    started("a1", "worker", { task: "t1", at: 0 }),
    bashStart("c1", "npm run build", "a1", 10, { mode: "async" }),
    bashBackground("c1", "sh1", "a1", 10.1),
    ev("assistant.turn_end", {}, "a1", 90),
  );
  assert.equal(store.lastEventAt, LAST);
  const now = LAST + 3_600_000;
  const before = listOf(store, { now });
  assert.deepEqual(before.map((e) => e.status), ["running", "running"]);

  const after = markOrphaned(before, store);
  assert.deepEqual(after.map((e) => [e.status, e.orphaned, e.step, e.task]), [
    ["stopped", true, "已停", null],
    ["stopped", true, "已停", null],
  ]);
  assert.equal(after[0]!.elapsedMs, 90_000);
  assert.equal(after[1]!.elapsedMs, 80_000);
});

test("an idle agent is stopped too but keeps its time; done and failed entries are left alone", () => {
  const store = storeOf(taskCall("t1", null, 0), started("a1", "worker", { task: "t1", at: 0 }), completed("a1", "t1", { at: 30, ms: 30_000 }));
  const [done] = listOf(store, { now: LAST });
  assert.equal(done!.status, "done");
  assert.deepEqual(markOrphaned([done!], store), [done]);

  const idle = { ...done!, status: "idle" as const, elapsedMs: 12_000 };
  const [stopped] = markOrphaned([idle], store);
  assert.deepEqual([stopped!.status, stopped!.orphaned, stopped!.elapsedMs], ["stopped", true, 12_000]);
});
