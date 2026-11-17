# 后台命令在系统里的样子，信号对谁有效，哪个 session 在前台

这份文档给维护 copilot-panes 的人看，写三件和操作系统有关的事实：Copilot CLI 起的命令是什么样的进程；给它们发信号对哪些情况有效；一个 Copilot CLI 进程开着多个 session 时，怎么判断用户正看着哪个。读完应该知道中断命令和选 session 的规则为什么是现在这样。没有特别说明的事实，都是在 Copilot CLI 1.0.112、tmux 3.4、Linux 上实测的。

## 命令是 Copilot CLI 的子进程，`attached` 的是进程组组长，`detached` 的不是

任务列表里 shell 任务的 `pid` 是命令自己的进程号。`attachmentMode` 是 `attached`（由 Copilot CLI 管着）或 `detached`（`detach: true` 起的）：

| 种类 | 父进程 | 进程组号 | 是不是组长 |
| --- | --- | --- | --- |
| `attached`：主 agent 和子 agent 起的前台命令、后台命令 | Copilot CLI 本身 | 等于自己的进程号 | 是 |
| `detached` | 一个 `sh -c … copilot-detached-supervisor` 进程（它的父进程是 Copilot CLI） | 等于 supervisor 的进程号 | 否 |

主 agent 和子 agent 起的命令没有区别，都是 Copilot CLI 的直接子进程。

后台命令的标准输入是 `/dev/null`，没有伪终端。所以谁都没法给它打字，界面里在命令的内容区按字符键，只会提示“这条命令不接受输入，只能中断”。Copilot CLI 的更新日志说，从 1.0.62 起 `write_bash` 也不再支持交互输入（来自更新日志，没验证）。

## 给进程组发 SIGINT 对 `attached` 命令有效，对 `detached` 命令无效

- **`attached` 的后台命令：** 给它的进程组发 SIGINT，进程 0.5 秒内消失；Copilot CLI 显示 `exited (code 130)`；任务状态变成 `completed`（不是 `failed`），日志里是 `shell_completed` 通知，退出码 130；Copilot CLI 还会自动让 agent 读输出并回复一条。另外，从别的进程给一个测试命令发 `kill -INT <进程号>`，命令打印出收到信号的标记并以 130 退出。
- **忽略 SIGINT 的命令：** 命令里写了 `trap "" INT` 时，SIGINT 无效。3 秒后再发 SIGTERM 才停下，退出码 143。所以界面的 Ctrl+C 是逐级升级的：SIGINT，3 秒后 SIGTERM，再按 SIGKILL。
- **命令里用 `&` 起的子进程：** 在非交互的 bash 里，后台子进程忽略 SIGINT（`/proc/<进程号>/status` 的 `SigIgn` 里有 SIGINT），所以组长收到 SIGINT 退出后，它们还留着。只在本机的 bash 里验证过。
- **`detached` 的命令：** `pid` 不是进程组组长，只给这一个进程发 SIGINT，5 秒后命令还在跑，因为 bash 在等它的 `sleep` 子进程。`tasks.cancel` 能杀掉整条命令，状态变 `cancelled`。所以界面对 `detached` 命令不发信号，直接请扩展 `tasks.cancel`。
- **SDK 的 `shell.kill`：** 它只对 `shell.exec` 起的进程有效，对 bash 工具起的命令没有发信号的办法，所以 Ctrl+C 要界面自己发信号。
- **pytest、npm 这类真实命令能不能被 SIGINT 停下：** 没测过。停不下来就用名单里的 `x`（`tasks.cancel`）。

**发信号前的检查**（`src/bridge/signals.ts`）。进程号可能被别的进程重用，也可能被伪造的扩展骗去杀不相干的进程，所以每次发之前：

1. Copilot CLI 的进程号要大于 1，并且取自扩展的登记记录，不取 socket 对端 `hello` 里报的。进程号 1 是所有进程的祖先，祖先检查对它永远通过。
2. `/proc/<进程号>` 还在，并且 Copilot CLI 是它的祖先。
3. 目标不能是界面自己或它的祖先，信号要发往的进程组也不能是界面所在的进程组。
4. 进程是自己进程组的组长（进程组号等于进程号）就给整个进程组发，否则只给它一个进程发。
5. 进程号 0、1、-1 绝不发。

检查不通过，或者拿不到进程号，就退回请扩展调用 `tasks.cancel`。用假的扩展做过两种对抗测试：`hello` 里报的 Copilot CLI 进程号和登记记录对不上，界面拒绝连接、不发信号；进程号对，但 shell 任务的 `pid` 指向不属于 Copilot CLI 的进程，界面不发信号，只请扩展取消。两次目标进程都活着。

## 一个 Copilot CLI 进程可以同时开着很多 session，没有接口告诉你哪个在前台

实测一个进程同时开着 10 个 session（用过 `/new` 或恢复了旧 session）。copilot-panes 想显示用户正看着的那个，从外面找线索。四种线索，实测结果如下。

**进程日志里的 `Registering foreground session`：可靠，首选。**

- 文件是 `<COPILOT_HOME>/logs/process-<启动毫秒>-<进程号>.log`，进程号是 `copilot` 本体的，也就是登记记录里的 `copilotPid`。
- 用户在 Copilot CLI 里切换 session 时，写一对 `Unregistering …`、`Registering …`，相隔不到 10 毫秒；启动时写一次；发言、跑子 agent 时不写。
- 可靠的依据：在一个进程的 56 条真人发言里，54 条落在它所在的 session 当前台的时间段内；另 2 条晚了 1 到 30 秒，和“消息排了队、用户已经切走”相符（没验证）。另一个进程最后一条登记的 session 名，也和它所在 pane 的标题一致。
- 曾有一次查到“最后一条不对”，后来没有复现，原因不明。

**pane 标题：可靠，但只有名字。** 标题是 `<session 名字> - GitHub Copilot`，名字等于 `workspace.yaml` 的 `name`，和日志最后一条指向的 session 一致。局限：没有 session ID，两个 session 重名就指不到；session 改名后标题多久更新，没验证。只在日志读不到时才用，重名不用。读标题用 `tmux display-message -p`，不改任何 tmux 设置。

**屏幕内容：不能用。** `capture-pane -p` 抓到的是左边的 session 列表加右边的内容。纯文本看不出哪一行被选中（高亮是颜色，要加 `-e`），也没有 session ID。

**最近一次用户发言：不是前台线索，只当第三选择。** 用户可以切到一个 session 只看不说话，发言时间看不出他在看哪个。只统计没有 `agentId`、`source` 为空、为 `user` 或以 `command-` 开头的 `user.message`。

copilot-panes 的做法：每秒看一眼进程日志里新增的部分（只读新增，很便宜）；第一次从文件末尾往前一块一块读，直到找到登记记录，最多往前 16 MB。日志文件按进程号找，同一个进程号取启动时刻最新的；找不到就每 10 秒再列一次目录。session ID 要写全 36 个字符才算一条记录，没写完的半行不会被当成记录。最后一件事是 `Unregistering` 的，说明现在没有前台 session。标题里的终端控制码和方向控制符会先去掉，因为 pane 标题谁都能设。

## 用 `/proc` 和 tmux 找到 Copilot CLI 和它的 pane

copilot-panes 只支持 Linux，因为要读 `/proc`：

- `/proc/<进程号>/stat` 里取父进程号、进程组号和启动时刻。程序名在括号里，可以含空格和括号，所以要从最后一个 `)` 往后切字段。
- `/proc/<进程号>/cmdline` 按 `\0` 切开，判断进程像不像 Copilot CLI。
- 整个进程表读一遍，才能找到界面自己所在 tmux 窗口里的 Copilot CLI 进程。这是界面空闲时最大的 CPU 开销，所以放慢到每 5 秒，窗口布局最多每 30 秒重新量一次。

tmux 只问一件事：`tmux list-panes -t <界面所在的 pane> -F "#{pane_id} #{pane_pid} #{window_id}"`，得到同一个窗口里每个 pane 的 shell 进程号，再沿进程树找 Copilot CLI。扩展的环境里有 `TMUX_PANE`，登记记录里的 `tmuxPane` 与 `tmux display -p '#{pane_id}'` 一致。

没有装扩展时，候选 session 靠 session 目录里的 `inuse.<进程号>.lock`：进程号还活着并且像 Copilot CLI，才算数。

## 还没验证的事

- pytest、npm 这类真实命令能不能被 SIGINT 停下。
- session 改名后 pane 标题多久更新。
- 沙箱开启时，扩展写数据目录、开 unix socket 的行为。
- `Registering foreground session` 日志行的格式在别的 Copilot CLI 版本里是否不变；这是读日志，不是公开接口。
- 只在 Linux 上做过；macOS 没有 `/proc`，没试。

## 相关阅读

- `architecture.md`：找 session 的规则，和中断命令在状态机里怎么走。
- `extension-api.md`：`tasks.cancel`、`readOutput` 的行为，以及扩展接口里没有“前台 session”的原因。
- `events-log.md`：后台命令的 `shellId` 和结束通知怎么从事件里得出。
