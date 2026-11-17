import assert from "node:assert/strict";
import { test } from "node:test";
import { DEMO_KEYS, demoData } from "../helpers/demo-data.ts";
import type { ViewData } from "../../src/types/app.ts";
import { computeLayout, hiddenEndedCount } from "../../src/ui/views/layout.ts";
import { pageOffset } from "../../src/ui/views/rowkit.ts";
import { baseState } from "./body-support.ts";
import { entry } from "./views-support.ts";

const NOW = 1_800_000_000_250;
const sample = demoData(NOW, { settled: true });
const withEntries = (count: number): ViewData => ({ ...sample, entries: Array.from({ length: count }, (_, i) => entry({ key: `agent:n${i}`, id: `n${i}` })) });
const notice = { tone: "attention", text: "只读：这个 session 没有加载扩展" } as const;

test("the sample (80x24, nine entries) gets a seven-row list with a hint row, a title row and a ten-row content", () => {
  const layout = computeLayout(baseState({ selected: DEMO_KEYS.fixLogin }), sample, { cols: 80, rows: 24 });
  assert.deepEqual(layout, {
    statusRow: -1,
    listTop: 1,
    listRows: 7,
    listOffset: 0,
    listCollapsed: false,
    selectedIndex: 2,
    hintRow: 8,
    hiddenRow: -1,
    hiddenEnded: 0,
    titleRow: 9,
    contentTop: 10,
    contentRows: 10,
    noticeRow: 20,
    dividerRow: 21,
    inputTop: 22,
    inputRows: 1,
    keysRow: 23,
    showModel: true,
    showTokens: true,
  });
});

test("a pane with room for every entry has no hint row; the title row sits right under the list", () => {
  const layout = computeLayout(baseState({ selected: DEMO_KEYS.fixLogin }), sample, { cols: 110, rows: 40 });
  assert.deepEqual([layout.listRows, layout.hintRow, layout.titleRow, layout.contentTop, layout.contentRows], [9, -1, 10, 11, 25]);
  assert.deepEqual([layout.noticeRow, layout.dividerRow, layout.inputTop, layout.keysRow], [36, 37, 38, 39]);
});

test("a status notice takes the second row and the list one row; with 80x22 and seven entries the list is not cut", () => {
  const plain = computeLayout(baseState(), withEntries(7), { cols: 80, rows: 22 });
  assert.deepEqual([plain.statusRow, plain.listTop, plain.listRows, plain.hintRow, plain.titleRow, plain.contentRows], [-1, 1, 7, -1, 8, 9]);
  const flagged = computeLayout(baseState(), { ...withEntries(7), statusNotice: notice }, { cols: 80, rows: 22 });
  assert.deepEqual([flagged.statusRow, flagged.listTop, flagged.listRows, flagged.hintRow, flagged.titleRow, flagged.contentRows], [1, 2, 5, 7, 8, 9]);
  const quiet = computeLayout(baseState(), { ...withEntries(7), statusNotice: null }, { cols: 80, rows: 22 });
  assert.equal(quiet.statusRow, -1);
});

test("the second row comes from statusNotice only: a read-only extension without one (an ended session) has none", () => {
  const readOnly: ViewData = { ...sample, extension: { kind: "readonly", reason: "x" } };
  assert.equal(computeLayout(baseState(), readOnly, { cols: 80, rows: 24 }).statusRow, -1);
  assert.equal(computeLayout(baseState(), { ...readOnly, statusNotice: notice }, { cols: 80, rows: 24 }).statusRow, 1);
});

test("a taller input box takes rows from the content, not from the list", () => {
  const layout = computeLayout(baseState({ selected: DEMO_KEYS.fixLogin }), sample, { cols: 80, rows: 24 }, 3);
  assert.equal(layout.listRows, 7);
  assert.equal(layout.contentRows, 8);
  assert.equal(layout.dividerRow, 19);
  assert.equal(layout.inputTop, 20);
  assert.equal(layout.inputRows, 3);
  assert.equal(layout.keysRow, 23);
});

test("the model column goes below 60 columns and the token column below 48", () => {
  const at = (cols: number) => computeLayout(baseState(), sample, { cols, rows: 22 });
  assert.deepEqual([at(60).showModel, at(60).showTokens], [true, true]);
  assert.deepEqual([at(59).showModel, at(59).showTokens], [false, true]);
  assert.deepEqual([at(48).showModel, at(48).showTokens], [false, true]);
  assert.deepEqual([at(47).showModel, at(47).showTokens], [false, false]);
});

test("the list region takes at most 40% of the rows left after the fixed ones, and at least three; a cut list gives its last row to the hint", () => {
  const list = (count: number, rows: number) => {
    const l = computeLayout(baseState(), withEntries(count), { cols: 80, rows });
    return [l.listRows, l.hintRow >= 0 ? 1 : 0];
  };
  assert.deepEqual(list(12, 30), [9, 1]);
  assert.deepEqual(list(12, 21), [5, 1]);
  assert.deepEqual(list(12, 50), [12, 0]);
  assert.deepEqual(list(2, 30), [2, 0]);
  assert.deepEqual(list(0, 30), [1, 0]);
  assert.deepEqual(list(60, 60), [21, 1], "about twenty rows of a 60-row pane");
});

test("the list collapses (no rows at all) below 20 rows or when zoomed, and the title row follows the top row", () => {
  const layout = (rows: number, zoom = false) => computeLayout(baseState({ zoom, selected: "agent:n3" }), withEntries(7), { cols: 80, rows });
  assert.equal(layout(20).listCollapsed, false);
  assert.equal(layout(19).listCollapsed, true);
  assert.equal(layout(19).listRows, 0);
  assert.equal(layout(19).titleRow, 1);
  assert.equal(layout(19).selectedIndex, 3);
  assert.equal(layout(30, true).listRows, 0);
  assert.equal(layout(30, true).hintRow, -1);
  assert.equal(layout(30, true).contentRows, 30 - 6, "top, title, notice, divider, input and keys are the six fixed rows");
  const flagged = computeLayout(baseState({ zoom: true }), { ...withEntries(7), statusNotice: notice }, { cols: 80, rows: 30 });
  assert.deepEqual([flagged.statusRow, flagged.titleRow], [1, 2]);
});

test("the list pages by the selection: moving inside a page never scrolls, the last page is filled", () => {
  const layout = (selected: number) => computeLayout(baseState({ selected: `agent:n${selected}` }), withEntries(20), { cols: 80, rows: 20 });
  const offset = (selected: number) => layout(selected).listOffset;
  assert.equal(layout(0).listRows, 5);
  assert.deepEqual([0, 2, 4].map(offset), [0, 0, 0]);
  assert.deepEqual([5, 7, 9].map(offset), [5, 5, 5]);
  assert.deepEqual([15, 17, 19].map(offset), [15, 15, 15]);
  assert.equal(pageOffset(-1, 20, 6), 0);
  assert.equal(pageOffset(5, 4, 6), 0);
  assert.equal(pageOffset(19, 20, 6), 14);
});

test("collapsed-ended entries get a last row in the list, counted from the store; it stays when the list is cut", () => {
  const entries = sample.entries.filter((e) => e.status !== "done" && e.status !== "failed");
  const data: ViewData = { ...sample, entries };
  assert.equal(hiddenEndedCount(data), 3, "find-bug, migrate-db and npm run build are in the store but not in the list");
  assert.equal(hiddenEndedCount(sample), 0);
  const layout = computeLayout(baseState({ collapseEnded: true }), data, { cols: 80, rows: 24 });
  assert.deepEqual([layout.listRows, layout.hintRow, layout.hiddenRow, layout.hiddenEnded, layout.titleRow], [6, -1, 7, 3, 8]);
  const off = computeLayout(baseState({ collapseEnded: false }), data, { cols: 80, rows: 24 });
  assert.deepEqual([off.hiddenRow, off.hiddenEnded], [-1, 0]);
  const cut = computeLayout(baseState({ collapseEnded: true }), { ...data, entries: withEntries(12).entries }, { cols: 80, rows: 24 });
  assert.deepEqual([cut.listRows, cut.hintRow, cut.hiddenRow], [6, 7, 8]);
  const zoomed = computeLayout(baseState({ collapseEnded: true, zoom: true }), data, { cols: 80, rows: 24 });
  assert.equal(zoomed.hiddenRow, -1, "zoomed shows no list at all");
});

test("a pane too short for everything drops the divider, then the notice row, and never goes negative", () => {
  const layout = (rows: number) => computeLayout(baseState(), sample, { cols: 80, rows }, 1);
  assert.deepEqual([layout(6).dividerRow, layout(6).noticeRow, layout(6).contentRows], [3, 2, 0]);
  assert.deepEqual([layout(5).dividerRow, layout(5).noticeRow, layout(5).titleRow, layout(5).inputTop], [2, -1, 1, 3]);
  assert.deepEqual([layout(4).dividerRow, layout(4).noticeRow, layout(4).titleRow, layout(4).inputTop, layout(4).keysRow], [-1, -1, 1, 2, 3]);
  assert.deepEqual([layout(3).titleRow, layout(3).inputTop, layout(3).keysRow], [-1, 1, 2]);
  for (let rows = 0; rows < 40; rows++) {
    const l = layout(rows);
    assert.ok(l.contentRows >= 0 && l.listRows >= 0 && l.inputRows >= 0, `rows ${rows}`);
    assert.ok(rows === 0 || l.keysRow === rows - 1);
    if (rows >= 3) assert.ok(l.inputTop + l.inputRows <= l.keysRow, `the input stays above the key row at ${rows} rows`);
  }
});
