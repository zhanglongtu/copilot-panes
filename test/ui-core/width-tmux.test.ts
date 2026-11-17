// 拿真的 tmux 核对 src/ui/width.ts：没有 tmux，或者 tmux 不是测宽度表用的版本（3.4）时跳过。tmux 开在独立的服务里（socket 名带进程号），用完关掉，不碰默认的 tmux 服务。
// 三部分：1) 一批手挑的字符串，逐个打印后用 `tmux display-message -p '#{cursor_x}'` 读光标列；
// 2) 全部 Unicode 码点，每个单独打印，读光标列，核对 charWidth；3) 几万条随机拼的字符串（汉字、表情、组合符号、ZWJ、变体选择符、国旗等），核对 textWidth。
// 升级 tmux 或 glibc 后报不一致，运行 node test/ui-core/gen-width-table.ts 重新生成宽度表，再看 width.ts 的 CellMeter 规则是否要改。
import assert from "node:assert/strict";
import { test } from "node:test";
import { charWidth, textWidth } from "../../src/ui/width.ts";
import { measureStrings, measureWithDisplayMessage, scanCodePoints, widthCheckSkipReason } from "./tmux-probe.ts";

const skip = widthCheckSkipReason();

const u = (...cps: number[]) => String.fromCodePoint(...cps);
const ZWJ = 0x200d;
const VS16 = 0xfe0f;

const CURATED: string[] = [
  "hello", "webshop  修登录失败的 bug", "你好，世界", "，。！？：；（）「」『』《》", "　", "ＡＢＣ１２３", "한글", "ひらがなカタカナ", "ｱｲｳ", "ｶﾞ",
  // 界面用到的符号，每个都要是 1 列
  "┃", "│", "▸", "›", "•", "○", "✓", "✗", "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏", "⠿", "…", "−", "↑", "↓", "┃│▸›•○✓✗⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⠿…−↑↓",
  "▶■●◆★☆→←─╭╮█░",
  // 组合字符和零宽字符
  "e\u0301", "a\u0308\u0323", "ก็", "กำ", "हिन्दी", "क्ष", "مَرْحَبًا", "a\u200bb", "a\u200db", "a\ufeffb", "\u2060", "\u0301", "x\u0301\u0301\u0301",
  u(0x1112, 0x1161, 0x11ab), u(0x845b, 0xe0100), "字\ufe0e", "字\ufe0f", "\u3099", "ab\u0301c",
  // 表情符号：宽表情、需要变体选择符才变宽的、肤色、国旗、ZWJ 序列、keycap
  "😀", "🎉", "👍", "🚀", "✅", "❌", "⚠️", "⚠", "❤️", "❤", "☺️", "☺", "1️⃣", "9️⃣", "#️⃣", "©️", "™️", "✔️", "✔", "⭐", "🔥", "⌚", "🕐", "☀️", "☀", "♥️", "▶️", "🫠", "🪿",
  "👍🏽", "🏽", "a🏽", "你🏽", "🇨🇳", "🇺🇸🇯🇵", "🇨", "🇨🇳🇺", "👨‍👩‍👧", "🏳️‍🌈", "🧑‍💻", "🤦🏽‍♂️", "👩‍❤️‍👨", "🧑🏽‍🤝‍🧑🏻", "🏴󠁧󠁢󠁥󠁮󠁧󠁿", "😀😀", "☝🏽", "☝",
  u(0x78, VS16, VS16), u(0x78, VS16, 0x1f1e8), u(0x2764, VS16, 0x1f3fd), u(0x61, ZWJ, 0x4f60), u(0x4f60, ZWJ, 0x597d), u(0x1f468, ZWJ, 0x1f468, ZWJ, 0x1f468, ZWJ, 0x1f468),
  u(0x1f1e8, 0x1f1f3, 0x1f1fa, 0x1f1f8, 0x1f1e8, 0x1f1f3), "一二三🎉四五六", "测试✅通过 ❌失败 ⚠️警告",
  // 界面里常见的名字、最近一步、用时、token 和内容行
  "find-bug", "  run-tests", "    $ pytest -v tests/", "$ python3 -u score.py --run nov15", "交回了报告", "等 run-tests 交回结果", "做完一轮，等你发话", "跑 pytest",
  "退出码 1", "12/40 30%", "▰▰▰▱▱▱▱▱▱▱ 12/40 30%", "1m29s", "40.9万", "1.1万", "≥12万",
  "任务：登录失败是因为 src/auth.ts 里的 refreshToken() 提前清空了会话。", "▸ 看  src/auth.ts 第 40 到 96 行", "清空会话的调用在第 71 行。我把它移到 logout()，再补一条测试。",
  "⠹ 等 run-tests 交回结果  48s", "[###-------] 12/40 30% 已用 1m20s 还要约 3m10s task_012", "› 插一句话给 fix-login，它做完手上这一步就会看到",
  "↑↓ 选择  Enter 进入  x 停止  z 放大  ? 帮助", "┏━ fix-login  medium-1.0  在跑 2m14s ━━━", "┌─ $ npm run build  失败（退出码 1） 12s ───", "┠─────", "├─────", "▌", "⊘", "◌", "●", "▰", "▱",
];

test("textWidth matches tmux's cursor column for hand-picked strings (display-message)", { skip, timeout: 120_000 }, async (t) => {
  const measured = await measureWithDisplayMessage(CURATED);
  const bad = CURATED.flatMap((s, i) => (textWidth(s) === measured[i] ? [] : [`${JSON.stringify(s)}: tmux ${measured[i]}, ours ${textWidth(s)}`]));
  t.diagnostic(`display-message check: ${CURATED.length} strings, ${bad.length} mismatches`);
  assert.deepEqual(bad, []);
});

test("charWidth matches tmux for every Unicode code point", { skip, timeout: 180_000 }, async (t) => {
  const ranges = await scanCodePoints();
  let checked = 0;
  const bad: string[] = [];
  for (const [from, to, width] of ranges) {
    for (let cp = from; cp <= to; cp++) {
      checked++;
      if (charWidth(cp) !== width && bad.length < 20) bad.push(`U+${cp.toString(16)}: tmux ${width}, ours ${charWidth(cp)}`);
    }
  }
  t.diagnostic(`code point scan: ${checked} code points, ${ranges.length} width ranges, ${bad.length} mismatches`);
  assert.ok(checked > 1_100_000);
  assert.deepEqual(bad, []);
});

test("textWidth matches tmux for random mixes of wide, combining, joining and emoji characters", { skip, timeout: 180_000 }, async (t) => {
  const alphabet = [
    0x61, 0x20, 0x4f60, 0xac00, 0x1100, 0x1160, 0x11a8, 0xe9, 0x2192, 0x2713, 0x2764, 0xa9, 0x261d, 0x26f9, 0x2600, 0x1f600, 0x1f44d, 0x1f468, 0x1f9d1,
    0x1f3fb, 0x1f3fd, 0x1f1e8, 0x1f1f3, ZWJ, VS16, 0xfe0e, 0x301, 0x20e3, 0xe0067, 0x200b, 0x2060, 0xad, 0xff71, 0xff9e, 0x3099, 0x3000, 0x1f3f4, 0x93f, 0x915,
    0x94d, 0x80, 0x9b,
  ];
  let seed = 20260116;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const strings: string[] = [];
  for (let i = 0; i < 30_000; i++) {
    const length = i < 25_000 ? 1 + Math.floor(rnd() * 8) : 8 + Math.floor(rnd() * 12);
    let s = "";
    for (let j = 0; j < length; j++) s += String.fromCodePoint(alphabet[Math.floor(rnd() * alphabet.length)]!);
    strings.push(s);
  }
  const measured = await measureStrings(strings);
  const bad = strings.flatMap((s, i) =>
    textWidth(s) === measured[i] ? [] : [`tmux ${measured[i]}, ours ${textWidth(s)}: ${[...s].map((c) => c.codePointAt(0)!.toString(16)).join(" ")}`],
  );
  t.diagnostic(`random strings: ${strings.length} strings, ${bad.length} mismatches`);
  assert.deepEqual(bad.slice(0, 20), []);
});
