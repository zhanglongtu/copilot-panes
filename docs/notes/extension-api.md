# 扩展能订阅什么、能调用什么，以及扩展进程的生命周期

这份文档给维护 copilot-panes 扩展的人看：Copilot CLI 的扩展接口（`@github/copilot-sdk` 的 `extension` 入口）里，copilot-panes 用到的那部分到底怎么表现。读完应该知道扩展能收到哪些事件、哪些事件不落盘、`tasks` 方法对各种任务返回什么、扩展进程什么时候被启动和停掉。完整的类型定义见 `@github/copilot-sdk` 的 `generated/rpc.d.ts` 和 `generated/session-events.d.ts`（MIT 许可，不随本项目分发），这里只写类型里看不出来的行为。没有特别说明的事实，都是在 Copilot CLI 1.0.112 上实测的。

## 扩展是 Copilot CLI 为每个 session 起的 Node 进程

扩展入口调用 `joinSession()`（从 `@github/copilot-sdk/extension` 导入），返回的 session 对象带 `sessionId`、`on`、`getEvents`、`log` 和类型化的 `rpc`。要点：

- `joinSession()` 读环境变量 `SESSION_ID`，没有就抛错，所以只能在 Copilot CLI 启动的扩展进程里运行。session ID 以返回的 `session.sessionId` 为准。
- **stdout 是和 Copilot CLI 之间的 JSON-RPC 通道。** 扩展不能 `console.log`；要输出，写 stderr，或调用 `session.log(message, { level, ephemeral })`。不带 `ephemeral` 的日志会落进 `events.jsonl`。
- 钩子（`hooks`）、自定义工具（`tools`）、HTTP 转发（`fetch`）也能用，copilot-panes 都不用，`joinSession({})` 即可。
- 默认的权限处理器返回“没有结果”。

扩展能不能加载，取决于下面几条：

- **实验功能要开。** 在 Copilot CLI 里运行 `/settings experimental on`，或者启动时带 `--experimental`。
- **扩展放在用户级目录** `~/.copilot/extensions/<名字>/extension.mjs`（`COPILOT_HOME` 设了就用它），对所有项目有效。
- **项目级目录** `.github/extensions/<名字>/extension.mjs` 要求工作目录被信任。交互模式下 Copilot CLI 会弹目录信任确认，选“信任”后 1 秒内扩展起来；设了 `COPILOT_ALLOW_ALL=true` 则不弹。项目级目录要在仓库根，所以放在别的仓库里的测试项目要先 `git init`（不 `git init` 会怎样，没验证）。
- 提示模式（`copilot -p`）下，用户级和插件扩展照常加载，项目级扩展默认跳过，要设 `GITHUB_COPILOT_PROMPT_MODE_EXTENSIONS=true`；这一条来自读 Copilot CLI 的代码，提示模式下没有实测。

## 扩展进程的环境和退出：收到 SIGTERM 后可能只有 1 秒

**环境变量。** Copilot CLI 给扩展进程设了 `SESSION_ID`、`EXTENSION_PATH`、`COPILOT_SDK_PATH`、`COPILOT_EXTENSION_PARENT_PID`、`COPILOT_EXTENSION_SANDBOXED`、`COPILOT_EXTENSION_INITIALIZATION`。普通环境变量照常继承（实测能读到 `TMUX_PANE`、`COPILOT_HOME`，也能读到自己加的变量）；`GITHUB_TOKEN` 这类敏感变量被剥掉。实测 `COPILOT_EXTENSION_PARENT_PID` 等于扩展的 `process.ppid`，也等于持有 session 的 `inuse.<进程号>.lock` 的进程；`COPILOT_EXTENSION_SANDBOXED` 是 `0`。扩展进程的工作目录没查清。

**看门狗。** SDK 在非沙箱时要求 `COPILOT_EXTENSION_PARENT_PID` 等于 `process.ppid`，否则直接退出，之后每秒检查父进程还在不在，不在就退出。沙箱时（`COPILOT_EXTENSION_SANDBOXED=1`）改为 stdin 关闭就退出。设置项 `sandbox.sandboxExtensions` 控制扩展是否在沙箱里跑；沙箱开启时扩展能不能写 `~/.copilot/`、开 unix socket，没验证。

**停止。** 普通停止或重新加载：先发 SIGTERM，5 秒后还在就发 SIGKILL。Copilot CLI 退出或 session 销毁：和别的清理共用约 1 秒宽限期。SDK 自己不注册 SIGTERM、SIGINT 的处理函数，进程会直接被终止；想清理 unix socket 就要自己注册处理函数，并在 1 秒内做完（这是 Node 的行为，没有在 Copilot CLI 里单独验证）。实测 `/exit` 时，Copilot CLI 先断开连接，约 90 毫秒内登记记录和 socket 文件就都没了。

**日志。** Copilot CLI 自己的日志在 `~/.copilot/logs/process-<启动毫秒>-<进程号>.log`。扩展写的 stderr 进入另一个格式相同、文件名里是扩展进程号的日志文件，文件里有启动（`=== launch pid=… ===`）、就绪（`=== ready ===`）和退出（`=== exit code=0 disposition=stopped-normally ===`）的标记行。

## 每个 session 一组扩展进程，`/new` 不会重新加载它们

扩展按 session 单独启动。实测 `/new` 之后：旧 session 的扩展进程继续运行，照样收到事件、推送用量；新 session 另起一组扩展进程；两个 session 各有一条登记记录，Copilot CLI 进程号和 tmux pane 相同，socket 路径不同。

Copilot CLI 要求扩展在 `/clear` 或前台 session 被替换时重新加载（SDK 文档写的行为，没有逐项实测）。对 Copilot CLI 说“重新加载扩展”时，实测的过程是：旧进程收到 SIGTERM，删掉登记记录和 socket 文件，退出码 0；约 0.25 秒后新进程登记，socket 路径不变（路径只取决于数据目录和 session ID），连着的界面重连成功。

新进程不知道之前发生的事：它订阅得晚，漏掉了 `tool.shell_output` 和 `assistant.usage`。补救办法有两个：

- 用 `session.getEvents()` 读历史，恢复命令调用和子 agent 的 `totalTokens`。它只含落盘的事件，不含 `tool.shell_output` 和 `assistant.usage`。
- 正在抄输出的 `detach` 命令（bash 调用带 `detach: true`，命令脱离 Copilot CLI 独立运行），从头读 `tasks.readOutput`，跳过 `.out` 里已有的字节，接着抄。实测一条 60 秒的 `detach` 命令在第 20 秒重新加载：补救前 `.out` 停在 651 字节，日志文件有 2,279 字节；补救后两者一致。

重新加载前后都在跑的后台命令，`.out` 仍与事件逐字节一致。用量只含新进程看到的部分，这是 SDK 的限制。

## 事件：扩展能收到全部，落盘的只是一部分

`session.on(handler)` 订阅全部事件；`session.on(type, handler)` 订阅一种。返回的函数用来取消订阅。每个事件的外层有 `id`、`timestamp`、`parentId`、`type`，可能有 `agentId`（子 agent 的实例 ID，主会话没有）、`checkpoint`、`ephemeral`。

**不落盘的事件**是类型里标了 `ephemeral: true` 的，1.0.112 里有 85 种，只发给在线的订阅者，晚订阅的收不到、也不会重放。扩展关心的有 `session.idle`、`session.background_tasks_changed`、`tool.shell_output`、`tool.execution_progress`、`tool.execution_partial_result`、`assistant.message_delta`、`assistant.usage`、`session.usage_info`。实测它们在 `events.jsonl` 里出现 0 次。其余事件的 `ephemeral` 是可选字段，类型里看不出会不会落盘；实测会落盘的有 `subagent.started`、`subagent.configured`、`subagent.selected`、`subagent.completed`、`tool.execution_start`、`tool.execution_complete`、`system.notification`、`session.start`、`session.resume`、`session.shutdown`、`assistant.message`、`assistant.turn_start`、`assistant.turn_end`。所以扩展必须先订阅、再做别的事。

**`tool.shell_output`**（命令的实时输出）：

- 字段：`toolCallId`、`sequence`、`stream`、`text`。`sequence` 每条命令从 0 开始，实测在 10 条命令的 114 个事件里连续，没有乱序和重复。`stream` 是 `stdout`、`stderr` 或 `terminal`，缺省表示 `stdout`；实测全是 `stdout`，没测 `stderr` 和 `terminal`。`text` 是新增的一段，不一定以整行结束。
- 按 `sequence` 把 `text` 拼起来，和扩展存的 `.out` 逐字节一致。实测命令带颜色码和 `\r` 进度，主会话的前台和后台命令、子 agent 起的同步和后台命令，全都一致。子 agent 起的命令，事件带 `agentId`。瞬间结束的命令也有 1 条。
- `tool.execution_partial_result` 里的文字去掉了颜色码，每条是到目前为止的全文，不能当原文用。
- `detach` 的命令没有 `tool.shell_output`，输出要另外抄（见“`detach` 的命令没有输出事件”一节）。

**`system.notification`** 的 `kind.type` 有 8 种：`agent_completed`、`agent_idle`、`new_inbox_message`、`shell_completed`、`shell_detached_completed`、`instruction_discovered`、`workflow_completed`、`unclassified`。`shell_completed` 带 `shellId`，退出码可能缺；`shell_detached_completed` 只有 `shellId`；两者都没有 `toolCallId`。

**`assistant.usage`** 一次模型调用一条，字段有 `model`、`inputTokens`、`outputTokens`、`cacheReadTokens`、`cacheWriteTokens`、`cost`、`duration`。子 agent 的带 `agentId`，主 agent 的没有。

**`session.background_tasks_changed`** 的载荷是空的，只表示“后台任务的状态变了”。它可以代替或补充每秒一次的 `tasks.list()` 轮询，这是建议，没有试过。

**`tool.execution_complete`** 对 shell 工具：`success` 表示调用成功，不表示命令成功；实测同步命令退出码 7 时 `success` 仍是 `true`，退出码在 `shellExecution.exitCode`。后台命令的完成事件带 `result.structuredContent.shellId`。

## `session.rpc.tasks` 的方法：成功都有明确返回值，失败多数是返回值而不是异常

| 方法 | 参数 | 返回 | 实测的行为 |
| --- | --- | --- | --- |
| `list()` | 无 | `{ tasks }` | 任务有 `agent`、`shell`、`client` 三种，要跳过 `client`（扩展或 SDK 自己登记的任务） |
| `sendMessage` | `id`、`message`、可选 `fromAgentId` | `{ sent, error? }` | 给在跑的和 `idle` 的子 agent 都返回 `sent: true`，子 agent 照做并回复；`idle` 的会变成 `running` 再回到 `idle`。给已取消的子 agent、shell 任务、不存在的 id：`sent: false`，`error` 是“Agent not found or not accepting messages”。copilot-panes 传 `fromAgentId: ""`，空串和省略是否等价没查清 |
| `cancel` | `id` | `{ cancelled }` | 取消子 agent：`true`，状态变 `cancelled`，它正在跑的命令一起被杀，对应的 shell 任务从列表消失。取消后台命令：`true`，进程消失，状态 `cancelled`。已结束或不存在的任务：`false` |
| `promoteToBackground` | `id` | `{ promoted }` | 在跑或 `idle` 的同步子 agent：`true`，`executionMode` 变 `background`，`canPromoteToBackground` 变 `false`。不存在的 id：`false` |
| `remove` | `id` | `{ removed }` | 已结束的任务：`true`。在跑、`idle` 或不存在的：`false` |
| `readOutput` | `id`、可选 `cursor`、可选 `waitMs` | `{ text, cursor, exit? }` | 只对 `detach` 的 shell 任务有效，见“`detach` 的命令没有输出事件”一节。其他 id 返回 `{ error: "No detached shell task with id '…'" }`（是返回值，不是异常） |

`tasks` 还有 `getProgress`、`startAgent`、`register`、`update`、`refresh`、`waitForPending`、`getCurrentPromotable`、`promoteCurrentToBackground`，copilot-panes 不用。

`tasks.sendMessage` 实际只要 1 到 5 毫秒返回，界面等的 10 秒超时几乎不会触发。

## `TaskInfo` 有三种形状，shell 任务没有 `toolCallId` 和退出码

**子 agent 任务**（`type: "agent"`）：`id` 等于子 agent 事件信封里的 `agentId`（实测，`assistant.usage`、`subagent.completed` 和任务列表里是同一个值）；`toolCallId` 是发起它的 `task` 工具调用的 ID；还有 `displayName`、`description`、`status`、`startedAt`、`completedAt`、`activeTimeMs`、`error`、`agentType`、`prompt`（最近一次收到的提示）、`result`、`model`、`resolvedModel`、`executionMode`（`sync` 或 `background`）、`canPromoteToBackground`、`latestResponse`、`idleSince`。

**shell 任务**（`type: "shell"`）：`id`、`description`、`status`、`startedAt`、`completedAt`、`command`、`attachmentMode`（`attached` 或 `detached`）、`executionMode`、`canPromoteToBackground`、`logPath`（`detach` 的命令才有）、`pid`。**没有 `toolCallId`，也没有退出码。**

- shell 任务的 `id` 就是 `shellId`：bash 结果里的 `<shellId: X>`、`read_bash` 和 `stop_bash` 的 `shellId` 参数、完成事件里的 `structuredContent.shellId`，都是同一个值。
- shell 的 `id` 在 Copilot CLI 进程内全局递增：`/new` 之后新 session 的第一条命令编号接着往下，实测是 `7`，不是 `0`。
- 所以界面要把 shell 任务对到名单上的命令，只能靠 `shellId` 或“命令文字加启动时间”。实测 50 次对应全部正确，以 `events.jsonl` 里每条 bash 调用的 `shellId` 为标准答案。

**状态**是 `running`、`idle`、`completed`、`failed`、`cancelled`；`client` 任务多一个 `orphaned`。

- 同步（前台）命令只在运行时出现在任务列表里，结束就消失；后台命令结束后以 `completed` 或 `cancelled` 留在列表里，直到 `remove`。
- 子 agent 同步做完后是 `idle`（带 `idleSince` 和 `latestResponse`），不是 `completed`；`idle` 的子 agent 还能收消息。变成 `idle` 时，日志里有 `agent_idle` 通知。
- 主会话起的后台命令结束时，日志里有 `shell_completed` 通知，带退出码；被 `tasks.cancel` 杀掉的命令没有通知。子 agent 起的后台命令正常结束时有没有通知，没测。
- 被 `tasks.cancel` 杀掉的子 agent，也会发 `subagent.completed`，带 `cancelled: true` 和 `totalTokens`。

## `detach` 的命令没有输出事件，要用 `tasks.readOutput` 抄

`detach: true` 的 bash 调用立刻返回，结果文字是“command started in detached background with shellId: N”一类，`structuredContent.shellId` 可直接取。它不发 `tool.shell_output`。

- `tasks.readOutput` 返回 `text`（UTF-8，已脱敏，每次最多 64 KiB）、`cursor`（不透明，实测形如 `shell-output:v1:<字节数>`，乱写会报 `invalid tasks.readOutput cursor`）、命令结束后才有的 `exit`（`status` 和可选的 `exitCode`）。第一次不传 `cursor` 从头读；`waitMs` 最多 30,000，没有新输出时等这么久再返回。
- 抄出来的 `.out` 和 Copilot CLI 自己写的日志文件（任务的 `logPath`）逐字节一致。
- 命令结束时，日志里是 `shell_detached_completed` 通知，没有退出码，退出码只能从 `readOutput` 的 `exit.exitCode` 取；任务状态变 `completed`。

## 扩展接口里没有“前台 session”

一个 Copilot CLI 进程可以同时开着好几个 session，扩展收不到“用户正看着哪个”的信息：`session.getForeground` 请求只在 `--ui-server`（TUI 加服务器）模式下可用，扩展拿不到客户端对象；`session.foreground` 生命周期事件只发给 `CopilotClient.onLifecycle` 的订阅者，扩展收不到。扩展进程的存在也不代表它的 session 在前台。所以 copilot-panes 从外面判断，办法见相关阅读。

## 还没验证的事

- 沙箱开启时扩展能不能写数据目录、开 unix socket（实测都在沙箱关闭时做的）。
- 命令的 `stderr` 和 `terminal` 流的事件。
- `copilot -p` 提示模式下加载扩展。
- `copilot --resume` 恢复 session 时扩展的行为。
- 扩展进程的工作目录。

## 相关阅读

- `architecture.md`：扩展和界面怎么分工，socket 协议，以及登记记录和输出文件放在哪里。
- `events-log.md`：`events.jsonl` 里和子 agent、命令有关的事件，以及名单怎么从它们得出。
- `processes-and-sessions.md`：命令在操作系统里的样子、给进程发信号的效果，以及怎么判断哪个 session 在前台。
