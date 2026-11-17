import { test } from "node:test";
import assert from "node:assert/strict";
import { chooseSession, switchNotice } from "../../src/discover/choose.ts";
import type { ChooseInput, CurrentSession, ForegroundHint, SelfLocation, SessionCandidate } from "../../src/types/session.ts";

const NOW = 1_000_000_000;
const CWD = "/work/app";

function cand(sessionId: string, over: Partial<SessionCandidate> = {}): SessionCandidate {
  return { sessionId, copilotPid: null, tmuxPane: null, cwd: null, title: null, lastEventAt: 0, registration: null, source: "lock", ...over };
}

const inTmux = (windowPanes: string[], windowCopilotPids: number[], cwd = CWD): SelfLocation => ({
  cwd,
  tmux: { paneId: "%9", windowPanes, windowCopilotPids },
});
const outsideTmux = (cwd = CWD): SelfLocation => ({ cwd, tmux: null });

function current(sessionId: string, over: Partial<CurrentSession> = {}): CurrentSession {
  return { sessionId, pinned: false, lastEventAt: 0, ...over };
}

function choose(input: Partial<ChooseInput> & Pick<ChooseInput, "candidates" | "self">) {
  return chooseSession({ explicitId: null, current: null, ...input });
}

const logHint = (copilotPid: number, sessionId: string): ForegroundHint => ({ kind: "log", copilotPid, sessionId });
const titleHint = (copilotPid: number | null, title: string): ForegroundHint => ({ kind: "title", copilotPid, title });

function picked(result: ReturnType<typeof choose>) {
  assert.equal(result.kind, "session");
  return result.kind === "session" ? result : (undefined as never);
}

// ───── 候选范围 ─────

test("an explicit session id always wins", () => {
  const candidates = [cand("a", { cwd: CWD, lastEventAt: NOW })];
  assert.deepEqual(choose({ candidates, self: outsideTmux(), explicitId: "zzz" }), { kind: "session", sessionId: "zzz", reason: "explicit", scopeBy: null, scope: ["zzz"] });
  assert.deepEqual(choose({ candidates: [], self: outsideTmux(), explicitId: "zzz", current: current("a", { pinned: true }) }), {
    kind: "session",
    sessionId: "zzz",
    reason: "explicit",
    scopeBy: null,
    scope: ["zzz"],
  });
});

test("in tmux a Copilot CLI process with three sessions and no other clue gives the one with the newest event", () => {
  const candidates = [
    cand("old", { copilotPid: 100, lastEventAt: NOW - 50_000 }),
    cand("new", { copilotPid: 100, lastEventAt: NOW - 1_000 }),
    cand("mid", { copilotPid: 100, lastEventAt: NOW - 20_000 }),
    cand("elsewhere", { copilotPid: 900, tmuxPane: "%50", cwd: CWD, lastEventAt: NOW }),
  ];
  assert.deepEqual(choose({ candidates, self: inTmux(["%1"], [100]) }), {
    kind: "session",
    sessionId: "new",
    reason: "last-event",
    scopeBy: "tmux",
    scope: ["new", "mid", "old"],
  });
});

test("in tmux a registration is also matched by its pane, and two Copilot CLI processes in the window compete on the newest event", () => {
  const candidates = [
    cand("by-pid", { copilotPid: 100, lastEventAt: NOW - 9_000 }),
    cand("by-pane", { copilotPid: 777, tmuxPane: "%1", lastEventAt: NOW - 3_000 }),
    cand("other-window", { copilotPid: 888, tmuxPane: "%40", lastEventAt: NOW }),
  ];
  const result = picked(choose({ candidates, self: inTmux(["%1", "%2"], [100]) }));
  assert.equal(result.sessionId, "by-pane");
  assert.deepEqual(result.scope, ["by-pane", "by-pid"]);

  const second = choose({ candidates: [cand("p100", { copilotPid: 100, lastEventAt: NOW - 100 }), cand("p200", { copilotPid: 200, lastEventAt: NOW - 5 })], self: inTmux(["%1", "%2"], [100, 200]) });
  assert.equal(picked(second).sessionId, "p200");
});

test("outside tmux, or with nothing in the window, the newest session with the same cwd is chosen", () => {
  const candidates = [
    cand("same-old", { cwd: CWD, lastEventAt: NOW - 10_000 }),
    cand("same-new", { cwd: CWD, lastEventAt: NOW - 2_000 }),
    cand("other-newest", { cwd: "/work/other", lastEventAt: NOW }),
    cand("no-cwd", { cwd: null, lastEventAt: NOW }),
  ];
  const expected = { kind: "session", sessionId: "same-new", reason: "last-event", scopeBy: "cwd", scope: ["same-new", "same-old"] };
  assert.deepEqual(choose({ candidates, self: outsideTmux() }), expected);
  assert.deepEqual(choose({ candidates, self: inTmux(["%1"], [4242]) }), expected);
});

test("nothing found gives none", () => {
  assert.deepEqual(choose({ candidates: [], self: outsideTmux() }), { kind: "none" });
  assert.deepEqual(choose({ candidates: [cand("x", { cwd: "/elsewhere", copilotPid: 5 })], self: inTmux(["%1"], [100]) }), { kind: "none" });
  assert.deepEqual(choose({ candidates: [cand("x", { cwd: "/elsewhere" })], self: outsideTmux(), current: current("gone") }), { kind: "none" });
});

test("a pinned session stays until it is no longer a candidate", () => {
  const self = inTmux(["%1"], [100]);
  const pinned = current("a", { pinned: true });
  const both = [cand("a", { copilotPid: 100, lastEventAt: NOW - 900_000 }), cand("b", { copilotPid: 100, lastEventAt: NOW })];
  // 手选的不被任何线索换走，包括前台线索
  assert.deepEqual(choose({ candidates: both, self, current: pinned, foreground: [logHint(100, "b")] }), { kind: "session", sessionId: "a", reason: "pinned", scopeBy: "tmux", scope: ["b", "a"] });
  // 手选的在窗口之外（范围里一个都没有）也留着，并且出现在 scope 里
  const outside = [cand("a", { copilotPid: 555, cwd: "/else", lastEventAt: NOW - 900_000 })];
  assert.deepEqual(choose({ candidates: outside, self, current: pinned }), { kind: "session", sessionId: "a", reason: "pinned", scopeBy: "cwd", scope: ["a"] });
  // 它结束后不再是候选，自动恢复成选最新的
  const afterEnd = [cand("b", { copilotPid: 100, lastEventAt: NOW })];
  assert.deepEqual(choose({ candidates: afterEnd, self, current: pinned }), { kind: "session", sessionId: "b", reason: "last-event", scopeBy: "tmux", scope: ["b"] });
  assert.deepEqual(choose({ candidates: [], self, current: pinned }), { kind: "none" });
});

// ───── 依据：前台线索、用户发言、最近有事件 ─────

test("a foreground log hint beats everything else: the newest user message and the newest event", () => {
  const candidates = [
    cand("shown", { copilotPid: 100, lastEventAt: NOW - 90_000, lastUserMessageAt: NOW - 80_000 }),
    cand("busy", { copilotPid: 100, lastEventAt: NOW, lastUserMessageAt: NOW - 5_000 }),
  ];
  const result = choose({ candidates, self: inTmux(["%1"], [100]), foreground: [logHint(100, "shown")] });
  assert.deepEqual(result, { kind: "session", sessionId: "shown", reason: "foreground", via: "log", scopeBy: "tmux", scope: ["busy", "shown"] });
});

test("a pane title hint points to the one session whose name matches; a title shared by two sessions is not used", () => {
  const candidates = [
    cand("a", { copilotPid: 100, title: "写周报", lastEventAt: NOW, lastUserMessageAt: NOW }),
    cand("b", { copilotPid: 100, title: "tmux  面板", lastEventAt: NOW - 1_000, lastUserMessageAt: NOW - 500_000 }),
    cand("c", { copilotPid: 100, title: "tmux 面板", lastEventAt: NOW - 2_000 }),
  ];
  const self = inTmux(["%1"], [100]);
  const unique = picked(choose({ candidates, self, foreground: [titleHint(100, "写周报")] }));
  assert.deepEqual([unique.sessionId, unique.reason, unique.via], ["a", "foreground", "title"]);
  // b 和 c 重名（空白不同也算同名）：标题指不到哪一个，退回用户发言最新的 a
  const ambiguous = picked(choose({ candidates, self, foreground: [titleHint(100, "tmux 面板")] }));
  assert.deepEqual([ambiguous.sessionId, ambiguous.reason], ["a", "last-message"]);
  // 标题和任何候选都对不上
  assert.equal(picked(choose({ candidates, self, foreground: [titleHint(100, "别的")] })).reason, "last-message");
  // 标题线索只在它说的那个进程的 session 里找
  const other = [...candidates, cand("d", { copilotPid: 200, title: "tmux 面板", lastEventAt: NOW - 3_000 })];
  assert.equal(picked(choose({ candidates: other, self: inTmux(["%1"], [100, 200]), foreground: [titleHint(200, "tmux 面板")] })).sessionId, "d");
});

test("the log hint is used before the title hint; a log hint for a session outside the scope falls back to the title", () => {
  const candidates = [
    cand("a", { copilotPid: 100, title: "甲", lastEventAt: NOW }),
    cand("b", { copilotPid: 100, title: "乙", lastEventAt: NOW - 1_000 }),
  ];
  const self = inTmux(["%1"], [100]);
  assert.equal(picked(choose({ candidates, self, foreground: [titleHint(100, "甲"), logHint(100, "b")] })).sessionId, "b");
  const fallback = picked(choose({ candidates, self, foreground: [logHint(100, "not-here"), titleHint(100, "乙")] }));
  assert.deepEqual([fallback.sessionId, fallback.via], ["b", "title"]);
});

test("with several Copilot CLI processes in the window the foreground session where the user spoke last wins", () => {
  const candidates = [
    cand("left", { copilotPid: 100, lastEventAt: NOW - 1_000, lastUserMessageAt: NOW - 600_000 }),
    cand("right", { copilotPid: 200, lastEventAt: NOW - 90_000, lastUserMessageAt: NOW - 30_000 }),
    cand("right-background", { copilotPid: 200, lastEventAt: NOW, lastUserMessageAt: NOW - 700_000 }),
  ];
  const result = choose({ candidates, self: inTmux(["%1", "%2"], [100, 200]), foreground: [logHint(100, "left"), logHint(200, "right")] });
  assert.equal(picked(result).sessionId, "right");
});

test("without a foreground hint the session where the user spoke last wins, whatever the events say", () => {
  const candidates = [
    cand("quiet", { copilotPid: 100, lastEventAt: NOW - 60_000, lastUserMessageAt: NOW - 40_000 }),
    cand("busy", { copilotPid: 100, lastEventAt: NOW, lastUserMessageAt: NOW - 900_000 }),
    cand("never-spoke", { copilotPid: 100, lastEventAt: NOW - 1_000 }),
  ];
  const result = picked(choose({ candidates, self: inTmux(["%1"], [100]) }));
  assert.deepEqual([result.sessionId, result.reason], ["quiet", "last-message"]);
});

test("the session the user talks to has nothing running, another one runs three sub-agents in the background", () => {
  // 左边正在对话的 session（最后一次发言 10:53:26，事件也停在那附近）；另一个 session 的后台子 agent 一直在写事件
  const talking = cand("talking", { copilotPid: 4321, title: "整理订单页的样式", lastEventAt: Date.parse("2026-03-02T10:53:40Z"), lastUserMessageAt: Date.parse("2026-03-02T10:53:26Z") });
  const background = cand("background", { copilotPid: 4321, title: "迁移用户表并写文档", lastEventAt: Date.parse("2026-03-02T11:02:57Z"), lastUserMessageAt: Date.parse("2026-03-02T10:41:24Z") });
  const self = inTmux(["%7"], [4321]);
  const asked = (over: Partial<ChooseInput>) => picked(choose({ candidates: [background, talking], self, ...over }));

  // 前台线索指到正在对话的：选它，当前显示的是后台那个也要换过来
  const withHint = asked({ current: current("background", { lastEventAt: Date.parse("2026-03-02T11:02:57Z") }), foreground: [logHint(4321, "talking")] });
  assert.deepEqual([withHint.sessionId, withHint.reason], ["talking", "foreground"]);
  const byTitle = asked({ foreground: [titleHint(4321, "整理订单页的样式")] });
  assert.deepEqual([byTitle.sessionId, byTitle.reason], ["talking", "foreground"]);
  // 没有任何前台线索：最近一次用户发言更新的是正在对话的，不是事件最多的
  const noHint = asked({});
  assert.deepEqual([noHint.sessionId, noHint.reason], ["talking", "last-message"]);
  // 反过来：用户切到后台那个 session 看着（日志线索变了），就跟过去
  const switched = asked({ current: current("talking"), foreground: [logHint(4321, "background")] });
  assert.deepEqual([switched.sessionId, switched.reason], ["background", "foreground"]);
});

// ───── 什么时候自动换 ─────

test("when the only basis is the newest event the current session is never left", () => {
  const candidates = [cand("a", { copilotPid: 100, lastEventAt: NOW - 600_000 }), cand("b", { copilotPid: 100, lastEventAt: NOW })];
  const self = inTmux(["%1"], [100]);
  assert.deepEqual(choose({ candidates, self, current: current("a") }), { kind: "session", sessionId: "a", reason: "stay", scopeBy: "tmux", scope: ["b", "a"] });
  // 没有当前的：选最新的
  assert.equal(picked(choose({ candidates, self })).sessionId, "b");
  // 当前 session 读到的最新事件比文件修改时间更新时，只影响 scope 的顺序
  assert.deepEqual(picked(choose({ candidates, self, current: current("a", { lastEventAt: NOW + 5 }) })).scope, ["a", "b"]);
});

test("a changed foreground hint moves to the new session at once, even while the current one still has running entries", () => {
  const candidates = [cand("a", { copilotPid: 100, lastEventAt: NOW }), cand("b", { copilotPid: 100, lastEventAt: NOW - 100_000 })];
  const self = inTmux(["%1"], [100]);
  assert.equal(picked(choose({ candidates, self, current: current("a"), foreground: [logHint(100, "a")] })).sessionId, "a");
  const moved = picked(choose({ candidates, self, current: current("a"), foreground: [logHint(100, "b")] }));
  assert.deepEqual([moved.sessionId, moved.reason], ["b", "foreground"]);
});

test("without a hint the current session is left only when the user spoke in another one more recently", () => {
  const spoke = (a: number, b: number) => [cand("a", { copilotPid: 100, lastEventAt: NOW, lastUserMessageAt: a }), cand("b", { copilotPid: 100, lastEventAt: NOW - 50_000, lastUserMessageAt: b })];
  const self = inTmux(["%1"], [100]);
  const left = picked(choose({ candidates: spoke(NOW - 100_000, NOW - 1_000), self, current: current("a") }));
  assert.deepEqual([left.sessionId, left.reason], ["b", "last-message"]);
  // 同时发言（时间相同）：已经在看的不动，免得来回跳
  const tie = picked(choose({ candidates: spoke(NOW - 1_000, NOW - 1_000), self, current: current("b") }));
  assert.deepEqual([tie.sessionId, tie.reason], ["b", "last-message"]);
});

test("a current session that left the scope is replaced by the best one in it", () => {
  const candidates = [cand("moved", { copilotPid: 555, lastEventAt: NOW }), cand("here", { copilotPid: 100, lastEventAt: NOW - 90_000 })];
  const result = choose({ candidates, self: inTmux(["%1"], [100]), current: current("moved") });
  assert.deepEqual(result, { kind: "session", sessionId: "here", reason: "last-event", scopeBy: "tmux", scope: ["here"] });
});

test("the switch notice names the session and the real reason", () => {
  assert.equal(switchNotice("修登录失败", "foreground", false), "已切到「修登录失败」：左边切到了这个 session");
  assert.equal(switchNotice("甲", "last-message", false), "已切到「甲」：你刚在这个 session 里发了消息");
  assert.equal(switchNotice("乙", "last-event", true), "已切到「乙」：原来那个 session 已经结束");
  assert.equal(switchNotice("乙", "foreground", true), "已切到「乙」：原来那个 session 已经结束");
});
