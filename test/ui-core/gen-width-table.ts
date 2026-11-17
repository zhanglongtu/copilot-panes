// 重新生成 src/ui/width-table.ts：在独立的 tmux 里逐个码点量宽度，把宽度 0 和 2 的区间写成表。
// 用法：node test/ui-core/gen-width-table.ts    （升级 tmux 或 glibc 之后，width-tmux.test.ts 报不一致时运行）
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { scanCodePoints, tmuxAvailable } from "./tmux-probe.ts";

if (!tmuxAvailable()) throw new Error("tmux is required");
const version = execFileSync("tmux", ["-V"], { encoding: "utf8" }).trim();
const started = Date.now();
const ranges = await scanCodePoints();
if (ranges.some((r) => r[2] < 0 || r[2] > 2)) throw new Error("unexpected width in scan");
const flat = (width: number) => ranges.filter((r) => r[2] === width).flatMap((r) => [r[0], r[1]]);

const lines = (name: string, numbers: number[]) => {
  const rows: string[] = [];
  for (let i = 0; i < numbers.length; i += 16) rows.push("  " + numbers.slice(i, i + 16).map((n) => "0x" + n.toString(16)).join(", ") + ",");
  return `export const ${name}: readonly number[] = [\n${rows.join("\n")}\n];\n`;
};

const out = `// 由 test/ui-core/gen-width-table.ts 生成，请勿手改。
// 来源：${version}（glibc 的 wcwidth 加 tmux 自己的 utf8_force_wide 表）在 UTF-8 环境里逐个码点实测，宽度不是 1 的码点区间。
// 每两个数是一个闭区间 [起点, 终点]，从小到大排列。控制字符（U+0000–U+001F、U+007F–U+009F）和代理对不在表里，width.ts 里单独处理。
// 注意：U+200D（零宽连接符）和 U+FE0F（变体选择符 16）在表里是 0 列，但 tmux 会把它们并进前一个格子，并可能把前一个格子撑到 2 列，规则在 width.ts 的 CellMeter 里。

${lines("ZERO_WIDTH", flat(0))}
${lines("WIDE", flat(2))}`;
writeFileSync(fileURLToPath(new URL("../../src/ui/width-table.ts", import.meta.url)), out);
console.log(`wrote src/ui/width-table.ts from ${ranges.length} ranges in ${Math.round((Date.now() - started) / 1000)}s`);
