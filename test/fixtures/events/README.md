# 测试用事件样本

这里的文件都是编出来的，不含真实 session 的内容：字段位置照真实的 `events.jsonl`，ID、时间、命令、路径和文字都是虚构的。`test/model/fixtures.test.ts` 读它们。

## 场景样本（手工构造，每个只演示一种状态规则）

- `subagent-sync-completed.jsonl`：同步子 agent 完成：done，工具 2 次，38120 tokens，12.0 秒。
- `subagent-nested.jsonl`：writer 起 checker，都 done。上一级按发起 task 调用的 `agentId` 判断（不读 `data.parentId`）：checker 的是 writer，writer 的是主会话。
- `subagent-failed.jsonl`：`subagent.failed`：failed，5.0 秒；`error` 含换行，折成 `模型超时 重试失败`。
- `subagent-multi-turn.jsonl`：做完后又收到消息：done、running、done，共 30.0 秒；第一条 `agent_idle` 通知被忽略。
- `subagent-cancelled.jsonl`：两个子 agent 被取消：completed 带 `cancelled: true`；completed 后跟 `abort`。都是 stopped。
- `subagent-with-bash.jsonl`：子 agent builder 起后台 `sleep 60` 和同步 `ls -l`，主会话起 `echo main`；前两条属于 builder，后一条属于主会话；builder 完成时后台命令被丢弃。
- `bash-async-read-stop.jsonl`：后台命令 int-test 被 SIGINT，`read_bash` 返回退出码 130，failed，留在名单里，6 行输出；tail-log 被 `stop_bash` 停，stopped，无退出码，不算失败。
- `bash-detach.jsonl`：两条 `detach: true` 命令：gw 靠 `shell_detached_completed` 通知结束，无退出码；job 靠 `read_bash` 返回退出码 0 结束。
- `bash-sync-completed.jsonl`：同步 `make build` 3 秒，退出码 0，不留在名单里。
- `bash-sync-failed.jsonl`：`make test` 2.0 秒退出码 2，`grep x y` 1.9 秒退出码 1；都 failed，只有 `make test` 留在名单里（前台命令跑满 2 秒才算上过名单）。
- `bash-sync-promoted-to-background.jsonl`：同步命令 30 秒超时转后台（没有 `shellExecution`，`structuredContent.shellId` 为 7），再被 `stop_bash` 停；stopped。
- `tasks-json-merge.jsonl` 加 `tasks-sample.json`：4 个后台子 agent：alpha 在跑并有未结束的 `make test`，beta、gamma done，delta failed；合并任务列表后 beta 变 idle，顺序是 delta、alpha、`make test`、beta、gamma（按开始时间）。

## 虚构的完整 session

`synthetic-session.jsonl`（273 行）是生成出来的，场景是在 webshop 项目里重构结算流程：

- 15 个子 agent，最深三层嵌套（checkout-lead → payment-worker → fx-helper）。
- 同步、后台、detach 的命令；一个命令转入后台后一直在跑；子 agent 结束时被丢掉的后台命令。
- 6 条失败命令，名单只留最近 5 条。
- 两个被追加过消息的子 agent（共 3 次重新开始），一个失败、一个被取消的子 agent。
- `session.usage_record` 用量记录；上级的 `totalTokens` 含下级。

用 `node test/fixtures/events/gen-synthetic-session.mjs` 重新生成。随机数的种子固定，所以输出每次相同；改了生成脚本后要把新文件一起提交，并更新 `test/model/fixtures.test.ts` 里的期望（测试会核对提交的文件和生成结果一致）。
