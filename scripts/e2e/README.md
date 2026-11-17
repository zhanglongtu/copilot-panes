# 真实 Copilot CLI 联调脚本

用独立的 tmux 服务（`-L cp-e2e`）起一个真实的 Copilot CLI，左 pane 跑它，右 pane 留给界面；扩展以项目级扩展装在 `.scratch/e2e/proj/.github/extensions/`，不碰 `~/.copilot/extensions/`。数据都放在 `.scratch/e2e/`（git 忽略）。真实 session 会花钱：用环境变量 `E2E_MODEL` 指定模型 ID（必填，没有默认值），建议选便宜的；一整轮场景约几美分。

```
E2E_MODEL=<模型 ID> scripts/e2e/start.sh [--build]   # 起环境（--build：重新构建，产物写到 .scratch/e2e/dist/，不动 dist/）：左 pane 是 Copilot CLI（等输入框就绪、等扩展登记，约 10 秒），右 pane 是干净的 bash
scripts/e2e/ui.sh start                    # 在右 pane 起界面；ui.sh key|type|line|screen|wait|stop 操作和读屏
scripts/e2e/send.sh --list                 # 现成的提示；send.sh <名字> 送进左 pane；send.sh -t "/new" 送任意文字
node scripts/e2e/probe.mjs watch           # 不用界面时：打印 hello、每次 tasks 和 usage 推送、.out 大小变化
scripts/e2e/scenario.sh                    # 或者一次跑完全部场景（约 6 分钟）
scripts/e2e/stop.sh                        # 退出 Copilot CLI、关 tmux 服务、确认没留进程、核对 settings.json
```

先开界面再开 Copilot CLI：`start.sh --no-cli`，再 `ui.sh start`，最后 `cli.sh start`。没有扩展的 session：`cli.sh start --noext`。退出 Copilot CLI：`cli.sh exit`。

## 脚本

| 文件 | 作用 |
| --- | --- |
| `start.sh` | 建 `.scratch/e2e/proj`（自己 `git init`，否则项目级扩展会找到外层仓库的 `.github/`），复制扩展，起 tmux。`E2E_NO_TRUST_ENV=1` 去掉 `COPILOT_ALLOW_ALL`，用来看“是否信任这个目录”的提问 |
| `cli.sh` | `start [--noext] [--no-wait]` 在左 pane 起 Copilot CLI；`exit` 发 `/exit` |
| `ui.sh` | 右 pane 里运行和操作界面（`start`、`key`、`type`、`line`、`screen`、`wait`、`stop`、`pid`）。`stop` 先按 Escape 离开内容区，再按 `q`：内容区里 `q` 只是一个字符 |
| `send.sh` / `screen.sh` | 往左 pane 送提示或按键（`-k Escape`）；`screen.sh [right] [-w 正则 [秒]]` 看画面或等某段文字出现 |
| `attach.py <秒> [文件]` | 给 tmux 服务接一个伪终端客户端；界面的 `o`（`display-popup` 开 less）没有客户端会失败 |
| `probe.mjs` | 像界面一样连 socket。一次性命令：`info`、`tasks`、`find`、`send`、`cancel`、`promote`、`remove`、`refresh`、`sigint`。`--session <ID 前缀>` 选 session，默认取最新的 |
| `spy-extension.mjs` | 旁观用的项目级扩展，不经被测扩展，原样记下所有事件和每次 `tasks.list()`（`.scratch/e2e/spy/`）。`probe.mjs raw tasks.cancel '{"id":"1"}'` 经它直接调用 SDK |
| `compare-out.mjs` | `.out` 和真实事件逐字节对照 |
| `rogue-extension.mjs` | 冒充扩展的假 socket 服务，验证界面不会被对端报来的进程号骗去给别的进程发信号；只在自己的数据目录里运行 |
| `emit.sh`、`progress.sh`、`trapint.sh`、`bigout.sh` | 测试命令：每秒一行带颜色的文字加 `\r` 进度；`[###---] 12/40` 样式的进度行；忽略 SIGINT 的命令；打印大量行（`bigout.sh <行数> [每行补到的字节数] [退出码]`） |
| `make-fixture.mjs` | 把一次联调的 session 日志、`.out`、探针和旁观者的记录整理到 `.scratch/e2e/fixture/`，并扫一遍密钥和主目录路径。里面是真实内容，放进仓库前要自己改成虚构的 |
| `prompts/*.txt` | 现成的提示（`send.sh --list`）：同步、后台、detach、失败的命令，子 agent 的各种起法，忽略 SIGINT 的命令，大输出，`reload-ext` |

## 不碰全局设置

`copilot` 的 `--no-mouse` 会把 `"mouse": false` 写进 `~/.copilot/settings.json`，别的正在运行的 session 读到后会关掉鼠标；`--experimental` 会写 `"experimental": true`。所以：

- `start.sh` 不传这两个参数；`E2E_COPILOT_ARGS` 里出现 `--no-mouse`、`--mouse`、`--experimental`、`--no-experimental`、`--dynamic-retrieval` 就拒绝启动。项目级扩展需要实验功能，`start.sh` 只检查设置里 `experimental` 已经是 `true`，不替你改。
- `start.sh` 启动前把设置文件备份到 `.scratch/e2e/settings.json.before`；`stop.sh` 退出后核对，不一致就打印差别、退出码 4，绝不自动改回：可能是联调改的，也可能是你在别的 session 里改的，由你决定。
- 要试新的 `copilot` 参数，先在隔离的 `COPILOT_HOME`（拷一份设置当种子）里起一次，看设置文件有没有变，再放进脚本。

## 其他注意

- 同一时间只能有一个环境；`stop.sh` 只动 `-L cp-e2e` 的 tmux 和环境里带本次数据目录的进程。
- 界面联调要用 `ui.sh`，不要在 bash 工具里直接运行界面：界面往终端写控制码。读屏用 `ui.sh screen`（`capture-pane -p`，没有控制码）。
- 命令输出里有终端控制码：`.out` 原文、`tmux capture-pane -e` 的输出别直接打印到会被 Copilot CLI 显示的终端，用 `cat -v` 或写进文件。
- 模型有时不照提示办（例如拒绝 `detach: true`），重送一次，或看 `screen.sh`。
- 提示模式 `copilot -p` 没做：项目级扩展在 `-p` 下要设 `GITHUB_COPILOT_PROMPT_MODE_EXTENSIONS=true` 才加载，而界面联调需要活着的交互式 session。
