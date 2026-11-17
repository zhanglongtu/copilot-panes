import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Interrupter } from "../../src/bridge/signals.ts";
import type { ProcAccess } from "../../src/bridge/signals.ts";
import { CONFIRM_WINDOW_MS, INTERRUPT_ESCALATE_MS, NOTICE_MS, QUIT_WINDOW_MS } from "../../src/constants.ts";
import type { AppEffect, InterruptSignal } from "../../src/types/app.ts";
import { agentKey, commandKey } from "../../src/types/model.ts";
import { initialState, update } from "../../src/ui/app.ts";
import { computeLayout } from "../../src/ui/views/layout.ts";
import { COMMAND_NO_INPUT_NOTICE } from "../../src/ui/views/input.ts";
import { agentContentLines, agentRowCount } from "../../src/ui/views/agent.ts";
import { matchRows } from "../../src/ui/views/content.ts";
import { Harness, agent, command, fakeAgentStore, fakeTerminal, makeData } from "./app-support.ts";
import type { StoreView } from "../../src/types/model.ts";

const types = (effects: readonly AppEffect[]) => effects.map((e) => e.type);

describe("data: selection, follow and session changes", () => {
  test("the first data selects the newest entry and marks nothing unread or rings", () => {
    const failed = agent("old", { status: "failed" });
    const h = new Harness();
    h.feed([failed, agent("mid"), agent("new")]);
    assert.equal(h.state.selected, agentKey("new"));
    assert.equal(h.state.unread.size, 0);
    assert.deepEqual(h.effects, []);
  });

  test("moving the selection stops follow-latest and f resumes it and selects the newest", () => {
    const h = new Harness();
    h.feed([agent("a"), agent("b"), agent("c")]);
    assert.equal(h.state.followLatest, true);
    h.press("j");
    assert.equal(h.state.followLatest, true, "no move, no change");
    h.press("k");
    assert.equal(h.state.selected, agentKey("b"));
    assert.equal(h.state.followLatest, false);
    h.press("g");
    assert.equal(h.state.selected, agentKey("a"));
    h.press("G");
    assert.equal(h.state.selected, agentKey("c"));
    h.press("Up", "Up");
    assert.equal(h.state.selected, agentKey("a"));
    h.press("f");
    assert.equal(h.state.followLatest, true);
    assert.equal(h.state.selected, agentKey("c"));
    h.press("f");
    assert.equal(h.state.followLatest, false);
  });

  test("a new entry is selected only while following, in the list, with no search", () => {
    const [a, b] = [agent("a"), agent("b")];
    const h = new Harness();
    h.feed([a, b]);
    const c = agent("c");
    h.feed([a, b, c]);
    assert.equal(h.state.selected, c.key, "following");

    h.press("Enter");
    const d = agent("d");
    h.feed([a, b, c, d]);
    assert.equal(h.state.selected, c.key, "focus in content: do not steal it");

    h.press("Esc", "k");
    assert.equal(h.state.followLatest, false);
    const e = agent("e");
    h.feed([a, b, c, d, e]);
    assert.equal(h.state.selected, b.key, "not following");
  });

  test("f says in plain words what it did and c says nothing; with follow off a new entry gets a notice that f jumps to it", () => {
    const [done1, done2, a] = [agent("d1", { status: "done" }), agent("d2", { status: "failed" }), agent("a")];
    const h = new Harness();
    h.feed([done1, done2, a]);
    h.press("f");
    assert.equal(h.notice, "不再自动选中新任务，按 f 恢复");
    h.press("f");
    assert.equal(h.notice, "有新任务时自动选中它");
    h.press("f");

    // 跟随关着，来了一个新任务：不抢选中，只提示
    const fresh = agent("fresh-one");
    h.feed([done1, done2, a, fresh]);
    assert.equal(h.state.selected, a.key);
    assert.equal(h.notice, "新任务 fresh-one 开始了，按 f 跳过去");
    // 一次来了几个：说名字最新的那个和个数
    const [x, y] = [agent("x"), agent("y")];
    h.feed([done1, done2, a, fresh, x, y]);
    assert.equal(h.notice, "新任务 y 等 2 个开始了，按 f 跳过去");
    // 提示的就是 f 做的事
    h.press("f");
    assert.equal(h.state.selected, y.key);

    // c：不弹提示，名单最后一行自己写着收起了几个
    const c = new Harness();
    c.feed([done1, done2, agent("run")]);
    c.press("c");
    assert.equal(c.state.collapseEnded, true);
    assert.equal(c.notice, null);
    c.press("c");
    assert.equal(c.state.collapseEnded, false);
    assert.equal(c.notice, null);
  });

  test("a new-entry notice does not hide an error that is still showing, and a switch notice survives the session change", () => {
    const [a, b] = [agent("a"), agent("b")];
    const h = new Harness();
    h.feed([a]);
    h.press("k");
    h.press("f");
    h.press("f");
    h.send({ type: "notify", text: "复制失败：不在 tmux 里", tone: "error" });
    h.feed([a, b]);
    assert.equal(h.notice, "复制失败：不在 tmux 里");

    // 自动换 session：runtime 先发提示再换数据，提示要带到新 session 上，并能指定显示多久
    const s = new Harness([agent("a")]);
    s.feed([agent("a")]);
    s.send({ type: "notify", text: "已切到「乙」：左边切到了这个 session", tone: "info", durationMs: 6000 });
    assert.equal(s.state.notice?.until, s.now + 6000);
    s.data = makeData([agent("z")], { session: { sessionId: "s2", project: "proj", title: "乙" } });
    s.send({ type: "data" });
    assert.equal(s.notice, "已切到「乙」：左边切到了这个 session");
    assert.equal(s.state.sessionId, "s2");
  });

  test("when the selected entry disappears the neighbour is selected and focus goes back to the list", () => {
    const [a, b, c] = [agent("a"), agent("b"), agent("c")];
    const h = new Harness();
    h.feed([a, b, c]);
    h.press("k", "Enter");
    assert.equal(h.state.selected, b.key);
    assert.equal(h.state.focus, "content");
    h.feed([a, c]);
    assert.equal(h.state.selected, c.key, "the one after it");
    assert.equal(h.state.focus, "list");
    h.feed([a]);
    assert.equal(h.state.selected, a.key, "no one after it: the one before");
    h.feed([]);
    assert.equal(h.state.selected, null);
  });

  test("changing session drops selection, unread, drafts and scroll but keeps preferences", () => {
    const h = new Harness();
    h.feed([agent("a"), agent("b")]);
    h.press("z", "k", "Enter");
    h.type("draft");
    h.press("Esc");
    h.feed([agent("a", { status: "done", startedAt: 1 }), agent("b")]);
    assert.equal(h.state.drafts.size, 1);
    assert.equal(h.state.zoom, true);

    h.feed([agent("x"), agent("y")], { session: { sessionId: "s2", project: "p2", title: null } });
    assert.equal(h.state.sessionId, "s2");
    assert.equal(h.state.selected, agentKey("y"));
    assert.equal(h.state.focus, "list");
    assert.equal(h.state.drafts.size, 0);
    assert.equal(h.state.unread.size, 0);
    assert.equal(h.state.pending.size, 0);
    assert.equal(h.state.zoom, true);
    assert.deepEqual(h.effects, [], "entries already there when the session is adopted do not ring");
  });
});

describe("unread marks and the bell", () => {
  test("an entry that ends while not selected becomes unread and selecting it clears the mark", () => {
    const a = agent("a");
    const b = agent("b");
    const h = new Harness();
    h.feed([a, b]);
    h.feed([{ ...a, status: "done" }, b]);
    assert.deepEqual([...h.state.unread], [a.key]);
    h.press("k");
    assert.equal(h.state.unread.size, 0);
  });

  test("the selected entry ending or going idle is not unread, an unselected idle one is", () => {
    const a = agent("a");
    const b = agent("b");
    const h = new Harness();
    h.feed([a, b]);
    h.feed([a, { ...b, status: "done" }]);
    assert.equal(h.state.unread.size, 0);
    h.feed([{ ...a, status: "idle" }, { ...b, status: "done" }]);
    assert.deepEqual([...h.state.unread], [a.key]);
  });

  test("a new failure rings once; --no-bell silences it; an already failed entry does not ring again", () => {
    const a = agent("a");
    const b = command("b");
    const h = new Harness();
    h.feed([a, b]);
    const effects = h.feed([a, { ...b, status: "failed", exitCode: 1 }, command("c", { status: "failed", exitCode: 2 })]);
    assert.deepEqual(types(effects), ["bell"]);
    assert.equal(types(h.feed([a, { ...b, status: "failed", exitCode: 1 }])).length, 0);

    const quiet = new Harness();
    quiet.feed([a, b], { bellEnabled: false });
    assert.deepEqual(quiet.feed([a, { ...b, status: "failed" }], { bellEnabled: false }), []);
    assert.deepEqual([...quiet.state.unread], [b.key].filter((k) => k !== quiet.state.selected));
  });

  test("a hidden entry that reappears (c toggled) is not reported as new", () => {
    const a = agent("a");
    const b = agent("b", { status: "done" });
    const h = new Harness();
    h.feed([a, b]);
    h.feed([a]);
    const effects = h.feed([a, b]);
    assert.deepEqual(effects, []);
    assert.equal(h.state.unread.has(b.key), false);
  });
});

describe("list keys", () => {
  test("x asks first and acts only on a second press within the window on the same entry", () => {
    const a = agent("a");
    const h = new Harness();
    h.feed([a]);
    assert.deepEqual(h.press("x"), []);
    assert.equal(h.state.confirmStop?.key, a.key);
    assert.equal(h.state.confirmStop?.until, h.now + CONFIRM_WINDOW_MS);

    h.advance(CONFIRM_WINDOW_MS - 1);
    const [request] = h.press("x");
    assert.deepEqual(request, { type: "request", requestId: "r1", op: { op: "cancel", taskId: "a" } });
    assert.equal(h.state.confirmStop, null);
    assert.equal(h.state.pending.get("r1")?.label, "a");
  });

  test("x after the window expired only asks again", () => {
    const h = new Harness();
    h.feed([agent("a")]);
    h.press("x");
    h.advance(CONFIRM_WINDOW_MS);
    assert.equal(h.state.confirmStop, null, "the tick clears it");
    assert.deepEqual(h.press("x"), []);
    assert.notEqual(h.state.confirmStop, null);

    // 没有时钟输入时，过期的确认也不能被第二次按键用掉。
    h.now += CONFIRM_WINDOW_MS + 1;
    assert.deepEqual(h.press("x"), []);
  });

  test("another key between the two presses cancels the confirmation", () => {
    const h = new Harness();
    h.feed([agent("a"), agent("b")]);
    h.press("x", "k", "j");
    assert.equal(h.state.confirmStop, null);
    assert.deepEqual(h.press("x"), []);
  });

  test("x on a command uses the shell task id", () => {
    const h = new Harness();
    h.feed([command("c1")]);
    h.press("x");
    assert.deepEqual(h.press("x"), [{ type: "request", requestId: "r1", op: { op: "cancel", taskId: "sh-c1" } }]);
  });

  test("x does nothing but explain when the entry is not running, has no task, or the extension is read-only", () => {
    const ended = new Harness();
    ended.feed([agent("a", { status: "done" })]);
    assert.deepEqual(ended.press("x", "x"), []);
    assert.match(ended.notice ?? "", /不在跑了/);
    assert.equal(ended.state.confirmStop, null);

    const noTask = new Harness();
    noTask.feed([agent("a", { task: null })]);
    assert.deepEqual(noTask.press("x", "x"), []);
    assert.match(noTask.notice ?? "", /对应不上/);

    const readonly = new Harness();
    readonly.feed([agent("a")], { extension: { kind: "readonly", reason: "只读：这个 session 没加载扩展", cause: "这个 session 启动时还没装扩展" } });
    assert.deepEqual(readonly.press("x", "x"), []);
    assert.equal(readonly.notice, "只读，不能停止：这个 session 启动时还没装扩展");

    // 数据里没有原因时仍说得通
    const unknown = new Harness();
    unknown.feed([agent("a")], { extension: { kind: "readonly", reason: "只读：扩展没有加载" } });
    unknown.press("x", "x");
    assert.equal(unknown.notice, "只读，不能停止：扩展没有加载");
  });

  test("b promotes only a running entry that can go to the background", () => {
    const h = new Harness();
    h.feed([command("c1"), agent("a")]);
    assert.equal(h.state.selected, agentKey("a"));
    h.press("b");
    assert.match(h.notice ?? "", /不能转后台/);
    assert.deepEqual(h.effects, []);

    h.press("k");
    assert.deepEqual(h.press("b"), [{ type: "request", requestId: "r1", op: { op: "promoteToBackground", taskId: "sh-c1" } }]);

    const readonly = new Harness();
    readonly.feed([command("c1")], { extension: { kind: "readonly", reason: "正在连接扩展…", cause: "扩展正在连接" } });
    assert.deepEqual(readonly.press("b"), []);
    assert.equal(readonly.notice, "只读，不能转后台：扩展正在连接");
  });

  test("Enter, Right and Tab move focus into the content and Esc comes back", () => {
    for (const name of ["Enter", "Right", "Tab"]) {
      const h = new Harness();
      h.feed([agent("a")]);
      h.press(name);
      assert.equal(h.state.focus, "content", name);
      h.press("Esc");
      assert.equal(h.state.focus, "list");
    }
  });

  test("c, z and e toggle; z on a short pane explains the automatic collapse", () => {
    const a = agent("a");
    const h = new Harness();
    h.feed([a]);
    h.press("c");
    assert.equal(h.state.collapseEnded, true);
    h.press("c");
    assert.equal(h.state.collapseEnded, false);
    h.press("z");
    assert.equal(h.state.zoom, true);
    assert.equal(h.notice === null || !/太矮/.test(h.notice), true);
    h.press("e");
    assert.deepEqual([...h.state.expanded], [a.key]);
    h.press("e");
    assert.equal(h.state.expanded.size, 0);

    h.size = { cols: 80, rows: 15 };
    h.press("z");
    assert.match(h.notice ?? "", /太矮/);
  });

  test("y, o and q produce their effects; y and o need a selected entry", () => {
    const a = agent("a");
    const h = new Harness();
    assert.deepEqual(h.press("y", "o"), []);
    h.feed([a]);
    assert.deepEqual(h.press("y"), [{ type: "copy", entryKey: a.key }]);
    assert.deepEqual(h.press("o"), [{ type: "pager", entryKey: a.key }]);
    assert.deepEqual(h.press("q"), [{ type: "quit" }]);
  });

  test("Ctrl+C asks first and quits on a second press within two seconds", () => {
    const h = new Harness();
    h.feed([agent("a")]);
    assert.deepEqual(h.press("C-c"), []);
    assert.equal(h.state.quitArmedUntil, h.now + QUIT_WINDOW_MS);
    h.advance(QUIT_WINDOW_MS - 1);
    assert.deepEqual(h.press("C-c"), [{ type: "quit" }]);
  });

  test("Ctrl+C after the window, or with another key in between, only asks again", () => {
    const h = new Harness();
    h.feed([agent("a")]);
    h.press("C-c");
    h.advance(QUIT_WINDOW_MS);
    assert.equal(h.state.quitArmedUntil, null);
    assert.deepEqual(h.press("C-c"), []);
    h.press("j");
    assert.equal(h.state.quitArmedUntil, null);
    assert.deepEqual(h.press("C-c"), []);
  });

  test("notices expire on the clock and tick changes nothing else", () => {
    const h = new Harness();
    h.feed([agent("a")]);
    h.send({ type: "notify", text: "出错了", tone: "error" });
    assert.deepEqual(h.state.notice, { text: "出错了", tone: "error", until: h.now + NOTICE_MS });
    const before = h.state;
    h.advance(NOTICE_MS - 1);
    assert.equal(h.state.notice?.text, "出错了");
    h.advance(1);
    assert.equal(h.state.notice, null);
    const quiet = h.state;
    h.advance(10);
    assert.equal(h.state, quiet, "nothing to expire: same state object");
    assert.notEqual(before, quiet);
  });
});

describe("agent content: drafts and sending", () => {
  test("Enter sends, clears the draft and records the request; success says it was sent", () => {
    const h = new Harness();
    h.feed([agent("fix")]);
    h.press("Enter");
    h.type("请继续");
    assert.equal(h.state.drafts.get(agentKey("fix"))?.text, "请继续");
    const effects = h.press("Enter");
    assert.deepEqual(effects, [{ type: "request", requestId: "r1", op: { op: "sendMessage", taskId: "fix", message: "请继续" } }]);
    assert.equal(h.state.drafts.size, 0);
    assert.equal(h.state.pending.get("r1")?.op, "sendMessage");

    h.send({ type: "result", requestId: "r1", outcome: { ok: true } });
    assert.equal(h.notice, "已发给 fix");
    assert.equal(h.state.notice?.tone, "info");
    assert.equal(h.state.pending.size, 0);
  });

  test("a failed send shows the reason and puts the text back", () => {
    const h = new Harness();
    h.feed([agent("fix")]);
    h.press("Enter");
    h.type("hello");
    h.press("Enter");
    h.send({ type: "result", requestId: "r1", outcome: { ok: false, reason: "子 agent 已经结束" } });
    assert.match(h.notice ?? "", /子 agent 已经结束/);
    assert.equal(h.state.notice?.tone, "error");
    assert.deepEqual(h.state.drafts.get(agentKey("fix")), { text: "hello", cursor: 5 });
  });

  test("a send that timed out does not claim the message was not sent: it says no result came and the message may have arrived", () => {
    const h = new Harness();
    h.feed([agent("fix")]);
    h.press("Enter");
    h.type("hello");
    h.press("Enter");
    h.send({ type: "result", requestId: "r1", outcome: { ok: false, reason: "扩展没有回应", uncertain: true } });
    assert.equal(h.notice, "没收到结果：扩展没有回应（消息可能已经送到，先看过程记录再决定要不要重发）");
    assert.ok(!(h.notice ?? "").includes("没发出去"));
    assert.equal(h.state.drafts.get(agentKey("fix"))?.text, "hello", "the text is still put back so nothing is lost");
  });

  test("a failed send keeps what was typed in the meantime", () => {
    const h = new Harness();
    h.feed([agent("fix")]);
    h.press("Enter");
    h.type("one");
    h.press("Enter");
    h.type("two");
    h.send({ type: "result", requestId: "r1", outcome: { ok: false, reason: "没有回应" } });
    assert.equal(h.state.drafts.get(agentKey("fix"))?.text, "one\ntwo");
  });

  test("Enter with an empty or blank draft sends nothing", () => {
    const h = new Harness();
    h.feed([agent("fix")]);
    h.press("Enter");
    assert.deepEqual(h.press("Enter"), []);
    h.type("  ");
    assert.deepEqual(h.press("Enter"), []);
    assert.equal(h.state.pending.size, 0);
  });

  test("a draft survives Esc and switching to another entry and back", () => {
    const h = new Harness();
    h.feed([agent("a"), agent("b")]);
    h.press("Enter");
    h.type("for b");
    h.press("Esc", "k", "Enter");
    assert.equal(h.state.drafts.get(agentKey("b"))?.text, "for b");
    h.type("for a");
    h.press("Esc", "j");
    assert.equal(h.state.selected, agentKey("b"));
    h.press("Enter");
    assert.equal(h.state.drafts.get(agentKey("b"))?.text, "for b");
    assert.equal(h.state.drafts.get(agentKey("a"))?.text, "for a");
    h.press("Enter");
    assert.deepEqual(h.effects.at(-1), { type: "request", requestId: "r1", op: { op: "sendMessage", taskId: "b", message: "for b" } });
    assert.equal(h.state.drafts.get(agentKey("a"))?.text, "for a");
  });

  test("letters in the agent's content are text, not commands", () => {
    const h = new Harness();
    h.feed([agent("a"), agent("b")]);
    h.press("Enter");
    h.type("xqzfsy?/");
    assert.equal(h.state.drafts.get(agentKey("b"))?.text, "xqzfsy?/");
    assert.equal(h.state.selected, agentKey("b"));
    assert.equal(h.state.overlay, "none");
    assert.equal(h.state.search, null);
    assert.deepEqual(h.effects, []);
  });

  test("Alt+Enter and Ctrl+J add a line instead of sending", () => {
    const h = new Harness();
    h.feed([agent("a")]);
    h.press("Enter");
    h.type("l1");
    assert.deepEqual(h.press("A-Enter"), []);
    h.type("l2");
    h.press("C-j");
    h.type("l3");
    assert.equal(h.state.drafts.get(agentKey("a"))?.text, "l1\nl2\nl3");
  });

  test("Ctrl+C clears the draft; with nothing to clear it points to Esc", () => {
    const h = new Harness();
    h.feed([agent("a")]);
    h.press("Enter");
    h.type("oops");
    h.press("C-c");
    assert.equal(h.state.drafts.size, 0);
    assert.equal(h.state.focus, "content");
    assert.equal(h.notice, null);
    h.press("C-c");
    assert.equal(h.notice, "按 Esc 回名单");
    assert.deepEqual(h.effects, []);
  });

  test("an ended or read-only agent takes no input and says why", () => {
    const ended = new Harness();
    ended.feed([agent("a", { status: "done" })]);
    ended.press("Enter", "h");
    assert.match(ended.notice ?? "", /^没输入进去：a 已经结束$/);
    assert.equal(ended.state.drafts.size, 0);
    ended.press("Enter");
    assert.deepEqual(ended.effects, []);

    const readonly = new Harness();
    readonly.feed([agent("a")], { extension: { kind: "readonly", reason: "只读：还没装扩展", cause: "还没装扩展" } });
    readonly.press("Enter", "h");
    assert.equal(readonly.notice, "没输入进去：只读，还没装扩展");
    assert.equal(readonly.state.drafts.size, 0);
    readonly.press("Enter");
    assert.equal(readonly.notice, "没发出去：只读，还没装扩展");

    const orphaned = new Harness();
    orphaned.feed([agent("a", { status: "stopped", orphaned: true })]);
    orphaned.press("Enter", "Enter");
    assert.equal(orphaned.notice, "没发出去：这个 session 已经结束");
  });

  test("an agent that cannot be matched to a task keeps the text and says so", () => {
    const h = new Harness();
    h.feed([agent("a", { task: null })]);
    h.press("Enter");
    h.type("hi");
    assert.deepEqual(h.press("Enter"), []);
    assert.match(h.notice ?? "", /对应不上/);
    assert.equal(h.state.drafts.get(agentKey("a"))?.text, "hi");
  });

  test("a result for an unknown request is ignored", () => {
    const h = new Harness();
    h.feed([agent("a")]);
    const before = h.state;
    h.send({ type: "result", requestId: "r99", outcome: { ok: false, reason: "x" } });
    assert.equal(h.state, before);
  });

  test("results of x and b write their own wording", () => {
    const h = new Harness();
    h.feed([command("c1")]);
    h.press("x", "x");
    h.send({ type: "result", requestId: "r1", outcome: { ok: true } });
    assert.equal(h.notice, "已请求停止 $ run c1");
    h.press("b");
    h.send({ type: "result", requestId: "r2", outcome: { ok: false, reason: "已经在后台" } });
    assert.equal(h.notice, "没转后台：已经在后台");
  });
});

describe("command content", () => {
  test("Ctrl+C asks the runtime to interrupt, other characters explain that there is no input", () => {
    const h = new Harness();
    h.feed([command("c1")]);
    h.press("Enter");
    assert.deepEqual(h.press("C-c"), [{ type: "interrupt", entryKey: commandKey("c1"), toolCallId: "c1", pid: 4242, taskId: "sh-c1" }]);
    h.press("h");
    assert.equal(h.notice, COMMAND_NO_INPUT_NOTICE);
    h.send({ type: "tick" });
    h.press("Enter");
    assert.equal(h.notice, COMMAND_NO_INPUT_NOTICE);
    assert.equal(h.state.drafts.size, 0);
    h.press("Esc");
    assert.equal(h.state.focus, "list");
  });

  test("Ctrl+C on a command that already exited only says so", () => {
    const h = new Harness();
    h.feed([command("c1", { status: "done", exitCode: 0 })]);
    h.press("Enter");
    assert.deepEqual(h.press("C-c"), []);
    assert.equal(h.notice, "这条命令已经退出了");
  });

  test("Ctrl+C escalates SIGINT, SIGTERM, SIGKILL with the 3 second condition (real Interrupter)", () => {
    const sent: { target: number; signal: InterruptSignal }[] = [];
    const proc: ProcAccess = {
      exists: () => true,
      parentOf: (pid) => (pid === 4242 ? 100 : null),
      processGroupOf: (pid) => pid,
      kill: (target, signal) => void sent.push({ target, signal }),
    };
    const h = new Harness();
    const interrupter = new Interrupter(proc, { now: () => h.now }, INTERRUPT_ESCALATE_MS);
    h.feed([command("c1")]);
    h.press("Enter");

    const ctrlC = () => {
      for (const effect of h.press("C-c")) {
        assert.equal(effect.type, "interrupt");
        if (effect.type !== "interrupt") continue;
        const outcome = interrupter.press(effect.toolCallId, effect.pid, 100);
        h.send({ type: "interrupted", entryKey: effect.entryKey, outcome });
      }
    };

    ctrlC();
    assert.deepEqual(sent, [{ target: -4242, signal: "SIGINT" }]);
    assert.match(h.notice ?? "", /已发送 SIGINT/);
    assert.equal(h.state.interrupts?.get(commandKey("c1"))?.signal, "SIGINT");

    h.advance(1000);
    ctrlC();
    assert.equal(sent.length, 1, "within 3 seconds: no escalation");
    assert.match(h.notice ?? "", /已发送 SIGINT，2 秒后还没退出可以再按一次/);

    h.advance(INTERRUPT_ESCALATE_MS - 1000);
    ctrlC();
    assert.deepEqual(sent.at(-1), { target: -4242, signal: "SIGTERM" });
    assert.equal(h.state.interrupts?.get(commandKey("c1"))?.signal, "SIGTERM");

    h.advance(INTERRUPT_ESCALATE_MS);
    ctrlC();
    assert.deepEqual(sent.at(-1), { target: -4242, signal: "SIGKILL" });
    assert.equal(sent.length, 3);

    h.feed([command("c1", { status: "done", exitCode: 137, startedAt: 0 })]);
    h.press("C-c");
    assert.equal(h.notice, "这条命令已经退出了");
    assert.equal(sent.length, 3);
  });

  test("without a usable pid the interrupt falls back to asking the extension to cancel", () => {
    const h = new Harness();
    const entry = command("c1", { task: { id: "sh-c1", status: "running", executionMode: "sync", canPromoteToBackground: false, pid: null } });
    h.feed([entry]);
    h.press("Enter", "C-c");
    const [effect] = h.effects;
    assert.equal(effect?.type, "interrupt");
    assert.equal(effect?.type === "interrupt" ? effect.pid : "x", null);
    const after = h.send({ type: "interrupted", entryKey: entry.key, outcome: { kind: "fallback", reason: "拿不到命令的进程号" } });
    assert.deepEqual(after, [{ type: "request", requestId: "r1", op: { op: "cancel", taskId: "sh-c1" } }]);
    assert.match(h.notice ?? "", /拿不到命令的进程号/);

    const bare = new Harness();
    bare.feed([command("c2", { task: null })]);
    bare.press("Enter", "C-c");
    const none = bare.send({ type: "interrupted", entryKey: commandKey("c2"), outcome: { kind: "fallback", reason: "拿不到命令的进程号" } });
    assert.deepEqual(none, []);
    assert.equal(bare.state.notice?.tone, "error");

    bare.send({ type: "interrupted", entryKey: commandKey("c2"), outcome: { kind: "failed", reason: "发信号失败：EPERM" } });
    assert.match(bare.notice ?? "", /EPERM/);
  });

  test("a read-only extension cannot interrupt and says so", () => {
    const h = new Harness();
    h.feed([command("c1", { task: null })], { extension: { kind: "readonly", reason: "只读：扩展和界面版本不一致", cause: "扩展和界面的版本不一致" } });
    h.press("Enter");
    assert.deepEqual(h.press("C-c"), []);
    assert.equal(h.notice, "只读，不能中断：扩展和界面的版本不一致");
  });
});

describe("scrolling", () => {
  const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i}`);

  test("e on a command shows its text above the output and scrolls to the top so it is seen; e again goes back", () => {
    const store = { ...fakeAgentStore("x", []), command: () => ({ command: "cd /a && timeout 9 make test", eventOutput: "" }) } as unknown as StoreView;
    const h = new Harness([command("c1")], { terminal: fakeTerminal(lines(100)), store });
    h.feed([command("c1")], { terminal: fakeTerminal(lines(100)), store });
    const rows = computeLayout(h.state, h.context().data, h.size).contentRows;
    h.press("e");
    // 命令原文占一行，后面空一行
    assert.equal(h.state.scroll, 102 - rows);
    assert.equal(h.state.scrollTotal, 102);
    h.press("e");
    assert.equal(h.state.scroll, 100 - rows, "after collapsing, clamped to the new top");
    assert.equal(h.state.scrollTotal, 100);
  });

  test("Home and End in a sub-agent's content jump to the top and the bottom of the record while the input box is empty", () => {
    const store = fakeAgentStore("a", Array.from({ length: 200 }, (_, i) => `say ${i}`));
    const entry = agent("a");
    const h = new Harness([entry], { store });
    h.feed([entry], { store });
    h.press("Enter", "Home");
    assert.ok(h.state.scroll > 100, "jumped far up the record");
    h.press("End");
    assert.equal(h.state.scroll, 0);
    h.type("ab");
    h.press("Home");
    assert.equal(h.state.scroll, 0, "with text in the box Home moves the cursor");
    assert.equal(h.state.drafts.get(entry.key)?.cursor, 0);
  });

  test("PgUp and PgDn scroll in the list focus too, clamp, and Home/End jump in a command's content", () => {
    const h = new Harness([command("c1")], { terminal: fakeTerminal(lines(100)) });
    h.feed([command("c1")], { terminal: fakeTerminal(lines(100)) });
    const layout = computeLayout(h.state, h.context().data, h.size);
    const page = layout.contentRows - 1;
    h.press("PgUp");
    assert.equal(h.state.scroll, page);
    assert.equal(h.state.scrollTotal, 100);
    h.press("PgDn");
    assert.equal(h.state.scroll, 0);
    assert.equal(h.state.scrollTotal, null);
    h.press("PgDn");
    assert.equal(h.state.scroll, 0);

    h.press("Enter", "Home");
    assert.equal(h.state.scroll, 100 - layout.contentRows);
    h.press("PgUp");
    assert.equal(h.state.scroll, 100 - layout.contentRows, "already at the top");
    h.press("End");
    assert.equal(h.state.scroll, 0);
    h.press("Up", "Up");
    assert.equal(h.state.scroll, 2);
  });

  test("new output while scrolled up does not move the page the user is reading", () => {
    const entry = command("c1");
    const h = new Harness();
    h.feed([entry], { terminal: fakeTerminal(lines(100)) });
    const rows = computeLayout(h.state, h.context().data, h.size).contentRows;
    h.press("PgUp");
    const page = rows - 1;
    h.feed([entry], { terminal: fakeTerminal(lines(110)) });
    assert.equal(h.state.scroll, page, "data does not touch it: the view adds the growth");
    h.press("PgUp");
    assert.equal(h.state.scroll, page + 10 + page, "the next page continues from where the screen really is");
    assert.equal(h.state.scrollTotal, 110);
  });

  test("each entry keeps its own scroll position", () => {
    const [a, b] = [command("a"), command("b")];
    const h = new Harness();
    h.feed([a, b], { terminal: fakeTerminal(lines(100)) });
    h.press("PgUp", "PgUp");
    const scrolled = h.state.scroll;
    assert.ok(scrolled > 0);
    h.press("k");
    assert.equal(h.state.selected, a.key);
    assert.equal(h.state.scroll, 0);
    h.press("PgUp");
    h.press("j");
    assert.equal(h.state.scroll, scrolled);
    assert.equal(h.state.scrollTotal, 100);
    h.press("k");
    assert.equal(h.state.scroll > 0, true);
  });

  test("the mouse wheel scrolls the content, or moves the selection over the list", () => {
    const [a, b] = [command("a"), command("b")];
    const h = new Harness();
    h.feed([a, b], { terminal: fakeTerminal(lines(100)) });
    const layout = computeLayout(h.state, h.context().data, h.size);
    h.mouse("wheelup", layout.contentTop + 1);
    assert.equal(h.state.scroll, 3);
    h.mouse("wheeldown", layout.contentTop + 1);
    assert.equal(h.state.scroll, 0);

    h.mouse("wheelup", layout.listTop);
    assert.equal(h.state.selected, a.key);
    assert.equal(h.state.followLatest, false);
    h.mouse("wheeldown", layout.listTop);
    assert.equal(h.state.selected, b.key);
  });
});

describe("mouse clicks", () => {
  test("clicking a list row selects it, stops following and puts focus on the list; clicking the content focuses it", () => {
    const h = new Harness();
    h.feed([agent("a"), agent("b"), agent("c")]);
    h.press("Enter");
    const layout = computeLayout(h.state, h.context().data, h.size);
    h.mouse("down", layout.listTop);
    assert.equal(h.state.selected, agentKey("a"));
    assert.equal(h.state.followLatest, false);
    assert.equal(h.state.focus, "list");

    h.mouse("down", layout.listTop + 1);
    assert.equal(h.state.selected, agentKey("b"));
    h.mouse("down", layout.contentTop + 2);
    assert.equal(h.state.focus, "content");
    h.mouse("down", layout.listTop);
    assert.equal(h.state.focus, "list");
    h.mouse("down", layout.titleRow);
    assert.equal(h.state.focus, "content", "the title row is the top of the content frame");
    h.mouse("down", layout.listTop);
    h.mouse("down", layout.dividerRow);
    assert.equal(h.state.focus, "content", "so is the line above the input");
    h.mouse("down", layout.inputTop);
    assert.equal(h.state.focus, "content");
    h.mouse("down", layout.keysRow);
    assert.equal(h.state.focus, "content", "the key hint row is not clickable");
  });

  test("clicks on the top row, releases and right clicks do nothing", () => {
    const h = new Harness();
    h.feed([agent("a")]);
    h.size = { cols: 80, rows: 30 };
    const layout = computeLayout(h.state, h.context().data, h.size);
    const before = h.state;
    h.mouse("down", 0);
    h.mouse("up", layout.listTop);
    h.send({ type: "input", event: { type: "mouse", action: "down", button: "right", row: layout.listTop, col: 1, ctrl: false, alt: false, shift: false } });
    assert.equal(h.state, before);
  });

  test("with the list collapsed there are no list rows: a click on the title row keeps the selected entry and focuses the content", () => {
    const h = new Harness();
    h.size = { cols: 80, rows: 15 };
    h.feed([agent("a"), agent("b")]);
    const layout = computeLayout(h.state, h.context().data, h.size);
    assert.equal(layout.listRows, 0);
    assert.equal(layout.titleRow, 1);
    const selected = h.state.selected;
    h.mouse("down", 1);
    assert.equal(h.state.selected, selected);
    assert.equal(h.state.focus, "content");
  });

  test("the rows between the list and the title (more entries below, collapsed ended entries) do nothing", () => {
    const h = new Harness();
    h.size = { cols: 80, rows: 24 };
    h.feed(Array.from({ length: 12 }, (_, i) => agent(`n${i}`)));
    const layout = computeLayout(h.state, h.context().data, h.size);
    assert.ok(layout.hintRow > 0);
    const before = h.state;
    h.mouse("down", layout.hintRow);
    assert.equal(h.state, before);
  });
});

describe("search", () => {
  const output = Array.from({ length: 30 }, (_, i) => (i === 3 || i === 20 || i === 28 ? `line ${i}: ERROR` : `line ${i}`));

  const searching = (focus: "list" | "content") => {
    const h = new Harness();
    h.feed([command("c1")], { terminal: fakeTerminal(output) });
    if (focus === "content") h.press("Enter");
    h.press("/");
    return h;
  };

  test("/ edits the term, Enter jumps to the first match on or below the window top, n and N cycle", () => {
    const h = searching("list");
    assert.equal(h.state.search?.editing, true);
    h.type("error");
    h.press("Enter");
    assert.equal(h.state.search?.editing, false);
    assert.equal(h.state.search?.matches, 3);
    assert.equal(h.state.search?.currentRow, 20, "the window shows lines 12 to 29");
    assert.equal(h.state.scroll, 0);

    h.press("n");
    assert.equal(h.state.search?.currentRow, 28);
    h.press("n");
    assert.equal(h.state.search?.currentRow, 3);
    assert.equal(h.state.search?.index, 0);
    assert.ok(h.state.scroll > 0, "scrolled up to show line 3");
    h.press("N");
    assert.equal(h.state.search?.currentRow, 28);
    assert.equal(h.state.scroll, 0);
    h.press("N");
    assert.equal(h.state.search?.currentRow, 20);
  });

  test("Esc cancels the edit and the committed search; an empty term or no match leaves nothing to jump to", () => {
    const h = searching("list");
    h.type("err");
    h.press("Esc");
    assert.equal(h.state.search, null);

    h.press("/", "Enter");
    assert.equal(h.state.search, null, "empty term");

    h.press("/");
    h.type("zzz");
    h.press("Enter");
    const found = () => h.state.search;
    assert.equal(found()?.matches, 0);
    assert.equal(found()?.currentRow, null);
    h.press("n");
    assert.equal(found()?.currentRow, null);

    h.press("Esc");
    assert.equal(h.state.search, null);
  });

  test("in a command's content Esc first cancels the search, then leaves the content", () => {
    const h = searching("content");
    h.type("error");
    h.press("Enter", "Esc");
    assert.equal(h.state.search, null);
    assert.equal(h.state.focus, "content");
    h.press("Esc");
    assert.equal(h.state.focus, "list");
  });

  test("while editing the term, keys are text; selecting another entry drops the search; n without a search says how to start one", () => {
    const h = new Harness();
    h.feed([command("c1"), command("c2")], { terminal: fakeTerminal(output) });
    h.press("n");
    assert.match(h.notice ?? "", /先按 \//);
    h.press("/");
    h.type("jqx");
    assert.equal(h.state.search?.query.text, "jqx");
    assert.equal(h.state.selected, commandKey("c2"));
    h.press("Enter");
    h.press("k");
    assert.equal(h.state.search, null);
  });

  test("a sub-agent without a store has nothing to search but does not break", () => {
    const h = new Harness();
    h.feed([agent("a")]);
    h.press("/");
    h.type("x");
    h.press("Enter");
    assert.equal(h.state.search?.matches, 0);
  });
});

describe("a sub-agent's transcript", () => {
  const texts = Array.from({ length: 60 }, (_, i) => (i === 10 || i === 40 ? `这里有 Needle ${i}` : `第 ${i} 句话`));
  const setup = () => {
    const h = new Harness();
    h.feed([agent("a1")], { store: fakeAgentStore("a1", texts) });
    return h;
  };

  test("PgUp scrolls by a page and stops at the first row", () => {
    const h = setup();
    const rows = computeLayout(h.state, h.context().data, h.size).contentRows;
    const total = agentRowCount(h.data.store!, "a1", { width: 78, expanded: false });
    assert.ok(total > rows * 2);
    h.press("PgUp");
    assert.equal(h.state.scroll, rows - 1);
    assert.equal(h.state.scrollTotal, total);
    for (let i = 0; i < 20; i++) h.press("PgUp");
    assert.equal(h.state.scroll, total - rows);
    h.press("Enter", "PgDn");
    assert.equal(h.state.scroll, total - rows - (rows - 1));
  });

  test("/ finds the rows the view shows and n and N move between them", () => {
    const h = setup();
    const shown = agentContentLines(h.data.store!, "a1", { width: 78, expanded: false, now: h.now, spinnerFrame: 0 });
    const rows = matchRows(shown, "needle");
    assert.equal(rows.length, 2);
    h.press("/");
    h.type("needle");
    h.press("Enter");
    const search = () => h.state.search;
    assert.equal(search()?.matches, 2);
    assert.equal(search()?.currentRow, rows[0], "both matches are above the window: wrap to the first");
    assert.ok(h.state.scroll > 0);
    h.press("n");
    assert.equal(search()?.currentRow, rows[1]);
    h.press("n");
    assert.equal(search()?.currentRow, rows[0]);
    h.press("N");
    assert.equal(search()?.currentRow, rows[1]);
  });
});

describe("overlays", () => {
  test("help swallows other keys and closes with Esc, q, ? or Ctrl+C", () => {
    const h = new Harness();
    h.feed([agent("a"), agent("b")]);
    h.press("?");
    assert.equal(h.state.overlay, "help");
    h.press("k", "x", "Enter", "z", "f");
    assert.equal(h.state.selected, agentKey("b"));
    assert.equal(h.state.zoom, false);
    assert.equal(h.state.confirmStop, null);
    assert.equal(h.state.focus, "list");
    for (const close of ["Esc", "q", "?", "C-c"]) {
      h.press("?");
      h.press(close);
      assert.equal(h.state.overlay, "none", close);
    }
    assert.deepEqual(h.effects, [], "q inside the overlay does not quit");
  });

  test("help that does not fit the pane scrolls with the arrows, PgUp/PgDn, Home/End and the wheel; opening it again starts at the top", () => {
    const h = new Harness();
    h.size = { cols: 50, rows: 20 };
    h.feed([agent("a")]);
    h.press("?");
    assert.equal(h.state.helpScroll ?? 0, 0);
    h.press("Down", "j");
    assert.equal(h.state.helpScroll, 2);
    h.press("Up");
    assert.equal(h.state.helpScroll, 1);
    h.press("PgDn");
    assert.equal(h.state.helpScroll, 1 + 16);
    h.press("PgUp", "PgUp");
    assert.equal(h.state.helpScroll, 0);
    h.press("End");
    const max = h.state.helpScroll ?? 0;
    assert.ok(max > 10);
    h.press("Down", "PgDn");
    assert.equal(h.state.helpScroll, max, "stops at the end");
    h.press("Home");
    assert.equal(h.state.helpScroll, 0);
    h.mouse("wheeldown", 5);
    assert.equal(h.state.helpScroll, 3);
    h.press("G");
    assert.equal(h.state.helpScroll, max);
    h.press("g");
    assert.equal(h.state.helpScroll, 0);
    h.press("End", "Esc", "?");
    assert.equal(h.state.helpScroll, 0);
    assert.equal(h.state.overlay, "help");
    assert.equal(h.state.selected, agentKey("a"));
  });

  test("help that fits the pane has nothing to scroll", () => {
    const h = new Harness();
    h.size = { cols: 100, rows: 40 };
    h.feed([agent("a")]);
    const before = h.state;
    h.press("?");
    h.press("Down", "PgDn", "End");
    assert.equal(h.state.helpScroll, 0);
    assert.equal(before.overlay, "none");
  });

  test("the session picker selects with the arrows, Enter pins, the last item restores automatic choice", () => {
    const sessions = [
      { sessionId: "s1", title: "one", cwd: "/a", lastEventAt: 1, current: true },
      { sessionId: "s2", title: "two", cwd: "/b", lastEventAt: 2, current: false },
    ];
    const h = new Harness();
    h.feed([agent("a")], { sessions });
    h.press("s");
    assert.equal(h.state.overlay, "sessions");
    assert.equal(h.state.pickerIndex, 0, "starts on the current session");
    h.press("j");
    assert.equal(h.state.pickerIndex, 1);
    assert.deepEqual(h.press("Enter"), [{ type: "pinSession", sessionId: "s2" }]);
    assert.equal(h.state.overlay, "none");

    h.press("s", "End");
    assert.equal(h.state.pickerIndex, 2);
    h.press("Down");
    assert.equal(h.state.pickerIndex, 2);
    assert.deepEqual(h.press("Enter"), [{ type: "unpinSession" }]);

    h.press("s", "Esc");
    assert.equal(h.state.overlay, "none");
    assert.equal(h.effects.length, 2);
  });

  test("the overlays do not open on the waiting screen, and a mouse wheel moves the picker", () => {
    const waiting = new Harness();
    waiting.feed([], { session: null });
    waiting.press("s", "?");
    assert.equal(waiting.state.overlay, "none");

    const h = new Harness();
    h.feed([agent("a")], { sessions: [{ sessionId: "s1", title: null, cwd: null, lastEventAt: 1, current: true }] });
    h.press("s");
    h.mouse("wheeldown", 5);
    assert.equal(h.state.pickerIndex, 1);
    h.mouse("down", 2);
    assert.equal(h.state.overlay, "sessions");
  });
});

describe("initial state", () => {
  test("starts in the list, following, with nothing selected", () => {
    const state = initialState();
    assert.equal(state.focus, "list");
    assert.equal(state.selected, null);
    assert.equal(state.followLatest, true);
    assert.equal(state.nextRequestId, 1);
  });

  test("keys on an empty list do nothing", () => {
    const h = new Harness();
    const before = h.state;
    h.feed([]);
    h.press("j", "k", "Enter", "x", "b", "PgUp", "Esc");
    assert.equal(h.state.selected, null);
    assert.equal(h.state.focus, "list");
    assert.deepEqual(h.effects, []);
    assert.equal(update(before, { type: "tick" }, h.context()).effects.length, 0);
  });
});
