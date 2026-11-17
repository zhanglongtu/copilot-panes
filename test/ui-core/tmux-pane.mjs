// 在 tmux pane 里运行的小程序，用来量 tmux 实际认的显示宽度；由 width-tmux.test.ts 和 gen-width-table.mjs 启动，不是测试文件。
//   node tmux-pane.mjs scan <out.json> [起点] [终点]  逐个码点量宽度，写出 [起点, 终点, 宽度] 的区间（跳过控制字符和代理对）
//   node tmux-pane.mjs strings <in.json> <out.json>   量 JSON 数组里每个字符串的宽度，写出同样长的数组
//   node tmux-pane.mjs serve <in.json>                逐个打印字符串，每打印一个就把 pane 标题设成 done-<序号>，再等一个按键才打印下一个
// 量法：回到行首打印字符串，再发 ESC[6n 让 tmux 回报光标列；列号减 1 就是宽度。行首没有前一个格子，所以组合字符不会和前缀粘在一起。
import { readFileSync, writeFileSync } from "node:fs";

const [mode, a, b, c] = process.argv.slice(2);
process.stdin.setRawMode(true);
process.stdin.setEncoding("utf8");

let buf = "";
let wake = null;
const reply = /\x1b\[\d+;\d+R/g;
process.stdin.on("data", (d) => {
  buf += d;
  if (wake) wake();
});
function waitFor(test) {
  return new Promise((resolve) => {
    wake = () => {
      if (test()) {
        wake = null;
        resolve();
      }
    };
    wake();
  });
}
const replies = () => [...buf.matchAll(reply)].map((m) => Number(m[0].slice(2, -1).split(";")[1]) - 1);

async function measure(strings) {
  const out = [];
  const BATCH = 100;
  for (let i = 0; i < strings.length; i += BATCH) {
    const chunk = strings.slice(i, i + BATCH);
    buf = "";
    process.stdout.write(chunk.map((s) => "\r\x1b[K" + s + "\x1b[6n").join(""));
    await waitFor(() => replies().length >= chunk.length);
    out.push(...replies().slice(0, chunk.length));
  }
  return out;
}

if (mode === "scan") {
  const start = Number(b ?? 0);
  const end = Number(c ?? 0x10ffff);
  const cps = [];
  for (let cp = Math.max(start, 0x20); cp <= end; cp++) {
    if ((cp >= 0x7f && cp <= 0x9f) || (cp >= 0xd800 && cp <= 0xdfff)) continue;
    cps.push(cp);
  }
  const widths = await measure(cps.map((cp) => String.fromCodePoint(cp)));
  const ranges = [];
  cps.forEach((cp, i) => {
    const last = ranges[ranges.length - 1];
    if (last && last[2] === widths[i] && last[1] === cp - 1) last[1] = cp;
    else ranges.push([cp, cp, widths[i]]);
  });
  writeFileSync(a, JSON.stringify(ranges));
} else if (mode === "strings") {
  const strings = JSON.parse(readFileSync(a, "utf8"));
  writeFileSync(b, JSON.stringify(await measure(strings)));
} else if (mode === "serve") {
  const strings = JSON.parse(readFileSync(a, "utf8"));
  for (let i = 0; i < strings.length; i++) {
    buf = "";
    process.stdout.write(`\r\x1b[K${strings[i]}\x1b]2;done-${i}\x07`);
    await waitFor(() => buf.length > 0);
  }
  process.stdout.write("\x1b]2;finished\x07");
} else {
  process.stderr.write("unknown mode\n");
}
process.exit(0);
