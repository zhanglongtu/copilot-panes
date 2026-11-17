// 状态机测试用的夹具和驱动：造名单条目、ViewData，一个能连续喂输入、记录动作的 Harness。
import { agentKey, commandKey } from "../../src/types/model.ts";
import type { AgentRecord, ListEntry, StoreView, TaskRef, TranscriptItem } from "../../src/types/model.ts";
import type { AppContext, AppEffect, AppInput, AppState, ViewData } from "../../src/types/app.ts";
import type { InputEvent, KeyEvent, MouseEvent, Size, SpecialKey, TerminalLines } from "../../src/types/ui.ts";
import { initialState, update } from "../../src/ui/app.ts";

let counter = 1000;

const task = (id: string, over: Partial<TaskRef> = {}): TaskRef => ({
  id,
  status: "running",
  executionMode: "background",
  canPromoteToBackground: false,
  pid: null,
  ...over,
});

/** 子 agent 条目；每次调用开始时间递增，所以后造的更新。 */
export function agent(id: string, over: Partial<ListEntry> = {}): ListEntry {
  return {
    key: agentKey(id),
    kind: "agent",
    id,
    depth: 0,
    parentKey: null,
    status: "running",
    name: id,
    model: null,
    startedAt: counter++,
    elapsedMs: 0,
    tokens: null,
    step: "",
    exitCode: null,
    task: task(id),
    ...over,
  };
}

/** 命令条目：任务 id 是 "sh-<toolCallId>"，进程号 4242。 */
export function command(id: string, over: Partial<ListEntry> = {}): ListEntry {
  return {
    key: commandKey(id),
    kind: "command",
    id,
    depth: 0,
    parentKey: null,
    status: "running",
    name: `run ${id}`,
    model: null,
    startedAt: counter++,
    elapsedMs: 0,
    tokens: null,
    step: "",
    exitCode: null,
    task: task(`sh-${id}`, { pid: 4242, canPromoteToBackground: true, executionMode: "sync" }),
    ...over,
  };
}

export function makeData(entries: readonly ListEntry[], over: Partial<ViewData> = {}): ViewData {
  return {
    now: 0,
    session: { sessionId: "s1", project: "proj", title: null },
    extension: { kind: "connected" },
    entries,
    runningCount: entries.filter((e) => e.status === "running").length,
    totalTokens: null,
    store: null,
    terminal: null,
    sessions: [],
    bellEnabled: true,
    ...over,
  };
}

/** 纯文字的假终端：texts 的每一项是一行；find 不分大小写。 */
export function fakeTerminal(texts: readonly string[], rows = 24): TerminalLines {
  return {
    cols: 80,
    rows,
    totalLines: texts.length,
    lines: (start, count) => texts.slice(start, start + count).map((t) => (t === "" ? [] : [{ text: t }])),
    find: (query) => texts.flatMap((t, i) => (t.toLowerCase().includes(query.toLowerCase()) ? [i] : [])),
  };
}

const SPECIAL: Record<string, SpecialKey> = {
  Enter: "enter",
  Esc: "escape",
  Tab: "tab",
  Up: "up",
  Down: "down",
  Left: "left",
  Right: "right",
  Home: "home",
  End: "end",
  PgUp: "pageup",
  PgDn: "pagedown",
  Backspace: "backspace",
};

/** "j"、"G"、"Enter"、"Esc"、"PgUp"、"C-c"（Ctrl+C）、"A-Enter"（Alt+Enter）。 */
export function keyEvent(name: string): KeyEvent {
  const base = { type: "key", ctrl: false, alt: false, shift: false } as const;
  if (name.startsWith("C-")) return { ...base, key: "char", text: name.slice(2), ctrl: true };
  if (name.startsWith("A-")) return { ...keyEvent(name.slice(2)), alt: true };
  const special = SPECIAL[name];
  if (special !== undefined) return { ...base, key: special, text: "" };
  return { ...base, key: "char", text: name };
}

export function mouse(action: MouseEvent["action"], row: number, col = 5): MouseEvent {
  return { type: "mouse", action, button: action === "down" ? "left" : null, row, col, ctrl: false, alt: false, shift: false };
}

/** 连续喂输入的驱动：保存状态、数据、时刻，累积所有动作。 */
export class Harness {
  state: AppState = initialState();
  effects: AppEffect[] = [];
  now = 100_000;
  size: Size = { cols: 80, rows: 24 };
  data: ViewData;

  constructor(entries: readonly ListEntry[] = [], over: Partial<ViewData> = {}) {
    this.data = makeData(entries, over);
  }

  context(): AppContext {
    return { data: { ...this.data, now: this.now }, size: this.size, now: this.now };
  }

  send(input: AppInput): AppEffect[] {
    const result = update(this.state, input, this.context());
    this.state = result.state;
    this.effects.push(...result.effects);
    return result.effects;
  }

  /** 喂数据变化：换掉名单（和其他 ViewData 字段）再发一个 data 输入。 */
  feed(entries: readonly ListEntry[], over: Partial<ViewData> = {}): AppEffect[] {
    this.data = makeData(entries, { ...this.data, ...over, entries, runningCount: entries.filter((e) => e.status === "running").length });
    return this.send({ type: "data" });
  }

  /** 依次按键，返回最后一次按键产生的动作。 */
  press(...names: string[]): AppEffect[] {
    let last: AppEffect[] = [];
    for (const name of names) last = this.send({ type: "input", event: keyEvent(name) as InputEvent });
    return last;
  }

  /** 逐个字符输入。 */
  type(text: string): void {
    for (const ch of text) this.press(ch);
  }

  mouse(action: MouseEvent["action"], row: number, col = 5): AppEffect[] {
    return this.send({ type: "input", event: mouse(action, row, col) });
  }

  advance(ms: number): void {
    this.now += ms;
    this.send({ type: "tick" });
  }

  get notice(): string | null {
    return this.state.notice?.text ?? null;
  }

  /** 最近产生的 request 动作。 */
  lastRequest(): Extract<AppEffect, { type: "request" }> | undefined {
    return this.effects.findLast((e): e is Extract<AppEffect, { type: "request" }> => e.type === "request");
  }
}

/** 只有一个子 agent 的假状态库：过程记录是 texts 里每一项一条 say。够 agentContentLines 用。 */
export function fakeAgentStore(agentId: string, texts: readonly string[]): StoreView {
  const transcript: TranscriptItem[] = texts.map((text, seq) => ({ kind: "say", seq, at: seq, text }));
  const record = { id: agentId, name: agentId, status: "running", model: null } as unknown as AgentRecord;
  return {
    sessionId: "s1",
    version: 1,
    cwd: null,
    mainModel: null,
    lastEventAt: 0,
    agents: () => [record],
    commands: () => [],
    agent: (id) => (id === agentId ? record : undefined),
    command: () => undefined,
    commandByShellId: () => undefined,
    transcript: (id) => (id === agentId ? transcript : []),
  };
}
