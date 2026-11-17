// 时钟和定时器的接口。需要时间的模块都从参数拿它们，测试换成假的（或用 node:test 的 mock.timers）。

export interface Clock {
  /** 当前时刻，Unix 毫秒。 */
  now(): number;
}

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export const realClock: Clock = { now: () => Date.now() };

/** 真的定时器。定时器都 unref，不会单独让进程不退出。 */
export const realTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms).unref(),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
  setInterval: (fn, ms) => setInterval(fn, ms).unref(),
  clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout),
};
