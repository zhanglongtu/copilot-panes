// 选显示哪个 session：纯函数，只看传进来的数据，不碰文件系统，方便测试。
// 前台线索（日志、pane 标题）和用户发言时间都由调用方读好传进来，见 foreground.ts、user-messages.ts。

import type { ChooseInput, ChooseReason, ChooseResult, ForegroundHint, SelfLocation, SessionCandidate } from "../types/session.ts";

/** 标题比较前的整理：空白折成一个空格、去首尾空白。 */
export function normalizeTitle(title: string | null): string {
  return (title ?? "").replace(/\s+/g, " ").trim();
}

/**
 * 候选范围：在 tmux 里时，是 tmuxPane 在 windowPanes 里、或 copilotPid 在 windowCopilotPids 里的候选（by "tmux"）；
 * 范围为空或不在 tmux 里时，是 cwd 和 self.cwd 相同的候选（by "cwd"）。顺序不保证。
 */
export function candidateScope(candidates: readonly SessionCandidate[], self: SelfLocation): { scope: SessionCandidate[]; by: "tmux" | "cwd" } {
  if (self.tmux) {
    const { windowPanes, windowCopilotPids } = self.tmux;
    const scope = candidates.filter(
      (c) => (c.tmuxPane !== null && windowPanes.includes(c.tmuxPane)) || (c.copilotPid !== null && windowCopilotPids.includes(c.copilotPid)),
    );
    if (scope.length > 0) return { scope, by: "tmux" };
  }
  return { scope: candidates.filter((c) => c.cwd !== null && c.cwd === self.cwd), by: "cwd" };
}

/**
 * 前台线索指到的候选，每个 Copilot CLI 进程最多一个：日志线索（给的是 session ID，精确）优先，指到的 session 不在范围里就看 pane 标题；
 * 标题线索要范围里（同一个进程的）恰好一个候选的名字和它相同才算，重名不算，免得猜错。
 */
function foregroundCandidates(scope: readonly SessionCandidate[], hints: readonly ForegroundHint[]): Map<SessionCandidate, ForegroundHint["kind"]> {
  const byProcess = new Map<string, { candidate: SessionCandidate; via: ForegroundHint["kind"] }>();
  for (const hint of hints) {
    if (hint.kind !== "log") continue;
    const found = scope.find((c) => c.sessionId === hint.sessionId);
    if (found) byProcess.set(String(hint.copilotPid), { candidate: found, via: "log" });
  }
  for (const hint of hints) {
    if (hint.kind !== "title") continue;
    const key = hint.copilotPid === null ? "?" : String(hint.copilotPid);
    const wanted = normalizeTitle(hint.title);
    if (byProcess.has(key) || wanted === "") continue;
    const matches = scope.filter((c) => (hint.copilotPid === null || c.copilotPid === hint.copilotPid) && normalizeTitle(c.title) === wanted);
    if (matches.length === 1) byProcess.set(key, { candidate: matches[0]!, via: "title" });
  }
  const result = new Map<SessionCandidate, ForegroundHint["kind"]>();
  for (const { candidate, via } of byProcess.values()) if (!result.has(candidate)) result.set(candidate, via);
  return result;
}

/**
 * 选择规则（docs/architecture.md “找 session”一节）：
 * 1. explicitId 不为 null：选它（不管在不在候选里），reason "explicit"，scope 是 [explicitId]。
 * 2. 先定候选范围（candidateScope），scope 按最新事件从新到旧排；当前 session 的最新事件取 max(候选的 lastEventAt, current.lastEventAt)。
 *    范围为空，结果是 none。
 * 3. current 是用户手选的（pinned）且还在候选里（任何范围）：留在它上面，reason "pinned"。手选的已经不在候选里，当作没有 current。
 * 4. 在范围里按依据从强到弱选一个：
 *    foreground：前台线索指到的（foregroundCandidates）；有几个（几个 Copilot CLI 进程）时取其中用户发言最新的。
 *    last-message：最近一次用户发言（lastUserMessageAt）最新的；
 *    last-event：最近有事件的。
 * 5. current 在范围里时：依据是 foreground 或 last-message，就换到选出的那个（它已经是 current 就不动），reason 是那个依据；
 *    依据只是 last-event（没有更强的线索），不自动换，留在 current 上，reason "stay"。current 不在范围里或没有 current：选出的那个。
 *
 * 补充：手选的 session 在范围之外时（范围可能是空的），scope 里也放上它，s 键的列表才看得到当前这一项。
 */
export function chooseSession(input: ChooseInput): ChooseResult {
  const { candidates, explicitId, self, current } = input;
  if (explicitId !== null) return { kind: "session", sessionId: explicitId, reason: "explicit", scopeBy: null, scope: [explicitId] };

  const latest = (c: SessionCandidate): number =>
    current && c.sessionId === current.sessionId ? Math.max(c.lastEventAt, current.lastEventAt) : c.lastEventAt;
  const userAt = (c: SessionCandidate): number => c.lastUserMessageAt ?? 0;
  const isCurrent = (c: SessionCandidate): boolean => current !== null && c.sessionId === current.sessionId;
  const newestFirst = (list: readonly SessionCandidate[]): SessionCandidate[] => [...list].sort((a, b) => latest(b) - latest(a));
  // 发言时间相同时，已经在看的那个排前面，免得来回跳
  const byUserMessage = (a: SessionCandidate, b: SessionCandidate): number =>
    userAt(b) - userAt(a) || Number(isCurrent(b)) - Number(isCurrent(a)) || latest(b) - latest(a);

  const { scope: unsorted, by } = candidateScope(candidates, self);
  const scope = newestFirst(unsorted);

  const currentCandidate = current ? candidates.find((c) => c.sessionId === current.sessionId) : undefined;
  if (current?.pinned && currentCandidate) {
    const withCurrent = scope.includes(currentCandidate) ? scope : newestFirst([...scope, currentCandidate]);
    return { kind: "session", sessionId: current.sessionId, reason: "pinned", scopeBy: by, scope: withCurrent.map((c) => c.sessionId) };
  }

  if (scope.length === 0) return { kind: "none" };
  const scopeIds = scope.map((c) => c.sessionId);

  let picked: SessionCandidate;
  let reason: ChooseReason;
  let via: ForegroundHint["kind"] | undefined;
  const foreground = foregroundCandidates(scope, input.foreground ?? []);
  const spoke = scope.filter((c) => userAt(c) > 0);
  if (foreground.size > 0) {
    picked = [...foreground.keys()].sort(byUserMessage)[0]!;
    via = foreground.get(picked);
    reason = "foreground";
  } else if (spoke.length > 0) {
    picked = [...spoke].sort(byUserMessage)[0]!;
    reason = "last-message";
  } else {
    picked = scope[0]!;
    reason = "last-event";
  }

  if (currentCandidate && scope.includes(currentCandidate) && reason === "last-event") {
    return { kind: "session", sessionId: currentCandidate.sessionId, reason: "stay", scopeBy: by, scope: scopeIds };
  }
  return { kind: "session", sessionId: picked.sessionId, reason, ...(via === undefined ? {} : { via }), scopeBy: by, scope: scopeIds };
}

/**
 * 自动换了 session 之后给用户看的一句提示：已切到「标题」：原因。
 * previousGone：原来的 session 已经不在范围里（结束了）；否则按 chooseSession 的依据写。
 */
export function switchNotice(title: string, reason: ChooseReason, previousGone: boolean): string {
  let cause: string;
  if (previousGone) cause = "原来那个 session 已经结束";
  else if (reason === "foreground") cause = "左边切到了这个 session";
  else if (reason === "last-message") cause = "你刚在这个 session 里发了消息";
  else cause = "这个 session 最近有动静";
  return `已切到「${title}」：${cause}`;
}
