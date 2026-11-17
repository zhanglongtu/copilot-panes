// 只读时说清原因和怎么恢复。纯函数：把“这个 session 有没有登记记录、和扩展连得怎么样、扩展装了没有、实验功能开了没有”
// 变成界面要显示的话。界面（src/runtime.ts）和 copilot-panes doctor 都用它，所以两边对同一种情况的说法一致。

import { clipText } from "../ui/width.ts";
import type { BridgeState } from "./client.ts";
import type { ExtensionEnv } from "./extension-env.ts";

/** 刚连、或刚断开不到这么久，只说“正在连接”，不算出了问题。 */
export const CONNECTING_GRACE_MS = 3000;

export type ReadonlyWhy =
  | "connecting"
  | "not-installed"
  | "experimental-off"
  | "not-loaded"
  | "version"
  | "unsafe"
  | "no-socket"
  | "unreachable";

export interface ReadonlyInput {
  /** 这个 session 有有效的登记记录。 */
  registered: boolean;
  /** 登记记录里没有 socket 路径（扩展没能开成 socket，正在重试）。 */
  noSocket?: boolean;
  /** 和扩展的连接；还没建客户端（没有登记记录或没有 socket）是 null。statusSince 是 status 最近一次变化的时刻，不知道就不写。 */
  bridge: Pick<BridgeState, "status" | "statusSince" | "problemKind" | "problemDetail"> | null;
  env: ExtensionEnv;
  now: number;
  /** 已经等够了（doctor 连过一次、没连上）：不再用“正在连接”的宽限，直接说连不上。 */
  settled?: boolean;
}

export interface ReadonlyExplanation {
  why: ReadonlyWhy;
  /** 顶行用的短理由，如“只读：这个 session 没加载扩展”；正在连接时是“正在连接扩展…”。 */
  reason: string;
  /** 输入行和按键被拒绝时用的原因，写在“只读，不能发消息：”后面。 */
  cause: string;
  /** 顶行下面的提示行：原因和怎么恢复。 */
  notice: { tone: "attention" | "muted"; text: string };
}

const DETAIL_MAX_COLS = 36;

/** 为什么只读；扩展已经连上（不是只读）返回 null。 */
export function explainReadonly(input: ReadonlyInput): ReadonlyExplanation | null {
  const { bridge, env, now } = input;
  if (bridge?.status === "connected") return null;

  if (bridge !== null && bridge.status === "incompatible") {
    if (bridge.problemKind === "version") {
      return attention("version", "扩展和界面版本不一致", "扩展和界面的版本不一致", "扩展和界面的版本不一致。运行 copilot-panes install，再重启 Copilot CLI");
    }
    const detail = clipText(bridge.problemDetail ?? "", DETAIL_MAX_COLS).trim();
    return attention("unsafe", "连接没通过安全检查", "扩展的连接没通过安全检查", `扩展的连接没通过安全检查${detail === "" ? "" : `（${detail}）`}`);
  }

  if (bridge !== null) {
    const waited = bridge.statusSince === undefined || now < bridge.statusSince ? 0 : now - bridge.statusSince;
    if (waited < CONNECTING_GRACE_MS && input.settled !== true) return connecting();
    return attention("unreachable", "连不上扩展", "连不上扩展", "连不上扩展。重启 Copilot CLI，或运行 copilot-panes doctor 看原因");
  }

  if (input.registered) {
    return input.noSocket === true
      ? attention("no-socket", "扩展没能开成连接", "扩展没能开成连接", "扩展没能开成连接，正在重试。运行 copilot-panes doctor 看原因")
      : connecting();
  }

  if (!env.installed) {
    return attention("not-installed", "还没装扩展", "还没装扩展", "还没装扩展。运行 copilot-panes install，再重启 Copilot CLI");
  }
  if (!env.experimental) {
    return attention("experimental-off", "实验功能没开", "实验功能没开，扩展不会加载", "实验功能没开，扩展不会加载。运行 /settings experimental on 后重启");
  }
  return attention("not-loaded", "这个 session 没加载扩展", "这个 session 启动时还没装扩展", "这个 session 启动时还没装扩展。对它说“重新加载扩展”，或重启 Copilot CLI");
}

function connecting(): ReadonlyExplanation {
  return { why: "connecting", reason: "正在连接扩展…", cause: "扩展正在连接", notice: { tone: "muted", text: "正在连接扩展…" } };
}

function attention(why: ReadonlyWhy, reason: string, cause: string, text: string): ReadonlyExplanation {
  return { why, reason: `只读：${reason}`, cause, notice: { tone: "attention", text: `只读：${text}` } };
}
