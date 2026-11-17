# copilot-panes 的架构

这份文档给维护 copilot-panes 的人看：它由哪两个程序组成、数据怎么流动、每个模块管什么，以及找 session、合并任务列表、中断命令这几条关键规则。读完应该知道一个改动该落在哪个文件里、会影响谁。

## 扩展存数据、转任务，界面读文件和 socket 画画面

**扩展**（源码 `extension/src/`，打包成 `dist/extension.mjs`）由 Copilot CLI 为每个 session 启动一个进程。它只做三件界面自己做不到的事：

- 把命令的原始输出存成文件。`tool.shell_output` 事件不写进 `events.jsonl`，订阅晚了就收不到，所以扩展从启动起就存。
- 累加每个子 agent 的用量。`assistant.usage` 事件同样不写进 `events.jsonl`。
- 调用 `session.rpc.tasks.*`：定时查任务列表，替界面发消息、取消、转后台、移除。

**界面**（源码 `src/`，打包成 `dist/copilot-panes.mjs`）是用户在另一个 tmux pane 里运行的 `copilot-panes`，一个进程画全部画面：顶行（有异常时下面多一行提示）、名单、内容区、按键提示行。

两边共用的文件：`src/protocol.ts`（socket 消息和登记记录）、`src/paths.ts`（所有路径）、`src/constants.ts`（时间和上限）、`src/types/`（数据形状）、`src/version.ts`（版本号）。

数据流向：

```
Copilot CLI ──写──▶ session-state/<id>/events.jsonl ─────增量读────▶ 界面
    │ 所有事件（含不落盘的）                                          ▲  │
    ▼                                                                │  │ Ctrl+C：直接给
  扩展 ──追加──▶ copilot-panes/out/<id>/<toolCallId>.out ──增量读───┤  │ 命令的进程发信号
    │ ──每 5 秒重写──▶ copilot-panes/sessions/<id>.json ────读──────┤  ▼
    └── socket copilot-panes/sessions/<id>.sock：hello、tasks、usage、result ◀─▶ request
```

名单上有哪些条目、子 agent 的过程，都来自 Copilot CLI 自己写的 `events.jsonl`；扩展不转发事件。所以扩展没加载时，界面照样能显示名单和过程，只是变成只读。

## 运行时数据放在 `$COPILOT_HOME/copilot-panes/` 下

`COPILOT_HOME` 没设时是 `~/.copilot`，所以默认目录是 `~/.copilot/copilot-panes/`。`--data-dir` 或环境变量 `COPILOT_PANES_HOME` 可以换掉它；`--session-state-dir` 或 `COPILOT_PANES_STATE_DIR` 换掉 Copilot CLI 的 `session-state`。

| 路径 | 谁写 | 内容 |
| --- | --- | --- |
| `sessions/<session ID>.json` | 扩展 | 登记记录：协议版本、session ID、Copilot CLI 和扩展的进程号、`TMUX_PANE`、扩展的工作目录、socket 路径、扩展版本、开始和更新时间。每 5 秒原子地重写（先写临时文件再改名）当作心跳，退出时删掉 |
| `sessions/<session ID>.sock` | 扩展 | unix socket。路径超过 100 字节时改放 `$XDG_RUNTIME_DIR/copilot-panes/`，没有这个变量时放 `mkdtemp` 建的随机 0700 目录。登记记录写实际路径，开不成时是 `null` |
| `out/<session ID>/<toolCallId>.out` | 扩展 | 命令输出原文，按到达顺序追加，保留颜色码和回车符。单个文件到 32 MiB 后写一行说明、不再追加 |
| `tmp/` | 界面 | `o` 键给 `less` 看的临时文件 |

文件名里 `A-Za-z0-9._-` 以外的字符换成 `_`，超过 200 个字符的截短并加哈希。`sessions/`、`out/` 和 `out/<session ID>/` 启动时权限宽了就收紧成 0700，登记记录和 socket 是 0600。扩展启动 2 秒后清理：删掉 7 天没动的 `out/` 子目录，以及 Copilot CLI 进程已经不在的登记记录和它的 socket。

## 扩展先订阅事件，再登记自己、开 socket、轮询任务列表

扩展的逻辑在 `startPanes(session, deps)`（`extension/src/main.ts`），入口 `extension.ts` 只调用 `joinSession()`。session、目录、定时器都是可替换的依赖，测试传假的。启动顺序：

1. 先 `session.on` 订阅所有事件，再做别的，免得漏掉启动期间的输出和用量。
2. 建目录，选 socket 路径并开它（`extension/src/socketdir.ts`）。开不成就每 5 秒重试，期间登记记录里 `socketPath` 是 `null`。
3. 写登记记录，之后每 5 秒重写。
4. 每秒 `tasks.list()`，变了才推，至少每 5 秒推一次；用量变了最多每秒推一次。没有界面连着时降到每 5 秒查一次，界面一连上就马上查。
5. 启动 2 秒后清理。
6. 补读历史（扩展重新加载后需要）：从 `session.getEvents()` 恢复 `shellCalls` 和 `reportedTotalTokens`，`detach` 命令的输出接着抄。

**命令输出怎么存。** `bash` 一开始就建空的 `.out`；`tool.shell_output` 来一段追加一段；输出还没来得及出现就把完成事件里的结果（去掉退出标记）写进去。`detach` 的命令（`detach: true` 起的命令）没有 `tool.shell_output`，改用 `tasks.readOutput` 把增量抄进 `.out`，直到它报告退出。

**shell 任务和命令怎么对应。** shell 任务没有 `toolCallId`，扩展先看命令调用里的 `shellId` 是否等于任务 `id`；否则在还没被认领、命令文字相同、开始时间相差不到 30 秒的调用里取最近的；最近两个候选相差不超过 100 毫秒就不对应。结果放在 `tasks` 消息的 `shellCalls` 里。宁可不对应，也不能停错。

**退出。** Copilot CLI 先发 SIGTERM，宽限期可能只有 1 秒。入口收到后调用 `stop()`，删掉 socket 和登记记录（最多等 3 秒）。`exit` 事件里再同步清理一次，因为 Copilot CLI 被强杀时 SDK 的看门狗会直接 `process.exit`。

两条硬性约束：扩展不能写 stdout（那是和 Copilot CLI 之间的 JSON-RPC 通道），诊断写 stderr；任何一步出错都只记下来（最近一次错误放进 `tasks` 消息的 `error`），不能让扩展进程退出。

## socket 协议每行一条 JSON，界面不盲信对端

定义和解析都在 `src/protocol.ts`。每条消息带协议版本。解析函数从不抛异常，坏消息返回带错误种类的结果。一行最多 8 MiB，超长的整行丢弃。允许多个界面同时连同一个扩展。

| 方向 | 消息 | 内容 |
| --- | --- | --- |
| 扩展 → 界面 | `hello` | 连接建立时第一条：session ID、Copilot CLI 进程号、扩展进程号、扩展版本 |
| 扩展 → 界面 | `tasks` | 连接时一次，之后变了才推，至少每 5 秒一次：SDK 的 `TaskInfo` 原样（文字字段超过 16 KB 截短）、`shellCalls`、扩展最近一次出错 |
| 扩展 → 界面 | `usage` | 连接时一次，之后变了才推，最多每秒一次：每个子 agent 累加的 token 用量和调用次数，以及结束时事件报的 `totalTokens` |
| 扩展 → 界面 | `result` | 每条请求一条：同一个请求编号；成功，或失败加一句给人看的中文原因。等 Copilot CLI 超时时带 `uncertain`：操作可能已经生效，界面不说“没成” |
| 界面 → 扩展 | `request` | 用户操作时发：请求编号，加 `sendMessage`、`cancel`、`promoteToBackground`、`remove`、`refreshTasks` 之一 |

协议版本不同时，界面不再重连，按只读处理，并提示重新安装扩展。请求发出 10 秒内没有结果，界面当作“扩展没有回应”。

**界面不信对端报来的进程号。** 别的进程可以在 socket 路径上放一个假的 socket，它发来的任务列表里有进程号，界面会拿去发信号。所以连之前，界面用 `lstat` 检查 socket 和它所在的目录（`src/bridge/socket-safety.ts`）：不是符号链接，属于当前用户，对组和其他人不可写，不通过就不连。连上后，`hello` 的 session ID 和 Copilot CLI 进程号都要和登记记录一致，进程号还要大于 1。没做的：用 `SO_PEERCRED` 核对对端进程（Node 没有直接的接口）。

## 界面把文件和 socket 变成数据，状态机和视图是纯函数

界面每一步的输入输出：

1. **找 session**（`src/discover/`）：收集候选，用纯函数 `chooseSession` 选一个。
2. **读事件**（`src/model/tail.ts` 的 `LineTailer`）：只读新增的整行，喂给**状态库**（`src/model/store.ts` 的 `SessionStore`）。别的模块只通过 `StoreView` 读它。文件被截短或替换时，调用方新建状态库从头读。
3. **连扩展**（`src/bridge/client.ts`）：得到最近的任务列表（带收到时刻和连接是否还在）和用量。
4. **合成名单**（`src/model/merge.ts` 的 `buildList`）：状态库加任务列表加用量，得出排好序、带缩进的 `ListEntry[]`。行上的文字在这里定好，界面只截断和上色。
5. **组装视图数据**（`src/runtime.ts`）：名单、合计、扩展状态、选中命令的终端内容，合成 `ViewData`。
6. **状态机**（`src/ui/app.ts` 的 `update`）：输入是界面状态、一个输入（按键、数据、请求结果）和上下文（`ViewData`、尺寸、时刻），输出是新状态和要执行的动作（发请求、中断、复制、打开 less、响铃、换 session、退出）。`runtime.ts` 执行动作。
7. **视图**（`src/ui/views/frame.ts` 的 `renderFrame`）：状态、数据、尺寸进，一帧出。
8. **输出层**（`src/ui/output.ts`）：和上一帧逐行比较，只重写变了的行；用备用屏幕；退出时恢复终端；每秒最多约 30 帧。

`src/feed.ts` 的 `SessionFeed` 管一个 session 的全部数据。文件和 socket 都在 `SessionIO` 接口后面：真实的是 `RealSession`，`--demo` 用 `DemoSession`（`src/demo-live.ts`），两者走同一条路径。

## 画面是一帧行加光标，命令输出走终端模拟器

一帧（`Frame`）是若干行加真实光标的位置。颜色用语义名（由主题换成 256 色编号），或直接用 256 色编号、RGB（只用于命令输出自己的颜色）。界面自己只给选中的名单行铺背景色。

选中的命令和名单上在跑的命令各有一个 `TermView`（`src/term/terminal.ts`，包装 `@xterm/headless`），结束又没选中的会释放。`.out` 由 `src/feed.ts` 的 `OutputTail` 增量读：第一次读最后 2 MB，之后只读新增部分。没有 `.out`（扩展没加载）时，视图改用事件日志里的输出，并写明原因。在跑的命令取最后一行：有终端就取终端里的，否则每秒读 `.out` 末尾 4 KB；进度（如 `12/40 30%`）从这一行认出。

## 目录按依赖方向分组，依赖只往后一组走

| 位置 | 管什么 |
| --- | --- |
| `src/protocol.ts`、`paths.ts`、`constants.ts`、`types/`、`version.ts` | 两边共用的约定 |
| `extension/src/` | 扩展 |
| `src/model/` | 增量读文件、解析事件、状态库、合成名单、文字、进度、token |
| `src/ui/` 的基础文件（不含 `views/` 和 `app*.ts`） | 输出层、按键解析、显示宽度、主题、输入框 |
| `src/term/`、`src/bridge/`、`src/discover/` | 终端模拟器、socket 客户端和发信号、找 session |
| `src/ui/app*.ts`、`src/ui/views/`，以及 `src/` 下的 `feed.ts`、`runtime.ts`、`effects.ts`、`demo*.ts`、`cli.ts`、`install.ts`、`doctor.ts` | 状态机、视图、把各部分接起来、演示、命令行 |

最后一组可以用前面所有目录。`src/model/`、`src/bridge/`、`src/discover/`、`src/term/` 互不导入，也不导入界面；`src/ui/` 的基础文件不导入 `src/model/`；扩展只导入共用的文件。

## 找 session：先定候选范围，再选用户正看着的那个

候选 session 来自两处（`src/discover/candidates.ts`）：有效的登记记录（Copilot CLI 进程还在，心跳在 20 秒内），或没装扩展时的 `session-state/*/inuse.<进程号>.lock`（进程号还活着并且像 Copilot CLI）。每个候选带上工作目录、session 名字（都取自 `workspace.yaml`，名字去掉终端控制码）和 `events.jsonl` 的修改时间。纯函数 `chooseSession`（`src/discover/choose.ts`）按下面的顺序选：

1. 命令行 `--session` 指定了，就用它。ID 可以只写前几位：`session-state` 下有同名目录，或给的是完整 UUID，就原样用；否则按前缀匹配，唯一匹配才用，多个或没有就报错。
2. 候选范围：在 tmux 里，是同一窗口里其他 pane 的 Copilot CLI（登记记录的 `tmuxPane` 在这些 pane 里，或 pane 的进程树里有它的进程）开着的所有 session；不在 tmux 里，或同一窗口里没找到，是工作目录和界面相同的 session；都没有，显示等待画面。
3. 用户按 `s` 手选的，只要还是候选就固定在它上面。
4. 范围里按依据从强到弱选：前台线索指到的；最近一次用户发言最新的；最近有事件的。
5. 依据是前台线索或用户发言时，自动换到选出的那个，并提示“已切到「标题」：原因”；依据只是最近有事件时不自动换，因为子 agent 在后台写事件，不代表用户在看它。

前台线索由界面从外面找来，因为扩展接口没有可靠办法知道自己是不是前台。首选是 Copilot CLI 进程日志里最后一条 `Registering foreground session: <ID>`（`src/discover/foreground.ts`），其次是 pane 标题 `<session 名字> - GitHub Copilot`（只有名字，重名就不用）。用户发言取 `events.jsonl` 里最后一条真人发的 `user.message`（`src/discover/session-tail.ts`）。这些线索由 `src/runtime.ts` 读好传给 `chooseSession`，它不碰文件系统。

没接上时每秒找一次；接上活着的 session 后每 5 秒重新评估，已经结束的每 2 秒；另外每秒看一眼进程日志，前台 session 变了就马上重新找。接上的 session 结束、又没有别的候选时，留着它最后的画面。

## 只读时说清原因和怎么恢复

`src/bridge/readonly.ts` 的纯函数 `explainReadonly` 把“有没有登记记录、和扩展连得怎么样、扩展文件装了没有、实验功能开了没有”变成界面要显示的话；界面（`ViewData.statusNotice`、`ViewData.extension`）和 `copilot-panes doctor` 用同一个函数，所以说法一致。后两项在文件系统里查（`src/bridge/extension-env.ts`），换 session 时查一次，之后每 30 秒一次，不在每一帧里读文件。

| 情况 | 提示的意思 |
| --- | --- |
| 有登记记录，socket 还没连上或刚断开不到 3 秒 | 正在连接扩展（灰色，不算出错） |
| 扩展文件没装；协议版本不一致 | 运行 `copilot-panes install` 再重启 |
| 实验功能没开 | 运行 `/settings experimental on` 后重启 |
| 都装了、开了，但这个 session 没有登记记录 | 这个 session 启动时还没装扩展：重新加载扩展，或重启 |
| 登记记录里没有 socket 路径；连了 3 秒以上还没连上 | 扩展没能开成连接，或连不上：重启 Copilot CLI，或运行 `doctor` |
| 安全检查拒绝了连接 | 连接没通过安全检查，并写明原因 |

输入行和被拒绝的按键用同一个原因（`ViewData.extension.cause`）。

## 名单以事件日志为主，扩展连着且任务列表新鲜时校正

**哪些条目上名单。** 所有子 agent；后台命令一启动就上，前台命令跑满 2 秒才上；成功结束的命令立刻消失，失败的留下（最多 5 条）；当前选中的条目即使该消失也留着，直到用户移开选择。任务列表新鲜，指 socket 连着，并且 15 秒内收到过 `tasks` 消息。Copilot CLI 被强行结束、来不及写结束事件时（当前 session 不在候选里，或它的进程已不在），还在跑或待命的条目改成已停（符号 `◌`，`src/model/orphans.ts`），顶行右边写“session 已结束”。

**合并规则**（`buildList`）：

- **子 agent 的状态**先按事件算。任务列表新鲜、并且有 `agentId` 相同的任务时：任务说 `running` 是在跑，说 `idle` 是“做完一轮、等你发话”（`idle` 只有任务列表知道），说 `cancelled` 是已取消；其余仍按事件。
- **已取消和已停分开。** 事件里有取消的记录，或任务列表说 `cancelled`，是已取消；随 session 结束或续接而停、命令随所属子 agent 结束被丢掉，是已停。
- **命令的状态**先看事件。事件说还在跑、而它的 shell 任务已经结束时，按任务的结束状态算，结束后不再上名单，正被选中的除外（`tasks.cancel` 停掉的命令在事件里没有结束通知，靠这一条）。子 agent 结束后，它起的后台命令在对应的 shell 任务还在跑时继续列出，否则丢掉。
- **对上任务。** 子 agent 按 `agentId` 找；命令经 `shellCalls` 找到 shell 任务，取进程号和能否转后台。任务列表不新鲜时所有条目都对不上任务，所有操作不可用。
- **命令的名字**由 `src/model/command-name.ts` 取：去掉 `cd … &&`、环境变量赋值、`env`、`timeout`、`bash -c` 等包装和末尾的输出管道，多行取第一条有意义的命令。原文在内容区按 `e` 看。
- **层级和顺序。** 子 agent 起的子 agent 和命令缩进在它下面，上一级被收起时下级往上顶一层。同一个上一级下面按开始时间排；按状态分组会让行随状态跳来跳去。

## token：取各个数里最大的，含下级，顶行只加最外层

子 agent 显示的数（`tokensByAgent`，`src/model/tokens.ts`）是几个已知数里最大的，所以不会比真实用量小：自己的用量加每个下级显示的数；完成事件的 `totalTokens`。自己的用量取两个里大的那个：`events.jsonl` 里 `session.usage_record` 逐条累加的输入加输出（`AgentRecord.eventTokens`，没有扩展也有），和扩展累加的 `assistant.usage`（`liveTokens`：缓存已算在输入里，不再加；改口径只改它）。

`totalTokens` 是发事件那一刻的累计用量，含下级各级、全程各轮，所以几条完成事件的数不能加起来。追加消息后又跑的几轮没有新的完成事件，它会偏小。顶行只加最外层子 agent 的数，因为它们已含下级。有 `eventTokens` 时在跑的数是全程的数，没有时才可能只是下限（`≥`）。

## 中断命令：界面直接给命令的进程组发信号，按一次升一级

Ctrl+C 不经过 Copilot CLI，因为 SDK 的 `shell.kill` 对 bash 工具起的命令无效。规则在 `src/bridge/signals.ts`：

1. 进程号取自任务列表里 shell 任务的 `pid`。`detach` 的命令不发信号，直接请扩展 `tasks.cancel`，提示行写“已请求停止”：它不是进程组组长，只发 SIGINT 实测停不了。
2. 发信号前检查：Copilot CLI 的进程号大于 1，并取自登记记录；目标进程还在，且是 Copilot CLI 的后代；目标不能是界面自己或它的祖先，也不能在界面自己的进程组里。
3. 进程是自己进程组的组长（进程组号等于进程号）就给整个进程组发，否则只给这个进程发。
4. 第一次发 SIGINT；之后 3 秒内再按不发，提示行写还要等几秒；3 秒后再按发 SIGTERM，再按发 SIGKILL。
5. 拿不到进程号或检查不通过时，退回请扩展调用 `tasks.cancel`。名单里的 `x`（停止）一律走 `tasks.cancel`。

用 `&` 起的后台子进程会忽略 SIGINT，组长收到 SIGINT 后它们还在。

## 测试：纯函数加临时目录，不碰真实的 `~/.copilot` 和用户的 tmux

- 测试用 `node:test`，`npm test` 全部运行；涉及文件、socket 或进程的测试都在临时目录里做：假的数据目录、真的 unix socket、假造的 `/proc` 或自己起的子进程。tmux 的单元测试用假的命令执行函数，只有 `test/ui-core/width-tmux.test.ts` 开独立的 tmux 服务器核对字符宽度表。
- 界面的测试是快照：固定的演示数据（`test/helpers/demo-data.ts`）、固定的时刻，在三种尺寸下各画三帧（焦点在名单、在子 agent 内容区、在命令内容区），纯文字存在 `test/ui/snapshots/`，样式按设计规则的表逐项断言，对比度也在这里查。改了界面后要重新生成快照，再看 `git diff` 确认变化是想要的。

## 相关阅读

- `design.md`：界面的视觉规则：原则、颜色表、每种状态的样式、内容区的半框。
- `development.md`：怎么构建、测试、部署，以及真实联调脚本怎么用。
- `notes/events-log.md`：`events.jsonl` 里和子 agent、命令有关的事件，以及状态库怎么从它们得出数据。
- `notes/extension-api.md`：扩展能订阅什么、能调用什么，以及扩展进程的生命周期。
- `notes/processes-and-sessions.md`：命令在系统里的样子、信号对谁有效，以及怎么判断哪个 session 在前台。
