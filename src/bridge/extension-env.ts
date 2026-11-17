// 装扩展要满足的两个前提，在文件系统里查：扩展文件在不在、Copilot CLI 的实验功能开没开。
// 界面换 session 时查一次，之后每 30 秒一次（见 src/runtime.ts）；doctor 逐项报告同样的结果。

import { existsSync, readFileSync } from "node:fs";
import { extensionInstallPath, settingsPath } from "../paths.ts";
import type { PathEnv } from "../paths.ts";

export interface ExtensionEnv {
  /** $COPILOT_HOME/extensions/copilot-panes/extension.mjs 存在。 */
  installed: boolean;
  /** settings.json 里 experimental 是 true；读不到文件或不是 true 都是 false（Copilot CLI 默认不开）。 */
  experimental: boolean;
}

/** settings.json 的内容里 experimental 是不是 true；不是合法 JSON 时退回看有没有 "experimental": true 这段文字。 */
export function isExperimentalOn(text: string): boolean {
  try {
    return (JSON.parse(text) as { experimental?: unknown }).experimental === true;
  } catch {
    return /"experimental"\s*:\s*true/.test(text);
  }
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

export function readExtensionEnv(env: PathEnv, home: string): ExtensionEnv {
  const settings = readText(settingsPath(env, home));
  return {
    installed: existsSync(extensionInstallPath(env, home)),
    experimental: settings !== null && isExperimentalOn(settings),
  };
}
