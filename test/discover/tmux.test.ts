import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { symlinkSync } from "node:fs";
import { join } from "node:path";
import { locateSelf } from "../../src/discover/candidates.ts";
import { readProcTable } from "../../src/discover/procs.ts";
import { realTmux, windowPanes } from "../../src/discover/tmux.ts";
import type { TmuxRunner } from "../../src/discover/tmux.ts";
import { tempDir } from "../helpers/tmp.ts";

const LIST_FORMAT = "#{pane_id} #{pane_pid} #{window_id}";

test("list-panes output is parsed and malformed lines are skipped (fake runner, no real tmux)", async () => {
  const calls: Array<readonly string[]> = [];
  const run: TmuxRunner = async (args) => {
    calls.push(args);
    return ["%1 1000 @0", "%2 2000 @0", "", "garbage", "%x 3000 @0", "%3 abc @0", "%4 4000", "%5 5000 @0 extra", "%6 0 @0", "%7 7000 @1\r"].join("\n") + "\n";
  };
  const panes = await windowPanes("%2", run);
  assert.deepEqual(calls, [["list-panes", "-t", "%2", "-F", LIST_FORMAT]]);
  assert.deepEqual(panes, [
    { paneId: "%1", panePid: 1000, windowId: "@0" },
    { paneId: "%2", panePid: 2000, windowId: "@0" },
    { paneId: "%7", panePid: 7000, windowId: "@1" },
  ]);
});

test("a failing tmux gives an empty list", async () => {
  assert.deepEqual(await windowPanes("%1", () => Promise.reject(new Error("no server running"))), []);
  assert.deepEqual(await windowPanes("%1", () => Promise.resolve("")), []);
});

const hasTmux = spawnSync("tmux", ["-V"]).status === 0;

test(
  "a real tmux server of our own: realTmux, windowPanes and locateSelf find a copilot process in the other pane",
  { skip: !hasTmux && "tmux is not installed" },
  async () => {
    const dir = tempDir("m");
    const serverName = `cp-disc-${process.pid}`;
    // 套接字放在临时目录里，不写系统的 /tmp；-L 让它不碰用户的默认 tmux 服务
    const savedTmpdir = process.env.TMUX_TMPDIR;
    const savedTmux = process.env.TMUX;
    process.env.TMUX_TMPDIR = dir.path;
    delete process.env.TMUX;
    const real = realTmux();
    const tmux: TmuxRunner = (args) => real(["-L", serverName, "-f", "/dev/null", ...args]);
    let fakeCopilotPid = 0;
    try {
      const fakeCopilot = join(dir.path, "copilot");
      // A symlink to node, not a copy of sleep: where coreutils is one multi-call binary, a copy named "copilot" would exit at once.
      symlinkSync(process.execPath, fakeCopilot);
      await tmux(["new-session", "-d", "-s", "t", "-x", "100", "-y", "30", "sleep 300"]);
      await tmux(["split-window", "-t", "t", `sh -c '${fakeCopilot} -e "setTimeout(() => {}, 300000)"; sleep 1'`]);
      const ids = (await tmux(["list-panes", "-t", "t", "-F", "#{pane_id}"])).trim().split("\n");
      assert.equal(ids.length, 2);
      const [selfPane, otherPane] = ids as [string, string];

      const panes = await windowPanes(selfPane, tmux);
      assert.deepEqual(panes.map((p) => p.paneId), ids);
      assert.equal(new Set(panes.map((p) => p.windowId)).size, 1);

      const locate = (pane: string) => locateSelf({ cwd: "/work", tmuxPane: pane, run: tmux, procTable: readProcTable() });
      let located = await locate(selfPane);
      const deadline = Date.now() + 15_000;
      while ((located.tmux?.windowCopilotPids.length ?? 0) === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        located = await locate(selfPane);
      }
      assert.equal(located.cwd, "/work");
      assert.deepEqual(located.tmux?.windowPanes, [otherPane]);
      assert.equal(located.tmux?.paneId, selfPane);
      assert.equal(located.tmux?.windowCopilotPids.length, 1);
      fakeCopilotPid = located.tmux!.windowCopilotPids[0]!;
      const table = readProcTable();
      assert.equal(table.get(fakeCopilotPid)?.comm, "copilot");
      assert.equal(table.get(fakeCopilotPid)?.argv[0], fakeCopilot);
      // 从另一个 pane 看，自己这个 pane 里没有 copilot
      assert.deepEqual((await locate(otherPane)).tmux?.windowCopilotPids, []);
    } finally {
      await tmux(["kill-server"]).catch(() => {});
      const gone = Date.now() + 8000;
      while (fakeCopilotPid && readProcTable().get(fakeCopilotPid)?.comm === "copilot" && Date.now() < gone) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const stillRunning = await tmux(["list-sessions"]).then(
        () => true,
        () => false,
      );
      if (savedTmpdir === undefined) delete process.env.TMUX_TMPDIR;
      else process.env.TMUX_TMPDIR = savedTmpdir;
      if (savedTmux !== undefined) process.env.TMUX = savedTmux;
      dir.cleanup();
      assert.equal(stillRunning, false, "the test tmux server was left running");
    }
  },
);
