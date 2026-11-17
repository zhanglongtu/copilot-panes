// 版本号：源码直接运行时读 package.json；构建时只把版本号这一个字符串编进两个包，package.json 的其他内容不进包。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { version } from "../../src/version.ts";
import { REPO_ROOT, tempDir } from "../helpers/tmp.ts";

function build(dir: string, name: string, packageJson: object): { cli: Buffer; extension: Buffer } {
  const pkg = join(dir, `${name}.package.json`);
  const outdir = join(dir, name);
  writeFileSync(pkg, JSON.stringify(packageJson));
  const result = spawnSync(process.execPath, ["build.mjs"], { cwd: REPO_ROOT, encoding: "utf8", env: { ...process.env, BUILD_OUTDIR: outdir, BUILD_PACKAGE_JSON: pkg } });
  assert.equal(result.status, 0, result.stderr);
  return { cli: readFileSync(join(outdir, "copilot-panes.mjs")), extension: readFileSync(join(outdir, "extension.mjs")) };
}

test("run from source, the version is the one in package.json", () => {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as { version: string };
  assert.equal(version, pkg.version);
});

test("the bundles hold the version string and nothing else of package.json, so changing a script does not change the extension", () => {
  const dir = tempDir("vr-");
  try {
    const plain = build(dir.path, "plain", { name: "x", version: "1.2.3" });
    const withScript = build(dir.path, "script", { name: "x", version: "1.2.3", scripts: { deploy: "node deploy.mjs" }, devDependencies: { esbuild: "^1" } });
    assert.ok(plain.extension.equals(withScript.extension), "extension.mjs is byte for byte the same");
    assert.ok(plain.cli.equals(withScript.cli), "copilot-panes.mjs is byte for byte the same");
    for (const bundle of [plain.extension, plain.cli]) {
      const text = bundle.toString("utf8");
      assert.ok(text.includes('var version = "1.2.3";'));
      assert.ok(!text.includes("package.json") && !text.includes("devDependencies"));
    }
    const newer = build(dir.path, "newer", { name: "x", version: "9.9.9" });
    assert.ok(!plain.extension.equals(newer.extension));
    assert.ok(newer.extension.toString("utf8").includes('var version = "9.9.9";'));
  } finally {
    dir.cleanup();
  }
});
