// 找 session 用的数据形状：候选 session、界面自己在哪、当前接着哪个，以及选择的结果。
// 选哪个由 src/discover/choose.ts 的纯函数 chooseSession 决定，它只看这里的数据，不碰文件系统。

import type { Registration } from "../protocol.ts";

/** 一个可能要显示的 session。 */
export interface SessionCandidate {
  sessionId: string;
  /** 开着它的 Copilot CLI 进程号；不知道是 null。 */
  copilotPid: number | null;
  /** 登记记录里的 tmux pane（如 "%3"）；没有登记记录或不在 tmux 里是 null。 */
  tmuxPane: string | null;
  /** workspace.yaml 里的 cwd；读不到时用登记记录的 cwd；都没有是 null。 */
  cwd: string | null;
  /** workspace.yaml 里的 name（顶行显示的 session 名字）；没有是 null。 */
  title: string | null;
  /** events.jsonl 的修改时间（Unix 毫秒）；文件还不存在是 0。 */
  lastEventAt: number;
  /** 可选。真人最近一次在这个 session 里发言的时间（Unix 毫秒）：events.jsonl 里最后一条没有 agentId、source 为空或 user 或 command- 开头的 user.message。没有或还没读是 0 或不写。 */
  lastUserMessageAt?: number;
  /** 有效的登记记录（Copilot CLI 进程还在、心跳在 20 秒内）；没装扩展的 session 是 null。 */
  registration: Registration | null;
  /** 从哪找到的：有效的登记记录，或者 inuse.<进程号>.lock 加活着的 copilot 进程。 */
  source: "registration" | "lock";
}

/** 界面自己在哪。 */
export interface SelfLocation {
  /** 界面进程的工作目录。 */
  cwd: string;
  /** 在 tmux 里时：自己的 pane、同一个窗口里其他 pane、这些 pane 的进程树里找到的 Copilot CLI 进程号。不在 tmux 里是 null。 */
  tmux: {
    paneId: string;
    windowPanes: readonly string[];
    windowCopilotPids: readonly number[];
    /** 可选。Copilot CLI 进程号 → 它所在的 pane（读 pane 标题用）。 */
    panesByPid?: Readonly<Record<number, string>>;
  } | null;
}

/** 当前接着的 session。 */
export interface CurrentSession {
  sessionId: string;
  /** 用户按 s 手动选的：固定在它上面，直到它结束（不再是候选）。 */
  pinned: boolean;
  /** 当前 session 读到的最新事件时间（StoreView.lastEventAt），比候选的文件修改时间更准；没有就用 0。 */
  lastEventAt: number;
}

/**
 * 从界面这边找到的“用户在 Copilot CLI 里正看着哪个 session”的线索（扩展的接口没有可靠办法知道，只能找旁证）。
 * log：Copilot CLI 进程日志里最后一条 “Registering foreground session: <ID>”，切换 session 时写；title：那个进程所在 tmux pane 的标题，
 * Copilot CLI 把它设成“<当前 session 的名字> - GitHub Copilot”，这里是去掉后缀的名字。
 */
export type ForegroundHint =
  | { kind: "log"; copilotPid: number; sessionId: string }
  | { kind: "title"; copilotPid: number | null; title: string };

export interface ChooseInput {
  candidates: readonly SessionCandidate[];
  /** 命令行 --session 指定的 ID；没指定是 null。 */
  explicitId: string | null;
  self: SelfLocation;
  current: CurrentSession | null;
  /** 可选。前台线索；没有或不写就跳过“有前台线索”这一级。 */
  foreground?: readonly ForegroundHint[];
}

/**
 * 选中这个 session 的依据，按优先级：explicit 命令行指定；pinned 用户按 s 固定的；foreground 前台线索指到的；
 * last-message 最近一次用户发言最新；last-event 最近有事件；stay 依据只是“最近有事件”而当前的 session 还在范围里，所以不换。
 */
export type ChooseReason = "explicit" | "pinned" | "foreground" | "last-message" | "last-event" | "stay";

/**
 * 选择的结果。scopeBy 是候选范围怎么来的：tmux 同一窗口里的 Copilot CLI 进程开着的 session，cwd 工作目录相同；命令行指定 session 时没有范围，是 null。
 * scope 是同一个候选范围里所有 session 的 ID（按最新事件从新到旧），给 s 键的选择列表用。
 */
export type ChooseResult =
  | {
      kind: "session";
      sessionId: string;
      reason: ChooseReason;
      /** reason 是 foreground 时，指到它的是哪种线索（日志、pane 标题）。 */
      via?: ForegroundHint["kind"];
      scopeBy: "tmux" | "cwd" | null;
      scope: readonly string[];
    }
  | { kind: "none" };
