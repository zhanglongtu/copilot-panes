// esbuild 插件：包里的 src/version.ts 换成一行 `export const version = "x.y.z"`，不把整个 package.json 编进去。
// build.mjs 和打包测试（test/extension/bundle.test.ts）都用它：没有它，包里的 version.ts 会在运行时去找 package.json，
// 而装在 ~/.copilot/extensions/ 里的扩展旁边没有这个文件。
export function versionOnly(version) {
  return {
    name: "version-only",
    setup(b) {
      b.onLoad({ filter: /[\\/]src[\\/]version\.ts$/ }, () => ({ contents: `export const version = ${JSON.stringify(version)};\n`, loader: "ts" }));
    },
  };
}
