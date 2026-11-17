import assert from "node:assert/strict";
import { test } from "node:test";
import { describeError, ErrorLog } from "../../extension/src/errors.ts";
import { FakeTime } from "./fake.ts";

test("only the latest error is kept, folded to one line", () => {
  const time = new FakeTime(5000);
  const log = new ErrorLog(time);
  assert.equal(log.last(), null);
  log.record("tasks.list", new Error("first"));
  time.tick(10);
  log.record("output.append", new Error("disk\n  is   full\r\n"));
  assert.deepEqual(log.last(), { step: "output.append", message: "disk is full", at: 5010 });
});

test("long reasons are cut at 500 characters and odd values are described", () => {
  const log = new ErrorLog(new FakeTime());
  log.record("x", "a".repeat(600));
  assert.equal(log.last()?.message, `${"a".repeat(500)}…`);
  assert.equal(describeError({ message: "from object" }), "from object");
  assert.equal(describeError(undefined), "undefined");
  assert.equal(describeError(new Error("")), "Error");
  assert.equal(describeError({ toString: () => { throw new Error("no"); } }), "无法转成文字的异常");
});

test("last() hands out a copy", () => {
  const log = new ErrorLog(new FakeTime());
  log.record("x", "boom");
  const copy = log.last()!;
  copy.message = "changed";
  assert.equal(log.last()?.message, "boom");
});

test("the stderr hook gets a repeated line only once a minute, and a throwing hook is harmless", () => {
  const time = new FakeTime();
  const lines: string[] = [];
  const log = new ErrorLog(time, (line) => lines.push(line));
  log.record("tasks.list", "down");
  log.record("tasks.list", "down");
  log.record("tasks.list", "other");
  time.tick(61_000);
  log.record("tasks.list", "other");
  assert.deepEqual(lines, ["tasks.list: down", "tasks.list: other", "tasks.list: other"]);

  const throwing = new ErrorLog(time, () => {
    throw new Error("stderr closed");
  });
  throwing.record("x", "boom");
  assert.equal(throwing.last()?.message, "boom");
});
