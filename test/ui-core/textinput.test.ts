import assert from "node:assert/strict";
import { test } from "node:test";
import type { KeyEvent, PasteEvent, SpecialKey, TextInputState } from "../../src/types/ui.ts";
import { applyInput, emptyInput, layoutInput } from "../../src/ui/textinput.ts";

type Mods = Partial<Pick<KeyEvent, "ctrl" | "alt" | "shift">>;
const ch = (text: string, mods: Mods = {}): KeyEvent => ({ type: "key", key: "char", text, ctrl: false, alt: false, shift: false, ...mods });
const sp = (k: SpecialKey, mods: Mods = {}): KeyEvent => ({ type: "key", key: k, text: "", ctrl: false, alt: false, shift: false, ...mods });
const paste = (text: string): PasteEvent => ({ type: "paste", text });
const ctrl = (letter: string) => ch(letter, { ctrl: true });

/** 依次喂事件，返回最后的状态。 */
function run(start: TextInputState, ...events: (KeyEvent | PasteEvent)[]): TextInputState {
  let state = start;
  for (const event of events) state = applyInput(state, event).state;
  return state;
}
const typed = (text: string) => run(emptyInput(), ...[...text].map((c) => ch(c)));
/** 光标位置用 | 标出来，方便读断言。 */
const show = (s: TextInputState) => s.text.slice(0, s.cursor) + "|" + s.text.slice(s.cursor);
const at = (marked: string): TextInputState => {
  const i = marked.indexOf("|");
  return { text: marked.slice(0, i) + marked.slice(i + 1), cursor: i };
};

test("typing, cursor movement and deleting work by grapheme with Chinese and emoji", () => {
  assert.equal(show(typed("你好abc")), "你好abc|");
  assert.equal(show(run(typed("你好abc"), sp("left"), sp("left"), sp("left"), sp("left"))), "你|好abc");
  assert.equal(show(run(typed("你好"), sp("left"), ch("们"))), "你们|好");
  assert.equal(show(run(typed("你好"), sp("backspace"))), "你|");
  assert.equal(show(run(at("你|好"), sp("delete"))), "你|");
  assert.equal(show(run(at("|你好"), sp("backspace"))), "|你好");
  assert.equal(show(run(at("你好|"), sp("delete"))), "你好|");

  // 组合符号、表情、ZWJ 序列都是一个字素：一次移动、一次删除
  const family = "👨‍👩‍👧";
  assert.equal(show(run(at(`a${family}|b`), sp("left"))), `a|${family}b`);
  assert.equal(show(run(at(`a|${family}b`), sp("right"))), `a${family}|b`);
  assert.equal(show(run(at(`a${family}|b`), sp("backspace"))), "a|b");
  assert.equal(show(run(at(`a|${family}b`), sp("delete"))), "a|b");
  const accented = run(typed("e"), ch("\u0301"));
  assert.equal(show(accented), "e\u0301|");
  assert.equal(show(run(accented, sp("backspace"))), "|");
  assert.equal(show(run(at("👍🏽|x"), sp("left"))), "|👍🏽x");

  // 光标不在字素边界上时先挪到下一个边界
  assert.equal(show(run({ text: "e\u0301x", cursor: 1 }, sp("right"))), "e\u0301x|");
  assert.equal(show(run({ text: "ab", cursor: 99 }, ch("c"))), "abc|");

  // Home、End、Ctrl+A、Ctrl+E 在当前行
  assert.equal(show(run(at("ab|cd\nef"), sp("home"))), "|abcd\nef");
  assert.equal(show(run(at("ab|cd\nef"), sp("end"))), "abcd|\nef");
  assert.equal(show(run(at("ab\ncd|ef"), ctrl("a"))), "ab\n|cdef");
  assert.equal(show(run(at("ab\ncd|ef"), ctrl("e"))), "ab\ncdef|");
  assert.equal(show(run(at("ab\ncd|ef"), sp("home", { ctrl: true }))), "|ab\ncdef");
  assert.equal(show(run(at("ab|\ncdef"), sp("end", { ctrl: true }))), "ab\ncdef|");
});

test("Ctrl+U, Ctrl+K, Ctrl+W and Alt+Backspace delete to the line start, line end and the previous word", () => {
  assert.equal(show(run(at("first\nsecond| third"), ctrl("u"))), "first\n| third");
  assert.equal(show(run(at("first\nsecond| third\nlast"), ctrl("k"))), "first\nsecond|\nlast");
  assert.equal(show(run(at("abc|"), ctrl("k"))), "abc|");
  assert.equal(show(run(at("|abc"), ctrl("u"))), "|abc");
  assert.equal(show(run(at("hello wor|ld"), ctrl("w"))), "hello |ld");
  assert.equal(show(run(at("hello world  |"), ctrl("w"))), "hello |");
  assert.equal(show(run(at("hello   |"), ctrl("w"))), "|");
  assert.equal(show(run(at("hello world|"), sp("backspace", { alt: true }))), "hello |");
  assert.equal(show(run(at("a\n|b"), ctrl("w"))), "a|b");
  assert.equal(show(run(at("|a"), ctrl("w"))), "|a");
  // 中文没有空格也按词删，不会一下删掉整句
  const chinese = run(at("今天天气很好|"), ctrl("w"));
  assert.ok(chinese.text.length > 0 && chinese.text.length < 6, chinese.text);
});

test("Ctrl+J and Alt+Enter insert a newline; Enter submits non-blank text without clearing it", () => {
  assert.equal(show(run(typed("ab"), ctrl("j"), ch("c"))), "ab\nc|");
  assert.equal(show(run(typed("ab"), sp("enter", { alt: true }), ch("c"))), "ab\nc|");
  assert.equal(show(run(at("a|b"), sp("enter", { shift: true }))), "a\n|b");

  const submitted = applyInput(typed("  你好 "), sp("enter"));
  assert.equal(submitted.submit, "  你好 ");
  assert.equal(submitted.handled, true);
  assert.deepEqual(submitted.state, typed("  你好 "));

  for (const blank of ["", "   ", " \n \n"]) {
    const result = applyInput({ text: blank, cursor: blank.length }, sp("enter"));
    assert.equal(result.submit, null);
    assert.equal(result.handled, true);
    assert.equal(result.state.text, blank);
  }
  assert.equal(applyInput(typed("a"), ch("x")).submit, null);
});

test("paste normalises line endings and tabs", () => {
  assert.equal(show(run(at("a|b"), paste("1\r\n2\r3\n4"))), "a1\n2\n3\n4|b");
  assert.equal(show(run(emptyInput(), paste("x\ty"))), "x    y|");
  assert.equal(show(run(emptyInput(), paste("a\x1b[31mb\x07\x00c"))), "a[31mbc|");
  assert.equal(show(run(at("你|好"), paste("世界"))), "你世界|好");
  assert.equal(show(run(at("|"), paste(""))), "|");
  const result = applyInput(emptyInput(), paste("\x1b"));
  assert.equal(result.handled, true);
  assert.equal(result.state.text, "");
});

test("Up and Down move between lines by display column and are left to the caller on the first and last line", () => {
  assert.equal(show(run(at("abcdef\nxy|\nlonger line"), sp("up"))), "ab|cdef\nxy\nlonger line");
  assert.equal(show(run(at("abcdef\nxy|\nlonger line"), sp("down"))), "abcdef\nxy\nlo|nger line");
  assert.equal(show(run(at("abcdef|\nxy"), sp("down"))), "abcdef\nxy|");
  assert.equal(show(run(at("你好世|界\nabcdefgh"), sp("down"))), "你好世界\nabcdef|gh");
  assert.equal(show(run(at("abcdef\n你好世界|"), sp("up"))), "abcdef|\n你好世界");
  assert.equal(show(run(at("abcde|\n你好世界"), sp("down"))), "abcde\n你好|世界");
  assert.equal(show(run(at("\n|x"), sp("up"))), "|\nx");

  const first = applyInput(at("abc|\ndef"), sp("up"));
  assert.equal(first.handled, false);
  assert.deepEqual(first.state, at("abc|\ndef"));
  assert.equal(applyInput(at("abc\nde|f"), sp("down")).handled, false);
  assert.equal(applyInput(at("a|"), sp("down")).handled, false);
  assert.equal(applyInput(at("|a"), sp("up")).handled, false);
});

test("keys the box does not use are reported as not handled", () => {
  const state = at("ab|c");
  for (const event of [sp("escape"), sp("tab"), sp("backtab", { shift: true }), sp("pageup"), sp("pagedown"), sp("insert"), ch("c", { ctrl: true }), ch("d", { ctrl: true }), ch("x", { alt: true })]) {
    const result = applyInput(state, event);
    assert.equal(result.handled, false, JSON.stringify(event));
    assert.equal(result.submit, null);
    assert.deepEqual(result.state, state);
  }
  for (const event of [sp("left"), sp("right"), sp("home"), sp("end"), sp("backspace"), sp("delete"), ch("x")]) {
    assert.equal(applyInput(state, event).handled, true, JSON.stringify(event));
  }
});

test("layoutInput wraps by display width, keeps the cursor visible and shows at most maxRows rows", () => {
  assert.deepEqual(layoutInput(emptyInput(), 10, 6), { rows: [""], cursorRow: 0, cursorCol: 0 });

  // 汉字 2 列：8 列宽放 4 个汉字
  const wrapped = layoutInput(typed("你好世界你好"), 8, 6);
  assert.deepEqual(wrapped.rows, ["你好世界", "你好"]);
  assert.deepEqual([wrapped.cursorRow, wrapped.cursorCol], [1, 4]);

  // 宽字符放不下一行剩下的 1 列时整个折到下一行
  const narrow = layoutInput(typed("a你好"), 4, 6);
  assert.deepEqual(narrow.rows, ["a你", "好"]);
  assert.deepEqual([narrow.cursorRow, narrow.cursorCol], [1, 2]);

  // 光标正好在占满的一行末尾：放到下一行行首
  const full = layoutInput(typed("abcd"), 4, 6);
  assert.deepEqual(full.rows, ["abcd", ""]);
  assert.deepEqual([full.cursorRow, full.cursorCol], [1, 0]);
  const fullMiddle = layoutInput(at("abcd|ef"), 4, 6);
  assert.deepEqual(fullMiddle.rows, ["abcd", "ef"]);
  assert.deepEqual([fullMiddle.cursorRow, fullMiddle.cursorCol], [1, 0]);
  const notFull = layoutInput(at("abc|"), 4, 6);
  assert.deepEqual([notFull.cursorRow, notFull.cursorCol], [0, 3]);

  // 多个逻辑行，光标在中间
  const lines = layoutInput(at("first\nse|cond\nthird"), 10, 6);
  assert.deepEqual(lines.rows, ["first", "second", "third"]);
  assert.deepEqual([lines.cursorRow, lines.cursorCol], [1, 2]);
  const blankLine = layoutInput(at("a\n|\nb"), 10, 6);
  assert.deepEqual(blankLine.rows, ["a", "", "b"]);
  assert.deepEqual([blankLine.cursorRow, blankLine.cursorCol], [1, 0]);

  // 光标在汉字后面的列
  const chinese = layoutInput(at("你好|世界"), 20, 6);
  assert.deepEqual([chinese.cursorRow, chinese.cursorCol], [0, 4]);

  // 比 maxRows 长：显示光标所在的那一段
  const text = Array.from({ length: 10 }, (_, i) => `line${i}`).join("\n");
  const atEnd = layoutInput({ text, cursor: text.length }, 20, 6);
  assert.deepEqual(atEnd.rows, ["line4", "line5", "line6", "line7", "line8", "line9"]);
  assert.deepEqual([atEnd.cursorRow, atEnd.cursorCol], [5, 5]);
  const atStart = layoutInput({ text, cursor: 0 }, 20, 6);
  assert.deepEqual(atStart.rows, ["line0", "line1", "line2", "line3", "line4", "line5"]);
  assert.deepEqual([atStart.cursorRow, atStart.cursorCol], [0, 0]);
  const middle = layoutInput({ text, cursor: text.indexOf("line7") + 2 }, 20, 6);
  assert.equal(middle.rows[middle.cursorRow], "line7");
  assert.equal(middle.cursorCol, 2);
  assert.equal(middle.rows.length, 6);

  // 折行后的行数也算；末尾那一行正好占满时光标在新起的空行里
  const longText = "你".repeat(30);
  const long = layoutInput({ text: longText, cursor: longText.length }, 10, 3);
  assert.deepEqual(long.rows, ["你你你你你", "你你你你你", ""]);
  assert.deepEqual([long.cursorRow, long.cursorCol], [2, 0]);
  const longMid = layoutInput({ text: longText, cursor: 12 }, 10, 3);
  assert.deepEqual(longMid.rows, ["你你你你你", "你你你你你", "你你你你你"]);
  assert.deepEqual([longMid.cursorRow, longMid.cursorCol], [2, 4]);
});
