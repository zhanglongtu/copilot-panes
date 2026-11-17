// 从命令输出的一行里认出进度，名单的“最近一步”显示成“12/40 30%”。纯函数。

// 数字前面不能紧挨着字母、数字、下划线、"/"，也不能是 "x." 这样的小数点或扩展名；后面同理。
// 句子末尾的 "."（如 "Done 40/40."）后面不跟字母数字，不算被挡住。
const FRACTION = /(?<![A-Za-z0-9_/]|[A-Za-z0-9_]\.)(\d+)\/(\d+)(?![A-Za-z0-9_/]|\.[A-Za-z0-9_])/g;
// "%" 后面紧跟字母数字的（如 URL 编码 "%25"）不算。
const PERCENT = /(?<![A-Za-z0-9_/]|[A-Za-z0-9_]\.)(\d+(?:\.\d+)?)%(?![A-Za-z0-9_])/g;

/**
 * 认出进度，返回显示文字；认不出返回 null。
 * - 分数：独立的 "a/b"（前后不是数字、字母、"/" 或 "."，所以路径和日期 2026/11/16 不算），b ≥ 2 且 0 ≤ a ≤ b。
 *   句子末尾的句号（"Done 40/40."）不算 "."。
 * - 百分数：独立的 "p%"（p 是 0–100 的整数或小数）。
 * - 有多处时各取最后一处。两样都有写“a/b p%”（p 是百分数的整数部分）；只有分数写“a/b p%”，p 由 a/b 算出；只有百分数写“p%”。
 * - 取整一律向下，不四舍五入：四舍五入（Math.round）和“四舍六入五成双”都会把 99.5% 说成 100%，
 *   两种都会把 99.5% 说成 100%，而任务还没做完。
 * 例："[###-------] 12/40 30% 已用 1m20s 还要约 3m10s task_012" → "12/40 30%"；"tests/test_auth.py::x PASSED [ 30%]" → "30%"。
 */
export function extractProgress(line: string): string | null {
  let fraction: { a: number; b: number } | null = null;
  for (const match of line.matchAll(FRACTION)) {
    const a = Number(match[1]);
    const b = Number(match[2]);
    if (b >= 2 && a <= b) fraction = { a, b };
  }
  let percent: number | null = null;
  for (const match of line.matchAll(PERCENT)) {
    const p = Number(match[1]);
    if (p <= 100) percent = Math.floor(p);
  }
  if (fraction) {
    const shown = percent ?? Math.floor((fraction.a * 100) / fraction.b);
    return `${fraction.a}/${fraction.b} ${shown}%`;
  }
  return percent === null ? null : `${percent}%`;
}
