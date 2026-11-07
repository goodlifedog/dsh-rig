/**
 * 应用能力缓存：记住「哪个应用吃哪种输入方式」，下次直接用对的那条路。
 *
 * 为什么要这层：不同应用接受的输入方式不同（计算器吃键盘、备忘录吃 AX 设值、
 * 文本编辑忽略后台键入）。每次盲目试错既慢又可能触发副作用，所以把探测结果存下来，
 * 按「最近一次成功的方式优先」排序。
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * 从缓存里取某个应用某种意图的方法顺序。
 * @returns {string[]|null} 没记录过返回 null（调用方用默认顺序）
 */
export function methodOrder(cache, app, intent) {
  const entry = cache && cache[app];
  if (!entry) return null;
  const list = entry[intent];
  return Array.isArray(list) && list.length ? list.slice() : null;
}

/**
 * 记录一次尝试结果：成功的方式提到最前，失败的挪到最后。
 * 纯函数，返回新的 cache 对象。
 */
export function recordMethod(cache, app, intent, method, ok) {
  const next = JSON.parse(JSON.stringify(cache || {}));
  if (!next[app]) next[app] = {};
  if (!Array.isArray(next[app][intent]) || !next[app][intent].length) {
    next[app][intent] = intent === 'type' ? ['set_value', 'type_text'] : ['click'];
  }
  const list = next[app][intent].filter((m) => m !== method);
  if (ok) list.unshift(method);
  else list.push(method);
  next[app][intent] = Array.from(new Set(list));
  next[app].updatedAt = Date.now();
  return next;
}

/** 读缓存（文件不存在返回空对象） */
export function loadCache(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** 写缓存（自动建目录） */
export function saveCache(file, cache) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(cache, null, 2));
    return true;
  } catch {
    return false;
  }
}
