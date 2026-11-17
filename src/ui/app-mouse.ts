// 鼠标：点名单的一行选中它，点内容区把焦点移过去，滚轮翻看（指针在名单上时移动选择）。
// 命中测试用视图的 computeLayout，和画面上的行对得上。

import type { AppContext, AppState, AppUpdate } from "../types/app.ts";
import type { MouseEvent } from "../types/ui.ts";
import { scrollView } from "./app-content.ts";
import { moveSelection, noop, selectEntry, selectedEntry } from "./app-core.ts";
import { helpWindow } from "./views/help.ts";
import { computeLayout } from "./views/layout.ts";

/** 滚轮每格翻几行内容。 */
export const WHEEL_LINES = 3;

export function handleMouse(state: AppState, e: MouseEvent, ctx: AppContext): AppUpdate {
  const wheel = e.action === "wheelup" ? -1 : e.action === "wheeldown" ? 1 : 0;

  if (state.overlay !== "none") {
    if (wheel === 0) return noop(state);
    if (state.overlay === "help") {
      const area = Math.max(0, ctx.size.rows - 2);
      const shown = helpWindow(ctx.data.extension.kind === "readonly", ctx.size.cols, area, state.helpScroll ?? 0);
      const to = Math.max(0, Math.min(shown.maxScroll, shown.scroll + wheel * WHEEL_LINES));
      return noop(to === (state.helpScroll ?? 0) ? state : { ...state, helpScroll: to });
    }
    const index = Math.max(0, Math.min(ctx.data.sessions.length, state.pickerIndex + wheel));
    return noop(index === state.pickerIndex ? state : { ...state, pickerIndex: index });
  }

  const layout = computeLayout(state, ctx.data, ctx.size);
  const inList = e.row >= layout.listTop && e.row < layout.listTop + layout.listRows;
  const entry = selectedEntry(state, ctx);

  if (wheel !== 0) {
    if (inList) return noop(moveSelection(state, ctx, { by: wheel }));
    return entry === null ? noop(state) : noop(scrollView(state, ctx, entry, { by: -wheel * WHEEL_LINES }));
  }

  if (e.action !== "down" || e.button !== "left") return noop(state);

  if (inList) {
    const clicked = layout.listCollapsed ? entry : (ctx.data.entries[layout.listOffset + (e.row - layout.listTop)] ?? null);
    if (clicked === null) return noop(state);
    const picked = selectEntry(state, clicked.key);
    if (picked === state && state.focus === "list") return noop(state);
    return noop({ ...picked, focus: "list", followLatest: picked === state ? state.followLatest : false });
  }

  // 内容区从标题行（半框的上边）起，到输入行为止；名单下面的“还有几个”“收起了几个”那几行不算
  const contentFrom = layout.titleRow >= 0 ? layout.titleRow : layout.contentTop;
  const inContent = e.row >= contentFrom && e.row < layout.inputTop + layout.inputRows;
  if (inContent && entry !== null && state.focus !== "content") return noop({ ...state, focus: "content" });
  return noop(state);
}
