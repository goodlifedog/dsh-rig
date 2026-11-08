'use strict';
/**
 * 备忘录写入前的判定（纯函数）。
 *
 * 背景：验证任务会先点「新建备忘录」，再往第一个 AXTextArea 写测试内容。
 * set_value / typeText 都是覆盖语义——如果新建没成功，第一个文本区很可能就是
 * 用户正在编辑的笔记，写进去就把用户内容盖掉了。所以写入前必须确认：
 *   1) 新建备忘录成功（点击命中且没抢前台）
 *   2) 确实有可写文本区（冷启动可能停在"无备忘录"状态）
 *
 * 任何一条不满足都跳过写入，宁可少验证一步，也不能碰用户内容。
 *
 * @param {{newNoteOk?:boolean, frontUnchanged?:boolean, hasArea?:boolean}} input
 * @returns {{ok:boolean, reason:string}}
 */
export function decideNoteWrite(input = {}) {
  const { newNoteOk = false, frontUnchanged = true, hasArea = true } = input || {};
  if (!newNoteOk) return { ok: false, reason: '新建备忘录没成功，跳过写入以免覆盖用户正在编辑的笔记' };
  if (frontUnchanged === false) return { ok: false, reason: '新建备忘录时前台被抢，跳过写入以免写错窗口' };
  if (!hasArea) return { ok: false, reason: '备忘录没有可写文本区（首次使用或没有笔记库）' };
  return { ok: true, reason: '' };
}
