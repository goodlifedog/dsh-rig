'use strict';

/**
 * 最小可用 CDP（Chrome DevTools Protocol）客户端：零依赖。
 *
 * 为什么不用现成的 ws 包：
 *   Node 20 没有全局 WebSocket（Node 22+ 才有），本仓库又不引入第三方依赖，
 *   所以这里用 node:http 做 HTTP 侧（/json、/json/version），
 *   用 node:crypto + node:net 自己实现 RFC 6455 的最小客户端帧协议：
 *   握手 + 客户端掩码 + 文本帧 + 分片续帧 + ping/pong/close。
 *   只实现 CDP 用得到的部分：文本帧、无扩展、无压缩。
 *
 * 用法（库）：
 *   import { CDP, listTargets, getVersion } from './cdp.mjs';
 *   const cdp = await CDP.attach({ port: 9333, target: 'DSH Rig' });
 *   console.log(await cdp.getTitle());
 *   await cdp.clickSelector('#pill');
 *   cdp.close();
 *
 * 用法（命令行，便于取证）：
 *   node cdp.mjs version --port=9333
 *   node cdp.mjs targets --port=9333
 *   node cdp.mjs eval    --port=9333 --expr="document.title"
 *   node cdp.mjs inspect --port=9333 --target="DSH Rig"
 *   node cdp.mjs click   --port=9333 --selector="#pill"
 *   node cdp.mjs shot    --port=9333 --out=/tmp/overlay-cdp.png
 */

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { isDirectRun } from './direct-run.mjs';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const OPCODES = { CONT: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0x0a };

// ---------- HTTP 侧：/json、/json/version ----------

function httpGetJson(url, { timeout = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error('HTTP ' + res.statusCode + ' ' + url + '：' + body.slice(0, 200)));
          return;
        }
        try { resolve(JSON.parse(body)); }
        catch (error) { reject(new Error('返回不是 JSON：' + body.slice(0, 200))); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('请求超时：' + url)));
    req.on('error', reject);
  });
}

export function getVersion({ host = '127.0.0.1', port = 9333 } = {}) {
  return httpGetJson('http://' + host + ':' + port + '/json/version');
}

export function listTargets({ host = '127.0.0.1', port = 9333 } = {}) {
  return httpGetJson('http://' + host + ':' + port + '/json/list');
}

/** 按 id / title / url 选 target；字符串按子串匹配，正则按 test。 */
export function pickTarget(targets, matcher) {
  if (!matcher) {
    const page = targets.find((t) => t.type === 'page');
    if (!page) throw new Error('没有 type=page 的 target，实际：' + JSON.stringify(targets.map((t) => t.type)));
    return page;
  }
  const test = (value) => {
    if (value == null) return false;
    if (matcher instanceof RegExp) return matcher.test(value);
    return String(value).includes(String(matcher));
  };
  const hit = targets.find((t) => test(t.id) || test(t.title) || test(t.url));
  if (!hit) {
    throw new Error('没找到匹配的 target：' + String(matcher) + '；现有：' +
      targets.map((t) => JSON.stringify({ type: t.type, title: t.title, url: t.url })).join(', '));
  }
  return hit;
}

// ---------- WebSocket 最小实现（RFC 6455 客户端） ----------

function encodeClientFrame(opcode, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const len = body.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = 0x80 | len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 0x80 | 127;
    header.writeUInt32BE(Math.floor(len / 0x100000000), 2);
    header.writeUInt32BE(len >>> 0, 6);
  }
  header[0] = 0x80 | opcode; // FIN=1，无扩展位
  const mask = crypto.randomBytes(4);
  const masked = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i += 1) masked[i] = body[i] ^ mask[i & 3];
  return Buffer.concat([header, mask, masked]);
}

class MiniWebSocket extends EventEmitter {
  constructor() {
    super();
    this.socket = null;
    this.inbox = Buffer.alloc(0);
    this.fragments = [];
    this.state = 'connecting'; // connecting / open / closed
    this.closeCode = null;
    this.closeReason = '';
    this.maxPayload = 64 * 1024 * 1024;
  }

  static connect(url, { timeout = 5000, maxPayload = 64 * 1024 * 1024 } = {}) {
    const ws = new MiniWebSocket();
    ws.maxPayload = maxPayload;
    return ws.open(url, timeout).then(() => ws);
  }

  open(url, timeout) {
    return new Promise((resolve, reject) => {
      let parsed;
      try { parsed = new URL(url); }
      catch (error) { reject(new Error('WebSocket URL 不合法：' + url)); return; }
      if (parsed.protocol !== 'ws:') {
        reject(new Error('只支持 ws://（本地 CDP 不走 wss）：' + url));
        return;
      }

      const key = crypto.randomBytes(16).toString('base64');
      const req = http.request({
        host: parsed.hostname,
        port: parsed.port || 80,
        path: parsed.pathname + parsed.search,
        headers: {
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Key': key,
          'Sec-WebSocket-Version': '13',
        },
        timeout,
      });

      let settled = false;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        this.state = 'closed';
        reject(error);
      };

      req.on('upgrade', (res, socket, head) => {
        const accept = res.headers['sec-websocket-accept'];
        const expected = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
        if (res.statusCode !== 101 || accept !== expected) {
          socket.destroy();
          fail(new Error('WebSocket 握手失败：status=' + res.statusCode + ' accept=' + accept));
          return;
        }
        settled = true;
        this.socket = socket;
        this.state = 'open';
        socket.setNoDelay(true);
        socket.on('data', (chunk) => this.onData(chunk));
        socket.on('close', () => this.finalize(1006, 'socket closed'));
        socket.on('error', (error) => {
          this.emit('error', error);
          this.finalize(1006, String(error && error.message));
        });
        if (head && head.length) this.onData(head);
        this.emit('open');
        resolve();
      });

      req.on('response', (res) => {
        res.resume();
        fail(new Error('目标没有升级到 WebSocket：HTTP ' + res.statusCode));
      });
      req.on('timeout', () => {
        req.destroy();
        fail(new Error('WebSocket 连接超时：' + url));
      });
      req.on('error', fail);
      req.end();
    });
  }

  onData(chunk) {
    this.inbox = this.inbox.length ? Buffer.concat([this.inbox, chunk]) : chunk;
    for (;;) {
      const frame = this.readFrame();
      if (!frame) return;
      this.handleFrame(frame);
      if (this.state === 'closed') return;
    }
  }

  readFrame() {
    const buf = this.inbox;
    if (buf.length < 2) return null;

    const fin = (buf[0] & 0x80) !== 0;
    const rsv = buf[0] & 0x70;
    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let len = buf[1] & 0x7f;
    let offset = 2;

    if (rsv !== 0) throw new Error('收到带扩展位的帧，本实现未协商扩展');
    if (len === 126) {
      if (buf.length < 4) return null;
      len = buf.readUInt16BE(2);
      offset = 4;
    } else if (len === 127) {
      if (buf.length < 10) return null;
      const high = buf.readUInt32BE(2);
      const low = buf.readUInt32BE(6);
      len = high * 0x100000000 + low;
      offset = 10;
    }
    if (len > this.maxPayload) throw new Error('帧过大：' + len);
    if (masked) offset += 4;
    if (buf.length < offset + len) return null;

    let payload = buf.subarray(offset, offset + len);
    if (masked) {
      const mask = buf.subarray(offset - 4, offset);
      const out = Buffer.allocUnsafe(len);
      for (let i = 0; i < len; i += 1) out[i] = payload[i] ^ mask[i & 3];
      payload = out;
    } else {
      payload = Buffer.from(payload);
    }
    this.inbox = buf.subarray(offset + len);
    return { fin, opcode, payload };
  }

  handleFrame(frame) {
    const fin = frame.fin;
    const opcode = frame.opcode;
    const payload = frame.payload;

    if (opcode === OPCODES.PING) {
      this.write(OPCODES.PONG, payload);
      return;
    }
    if (opcode === OPCODES.PONG) return;
    if (opcode === OPCODES.CLOSE) {
      const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
      const reason = payload.length > 2 ? payload.subarray(2).toString('utf8') : '';
      this.write(OPCODES.CLOSE, payload.subarray(0, 2));
      this.finalize(code, reason);
      return;
    }
    if (opcode === OPCODES.CONT) {
      this.fragments.push(payload);
    } else {
      this.fragments = [payload];
    }
    if (!fin) return;
    const message = Buffer.concat(this.fragments);
    this.fragments = [];
    if (opcode === OPCODES.TEXT || opcode === OPCODES.CONT) {
      this.emit('message', message.toString('utf8'));
    } else {
      this.emit('binary', message);
    }
  }

  write(opcode, payload) {
    if (this.state !== 'open' || !this.socket) return false;
    try {
      this.socket.write(encodeClientFrame(opcode, payload));
      return true;
    } catch (error) {
      this.emit('error', error);
      return false;
    }
  }

  send(text) {
    return this.write(OPCODES.TEXT, text);
  }

  finalize(code, reason) {
    if (this.state === 'closed') return;
    this.state = 'closed';
    this.closeCode = code;
    this.closeReason = reason || '';
    if (this.socket) {
      try { this.socket.end(); } catch (error) { /* 已断开 */ }
    }
    this.emit('close', { code: code, reason: this.closeReason });
  }

  close() {
    if (this.state === 'open') {
      const payload = Buffer.alloc(2);
      payload.writeUInt16BE(1000, 0);
      this.write(OPCODES.CLOSE, payload);
    }
    this.finalize(1000, 'client close');
  }
}

// ---------- CDP 会话 ----------

/**
 * 一个 CDP 会话：连上某个 target 的 webSocketDebuggerUrl，
 * 把请求 id 和响应配对，其余消息作为事件派发。
 */
export class CDP extends EventEmitter {
  constructor(ws, target) {
    super();
    this.ws = ws;
    this.target = target;
    this.nextId = 0;
    this.pending = new Map();
    this.closed = false;
    this.protocolMessages = 0;

    ws.on('message', (text) => this.onMessage(text));
    ws.on('close', (info) => {
      this.closed = true;
      for (const waiter of this.pending.values()) waiter.reject(new Error('CDP 连接已断开（code ' + info.code + '）'));
      this.pending.clear();
      this.emit('close', info);
    });
    ws.on('error', (error) => this.emit('error', error));
  }

  /** 连上 target（默认第一个 page）。matcher 见 pickTarget。 */
  static async attach({ host = '127.0.0.1', port = 9333, target = null, timeout = 5000 } = {}) {
    const targets = await listTargets({ host, port });
    const picked = pickTarget(targets, target);
    const ws = await MiniWebSocket.connect(picked.webSocketDebuggerUrl, { timeout });
    return new CDP(ws, picked);
  }

  /** 连到 browser 级 target（Target.getTargets 等；不绑定具体页面）。 */
  static async attachBrowser({ host = '127.0.0.1', port = 9333, timeout = 5000 } = {}) {
    const version = await getVersion({ host, port });
    const ws = await MiniWebSocket.connect(version.webSocketDebuggerUrl, { timeout });
    return new CDP(ws, { type: 'browser', title: version.Browser, url: version.webSocketDebuggerUrl });
  }

  onMessage(text) {
    let message;
    try { message = JSON.parse(text); }
    catch (error) {
      this.emit('protocol-error', new Error('收到非 JSON 的 CDP 消息：' + text.slice(0, 200)));
      return;
    }
    this.protocolMessages += 1;

    if (message.id != null) {
      const waiter = this.pending.get(message.id);
      if (!waiter) {
        this.emit('protocol-error', new Error('收到未知 id 的响应：' + message.id));
        return;
      }
      this.pending.delete(message.id);
      clearTimeout(waiter.timer);
      if (message.error) {
        const error = new Error('CDP ' + waiter.method + ' 失败：' + (message.error.message || '') +
          (message.error.data ? '（' + message.error.data + '）' : ''));
        error.code = message.error.code;
        error.data = message.error.data;
        error.method = waiter.method;
        waiter.reject(error);
      } else {
        waiter.resolve(message.result);
      }
      return;
    }

    if (message.method) {
      this.emit('event', message);
      this.emit(message.method, message.params);
    }
  }

  /** 发一条 CDP 命令，等它的 result。 */
  send(method, params = {}, { timeout = 10000 } = {}) {
    if (this.closed) return Promise.reject(new Error('CDP 连接已关闭，无法发送 ' + method));
    const id = ++this.nextId;
    const payload = JSON.stringify({ id: id, method: method, params: params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('CDP ' + method + ' 超时（' + timeout + 'ms）'));
      }, timeout);
      this.pending.set(id, { resolve: resolve, reject: reject, method: method, timer: timer });
      if (!this.ws.send(payload)) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error('发送失败，WebSocket 未就绪'));
      }
    });
  }

  /**
   * Runtime.evaluate：执行 JS 并返回结果值。
   * 默认 awaitPromise + returnByValue；页面里的异常会作为错误抛出。
   */
  async evaluate(expression, options) {
    const opts = options || {};
    const result = await this.send('Runtime.evaluate', {
      expression: expression,
      awaitPromise: opts.awaitPromise !== false,
      returnByValue: opts.returnByValue !== false,
      includeCommandLineAPI: true,
    }, { timeout: opts.timeout || 10000 });

    if (result.exceptionDetails) {
      const detail = result.exceptionDetails;
      const text = (detail.exception && (detail.exception.description || detail.exception.value)) || detail.text || '未知异常';
      const error = new Error('页面执行异常：' + String(text).split('\n')[0]);
      error.exceptionDetails = detail;
      throw error;
    }
    return opts.returnByValue === false ? result.result : result.result.value;
  }

  getTitle() {
    return this.evaluate('document.title');
  }

  getUrl() {
    return this.evaluate('location.href');
  }

  /** 取一个简明的 DOM 快照：节点数、可交互元素、标题、文本。 */
  inspectDom(maxText) {
    const limit = Number.isFinite(maxText) ? maxText : 400;
    const expr = [
      '(function () {',
      '  var sel = "a[href], button, input, select, textarea, [role=button], [role=link], [role=checkbox], [role=tab], [contenteditable=true]";',
      '  var interactive = Array.prototype.slice.call(document.querySelectorAll(sel));',
      '  function rect(el) { var r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; }',
      '  return {',
      '    title: document.title,',
      '    url: location.href,',
      '    readyState: document.readyState,',
      '    nodes: document.getElementsByTagName("*").length,',
      '    interactive: interactive.length,',
      '    interactiveSample: interactive.slice(0, 8).map(function (el) {',
      '      return { tag: el.tagName.toLowerCase(), id: el.id || null, cls: String(el.className || "").slice(0, 40) || null,',
      '        text: String(el.innerText || el.value || "").trim().slice(0, 40), rect: rect(el) };',
      '    }),',
      '    text: String(document.body ? document.body.innerText : "").replace(/\\s+/g, " ").trim().slice(0, ' + limit + ')',
      '  };',
      '})()',
    ].join('\n');
    return this.evaluate(expr);
  }

  /** 读某个选择器的状态（存在性、文本、class、可见性、位置）。 */
  inspectSelector(selector) {
    const expr = [
      '(function () {',
      '  var el = document.querySelector(' + JSON.stringify(selector) + ');',
      '  if (!el) return null;',
      '  var r = el.getBoundingClientRect();',
      '  var style = getComputedStyle(el);',
      '  return {',
      '    tag: el.tagName.toLowerCase(),',
      '    id: el.id || null,',
      '    cls: String(el.className || ""),',
      '    text: String(el.innerText || el.value || "").replace(/\\s+/g, " ").trim().slice(0, 120),',
      '    visible: r.width > 0 && r.height > 0 && style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) > 0,',
      '    rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }',
      '  };',
      '})()',
    ].join('\n');
    return this.evaluate(expr);
  }

  async waitFor(expression, options) {
    const opts = options || {};
    const timeout = opts.timeout || 5000;
    const interval = opts.interval || 100;
    const started = Date.now();
    for (;;) {
      if (await this.evaluate('Boolean(' + expression + ')')) return true;
      if (Date.now() - started > timeout) return false;
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
  }

  /**
   * 在坐标上触发一次"真实"鼠标点击：走 Input 域（浏览器的输入管线），
   * 生成的事件 isTrusted=true，效果等同用户点击，不是 el.click() 的合成事件。
   */
  async dispatchClick(x, y, options) {
    const opts = options || {};
    const button = opts.button || 'left';
    const clickCount = opts.clickCount || 1;
    const base = { x: Math.round(x), y: Math.round(y), button: button, clickCount: clickCount };
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: base.x, y: base.y, button: 'none', buttons: 0 });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: base.x, y: base.y, button: button, buttons: button === 'left' ? 1 : 2, clickCount: clickCount });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: base.x, y: base.y, button: button, buttons: 0, clickCount: clickCount });
    return { x: base.x, y: base.y, method: 'Input.dispatchMouseEvent' };
  }

  /** 滚动到元素可见，取中心点，用 Input 真点一次。 */
  async clickSelector(selector, options) {
    const opts = options || {};
    const scroll = opts.scrollIntoView !== false;
    const expr = [
      '(function () {',
      '  var el = document.querySelector(' + JSON.stringify(selector) + ');',
      '  if (!el) return null;',
      scroll ? '  el.scrollIntoView({ block: "center", inline: "center" });' : '',
      '  var r = el.getBoundingClientRect();',
      '  return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height, tag: el.tagName.toLowerCase() };',
      '})()',
    ].filter(Boolean).join('\n');

    const box = await this.evaluate(expr);
    if (!box) throw new Error('找不到元素：' + selector);
    if (!box.w || !box.h) throw new Error('元素没有可点击尺寸（' + box.w + 'x' + box.h + '）：' + selector);
    const point = await this.dispatchClick(box.x, box.y);
    return { selector: selector, tag: box.tag, size: { w: Math.round(box.w), h: Math.round(box.h) }, point: point };
  }

  /** 用 el.click() 合成事件点一次（不经过输入管线，适合非重点元素）。 */
  clickSelectorSynthetic(selector) {
    return this.evaluate([
      '(function () {',
      '  var el = document.querySelector(' + JSON.stringify(selector) + ');',
      '  if (!el) return { ok: false, reason: "not found" };',
      '  el.click();',
      '  return { ok: true, tag: el.tagName.toLowerCase() };',
      '})()',
    ].join('\n'));
  }

  /** 输入文本：Input.insertText 走真实输入管线（等价于输入法上屏）。 */
  insertText(text) {
    return this.send('Input.insertText', { text: String(text) });
  }

  /** 给输入框赋值（绕过键盘，直接改 value 并派发 input/change）。 */
  setValue(selector, value) {
    return this.evaluate([
      '(function () {',
      '  var el = document.querySelector(' + JSON.stringify(selector) + ');',
      '  if (!el) return { ok: false, reason: "not found" };',
      '  el.focus();',
      '  el.value = ' + JSON.stringify(String(value)) + ';',
      '  el.dispatchEvent(new Event("input", { bubbles: true }));',
      '  el.dispatchEvent(new Event("change", { bubbles: true }));',
      '  return { ok: true, value: el.value };',
      '})()',
    ].join('\n'));
  }

  /** 页面截图，返回 PNG Buffer；传 outPath 时顺便落盘。 */
  async screenshot(outPath) {
    const shot = await this.send('Page.captureScreenshot', { format: 'png' }, { timeout: 15000 });
    const buffer = Buffer.from(shot.data, 'base64');
    if (outPath) fs.writeFileSync(outPath, buffer);
    return buffer;
  }

  /** 浏览器层：列出所有 target（含 iframe/worker）。 */
  async getTargets() {
    const result = await this.send('Target.getTargets');
    return result.targetInfos;
  }

  close() {
    this.closed = true;
    this.ws.close();
  }
}

// ---------- 命令行 ----------

function parseArgs(argv) {
  const args = { _: [] };
  for (const raw of argv.slice(2)) {
    if (raw.startsWith('--')) {
      const eq = raw.indexOf('=');
      if (eq === -1) args[raw.slice(2)] = true;
      else args[raw.slice(2, eq)] = raw.slice(eq + 1);
    } else {
      args._.push(raw);
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const command = args._[0] || 'targets';
  const host = args.host || '127.0.0.1';
  const port = Number(args.port || process.env.CDP_PORT || 9333);
  const target = args.target || args.title || null;

  if (command === 'version') {
    console.log(JSON.stringify(await getVersion({ host: host, port: port }), null, 2));
    return;
  }
  if (command === 'targets') {
    console.log(JSON.stringify(await listTargets({ host: host, port: port }), null, 2));
    return;
  }

  const cdp = await CDP.attach({ host: host, port: port, target: target });
  try {
    if (command === 'eval') {
      if (!args.expr) throw new Error('需要 --expr="JS 表达式"');
      console.log(JSON.stringify(await cdp.evaluate(args.expr), null, 2));
    } else if (command === 'inspect') {
      console.log(JSON.stringify(await cdp.inspectDom(), null, 2));
    } else if (command === 'click') {
      if (!args.selector) throw new Error('需要 --selector="#id"');
      console.log(JSON.stringify(await cdp.clickSelector(args.selector), null, 2));
    } else if (command === 'shot') {
      const out = args.out || '/tmp/cdp-shot.png';
      const buffer = await cdp.screenshot(out);
      console.log(JSON.stringify({ ok: true, out: out, bytes: buffer.length }, null, 2));
    } else if (command === 'title') {
      console.log(await cdp.getTitle());
    } else {
      throw new Error('未知命令：' + command + '（可用 version / targets / eval / inspect / click / shot / title）');
    }
  } finally {
    cdp.close();
  }
}

// 入口守卫统一走 core/direct-run.mjs（realpath 归一，符号链接路径也判 true）。
// 原来这里有个本地 isDirectRun()，用 pathToFileURL(argv[1]) 字符串比较：
// 经符号链接执行时 argv[1] 带 symlink 路径、import.meta.url 是 realpath → 判 false，命令行静默不跑。
if (isDirectRun(import.meta.url)) {
  main().catch((error) => {
    console.error('[cdp] ' + (error && error.message ? error.message : error));
    process.exit(1);
  });
}
