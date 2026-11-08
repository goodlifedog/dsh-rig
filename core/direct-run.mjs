'use strict';
/**
 * 入口守卫：判断「这个模块是被直接执行」还是「被 import / node --test 加载」。
 *
 * 为什么不自己写 `path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)`：
 * import.meta.url 里是 Node 解析后的 realpath，而 argv[1] 原样保留调用方给的路径。
 * 仓库或任务目录经由符号链接访问时（/var → /private/var、~/Desktop 指向外置盘、
 * daemon 用含 symlink 的路径 spawn），两个字符串不相等 → 守卫判 false →
 * main() 不执行、进程照样退出 0：任务静默空跑，验收还会当成功（L1 复核抓到的假绿）。
 *
 * 三种场景（行为必须不变）：
 *   - runner / daemon 用绝对路径 spawn 任务文件：两边指向同一文件 → true，照常执行 main
 *   - `node --test` 或被别的模块 import：argv[1] 是测试框架/宿主脚本 → false，不能有副作用
 *   - 通过符号链接路径执行（argv[1] 是 symlink、import.meta.url 是 realpath）→ realpath 归一后 true
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 把路径归一成 realpath；路径不存在/没权限时退回 path.resolve（纯字符串归一，永不抛）。
 * @param {string} target
 * @returns {string}
 */
function normalizePath(target) {
  const abs = path.resolve(String(target));
  try {
    return fs.realpathSync(abs);
  } catch {
    return abs;
  }
}

/**
 * 本模块是否被直接执行（纯函数：只读 argv 与文件系统，不启动任何东西）。
 * @param {string} moduleUrl 调用方传 `import.meta.url`
 * @param {string} [argv1] 默认 process.argv[1]（测试可注入）
 * @returns {boolean} 只有两边归一后是同一个文件才 true；argv1 缺失或非 file URL 一律 false
 */
export function isDirectRun(moduleUrl, argv1 = process.argv[1]) {
  if (!moduleUrl || !argv1) return false;
  let self;
  try {
    self = fileURLToPath(String(moduleUrl));
  } catch {
    return false;
  }
  return normalizePath(self) === normalizePath(String(argv1));
}

export default { isDirectRun };
