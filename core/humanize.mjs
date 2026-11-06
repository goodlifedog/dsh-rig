'use strict';
/**
 * 拟人化操作：轨迹、节奏、输入方式。
 *
 * 目的不是「骗过某种检测」，而是避免机器式的固定像素和固定间隔——
 * 人不会每次都落在同一个像素，也不会每次都用手表一样准的间隔离手。
 *
 * 四个可独立测的层面：
 *   1. 落点  jitterPoint        目标点附近的手抖，半径有界
 *   2. 轨迹  buildTrajectory    贝塞尔曲线 + 变速 + 抖动，分步移动而不是瞬移
 *   3. 节奏  preActionPause / betweenActions / humanType  随机停顿区间
 *   4. 输入  humanType          按码点分段输入，偶发打错字再退格纠正
 *
 * 所有随机源都可注入（默认 Math.random），单测用 makeRng(seed) 复现同一条轨迹。
 * 轨迹本身只是「点 + 每步耗时」的数据，谁来执行（CDP 页面鼠标、小窗虚拟光标、
 * 系统窗口坐标点击）由调用方通过 emit / playTrajectory 决定。
 */

export const rand = (min, max, rng = Math.random) => min + rng() * (max - min);

export const sleep = (ms) => new Promise((r) => setTimeout(r, Math.round(ms)));

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** 可复现的伪随机数发生器（mulberry32）：同一个 seed 出同一条轨迹，方便单测 */
export function makeRng(seed = 1) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 在目标坐标附近随机抖动，模拟手抖。radius=0 时不抖，落点精确。 */
export function jitterPoint(x, y, radius = 3, rng = Math.random) {
  if (!radius) return { x: Math.round(x), y: Math.round(y) };
  return {
    x: Math.round(x + rand(-radius, radius, rng)),
    y: Math.round(y + rand(-radius, radius, rng)),
  };
}

/** 三次贝塞尔取点 */
function bezier(p0, p1, p2, p3, t) {
  const u = 1 - t;
  return {
    x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
    y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
  };
}

/** 缓入缓出：起步慢、中段快、临近目标减速 */
function easeInOut(t) {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

/**
 * 生成一条从 from 到 to 的移动轨迹。
 *
 * 返回值是 [{x, y, ms}]：第一点是起点（ms=0），每点带「走到这一步要等多久」。
 * 关键性质（单测覆盖）：
 *   - 首点 = from，末点 = to（落点精确，抖动只加在中间过程和控制点附近）
 *   - 点数随距离变化但在 [minSteps, maxSteps] 内，不是一步瞬移
 *   - 走的是弧线不是直线（垂直方向有 bend 偏移）
 *   - 每步带亚像素抖动
 *
 * @param {{x:number,y:number}} from 起点（一般是上一次的落点）
 * @param {{x:number,y:number}} to   目标点
 * @param {object} options
 *   steps     固定步数（默认按距离 dist/14，夹在 6..60）
 *   bend      弧度系数，控制点垂直偏移比例（默认 0.22）
 *   jitter    每步抖动幅度，像素（默认 0.8）
 *   speed     整体速度倍率，>1 更慢（默认 1）
 *   rng       随机源（默认 Math.random）
 */
export function buildTrajectory(from, to, options = {}) {
  const rng = options.rng || Math.random;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.hypot(dx, dy);

  const steps = options.steps != null
    ? clamp(Math.round(options.steps), 1, 200)
    : clamp(Math.round(dist / 14), options.minSteps ?? 6, options.maxSteps ?? 60);

  const bendMax = options.bend ?? 0.22;
  const nx = dist ? -dy / dist : 0;
  const ny = dist ? dx / dist : 0;
  const bend = rand(-bendMax, bendMax, rng) * dist;
  const p1 = { x: from.x + dx * 0.3 + nx * bend, y: from.y + dy * 0.3 + ny * bend };
  const p2 = { x: from.x + dx * 0.7 + nx * bend * 0.55, y: from.y + dy * 0.7 + ny * bend * 0.55 };

  const jitter = options.jitter ?? 0.8;
  const speed = options.speed ?? 1;
  const raw = [{ x: from.x, y: from.y, ms: 0 }];

  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const e = easeInOut(t);
    const pt = bezier(from, p1, p2, to, e);
    // 变速：两端慢、中段快
    const edge = t < 0.15 || t > 0.85;
    const ms = Math.round((edge ? rand(18, 32, rng) : rand(6, 14, rng)) * speed);
    // 最后一步落在目标点上，不抖，避免点空
    const last = i === steps;
    raw.push({
      x: last ? to.x : Math.round(pt.x + rand(-jitter, jitter, rng)),
      y: last ? to.y : Math.round(pt.y + rand(-jitter, jitter, rng)),
      ms: last ? 0 : ms,
    });
  }

  // 取整后可能出现和上一步完全相同的点（缓入阶段常见）。
  // 真实鼠标不会重复上报同一像素，这里去掉重复点，让每一步都是真的位移。
  const points = [];
  for (let i = 0; i < raw.length; i++) {
    const p = raw[i];
    const prev = points[points.length - 1];
    const isLast = i === raw.length - 1;
    if (!prev || p.x !== prev.x || p.y !== prev.y) points.push(p);
    else if (isLast) points[points.length - 1] = p; // 保证末点严格等于目标点
  }
  return points;
}

/**
 * 按轨迹分步移动：每一步先等 ms，再交给 emit(step, i) 去执行。
 *
 * emit 是「谁来动光标」的抽象：
 *   - CDP 页面鼠标：emit = (p) => page.send('Input.dispatchMouseEvent', {type:'mouseMoved', x:p.x, y:p.y})
 *   - 小窗虚拟光标：emit = (p) => overlay.pushCursor(p)
 *   - 系统窗口：macOS 后台路径没有移动图元（ocu 只暴露 click/type/press_key），
 *     传 null 时只保留节奏（每步照等），落点仍走 jitterPoint + sky_click。
 */
export async function playTrajectory(points, options = {}) {
  const wait = options.sleepFn || sleep;
  const scale = options.scale ?? 1;
  const emit = typeof options.emit === 'function' ? options.emit : null;
  const started = Date.now();
  let waitedMs = 0;
  let movedPx = 0;

  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (p.ms) {
      const ms = p.ms * scale;
      await wait(ms);
      waitedMs += ms;
    }
    if (emit) await emit(p, i);
    if (i > 0) movedPx += Math.hypot(p.x - points[i - 1].x, p.y - points[i - 1].y);
  }

  const end = points[points.length - 1];
  return {
    steps: points.length,
    waitedMs: Math.round(waitedMs),
    movedPx: Math.round(movedPx * 10) / 10,
    elapsedMs: Date.now() - started,
    end: { x: end.x, y: end.y },
  };
}

/** 操作前的随机停顿：像人一样先看一眼再动手 */
export async function preActionPause(scale = 1, options = {}) {
  const wait = options.sleepFn || sleep;
  await wait(rand(90, 260, options.rng || Math.random) * scale);
}

/** 动作之间的随机间隔 */
export async function betweenActions(scale = 1, options = {}) {
  const wait = options.sleepFn || sleep;
  await wait(rand(180, 520, options.rng || Math.random) * scale);
}

/** 随机挑一个「手滑」的错字：默认从键盘邻键里选，可用 typoPool 覆盖 */
export function typoChar(rng = Math.random, pool = 'asdfghjklqwertyuiopzxcv') {
  const chars = Array.from(pool);
  return chars[Math.floor(rand(0, chars.length - 1e-9, rng))];
}

/**
 * 逐段输入：把文本按「码点」切成 1–3 字一段，段间随机延迟，偶尔长停顿；
 * 给 backspace 函数时，还会偶发打错一个字，退格删掉，再敲对的（像真人打字）。
 *
 * @param {(text:string)=>Promise<any>} typeFn   实际输入一段文字
 * @param {string} text                           要输入的文本
 * @param {object} options
 *   minDelay/maxDelay  段间延迟区间（默认 40–130ms）
 *   pauseChance        插入长停顿的概率（默认 0.12）
 *   pauseMs            长停顿区间（默认 [260, 620]）
 *   maxChunk           每段最多几个码点（默认 3）
 *   typoChance         打错字的概率（默认 0；传了 backspace 才生效）
 *   backspace          async (count) => {...}，按码点删掉 count 个字
 *   typoPool/typoChar  错字候选
 *   sleepFn/rng        便于单测注入
 * @returns {{chars:number, chunks:number, typos:number, typoDetail:Array}}
 */
export async function humanType(typeFn, text, options = {}) {
  const rng = options.rng || Math.random;
  const wait = options.sleepFn || sleep;
  const minDelay = options.minDelay ?? 40;
  const maxDelay = options.maxDelay ?? 130;
  const pauseChance = options.pauseChance ?? 0.12;
  const pauseMs = options.pauseMs || [260, 620];
  const maxChunk = Math.max(1, options.maxChunk ?? 3);
  const typoChance = options.backspace ? (options.typoChance ?? 0) : 0;
  const pick = options.typoChar || ((r) => typoChar(r, options.typoPool));
  const chars = Array.from(text);
  const typoDetail = [];
  let chunks = 0;
  let i = 0;

  while (i < chars.length) {
    chunks += 1;
    const chunk = 1 + Math.floor(rand(0, maxChunk, rng));
    const part = chars.slice(i, i + chunk).join('');
    i += chunk;

    if (typoChance > 0 && rng() < typoChance) {
      const wrong = pick(rng);
      const wrongLen = Array.from(wrong).length;
      await typeFn(wrong);
      await wait(rand(60, 170, rng));
      await options.backspace(wrongLen);
      typoDetail.push({ wrong, atChunk: chunks });
      await wait(rand(30, 90, rng));
    }

    await typeFn(part);
    await wait(rand(minDelay, maxDelay, rng));
    if (rng() < pauseChance) await wait(rand(pauseMs[0], pauseMs[1], rng));
  }

  return { chars: chars.length, chunks, typos: typoDetail.length, typoDetail };
}

export default {
  rand,
  sleep,
  makeRng,
  jitterPoint,
  buildTrajectory,
  playTrajectory,
  preActionPause,
  betweenActions,
  typoChar,
  humanType,
};
