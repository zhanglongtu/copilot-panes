import assert from "node:assert/strict";
import { test } from "node:test";
import { FOLD_MIN_PROMPTS, FOLD_SCAN_CHARS, PromptFolds } from "../../src/model/prompt-fold.ts";

// 任务说明常常以同一段固定的话开头
const HEADER = "开始前请先读项目说明，再按其中的约定动手；交回的结果要写清楚改了哪些文件、跑了什么命令。";

function folds(prompts: Record<string, string>): Record<string, number> {
  const all = new PromptFolds();
  for (const [id, text] of Object.entries(prompts)) all.add(id, text);
  return Object.fromEntries(Object.keys(prompts).map((id) => [id, all.fold(id)]));
}

test("with fewer than three prompts nothing is folded; with three or more the shared header is", () => {
  assert.equal(FOLD_MIN_PROMPTS, 3);
  const a = `${HEADER}\n\n任务甲：查右侧面板。`;
  const b = `${HEADER}\n\n任务乙：查数据来源。`;
  const c = `${HEADER}\n\n任务丙：盘点代码。`;
  assert.deepEqual(folds({ a }), { a: 0 });
  assert.deepEqual(folds({ a, b }), { a: 0, b: 0 });
  assert.deepEqual(folds({ a, b, c }), { a: HEADER.length + 2, b: HEADER.length + 2, c: HEADER.length + 2 });
});

test("the fold ends on a paragraph boundary: it includes the blank line after the shared paragraph and none of the task", () => {
  const prompts = { a: `${HEADER}\n\n任务甲`, b: `${HEADER}\n\n任务乙`, c: `${HEADER}\n\n任务丙` };
  const result = folds(prompts);
  assert.equal(prompts.a.slice(result.a), "任务甲");
  assert.equal(prompts.b.slice(result.b!), "任务乙");
});

test("only prompts that really share the paragraph in the same place count; a prompt that differs is not folded", () => {
  const a = `${HEADER}\n\n任务甲`;
  const b = `${HEADER}\n\n任务乙`;
  const c = `${HEADER}\n\n任务丙`;
  const other = `完全不同的开头。\n\n${HEADER}\n\n任务丁`;
  const almost = `${HEADER.replace("。", "！")}\n\n任务戊`;
  const result = folds({ a, b, c, other, almost });
  assert.equal(result.a, HEADER.length + 2);
  assert.equal(result.other, 0, "the same paragraph at another position does not count");
  assert.equal(result.almost, 0, "one character different is a different paragraph");
});

test("several shared paragraphs in a row are folded together, as long as each prefix is shared by three", () => {
  const second = "你是子 agent，亲自完成下面的任务。";
  const prompts = {
    a: `${HEADER}\n\n${second}\n\n任务甲`,
    b: `${HEADER}\n\n${second}\n\n任务乙`,
    c: `${HEADER}\n\n${second}\n\n任务丙`,
    d: `${HEADER}\n\n别的第二段\n\n任务丁`,
    e: `${HEADER}\n\n别的第二段\n\n任务戊`,
  };
  const result = folds(prompts);
  assert.equal(prompts.a.slice(result.a), "任务甲");
  // d、e 的第二段只有两份：只折共有的第一段
  assert.equal(result.d, HEADER.length + 2);
  assert.equal(result.e, HEADER.length + 2);
});

test("at least one paragraph is left: prompts that are identical are not folded away entirely", () => {
  const same = `${HEADER}\n\n同一件事`;
  assert.deepEqual(folds({ a: same, b: same, c: same }), { a: HEADER.length + 2, b: HEADER.length + 2, c: HEADER.length + 2 });
  assert.deepEqual(folds({ a: HEADER, b: HEADER, c: HEADER }), { a: 0, b: 0, c: 0 });
});

test("blank lines may hold spaces or use Windows line ends; one line break is not a paragraph break", () => {
  const first = "第一段";
  const prompts = { a: `${first}\r\n\r\n甲`, b: `${first}\n \t\n\n乙`, c: `${first}\n\n\n\n丙`, d: `${first}\n紧接着没有空行\n\n丁` };
  const result = folds(prompts);
  assert.equal(prompts.a.slice(result.a), "甲");
  assert.equal(prompts.b.slice(result.b!), "乙");
  assert.equal(prompts.c.slice(result.c!), "丙");
  assert.equal(result.d, 0, "its first paragraph is longer");
});

test("adding or replacing a prompt updates the result, and a prompt that is replaced stops counting", () => {
  const all = new PromptFolds();
  all.add("a", `${HEADER}\n\n甲`);
  all.add("b", `${HEADER}\n\n乙`);
  assert.equal(all.fold("a"), 0);
  all.add("c", `${HEADER}\n\n丙`);
  assert.equal(all.fold("a"), HEADER.length + 2);
  all.add("c", "换成别的\n\n内容");
  assert.equal(all.fold("a"), 0, "only two left");
  assert.equal(all.fold("unknown"), 0);
  assert.equal(all.size, 3);
});

test("only the first FOLD_SCAN_CHARS characters are looked at", () => {
  const long = "字".repeat(FOLD_SCAN_CHARS + 10);
  const prompts = { a: `${long}\n\n甲`, b: `${long}\n\n乙`, c: `${long}\n\n丙` };
  assert.deepEqual(folds(prompts), { a: 0, b: 0, c: 0 });
});
