// 终端模拟器的基准：node test/term/bench.ts
// 喂 10 万行带颜色的输出，量总用时、事件循环被占住的最长时间，以及取可见行和回滚行的用时。
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { TermView } from "../../src/term/terminal.ts";
import { TERM_SCROLLBACK_LINES } from "../../src/constants.ts";

const LINES = 100_000;

function makeOutput(lines: number): string {
  const parts: string[] = [];
  for (let i = 0; i < lines; i++) {
    parts.push(`\x1b[32mINFO\x1b[0m ${String(i).padStart(6, "0")} \x1b[1;34mprocessing\x1b[0m item \x1b[38;5;208m${i % 256}\x1b[0m of \x1b[38;2;10;200;100mtotal\x1b[0m 处理完成 ok\n`);
  }
  return parts.join("");
}

function ms(n: number): string {
  return n.toFixed(2);
}

const data = makeOutput(LINES);
const term = new TermView({ cols: 120, rows: 40, scrollback: TERM_SCROLLBACK_LINES });
const delay = monitorEventLoopDelay({ resolution: 1 });
delay.enable();

let maxBlock = 0;
let last = performance.now();
const probe = setInterval(() => {
  const now = performance.now();
  maxBlock = Math.max(maxBlock, now - last - 1);
  last = now;
}, 1);

const start = performance.now();
await term.write(data);
const feedMs = performance.now() - start;
clearInterval(probe);
delay.disable();

const timeIt = (fn: () => unknown, runs: number): { median: number; max: number } => {
  const times: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    fn();
    times.push(performance.now() - t);
  }
  times.sort((a, b) => a - b);
  return { median: times[Math.floor(runs / 2)]!, max: times[runs - 1]! };
};

const viewport = timeIt(() => term.viewport(0), 200);
const scrolled = timeIt(() => term.viewport(2000), 200);
const whole = timeIt(() => term.lines(0, term.totalLines), 5);
const found = timeIt(() => term.find("item 99999"), 5);
const plain = timeIt(() => term.plainText(), 5);

console.log(`输出 ${(data.length / 1024 / 1024).toFixed(1)} MiB，${LINES} 行，终端 120x40，回滚 ${TERM_SCROLLBACK_LINES} 行`);
console.log(`喂完用时 ${ms(feedMs)} ms；喂的过程中事件循环最长被占 ${ms(maxBlock)} ms`);
console.log(`缓冲总行数 ${term.totalLines}`);
console.log(`viewport(0) 40 行：中位 ${ms(viewport.median)} ms，最大 ${ms(viewport.max)} ms`);
console.log(`viewport(2000) 40 行：中位 ${ms(scrolled.median)} ms，最大 ${ms(scrolled.max)} ms`);
console.log(`lines(0, 全部 ${term.totalLines} 行)：中位 ${ms(whole.median)} ms`);
console.log(`find：中位 ${ms(found.median)} ms；plainText：中位 ${ms(plain.median)} ms`);
term.dispose();
