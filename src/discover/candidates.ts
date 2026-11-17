// 收集候选 session，以及界面自己在哪（同一个 tmux 窗口里的 Copilot CLI 进程）。这里碰文件系统和 tmux；选哪个交给 choose.ts。

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { eventsPath, sessionDir, workspacePath } from "../paths.ts";
import type { Registration } from "../protocol.ts";
import type { SelfLocation, SessionCandidate } from "../types/session.ts";
import { looksLikeCopilot, selfAndDescendants } from "./procs.ts";
import type { ProcInfo } from "./procs.ts";
import { isRegistrationLive, readRegistrations } from "./registry.ts";
import { windowPanes } from "./tmux.ts";
import type { TmuxRunner } from "./tmux.ts";

// 终端转义序列（CSI、OSC）、C0 和 C1 控制字符、方向控制符：session 名字谁都能改，原样打印到用户的终端会改鼠标模式、屏幕和标题。
const TERMINAL_CONTROL = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|[\x00-\x1f\x7f-\x9f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g;

/** YAML 顶层的一行 "key: value" 的值：去掉首尾空白和成对的引号，再去掉终端控制码；空值是 null。 */
function yamlScalar(raw: string): string | null {
  let value = raw.trim();
  if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value[value.length - 1] === value[0]) value = value.slice(1, -1);
  value = value.replace(TERMINAL_CONTROL, "").trim();
  return value === "" ? null : value;
}

/** workspace.yaml 里的 cwd 和 name（只认顶层的 "cwd: ..." 和 "name: ..." 两行，值去掉首尾空白和成对的引号）。文件不在返回两个 null。 */
export function readWorkspace(stateDir: string, sessionId: string): { cwd: string | null; name: string | null } {
  const result: { cwd: string | null; name: string | null } = { cwd: null, name: null };
  let text: string;
  try {
    text = readFileSync(workspacePath(stateDir, sessionId), "utf8");
  } catch {
    return result;
  }
  for (const line of text.split(/\r?\n/)) {
    const match = /^(cwd|name):(.*)$/.exec(line);
    if (!match) continue;
    result[match[1] as "cwd" | "name"] = yamlScalar(match[2]!);
  }
  return result;
}

const FULL_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * --session 给的 ID 可以只写前几位。session-state 下有同名目录，或给的是完整的 UUID，就原样用（不管它在不在）；
 * 否则按前缀（不分大小写）匹配 session-state 下的目录：唯一匹配用它；匹配到几个，报错并列出它们的完整 ID 和标题；一个都没有，报错。
 */
export function resolveSessionArg(stateDir: string, given: string): { ok: true; sessionId: string } | { ok: false; error: string } {
  if (existsSync(sessionDir(stateDir, given)) || FULL_SESSION_ID.test(given)) return { ok: true, sessionId: given };
  let names: string[] = [];
  try {
    names = readdirSync(stateDir);
  } catch {
    // session-state 目录不存在：下面报没有匹配的
  }
  const prefix = given.toLowerCase();
  const matches = names.filter((name) => name.toLowerCase().startsWith(prefix)).sort();
  if (matches.length === 1) return { ok: true, sessionId: matches[0]! };
  if (matches.length === 0) return { ok: false, error: `没有 ID 以 ${given} 开头的 session` };
  const lines = matches.map((name) => `  ${name}  ${readWorkspace(stateDir, name).name ?? "（没有名字）"}`);
  return { ok: false, error: `有 ${matches.length} 个 session 的 ID 以 ${given} 开头，请多写几位：\n${lines.join("\n")}` };
}

export interface ScanOptions {
  dataDir: string;
  stateDir: string;
  now: number;
  isPidAlive(pid: number): boolean;
  /** 进程表（只在退回找锁文件时用来判断进程像不像 Copilot CLI）。 */
  procTable: ReadonlyMap<number, ProcInfo>;
}

function eventsModifiedAt(stateDir: string, sessionId: string): number {
  try {
    return Math.floor(statSync(eventsPath(stateDir, sessionId)).mtimeMs);
  } catch {
    return 0;
  }
}

function makeCandidate(
  stateDir: string,
  sessionId: string,
  copilotPid: number,
  registration: Registration | null,
  source: SessionCandidate["source"],
): SessionCandidate {
  const workspace = readWorkspace(stateDir, sessionId);
  return {
    sessionId,
    copilotPid,
    tmuxPane: registration?.tmuxPane ?? null,
    cwd: workspace.cwd ?? (registration && registration.cwd !== "" ? registration.cwd : null),
    title: workspace.name,
    lastEventAt: eventsModifiedAt(stateDir, sessionId),
    registration,
    source,
  };
}

/** 某个 session 目录里 inuse.<进程号>.lock 的进程号，按从大到小排（大的通常是新起的进程）。 */
function lockPids(sessionDir: string): number[] {
  const pids: number[] = [];
  for (const name of readdirSync(sessionDir)) {
    const match = /^inuse\.(\d+)\.lock$/.exec(name);
    if (match) pids.push(Number(match[1]));
  }
  return pids.sort((a, b) => b - a);
}

/**
 * 候选 session：
 * 1. 有效的登记记录（discover/registry.ts 的 isRegistrationLive），source 为 "registration"。
 * 2. 没有有效登记记录的：<stateDir>/*\/inuse.<进程号>.lock 里，进程号活着并且 looksLikeCopilot 的，source 为 "lock"。
 * cwd、title 取 readWorkspace（cwd 读不到时用登记记录的 cwd）；lastEventAt 是 events.jsonl 的修改时间（不存在是 0）。
 * 单个 session 读出错就跳过它。结果按 lastEventAt 从新到旧排。
 */
export function scanCandidates(options: ScanOptions): SessionCandidate[] {
  const { dataDir, stateDir, now, isPidAlive, procTable } = options;
  const candidates = new Map<string, SessionCandidate>();

  for (const registration of readRegistrations(dataDir)) {
    if (!isRegistrationLive(registration, now, isPidAlive)) continue;
    try {
      candidates.set(registration.sessionId, makeCandidate(stateDir, registration.sessionId, registration.copilotPid, registration, "registration"));
    } catch {
      // 读不出来就跳过这个 session
    }
  }

  let names: string[] = [];
  try {
    names = readdirSync(stateDir);
  } catch {
    // session-state 目录不存在：没有锁文件候选
  }
  for (const sessionId of names) {
    if (candidates.has(sessionId)) continue;
    try {
      const pid = lockPids(join(stateDir, sessionId)).find((candidatePid) => {
        const info = procTable.get(candidatePid);
        return isPidAlive(candidatePid) && info !== undefined && looksLikeCopilot(info);
      });
      if (pid !== undefined) candidates.set(sessionId, makeCandidate(stateDir, sessionId, pid, null, "lock"));
    } catch {
      // 不是目录或读不了：跳过
    }
  }

  return [...candidates.values()].sort((a, b) => b.lastEventAt - a.lastEventAt || (a.sessionId < b.sessionId ? -1 : 1));
}

export interface LocateOptions {
  cwd: string;
  /** 环境变量 TMUX_PANE；不在 tmux 里（没有 TMUX 或 TMUX_PANE）是 null。 */
  tmuxPane: string | null;
  run: TmuxRunner;
  procTable: ReadonlyMap<number, ProcInfo>;
}

/**
 * 界面自己在哪。在 tmux 里时：用 windowPanes 找同一个窗口的其他 pane（不含自己），在每个 pane 的进程（panePid）和它的子孙里找
 * looksLikeCopilot 的进程，收集进程号和它们所在的 pane（panesByPid，读 pane 标题用）。tmux 出错时当作不在 tmux 里（tmux 为 null）。
 */
export async function locateSelf(options: LocateOptions): Promise<SelfLocation> {
  const { cwd, tmuxPane, run, procTable } = options;
  if (tmuxPane === null) return { cwd, tmux: null };
  const panes = await windowPanes(tmuxPane, run);
  if (panes.length === 0) return { cwd, tmux: null };
  const others = panes.filter((pane) => pane.paneId !== tmuxPane);
  const copilotPids = new Set<number>();
  const panesByPid: Record<number, string> = {};
  for (const pane of others) {
    for (const pid of selfAndDescendants(pane.panePid, procTable)) {
      const info = procTable.get(pid);
      if (info && looksLikeCopilot(info)) {
        copilotPids.add(pid);
        panesByPid[pid] ??= pane.paneId;
      }
    }
  }
  return { cwd, tmux: { paneId: tmuxPane, windowPanes: others.map((pane) => pane.paneId), windowCopilotPids: [...copilotPids], panesByPid } };
}
