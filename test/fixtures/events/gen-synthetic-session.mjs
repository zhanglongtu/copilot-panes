// 生成 synthetic-session.jsonl：一份虚构的 session 事件日志，事件的结构和字段照真实的 events.jsonl。
// 所有 ID 由固定种子的随机数生成，时间、文字、命令和路径都是编的，所以每次运行得到完全相同的文件。
// 场景：在 webshop 项目里重构结算流程。15 个子 agent（最深三层嵌套）、同步和后台和 detach 的命令、
// 6 条会留在名单里的失败命令（名单只留最近 5 条）、两个被追加过消息的子 agent、一个失败和一个被取消的子 agent、用量记录。
// 用法：node gen-synthetic-session.mjs [输出路径]（默认写在本文件旁边的 synthetic-session.jsonl）。

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const START = Date.UTC(2026, 2, 2, 9, 0, 0);
const CWD = "/home/user/projects/webshop";
const MODEL = { large: "provider/large-1.0", medium: "provider/medium-1.0", small: "provider/small-1.0" };
const SELECTED_TOOLS = ["grep", "glob", "view", "bash", "read_bash", "stop_bash"];

export function generateSyntheticSession() {
  const rand = mulberry32(20260302);
  const hex = (n) => Array.from({ length: n }, () => "0123456789abcdef"[Math.floor(rand() * 16)]).join("");
  const uuid = () => `${hex(8)}-${hex(4)}-4${hex(3)}-${"89ab"[Math.floor(rand() * 4)]}${hex(3)}-${hex(12)}`;
  const BASE62 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const callId = () => `toolu_${Array.from({ length: 22 }, () => BASE62[Math.floor(rand() * 62)]).join("")}`;

  const SESSION_ID = uuid();
  const events = [];
  const add = (t, type, data, agentId = null) => events.push({ t: Math.round(t * 1000), seq: events.length, type, data, agentId });
  const shortModel = (model) => model.slice(model.lastIndexOf("/") + 1);

  const main = { id: null, model: MODEL.large, owner: null, taskCall: null, calls: 0, tokens: 0, children: [] };
  let shellCounter = 40;
  const nextShell = () => String(shellCounter++);

  const ctx = (a) => (a.taskCall ? { parentToolCallId: a.taskCall, ownerNativeSessionId: a.owner } : {});

  // ───── 子 agent 的生命周期 ─────

  function agent(name, kind, model, mode, parent, at, description, prompt) {
    return { id: uuid(), name, kind, model, mode, parent, at, description, prompt, taskCall: callId(), owner: uuid(), calls: 0, tokens: 0, children: [], text: "" };
  }

  function spawn(a) {
    const parent = a.parent;
    parent.calls++;
    parent.children.push(a);
    add(a.at, "tool.execution_start", {
      toolCallId: a.taskCall,
      toolName: "task",
      arguments: { name: a.name, description: a.description, agent_type: a.kind, model: a.model, reasoning_effort: "xhigh", mode: a.mode, prompt: a.prompt },
      turnId: "1",
      model: shortModel(parent.model),
      ...ctx(parent),
    }, parent.id);
    add(a.at + 0.03, "subagent.started", {
      toolCallId: a.taskCall,
      agentName: a.kind,
      agentDisplayName: a.name,
      agentDescription: a.description,
      model: a.model,
      taskModelSource: "task_argument",
      modelSelectionSource: "explicit_override",
      ...(parent.id ? { parentId: parent.id } : {}),
      resumable: false,
      agentType: a.kind,
      executionMode: a.mode,
    }, a.id);
    add(a.at + 0.07, "subagent.configured", { model: a.model, reasoningEffort: "xhigh", contextTier: "long_context", multiTurn: true }, a.id);
    add(a.at + 0.07, "subagent.selected", { agentName: a.kind, agentDisplayName: `${a.kind} agent`, tools: SELECTED_TOOLS }, a.id);
    if (a.mode === "background") {
      add(a.at + 0.08, "tool.execution_complete", {
        toolCallId: a.taskCall,
        model: shortModel(parent.model),
        turnId: "1",
        rte: false,
        success: true,
        result: { content: `Agent started in background with agent_id: ${a.id}. You'll be notified when it completes.` },
        ...ctx(parent),
      }, parent.id);
    }
    add(a.at + 0.1, "user.message", {
      content: a.prompt,
      hasSubmittedTask: true,
      source: `agent-${parent.id ?? SESSION_ID}`,
      messageId: uuid(),
      delivery: "idle",
      turnId: "0",
    }, a.id);
  }

  function totalTokens(a) {
    return a.tokens + a.children.reduce((sum, child) => sum + totalTokens(child), 0);
  }

  function finish(a, t, { failure, cancelled, reply } = {}) {
    const durationMs = Math.round((t - a.at) * 1000);
    const common = { toolCallId: a.taskCall, totalToolCalls: a.calls, totalTokens: totalTokens(a), durationMs };
    if (failure) {
      add(t, "subagent.failed", { ...common, error: failure }, a.id);
    } else {
      add(t, "subagent.completed", {
        toolCallId: a.taskCall,
        agentName: a.kind,
        agentDisplayName: a.name,
        ...(cancelled ? { cancelled: true } : {}),
        model: a.model,
        firstDispatchedModel: shortModel(a.model),
        explicitModelOverride: a.model,
        modelSelectionSource: "explicit_override",
        totalToolCalls: a.calls,
        totalTokens: common.totalTokens,
        durationMs,
      }, a.id);
    }
    if (a.mode === "sync") {
      add(t + 0.01, "tool.execution_complete", {
        toolCallId: a.taskCall,
        model: shortModel(a.parent.model),
        turnId: "1",
        rte: false,
        success: !failure,
        ...(failure ? { error: { message: `Agent failed: ${failure.replaceAll("\n", " ")}`, code: "failure" } } : { result: { content: reply ?? a.text } }),
        ...ctx(a.parent),
      }, a.parent.id);
    }
  }

  function idle(a, t) {
    add(t, "system.notification", {
      content: `<system_notification>\nAgent "${a.name}" (${a.kind}) has finished processing and is now idle.\n</system_notification>`,
      kind: { type: "agent_idle", agentId: a.id, agentType: a.kind, displayName: a.name, description: a.description },
    });
  }

  function say(a, t, content, reasoningText) {
    a.text = content;
    add(t, "assistant.message", {
      messageId: uuid(),
      model: shortModel(a.model),
      content,
      toolRequests: [],
      turnId: "0",
      ...(reasoningText ? { reasoningText } : {}),
      ...(a.taskCall ? { parentToolCallId: a.taskCall } : {}),
      rte: false,
    }, a.id);
  }

  function usage(a, t, inputTokens, outputTokens) {
    a.tokens += inputTokens + outputTokens;
    add(t, "session.usage_record", {
      usage: { model: shortModel(a.model), inputTokens, outputTokens, cacheReadTokens: Math.round(inputTokens * 0.6), cacheWriteTokens: Math.round(inputTokens * 0.1) },
    }, a.id);
  }

  function message(to, t, from, content) {
    add(t, "user.message", { content, hasSubmittedTask: true, source: `agent-${from.id ?? SESSION_ID}`, messageId: uuid(), delivery: "idle", turnId: "0" }, to.id);
  }

  // ───── 工具调用 ─────

  function call(a, t, seconds, toolName, args, { title, content, success = true, extra = {}, telemetry, shellExecution } = {}) {
    const id = callId();
    a.calls++;
    add(t, "tool.execution_start", {
      toolCallId: id,
      toolName,
      arguments: args,
      turnId: "1",
      model: shortModel(a.model),
      toolTitle: title ?? toolName,
      ...(a.taskCall ? ctx(a) : {}),
    }, a.id);
    add(t + seconds, "tool.execution_complete", {
      toolCallId: id,
      model: shortModel(a.model),
      turnId: "1",
      rte: false,
      ...(shellExecution ? { shellExecution } : {}),
      success,
      result: { content, ...extra },
      ...(telemetry ? { toolTelemetry: telemetry } : {}),
      ...(a.taskCall ? ctx(a) : {}),
    }, a.id);
    return id;
  }

  const view = (a, t, path, content, lines) => call(a, t, 0.4, "view", lines ? { path, view_range: lines } : { path }, { title: "Viewing file", content });
  const grep = (a, t, pattern, path, content, matches) =>
    call(a, t, 0.6, "grep", { pattern, path }, { title: "Searching files", content, telemetry: { properties: {}, metrics: { file_count: matches } } });
  const glob = (a, t, pattern, content) => call(a, t, 0.3, "glob", { pattern }, { title: "Finding files", content });
  const edit = (a, t, path, oldStr, newStr, added, removed) =>
    call(a, t, 0.5, "edit", { path, old_str: oldStr, new_str: newStr }, { title: "Editing file", content: `File ${path} updated with changes.`, telemetry: { properties: {}, metrics: { linesAdded: added, linesRemoved: removed } } });
  const create = (a, t, path, text) => call(a, t, 0.4, "create", { path, file_text: text }, { title: "Creating file", content: `Created file ${path} with ${text.length} characters` });

  const SHELL_TELEMETRY = (mode, detached = false) => ({
    properties: { customTimeout: "false", executionMode: mode, detached: String(detached), sandboxApplied: "false", sandboxOptOutRequested: "false" },
    metrics: {},
  });

  function syncShell(a, t, seconds, command, description, exitCode, output) {
    const shellId = nextShell();
    return call(a, t, seconds, "bash", { command, description, mode: "sync", initial_wait: 30 }, {
      title: "Running command",
      content: `${output}\n<shellId: ${shellId} completed with exit code ${exitCode}>`,
      extra: { structuredContent: { shellId } },
      telemetry: SHELL_TELEMETRY("sync"),
      shellExecution: { exitCode },
    });
  }

  function asyncShell(a, t, command, description, shellId, detach = false) {
    return call(a, t, 0.1, "bash", { command, description, mode: "async", ...(detach ? { detach: true } : {}), shellId }, {
      title: "Running command",
      content: `<command started in ${detach ? "detached " : ""}background with shellId: ${shellId}>`,
      extra: { structuredContent: { shellId } },
      telemetry: SHELL_TELEMETRY("async", detach),
    });
  }

  function readBash(a, t, seconds, shellId, text, exitCode) {
    const finished = exitCode !== undefined;
    return call(a, t, seconds, "read_bash", { shellId, delay: Math.round(seconds) }, {
      title: "Read shell output",
      content: finished
        ? `${text}\n<shellId: ${shellId} completed with exit code ${exitCode}>`
        : `${text}\n<command with shellId: ${shellId} is still running after ${Math.round(seconds)} seconds. The command is still running. Use read_bash to continue waiting for output, or stop_bash to stop it.>`,
      extra: { structuredContent: { shellId } },
      shellExecution: finished ? { exitCode } : undefined,
    });
  }

  function stopBash(a, t, shellId) {
    return call(a, t, 0.02, "stop_bash", { shellId }, {
      title: "Stop shell",
      content: `<command with id: ${shellId} stopped>`,
      extra: { structuredContent: { shellId } },
      telemetry: { properties: { shell_status: "stopped" }, metrics: {} },
    });
  }

  // ───── 主会话 ─────

  add(0, "session.start", {
    sessionId: SESSION_ID,
    version: 1,
    producer: "copilot-agent",
    copilotVersion: "1.0.112",
    startTime: new Date(START).toISOString(),
    selectedModel: MODEL.large,
    reasoningEffort: "medium",
    contextTier: "long_context",
    alreadyInUse: false,
    context: { cwd: CWD, gitRoot: CWD, branch: "main" },
  });
  add(1, "user.message", { content: "把 webshop 的结算流程拆成支付、税费、优惠券三个模块；先把购物车和商品目录里的问题查清楚。", messageId: uuid(), turnId: "0" });
  add(2, "assistant.turn_start", { turnId: "0", interactionId: uuid() });
  say(main, 3, "我先并行查几个方向，再安排重构。");
  syncShell(main, 3.5, 0.3, "git status --short", "Show working tree changes", 0, " M src/cart/cart.ts");

  const catalogScan = agent("catalog-scan", "explore", MODEL.small, "sync", main, 5, "扫描商品目录模块", "列出 src/catalog 下的文件，找出价格是在哪里算的，汇报文件名和函数名。");
  const cartAudit = agent("cart-audit", "explore", MODEL.small, "background", main, 8, "检查购物车的边界情况", "读 src/cart，找出数量合并、删除商品、清空购物车时可能算错总价的地方。");
  const checkoutLead = agent("checkout-lead", "general-purpose", MODEL.medium, "background", main, 12, "带头重构结算", "把结算拆成 payment、tax、coupon 三个模块。你来分派，每个模块各起一个子 agent，最后跑一遍类型检查。");
  const dbMigrate = agent("db-migrate", "general-purpose", MODEL.medium, "background", main, 15, "跑订单表迁移", "运行 npm run migrate，把 orders 表的新列加上；失败就把报错原文带回来。");
  const perfBench = agent("perf-bench", "task", MODEL.small, "background", main, 18, "压测结算接口", "用 bench/load.js 以 200 个并发用户压一遍结算接口，报告 p95。");
  const docsWriter = agent("docs-writer", "general-purpose", MODEL.medium, "background", main, 22, "写结算流程文档", "在 docs/checkout.md 里写一页结算流程的说明，包含时序图的文字版。");
  const e2eRunner = agent("e2e-runner", "general-purpose", MODEL.medium, "background", main, 30, "跑端到端测试", "启动 playwright 端到端测试，同时盯着服务端日志；测试结束后停掉日志。");
  const releaseNotes = agent("release-notes", "general-purpose", MODEL.small, "background", main, 35, "起草发布说明", "根据 CHANGELOG.md 的未发布部分起草一份发布说明。");
  const lintFixer = agent("lint-fixer", "task", MODEL.small, "sync", main, 60, "修 lint 报错", "运行 npm run lint，把报错逐个修掉，直到干净。");
  const a11yCheck = agent("a11y-check", "explore", MODEL.small, "sync", main, 72, "检查结算页无障碍", "看 src/ui/checkout 下的组件，找缺少 aria 标签的表单控件。");
  const reviewer = agent("review-1", "code-review", MODEL.medium, "sync", main, 110, "审查改动", "审查工作区里未提交的改动，只报告会导致错误的问题。");

  const paymentWorker = agent("payment-worker", "general-purpose", MODEL.medium, "sync", checkoutLead, 20, "重构支付模块", "把 src/payment/charge.ts 里的金额取整挪到单独的函数，保持对外接口不变。");
  const taxWorker = agent("tax-worker", "general-purpose", MODEL.medium, "background", checkoutLead, 24, "重构税费模块", "把税率查询从结算里抽出来，放进 src/tax。");
  const fxHelper = agent("fx-helper", "explore", MODEL.small, "sync", paymentWorker, 30, "查汇率换算的用法", "找出所有做币种换算的调用点，列出文件和行号。");
  const couponWorker = agent("coupon-worker", "task", MODEL.small, "sync", checkoutLead, 100, "重构优惠券模块", "把优惠券校验挪到 src/coupon，并补上过期时间的判断。");

  // 目录扫描
  spawn(catalogScan);
  say(catalogScan, 6, "先看目录结构。", "目录不大，先把文件列出来再读价格相关的部分");
  view(catalogScan, 7, `${CWD}/src/catalog/index.ts`, "export * from './pricing';\nexport * from './search';");
  grep(catalogScan, 9, "price\\(", `${CWD}/src`, "src/catalog/pricing.ts:12: export function price(item)", 3);
  usage(catalogScan, 10, 9200, 410);
  view(catalogScan, 12, `${CWD}/src/catalog/pricing.ts`, "export function price(item) { return item.cents / 100; }", [1, 40]);
  glob(catalogScan, 14, "src/catalog/**/*.ts", "src/catalog/index.ts\nsrc/catalog/pricing.ts\nsrc/catalog/search.ts");
  usage(catalogScan, 16, 11800, 380);
  say(catalogScan, 38, "目录模块共 3 个文件，价格在 pricing.ts 的 price() 里算。");
  finish(catalogScan, 40);

  // 购物车检查（后来被追加了一次消息）
  spawn(cartAudit);
  grep(cartAudit, 10, "quantity", `${CWD}/src/cart`, "src/cart/cart.ts:31: item.quantity += 1", 2);
  grep(cartAudit, 13, "remove", `${CWD}/src/cart`, "src/cart/cart.ts:58: items.splice(index, 1)", 1);
  view(cartAudit, 16, `${CWD}/src/cart/cart.ts`, "export class Cart { /* … */ }", [20, 80]);
  usage(cartAudit, 20, 14100, 520);
  say(cartAudit, 60, "发现两处：重复加购没有合并数量；删掉最后一件商品后总价没有清零。");
  finish(cartAudit, 62);
  idle(cartAudit, 63);
  call(main, 130, 0.05, "write_agent", { agent_id: cartAudit.id, message: "再查一下并发加购时有没有丢更新。" }, { content: `Message delivered to agent ${cartAudit.id}` });
  message(cartAudit, 131, main, "再查一下并发加购时有没有丢更新。");
  say(cartAudit, 135, "好，我看看 addItem 的写入顺序。");
  view(cartAudit, 138, `${CWD}/src/cart/store.ts`, "export function save(cart) { /* … */ }");
  usage(cartAudit, 140, 6400, 300);
  say(cartAudit, 165, "addItem 先读后写，没有加锁；并发时后写的会盖掉先写的。");
  finish(cartAudit, 167);
  idle(cartAudit, 168);

  // 结算牵头的三层嵌套
  spawn(checkoutLead);
  say(checkoutLead, 13, "我把任务分给三个人。", "支付最复杂，先让它开始；税费和优惠券可以并行");
  usage(checkoutLead, 14, 5200, 260);

  spawn(paymentWorker);
  view(paymentWorker, 22, `${CWD}/src/payment/charge.ts`, "export function charge(order) { return Math.round(order.total * 100) / 100; }");
  edit(paymentWorker, 26, `${CWD}/src/payment/charge.ts`, "Math.round(order.total * 100) / 100", "roundMoney(order.total)", 3, 1);
  spawn(fxHelper);
  grep(fxHelper, 31, "convert\\(", `${CWD}/src`, "src/payment/charge.ts:19: convert(amount, from, to)\nsrc/ui/checkout/summary.tsx:44: convert(total, 'USD', locale.currency)", 2);
  view(fxHelper, 34, `${CWD}/src/payment/fx.ts`, "export function convert(amount, from, to) { /* … */ }");
  view(fxHelper, 38, `${CWD}/src/ui/checkout/summary.tsx`, "export function Summary() { /* … */ }", [30, 60]);
  usage(fxHelper, 40, 7700, 290);
  say(fxHelper, 50, "共 2 处调用：charge.ts 第 19 行和 summary.tsx 第 44 行。");
  finish(fxHelper, 52);
  syncShell(paymentWorker, 56, 4.2, "npm test -- payment", "Run the payment tests", 1, "FAIL src/payment/charge.test.ts\n  ✕ rounds half up (4 ms)");
  edit(paymentWorker, 62, `${CWD}/src/payment/money.ts`, "Math.floor(value * 100)", "Math.round(value * 100)", 1, 1);
  syncShell(paymentWorker, 66, 3.0, "npm test -- payment", "Run the payment tests again", 0, "PASS src/payment/charge.test.ts");
  usage(paymentWorker, 69, 18400, 1250);
  say(paymentWorker, 92, "支付模块拆好了，取整的 bug 一并修了，测试通过。");
  finish(paymentWorker, 96);

  spawn(taxWorker);
  view(taxWorker, 26, `${CWD}/src/checkout/tax.ts`, "export function taxFor(order) { /* … */ }");
  grep(taxWorker, 30, "taxRate", `${CWD}/src`, "src/checkout/tax.ts:8: const taxRate = await fetchRate(order.region)", 1);
  usage(taxWorker, 33, 9900, 350);
  finish(taxWorker, 63, { failure: "上游税率接口超时\n重试 3 次后放弃" });

  spawn(couponWorker);
  view(couponWorker, 102, `${CWD}/src/checkout/coupon.ts`, "export function applyCoupon(order, code) { /* … */ }");
  edit(couponWorker, 108, `${CWD}/src/coupon/validate.ts`, "if (!coupon) return false", "if (!coupon || coupon.expiresAt < now) return false", 4, 1);
  usage(couponWorker, 112, 8800, 640);
  say(couponWorker, 122, "优惠券校验已经挪到 src/coupon，并且会拒绝过期的券。");
  finish(couponWorker, 124);

  syncShell(checkoutLead, 127, 2.6, "npm run typecheck", "Typecheck the project", 0, "tsc --noEmit: no errors");
  usage(checkoutLead, 130, 6100, 480);
  say(checkoutLead, 148, "三个模块都拆完了；税费那边因为接口超时没做成，需要你决定是否重试。");
  finish(checkoutLead, 150);

  // 数据库迁移：后台命令失败
  spawn(dbMigrate);
  view(dbMigrate, 17, `${CWD}/db/migrations/0007_orders.sql`, "ALTER TABLE orders ADD COLUMN coupon_id integer;");
  asyncShell(dbMigrate, 40, "npm run migrate", "Apply database migrations", "migrate");
  readBash(dbMigrate, 46, 5, "migrate", "applying 0006_users.sql");
  readBash(dbMigrate, 58, 12, "migrate", "applying 0007_orders.sql\nerror: column \"coupon_id\" already exists", 1);
  usage(dbMigrate, 59, 7300, 420);
  say(dbMigrate, 70, "迁移在 0007 失败：orders.coupon_id 已经存在，需要先确认这一列是不是手工加过。");
  finish(dbMigrate, 72);

  // 压测
  spawn(perfBench);
  syncShell(perfBench, 20, 6.1, "node bench/load.js --users 200", "Load test the checkout endpoint", 0, "requests: 12000\np95: 182ms");
  view(perfBench, 28, `${CWD}/bench/load.js`, "// k6-style load script");
  usage(perfBench, 30, 6500, 300);
  say(perfBench, 44, "200 并发下 p95 是 182 毫秒。");
  finish(perfBench, 46);

  // 文档：被取消
  spawn(docsWriter);
  view(docsWriter, 24, `${CWD}/docs/README.md`, "# docs");
  create(docsWriter, 30, `${CWD}/docs/checkout.md`, "# 结算流程\n");
  usage(docsWriter, 33, 5900, 700);
  finish(docsWriter, 45, { cancelled: true });

  // 端到端：停掉一个命令，另一个在子 agent 结束时被丢掉
  spawn(e2eRunner);
  asyncShell(e2eRunner, 38, "npx playwright test", "Run the end-to-end suite", "e2e");
  readBash(e2eRunner, 44, 5, "e2e", "Running 18 tests using 2 workers");
  asyncShell(e2eRunner, 50, "tail -f logs/server.log", "Follow the server log", "serverlog");
  readBash(e2eRunner, 70, 5, "serverlog", "listening on :3000");
  stopBash(e2eRunner, 84, "e2e");
  usage(e2eRunner, 86, 12300, 560);
  say(e2eRunner, 88, "端到端测试被我停掉了，日志还开着。");
  finish(e2eRunner, 90);

  // 发布说明：两次追加消息
  spawn(releaseNotes);
  view(releaseNotes, 37, `${CWD}/CHANGELOG.md`, "## Unreleased\n- fix: cart total after removing the last item");
  usage(releaseNotes, 40, 4800, 350);
  say(releaseNotes, 58, "草稿写好了，共 6 条。");
  finish(releaseNotes, 60);
  idle(releaseNotes, 61);
  call(main, 75, 0.05, "write_agent", { agent_id: releaseNotes.id, message: "把修复类的条目放在最前面。" }, { content: `Message delivered to agent ${releaseNotes.id}` });
  message(releaseNotes, 76, main, "把修复类的条目放在最前面。");
  say(releaseNotes, 80, "已调整顺序。");
  usage(releaseNotes, 82, 2100, 180);
  finish(releaseNotes, 95);
  idle(releaseNotes, 96);
  call(main, 120, 0.05, "write_agent", { agent_id: releaseNotes.id, message: "再加一段升级提示。" }, { content: `Message delivered to agent ${releaseNotes.id}` });
  message(releaseNotes, 121, main, "再加一段升级提示。");
  say(releaseNotes, 125, "升级提示补好了。");
  finish(releaseNotes, 140);
  idle(releaseNotes, 141);

  // lint：第一次失败，修完再跑
  spawn(lintFixer);
  syncShell(lintFixer, 62, 3.1, "npm run lint", "Run the linter", 1, "src/cart/cart.ts\n  31:5  error  'qty' is assigned a value but never used");
  edit(lintFixer, 68, `${CWD}/src/cart/cart.ts`, "const qty = 1;\n", "", 0, 1);
  syncShell(lintFixer, 70, 2.4, "npm run lint", "Run the linter again", 0, "no problems");
  usage(lintFixer, 72, 5200, 260);
  say(lintFixer, 88, "lint 已经干净。");
  finish(lintFixer, 92);

  spawn(a11yCheck);
  view(a11yCheck, 74, `${CWD}/src/ui/checkout/form.tsx`, "export function Form() { /* … */ }");
  grep(a11yCheck, 78, "<input", `${CWD}/src/ui/checkout`, "src/ui/checkout/form.tsx:21: <input name=\"zip\" />", 1);
  usage(a11yCheck, 80, 5600, 240);
  say(a11yCheck, 98, "邮编输入框缺少 aria-label。");
  finish(a11yCheck, 100);

  spawn(reviewer);
  grep(reviewer, 112, "TODO", `${CWD}/src`, "No matches found.", 0);
  view(reviewer, 115, `${CWD}/src/cart/cart.ts`, "export class Cart { /* … */ }");
  view(reviewer, 118, `${CWD}/src/payment/charge.ts`, "export function charge(order) { /* … */ }");
  view(reviewer, 121, `${CWD}/src/coupon/validate.ts`, "export function validate(coupon) { /* … */ }");
  usage(reviewer, 125, 21500, 900);
  say(reviewer, 138, "没有发现会导致错误的问题。");
  finish(reviewer, 141);

  // 主会话的其余命令
  syncShell(main, 150, 4.0, "npm test", "Run the whole test suite", 1, "FAIL src/cart/cart.test.ts\n  ✕ merges duplicate items (6 ms)");
  asyncShell(main, 160, "npm run dev", "Start the dev server", "dev");
  readBash(main, 165, 4, "dev", "ready on http://localhost:3000");
  asyncShell(main, 170, "python3 -m http.server 8000", "Serve the static preview", "preview", true);
  stopBash(main, 200, "dev");
  syncShell(main, 205, 3.5, "npm run build", "Build for production", 2, "error TS2322: Type 'string' is not assignable to type 'number'.");
  syncShell(main, 215, 6.0, "npm run e2e:smoke", "Run the smoke tests", 1, "1 failed: checkout › pays with a saved card");
  call(main, 225, 30, "bash", { command: "sleep 600", description: "Wait for the cache to warm up" }, {
    title: "Running command",
    content: "<command with shellId: 52 is still running after 30 seconds. The command is still running. Use read_bash to continue waiting for output, or stop_bash to stop it.>",
    extra: { structuredContent: { shellId: "52" } },
    telemetry: { properties: { customTimeout: "false", executionMode: "sync", detached: "false", shell_error_category: "command_timeout", is_timeout: "true" }, metrics: { commandTimeout: 30000 } },
  });
  add(260, "system.notification", {
    content: "<system_notification>\nShell command \"Serve the static preview\" (shellId: preview) has finished.\n</system_notification>",
    kind: { type: "shell_detached_completed", shellId: "preview", description: "Serve the static preview" },
  });
  say(main, 262, "支付和优惠券已经拆好；税费需要重试，数据库迁移要先确认 coupon_id。");
  add(263, "assistant.turn_end", { turnId: "0" });

  // ───── 排序并写出 ─────

  events.sort((a, b) => a.t - b.t || a.seq - b.seq);
  let parentId = null;
  const lines = events.map((event) => {
    const id = uuid();
    const record = { type: event.type, data: event.data, ...(event.agentId ? { agentId: event.agentId } : {}), id, timestamp: new Date(START + event.t).toISOString(), parentId };
    parentId = id;
    return JSON.stringify(record);
  });
  return `${lines.join("\n")}\n`;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const output = process.argv[2] ?? fileURLToPath(new URL("synthetic-session.jsonl", import.meta.url));
  writeFileSync(output, generateSyntheticSession());
  console.log(`wrote ${output}`);
}
