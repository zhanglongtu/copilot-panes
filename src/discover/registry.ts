// 读扩展写的登记记录（<dataDir>/sessions/*.json），判断哪些还有效。

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { REGISTRATION_STALE_MS } from "../constants.ts";
import { sessionsDir } from "../paths.ts";
import { parseRegistration } from "../protocol.ts";
import type { Registration } from "../protocol.ts";

/** 读 <dataDir>/sessions/ 下所有 .json 登记记录，用 protocol.ts 的 parseRegistration 解析；读不了、解析不了的跳过。目录不存在返回 []。 */
export function readRegistrations(dataDir: string): Registration[] {
  const dir = sessionsDir(dataDir);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const registrations: Registration[] = [];
  for (const name of names.sort()) {
    if (!name.endsWith(".json")) continue;
    try {
      const parsed = parseRegistration(readFileSync(join(dir, name), "utf8"));
      if (parsed.ok) registrations.push(parsed.value);
    } catch {
      // 文件正好被扩展删掉或读不了：跳过
    }
  }
  return registrations;
}

/** 登记记录有效：Copilot CLI 进程还在（isPidAlive(copilotPid)），并且 now - updatedAt 不超过 REGISTRATION_STALE_MS（20 秒）。 */
export function isRegistrationLive(registration: Registration, now: number, isPidAlive: (pid: number) => boolean): boolean {
  return now - registration.updatedAt <= REGISTRATION_STALE_MS && isPidAlive(registration.copilotPid);
}
