// 扩展的入口：Copilot CLI 为每个 session 启动一个扩展进程并运行这个文件（打包成 dist/extension.mjs）。
// 这里只做一件事：从 SDK 拿到 joinSession，join 当前 session，把真的 session 交给 runWithSession（bootstrap.ts）。
// 其余逻辑都在别的文件里，能用假的 session 测试。没有开关：装上就一直工作。

import { runWithSession } from "./bootstrap.ts";
import type { PanesSession } from "./sdk.ts";

/** 环境变量 COPILOT_PANES_NO_START 为 "1" 时不启动（测试导入这个文件时用）。 */
export const NO_START_ENV = "COPILOT_PANES_NO_START";

/** SDK 的模块名。放在变量里，tsc 不去解析它，esbuild 也原样保留这个动态 import（SDK 由 Copilot CLI 提供）。 */
export const SDK_MODULE = "@github/copilot-sdk/extension";

interface SdkModule {
  joinSession(config?: Record<string, never>): Promise<unknown>;
}

/**
 * 真正的启动流程：`await import(SDK_MODULE)` 取 joinSession，`joinSession({})` join 当前 session（session ID 以
 * session.sessionId 为准），再交给 runWithSession。出错时由调用方写 stderr。
 */
export async function runExtension(): Promise<void> {
  const sdk = (await import(SDK_MODULE)) as SdkModule;
  const session = await sdk.joinSession({});
  await runWithSession(session as PanesSession);
}

// 只在 Copilot CLI 启动的扩展进程里自动运行（那里一定有 SESSION_ID）。
if (process.env[NO_START_ENV] !== "1" && process.env.SESSION_ID) {
  runExtension().catch((e: unknown) => {
    process.stderr.write(`copilot-panes 扩展没有启动：${e instanceof Error ? e.message : String(e)}\n`);
  });
}
