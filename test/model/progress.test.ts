// 从命令输出的一行里认出进度。
import assert from "node:assert/strict";
import { test } from "node:test";
import { extractProgress } from "../../src/model/progress.ts";

test("fraction and percent together give '12/40 30%'", () => {
  assert.equal(extractProgress("[###-------] 12/40 30% 已用 1m20s 还要约 3m10s task_012"), "12/40 30%");
  assert.equal(extractProgress("[#---------] 2/40 5% 已用 13s 还要约 4m07s task_002"), "2/40 5%");
  assert.equal(extractProgress(" 30%|███       | 12/40 [00:05<00:12,  2.3it/s]"), "12/40 30%");
  assert.equal(extractProgress("Epoch 3/10 - loss 0.31 - 45%"), "3/10 45%");
});

test("a fraction alone gets a computed percent and a percent alone stays alone", () => {
  assert.equal(extractProgress("processed 12/40 files"), "12/40 30%");
  assert.equal(extractProgress("[ 3/10] Building target"), "3/10 30%");
  assert.equal(extractProgress("0/40"), "0/40 0%");
  assert.equal(extractProgress("40/40"), "40/40 100%");
  assert.equal(extractProgress("tests/test_auth.py::test_login PASSED [ 30%]"), "30%");
  assert.equal(extractProgress("tests/test_auth.py::test_login PASSED                     [100%]"), "100%");
  assert.equal(extractProgress("Downloading... 7%"), "7%");
  assert.equal(extractProgress("Progress: 45.3%"), "45%");
  assert.equal(extractProgress("(30%)"), "30%");
  assert.equal(extractProgress("Done 40/40."), "40/40 100%");
});

test("with several of each, the last fraction and the last percent are used", () => {
  assert.equal(extractProgress("batch 1/3 ... batch 2/3 ... 66%"), "2/3 66%");
  assert.equal(extractProgress("10% 20% 30%"), "30%");
  assert.equal(extractProgress("1/4 2/4 3/4"), "3/4 75%");
  assert.equal(extractProgress("file 7/9 of 120% load, 50%"), "7/9 50%");
});

test("paths, dates and version numbers are not progress", () => {
  for (const line of [
    "2026/11/16",
    "2026/11/16 07:48:20",
    "16/11/2026",
    "11/16/2026",
    "v1/2",
    "v1.2/3",
    "src/1/2.py",
    "tests/test_1/2",
    "x1/2",
    "and/or",
    "1/2.py",
    "1.2/3",
    "1/2.3",
    "see /usr/lib/x86_64/3/4",
    "https://example.com/1/2/3",
    "10/5",
    "5/1",
    "0/1",
    "1/1",
    "150%",
    "a50%",
    "50%25",
    "100.5%",
    "-",
    "",
    "no numbers here",
    "12 / 40",
    "12/ 40",
  ]) {
    assert.equal(extractProgress(line), null, line);
  }
});

test("a date inside a line does not hide the real progress next to it", () => {
  assert.equal(extractProgress("2026/11/16 07:48 scoring 12/40 30%"), "12/40 30%");
  assert.equal(extractProgress("v1/2 build 25%"), "25%");
});

test("percents and fractions are cut, never rounded: Python's round (half to even) and Math.round (half up) would disagree", () => {
  // 12.5、37.5、62.5、87.5：Python 的 round 得 12、38、62、88，Math.round 得 13、38、63、88；一律向下取整得 12、37、62、87
  assert.equal(extractProgress("1/8"), "1/8 12%");
  assert.equal(extractProgress("3/8"), "3/8 37%");
  assert.equal(extractProgress("5/8"), "5/8 62%");
  assert.equal(extractProgress("7/8"), "7/8 87%");
  // 0.5、1.5、2.5：Python 得 0、2、2，Math.round 得 1、2、3；向下取整得 0、1、2
  assert.equal(extractProgress("0.5%"), "0%");
  assert.equal(extractProgress("1.5%"), "1%");
  assert.equal(extractProgress("2.5%"), "2%");
  assert.equal(extractProgress("12.5%"), "12%");
  // 离 100 很近但没做完，不说成 100%
  assert.equal(extractProgress("99.9%"), "99%");
  assert.equal(extractProgress("199/200"), "199/200 99%");
  assert.equal(extractProgress("2/3"), "2/3 66%");
  // 分数和百分数都有时，百分数取它自己的整数部分
  assert.equal(extractProgress("1/8 12.9%"), "1/8 12%");
});
