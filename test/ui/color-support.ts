// 样式测试用的颜色工具：xterm 256 色编号换成 RGB，算对比度，把一个片段的前景和背景按主题换成实际的颜色。
// 这个文件不是测试文件（名字不以 .test.ts 结尾）。

import type { Span, Theme } from "../../src/types/ui.ts";
import { resolveColor } from "../../src/ui/theme.ts";

export type Rgb = readonly [number, number, number];

const CUBE = [0, 95, 135, 175, 215, 255];
const ANSI16: Rgb[] = [
  [0, 0, 0], [205, 0, 0], [0, 205, 0], [205, 205, 0], [0, 0, 238], [205, 0, 205], [0, 205, 205], [229, 229, 229],
  [127, 127, 127], [255, 0, 0], [0, 255, 0], [255, 255, 0], [92, 92, 255], [255, 0, 255], [0, 255, 255], [255, 255, 255],
];

export function xtermRgb(n: number): Rgb {
  if (n < 16) return ANSI16[n]!;
  if (n >= 232) {
    const v = 8 + 10 * (n - 232);
    return [v, v, v];
  }
  const i = n - 16;
  return [CUBE[Math.floor(i / 36)]!, CUBE[Math.floor(i / 6) % 6]!, CUBE[i % 6]!];
}

const hex = (value: string): Rgb => [1, 3, 5].map((at) => parseInt(value.slice(at, at + 2), 16)) as unknown as Rgb;

/** 终端默认的背景和前景（取常见的估计值）。 */
export const TERMINAL_DEFAULTS = {
  dark: { bg: hex("#1C1F26"), fg: hex("#E6E6E6") },
  light: { bg: hex("#FAFAFA"), fg: hex("#1F2328") },
} as const;

function luminance([r, g, b]: Rgb): number {
  const f = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/** WCAG 的对比度，1 到 21。 */
export function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** 片段实际显示的前景和背景：语义名和编号按主题换，没写的用终端默认色。RGB 原样用。 */
export function actualColors(s: Span, theme: Theme): { fg: Rgb; bg: Rgb } {
  const defaults = TERMINAL_DEFAULTS[theme.name];
  const pick = (color: NonNullable<Span["style"]>["fg"], fallback: Rgb): Rgb => {
    if (color === undefined) return fallback;
    const c = resolveColor(color, theme);
    return typeof c === "number" ? xtermRgb(c) : ([c.r, c.g, c.b] as const);
  };
  return { fg: pick(s.style?.fg, defaults.fg), bg: pick(s.style?.bg, defaults.bg) };
}
