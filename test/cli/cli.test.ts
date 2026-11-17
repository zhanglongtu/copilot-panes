import assert from "node:assert/strict";
import { test } from "node:test";
import { bundledExtensionPath, parseArgs, USAGE } from "../../src/cli.ts";

function ok(argv: string[]) {
  const parsed = parseArgs(argv);
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.error);
  return parsed.options;
}

function bad(argv: string[]): string {
  const parsed = parseArgs(argv);
  assert.ok(!parsed.ok);
  return parsed.error;
}

test("no arguments run the interface with the defaults", () => {
  assert.deepEqual(ok([]), {
    command: "run",
    sessionId: null,
    stateDir: null,
    dataDir: null,
    theme: null,
    bell: true,
    demo: false,
    dryRun: false,
    version: false,
    help: false,
  });
});

test("parseArgs reads every option in the usage text", () => {
  const options = ok(["--session", "abc", "--session-state-dir", "/s", "--data-dir", "/d", "--light", "--no-bell", "--demo"]);
  assert.equal(options.sessionId, "abc");
  assert.equal(options.stateDir, "/s");
  assert.equal(options.dataDir, "/d");
  assert.equal(options.theme, "light");
  assert.equal(options.bell, false);
  assert.equal(options.demo, true);
  assert.equal(ok(["--dark"]).theme, "dark");
  assert.equal(ok(["--version"]).version, true);
  assert.equal(ok(["--help"]).help, true);
  assert.equal(ok(["-h"]).help, true);
  for (const option of USAGE.match(/--[a-z-]+/g) ?? []) assert.ok(parseArgs(argvFor(option)).ok, `${option} is in the usage text but not accepted`);
});

/** 把说明里出现的选项变成一条能通过解析的命令行。 */
function argvFor(option: string): string[] {
  if (option === "--session" || option === "--session-state-dir" || option === "--data-dir") return [option, "x"];
  if (option === "--dry-run") return ["install", option];
  return [option];
}

test("--option=value works too", () => {
  assert.equal(ok(["--session=abc"]).sessionId, "abc");
  assert.equal(ok(["--data-dir=/d"]).dataDir, "/d");
});

test("install and doctor are subcommands", () => {
  assert.equal(ok(["install"]).command, "install");
  assert.equal(ok(["install", "--dry-run"]).dryRun, true);
  assert.equal(ok(["doctor", "--data-dir", "/d"]).command, "doctor");
});

test("unknown options, subcommands and misplaced options are errors in Chinese", () => {
  assert.match(bad(["--nope"]), /不认识的选项：--nope/);
  assert.match(bad(["explode"]), /不认识的子命令/);
  assert.match(bad(["install", "doctor"]), /多出一个参数/);
  assert.match(bad(["--session"]), /--session 后面要跟一个值/);
  assert.match(bad(["--session", "--demo"]), /--session 后面要跟一个值/);
  assert.match(bad(["--light", "--dark"]), /只能用一个/);
  assert.match(bad(["--dry-run"]), /只能和 install/);
  assert.match(bad(["doctor", "--demo"]), /不能和子命令/);
});

test("the usage text is Chinese and fits one screen", () => {
  assert.ok(USAGE.split("\n").length <= 24);
  assert.match(USAGE, /用法/);
});

test("the extension is looked up next to the bundle, or in dist/ when run from src/", () => {
  assert.equal(bundledExtensionPath("/x/dist/copilot-panes.mjs"), "/x/dist/extension.mjs");
  assert.equal(bundledExtensionPath("/repo/src/cli.ts"), "/repo/dist/extension.mjs");
});
