// 把 events.jsonl 的一行解析成事件。只读外层：type、data、agentId、timestamp；任何问题都只丢这一行。

/** 解析后的事件。 */
export interface CopilotEvent {
  type: string;
  /** data 不是对象时是 {}。 */
  data: Record<string, unknown>;
  /** 顶层 agentId；不是非空字符串时是 null（事件属于主会话）。 */
  agentId: string | null;
  /** timestamp 转成的 Unix 毫秒；解析失败是 0。 */
  at: number;
}

/**
 * 解析一行。不是 JSON、不是对象、没有字符串 type 时返回 null。字段的类型问题不在这里处理（由状态库逐个检查）。
 * 同一个事件换字段顺序、加空格、写成 \uXXXX 转义，结果相同。
 */
export function parseEventLine(line: string): CopilotEvent | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(raw) || typeof raw.type !== "string") return null;
  return {
    type: raw.type,
    data: isRecord(raw.data) ? raw.data : {},
    agentId: typeof raw.agentId === "string" && raw.agentId !== "" ? raw.agentId : null,
    at: parseTimestamp(raw.timestamp),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}(?::?\d{2})?)?/;
/**
 * ISO 8601 时间（如 "2026-11-13T06:59:07.893Z"）转成 Unix 毫秒，保留毫秒；没有时区后缀按 UTC。
 * 不是字符串或解析失败返回 0。
 */
export function parseTimestamp(value: unknown): number {
  if (typeof value !== "string") return 0;
  const match = TIMESTAMP.exec(value);
  if (!match) return 0;
  // 不缓存换算结果：缓存的键如果是从整行里 slice 出来的，会让整个读入块一直留在内存里
  const seconds = toEpochSeconds(match);
  if (Number.isNaN(seconds)) return 0;
  const millis = match[7] ? Number(match[7].slice(0, 3).padEnd(3, "0")) : 0;
  return (seconds - zoneOffsetSeconds(match[8])) * 1000 + millis;
}

function toEpochSeconds(match: RegExpExecArray): number {
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return NaN;
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return NaN;
  return date.getTime() / 1000;
}

function zoneOffsetSeconds(zone: string | undefined): number {
  if (!zone || zone === "Z") return 0;
  const sign = zone.startsWith("-") ? -1 : 1;
  const digits = zone.slice(1).replace(":", "");
  const hours = Number(digits.slice(0, 2));
  const minutes = digits.length > 2 ? Number(digits.slice(2, 4)) : 0;
  return sign * (hours * 3600 + minutes * 60);
}
