'use strict';
/**
 * 端口与本地 URL 的单一来源。
 *
 * 之前 daemon 端口只有 daemon/cli/service 读 `AGENTD_PORT`，health / status / doctor /
 * restart-check 里写死 7789——用户按文档改了端口，诊断工具就会全部说「服务未启动」。
 * 这里统一读环境变量，谁要端口都从这儿拿。
 */

const DEFAULT_DAEMON_PORT = 7789;
const DEFAULT_OVERLAY_PORT = 7788;

function toPort(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : fallback;
}

export function daemonPort() {
  return toPort(process.env.AGENTD_PORT, DEFAULT_DAEMON_PORT);
}

export function overlayPort() {
  return toPort(process.env.OVERLAY_PORT, DEFAULT_OVERLAY_PORT);
}

export function daemonUrl(pathname = '/') {
  return 'http://127.0.0.1:' + daemonPort() + pathname;
}

export function overlayUrl(pathname = '/') {
  return 'http://127.0.0.1:' + overlayPort() + pathname;
}
