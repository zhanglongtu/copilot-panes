// 视图测试共用的造数据函数：界面状态、名单条目、假的状态库。这个文件不是测试文件（名字不以 .test.ts 结尾）。

import type { AppState } from "../../src/types/app.ts";
import type { AgentRecord, ListEntry, StoreView, ToolItem, TranscriptItem } from "../../src/types/model.ts";

export function baseState(over: Partial<AppState> = {}): AppState {
  return {
    focus: "list",
    selected: null,
    followLatest: true,
    collapseEnded: false,
    zoom: false,
    expanded: new Set(),
    unread: new Set(),
    lastStatus: new Map(),
    drafts: new Map(),
    scroll: 0,
    notice: null,
    confirmStop: null,
    quitArmedUntil: null,
    search: null,
    overlay: "none",
    pickerIndex: 0,
    nextRequestId: 1,
    pending: new Map(),
    ...over,
  };
}

/** 一个最小的名单条目，需要的字段用 over 覆盖。 */
export function entryOf(over: Partial<ListEntry> = {}): ListEntry {
  return {
    key: "agent:a1",
    kind: "agent",
    id: "a1",
    depth: 0,
    parentKey: null,
    status: "running",
    name: "fix-login",
    model: null,
    startedAt: 0,
    elapsedMs: 0,
    tokens: null,
    step: "",
    exitCode: null,
    task: null,
    ...over,
  };
}

/** 去掉 seq 的过程记录条目（按条目种类分别去，不是对联合类型整体去）。 */
export type Item = TranscriptItem extends infer T ? (T extends unknown ? Omit<T, "seq"> : never) : never;

const seqed = (items: readonly Item[]): TranscriptItem[] => items.map((item, seq) => ({ ...item, seq }) as TranscriptItem);

/** 只有过程记录和一个子 agent 的状态库：够 agentContentLines 用。promptFoldChars 是这个子 agent 的任务说明开头可折叠的字符数。 */
export function fakeStore(items: readonly Item[], status: AgentRecord["status"] = "running", promptFoldChars?: number): StoreView {
  const transcript = seqed(items);
  const agent = { id: "a1", name: "fix-login", status, model: null, ...(promptFoldChars === undefined ? {} : { promptFoldChars }) } as unknown as AgentRecord;
  return {
    sessionId: "s1",
    version: 1,
    cwd: "/work",
    mainModel: null,
    lastEventAt: 0,
    agents: () => [agent],
    commands: () => [],
    agent: (id) => (id === "a1" ? agent : undefined),
    command: () => undefined,
    commandByShellId: () => undefined,
    transcript: (id) => (id === "a1" ? transcript : []),
  };
}

export const say = (text: string, at = 0): Item => ({ kind: "say", at, text });
export const toolItem = (over: Partial<ToolItem> = {}): Item => ({
  kind: "tool",
  at: 0,
  toolCallId: "t1",
  toolName: "view",
  args: { path: "/work/src/a.ts" },
  status: "ok",
  endedAt: 1,
  resultText: null,
  errorText: null,
  telemetry: null,
  childAgentId: null,
  ...over,
});
