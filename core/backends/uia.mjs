'use strict';

/**
 * Windows 控制后端：包装 tools/uia-bridge.ps1。
 * 目标是与 macOS 的 ocu 提供同形接口，让任务层不必区分平台。
 *
 * 注意：本文件在 macOS 上无法实机验证，属于预留实现。
 */
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = path.join(__dirname, '..', '..', 'tools', 'uia-bridge.ps1');

export function isAvailable() {
  return process.platform === 'win32';
}

function run(args, timeout = 30000) {
  return new Promise((resolve, reject) => {
    if (!isAvailable()) return reject(new Error('UIA 后端只能在 Windows 上使用'));
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', BRIDGE, ...args],
      { timeout, maxBuffer: 32 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) return reject(new Error((stderr || err.message || '').trim() || 'UIA 调用失败'));
        resolve((stdout || '').trim());
      });
  });
}

function parseJson(text) {
  const line = text.split(/\r?\n/).filter((l) => l.trim().startsWith('{')).pop();
  if (!line) throw new Error('UIA 返回不是 JSON: ' + text.slice(0, 200));
  return JSON.parse(line);
}

/** 读界面树，返回 { process, pid, elements: [{index, role, name, value, x, y, w, h}] } */
export async function snapshot(processName) {
  return parseJson(await run(['snapshot', '-Process', processName]));
}

/** 按 snapshot 得到的索引点击 */
export async function click(index) {
  return parseJson(await run(['click', '-Index', String(index)]));
}

/** 向目标窗口后台输入文本 */
export async function typeText(text) {
  return parseJson(await run(['type', '-Text', text]));
}

/** 后台按键：ENTER / TAB / ESC / SPACE / BACKSPACE */
export async function pressKey(key) {
  return parseJson(await run(['key', '-Key', key]));
}

// ---------- 与 ocu 同形的适配层 ----------

export async function getApp(processName) {
  const tree = await snapshot(processName);
  return {
    process: processName,
    pid: tree.pid,
    async getAXState() {
      const t = await snapshot(processName);
      return t.elements
        .map((e) => e.index + ' ' + e.role.toLowerCase() + ' [' + e.name + '] frame x=' + e.x + ' y=' + e.y)
        .join('\n');
    },
    async click(index) { return click(index); },
    async typeText(text) { return typeText(text); },
    async pressKey(key) { return pressKey(key); },
  };
}

export default { isAvailable, snapshot, click, typeText, pressKey, getApp };
