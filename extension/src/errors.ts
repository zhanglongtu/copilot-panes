// 记录扩展最近一次出错，放进 tasks 消息的 error 字段，界面据此提示“扩展出错”。

import type { ExtensionError } from "../../src/protocol.ts";
import type { Clock } from "../../src/types/clock.ts";

const MAX_MESSAGE_CHARS = 500;
/** 同一条出错信息写到 stderr 的最小间隔，免得每秒失败一次的调用把 stderr 灌满。 */
const STDERR_REPEAT_MS = 60_000;

/** 把任意异常折成一行文字，最多 maxChars 个字符。 */
export function describeError(error: unknown, maxChars: number = MAX_MESSAGE_CHARS): string {
  let text: string;
  if (error instanceof Error) text = error.message || error.name;
  else if (typeof error === "object" && error !== null && typeof (error as { message?: unknown }).message === "string") {
    text = (error as { message: string }).message;
  } else {
    try {
      text = String(error);
    } catch {
      text = "无法转成文字的异常";
    }
  }
  const line = text.replace(/\s+/g, " ").trim() || "没有说明原因";
  return line.length > maxChars ? `${line.slice(0, maxChars)}…` : line;
}

/** 只留最近一次出错。错误原因折成一行。文件已经不在（ENOENT）不算出错，调用方自己决定要不要记。 */
export class ErrorLog {
  readonly #clock: Clock;
  readonly #onRecord: ((line: string) => void) | undefined;
  #last: ExtensionError | null = null;
  #lastLine = "";
  #lastLineAt = 0;

  /** onRecord 每次出错收到一行 "<step>: <原因>"（相同的行 60 秒内只给一次），用来写 stderr；它抛异常也不影响记录。 */
  constructor(clock: Clock, onRecord?: (line: string) => void) {
    this.#clock = clock;
    this.#onRecord = onRecord;
  }

  /** 记一次出错。step 是哪一步，如 "tasks.list"、"output.append"、"registration.write"、"socket.listen"。 */
  record(step: string, error: unknown): void {
    try {
      const at = this.#clock.now();
      const message = describeError(error);
      this.#last = { step, message, at };
      const line = `${step}: ${message}`;
      if (this.#onRecord && (line !== this.#lastLine || at - this.#lastLineAt >= STDERR_REPEAT_MS)) {
        this.#lastLine = line;
        this.#lastLineAt = at;
        this.#onRecord(line);
      }
    } catch {
      // 记录出错本身不能再出错
    }
  }

  /** 最近一次出错；没出过错是 null。 */
  last(): ExtensionError | null {
    return this.#last ? { ...this.#last } : null;
  }
}
