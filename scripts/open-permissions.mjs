#!/usr/bin/env node
'use strict';
/**
 * 一键打开本工具需要的三个系统权限面板（只打开设置，不代点任何按钮）。
 *   npm run permissions:open
 * 权限本身无法脚本授予（macOS TCC 设计如此），这里只把面板送到你面前。
 */
import { execFile } from 'node:child_process';
import { isMac } from '../core/platform.mjs';

const PANES = [
  { name: '辅助功能', url: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility', why: '读/点 Accessibility 语义树（ocu 全靠它）' },
  { name: '屏幕录制', url: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture', why: '按窗口抓图、读窗口标题、小窗回显' },
  { name: '自动化', url: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Automation', why: 'AppleScript 控制别的应用（按发起方→目标成对授权）' },
];

if (!isMac) {
  console.log('这个命令只处理 macOS 权限；当前平台请参考 docs/USAGE.md 的权限章节。');
  process.exit(0);
}

console.log('需要的三项权限（授权给「启动本工具的应用」——终端，或小窗的 Electron）：');
for (const pane of PANES) console.log('  · ' + pane.name + '：' + pane.why);
console.log('');
console.log('现在依次打开对应设置面板，勾选后回到终端重跑 npm run doctor 复查。');

let i = 0;
const openNext = () => {
  if (i >= PANES.length) {
    console.log('三个面板已打开过；若某项仍缺失，重启对应应用（终端/小窗）后再查。');
    return;
  }
  const pane = PANES[i++];
  execFile('/usr/bin/open', [pane.url], { timeout: 8000 }, (error) => {
    if (error) console.log('  打开「' + pane.name + '」失败，请手动到 系统设置 → 隐私与安全性 里找：' + error.message);
    setTimeout(openNext, 600);
  });
};
openNext();
