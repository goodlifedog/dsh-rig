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
    { name: 'Pages Creator Studio', bundle: 'com.apple.Pages', process: 'Pages' },
    { name: 'Keynote Creator Studio', bundle: 'com.apple.Keynote', process: 'Keynote' },
    { name: 'Numbers Creator Studio', bundle: 'com.apple.Numbers', process: 'Numbers' },
    { name: 'WPS Office', bundle: 'com.kingsoft.wpsoffice.mac', process: 'wpsoffice' },
    { name: '文本编辑', bundle: 'com.apple.TextEdit', process: 'TextEdit' },
  ],
  // 聊天 / 会议
  im: [
    { name: 'QQ', bundle: 'com.tencent.qq', process: 'QQ' },
    { name: 'WeChat', bundle: 'com.tencent.xinWeChat', process: 'WeChat' },
    { name: 'Telegram', bundle: 'ru.keepcoder.Telegram', process: 'Telegram' },
    { name: 'Gemini', bundle: 'com.google.GeminiMacOS', process: 'Gemini' },
    { name: 'ChatGPT', bundle: 'com.openai.codex', process: 'ChatGPT' },
    { name: 'TencentMeeting', bundle: 'com.tencent.meeting', process: 'TencentMeeting' },
  ],
  // 开发 / 终端 / 虚拟机 / 游戏平台
  dev: [
    { name: 'Ghostty', bundle: 'com.mitchellh.ghostty', process: 'ghostty' },
    { name: 'OrbStack', bundle: 'dev.kdrag0n.MacVirt', process: 'OrbStack' },
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
    // Safari 实测可读（窗口里的页内容不在 AX 树里，但浏览器壳 105 个节点可读可点）；
    // 冷启动不留窗口，所以探测结果依赖"用户已经有 Safari 窗口"
    { name: 'Safari', bundle: 'com.apple.Safari', process: 'Safari' },
    { name: 'Clash Verge', bundle: 'io.github.clash-verge-rev.clash-verge-rev', process: 'clash-verge' },
  ],
  // 音视频
  // 这里只放"打开就能看到界面"的创作类应用；后台常驻的音乐播放器另有 risk 名单兜底。
  media: [
    { name: 'iMovie', bundle: 'com.apple.iMovieApp', process: 'iMovie' },
    { name: 'GarageBand', bundle: 'com.apple.garageband10', process: 'GarageBand' },
    // 音乐：首次冷启动会弹「媒体库同步 / 欢迎」引导窗，探测只能读、绝不点。
    { name: 'Music', bundle: 'com.apple.Music', process: 'Music' },
  ],
  // 邮件
  // 系统邮件窗口的 AX 树可读（列表 + 正文），但首次启动会要求登录账号并弹「新建邮箱」向导；
  // 矩阵探测只读，不点任何按钮，不触发发信/删信这类不可逆动作。
  mail: [
    { name: 'Mail', bundle: 'com.apple.mail', process: 'Mail' },
  ],
  // 日历 / 提醒：同一个门类，都是"读多写少"的个人数据应用
  // 首次打开可能弹 iCloud 同步 / 通知权限；探测只看窗口是否可用，绝不点"接受/稍后"，
  // 也不删事件、不改日程（读出来的数据涉及个人隐私，报告里不落具体内容）。
  calendar: [
    { name: 'Calendar', bundle: 'com.apple.iCal', process: 'Calendar' },
    { name: 'Reminders', bundle: 'com.apple.reminders', process: 'Reminders' },
  ],
  // 阅读 / 预览
  // Preview 打开文件才有窗口，冷启动是空壳；矩阵里判定的是"壳可读"，不代表 PDF 内容在 AX 树里。
  reading: [
    { name: 'Preview', bundle: 'com.apple.Preview', process: 'Preview' },
  ],
  // 照片
  // 首次启动会弹「照片图库」选择 / iCloud 同步引导，且默认可能开始扫描图库——
  // 探测只读窗口与菜单，绝不动图库设置、不导入不删除。
  photos: [
    { name: 'Photos', bundle: 'com.apple.Photos', process: 'Photos' },
  ],
  // 效率小工具
  tools: [
    { name: 'FastZip', bundle: 'cn.better365.FastZip', process: 'FastZip' },
    { name: 'State', bundle: 'com.better365.menubar', process: 'State' },
    { name: 'iRightMouse', bundle: 'cn.better365.iRightMouse', process: 'iRightMouse' },
    { name: 'UURemote', bundle: 'com.netease.uuremote', process: 'UURemote' },
  ],
});

/**
 * 不对其做后台探测的应用：要么是用户正在用的关键工具，要么是宿主自己。
 * 清点报告里会标成「不动」/「专用方案」，而不是永远挂在「未测」。
 */
export const SPECIAL_APP_HANDLING = Object.freeze({
  'io.github.clash-verge-rev.clash-verge-rev': { status: '不动', detail: '用户代理工具，只读状态，永不退出、不点按钮' },
  'com.qeeyou.MobileGameAccelerator': { status: '不动', detail: '游戏加速器，同上，不接管' },
  'com.deepseek.dsh': { status: '不动', detail: '宿主机应用（本工具运行在这个会话里），不控制自己' },
  'com.google.Chrome': { status: '专用方案', detail: '会自己抢前台，走独立 profile 的 headless 实例（browser:bg）' },
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
