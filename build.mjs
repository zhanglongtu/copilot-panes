import { chmod, readFile } from "node:fs/promises";
import { join } from "node:path";
import { build } from "esbuild";
import { versionOnly } from "./scripts/version-plugin.mjs";

// BUILD_OUTDIR 让脚本把产物写到别处（例如联调用的 .scratch/），不动 dist/。
const outdir = process.env.BUILD_OUTDIR || "dist";

// 版本号只把这一个字符串编进包里，不把整个 package.json 编进去：src/version.ts 在包里被换成一行常量（scripts/version-plugin.mjs）。
// 否则往 package.json 里加个脚本，扩展的包就变了，doctor 会报“扩展版本不一样”。BUILD_PACKAGE_JSON 只给测试用。
const { version } = JSON.parse(await readFile(process.env.BUILD_PACKAGE_JSON || "package.json", "utf8"));

const common = {
  plugins: [versionOnly(version)],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  logLevel: "info",
};

await build({
  ...common,
  entryPoints: ["src/cli.ts"],
  outfile: join(outdir, "copilot-panes.mjs"),
  banner: { js: "#!/usr/bin/env node" },
});
await chmod(join(outdir, "copilot-panes.mjs"), 0o755);

// The SDK is provided by Copilot CLI when it loads the extension.
await build({
  ...common,
  entryPoints: ["extension/src/extension.ts"],
  outfile: join(outdir, "extension.mjs"),
  external: ["@github/copilot-sdk", "@github/copilot-sdk/*"],
});
