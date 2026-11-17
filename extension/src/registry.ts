// 登记记录 <dataDir>/sessions/<session ID>.json：界面靠它找到 session 和 socket。

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseRegistration, serializeRegistration } from "../../src/protocol.ts";
import type { Registration } from "../../src/protocol.ts";
import type { Clock, Timers } from "../../src/types/clock.ts";
import type { ErrorLog } from "./errors.ts";

export interface RegistrarOptions {
  /** src/paths.ts 的 registrationPath。 */
  path: string;
  /** 除 updatedAt 以外的内容；updatedAt 每次写入时取当前时刻。 */
  record: Omit<Registration, "updatedAt">;
  clock: Clock;
  timers: Timers;
  /** 心跳间隔（REGISTRATION_HEARTBEAT_MS）。 */
  heartbeatMs: number;
  errors: ErrorLog;
}

export class Registrar {
  readonly #options: RegistrarOptions;
  #heartbeat: unknown = null;
  #stopped = false;

  constructor(options: RegistrarOptions) {
    this.#options = options;
  }

  /** 原子地写一次：先写同目录的 <文件名>.<进程号>.tmp（0600），再 rename。出错记进 ErrorLog（step "registration.write"）。 */
  write(): void {
    if (this.#stopped) return;
    const { path, record, clock, errors } = this.#options;
    const tmp = `${path}.${record.extensionPid}.tmp`;
    try {
      // 同一个 session 的扩展被重新加载时，旧进程退出前的最后几次心跳不能盖掉新进程写的记录
      const current = this.#read();
      if (current && current.extensionPid !== record.extensionPid && current.startedAt > record.startedAt) return;
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(tmp, serializeRegistration({ ...record, updatedAt: clock.now() }), { mode: 0o600 });
      renameSync(tmp, path);
    } catch (e) {
      try {
        rmSync(tmp, { force: true });
      } catch {
        // 临时文件删不掉就留给清理
      }
      errors.record("registration.write", e);
    }
  }

  /** 改登记记录里的 socketPath（socket 后来才开成，或换了目录）并立刻重写。 */
  setSocketPath(socketPath: string | null): void {
    this.#options.record.socketPath = socketPath;
    this.write();
  }

  /** 立刻写一次，之后每 heartbeatMs 写一次。 */
  start(): void {
    if (this.#stopped || this.#heartbeat !== null) return;
    this.write();
    this.#heartbeat = this.#options.timers.setInterval(() => this.write(), this.#options.heartbeatMs);
  }

  /** 停掉心跳，删掉登记记录（文件已经不在不算出错）。记录已经属于另一个扩展进程（重新加载后的新进程）时不删。 */
  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    if (this.#heartbeat !== null) this.#options.timers.clearInterval(this.#heartbeat);
    this.#heartbeat = null;
    try {
      const current = this.#read();
      if (current && current.extensionPid !== this.#options.record.extensionPid) return;
      rmSync(this.#options.path, { force: true });
    } catch (e) {
      this.#options.errors.record("registration.remove", e);
    }
  }

  #read(): Registration | null {
    let text: string;
    try {
      text = readFileSync(this.#options.path, "utf8");
    } catch {
      return null;
    }
    const parsed = parseRegistration(text);
    return parsed.ok ? parsed.value : null;
  }
}
