import assert from "node:assert/strict";
import { test } from "node:test";
import xterm from "@xterm/headless";

// @xterm/headless is CommonJS: Node cannot see its named exports, so destructure the default export.
const { Terminal } = xterm;

test("arithmetic works", () => {
  assert.equal(1 + 1, 2);
});

test("@xterm/headless renders carriage return and colour codes", async () => {
  const term = new Terminal({ cols: 20, rows: 5, allowProposedApi: true });
  await new Promise<void>((resolve) => term.write("a\rb\x1b[31mc", resolve));
  const line = term.buffer.active.getLine(0)?.translateToString(true);
  assert.equal(line, "bc");
  term.dispose();
});
