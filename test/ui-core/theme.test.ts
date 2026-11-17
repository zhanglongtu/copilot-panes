import assert from "node:assert/strict";
import { test } from "node:test";
import type { Timers } from "../../src/types/clock.ts";
import type { ColorRole } from "../../src/types/ui.ts";
import {
  detectTheme,
  OSC11_QUERY,
  parseBackgroundReply,
  pickTheme,
  queryBackground,
  resolveColor,
  themeForBackground,
  THEMES,
  type BackgroundProbe,
} from "../../src/ui/theme.ts";

test("roles map to the design's 256-colour numbers in both themes; numbers and RGB pass through", () => {
  const table: Record<ColorRole, [number, number]> = {
    violet: [141, 56],
    violetDim: [134, 97],
    cyan: [80, 23],
    cyanDim: [66, 30],
    orange: [215, 130],
    red: [210, 124],
    redDim: [167, 131],
    text2: [250, 238],
    grey: [244, 243],
    selFocus: [237, 252],
    selBlur: [236, 254],
  };
  for (const [role, [dark, light]] of Object.entries(table) as [ColorRole, [number, number]][]) {
    assert.equal(resolveColor(role, THEMES.dark), dark, `dark ${role}`);
    assert.equal(resolveColor(role, THEMES.light), light, `light ${role}`);
  }
  assert.equal(resolveColor(33, THEMES.dark), 33);
  assert.deepEqual(resolveColor({ r: 1, g: 2, b: 3 }, THEMES.light), { r: 1, g: 2, b: 3 });
  assert.equal(THEMES.dark.name, "dark");
  assert.equal(THEMES.light.name, "light");
});

test("pickTheme honours --light and --dark, then COPILOT_PANES_THEME, then COLORFGBG, then defaults to dark", () => {
  assert.equal(pickTheme("light", {}).name, "light");
  assert.equal(pickTheme("dark", { COPILOT_PANES_THEME: "light", COLORFGBG: "0;15" }).name, "dark");
  assert.equal(pickTheme(null, { COPILOT_PANES_THEME: "light" }).name, "light");
  assert.equal(pickTheme(null, { COPILOT_PANES_THEME: " Dark ", COLORFGBG: "0;15" }).name, "dark");
  assert.equal(pickTheme(null, { COPILOT_PANES_THEME: "blue", COLORFGBG: "0;15" }).name, "light");
  assert.equal(pickTheme(null, { COLORFGBG: "0;15" }).name, "light");
  assert.equal(pickTheme(null, { COLORFGBG: "0;default;7" }).name, "light");
  assert.equal(pickTheme(null, { COLORFGBG: "15;0" }).name, "dark");
  assert.equal(pickTheme(null, { COLORFGBG: "garbage" }).name, "dark");
  assert.equal(pickTheme(null, {}).name, "dark");
});

test("parseBackgroundReply reads rgb: replies with 1 to 4 hex digits per channel, BEL or ST endings, and #RRGGBB", () => {
  assert.deepEqual(parseBackgroundReply("\x1b]11;rgb:1c1c/1f1f/2626\x07"), { r: 28, g: 31, b: 38 });
  assert.deepEqual(parseBackgroundReply("\x1b]11;rgb:ffff/ffff/ffff\x1b\\"), { r: 255, g: 255, b: 255 });
  assert.deepEqual(parseBackgroundReply("\x1b]11;rgb:fa/fa/fa\x07"), { r: 250, g: 250, b: 250 });
  assert.deepEqual(parseBackgroundReply("\x1b]11;rgb:0/8/f\x07"), { r: 0, g: 136, b: 255 });
  assert.deepEqual(parseBackgroundReply("\x1b]11;rgba:0000/0000/0000/ffff\x07"), { r: 0, g: 0, b: 0 });
  assert.deepEqual(parseBackgroundReply("\x1b]11;#FAFAFA\x07"), { r: 250, g: 250, b: 250 });
  assert.equal(parseBackgroundReply("\x1b]11;rgb:1c1c/1f1f"), null);
  assert.equal(parseBackgroundReply("\x1b[0n"), null);
  assert.equal(parseBackgroundReply(""), null);
});

test("themeForBackground calls bright backgrounds light and dark ones dark", () => {
  assert.equal(themeForBackground({ r: 250, g: 250, b: 250 }).name, "light");
  assert.equal(themeForBackground({ r: 28, g: 31, b: 38 }).name, "dark");
  assert.equal(themeForBackground({ r: 255, g: 0, b: 0 }).name, "dark");
  assert.equal(themeForBackground({ r: 0, g: 255, b: 0 }).name, "light");
});

/** 假的终端和定时器：记下写出的数据，让测试决定什么时候“回答”、什么时候“超时”。 */
function fakeProbe() {
  const written: string[] = [];
  const listeners = new Set<(chunk: string) => void>();
  const probe: BackgroundProbe = {
    write: (data) => void written.push(data),
    onData: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
  const timeouts: { fn: () => void; ms: number; cleared: boolean }[] = [];
  const timers: Timers = {
    setTimeout: (fn, ms) => {
      const handle = { fn, ms, cleared: false };
      timeouts.push(handle);
      return handle;
    },
    clearTimeout: (handle) => void ((handle as { cleared: boolean }).cleared = true),
    setInterval: () => undefined,
    clearInterval: () => undefined,
  };
  return { probe, timers, written, listeners, timeouts, reply: (data: string) => listeners.forEach((l) => l(data)) };
}

test("queryBackground asks with OSC 11 and understands an answer that arrives in pieces", async () => {
  const io = fakeProbe();
  const pending = queryBackground(io.probe, io.timers, 300);
  assert.deepEqual(io.written, [OSC11_QUERY]);
  assert.ok(OSC11_QUERY.startsWith("\x1b]11;?"));
  assert.equal(io.timeouts[0]!.ms, 300);
  io.reply("\x1b]11;rgb:fafa/fa");
  io.reply("fa/fafa\x07");
  assert.deepEqual(await pending, { r: 250, g: 250, b: 250 });
  assert.equal(io.listeners.size, 0);
  assert.ok(io.timeouts[0]!.cleared);
});

test("queryBackground gives up when the timer fires or when the terminal only answers the status query", async () => {
  const slow = fakeProbe();
  const timedOut = queryBackground(slow.probe, slow.timers, 300);
  slow.timeouts[0]!.fn();
  assert.equal(await timedOut, null);
  assert.equal(slow.listeners.size, 0);

  const unsupported = fakeProbe();
  const answered = queryBackground(unsupported.probe, unsupported.timers, 300);
  unsupported.reply("\x1b[0n");
  assert.equal(await answered, null);
  assert.equal(unsupported.listeners.size, 0);
});

test("detectTheme: explicit choices skip the terminal, a bright answer gives light, no answer falls back to COLORFGBG and then dark", async () => {
  const skipped = fakeProbe();
  assert.equal((await detectTheme({ flag: "dark", env: {}, probe: skipped.probe, timers: skipped.timers })).name, "dark");
  assert.equal((await detectTheme({ flag: null, env: { COPILOT_PANES_THEME: "light" }, probe: skipped.probe, timers: skipped.timers })).name, "light");
  assert.deepEqual(skipped.written, []);

  const light = fakeProbe();
  const asked = detectTheme({ flag: null, env: {}, probe: light.probe, timers: light.timers });
  light.reply("\x1b]11;rgb:ffff/ffff/ffff\x07");
  assert.equal((await asked).name, "light");

  const dark = fakeProbe();
  const askedDark = detectTheme({ flag: null, env: { COLORFGBG: "0;15" }, probe: dark.probe, timers: dark.timers });
  dark.reply("\x1b]11;rgb:1c1c/1f1f/2626\x07");
  assert.equal((await askedDark).name, "dark");

  const silent = fakeProbe();
  const fallback = detectTheme({ flag: null, env: { COLORFGBG: "0;15" }, probe: silent.probe, timers: silent.timers });
  silent.timeouts[0]!.fn();
  assert.equal((await fallback).name, "light");

  const nothing = fakeProbe();
  const defaulted = detectTheme({ flag: null, env: {}, probe: nothing.probe, timers: nothing.timers });
  nothing.timeouts[0]!.fn();
  assert.equal((await defaulted).name, "dark");

  assert.equal((await detectTheme({ flag: null, env: {}, timers: nothing.timers })).name, "dark");
});
