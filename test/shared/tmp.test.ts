import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { REPO_ROOT, tempDir } from "../helpers/tmp.ts";

test("temp dirs live under the repository's .scratch and are removed by cleanup", () => {
  const t = tempDir("t-");
  assert.ok(t.path.startsWith(join(REPO_ROOT, ".scratch", "tmp")));
  writeFileSync(join(t.path, "f"), "x");
  t.cleanup();
  assert.equal(existsSync(t.path), false);
});
