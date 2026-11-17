// 扩展用到的 Copilot CLI SDK 的那一小部分接口：按 @github/copilot-sdk 的 CopilotSession 的形状写成，只保留本工具用到的字段。
// 扩展的逻辑只依赖这个接口，测试用假的 session 实现它；入口 extension.ts 把 joinSession() 返回的真 session 传进来。

import type { TaskInfo, TaskStatus } from "../../src/protocol.ts";

/** session 事件的信封。data 的形状随 type 变，用前要检查（事件来自 Copilot CLI，字段可能缺）。 */
export interface SdkEvent {
  type: string;
  id?: string;
  timestamp?: string;
  parentId?: string | null;
  /** 子 agent 的实例 ID；主会话和会话级事件没有。 */
  agentId?: string;
  ephemeral?: boolean;
  data?: unknown;
}

export interface TasksRpc {
  list(): Promise<{ tasks: TaskInfo[] }>;
  cancel(params: { id: string }): Promise<{ cancelled: boolean }>;
  /** 只能移除已结束的任务；在跑或 idle 的返回 removed: false。 */
  remove(params: { id: string }): Promise<{ removed: boolean }>;
  /** fromAgentId 传 ""（空串与省略是否等价没查清）。 */
  sendMessage(params: { id: string; message: string; fromAgentId?: string }): Promise<{ sent: boolean; error?: string }>;
  promoteToBackground(params: { id: string }): Promise<{ promoted: boolean }>;
  /** 只对 detached 的 shell 任务有效。cursor 省略时从头读；waitMs 最多 30000。 */
  readOutput(params: { id: string; cursor?: string; waitMs?: number }): Promise<{
    text: string;
    cursor: string;
    exit?: { status: TaskStatus; exitCode?: number };
  }>;
}

/** 扩展用到的 session 成员。 */
export interface PanesSession {
  readonly sessionId: string;
  readonly rpc: { readonly tasks: TasksRpc };
  /** 订阅所有事件（含不落盘的 tool.shell_output、assistant.usage），返回取消订阅的函数。 */
  on(handler: (event: SdkEvent) => void): () => void;
  /** session 到现在的历史事件（只含落盘的，不含 tool.shell_output、assistant.usage）。扩展重新加载或晚于命令启动时用它补读；较旧的 Copilot CLI 可能没有。 */
  getEvents?(): Promise<readonly SdkEvent[]>;
  /** 写一条 Copilot CLI 能看到的日志。扩展不能写 stdout：stdout 是和 Copilot CLI 之间的 JSON-RPC 通道。 */
  log(message: string, options?: { level?: "info" | "warning" | "error"; ephemeral?: boolean }): Promise<void>;
}
