// npm run deploy：类型检查、构建、测试都通过后，把 dist/ 里的两个文件原子地复制到稳定目录。
// copilot-panes 命令应该指向稳定目录里的副本，这样开发中的构建不会影响正在用的版本，只有 deploy 会。
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const target = process.env.COPILOT_PANES_DEPLOY_DIR || join(homedir(), ".local", "share", "copilot-panes", "current");
const files = [
  { name: "copilot-panes.mjs", mode: 0o755 },
  { name: "extension.mjs", mode: 0o644 },
];

function run(label, args) {
  console.log(`[deploy] ${label}：npm ${args.join(" ")}`);
  const r = spawnSync("npm", args, { cwd: root, stdio: "inherit" });
  if (r.status !== 0) {
    console.error(`[deploy] ${label}没有通过，没有复制任何文件。`);
    process.exit(r.status ?? 1);
  }
}

run("类型检查", ["run", "typecheck"]);
run("构建", ["run", "build"]);
run("测试", ["test"]);

for (const f of files) {
  if (!existsSync(join(root, "dist", f.name))) {
    console.error(`[deploy] 构建后找不到 dist/${f.name}，没有复制任何文件。`);
    process.exit(1);
  }
}

function sameContent(a, b) {
  return existsSync(a) && existsSync(b) && readFileSync(a).equals(readFileSync(b));
}

const extensionChanged = !sameContent(join(root, "dist", "extension.mjs"), join(target, "extension.mjs"));

mkdirSync(target, { recursive: true, mode: 0o755 });
for (const f of files) {
  const tmp = join(target, `.${f.name}.${process.pid}.tmp`);
  copyFileSync(join(root, "dist", f.name), tmp);
  chmodSync(tmp, f.mode);
  renameSync(tmp, join(target, f.name));
  console.log(`[deploy] 已更新 ${join(target, f.name)}`);
}

console.log("[deploy] 完成：下次运行 copilot-panes 就是新版本；已经在跑的界面按 q 退出后重新运行。");
if (extensionChanged) {
  console.log("[deploy] 扩展有变化：还要运行 copilot-panes install 并重启 Copilot CLI。");
}
