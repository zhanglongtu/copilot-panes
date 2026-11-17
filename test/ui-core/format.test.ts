import assert from "node:assert/strict";
import { test } from "node:test";
import { formatDuration, formatTokens, formatTokensAtLeast } from "../../src/ui/format.ts";
import { textWidth } from "../../src/ui/width.ts";

test("formatDuration gives 48s, 1m29s, 12m, 1h02m and never more than 5 columns", () => {
  const cases: [number, string][] = [
    [0, "0s"],
    [999, "0s"],
    [48_000, "48s"],
    [59_999, "59s"],
    [60_000, "1m00s"],
    [89_000, "1m29s"],
    [599_999, "9m59s"],
    [600_000, "10m"],
    [12 * 60_000 + 30_000, "12m"],
    [3_599_000, "59m"],
    [3_600_000, "1h00m"],
    [3_720_000, "1h02m"],
    [35_999_000, "9h59m"],
    [36_000_000, "10h"],
    [99 * 3_600_000, "99h"],
    [-5000, "0s"],
    [Number.NaN, "0s"],
  ];
  for (const [ms, expected] of cases) assert.equal(formatDuration(ms), expected, `${ms} ms`);
  for (let s = 0; s < 400_000; s += 37) assert.ok(textWidth(formatDuration(s * 1000)) <= 5, formatDuration(s * 1000));
});

test("formatTokens gives 9000, 40.9万, 123万 and 1.2亿 and never more than 6 columns", () => {
  const cases: [number, string][] = [
    [0, "0"],
    [9000, "9000"],
    [9999, "9999"],
    [10_000, "1.0万"],
    [11_000, "1.1万"],
    [409_000, "40.9万"],
    [999_499, "99.9万"],
    [999_500, "100万"],
    [999_960, "100万"],
    [1_230_000, "123万"],
    [99_994_999, "9999万"],
    [99_995_000, "1.0亿"],
    [123_456_789, "1.2亿"],
    [9_994_999_999, "99.9亿"],
    [9_995_000_000, "100亿"],
    [123_456_789_012, "1235亿"],
    [-3, "0"],
    [Number.NaN, "0"],
    [40.9, "41"],
  ];
  for (const [n, expected] of cases) assert.equal(formatTokens(n), expected, `${n}`);
  for (let n = 0; n < 2e11; n = Math.ceil(n * 1.37) + 1) assert.ok(textWidth(formatTokens(n)) <= 6, `${n} → ${formatTokens(n)}`);
});

test("formatTokensAtLeast rounds down, starts with ≥ and stays within 6 columns", () => {
  const cases: [number, string][] = [[0, "≥0"], [9999, "≥9999"], [10_000, "≥1.0万"], [123_456, "≥12万"], [99_999, "≥9.9万"], [9_999_999, "≥999万"], [52_000_000, "≥0.5亿"], [450_000_000, "≥4.5亿"], [9_990_000_000, "≥99亿"]];
  for (const [n, text] of cases) {
    assert.equal(formatTokensAtLeast(n), text);
    assert.ok(textWidth(formatTokensAtLeast(n)) <= 6, text);
  }
  assert.equal(formatTokensAtLeast(Number.NaN), "≥0");
});
