#!/usr/bin/env python3
"""把 `tmux capture-pane -e -p` 读出来的带颜色文字画成 PNG，用来亲眼看界面的颜色。

用法：
  tmux -L cp-visual capture-pane -e -p -N > screen.ans
  python3 scripts/dev/ansi2png.py screen.ans screen.png [--theme dark|light] [--cols 110] [--rows 40]
  字体找不到时用 --latin-font、--latin-bold-font、--cjk-font、--cjk-bold-font（和 --cjk-index）指定文件。

认的控制码：SGR（重置、粗体、暗、反显、前景和背景的 16 色、256 色、真彩色、默认色）；其余控制码丢掉。
抓屏要加 -N：不加的话 tmux 会去掉行尾的空格，选中行行尾铺的底色就丢了。
一格一格地画：汉字等宽字符占两格，框线、色块（│┃─━┌┏├┠▌█ 等）和盲文点（转动的符号）自己画，这样行与行之间不留缝，
也不依赖字体有没有这些字。
需要 Pillow（python3 -c "import PIL"）。字体：西文用 DejaVu Sans Mono，中日韩文字用 Noto Sans Mono CJK SC；
先问 fontconfig（fc-match），再试几个常见的安装路径，都找不到就报错并说明怎么指定。
"""

import argparse
import re
import subprocess
import sys
import unicodedata
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

# 每种字体：fontconfig 的字体族名，和 fc-match 不可用时试的常见路径（文件, 集合里的序号）。
FONT_SPECS = {
    "latin": {
        "family": "DejaVu Sans Mono",
        False: [("/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf", 0), ("/usr/share/fonts/dejavu/DejaVuSansMono.ttf", 0), ("/Library/Fonts/DejaVuSansMono.ttf", 0)],
        True: [("/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf", 0), ("/usr/share/fonts/dejavu/DejaVuSansMono-Bold.ttf", 0), ("/Library/Fonts/DejaVuSansMono-Bold.ttf", 0)],
    },
    "cjk": {
        "family": "Noto Sans Mono CJK SC",
        False: [("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc", 7), ("/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc", 7)],
        True: [("/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc", 7), ("/usr/share/fonts/noto-cjk/NotoSansCJK-Bold.ttc", 7)],
    },
}

THEMES = {
    "dark": {"bg": (0x1C, 0x1F, 0x26), "fg": (0xE6, 0xE6, 0xE6)},
    "light": {"bg": (0xFA, 0xFA, 0xFA), "fg": (0x1F, 0x23, 0x28)},
}

ANSI16 = [
    (0, 0, 0), (205, 0, 0), (0, 205, 0), (205, 205, 0), (0, 0, 238), (205, 0, 205), (0, 205, 205), (229, 229, 229),
    (127, 127, 127), (255, 0, 0), (0, 255, 0), (255, 255, 0), (92, 92, 255), (255, 0, 255), (0, 255, 255), (255, 255, 255),
]
CUBE = [0, 95, 135, 175, 215, 255]

FONT_SIZE = 16
CJK_SIZE = 18
CELL_W = 10
CELL_H = 21
PAD = 10


def xterm_rgb(n):
    if n < 16:
        return ANSI16[n]
    if n >= 232:
        v = 8 + 10 * (n - 232)
        return (v, v, v)
    n -= 16
    return (CUBE[n // 36], CUBE[(n // 6) % 6], CUBE[n % 6])


class Cell:
    __slots__ = ("ch", "fg", "bg", "bold", "dim", "inverse", "wide_tail")

    def __init__(self, ch=" ", fg=None, bg=None, bold=False, dim=False, inverse=False, wide_tail=False):
        self.ch, self.fg, self.bg, self.bold, self.dim, self.inverse, self.wide_tail = ch, fg, bg, bold, dim, inverse, wide_tail


def char_width(ch):
    if unicodedata.combining(ch):
        return 0
    return 2 if unicodedata.east_asian_width(ch) in ("W", "F") else 1


SGR = re.compile(r"\x1b\[([0-9;:]*)m")
OTHER_ESC = re.compile(r"\x1b(\[[0-9;:?]*[ -/]*[@-~]|\][^\x07\x1b]*(\x07|\x1b\\)|[()][A-Za-z0-9])")


def apply_sgr(params, state):
    codes = [int(p) if p else 0 for p in re.split(r"[;:]", params)] if params else [0]
    i = 0
    while i < len(codes):
        c = codes[i]
        if c == 0:
            state.update(fg=None, bg=None, bold=False, dim=False, inverse=False)
        elif c == 1:
            state["bold"] = True
        elif c == 2:
            state["dim"] = True
        elif c == 22:
            state["bold"] = state["dim"] = False
        elif c == 7:
            state["inverse"] = True
        elif c == 27:
            state["inverse"] = False
        elif 30 <= c <= 37:
            state["fg"] = xterm_rgb(c - 30)
        elif 90 <= c <= 97:
            state["fg"] = xterm_rgb(c - 90 + 8)
        elif 40 <= c <= 47:
            state["bg"] = xterm_rgb(c - 40)
        elif 100 <= c <= 107:
            state["bg"] = xterm_rgb(c - 100 + 8)
        elif c == 39:
            state["fg"] = None
        elif c == 49:
            state["bg"] = None
        elif c in (38, 48):
            key = "fg" if c == 38 else "bg"
            if i + 1 < len(codes) and codes[i + 1] == 5 and i + 2 < len(codes):
                state[key] = xterm_rgb(codes[i + 2])
                i += 2
            elif i + 1 < len(codes) and codes[i + 1] == 2 and i + 4 < len(codes):
                state[key] = tuple(codes[i + 2 : i + 5])
                i += 4
        i += 1


def parse(text):
    rows = []
    # tmux 只在颜色变了才写控制码，所以一行的样式要接着上一行的末尾
    state = dict(fg=None, bg=None, bold=False, dim=False, inverse=False)
    for raw in text.rstrip("\n").split("\n"):
        cells = []
        pos = 0
        while pos < len(raw):
            m = SGR.match(raw, pos)
            if m:
                apply_sgr(m.group(1), state)
                pos = m.end()
                continue
            m = OTHER_ESC.match(raw, pos)
            if m:
                pos = m.end()
                continue
            ch = raw[pos]
            pos += 1
            if ch == "\r":
                continue
            w = char_width(ch)
            if w == 0:
                continue
            cells.append(Cell(ch, state["fg"], state["bg"], state["bold"], state["dim"], state["inverse"]))
            if w == 2:
                cells.append(Cell("", state["fg"], state["bg"], state["bold"], state["dim"], state["inverse"], wide_tail=True))
        rows.append(cells)
    return rows


def fc_match(family, bold):
    """用 fontconfig 找字体，返回 (文件, 序号)；没有 fc-match，或它回了别的字体族（没装这个字体）时返回 None。"""
    pattern = f"{family}:bold" if bold else family
    try:
        out = subprocess.run(["fc-match", "-f", "%{file}\n%{index}\n%{family}", pattern], capture_output=True, text=True, timeout=10, check=True).stdout
    except (OSError, subprocess.SubprocessError):
        return None
    parts = out.split("\n")
    if len(parts) < 3 or family.lower() not in parts[2].lower():
        return None
    return parts[0], int(parts[1] or 0)


def find_font(kind, bold, given, given_index):
    """字体文件的位置：命令行给的优先，再问 fontconfig，最后试常见路径。找不到就退出并说明怎么指定。"""
    spec = FONT_SPECS[kind]
    if given:
        if not Path(given).exists():
            sys.exit(f"字体文件不存在：{given}")
        return given, given_index if given_index is not None else 0
    found = fc_match(spec["family"], bold)
    if found:
        return found
    for path, index in spec[bold]:
        if Path(path).exists():
            return path, index
    option = f"--{kind}-{'bold-' if bold else ''}font"
    sys.exit(f"找不到字体 {spec['family']}（{'粗体' if bold else '常规'}）。请安装它，或者用 {option} 指定一个等宽字体文件。")


def load_fonts(args):
    fonts = {}
    for bold in (False, True):
        latin_path, latin_index = find_font("latin", bold, args.latin_bold_font if bold else args.latin_font, None)
        cjk_path, cjk_index = find_font("cjk", bold, args.cjk_bold_font if bold else args.cjk_font, args.cjk_index)
        fonts[("latin", bold)] = ImageFont.truetype(latin_path, FONT_SIZE, index=latin_index)
        fonts[("cjk", bold)] = ImageFont.truetype(cjk_path, CJK_SIZE, index=cjk_index)
    return fonts


_glyph_cache = {}


def has_glyph(font, ch):
    key = (id(font), ch)
    if key not in _glyph_cache:
        missing = font.getmask("\uffff")
        mask = font.getmask(ch)
        _glyph_cache[key] = bool(mask.getbbox()) and bytes(mask) != bytes(missing)
    return _glyph_cache[key]


def blend(fg, bg, k):
    return tuple(round(f * k + b * (1 - k)) for f, b in zip(fg, bg))


LIGHT = max(1, round(CELL_H / 14))
HEAVY = max(2, round(CELL_H / 7))

# 框线：每个字符是 (左, 右, 上, 下) 四个方向各是没有 0、细线 1、粗线 2
BOX = {
    "─": (1, 1, 0, 0), "━": (2, 2, 0, 0), "│": (0, 0, 1, 1), "┃": (0, 0, 2, 2),
    "┌": (0, 1, 0, 1), "┏": (0, 2, 0, 2), "├": (0, 1, 1, 1), "┠": (0, 1, 2, 2),
    "└": (0, 1, 1, 0), "┗": (0, 2, 2, 0), "┐": (1, 0, 0, 1), "┘": (1, 0, 1, 0),
    "┤": (1, 0, 1, 1), "┬": (1, 1, 0, 1), "┴": (1, 1, 1, 0), "┼": (1, 1, 1, 1),
}


def draw_box(draw, x, y, w, h, spec, color):
    left, right, up, down = spec
    cx, cy = x + w // 2, y + h // 2
    thick = lambda t: HEAVY if t == 2 else LIGHT
    vt = max(thick(up), thick(down)) if (up or down) else 0
    ht = max(thick(left), thick(right)) if (left or right) else 0
    if left:
        t = thick(left)
        draw.rectangle([x, cy - t // 2, cx + vt // 2, cy - t // 2 + t - 1], fill=color)
    if right:
        t = thick(right)
        draw.rectangle([cx - vt // 2, cy - t // 2, x + w - 1, cy - t // 2 + t - 1], fill=color)
    if up:
        t = thick(up)
        draw.rectangle([cx - t // 2, y, cx - t // 2 + t - 1, cy + ht // 2], fill=color)
    if down:
        t = thick(down)
        draw.rectangle([cx - t // 2, cy - ht // 2, cx - t // 2 + t - 1, y + h - 1], fill=color)


BLOCKS = {
    "▌": (0.0, 0.0, 0.5, 1.0), "▐": (0.5, 0.0, 1.0, 1.0), "█": (0.0, 0.0, 1.0, 1.0),
    "▀": (0.0, 0.0, 1.0, 0.5), "▄": (0.0, 0.5, 1.0, 1.0),
}


# 盲文点的位置（列, 行）：U+2800 加上的位 0x01 到 0x80 依次是 (0,0) (0,1) (0,2) (1,0) (1,1) (1,2) (0,3) (1,3)
BRAILLE_DOTS = [(0, 0), (0, 1), (0, 2), (1, 0), (1, 1), (1, 2), (0, 3), (1, 3)]


def draw_braille(draw, x, y, w, h, bits, color):
    radius = max(1.0, w / 7.0)
    top = y + h * 0.2
    step = h * 0.6 / 3
    for i, (col, row) in enumerate(BRAILLE_DOTS):
        if bits & (1 << i):
            cx = x + w * (0.3 if col == 0 else 0.7)
            cy = top + row * step
            draw.ellipse([cx - radius, cy - radius, cx + radius, cy + radius], fill=color)


def render(rows, theme, fonts, cols=None, nrows=None):
    colors = THEMES[theme]
    ncols = cols or max((len(r) for r in rows), default=1)
    nrows = nrows or len(rows)
    img = Image.new("RGB", (ncols * CELL_W + 2 * PAD, nrows * CELL_H + 2 * PAD), colors["bg"])
    draw = ImageDraw.Draw(img)
    for r in range(nrows):
        cells = rows[r] if r < len(rows) else []
        y = PAD + r * CELL_H
        cells = cells[:ncols]
        look = []
        for cell in cells:
            fg = cell.fg or colors["fg"]
            bg = cell.bg or colors["bg"]
            if cell.inverse:
                fg, bg = bg, fg
            look.append((fg, bg))
        # 先画整行的底色，再画字：汉字占两格，后一格的底色不能盖住前一格画的字
        for c, (fg, bg) in enumerate(look):
            if bg != colors["bg"]:
                x = PAD + c * CELL_W
                draw.rectangle([x, y, x + CELL_W - 1, y + CELL_H - 1], fill=bg)
        for c, cell in enumerate(cells):
            fg, bg = look[c]
            if cell.wide_tail or cell.ch in (" ", ""):
                continue
            x = PAD + c * CELL_W
            if cell.dim:
                fg = blend(fg, bg, 0.6)
            ch = cell.ch
            if ch in BOX:
                draw_box(draw, x, y, CELL_W, CELL_H, BOX[ch], fg)
            elif "\u2800" <= ch <= "\u28ff":
                draw_braille(draw, x, y, CELL_W, CELL_H, ord(ch) - 0x2800, fg)
            elif ch in BLOCKS:
                x0, y0, x1, y1 = BLOCKS[ch]
                draw.rectangle([x + round(x0 * CELL_W), y + round(y0 * CELL_H), x + round(x1 * CELL_W) - 1, y + round(y1 * CELL_H) - 1], fill=fg)
            else:
                wide = char_width(ch) == 2
                latin = fonts[("latin", cell.bold)]
                font = fonts[("cjk", cell.bold)] if wide or not has_glyph(latin, ch) else latin
                width = CELL_W * (2 if wide else 1)
                box = font.getbbox(ch, anchor="ls")
                tx = x + (width - (box[2] - box[0])) / 2 - box[0] if font is not latin else x
                draw.text((tx, y + round(CELL_H * 0.76)), ch, font=font, fill=fg, anchor="ls")
    return img


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("input", help="capture-pane -e -p 的输出文件")
    parser.add_argument("output", help="PNG 文件")
    parser.add_argument("--theme", choices=sorted(THEMES), default="dark", help="终端默认背景和前景：dark 是 #1C1F26，light 是 #FAFAFA")
    parser.add_argument("--cols", type=int, help="画几列（默认取最宽的一行）")
    parser.add_argument("--rows", type=int, help="画几行（默认取行数）")
    parser.add_argument("--latin-font", help="西文常规字体文件（默认：DejaVu Sans Mono）")
    parser.add_argument("--latin-bold-font", help="西文粗体字体文件")
    parser.add_argument("--cjk-font", help="中日韩常规字体文件（默认：Noto Sans Mono CJK SC）")
    parser.add_argument("--cjk-bold-font", help="中日韩粗体字体文件")
    parser.add_argument("--cjk-index", type=int, help="中日韩字体文件是 .ttc 集合时，用第几个字体（Noto CJK 的 Mono SC 是 7）")
    args = parser.parse_args()
    with open(args.input, encoding="utf-8") as f:
        rows = parse(f.read())
    if not rows:
        sys.exit("输入是空的")
    render(rows, args.theme, load_fonts(args), args.cols, args.rows).save(args.output)


if __name__ == "__main__":
    main()
