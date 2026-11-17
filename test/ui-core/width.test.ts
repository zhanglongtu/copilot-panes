import assert from "node:assert/strict";
import { test } from "node:test";
import { CellMeter, charWidth, clipText, graphemes, padText, textWidth, wrapText } from "../../src/ui/width.ts";

test("Chinese and full-width characters take two columns, combining marks and ZWJ none", () => {
  assert.equal(textWidth("你好，世界"), 10);
  assert.equal(textWidth("，。！？：；（）「」『』《》"), 28);
  assert.equal(textWidth("ＡＢＣ１２３"), 12);
  assert.equal(textWidth("　"), 2);
  assert.equal(textWidth("한글ひらがなカタカナ"), 20);
  assert.equal(textWidth("ｱｲｳ"), 3);
  assert.equal(charWidth(0x4f60), 2);
  assert.equal(charWidth(0x61), 1);
  assert.equal(charWidth(0x301), 0);
  assert.equal(charWidth(0x200d), 0);
  assert.equal(charWidth(0x200b), 0);
  assert.equal(charWidth(0x1b), 0);
  assert.equal(textWidth("e\u0301"), 1);
  assert.equal(textWidth("a\u200db"), 2);
  assert.equal(textWidth("webshop  修登录失败的 bug"), 7 + 2 + 12 + 1 + 3);
});

test("every symbol the interface draws is one column wide", () => {
  for (const symbol of ["┃", "│", "┏", "━", "┠", "┌", "─", "├", "▌", "▰", "▱", "⊘", "◌", "●", "▸", "›", "•", "○", "✓", "✗", "⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏", "⠿", "…", "−", "↑", "↓"]) {
    assert.equal(textWidth(symbol), 1, `U+${symbol.codePointAt(0)!.toString(16)} ${symbol}`);
  }
  assert.equal(textWidth("┃│┏━┠┌─├▌▰▱⊘◌●▸›•○✓✗⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⠿…−↑↓"), 35);
});

test("emoji follow tmux: wide by default, joined into one cell by ZWJ, skin tones, flags and VS16", () => {
  assert.equal(textWidth("😀🎉🚀✅⭐"), 10);
  assert.equal(textWidth("❤"), 1);
  assert.equal(textWidth("❤️"), 2);
  assert.equal(textWidth("1️⃣"), 2);
  assert.equal(textWidth("👍🏽"), 2);
  assert.equal(textWidth("🇨🇳"), 2);
  assert.equal(textWidth("👨‍👩‍👧"), 2);
  // tmux 一个格子最多存 21 个字节，太长的 ZWJ 序列会拆成几个格子（tmux 3.4 实测是 4 列）
  assert.equal(textWidth("🧑🏽‍🤝‍🧑🏻"), 4);
  // 撑宽之后 tmux 把“前一个格子”当成空白格，再来一个变体选择符会多占一列（tmux 3.4 实测）
  assert.equal(textWidth("x\ufe0f\ufe0f"), 3);
});

test("graphemes keeps combining marks, skin tones and ZWJ sequences together", () => {
  assert.deepEqual(graphemes("ae\u0301你"), ["a", "e\u0301", "你"]);
  assert.deepEqual(graphemes("👍🏽x"), ["👍🏽", "x"]);
  assert.deepEqual(graphemes("👨‍👩‍👧"), ["👨‍👩‍👧"]);
  assert.deepEqual(graphemes(""), []);
});

test("clipText never cuts half a wide character and never splits a grapheme", () => {
  const strings = [
    "python3 -u score.py --run nov15",
    "等 run-tests 交回结果",
    "任务：登录失败是因为 src/auth.ts 里的 refreshToken() 提前清空了会话。",
    "修登录失败的 bug",
    "你好世界",
    "",
    "a",
  ];
  for (const s of strings) {
    for (let w = -1; w <= 80; w++) {
      const out = clipText(s, w);
      if (w <= 0) assert.equal(out, "", `${JSON.stringify(s)} at ${w}`);
      else if (textWidth(s) <= w) assert.equal(out, s, `${JSON.stringify(s)} at ${w}`);
      else {
        assert.ok(out.endsWith("…") && textWidth(out) <= w, `${JSON.stringify(s)} at ${w}: ${out}`);
        assert.ok(s.startsWith(out.slice(0, -1)), `${JSON.stringify(s)} at ${w}: a prefix plus …`);
        assert.ok(textWidth(out) >= w - 1, `${JSON.stringify(s)} at ${w}: only as much as a wide character leaves`);
      }
    }
  }
  assert.equal(clipText("你好世界", 4), "你…");
  assert.equal(clipText("你好世界", 5), "你好…");
  assert.equal(clipText("abcdef", 4), "abc…");
  assert.equal(clipText("abcdef", 1), "…");
  assert.equal(clipText("abcdef", 0), "");
  assert.equal(clipText("abc", 3), "abc");

  // 带组合符号和表情的字符串：结果不超宽，也不留下半个字素
  const tricky = ["e\u0301e\u0301e\u0301e\u0301", "你👍🏽好👨‍👩‍👧世", "x\u0301y\u0301z", "❤️❤️❤️", "🇨🇳🇺🇸abc"];
  for (const s of tricky) {
    const cuts = new Set<string>();
    let acc = "";
    for (const g of graphemes(s)) cuts.add((acc += g));
    for (let w = 1; w <= textWidth(s) + 1; w++) {
      const out = clipText(s, w);
      assert.ok(textWidth(out) <= w, `${JSON.stringify(s)} at ${w} gave ${JSON.stringify(out)}`);
      if (out !== s) {
        const kept = out.slice(0, -1);
        assert.ok(kept === "" || cuts.has(kept), `${JSON.stringify(out)} cuts a grapheme of ${JSON.stringify(s)}`);
      }
    }
  }
  assert.equal(clipText("e\u0301e\u0301e\u0301", 3), "e\u0301e\u0301e\u0301");
  assert.equal(clipText("e\u0301e\u0301e\u0301", 2), "e\u0301…");
});

test("clipText ends with an ellipsis only when something was cut, and the result always fits", () => {
  const alphabet = ["a", "你", "é", "e\u0301", "😀", "❤️", "👍🏽", " ", "世", "x"];
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = 0; i < 400; i++) {
    let s = "";
    for (let j = 0, n = 1 + Math.floor(rnd() * 12); j < n; j++) s += alphabet[Math.floor(rnd() * alphabet.length)];
    for (let w = 0; w <= 16; w++) {
      const out = clipText(s, w);
      assert.ok(textWidth(out) <= Math.max(0, w), `${JSON.stringify(s)} at ${w}`);
      if (textWidth(s) > w && w > 0) assert.ok(out.endsWith("…"));
    }
  }
});

test("padText pads with spaces to the exact width, clipping first, on the chosen side", () => {
  assert.equal(padText("你", 4), "你  ");
  assert.equal(padText("ab", 5, "right"), "   ab");
  assert.equal(padText("abcdef", 4), "abc…");
  assert.equal(textWidth(padText("你好世界", 5)), 5);
  assert.equal(padText("", 3), "   ");
});

test("CellMeter reports the width so far and can be copied", () => {
  const a = new CellMeter();
  a.push(0x4f60);
  const b = a.copy();
  b.push(0x61);
  assert.equal(a.width, 2);
  assert.equal(b.width, 3);
});

test("wrapText keeps newlines, breaks words at spaces and hard-cuts words longer than a line", () => {
  assert.deepEqual(wrapText("", 10), [""]);
  assert.deepEqual(wrapText("ab\n\ncd", 10), ["ab", "", "cd"]);
  assert.deepEqual(wrapText("abc\n", 10), ["abc", ""]);
  assert.deepEqual(wrapText("a\r\nb\rc", 10), ["a", "b", "c"]);

  assert.deepEqual(wrapText("the quick brown fox jumps over", 12), ["the quick", "brown fox", "jumps over"]);
  assert.deepEqual(wrapText("hello   world again", 10), ["hello", "world", "again"]);

  // 比一行还长的单词在放不下处硬切
  assert.deepEqual(wrapText("a".repeat(25), 10), ["aaaaaaaaaa", "aaaaaaaaaa", "aaaaa"]);
  assert.deepEqual(wrapText("hello " + "x".repeat(25), 10), ["hello", "xxxxxxxxxx", "xxxxxxxxxx", "xxxxx"]);

  // 中文长句前部的空格不让首行提前断开
  const chinese = "好 " + "中文长句".repeat(10);
  const rows = wrapText(chinese, 40);
  assert.ok(textWidth(rows[0]!) >= 36, `first row is ${textWidth(rows[0]!)} columns: ${rows[0]}`);
  for (const row of rows) assert.ok(textWidth(row) <= 40);
  assert.equal(rows.join("").replaceAll(" ", ""), chinese.replaceAll(" ", ""));
});

test("wrapText never exceeds the width, never splits a wide character and loses no text", () => {
  const text = "你好 world, 这是一个测试 of mixed 文字 and emoji 😀👍🏽 plus a verylongwordwithoutanyspacesatall 结束。";
  for (let width = 2; width <= 40; width++) {
    const rows = wrapText(text, width);
    for (const row of rows) assert.ok(textWidth(row) <= width, `${width}: ${JSON.stringify(row)}`);
    assert.equal(rows.join("").replace(/ /g, ""), text.replace(/ /g, ""));
  }
  // 一个字素比整行还宽时单独占一行
  assert.deepEqual(wrapText("你好", 1), ["你", "好"]);
  assert.equal(textWidth("你"), 2);
});
