// 主题：把语义颜色换成 xterm 256 色编号，不用真彩色，因为 tmux 里 COLORTERM 常常是空的。
// 对比度：每个文字颜色在默认背景（深色按 #1C1F26、浅色按 #FAFAFA 估）和选中行底色上都不低于 4.0:1。
// 有几个颜色换成了相邻的编号才达到：深色 violetDim 97→134、redDim 131→167、red 203→210；
// 浅色 violet 61→56、violetDim 103→97、cyanDim 66→30、red 160→124。

import type { Timers } from "../types/clock.ts";
import type { Color, Rgb, Theme, ThemeName } from "../types/ui.ts";

export const THEMES: Readonly<Record<ThemeName, Theme>> = {
  dark: {
    name: "dark",
    colors: { violet: 141, violetDim: 134, cyan: 80, cyanDim: 66, orange: 215, red: 210, redDim: 167, text2: 250, grey: 244, selFocus: 237, selBlur: 236 },
  },
  light: {
    name: "light",
    colors: { violet: 56, violetDim: 97, cyan: 23, cyanDim: 30, orange: 130, red: 124, redDim: 131, text2: 238, grey: 243, selFocus: 252, selBlur: 254 },
  },
};

type Env = Readonly<Record<string, string | undefined>>;

const themeName = (value: string | undefined): ThemeName | null => {
  const v = value?.trim().toLowerCase();
  return v === "dark" || v === "light" ? v : null;
};

/** 用户明确指定的主题：--light 或 --dark（flag）优先，其次环境变量 COPILOT_PANES_THEME（dark 或 light）；都没有返回 null。 */
export function explicitTheme(flag: ThemeName | null, env: Env): Theme | null {
  const name = flag ?? themeName(env.COPILOT_PANES_THEME);
  return name === null ? null : THEMES[name];
}

/** 环境变量 COLORFGBG（"前景;背景"，rxvt 系终端设置，背景是最后一段）：背景是 7 或 15 当浅色，其他数字当深色，没有或看不懂返回 null。 */
function colorFgBg(env: Env): Theme | null {
  const parts = env.COLORFGBG?.split(";");
  const bg = parts && parts.length >= 2 ? Number(parts[parts.length - 1]) : NaN;
  if (!Number.isInteger(bg)) return null;
  return bg === 7 || bg === 15 ? THEMES.light : THEMES.dark;
}

/**
 * 不问终端、同步决定用哪套主题：--light 或 --dark 指定的优先，其次环境变量 COPILOT_PANES_THEME，
 * 再看环境变量 COLORFGBG（"前景;背景"，背景是 7 或 15 当浅色）；都没有用深色。
 * 要先问终端的背景色再决定，用 detectTheme。
 */
export function pickTheme(flag: ThemeName | null, env: Env): Theme {
  return explicitTheme(flag, env) ?? colorFgBg(env) ?? THEMES.dark;
}

/** 颜色换成终端要的值：语义名换成主题里的 256 色编号；数字和 RGB 原样返回。 */
export function resolveColor(color: Color, theme: Theme): number | Rgb {
  return typeof color === "string" ? theme.colors[color] : color;
}

// ───── 问终端背景色（OSC 11） ─────

/** 问终端要用的输入输出。stdin 必须已经是 raw 模式，否则终端的回答会被回显到屏幕上。 */
export interface BackgroundProbe {
  write(data: string): void;
  /** 订阅终端送来的数据，返回取消订阅的函数。 */
  onData(listener: (chunk: string) => void): () => void;
}

/** 问背景色（OSC 11），后面跟一个 ESC[5n：终端按顺序处理，不认 OSC 11 时只回 ESC[0n，不用等超时。 */
export const OSC11_QUERY = "\x1b]11;?\x07\x1b[5n";

/** 把一个颜色通道（1 到 4 位十六进制）换成 0 到 255。 */
const channel = (hex: string) => Math.round((parseInt(hex, 16) / (16 ** hex.length - 1)) * 255);

/** 从终端的回答里取背景色。认 `ESC ] 11 ; rgb:RRRR/GGGG/BBBB`（每个通道 1 到 4 位，结尾是 BEL 或 ESC \）和 `#RRGGBB`；认不出返回 null。 */
export function parseBackgroundReply(data: string): Rgb | null {
  const m = /\x1b\]11;(?:rgba?:([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})(?:\/[0-9a-f]{1,4})?|#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2}))(?:\x07|\x1b\\)/i.exec(data);
  if (!m) return null;
  return m[1] !== undefined
    ? { r: channel(m[1]), g: channel(m[2]!), b: channel(m[3]!) }
    : { r: channel(m[4]!), g: channel(m[5]!), b: channel(m[6]!) };
}

/** 背景色比一半亮就是浅色终端（按人眼对三原色的敏感度加权）。 */
export function themeForBackground(rgb: Rgb): Theme {
  const luminance = (0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b) / 255;
  return luminance > 0.5 ? THEMES.light : THEMES.dark;
}

/**
 * 问终端背景色：发 OSC 11 查询，timeoutMs 内收到回答就返回颜色；终端回了 ESC[0n 却没有 OSC 11 的回答
 * （不支持），或超时，返回 null。tmux 会替里面的程序回答。
 */
export function queryBackground(probe: BackgroundProbe, timers: Timers, timeoutMs = 300): Promise<Rgb | null> {
  return new Promise((resolve) => {
    let seen = "";
    let timer: unknown;
    let unsubscribe: () => void = () => {};
    const finish = (rgb: Rgb | null) => {
      timers.clearTimeout(timer);
      unsubscribe();
      resolve(rgb);
    };
    unsubscribe = probe.onData((chunk) => {
      seen += chunk;
      const rgb = parseBackgroundReply(seen);
      if (rgb) finish(rgb);
      else if (seen.includes("\x1b[0n")) finish(null);
    });
    timer = timers.setTimeout(() => finish(null), timeoutMs);
    probe.write(OSC11_QUERY);
  });
}

export interface DetectThemeOptions {
  flag: ThemeName | null;
  env: Env;
  /** 能问终端时传；不传（或 stdin 不是终端）就不问。 */
  probe?: BackgroundProbe;
  timers: Timers;
  timeoutMs?: number;
}

/**
 * 判断终端是深色还是浅色。顺序：--light 或 --dark，环境变量 COPILOT_PANES_THEME，向终端查背景色（OSC 11，带超时），
 * 环境变量 COLORFGBG，默认深色。
 */
export async function detectTheme(options: DetectThemeOptions): Promise<Theme> {
  const explicit = explicitTheme(options.flag, options.env);
  if (explicit) return explicit;
  if (options.probe) {
    const rgb = await queryBackground(options.probe, options.timers, options.timeoutMs);
    if (rgb) return themeForBackground(rgb);
  }
  return pickTheme(null, options.env);
}

