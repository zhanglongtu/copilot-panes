// 每个测试进程启动时先加载这个文件（package.json 的 test 脚本里的 --import）：把主目录换成一个空的临时目录，并清掉会影响测试的环境变量。
// 这样测试不会读到、也不会写到真实的 ~/.copilot，在 tmux 里或 Copilot CLI 的进程里运行 npm test 结果也一样。
// 单独运行一个测试文件时也要带上：node --import ./test/helpers/isolate-home.ts --test test/xxx.test.ts

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL("../..", import.meta.url)), ".scratch", "tmp");
mkdirSync(root, { recursive: true });
const home = mkdtempSync(join(root, "h-"));
process.env.HOME = home;
process.on("exit", () => rmSync(home, { recursive: true, force: true }));

// 目录和终端环境：这些变量决定代码去读哪里、认为自己在哪个 tmux 里。
for (const name of Object.keys(process.env)) {
  if (name.startsWith("COPILOT_") || name === "TMUX" || name === "TMUX_PANE" || name === "SESSION_ID" || name === "COLORFGBG" || name === "XDG_RUNTIME_DIR") {
    delete process.env[name];
  }
}
