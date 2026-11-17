// 名单“最近一步”、过程记录里工具调用那一行、模型短名、回复的第一句正文、显示用的路径。
import assert from "node:assert/strict";
import { test } from "node:test";
import { agentStep, commandStep, displayPath, firstBodyLine, programName, shortModel, toolLine, toolLineText, waitingText } from "../../src/model/describe.ts";
import type { SessionStore } from "../../src/model/store.ts";
import type { CommandRecord, ToolItem } from "../../src/types/model.ts";
import { bashBackground, bashEnd, bashStart, completed, ev, failedEvent, feed, say, shellCall, started, storeOf, taskCall, toolEnd, toolStart } from "./support.ts";

const HOME = "/home/u";
const SESSION = [ev("session.start", { selectedModel: "provider/large-1.0", context: { cwd: "/work/demo" } }), started("A", "fix-login", { model: "provider/medium-1.0" })];

function itemOf(store: SessionStore, callId: string): ToolItem {
  const item = store.transcript("A").find((entry): entry is ToolItem => entry.kind === "tool" && entry.toolCallId === callId);
  assert.ok(item, `tool item ${callId}`);
  return item;
}

function lineOf(store: SessionStore, callId: string): string {
  return toolLineText(toolLine(itemOf(store, callId), store, { home: HOME }));
}

// ───── 回复的第一句正文 ─────

test("a reply that starts with a heading gives the body, not the heading", () => {
  assert.equal(firstBodyLine("## 复核结果\n\n三道大题的评分标准都对得上。"), "三道大题的评分标准都对得上。");
});

test("headings, blank lines, code fences and rules are skipped and the first body line is used", () => {
  const cases: [string, string][] = [
    ["## 复核结果\n三道大题的评分标准都对得上", "三道大题的评分标准都对得上"],
    ["# 总结\n\n## 细节\n\n正文在这里", "正文在这里"],
    ["```\n代码里的一行\n```", "代码里的一行"],
    ["```python\nx = 1", "x = 1"],
    ["~~~\n内容", "内容"],
    ["---\n***\n___\n正文", "正文"],
    ["- - -\n正文", "正文"],
    ["标题\n=====\n正文", "标题"],
    ["   \n\n  \n正文在第四行", "正文在第四行"],
    ["#标签不是标题", "#标签不是标题"],
    ["####### 七个井号不是标题", "####### 七个井号不是标题"],
    ["# 只有一个标题", ""],
    ["```\n```", ""],
  ];
  for (const [text, want] of cases) assert.equal(firstBodyLine(text), want, text);
});

test("list marks, quote marks and double stars at the start of the line are removed", () => {
  const cases: [string, string][] = [
    ["**结论**：通过", "结论：通过"],
    ["* 星号条目", "星号条目"],
    ["+ 加号条目", "加号条目"],
    ["- 条目一\n- 条目二", "条目一"],
    ["> 引用的话", "引用的话"],
    ["> - 引用里的条目", "引用里的条目"],
    ["1. 第一步", "第一步"],
    ["2) 第二步", "第二步"],
    ["-5% 的变化", "-5% 的变化"],
    ["**", ""],
    ["**\n正文", "正文"],
    ["正文里的 **粗体** 也去掉", "正文里的 粗体 也去掉"],
    ["", ""],
    ["a\x07b   c", "a b c"],
  ];
  for (const [text, want] of cases) assert.equal(firstBodyLine(text), want, text);
  assert.equal(firstBodyLine(null as unknown as string), "");
});

// ───── 工具调用一行 ─────

test("toolLineText matches the lines of the design mock", () => {
  const store = storeOf(
    SESSION,
    toolStart("v1", "view", { path: "/work/demo/src/auth.ts", view_range: [40, 96] }, "A", 1),
    toolEnd("v1", "...", "A", 2),
    toolStart("g1", "grep", { pattern: "clearSession(", paths: ["/work/demo"] }, "A", 3),
    toolEnd("g1", "[grep content: 3 matches across 1 file(s) under /work/demo; delimited groups]\n\nsrc/auth.ts (3 match(es)):\n  71: clearSession()", "A", 4),
    toolStart("e1", "edit", { path: "/work/demo/src/auth.ts", old_str: "a", new_str: "b" }, "A", 5),
    toolEnd("e1", "File updated with changes.", "A", 6, { toolTelemetry: { metrics: { linesAdded: 4, linesRemoved: 3 } } }),
    taskCall("t-run", "A", 7, { name: "run-tests", model: "provider/small-1.0" }),
    started("R", "run-tests", { task: "t-run", model: "provider/small-1.0", at: 7.1 }),
  );
  assert.equal(lineOf(store, "v1"), "▸ 看  src/auth.ts 第 40 到 96 行");
  assert.equal(lineOf(store, "g1"), "▸ 搜  clearSession(  共 3 处");
  assert.equal(lineOf(store, "e1"), "▸ 改  src/auth.ts  +4 −3");
  assert.equal(lineOf(store, "t-run"), "▸ 起子 agent  run-tests  small-1.0");
});

test("toolLine for view: path shown relative to the cwd or the home, ranges, and a missing path", () => {
  const store = storeOf(
    SESSION,
    toolStart("v1", "view", { path: "/work/demo/README.md" }, "A", 1),
    toolStart("v2", "view", { path: "/work/demo/a.ts", view_range: [30, -1] }, "A", 2),
    toolStart("v3", "view", { path: "/home/u/notes/x.md", view_range: [1, 20] }, "A", 3),
    toolStart("v4", "view", { path: "/etc/hosts" }, "A", 4),
    toolStart("v5", "view", {}, "A", 5),
    toolStart("v6", "view", { path: 5, view_range: "nope" }, "A", 6),
    toolStart("v7", "view", "not an object", "A", 7),
  );
  assert.deepEqual(toolLine(itemOf(store, "v1"), store, { home: HOME }), { verb: "看", target: "README.md", detail: "" });
  assert.equal(toolLine(itemOf(store, "v2"), store, { home: HOME }).target, "a.ts 第 30 行起");
  assert.equal(toolLine(itemOf(store, "v3"), store, { home: HOME }).target, "~/notes/x.md 第 1 到 20 行");
  assert.equal(toolLine(itemOf(store, "v4"), store, { home: HOME }).target, "/etc/hosts");
  for (const id of ["v5", "v6", "v7"]) assert.equal(toolLine(itemOf(store, id), store, { home: HOME }).target, "", id);
});

test("toolLine for grep and glob counts matches and files only when the result says so", () => {
  const store = storeOf(
    SESSION,
    toolStart("g1", "grep", { pattern: "foo\nbar" }, "A", 1),
    toolStart("g2", "grep", { pattern: "x" }, "A", 2),
    toolEnd("g2", "No matches found.", "A", 3),
    toolStart("g3", "grep", { pattern: "y" }, "A", 4),
    toolEnd("g3", "[grep files_with_matches: some format nobody has seen]", "A", 5),
    toolStart("g4", "grep", { pattern: "z" }, "A", 6),
    ev("tool.execution_complete", { toolCallId: "g4", success: false, result: { content: "[grep content: 9 matches across 1 file(s)" } }, "A", 7),
    toolStart("l1", "glob", { pattern: "**/*.ts" }, "A", 8),
    toolEnd("l1", "[glob: 12 path(s) under /work/demo; grouped by directory]", "A", 9, { toolTelemetry: { metrics: { file_count: 125 } } }),
    toolStart("l2", "glob", { pattern: "*.md" }, "A", 10),
    toolEnd("l2", "[glob: 7 path(s) under /work/demo; grouped by directory]", "A", 11),
    toolStart("l3", "glob", { pattern: "*.zz" }, "A", 12),
    toolEnd("l3", "No files matched the pattern.", "A", 13),
  );
  const detail = (id: string) => toolLine(itemOf(store, id), store, { home: HOME }).detail;
  assert.deepEqual(
    ["g1", "g2", "g3", "g4", "l1", "l2", "l3"].map(detail),
    ["", "共 0 处", "", "", "共 125 个", "共 7 个", "共 0 个"],
  );
  assert.equal(toolLine(itemOf(store, "g1"), store).target, "foo bar");
});

test("toolLine for edit: line counts from the telemetry, else from the diff, else none; create shows the path", () => {
  const diff = "\ndiff --git a/x b/x\nindex 0000000..0000000 100644\n--- a/x\n+++ b/x\n@@ -1,3 +1,3 @@\n-old 1\n-old 2\n+new 1\n+new 2\n+new 3\n same\n";
  const store = storeOf(
    SESSION,
    toolStart("e1", "edit", { path: "/work/demo/x" }, "A", 1),
    ev("tool.execution_complete", { toolCallId: "e1", success: true, result: { content: "updated", detailedContent: diff } }, "A", 2),
    toolStart("e2", "edit", { path: "/work/demo/y" }, "A", 3),
    toolEnd("e2", "updated", "A", 4),
    toolStart("e3", "edit", { path: "/work/demo/z" }, "A", 5),
    toolStart("n1", "create", { path: "/work/demo/new.md", file_text: "hello" }, "A", 6),
    toolEnd("n1", "Created file", "A", 7),
  );
  assert.equal(lineOf(store, "e1"), "▸ 改  x  +3 −2");
  assert.equal(lineOf(store, "e2"), "▸ 改  y");
  assert.equal(lineOf(store, "e3"), "▸ 改  z");
  assert.equal(lineOf(store, "n1"), "▸ 建  new.md");
});

test("toolLine for bash: first line with folded spaces, then the exit code or 'moved to background'", () => {
  const store = storeOf(
    SESSION,
    bashStart("b1", "\n  python3   run.py --a\n  --b", "A", 1),
    bashStart("b2", "make test", "A", 2),
    bashEnd("b2", "boom\n", 2, "A", 5),
    bashStart("b3", "sleep 500", "A", 6),
    bashBackground("b3", "7", "A", 36, "<command with shellId: 7 is still running after 30 seconds>"),
    bashStart("b4", "dir", "A", 40),
  );
  assert.equal(lineOf(store, "b1"), "▸ 跑  python3 run.py --a");
  assert.equal(lineOf(store, "b2"), "▸ 跑  make test  退出码 2");
  assert.equal(lineOf(store, "b3"), "▸ 跑  sleep 500  转后台");
  feed(store, ev("system.notification", { kind: { type: "shell_completed", shellId: "7", exitCode: 0 } }, null, 90));
  assert.equal(lineOf(store, "b3"), "▸ 跑  sleep 500  退出码 0");
  assert.equal(toolLine(itemOf(store, "b4"), store).verb, "跑");
});

test("toolLine for task: the argument name, else the child's name, else the description; the child's model", () => {
  const store = storeOf(
    SESSION,
    taskCall("t1", "A", 1, { name: "run-tests", model: "provider/small-1.0" }),
    taskCall("t2", "A", 2, { name: undefined, description: "写文档", model: "provider/large-1.5" }),
    taskCall("t3", "A", 3, { name: undefined, description: undefined }),
    started("C", "child-three", { task: "t3", model: "provider/medium-1.0", at: 3.1 }),
  );
  assert.deepEqual(toolLine(itemOf(store, "t1"), store), { verb: "起子 agent", target: "run-tests", detail: "small-1.0" });
  assert.deepEqual(toolLine(itemOf(store, "t2"), store), { verb: "起子 agent", target: "写文档", detail: "large-1.5" });
  assert.deepEqual(toolLine(itemOf(store, "t3"), store), { verb: "起子 agent", target: "child-three", detail: "medium-1.0" });
});

test("toolLine for read_bash and stop_bash names the command, or the shellId when the command is unknown", () => {
  const store = storeOf(
    SESSION,
    bashStart("c1", "pytest -v\n  tests/", "A", 1, { mode: "async", shellId: "b" }),
    bashBackground("c1", "b", "A", 1.1),
    shellCall("r1", "read_bash", "b", "...", 5, "A"),
    shellCall("s1", "stop_bash", "b", "stopped", 6, "A"),
    shellCall("r2", "read_bash", "ghost", "...", 7, "A"),
    toolStart("r3", "read_bash", {}, "A", 8),
  );
  assert.equal(lineOf(store, "r1"), "▸ 读输出  pytest -v");
  assert.equal(lineOf(store, "s1"), "▸ 停命令  pytest -v");
  assert.equal(lineOf(store, "r2"), "▸ 读输出  ghost");
  assert.equal(lineOf(store, "r3"), "▸ 读输出  ");
});

test("toolLine for web_fetch, web_search and an unknown tool (verb is the tool name, target the first usable argument)", () => {
  const store = storeOf(
    SESSION,
    toolStart("w1", "web_fetch", { url: "https://example.com/a" }, "A", 1),
    toolStart("w2", "web_search", { query: "node  test\nrunner" }, "A", 2),
    toolStart("u1", "fetch_docs", { name: "x", prompt: "p", query: "  " }, "A", 3),
    toolStart("u2", "read_agent", { agent_id: "agent-7", wait: true }, "A", 4),
    toolStart("u3", "skill", {}, "A", 5),
    toolStart("u4", "sql", { query: 5, description: ["x"] }, "A", 6),
    toolStart("u5", "toString", { path: "/work/demo/a/b.txt" }, "A", 7),
  );
  assert.equal(lineOf(store, "w1"), "▸ 取网页  https://example.com/a");
  assert.equal(lineOf(store, "w2"), "▸ 搜网页  node test runner");
  assert.deepEqual(toolLine(itemOf(store, "u1"), store), { verb: "fetch_docs", target: "x", detail: "" });
  assert.deepEqual(toolLine(itemOf(store, "u2"), store), { verb: "read_agent", target: "agent-7", detail: "" });
  assert.deepEqual(toolLine(itemOf(store, "u3"), store), { verb: "skill", target: "", detail: "" });
  assert.deepEqual(toolLine(itemOf(store, "u4"), store), { verb: "sql", target: "", detail: "" });
  assert.equal(toolLine(itemOf(store, "u5"), store, { home: HOME }).verb, "toString");
});

test("waitingText: a sync task or command is awaited, a background one and a finished call are not", () => {
  const store = storeOf(
    SESSION,
    taskCall("t1", "A", 1, { name: "run-tests", mode: "sync" }),
    taskCall("t2", "A", 2, { name: "bg", mode: "background" }),
    taskCall("t3", "A", 3, { name: undefined, description: undefined }),
    bashStart("b1", "FOO=1 pytest -x", "A", 4),
    bashStart("b2", "serve", "A", 5, { mode: "async", shellId: "s" }),
    toolStart("v1", "view", { path: "/x" }, "A", 6),
    bashStart("b3", "ls", "A", 7),
    bashEnd("b3", "", 0, "A", 8),
  );
  const waiting = (id: string) => waitingText(itemOf(store, id), store);
  assert.deepEqual(["t1", "t2", "t3", "b1", "b2", "v1", "b3"].map(waiting), ["等 run-tests 交回结果", null, "等 子 agent 交回结果", "等 pytest 跑完", null, null, null]);
});

// ───── 子 agent 和命令的“最近一步” ─────

test("agentStep for a running agent: waiting for a task, the program of a command, or verb and target of other tools", () => {
  const step = (store: SessionStore) => agentStep(store.agent("A")!, "running", store);
  assert.equal(step(storeOf(SESSION)), "");
  assert.equal(step(storeOf(SESSION, taskCall("t1", "A", 1, { name: "run-tests", mode: "sync" }))), "等 run-tests 交回结果");
  assert.equal(step(storeOf(SESSION, taskCall("t1", "A", 1, { name: "bg", mode: "background" }))), "起子 agent bg");
  assert.equal(step(storeOf(SESSION, toolStart("v1", "view", { path: "/work/demo/src/auth.ts", view_range: [1, 9] }, "A", 1))), "看 auth.ts");
  assert.equal(step(storeOf(SESSION, toolStart("g1", "grep", { pattern: "clearSession(", path: "/work/demo/src" }, "A", 1))), "搜 clearSession(");
  assert.equal(step(storeOf(SESSION, toolStart("e1", "edit", { path: "/a/b/c.ts" }, "A", 1))), "改 c.ts");
  assert.equal(step(storeOf(SESSION, toolStart("u1", "skill", {}, "A", 1))), "skill");
  assert.equal(step(storeOf(SESSION, toolStart("u1", "view", { path: "/a/b.ts" }, "A", 1), toolEnd("u1", "x", "A", 2))), "看 b.ts");
  // 最近一次工具调用才算，前面的不算
  assert.equal(step(storeOf(SESSION, toolStart("v1", "view", { path: "/a/b.ts" }, "A", 1), bashStart("b1", "pytest -v tests/", "A", 2))), "跑 pytest");
});

test("the program name of a command: assignments, paths, interpreters, cd prefixes and quoting", () => {
  const cases: [string, string][] = [
    ["pytest -v tests/", "pytest"],
    ["FOO=1 BAR='a b' make test", "make"],
    ["/usr/bin/make -j8", "make"],
    ["./run.sh --x", "run.sh"],
    ["python3 -u score.py --run nov15", "score.py"],
    ["python -m pytest -x", "pytest"],
    ["python3.12 tests/run.py", "run.py"],
    ["node scripts/build.js", "build.js"],
    ["npx vitest run", "vitest"],
    ["bash deploy.sh", "deploy.sh"],
    ["bash -lc 'cd /repo && make test'", "make"],
    ["sh -c \"echo hi\"", "echo"],
    ["cd /repo && npm test", "npm"],
    ["cd a; cd b && FOO=1 pytest", "pytest"],
    ["python3 - <<'EOF'\nprint(1)\nEOF", "python3"],
    ["python3 > out.txt script.py", "script.py"],
    ["python3", "python3"],
    ["node -v", "node"],
    ["cd /repo", "cd"],
    ["", ""],
    ["   ", ""],
    ["FOO=1", ""],
    ["pytest 2>&1 | tail -5", "pytest"],
    ["timeout 170 node --test test/", "test"],
    ["stdbuf -oL python3 -u run.py", "run.py"],
    ["time FOO=1 make -j4", "make"],
    ["sudo -n nohup ./serve.sh", "serve.sh"],
    ["timeout 5", "timeout"],
    ["env", "env"],
    ["env FOO=1", "env"],
  ];
  for (const [command, want] of cases) assert.equal(programName(command), want, command);
});

test("agentStep for idle, done, failed and stopped", () => {
  const store = storeOf(SESSION, say("A", "## 结论\n\n**全部**通过", 1), started("B", "quiet"), started("C", "boom"), failedEvent("C", "t-C", "model\noverloaded", 5));
  const a = store.agent("A")!;
  assert.equal(agentStep(a, "idle", store), "做完一轮，等你发话");
  assert.equal(agentStep(a, "done", store), "全部通过");
  assert.equal(agentStep(store.agent("B")!, "done", store), "做完了");
  assert.equal(agentStep(store.agent("C")!, "failed", store), "model overloaded");
  assert.equal(agentStep(store.agent("B")!, "failed", store), "失败了");
  assert.equal(agentStep(a, "stopped", store), "停了");
});

test("commandStep shows progress while running, else the last line, and the exit code when it ended", () => {
  const store = storeOf(bashStart("c1", "make", null, 0), bashEnd("c1", "", 2, null, 3), bashStart("c2", "ls", null, 0), bashEnd("c2", "", 0, null, 3), bashStart("c3", "kill", null, 0));
  const [failed, ok, plain] = store.commands() as [CommandRecord, CommandRecord, CommandRecord];
  assert.equal(commandStep(failed, "running", "[###-------] 12/40 30% 已用 1m20s 还要约 3m10s task_012"), "12/40 30%");
  assert.equal(commandStep(failed, "running", "compiling foo.c"), "compiling foo.c");
  assert.equal(commandStep(failed, "running", ""), "");
  assert.equal(commandStep(failed, "failed", "ignored"), "退出码 2");
  assert.equal(commandStep(ok, "done", ""), "退出码 0");
  assert.equal(commandStep(plain, "failed", ""), "失败了");
  assert.equal(commandStep(plain, "done", ""), "做完了");
  assert.equal(commandStep(plain, "stopped", ""), "停了");
});

test("an agent that finished with a token count but no reply says it finished", () => {
  const store = storeOf(started("A", "alpha"), completed("A", "t-A", { tokens: 41_000, at: 5 }));
  assert.equal(agentStep(store.agent("A")!, "done", store), "做完了");
});

// ───── 模型短名和路径 ─────

test("shortModel drops the provider prefix (everything up to the last slash) and a leading claude-", () => {
  assert.equal(shortModel("provider/medium-1.0"), "medium-1.0");
  assert.equal(shortModel("provider/claude-small-1.0"), "small-1.0");
  assert.equal(shortModel("provider-b/tiny-1.0"), "tiny-1.0");
  assert.equal(shortModel("vendor/provider-b/medium-1.0"), "medium-1.0");
  assert.equal(shortModel("large-2.0"), "large-2.0");
  assert.equal(shortModel("claude-large-1"), "large-1");
  assert.equal(shortModel(""), null);
  assert.equal(shortModel(null), null);
  assert.equal(shortModel("provider/"), null);
  assert.equal(shortModel("provider/claude-"), null);
});

test("displayPath: relative to the cwd, ~ for the home, otherwise unchanged", () => {
  assert.equal(displayPath("/work/demo/src/a.ts", "/work/demo", HOME), "src/a.ts");
  assert.equal(displayPath("/work/demo", "/work/demo/", HOME), ".");
  assert.equal(displayPath("/work/demo2/a.ts", "/work/demo", HOME), "/work/demo2/a.ts");
  assert.equal(displayPath("/home/u/x/y.md", "/work/demo", HOME), "~/x/y.md");
  assert.equal(displayPath("/home/u/x/y.md", null, HOME), "~/x/y.md");
  assert.equal(displayPath("/home/u", null, `${HOME}/`), "~");
  assert.equal(displayPath("/home/u/work/demo/a", "/home/u/work/demo", HOME), "a");
  assert.equal(displayPath("/etc/hosts", "/work/demo", HOME), "/etc/hosts");
  assert.equal(displayPath("src/a.ts", "/work/demo", HOME), "src/a.ts");
  assert.equal(displayPath("/a/b", "/", ""), "/a/b");
});
