'use strict';

/**
 * ocu 的 MCP 常驻客户端。
 * 相比每次 spawn `ocu js`，长连接能复用原生会话：元素索引 120 秒内有效、动作更快、无需拼 JS 字符串。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { resolveOcu } from './platform.mjs';

const PROTOCOL_VERSION = '2025-03-26';

export class OcuMcp {
  constructor(options = {}) {
    this.bin = options.bin || resolveOcu();
    if (!this.bin) throw new Error('找不到 ocu，可执行文件未安装或平台不支持');
    this.child = null;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = '';
    this.closed = false;
    this.tools = [];
  }

  async start() {
    if (this.child) return this;
    // 随包附带的 ocu 是带 shebang 的 node 脚本，打包后没有全局 node，
    // 用 Electron 自带的 node 运行时来执行它。
    let isNodeScript = false;
    try {
      const fd = fs.openSync(this.bin, 'r');
      const head = Buffer.alloc(2);
      fs.readSync(fd, head, 0, 2, 0);
      fs.closeSync(fd);
      isNodeScript = head.toString('utf8') === '#!';
    } catch {}
    const cmd = isNodeScript ? process.execPath : this.bin;
    const args = isNodeScript ? [this.bin, 'mcp'] : ['mcp'];
    const env = { ...process.env, OPEN_COMPUTER_USE_VISUAL_CURSOR: '0' };
    if (isNodeScript) env.ELECTRON_RUN_AS_NODE = '1';
    this.child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], env });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => this._onData(chunk));
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk) => { if (process.env.DSH_MCP_DEBUG) process.stderr.write('[ocu-mcp] ' + chunk); });
    this.child.on('exit', (code) => {
      this.closed = true;
      for (const [, p] of this.pending) p.reject(new Error('ocu MCP 进程退出，code=' + code));
      this.pending.clear();
    });

    const init = await this._request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'dsh-desktop-agent', version: '0.6.0' },
    }, 15000);
    this.serverInfo = init && init.result ? init.result : null;
    this._notify('notifications/initialized', {});
    const listed = await this._request('tools/list', {}, 15000);
    this.tools = (listed && listed.result && listed.result.tools) || [];
    return this;
  }

  _onData(chunk) {
    this.buffer += chunk;
    let idx;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message || 'MCP 调用失败'));
        else p.resolve(msg);
      }
    }
  }

  _request(method, params, timeoutMs = 30000) {
    if (!this.child || this.closed) return Promise.reject(new Error('ocu MCP 未启动'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('MCP ' + method + ' 超时（' + timeoutMs + 'ms）'));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  _notify(method, params) {
    if (!this.child || this.closed) return;
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  /** 调用一个工具，返回解析后的 JSON（工具返回的是 MCP content 数组里的文本） */
  async callTool(name, args = {}, timeoutMs = 60000) {
    const msg = await this._request('tools/call', { name, arguments: args }, timeoutMs);
    const result = msg.result || {};
    const content = Array.isArray(result.content) ? result.content : [];
    const textPart = content.find((c) => c && typeof c.text === 'string');
    const text = textPart ? textPart.text : '';
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { parsed = null; }
    return { ok: !result.isError, text, json: parsed, raw: result };
  }

  async close() {
    if (!this.child) return;
    this.closed = true;
    try { this.child.stdin.end(); } catch {}
    try { this.child.kill(); } catch {}
    this.child = null;
  }
}

let shared = null;

/** 进程内共享一个常驻连接 */
export async function getOcuMcp(options) {
  if (shared && !shared.closed) return shared;
  shared = new OcuMcp(options);
  await shared.start();
  return shared;
}

export async function closeOcuMcp() {
  if (shared) { await shared.close(); shared = null; }
}
