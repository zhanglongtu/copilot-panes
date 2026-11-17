import assert from "node:assert/strict";
import { test } from "node:test";
import type { InputEvent, KeyEvent, MouseEvent, SpecialKey } from "../../src/types/ui.ts";
import { InputParser, MAX_PASTE_CHARS } from "../../src/ui/keys.ts";

const key = (k: SpecialKey | "char", text = "", mods: Partial<Pick<KeyEvent, "ctrl" | "alt" | "shift">> = {}): KeyEvent => ({
  type: "key",
  key: k,
  text,
  ctrl: false,
  alt: false,
  shift: false,
  ...mods,
});
const mouse = (action: MouseEvent["action"], button: MouseEvent["button"], row: number, col: number, mods: Partial<Pick<MouseEvent, "ctrl" | "alt" | "shift">> = {}): MouseEvent => ({
  type: "mouse",
  action,
  button,
  row,
  col,
  ctrl: false,
  alt: false,
  shift: false,
  ...mods,
});

const parse = (data: string): InputEvent[] => new InputParser().feed(data);

test("printable characters including Chinese become one key event each", () => {
  assert.deepEqual(parse("a"), [key("char", "a")]);
  assert.deepEqual(parse("你好世界"), ["你", "好", "世", "界"].map((c) => key("char", c)));
  assert.deepEqual(parse("a你b"), [key("char", "a"), key("char", "你"), key("char", "b")]);
  assert.deepEqual(parse("😀"), [key("char", "😀")]);
  assert.deepEqual(parse("，。"), [key("char", "，"), key("char", "。")]);
  assert.deepEqual(parse(" "), [key("char", " ")]);
});

test("Enter, Tab, Backspace, Ctrl+letters and Ctrl+J are told apart", () => {
  assert.deepEqual(parse("\r"), [key("enter")]);
  assert.deepEqual(parse("\t"), [key("tab")]);
  assert.deepEqual(parse("\x7f"), [key("backspace")]);
  assert.deepEqual(parse("\x08"), [key("backspace")]);
  assert.deepEqual(parse("\n"), [key("char", "j", { ctrl: true })]);
  assert.deepEqual(parse("\x01\x03\x0b\x15\x17"), ["a", "c", "k", "u", "w"].map((c) => key("char", c, { ctrl: true })));
  assert.deepEqual(parse("\x1a"), [key("char", "z", { ctrl: true })]);
  assert.deepEqual(parse("\x00"), [key("char", " ", { ctrl: true })]);
  assert.deepEqual(parse("\x1c"), []);
});

test("arrow, Home, End, PgUp, PgDn, Delete and modified arrows are recognised in both CSI and SS3 forms", () => {
  const plain: [string, SpecialKey][] = [
    ["\x1b[A", "up"], ["\x1b[B", "down"], ["\x1b[C", "right"], ["\x1b[D", "left"],
    ["\x1bOA", "up"], ["\x1bOB", "down"], ["\x1bOC", "right"], ["\x1bOD", "left"],
    ["\x1b[H", "home"], ["\x1b[F", "end"], ["\x1bOH", "home"], ["\x1bOF", "end"],
    ["\x1b[1~", "home"], ["\x1b[4~", "end"], ["\x1b[7~", "home"], ["\x1b[8~", "end"],
    ["\x1b[5~", "pageup"], ["\x1b[6~", "pagedown"], ["\x1b[2~", "insert"], ["\x1b[3~", "delete"],
  ];
  for (const [seq, name] of plain) assert.deepEqual(parse(seq), [key(name)], JSON.stringify(seq));

  assert.deepEqual(parse("\x1b[1;5A"), [key("up", "", { ctrl: true })]);
  assert.deepEqual(parse("\x1b[1;3C"), [key("right", "", { alt: true })]);
  assert.deepEqual(parse("\x1b[1;2D"), [key("left", "", { shift: true })]);
  assert.deepEqual(parse("\x1b[1;6B"), [key("down", "", { ctrl: true, shift: true })]);
  assert.deepEqual(parse("\x1b[3;5~"), [key("delete", "", { ctrl: true })]);
  assert.deepEqual(parse("\x1b[5;3~"), [key("pageup", "", { alt: true })]);
  assert.deepEqual(parse("\x1b[Z"), [key("backtab", "", { shift: true })]);
  assert.deepEqual(parse("\x1b[A\x1b[B\x1b[C"), [key("up"), key("down"), key("right")]);
  assert.deepEqual(parse("\x1b[Ax你"), [key("up"), key("char", "x"), key("char", "你")]);
});

test("Alt+key and Alt+Enter come from ESC followed by a character; a lone ESC waits for flush()", () => {
  assert.deepEqual(parse("\x1bb"), [key("char", "b", { alt: true })]);
  assert.deepEqual(parse("\x1b你"), [key("char", "你", { alt: true })]);
  assert.deepEqual(parse("\x1b\r"), [key("enter", "", { alt: true })]);
  assert.deepEqual(parse("\x1b\x7f"), [key("backspace", "", { alt: true })]);
  assert.deepEqual(parse("\x1b\x01"), [key("char", "a", { ctrl: true, alt: true })]);
  assert.deepEqual(parse("\x1b[13;3u"), [key("enter", "", { alt: true })]);
  assert.deepEqual(parse("\x1b[27;3;13~"), [key("enter", "", { alt: true })]);
  assert.deepEqual(parse("\x1b[13;2u"), [key("enter", "", { shift: true })]);
  assert.deepEqual(parse("\x1b[97;5u"), [key("char", "a", { ctrl: true })]);

  const p = new InputParser();
  assert.deepEqual(p.feed("\x1b"), []);
  assert.equal(p.hasPending, true);
  assert.deepEqual(p.flush(), [key("escape")]);
  assert.equal(p.hasPending, false);
  assert.deepEqual(p.flush(), []);

  assert.deepEqual(p.feed("\x1b"), []);
  assert.deepEqual(p.feed("x"), [key("char", "x", { alt: true })]);
  assert.equal(p.hasPending, false);

  // 连按两次 Esc：第一个马上交出，第二个等 flush
  assert.deepEqual(p.feed("\x1b\x1b"), [key("escape")]);
  assert.deepEqual(p.flush(), [key("escape")]);

  // 半截的序列在 flush 时丢掉，不变成按键
  assert.deepEqual(p.feed("\x1b[1;"), []);
  assert.equal(p.hasPending, true);
  assert.deepEqual(p.flush(), []);
  assert.deepEqual(p.feed("a"), [key("char", "a")]);
});

test("bracketed paste becomes one paste event and a lost end marker does not swallow input forever", () => {
  assert.deepEqual(parse("\x1b[200~hello 你好\x1b[201~"), [{ type: "paste", text: "hello 你好" }]);
  assert.deepEqual(parse("\x1b[200~line1\r\nline2\rline3\nline4\x1b[201~x"), [{ type: "paste", text: "line1\nline2\nline3\nline4" }, key("char", "x")]);
  assert.deepEqual(parse("a\x1b[200~b\x1b[201~c"), [key("char", "a"), { type: "paste", text: "b" }, key("char", "c")]);
  assert.deepEqual(parse("\x1b[200~\x1b[201~"), [{ type: "paste", text: "" }]);
  // 粘贴里的转义序列和控制字符原样保留，不当按键
  assert.deepEqual(parse("\x1b[200~a\x1b[Ab\x03\x1b[201~"), [{ type: "paste", text: "a\x1b[Ab\x03" }]);

  const p = new InputParser();
  assert.deepEqual(p.feed("\x1b[200~abc"), []);
  assert.equal(p.hasPending, false);
  assert.deepEqual(p.flush(), []);
  assert.deepEqual(p.feed("def\x1b[2"), []);
  assert.equal(p.hasPending, true);
  assert.deepEqual(p.feed("01~z"), [{ type: "paste", text: "abcdef" }, key("char", "z")]);

  const lost = new InputParser();
  const events = lost.feed("\x1b[200~" + "x".repeat(MAX_PASTE_CHARS + 5));
  assert.equal(events.length, 1);
  assert.equal(events[0]!.type, "paste");
  assert.ok((events[0] as { text: string }).text.length > MAX_PASTE_CHARS);
  assert.deepEqual(lost.feed("b"), [key("char", "b")]);
});

test("SGR mouse press, release, drag and wheel become 0-based mouse events", () => {
  assert.deepEqual(parse("\x1b[<0;10;5M"), [mouse("down", "left", 4, 9)]);
  assert.deepEqual(parse("\x1b[<0;10;5m"), [mouse("up", "left", 4, 9)]);
  assert.deepEqual(parse("\x1b[<1;1;1M"), [mouse("down", "middle", 0, 0)]);
  assert.deepEqual(parse("\x1b[<2;80;24M"), [mouse("down", "right", 23, 79)]);
  assert.deepEqual(parse("\x1b[<32;11;5M"), [mouse("drag", "left", 4, 10)]);
  assert.deepEqual(parse("\x1b[<35;11;5M"), [mouse("drag", null, 4, 10)]);
  assert.deepEqual(parse("\x1b[<64;3;4M"), [mouse("wheelup", null, 3, 2)]);
  assert.deepEqual(parse("\x1b[<65;3;4M"), [mouse("wheeldown", null, 3, 2)]);
  assert.deepEqual(parse("\x1b[<16;1;1M"), [mouse("down", "left", 0, 0, { ctrl: true })]);
  assert.deepEqual(parse("\x1b[<12;1;1M"), [mouse("down", "left", 0, 0, { shift: true, alt: true })]);
  assert.deepEqual(parse("\x1b[<68;1;1M"), [mouse("wheelup", null, 0, 0, { shift: true })]);
  assert.deepEqual(parse("\x1b[<66;1;1M\x1b[<64;1;1m"), []);
  assert.deepEqual(parse("\x1b[<0;10;5M\x1b[<64;3;4Mx"), [mouse("down", "left", 4, 9), mouse("wheelup", null, 3, 2), key("char", "x")]);
});

test("a sequence split across two feed() calls is still recognised", () => {
  const samples = [
    "\x1b[A", "\x1bOB", "\x1b[1;5C", "\x1b[3~", "\x1b[Z", "\x1b[<0;10;5M", "\x1b[<64;3;4M", "\x1bb", "\x1b\r", "\x1b[13;3u",
    "\x1b[200~粘贴 text\r\nmore\x1b[201~", "你好😀", "a\x1b[Dx你", "\x1b]11;rgb:1c1c/1f1f/2626\x07q", "\x1b[0n\x1b[1;2Rk",
  ];
  for (const sample of samples) {
    const whole = new InputParser();
    const expected = [...whole.feed(sample), ...whole.flush()];
    for (let cut = 1; cut < sample.length; cut++) {
      const split = new InputParser();
      const got = [...split.feed(sample.slice(0, cut)), ...split.feed(sample.slice(cut)), ...split.flush()];
      assert.deepEqual(got, expected, `${JSON.stringify(sample)} cut at ${cut}`);
    }
    const bytewise = new InputParser();
    const got: InputEvent[] = [];
    for (const unit of sample) got.push(...bytewise.feed(unit));
    got.push(...bytewise.flush());
    assert.deepEqual(got, expected, `${JSON.stringify(sample)} one character at a time`);
  }
  // 代理对被切在两个 UTF-16 单元中间
  const p = new InputParser();
  assert.deepEqual(p.feed("😀".slice(0, 1)), []);
  assert.equal(p.hasPending, true);
  assert.deepEqual(p.feed("😀".slice(1)), [key("char", "😀")]);
});

test("unknown sequences and terminal replies are dropped without producing keys", () => {
  assert.deepEqual(parse("\x1b[99;99X\x1b[5n\x1b[1;2R\x1b[?1;2cx"), [key("char", "x")]);
  assert.deepEqual(parse("\x1b]11;rgb:1c1c/1f1f/2626\x07y"), [key("char", "y")]);
  assert.deepEqual(parse("\x1b]0;title\x1b\\y"), [key("char", "y")]);
  assert.deepEqual(parse("\x1bOP\x1b[15~z"), [key("char", "z")]);
  assert.deepEqual(parse("\u009bz"), [key("char", "z")]);
  const garbage = new InputParser();
  assert.deepEqual(garbage.feed("\x1b[" + "1;".repeat(3000)), []);
  assert.equal(garbage.hasPending, false);
});
