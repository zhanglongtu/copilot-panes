// 名单里用时和 token 的写法。纯函数。用时 "48s"、"1m29s"，token "40.9万"。两列都最多 5、6 列宽。

const pad2 = (n: number) => String(n).padStart(2, "0");

/**
 * 用时，最多 5 列：不到 1 分钟写 "Ns"（0s–59s）；不到 10 分钟写 "MmSSs"（"1m29s"，秒补成两位）；不到 1 小时写 "MMm"（"12m"）；
 * 不到 10 小时写 "HhMMm"（"1h02m"）；再长写 "HHh"。负数当 0。毫秒向下取整到秒。
 */
export function formatDuration(ms: number): string {
  const s = Number.isFinite(ms) ? Math.floor(Math.max(0, ms) / 1000) : 0;
  if (s < 60) return `${s}s`;
  if (s < 600) return `${Math.floor(s / 60)}m${pad2(s % 60)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 36000) return `${Math.floor(s / 3600)}h${pad2(Math.floor((s % 3600) / 60))}m`;
  return `${Math.floor(s / 3600)}h`;
}

const oneDecimal = (tenths: number, unit: string) => `${Math.floor(tenths / 10)}.${tenths % 10}${unit}`;

/**
 * token 数，最多 6 列：不到 1 万写整数（"9000"）；不到 100 万写一位小数加“万”（"40.9万"、"1.1万"）；不到 1 亿写整数加“万”
 * （"123万"）；不到 100 亿写一位小数加“亿”；再多写整数加“亿”。小数四舍五入（进位到下一档时按下一档写，如 999,960 写 "100万"）。
 */
export function formatTokens(n: number): string {
  const v = Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
  if (v < 10_000) return String(v);
  if (v < 1_000_000) {
    const tenths = Math.round(v / 1_000);
    if (tenths < 1000) return oneDecimal(tenths, "万");
  }
  if (v < 100_000_000) {
    const wan = Math.round(v / 10_000);
    if (wan < 10_000) return `${wan}万`;
  }
  if (v < 10_000_000_000) {
    const tenths = Math.round(v / 10_000_000);
    if (tenths < 1000) return oneDecimal(tenths, "亿");
  }
  return `${Math.round(v / 100_000_000)}亿`;
}

/**
 * 只是下限的 token 数（名单里 ≥ 开头），最多 6 列，和 formatTokens 一样的单位但向下取，免得写出比实际还大的数：
 * 不到 1 万写整数；不到 10 万一位小数加“万”；不到 1000 万整数加“万”；不到 10 亿一位小数加“亿”（1000 万起写 0.1亿）；再多整数加“亿”。
 */
export function formatTokensAtLeast(n: number): string {
  const v = Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
  const oneDecimal = (unit: number) => {
    const tenths = Math.floor(v / (unit / 10));
    return `${Math.floor(tenths / 10)}.${tenths % 10}`;
  };
  if (v < 10_000) return `≥${v}`;
  if (v < 100_000) return `≥${oneDecimal(10_000)}万`;
  if (v < 10_000_000) return `≥${Math.floor(v / 10_000)}万`;
  if (v < 1_000_000_000) return `≥${oneDecimal(100_000_000)}亿`;
  return `≥${Math.floor(v / 100_000_000)}亿`;
}
