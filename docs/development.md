# 开发：构建、测试、部署、真实联调和截图

这份文档给要改 copilot-panes 的人看：仓库里每个目录放什么，怎么跑测试和构建，怎么把自己改的版本装到机器上用，怎么用真实的 Copilot CLI 联调，怎么重新生成截图，以及 CI 做什么。

## 目录一览

| 位置 | 放什么 |
| --- | --- |
| `src/` | 界面。入口是 `src/cli.ts`；`model/` 是事件解析和名单合成，`ui/` 是状态机和视图，`bridge/` 是连扩展的 socket 客户端和发信号，`discover/` 是找 session，`term/` 是终端模拟器 |
| `extension/src/` | 装进 Copilot CLI 的扩展，入口是 `extension.ts` |
| `test/` | 测试，目录和被测的代码一一对应（`test/model/`、`test/ui/` 等）。`test/fixtures/events/` 是虚构的事件样本：每个场景一个手写文件，外加 `synthetic-session.jsonl`（由同目录的 `gen-synthetic-session.mjs` 生成，种子固定，改了生成脚本要把新文件一起提交）；`test/helpers/` 是共用的测试工具 |
| `scripts/` | `deploy.mjs`（部署）、`version-plugin.mjs`（构建用）、`e2e/`（真实联调）、`bench/`（基准测试）、`dev/ansi2png.py`（截图） |
| `build.mjs`、`package.json`、`tsconfig.json`、`.editorconfig`、`LICENSE` | 用 esbuild 打包出 `dist/copilot-panes.mjs` 和 `dist/extension.mjs`；依赖和脚本；类型检查设置；编辑器格式设置；MIT 许可全文 |
| `.github/workflows/ci.yml` | CI |
| `docs/` | 文档 |
| `dist/`、`.scratch/` | 构建产物和联调、基准测试的数据，都被 `.gitignore` 排除 |

## 环境要求和日常命令

要求：Linux（读 `/proc`）、Node.js 22.18 以上（它能直接运行 `.ts` 文件，测试和 `npm run dev` 都靠这个）。tmux 和 `python3` 只有个别测试要用，没装会跳过。

| 命令 | 做什么 |
| --- | --- |
| `npm ci` | 按 `package-lock.json` 装依赖。运行时依赖只有 `@xterm/headless`，它会被打进界面的产物里 |
| `npm run dev` | 直接用源码运行界面（`node src/cli.ts`），可以加选项，例如 `npm run dev -- --demo` |
| `npm run typecheck` | `tsc --noEmit`，覆盖 `src`、`extension/src`、`test` 和 `scripts/bench` |
| `npm test` | 运行 `test/` 下所有 `*.test.ts`（`node --test`），约 10 秒。每个测试进程先加载 `test/helpers/isolate-home.ts`：把主目录换成临时目录，清掉 `COPILOT_*`、`TMUX` 等环境变量，所以测试不碰真实的 `~/.copilot` 和你的 tmux，在 tmux 或 Copilot CLI 里运行结果也一样 |
| `npm run build` | 生成 `dist/copilot-panes.mjs` 和 `dist/extension.mjs` |
| `npm run deploy` | 见“部署到自己的机器”一节 |

只跑一个文件或目录时，也要带上同一个预加载：`node --import ./test/helpers/isolate-home.ts --test test/model/store.test.ts`。

构建的两个细节：

- 扩展的产物把 `@github/copilot-sdk` 当外部依赖，因为 Copilot CLI 加载扩展时会提供它。所以扩展不能脱离 Copilot CLI 单独运行；`scripts/e2e/spy-extension.mjs` 同理。
- 版本号只把 `package.json` 里的 `version` 这一个字符串编进产物（`scripts/version-plugin.mjs`），不编整个文件。这样改脚本或依赖不会让扩展的产物变化，也就不会让 `copilot-panes doctor` 报“扩展版本不一样”。`BUILD_OUTDIR` 环境变量可以把产物写到别的目录，不动 `dist/`。

## 部署到自己的机器：`npm run deploy`

如果 `copilot-panes` 命令直接指向 `dist/`，每次构建都会立刻影响正在用的界面。`npm run deploy` 解决这个问题：先类型检查、构建、测试，全部通过后，才把 `copilot-panes.mjs` 和 `extension.mjs` 原子地复制到 `~/.local/share/copilot-panes/current/`（`COPILOT_PANES_DEPLOY_DIR` 可以换目录）。任何一步失败，什么都不复制。

让命令指向这个目录：

```sh
ln -sf ~/.local/share/copilot-panes/current/copilot-panes.mjs ~/.local/bin/copilot-panes
```

`copilot-panes install` 在程序文件旁边找 `extension.mjs`，所以部署目录里的两个文件要放在一起。扩展有变化时，`deploy` 会提示再运行一次 `copilot-panes install`，并重启 Copilot CLI（或对它说“重新加载扩展”）。

## 真实联调：`scripts/e2e/` 起一个真实的 Copilot CLI，逐项检查界面和扩展

单元测试用假的 session。要确认和真实的 Copilot CLI 配合得对，用 `scripts/e2e/` 里的脚本。它们用独立的 tmux 服务（`-L cp-e2e`，不碰你自己的 tmux）：左 pane 跑 Copilot CLI，右 pane 留给界面。扩展以项目级扩展装在 `.scratch/e2e/proj/.github/extensions/`，不碰 `~/.copilot/extensions/`；所有数据放在 `.scratch/e2e/`。

**真实 session 要花钱。** 用环境变量 `E2E_MODEL` 指定模型 ID（必填，没有默认值），选一个便宜的。一整轮场景约 6 分钟，花费随模型而变。

典型流程：

```
E2E_MODEL=<模型 ID> scripts/e2e/start.sh [--build]   # 起环境；--build 重新构建，产物写到 .scratch/e2e/dist/，不动 dist/
scripts/e2e/ui.sh start            # 在右 pane 起界面
scripts/e2e/send.sh --list         # 列出现成的提示；send.sh <名字> 送进左 pane
scripts/e2e/ui.sh screen           # 读界面的画面；还有 key、type、line、wait、stop
scripts/e2e/scenario.sh            # 或者一次跑完全部场景
scripts/e2e/stop.sh                # 退出 Copilot CLI、关 tmux 服务、确认没留进程、核对 settings.json
```

先开界面再开 Copilot CLI：`start.sh --no-cli`，再 `ui.sh start`，最后 `cli.sh start`。没有扩展的 session：`cli.sh start --noext`。退出 Copilot CLI：`cli.sh exit`。

| 脚本 | 作用 |
| --- | --- |
| `start.sh`、`stop.sh` | 建 `.scratch/e2e/proj`（脚本在里面 `git init`，否则项目级扩展会找到外层仓库的 `.github/`）、复制扩展、起和关 tmux。`E2E_NO_TRUST_ENV=1` 去掉 `COPILOT_ALLOW_ALL`，用来看“是否信任这个目录”的提问 |
| `cli.sh` | 在左 pane 起或退出 Copilot CLI |
| `ui.sh` | 在右 pane 里运行和操作界面。`stop` 先按 Escape 离开内容区再按 `q`，因为内容区里 `q` 只是一个字符 |
| `send.sh`、`screen.sh` | 往左 pane 送提示或按键；`screen.sh [right] [-w 正则 [秒]]` 看画面或等某段文字出现 |
| `attach.py <秒> [文件]` | 给 tmux 服务接一个伪终端客户端。界面的 `o` 键用 `display-popup` 开 less，没有客户端会失败 |
| `probe.mjs` | 像界面一样连 socket：`watch` 持续打印，`info`、`tasks`、`find`、`send`、`cancel`、`promote`、`remove`、`refresh`、`sigint`、`raw`、`wait` 是一次性命令；`--session <ID 前缀>` 选 session |
| `spy-extension.mjs` | 另一个项目级扩展，不经被测扩展，原样记下所有事件和每次 `tasks.list()`，用来核对被测扩展 |
| `compare-out.mjs` | 把 `.out` 和真实事件逐字节对照 |
| `rogue-extension.mjs` | 冒充扩展的假 socket 服务，验证界面不会被对端报来的进程号骗去给别的进程发信号 |
| `emit.sh`、`progress.sh`、`trapint.sh`、`bigout.sh` | 测试命令：带颜色和 `\r` 进度的输出；`[###---] 12/40` 样式的进度行；忽略 SIGINT 的命令；打印大量行 |
| `prompts/*.txt` | 现成的提示：同步、后台、`detach`、失败的命令，子 agent 的各种起法，忽略 SIGINT 的命令，大输出，重新加载扩展 |
| `make-fixture.mjs` | 把一次联调的 session 日志、`.out`、探针和旁观者的记录整理到 `.scratch/e2e/fixture/`（不进 git），并扫一遍令牌和主目录路径。里面是真实内容，放进仓库前要自己改成虚构的 |

### 联调不能改你的全局设置

Copilot CLI 有些命令行参数会把值写进全局的 `~/.copilot/settings.json`，而别的正在运行的 session 会读到：`--no-mouse` 写入 `"mouse": false`，`--experimental` 写入 `"experimental": true`。实测（Copilot CLI 1.0.112）不写设置的参数有 `--model`、`--allow-all`、`--no-custom-instructions`、`--no-ask-user`、`--disable-builtin-mcps`、`--name`、`--log-level`、`--log-dir`、`--no-auto-update`，环境变量 `COPILOT_ALLOW_ALL=true`，以及在目录信任确认里选“信任”。所以联调脚本：

- 不传 `--no-mouse` 和 `--experimental`。`E2E_COPILOT_ARGS` 里出现 `--no-mouse`、`--mouse`、`--experimental`、`--no-experimental`、`--dynamic-retrieval` 就拒绝启动。项目级扩展需要实验功能，所以 `start.sh` 只检查设置里 `experimental` 已经是 `true`，不替你改。
- 启动前把设置文件备份到 `.scratch/e2e/settings.json.before`；`stop.sh` 退出后核对，不一致就打印差别、退出码 4，绝不自动改回，由你决定。
- 要试新的 `copilot` 参数，先在隔离的 `COPILOT_HOME`（拷一份设置当种子）里起一次，看设置文件有没有变，再放进脚本。

### 其他注意

- 联调用的是真实的 `~/.copilot`：测试 session 会出现在 Copilot CLI 的 session 列表里；你配置的钩子会对它运行；设置里 `remoteSessions` 为 `true` 时，它会注册成可远程控制。
- 同一时间只能有一个环境；`stop.sh` 只动 `-L cp-e2e` 的 tmux 和带本次数据目录的进程。
- 联调界面要用 `ui.sh`，不要在没有终端的工具里直接运行界面：界面会往终端写控制码。读屏用 `ui.sh screen`（`capture-pane -p`，没有控制码）。
- 命令输出里有终端控制码：`.out` 原文和 `tmux capture-pane -e` 的输出，用 `cat -v` 看，或写进文件，别直接打印到 Copilot CLI 显示的终端。
- 模型有时不照提示办（例如拒绝 `detach: true`），重送一次，或用 `screen.sh` 看它在干什么。
- 提示模式 `copilot -p` 没做：项目级扩展在 `-p` 下要设 `GITHUB_COPILOT_PROMPT_MODE_EXTENSIONS=true` 才加载，而界面联调需要活着的交互式 session。
- 写用 tmux 驱动界面的测试时：每个测试用独立的 `-L` socket，外层会话加 `-f /dev/null`（不读你的配置）；等某段文字出现要轮询 `capture-pane -p`，不要用固定的 `sleep`；同一个 socket 上 `kill-server` 后马上 `new-session` 偶尔会失败，每次换一个 socket。

## 重新生成快照、宽度表和截图

**字符宽度表。** `src/ui/width-table.ts` 由 `test/ui-core/gen-width-table.ts` 生成，不要手改：它在独立的 tmux 里逐个码点实测宽度（当前表来自 tmux 3.4）。升级 tmux 或 glibc 后，`width-tmux.test.ts` 报不一致时，运行 `node test/ui-core/gen-width-table.ts` 重新生成。

**快照。** `test/ui/snapshots/` 里是固定演示数据、固定时刻画出的纯文字帧，三种尺寸（110×40、80×24、50×20）各三个视图。改了界面后：

```sh
UPDATE_SNAPSHOTS=1 node --import ./test/helpers/isolate-home.ts --test test/ui/snapshot.test.ts
git diff test/ui/snapshots
```

确认 diff 是想要的变化再提交。

**README 里的截图**在 `docs/images/`，用演示数据画，不需要 Copilot CLI。做法：

1. 开一个独立的 tmux 服务，把窗口设成 100 列 × 30 行，在里面运行 `npm run dev -- --demo`（浅色截图加 `--light`）。例如：`tmux -L cp-shot -f /dev/null new-session -d -s shot -x 100 -y 30 "npm run dev -- --demo"`。
2. 把画面带颜色地抓下来：`tmux -L cp-shot capture-pane -e -p -N -t shot > screen.ans`。`-N` 保留行尾的空格，不加的话选中行行尾铺的底色会丢。
3. 转成 PNG：`python3 scripts/dev/ansi2png.py screen.ans screen.png --theme dark --cols 100 --rows 30`（浅色用 `--theme light`）。每张约 1020×650 像素，100 到 170 KB。
4. 用完关掉服务：`tmux -L cp-shot kill-server`。

`ansi2png.py` 需要 Pillow（`python3 -c "import PIL"` 能通过）。字体用 DejaVu Sans Mono 和 Noto Sans Mono CJK SC：脚本先问 fontconfig，再试几个常见的安装路径，都找不到就报错，并说明怎么用 `--latin-font`、`--cjk-font` 等选项指定字体文件。它一格一格地画，汉字占两格，框线、色块和盲文点自己画，所以不依赖字体里有没有这些字符。

三张图是：`list-focus.png`（深色，焦点在名单，选中在跑的 `fix-login`）、`content-focus.png`（深色，按 `Enter` 进入 `fix-login` 的内容区，输入框里打了一句中文、没发送）、`light.png`（`--light`，焦点在名单，选中在跑的 `python3 -u score.py` 命令）。演示里的 `score.py` 命令启动后约半分钟结束，拍 `light.png` 要在启动后马上按 `↓` 五次选中它再抓屏。

## CI 在 Ubuntu 上跑类型检查、测试和构建

`.github/workflows/ci.yml` 在每次推送和拉取请求时运行：Ubuntu，Node 22，先装 tmux，然后依次 `npm ci`、`npm run typecheck`、`npm run build`、`npm test`。构建排在测试前面，是因为 `test/extension/bundle.test.ts` 要检查 `dist/extension.mjs`，没构建会跳过。tmux 要装，是因为字符宽度测试会起独立的 tmux 服务。

## 基准测试

两个脚本测性能，不属于 `npm test`：

- `npm run bench:cpu -- [空闲|在跑|演示|等待|全部] [秒数，默认 30]`：在独立的 tmux 服务（`-L cp-bench`）里起一个假的 Copilot CLI 进程和界面，数据放在 `.scratch/cpu/`，用界面进程的 `/proc/<pid>/stat` 算 CPU 占用。
- `npm run bench:transcript -- [条数，默认 10000]`：很长的子 agent 过程记录画一帧要多久，每个场景一行，单位毫秒。目标（1 万条）：第一帧不超过 16，之后每帧不超过 2。

## 相关阅读

- `architecture.md`：两个程序怎么分工，数据怎么流动，每个模块管什么。
- `design.md`：界面的视觉规则，改样式前先看。
- `notes/extension-api.md`：写扩展代码时，Copilot CLI 扩展接口的实测行为。
