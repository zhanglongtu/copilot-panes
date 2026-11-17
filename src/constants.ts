// 各模块共用的时间、上限和界面尺寸。数字集中在这里，扩展和界面用同一个值。

// ───── 扩展 ─────

/** 扩展每隔这么久调用一次 tasks.list()。 */
export const TASKS_POLL_MS = 1000;
/** 没有界面连着时，扩展调用 tasks.list() 的间隔（没人看，不必每秒查；界面一连上就立刻查一次）。 */
export const TASKS_IDLE_POLL_MS = 5000;
/** 任务列表没变时，扩展至少每隔这么久推一次，当作保活。 */
export const TASKS_KEEPALIVE_MS = 5000;
/** 扩展每隔这么久重写一次登记记录，当作心跳。 */
export const REGISTRATION_HEARTBEAT_MS = 5000;
/** 单个 .out 文件的上限。超过后不再追加，并在文件末尾写一行说明。 */
export const OUT_FILE_MAX_BYTES = 32 * 1024 * 1024;
/** 扩展启动时删掉最后修改早于这么久之前的 out/<session ID> 目录。 */
export const OUT_RETENTION_MS = 7 * 24 * 3600 * 1000;
/** TaskInfo 里单个文字字段（prompt、result、latestResponse、error、description）转发时最多这么多字符，超出截断并加 "…"。 */
export const TASK_TEXT_MAX_CHARS = 16 * 1024;
/** detach 命令没有 tool.shell_output，扩展用 tasks.readOutput 抄输出，每次最多等这么久。 */
export const DETACHED_READ_WAIT_MS = 2000;

// ───── 界面和扩展之间 ─────

/** 界面最近一次收到任务列表超过这么久，就当作没有任务列表。 */
export const TASKS_STALE_MS = 15000;
/** 登记记录超过这么久没更新，就当作扩展已经不在。 */
export const REGISTRATION_STALE_MS = 20000;
/** 请求发出后这么久没有结果，界面当作失败：“扩展没有回应”。 */
export const REQUEST_TIMEOUT_MS = 10000;
/** 连接断开或连不上时，隔这么久重连。 */
export const RECONNECT_MS = 1000;

// ───── 找 session ─────

/** 已经接上 session 时，每隔这么久重新评估一次要不要换。 */
export const DISCOVER_FOLLOW_MS = 2000;
/** 已经接上一个活着的 session 时，每隔这么久重新评估一次（空闲时找 session 是界面最大的 CPU 开销，所以放慢）。 */
export const DISCOVER_STEADY_MS = 5000;
/** 界面自己所在的 tmux 窗口（要扫全部进程才知道）最多隔这么久重新量一次；候选 session 的进程变了会提前重量。 */
export const LOCATE_SELF_REFRESH_MS = 30000;
/** 等待画面上，每隔这么久重新找一次。 */
export const DISCOVER_WAITING_MS = 1000;
/** 接上 session 之后，每隔这么久看一眼前台线索（Copilot CLI 进程日志里的前台 session）；变了就马上重新找。只读日志新增的部分，很便宜。 */
export const FOREGROUND_CHECK_MS = 1000;
/** 扩展装了没有、实验功能开了没有：换 session 时查一次，之后隔这么久查一次（不要每帧读文件）。 */
export const EXTENSION_ENV_REFRESH_MS = 30000;
/** 其他 session 里有几个条目在跑：隔这么久重新读它们 events.jsonl 的末尾（文件没变就不读）。 */
export const OTHER_SESSIONS_REFRESH_MS = 5000;
/** 自动换 session 的提示（“已切到「…」：…”）显示这么久。 */
export const SWITCH_NOTICE_MS = 6000;

// ───── 名单规则 ─────

/** 前台命令跑满这么久才上名单；后台命令一启动就上。 */
export const FOREGROUND_LIST_AFTER_MS = 2000;
/** 结束后留在名单里的失败命令最多这么多条，超出时去掉最早结束的。 */
export const FAILED_COMMANDS_KEPT = 5;
/** 后台命令从 read_bash 结果里攒的输出，每条命令最多这么多字符（没有 .out 时的退路）。 */
export const BG_EVENT_OUTPUT_CAP = 1_000_000;
/** 读命令输出的最后一行时，只读文件末尾这么多字节。 */
export const LAST_LINE_TAIL_BYTES = 4096;
/** 过程记录里每个工具结果最多留这么多字符（e 键展开时显示），超出截断。 */
export const TOOL_RESULT_KEEP_CHARS = 64 * 1024;
/** 子 agent 最后一条回复最多留这么多字符，用来取“最近一步”的第一句正文。 */
export const LAST_REPLY_KEEP_CHARS = 600;

// ───── 按键和提示 ─────

/** x（停止）第一次按下后，这么久之内再按才执行。 */
export const CONFIRM_WINDOW_MS = 2000;
/** 名单里第一次按 Ctrl+C 后，这么久之内再按才退出。 */
export const QUIT_WINDOW_MS = 2000;
/** 输入行上方的提示（“已发给 fix-login”、失败原因等）显示这么久。 */
export const NOTICE_MS = 3000;
/** 中断命令：上一次发信号之后要等这么久，再按 Ctrl+C 才升级到下一个信号。 */
export const INTERRUPT_ESCALATE_MS = 3000;
/** 单独的 Esc 要等这么久没有后续字节，才当作 Esc 键（否则是 Alt 组合键或转义序列的开头）。 */
export const ESC_TIMEOUT_MS = 30;

// ───── 画面 ─────

/** 两帧之间至少隔这么久（每秒最多约 30 帧）。 */
export const FRAME_MIN_INTERVAL_MS = 33;
/** “在跑”的转动符号每隔这么久换一帧（每秒 8 帧）。 */
export const SPINNER_FRAME_MS = 125;
export const SPINNER_FRAMES: readonly string[] = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
/** pane 窄于这么多列时，名单去掉模型列。 */
export const HIDE_MODEL_BELOW_COLS = 60;
/** pane 窄于这么多列时，名单再去掉 token 列。 */
export const HIDE_TOKENS_BELOW_COLS = 48;
/** pane 矮于这么多行时，名单收成一行（按 z 也一样）。 */
export const COLLAPSE_LIST_BELOW_ROWS = 20;
/** 子 agent 的输入框最多长到这么多行。 */
export const INPUT_MAX_ROWS = 6;
/** 任务说明默认只显示前这么多行，按 e 展开。 */
export const TASK_PREVIEW_ROWS = 2;
/** 命令的终端模拟器保留这么多行回滚。 */
export const TERM_SCROLLBACK_LINES = 5000;
