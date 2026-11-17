// 画面和输入的数据形状：样式、片段、一帧画面、主题、按键和鼠标事件、输入框状态。

// ───── 颜色和样式 ─────

/**
 * 界面自己用的颜色，按语义命名，由主题换成 xterm 256 色编号（见 src/ui/theme.ts）。
 * 色相只表示种类，只有活着的条目才带：violet 藤紫·亮、cyan 青·亮（在跑的子 agent、命令，焦点所在的半框，选中行的色块）；
 * violetDim、cyanDim 是它们的暗档（等你发话的符号、焦点不在时的半框）。orange 橙：未读的点、异常提示；
 * red、redDim 红的亮暗档（未读的失败、已读的失败）。亮度表示死活：不写颜色是一档文字（终端默认前景），
 * text2 二档，grey 三档（已结束的、模型、次要信息）。selFocus、selBlur 只用作背景：选中行在焦点在名单、在内容区时的底色。
 */
export type ColorRole =
  | "violet"
  | "cyan"
  | "orange"
  | "red"
  | "grey"
  | "violetDim"
  | "cyanDim"
  | "redDim"
  | "text2"
  | "selFocus"
  | "selBlur";

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/**
 * 颜色：语义名、xterm 256 色编号（0–255，命令自己的颜色原样传过来时用）、或 RGB（命令用真彩色时）。
 * 界面自己画的部分只用语义名；数字和 RGB 只来自终端模拟器里命令的输出。
 */
export type Color = ColorRole | number | Rgb;

/** 片段的样式。界面自己只在选中行用背景色（selFocus、selBlur），其余的 bg 只用于原样传递命令输出的颜色；不用斜体。 */
export interface Style {
  fg?: Color;
  bg?: Color;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  inverse?: boolean;
}

/** 一段同样式的文字。text 里不能有换行和控制字符。 */
export interface Span {
  text: string;
  style?: Style;
}

/** 屏幕上的一行：若干片段，从左到右。总宽度不能超过 pane 的列数（由画的一方保证）。 */
export type Line = readonly Span[];

/** 真实光标的位置，行列都从 0 起。 */
export interface Cursor {
  row: number;
  col: number;
}

/**
 * 一帧画面：由纯函数从界面状态和 pane 尺寸得出，输出层拿它和上一帧逐行比较，只重写变了的行。
 * lines 的条数等于 pane 的行数；cursor 是真实光标该放的位置（中文输入法的候选框跟着它），null 表示隐藏光标。
 */
export interface Frame {
  lines: Line[];
  cursor: Cursor | null;
}

export interface Size {
  cols: number;
  rows: number;
}

export type ThemeName = "dark" | "light";

/** 主题：每个语义颜色对应的 xterm 256 色编号。 */
export interface Theme {
  name: ThemeName;
  colors: Readonly<Record<ColorRole, number>>;
}

// ───── 输入事件 ─────

export type SpecialKey =
  | "up"
  | "down"
  | "left"
  | "right"
  | "home"
  | "end"
  | "pageup"
  | "pagedown"
  | "enter"
  | "tab"
  | "backtab"
  | "escape"
  | "backspace"
  | "delete"
  | "insert";

/**
 * 一个按键。可打印字符是 key "char"，text 是这一个字符（一个码点；中文输入法一次提交多个字时拆成多个事件）。
 * Ctrl 组合键也是 key "char"：Ctrl+C 是 { key: "char", text: "c", ctrl: true }，Ctrl+J（字节 0x0A）是 { text: "j", ctrl: true }。
 * Enter（字节 0x0D）是 key "enter"；Alt+Enter 是 { key: "enter", alt: true }。特殊键的 text 是 ""。
 */
export interface KeyEvent {
  type: "key";
  key: SpecialKey | "char";
  text: string;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
}

/** 括号粘贴模式下粘贴进来的整段文字（\r\n 和 \r 已换成 \n）。 */
export interface PasteEvent {
  type: "paste";
  text: string;
}

/** 鼠标事件（SGR 1006 格式）。row、col 从 0 起，相对整个 pane。 */
export interface MouseEvent {
  type: "mouse";
  action: "down" | "up" | "drag" | "wheelup" | "wheeldown";
  button: "left" | "middle" | "right" | null;
  row: number;
  col: number;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
}

export type InputEvent = KeyEvent | PasteEvent | MouseEvent;

// ───── 输入框 ─────

/** 输入框的状态。cursor 是 text 里的 UTF-16 下标，总在字符（字素）边界上。 */
export interface TextInputState {
  text: string;
  cursor: number;
}

// ───── 终端模拟器的只读接口 ─────

/**
 * 命令内容区要的东西：一个终端模拟器的可见部分和回滚缓冲。src/term/terminal.ts 的 TermView 实现它，
 * 视图（src/ui/views）只依赖这个接口。行号从 0 起，0 是回滚缓冲最早的一行。
 */
export interface TerminalLines {
  readonly cols: number;
  readonly rows: number;
  /** 回滚缓冲加屏幕的总行数。 */
  readonly totalLines: number;
  /** 从 start 起取 count 行（超出范围的部分不返回），每行是带样式的片段，颜色原样保留。 */
  lines(start: number, count: number): Line[];
  /** 可选。包含 query 的行号（和 lines() 同一套行号，从早到晚），不分大小写；query 为空返回 []。/ 键用。TermView 实现了它。 */
  find?(query: string): number[];
}
