# `events.jsonl` 里的事件，和名单怎么从它们得出

这份文档给维护 copilot-panes 的人看：Copilot CLI 为每个 session 追加写的事件日志 `events.jsonl` 里，哪些事件和子 agent、命令有关；状态库（`src/model/store.ts`、`src/model/commands.ts`）怎样把它们变成名单的数据和过程记录。读完应该能判断一种事件该不该处理、改动落在哪里。没有特别说明的事实，都是在 Copilot CLI 1.0.112 上实测的。

## 日志是每行一个 JSON，只读外层四个字段

session 目录 `~/.copilot/session-state/<session ID>/` 里有三样东西用得上：`events.jsonl`（事件日志）、`workspace.yaml`（有工作目录 `cwd` 和 session 名字 `name`）、`inuse.<进程号>.lock`（session 开着时存在，进程号是持有它的 Copilot CLI 进程）。

状态库只读每行的 `type`、`data`、`agentId`、`timestamp`：

- `agentId` 只有子 agent 的事件才有；没有，表示事件属于主会话。
- `timestamp` 是 ISO 8601 时间，转成 Unix 毫秒；解析失败得 0。
- `data` 不是对象时当作空对象。
- `id` 和 `parentId` 不读。`parentId` 是事件链，不是子 agent 的父子关系。

一行不是 JSON、不是对象、没有字符串 `type`，或者处理时出错，都只丢这一行，已有状态不受影响。状态库只处理下面表里的 `type`；其余的（数量最多的是 `hook.*`、`assistant.turn_*`，还有 `system.message`、`instruction.update`、`skill.*` 等）连 JSON 都不解析，只从行里取出时间。

有些事件不写进 `events.jsonl`，只发给在线订阅的扩展：`tool.shell_output`（命令的实时输出）、`assistant.usage`（一次模型调用的用量）、`session.idle` 等。所以只读日志，拿不到命令的实时输出，也看不出子 agent 做完一轮后还留在任务列表里等消息（空闲，idle）。这两样由装进 Copilot CLI 的扩展补上。

## 状态库读 15 种事件，每种只取几个字段

| `type` | 读的 `data` 字段 | 效果 |
| --- | --- | --- |
| `session.start`、`session.resume` | `selectedModel`、`context.cwd` | 记下主模型和工作目录。`resume` 还把还在跑的子 agent 和命令标成已停 |
| `session.shutdown` | 不读 | 同上，还在跑的都标成已停 |
| `session.model_change` | `newModel`（只认没有 `agentId` 的） | 更新主模型 |
| `subagent.started` | `toolCallId`、`agentDisplayName`、`agentName`、`agentType`、`agentDescription`、`model`、`executionMode` | 新建子 agent，状态在跑 |
| `subagent.configured` | `model` | 只在 `started` 没带模型时补上 |
| `subagent.completed` | `toolCallId`、`totalToolCalls`、`totalTokens`、`model`、`cancelled`、`durationMs` | 做完；`cancelled` 为真时记成已停并标取消 |
| `subagent.failed` | `toolCallId`、`totalToolCalls`、`totalTokens`、`error`、`durationMs` | 失败 |
| `user.message`（要有 `agentId`） | `content`、`source` | 第一条是任务说明，之后是消息；子 agent 不在跑时改回在跑 |
| `assistant.message`（要有 `agentId`） | `content`、`reasoningText` | 记成“说的话”和“思考” |
| `tool.execution_start`、`tool.execution_complete` | `toolName`、`toolCallId`、`arguments`；完成时另有 `success`、`error`、`result`、`shellExecution.exitCode`、`toolTelemetry.metrics` | 工具调用的开始和完成合成过程记录里的一条；bash 和 powershell 另外登记成命令 |
| `system.notification` | `kind.type`、`kind.agentId`、`kind.shellId`、`kind.exitCode` | `agent_idle` 让在跑的子 agent 记成做完；`shell_completed`、`shell_detached_completed` 结束后台命令 |
| `abort` | `reason` | 带 `agentId` 且 `reason` 为 `subagent_cancelled`：取消那个子 agent。不带 `agentId`：用户中断了主会话这一轮 |
| `session.usage_record`（要有 `agentId`） | `usage.inputTokens`、`usage.outputTokens` | 累加子 agent 的 token |

`session.usage_record` 是日志里实测存在的事件：子 agent 的带 `agentId`，每次模型调用一条。Copilot CLI 1.0.112 的 SDK 类型定义里没有它。

## 子 agent 的状态由事件推出，用时按“段”累计

状态取值是在跑、做完、失败、已停四种；已取消是已停加一个 `cancelled` 标记。事件和状态的对应：

| 事件和条件 | 新状态 |
| --- | --- |
| `subagent.started` | 在跑 |
| `user.message` 带 `agentId`，收消息的子 agent 不在跑 | 在跑，开始新的一段用时 |
| `subagent.completed`，`cancelled` 不为真 | 做完 |
| `subagent.completed`，`cancelled` 为真 | 已停，标取消 |
| `subagent.failed` | 失败。`error` 是字符串就原样存，`null` 存空串，其他值转成 JSON 文本，再折成一行 |
| `agent_idle` 通知，`kind.agentId` 对应的子 agent 在跑 | 做完 |
| `abort` 带 `agentId`，`reason` 为 `subagent_cancelled` | 已停，标取消，并丢掉它名下还在跑的后台命令 |
| `abort` 不带 `agentId` | 用户中断了主会话这一轮：在跑且 `executionMode` 为 `sync` 的子 agent 标成已停并取消；主会话的前台命令一起丢掉 |
| `session.shutdown`、`session.resume` | 还在跑的标成已停 |

细节：

- **找子 agent**：完成、失败事件先用顶层 `agentId` 找，再用 `data.toolCallId` 去对 `subagent.started` 记下的 `toolCallId`，都找不到就忽略。后到的事件直接覆盖状态，不看原状态。
- **父子关系**：子 agent 的上一级，是发起它的 `task` 工具调用所属的 agent。`task` 的 `tool.execution_start` 带发起者的 `agentId`；`subagent.started` 的 `data.toolCallId` 等于这次 `task` 调用的 `toolCallId`。查不到发起者就是主会话发起的，挂在最外层。
- **用时**：每段用时是从开始（或被消息叫醒）到结束。首次结束且事件带 `durationMs` 时，用时以它为准；以后每次结束加上这一段的时长。已结束的子 agent 用时不再增长。
- **调用次数**：每个带这个子 agent 自己 `agentId` 的 `tool.execution_start` 加一；`completed`、`failed` 事件里的 `totalToolCalls` 是整数就整个替换，它含各级下属的调用。
- **后台子 agent 的真实顺序**：`subagent.started`；第一轮做完发 `subagent.completed`；之后每发一次消息，日志里只多一条带它 `agentId` 的 `user.message`，没有新的开始或完成事件；每一轮结束只有一条 `agent_idle` 通知；被取消时再来一条 `cancelled` 为真的 `subagent.completed`。
- **消息是谁发的**：看 `user.message` 的 `source`。没有或为空串，是用户从界面发的；`agent-<ID>` 且 ID 是已知子 agent，是它；ID 不认识，是主会话（实测主会话发的消息 `source` 都是 `agent-<session ID>`）；其他取第一个 `-` 前的词（见过 `system`、`memory`、`schedule-<数字>`、`command-<ID>`）。
- **起子 agent 的工作流**：工作流里的子 agent 没有 `task` 调用，`toolCallId` 等于 `agentId`，带 `workflowRunId`，会挂在最外层。没有专门处理。

## 命令从 bash 和 powershell 调用登记，三个来源能让后台命令结束

**登记。** 每个 `bash`、`powershell` 的 `tool.execution_start` 都登记成一条命令，以 `toolCallId` 为键。`arguments.command` 是命令原文，`arguments.description` 是简述，`arguments.mode` 为 `async` 的是后台命令。`read_bash`、`write_bash`、`stop_bash`、`list_bash` 不登记命令，只用来结束或补充别的命令。命令归属于 `start` 事件的 `agentId`（没有就是主会话），归属只在开始时定。

**`shellId`。** Copilot CLI 给后台 shell 的编号，也是 `tasks.list()` 里 shell 任务的 `id`。有三个来源：`start` 的 `arguments.shellId`；完成事件的 `result.structuredContent.shellId`；完成事件里没有它、调用成功又没有 `shellExecution` 时，用正则 `shellId: (\S+?)>` 在 `result.content` 里找。

**前台命令转成后台。** 完成事件满足三条：`success` 为真、没有整数 `shellExecution.exitCode`、取得到 `shellId`，说明调用返回了而命令还在跑（`detach` 的命令，即 bash 调用带 `detach: true`、命令脱离 Copilot CLI 独立运行的；或同步命令等不到结果被转入后台）。这时不新建，把同一条命令改成后台。同步命令正常结束的完成事件也带 `shellId`，但带 `exitCode`，不转。

**前台命令怎么结束。** 看自己的完成事件：退出码取 `shellExecution.exitCode`；没有就取 `result.content` 末尾 `<shellId: … completed with exit code N>` 里的 N，这段标记总会从输出里去掉；都没有，状态是做完、不算失败。同步命令失败（实测退出码 7）时 `success` 仍然是 `true`，所以要看退出码。

**后台命令的三个结束来源**，先到的生效，后到的找不到命令、连退出码一起丢：

| 来源 | 怎么找到命令 | 退出码和状态 |
| --- | --- | --- |
| `system.notification`，`kind.type` 为 `shell_completed` 或 `shell_detached_completed` | `kind.shellId` | 取 `kind.exitCode`，是整数才认。`shell_detached_completed` 没有退出码，永远不会变失败 |
| `read_bash` 或 `write_bash` 的完成事件 | 调用的 `arguments.shellId` | 只有 `content` 末尾带退出标记才结束，退出码是标记里的 N |
| `stop_bash` 的完成事件 | 调用的 `arguments.shellId` | 立即标已停，没有退出码 |

另外，子 agent 做完、失败、被取消时，丢掉它名下还在跑的后台命令（日志里没有这些命令自己的结束通知）；会话结束或续接时，所有还在跑的命令标成已停。被 `tasks.cancel` 杀掉的命令在日志里没有结束通知，这一情况靠任务列表补。

**退出码和失败。** 命令正常结束、退出码不是 0，状态是失败。结束前在名单上出现过的（后台命令，或前台命令跑满 2 秒）会留下，最多 5 条，满了去掉最早的。

## 命令的输出优先取扩展存的 `.out`，没有才用事件里的

输出的来源，按顺序：

1. 扩展存的 `<toolCallId>.out` 存在，就用它，哪怕是空文件。
2. 否则，已结束的前台命令用完成事件的 `result.content`（去掉末尾的退出标记）。
3. 否则，后台命令用 `read_bash`、`write_bash` 读到的输出：只收调用成功的结果，去掉末尾一条 `<…shellId…>` 说明，丢掉只有空白的和整条等于“Read interrupted by user steering; shell continues in background.”的，每段补成以换行结尾，只留最后 262,144 个字符。

输出太大时，完成事件里的 `result.content` 会变成以 `Output too large to read at once` 开头的提示、一个存在 `/tmp` 的文件路径和约 500 个字符的预览。copilot-panes 不读那个文件，提示和预览当作普通输出。有 `.out` 时不受影响。

文字清理（`src/model/output.ts`）依次做：删终端转义序列（CSI、以 BEL 或 `ESC \` 结尾的 OSC、两字符的 `ESC` 序列）；`\r\n` 换成 `\n`；一行里有 `\r` 时只留最后一个 `\r` 之后的部分（进度条覆盖）；制表符换成 4 个空格；删除除换行外的控制字符，包括 U+0080 到 U+009F。先换 `\r\n` 再处理 `\r`，所以以 `\r\n` 结尾的行不会变成空行。单行文字再把所有空白折成一个空格。

命令在名单上的“最近一步”，取输出的最后一个非空行，以 `\r` 分段的取最后一个有字的段。进度从这一行认出：独立的分数 `a/b`（`b` 至少 2、`a` 不超过 `b`，所以路径和日期不算）和独立的百分数 `p%`（0 到 100）。一行里有多处时各取最后一处；两样都有写“a/b p%”，只有分数时 p 由 a/b 算出，取整一律向下。

## 过程记录按子 agent 分开存，文字有长度上限

状态库给每个子 agent 存一份过程记录，条目按顺序编号：

| 条目 | 来源 |
| --- | --- |
| 任务说明 | 这个子 agent 的第一条 `user.message`（内容不能全是空白，不看 `source`） |
| 消息 | 之后的 `user.message`，带发送者 |
| 思考 | `assistant.message` 的 `reasoningText`，去掉首尾空白后非空才记 |
| 说的话 | 同一条的 `content`，去掉首尾空白后非空才记；最后一条的前 600 个字符留作“最近一步” |
| 工具调用 | `tool.execution_start` 和同一个 `toolCallId` 的 `tool.execution_complete` 合成一条，带状态、结果文字、错误文字 |
| 继续 | 做完的子 agent 又收到消息 |
| 结束 | 做完、失败、已停。条目里的用时、调用次数、token 取事件当时的值，不随以后变化 |

主会话的 `assistant.message` 和 `user.message` 不进任何子 agent 的记录；主会话的工具调用只用来登记命令和 `task` 调用的归属。非 shell 工具的结果只存文字，`success` 为 `false` 或有 `error` 时标失败。

**长度上限**（`src/model/limits.ts`，单位都是字符）：工具的参数和结果，每个字符串留 4,096；说的话、思考、任务说明、消息每条留 65,536；命令的事件输出留 262,144；超出的截掉并记下数量。所有长文字的总量超过 2,400 万时，较早的条目缩成 160 个字符。

**名单行的文字**（`src/model/describe.ts`）：

- 工具调用一行是 `▸ <动词>  <对象>  <补充>`。`view` 写路径和行号范围，`grep` 写搜索词和“共 N 处”，`edit` 写路径和 `+a −b`，`bash` 写命令第一行和退出码，`task` 写子 agent 的名字和模型。没有专门写法的工具，对象取 `path`、`filePath`、`file_path`、`pattern`、`query`、`url`、`description`、`name`、`agent_id`、`prompt` 里第一个非空的参数。
- 在跑的子 agent，“最近一步”看最近一次工具调用：`bash` 显示“跑 <程序名>”，正等着同步子 agent 时显示“等 <名字> 交回结果”，其他显示“<动词> <对象>”。程序名取命令的第一个词，跳过 `cd 目录 &&`、`VAR=值`、`env`、`timeout`、`nohup` 这类包装；是 `python3`、`node`、`bash` 这类解释器时取后面第一个不以 `-` 开头的词。
- 做完的子 agent，“最近一步”是最后一条回复的第一句正文：跳过空行、`#` 标题行、代码围栏和分隔线，取第一个有字的行，去掉行首的列表符号和引用符号，以及行里所有的 `**`。没有回复写“做完了”。
- 模型短名：取最后一个 `/` 之后的部分，去掉开头的 `claude-`，例如 `provider/small-1.0` 显示成 `small-1.0`。

## token：用量事件按输入加输出累加，完成事件的总数已含下级

子 agent 显示的 token 取三个已知数里最大的（`src/model/tokens.ts`），所以要先弄清每个数的口径。实测如下：

- `session.usage_record`（落盘，子 agent 的带 `agentId`）和 `assistant.usage`（不落盘，只有扩展收到，子 agent 的带信封 `agentId`）每次模型调用一条。token 数是 `inputTokens + outputTokens`；缓存读写已经算在 `inputTokens` 里，不能再加。实测 37 条 `assistant.usage` 里，没有一条 `inputTokens` 小于缓存读写之和。
- `subagent.completed` 的 `totalTokens` 等于子 agent 所有用量事件 `inputTokens + outputTokens` 之和，是发事件那一刻的累计，包含全程各轮，也**包含它名下各级子 agent 的用量**。在 4 个真实 session 的 128 个子 agent 上核对：自己的用量加各下级的，没有一个比 `totalTokens` 小，116 个恰好相等，其余 12 个是追加消息后又多跑了几轮。
- 同一个子 agent 有两条完成事件时（后一条是取消），后一条也是累计数，不小于前一条，所以几条的数不能相加。
- 子 agent 做完一轮后再收到消息，会继续累计用量，但不再发 `subagent.completed`，`totalTokens` 停在上一轮。例：一个子 agent 在完成事件里写 4,875 万，用量记录后来累加到 6,965 万。

所以每个子 agent 的 token 是几个已知数里最大的，顶行合计只加最外层子 agent。

## 增量读取：只交付整行，文件变短或被替换时通知调用方重来

`src/model/tail.ts` 的 `LineTailer` 记着已读的字节数、文件的 inode 和文件开头的 128 字节。每次从已读位置读新增部分，最多 8 MiB，只交付以换行结尾的整行；末尾没写完的半行留着，下次补全后再交。首次读整个文件，所以大文件要分几次读完。

文件变小、inode 变了，或开头的 128 字节对不上（同一个 inode 被改写成更大的文件），都算被截短或替换：从头重读，并在结果里标 `reset`。调用方必须丢掉旧的状态库，新建一个从头喂。

扩展写的 `.out` 用同样的办法按文字读，不同的是用 `StringDecoder` 处理被切开的多字节字符。

## 还没弄清的事

- 不带 `agentId` 的 `abort` 停掉同步子 agent：代码里没有先例；实测的 254 个 session 里，这类 `abort` 出现 30 次，没有一次发生在同步子 agent 在跑的时候。
- `abort` 的 `reason` 为 `user_initiated`（不带 `agentId`）是什么场合，没看懂；状态库不看这个值。
- 约一半的 `subagent.completed` 里，`durationMs` 和“完成时间减开始时间”相差 7 到 118 秒（在 8,299 行的样本里，33 条里有 16 条）；状态库以 `durationMs` 为准，原因没查清。
- `subagent.failed` 的字段只来自旧代码和测试，没有在真实日志里见过。
- `read_powershell`、`stop_powershell`、`write_powershell` 不会和命令关联。

## 相关阅读

- `architecture.md`：状态库、扩展、界面怎么分工，以及状态库的结果怎么和任务列表合并成名单。
- `extension-api.md`：扩展能订阅哪些事件、哪些事件不落盘，以及任务相关方法的行为。
- `processes-and-sessions.md`：命令在操作系统里的样子，以及怎么判断用户正看着哪个 session。
