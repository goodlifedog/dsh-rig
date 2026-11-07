'use strict';
/**
 * 应用清单预设：按门类批量探测，不用每次手写 MATRIX_APPS_JSON。
 *
 *   MATRIX_PRESET=im npm run matrix
 *
 * 每个条目 { name, bundle, process }：name 是给人看的名字（也是探测时用来匹配窗口的线索），
 * bundle 用于 open -g 兜底启动，process 是英文可执行名（pgrep -x 判定是否在跑）。
 */

export const PRESETS = Object.freeze({
  // 办公文档
  office: [
    { name: 'Pages Creator Studio', bundle: 'com.apple.iWork.Pages', process: 'Pages' },
    { name: 'Keynote Creator Studio', bundle: 'com.apple.Keynote', process: 'Keynote' },
    { name: 'Numbers Creator Studio', bundle: 'com.apple.Numbers', process: 'Numbers' },
    { name: 'WPS Office', bundle: 'com.kingsoft.wpsoffice.mac', process: 'wpsoffice' },
    { name: '文本编辑', bundle: 'com.apple.TextEdit', process: 'TextEdit' },
  ],
  // 聊天 / 会议
  im: [
    { name: 'QQ', bundle: 'com.tencent.qq', process: 'QQ' },
    { name: 'WeChat', bundle: 'com.tencent.xinWeChat', process: 'WeChat' },
    { name: 'Telegram', bundle: 'com.tdesktop.Telegram', process: 'Telegram' },
    { name: 'Gemini', bundle: 'com.google.Gemini', process: 'Gemini' },
    { name: 'ChatGPT', bundle: 'com.openai.codex', process: 'ChatGPT' },
    { name: 'TencentMeeting', bundle: 'com.tencent.meeting', process: 'TencentMeeting' },
  ],
  // 开发 / 终端 / 虚拟机 / 游戏平台
  dev: [
    { name: 'Ghostty', bundle: 'com.mitchellh.ghostty', process: 'ghostty' },
    { name: 'OrbStack', bundle: 'dev.kdrag0n.orbstack', process: 'OrbStack' },
    { name: 'OpenCode', bundle: 'ai.opencode.desktop', process: 'OpenCode' },
    { name: 'Antigravity', bundle: 'com.google.antigravity', process: 'Antigravity' },
    { name: 'Steam', bundle: 'com.valvesoftware.steam', process: 'steam_osx' },
  ],
  // 系统自带（探测时只读，不点危险按钮）
  system: [
    { name: '备忘录', bundle: 'com.apple.Notes', process: 'Notes' },
    { name: '计算器', bundle: 'com.apple.calculator', process: 'Calculator' },
    { name: '访达', bundle: 'com.apple.finder', process: 'Finder' },
    { name: '系统设置', bundle: 'com.apple.systempreferences', process: 'System Settings' },
    { name: 'Clash Verge', bundle: 'com.nicenormalboy.clash-verge', process: 'clash-verge' },
  ],
  // 音视频
  media: [
    { name: 'iMovie', bundle: 'com.apple.iMovieApp', process: 'iMovie' },
    { name: 'GarageBand', bundle: 'com.apple.garageband10', process: 'GarageBand' },
  ],
  // 效率小工具
  tools: [
    { name: 'FastZip', bundle: 'cn.better365.FastZip', process: 'FastZip' },
    { name: 'State', bundle: 'com.better365.menubar', process: 'State' },
    { name: 'iRightMouse', bundle: 'cn.better365.iRightMouse', process: 'iRightMouse' },
    { name: 'UURemote', bundle: 'com.netease.uuremote', process: 'UURemote' },
  ],
});

/** 可用的预设名（排序后返回，便于报错时提示） */
export function presetNames() {
  return Object.keys(PRESETS).sort();
}

/**
 * 取一个预设应用列表（返回浅拷贝，调用方随便改）。
 * @param {string} name
 * @returns {Array<{name:string, bundle:string, process:string}>}
 */
export function presetApps(name) {
  const key = String(name || '').trim();
  const list = PRESETS[key];
  if (!list) {
    const error = new Error('未知预设：' + (key || '(空)') + '，可用：' + presetNames().join(' / '));
    error.code = 'UNKNOWN_PRESET';
    throw error;
  }
  return list.map((app) => ({ ...app }));
}
