// 很长的过程记录只排看得见的那几条：画出来的行要和“全部排一遍再切”一样，翻看和新来的内容也一样。
import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionStore } from "../../src/model/store.ts";
import { initialState } from "../../src/ui/app.ts";
import { agentContentLines, agentContentWindow, agentRowCount, agentRowCountExact } from "../../src/ui/views/agent.ts";
import type { AgentContentOptions } from "../../src/ui/views/agent.ts";
import { resolveScroll } from "../../src/ui/views/content.ts";
import { ev, say, started, taskCall, toolEnd, toolStart } from "../model/support.ts";
import { agent, Harness } from "./app-support.ts";
import { computeLayout } from "../../src/ui/views/layout.ts";

const WORDS = "the quick brown fox jumps over the lazy dog while checking login handler tokens and session cookies in the auth module".split(" ");
const sentence = (n: number, words: number) => Array.from({ length: words }, (_, i) => WORDS[(n * 7 + i * 3) % WORDS.length]).join(" ");

/** 每 5 条：一段话（有时带汉字）、两次读文件、一次搜索、一条你发的消息。 */
function transcript(count: number, from = 0, id = "a1"): string[] {
  const lines = from === 0 ? [taskCall(`t-${id}`, null, 0), started(id, id, { task: `t-${id}`, at: 0.1 }), ev("user.message", { content: "查一下登录失败\n再给出建议" }, id, 0.2)] : [];
  for (let n = from; n < from + count; n++) {
    const at = 1 + n * 0.01;
    switch (n % 5) {
      case 0:
        lines.push(say(id, n % 10 === 0 ? `${sentence(n, 30)}。登录失败是因为 refreshToken 提前清空了会话。` : sentence(n, 28), at));
        break;
      case 1:
      case 2:
        lines.push(toolStart(`v${id}${n}`, "view", { path: `/work/src/file${n}.ts` }, id, at), toolEnd(`v${id}${n}`, "line\n".repeat(15), id, at + 0.001));
        break;
      case 3:
        lines.push(toolStart(`g${id}${n}`, "grep", { pattern: "refreshToken", path: "/work/src" }, id, at), toolEnd(`g${id}${n}`, "a.ts:1\nb.ts:2", id, at + 0.001));
        break;
      default:
        lines.push(ev("user.message", { content: `请继续，注意 ${sentence(n, 10)}`, source: "" }, id, at));
    }
  }
  return lines;
}

function storeOf(lines: string[]): SessionStore {
  const store = new SessionStore("s1");
  for (const line of lines) store.feedLine(line);
  return store;
}

const options = (over: Partial<AgentContentOptions> = {}): AgentContentOptions => ({ width: 60, expanded: false, now: 100_000, spinnerFrame: 0, ...over });
const texts = (lines: readonly (readonly { text: string }[])[]) => lines.map((line) => line.map((s) => s.text).join(""));

// 超过 400 条是估算总行数的长记录，不到是精确的
for (const [name, count] of [["a short record", 40], ["a long record", 900]] as const) {
  test(`${name}: the window equals cutting the fully laid-out rows, at the bottom, scrolled, and at the very top`, () => {
    const store = storeOf(transcript(count));
    for (const expanded of [false, true]) {
      const all = agentContentLines(store, "a1", options({ expanded }));
      assert.equal(agentRowCountExact(store, "a1", options({ expanded })), all.length);
      for (const rows of [1, 7, 20]) {
        for (const scroll of [0, 1, 5, 33, 400, all.length - rows, all.length, all.length + 500, 1_000_000]) {
          const { start, info } = resolveScroll(all.length, rows, scroll, null);
          const win = agentContentWindow(store, "a1", { ...options({ expanded }), rows, scroll });
          const expected = all.slice(start, start + rows);
          assert.deepEqual(texts(win.lines.slice(0, expected.length)), texts(expected), `rows ${rows} scroll ${scroll} expanded ${expanded}`);
          assert.equal(win.lines.length, rows);
          assert.deepEqual(win.scroll, info, `rows ${rows} scroll ${scroll}`);
        }
      }
    }
  });
}

test("a long record: new rows after the user scrolled up do not move the window and are counted exactly", () => {
  const lines = transcript(900);
  const store = storeOf(lines);
  const before = agentContentLines(store, "a1", options());
  const total = agentRowCount(store, "a1", options());
  const state = { rows: 12, scroll: 40, scrollTotal: total };
  const seen = agentContentWindow(store, "a1", { ...options(), ...state });
  assert.deepEqual(seen.scroll, { below: 40, fresh: 0 });

  for (const line of transcript(60, 900)) store.feedLine(line);
  const after = agentContentLines(store, "a1", options());
  const grown = after.length - before.length;
  assert.ok(grown > 60);
  const still = agentContentWindow(store, "a1", { ...options(), ...state });
  assert.deepEqual(texts(still.lines), texts(seen.lines));
  assert.deepEqual(still.scroll, { below: 40 + grown, fresh: grown });
  // 总行数的差就是新来的行数（老条目的估算值定下来之后不再变）
  assert.equal(agentRowCount(store, "a1", options()) - total, grown);
});

test("a long record: the estimated total is close, and the same number comes back every time and after looking at another agent", () => {
  const lines = transcript(900);
  const store = storeOf([...lines, ...transcript(700, 0, "a2")]);
  const exact = agentRowCountExact(store, "a1", options());
  const estimate = agentRowCount(store, "a1", options());
  assert.ok(Math.abs(estimate - exact) / exact < 0.2, `estimate ${estimate} exact ${exact}`);
  assert.equal(agentRowCount(store, "a1", options()), estimate);
  agentContentWindow(store, "a2", { ...options(), rows: 10, scroll: 0 });
  agentRowCount(store, "a2", options());
  assert.equal(agentRowCount(store, "a1", options()), estimate);
});

test("PgUp through a long record reaches the exact top: the first row of the record is on screen and the 'below' count is exact", () => {
  const store = storeOf(transcript(900));
  const entry = agent("a1");
  const h = new Harness([entry], { store });
  h.feed([entry], { store });
  h.press("Enter");
  let last = -1;
  for (let i = 0; i < 3000 && h.state.scroll !== last; i++) {
    last = h.state.scroll;
    h.press("PgUp");
  }
  const rows = computeLayout(h.state, h.context().data, h.size).contentRows;
  const exact = agentRowCountExact(store, "a1", { width: h.size.cols - 2, expanded: false });
  assert.equal(h.state.scroll, exact - rows);
  const win = agentContentWindow(store, "a1", { ...options({ width: h.size.cols - 2 }), rows, scroll: h.state.scroll, scrollTotal: h.state.scrollTotal });
  const all = agentContentLines(store, "a1", options({ width: h.size.cols - 2 }));
  assert.deepEqual(texts(win.lines), texts(all.slice(0, rows)));
  assert.equal(win.scroll.below, exact - rows);
});

test("an unscrolled initial state has no scroll total and new records leave the bottom view alone", () => {
  const store = storeOf(transcript(900));
  const win = agentContentWindow(store, "a1", { ...options(), rows: 8, scroll: initialState().scroll });
  assert.equal(win.lines.length, 8);
  assert.deepEqual(win.scroll, { below: 0, fresh: 0 });
});
