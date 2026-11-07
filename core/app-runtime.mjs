'use strict';
/**
 * 应用运行时画像：不启动应用、不截图，只看它的包结构和链接的框架，
 * 判断它属于哪类运行时，从而知道"从底层该用哪条通道去控制它"。
 *
 * 为什么要这么做：逐个应用试是线性工作量，装一百个软件就要试一百次；
 * 按运行时分类是有限集合（原生 / Electron / Chromium / Qt / Java / Flutter / WebView），
 * 同类应用共用一套通道和驱动，新软件只要归类就能直接被支持。
 */

/** 运行时类型（越靠前判定优先级越高） */
export const RUNTIME_TYPES = Object.freeze([
  'electron', 'chromium', 'flutter', 'qt', 'java', 'native',
]);

/**
 * 按框架清单判断运行时类型（纯函数）。
 * @param {string[]} frameworks Contents/Frameworks 下的名字，或 otool 出来的链接名
 * @param {{hasJvmRuntime?:boolean, hasAsar?:boolean}} [info]
 * @returns {{type:string, evidence:string[]}}
 */
export function classifyRuntime(frameworks = [], info = {}) {
  const list = (frameworks || []).map((x) => String(x));
  const has = (re) => list.find((x) => re.test(x)) || '';
  const evidence = [];

  const electron = has(/electron framework/i);
  if (electron) evidence.push('包含 ' + electron);
  if (info.hasAsar) evidence.push('包含 app.asar');

  if (electron || info.hasAsar) return { type: 'electron', evidence };

  const flutter = has(/fluttermacos|flutter\.framework/i);
  if (flutter) return { type: 'flutter', evidence: ['包含 ' + flutter] };

  const qt = has(/qtcore|qtgui|qtwidgets|libqt/i);
  if (qt) return { type: 'qt', evidence: ['包含 ' + qt] };

  if (info.hasJvmRuntime) return { type: 'java', evidence: ['包含 JVM 运行时'] };
  const jvm = has(/libjvm|javavm/i);
  if (jvm) return { type: 'java', evidence: ['包含 ' + jvm] };

  // Chromium 系不止 "Chromium Framework" 一种写法：微信/QQ 这类自研壳子里有 mojo IPC、
  // Renderer Helper 子进程，本质仍是 Chromium 多进程架构，能走 CDP 一族通道。
  // 「Chrome 系」的包结构不止一种写法：Chrome/Edge 的框架叫 "<厂商> Framework.framework"，
  // Helper (Renderer) 埋在框架内部的 Helpers 目录下（所以要连路径一起看），
  // 微信/QQ 这类自研壳子里有 mojo IPC，CEF 系则直接带 Chromium Embedded Framework。
  const chromium = has(/chromium( embedded)? framework/i)
    || has(/libmmmojo/i)
    || has(/libcef|cef\.framework/i)
    || has(/helper \(renderer\)\.app/i);
  if (chromium) {
    const label = String(chromium).split('/').pop();
    return { type: 'chromium', evidence: ['包含 ' + label] };
  }

  // 注意：链接系统的 WebKit.framework 不代表界面是 Web 做的（GarageBand 也链接它，用来显示帮助文档），
  // 所以这里只当线索记下来，不当成运行时类型，避免把原生应用误判成 Web 应用。
  const webkit = has(/webkit\.framework|webkit2/i);
  if (webkit) evidence.push('链接了 WebKit（可能只是内嵌网页/帮助文档）');

  return { type: 'native', evidence: evidence.length ? evidence : ['没有 Web/跨平台框架，按原生 AppKit 处理'] };
}

/** 每类运行时默认的通道与顺序（越靠前越优先） */
export const RUNTIME_CHAINS = Object.freeze({
  native: ['ax', 'applescript', 'visual'],
  electron: ['ax', 'cdp', 'applescript', 'visual'],
  chromium: ['cdp', 'ax', 'visual'],
  flutter: ['ax', 'visual'],
  qt: ['ax', 'applescript', 'visual'],
  java: ['ax', 'visual'],
});

export const DRIVER_INFO = Object.freeze({
  ax: {
    label: 'Accessibility 语义驱动',
    note: '读树 + 点元素 + 设值，不抢前台，最稳',
    requires: '进程有可读的 AX 树（部分自绘界面只有空树）',
  },
  cdp: {
    label: 'CDP 调试通道',
    note: 'Chromium/Electron 可开远程调试口，直接操作页面，绕开界面层',
    requires: '进程真的开着调试端口（不是所有 Electron 应用都允许开）',
  },
  applescript: {
    label: 'AppleScript 脚本字典',
    note: '应用自带命令字典时可按语义操作；第三方应用首次会弹自动化授权',
    requires: '应用包里有 .sdef 字典，且系统里已授权自动化',
  },
  visual: {
    label: '画面 + 坐标',
    note: '读不到树时的兜底：抓帧 + 按坐标点，窗口位置变化会失效',
    requires: '能抓到目标窗口的画面（窗口在别的桌面时只有纯色帧）',
  },
});

/**
 * 给一份运行时画像选驱动链（纯函数）。
 * @param {{type:string, applescript?:{available?:boolean, commands?:number}}} profile
 * @returns {Array<{driver:string, label:string, note:string, reason:string}>}
 */
export function chooseDriverChain(profile = {}) {
  const type = RUNTIME_TYPES.includes(profile.type) ? profile.type : 'native';
  const base = RUNTIME_CHAINS[type] || RUNTIME_CHAINS.native;
  const out = [];
  for (const driver of base) {
    if (driver === 'applescript') {
      const commands = Number(profile.applescript && profile.applescript.commands) || 0;
      if (!commands) continue; // 没有脚本字典就不排这条通道
      out.push({
        driver,
        ...DRIVER_INFO[driver],
        reason: '应用有 ' + commands + ' 条脚本命令，可按语义操作',
      });
      continue;
    }
    const reason = driver === 'ax'
      ? (type === 'native' ? '原生应用，界面树通常完整' : '跨平台框架一般会桥接无障碍树，先试 AX')
      : (driver === 'cdp'
        ? '基于 Chromium，可尝试开远程调试口'
        : '读不到树时用画面兜底');
    out.push({ driver, ...DRIVER_INFO[driver], reason });
  }
  if (!out.some((x) => x.driver === 'visual')) {
    out.push({ driver: 'visual', ...DRIVER_INFO.visual, reason: '最后的兜底通道' });
  }
  return out;
}

/** 从 sdef 输出里数命令（纯函数），用于判断应用有没有 AppleScript 字典 */
export function countSdefCommands(xml) {
  const text = String(xml || '');
  const names = new Set();
  for (const m of text.matchAll(/<command\s+name="([^"]+)"/g)) names.add(m[1]);
  return names.size;
}

/** 把画像和驱动链渲染成给人看的几行文字 */
export function describeProfile(profile, chain = chooseDriverChain(profile)) {
  const lines = [];
  lines.push('运行时：' + profile.type + (profile.evidence && profile.evidence.length ? '（' + profile.evidence.join('；') + '）' : ''));
  if (profile.applescript) {
    lines.push('AppleScript 字典：' + (profile.applescript.available ? profile.applescript.commands + ' 条命令' : '没有'));
  }
  lines.push('驱动顺序：' + chain.map((c) => c.driver).join(' → '));
  for (const c of chain) lines.push('  - ' + c.driver + '（' + c.label + '）：' + c.reason);
  return lines.join('\n');
}
