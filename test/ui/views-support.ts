// 名单、顶行、按键提示行、覆盖层的测试共用的造数据函数。这个文件不是测试文件（名字不以 .test.ts 结尾）。

import type { ListEntry } from "../../src/types/model.ts";

export function entry(over: Partial<ListEntry> = {}): ListEntry {
  return {
    key: "agent:a1",
    kind: "agent",
    id: "a1",
    depth: 0,
    parentKey: null,
    status: "running",
    name: "fix-login",
    model: "medium-1.0",
    startedAt: 0,
    elapsedMs: 134_000,
    tokens: 183_000,
    step: "等 run-tests 交回结果",
    exitCode: null,
    task: null,
    ...over,
  };
}

export function command(over: Partial<ListEntry> = {}): ListEntry {
  return entry({ key: "cmd:c1", kind: "command", id: "c1", name: "npm run build", model: null, tokens: null, step: "12/40 30%", ...over });
}
