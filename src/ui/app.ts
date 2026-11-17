// 界面状态机：按键、鼠标、数据变化进，新状态和要执行的动作出。纯函数，不碰终端、文件、socket，时刻都从上下文里来。
// 全部按键见 src/ui/views/help.ts（帮助画面）；具体实现拆在 app-*.ts：
// app-core（初始状态、选中、请求）、app-data（数据变化）、app-keys（按键）、app-mouse（鼠标）、
// app-content（翻看和搜索）、app-requests（请求和中断的结果）。
//
// 放大：state.zoom 只记用户按 z 的偏好；pane 矮于 COLLAPSE_LIST_BELOW_ROWS 行时自动收起名单由视图的 computeLayout 判断
// （listCollapsed = 矮于这个行数或 zoom），状态机不改 zoom。

import type { AppContext, AppInput, AppState, AppUpdate } from "../types/app.ts";
import { applyData, syncSession } from "./app-data.ts";
import { handleKey, handlePaste } from "./app-keys.ts";
import { handleMouse } from "./app-mouse.ts";
import { handleInterrupted, handleResult } from "./app-requests.ts";
import { initialState, noop, withNotice } from "./app-core.ts";

export { initialState };

/** 时钟走了：清掉过期的提示、x 的确认、Ctrl+C 退出的确认。没有过期的就原样返回。 */
function expire(state: AppState, now: number): AppState {
  const notice = state.notice !== null && state.notice.until <= now ? null : state.notice;
  const confirmStop = state.confirmStop !== null && state.confirmStop.until <= now ? null : state.confirmStop;
  const quitArmedUntil = state.quitArmedUntil !== null && state.quitArmedUntil <= now ? null : state.quitArmedUntil;
  if (notice === state.notice && confirmStop === state.confirmStop && quitArmedUntil === state.quitArmedUntil) return state;
  return { ...state, notice, confirmStop, quitArmedUntil };
}

function dispatch(state: AppState, input: AppInput, ctx: AppContext): AppUpdate {
  switch (input.type) {
    case "tick":
      return noop(expire(state, ctx.now));
    case "data":
      return applyData(state, ctx, false);
    case "result":
      return handleResult(state, input.requestId, input.outcome, ctx);
    case "interrupted":
      return handleInterrupted(state, input.entryKey, input.outcome, ctx);
    case "notify":
      return noop(withNotice(state, ctx, input.text, input.tone, input.durationMs));
    case "input": {
      const event = input.event;
      if (event.type === "key") return handleKey(state, event, ctx);
      if (event.type === "paste") return handlePaste(state, event, ctx);
      return handleMouse(state, event, ctx);
    }
  }
}

/**
 * 处理一个输入，返回新状态和要执行的动作。每次先看 session 变了没有：变了就清掉和旧 session 有关的状态，
 * 并把当前名单当作“已经在那里”（不标未读、不响铃），再处理这个输入。
 */
export function update(state: AppState, input: AppInput, context: AppContext): AppUpdate {
  const synced = syncSession(state, context);
  if (!synced.adopted) return dispatch(synced.state, input, context);
  const seeded = applyData(synced.state, context, true);
  const result = dispatch(seeded.state, input, context);
  return { state: result.state, effects: [...seeded.effects, ...result.effects] };
}
