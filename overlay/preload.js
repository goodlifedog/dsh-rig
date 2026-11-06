'use strict';

/**
 * 渲染进程与主进程之间的最小桥。
 * 渲染进程开启 contextIsolation + sandbox，只通过这里暴露的 overlay API 拿数据。
 */

const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel) {
  return (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  };
}

contextBridge.exposeInMainWorld('overlay', {
  getState: () => ipcRenderer.invoke('overlay:get-state'),
  close: () => ipcRenderer.send('overlay:close'),
  toggleExpand: () => ipcRenderer.invoke('overlay:toggle-expand'),
  setHover: (v) => ipcRenderer.send('overlay:hover', Boolean(v)),
  // 鼠标进入按钮/拖拽条热区时告诉主进程，切换「点击穿透」；其余区域保持穿透
  setInteractive: (v) => ipcRenderer.send('overlay:interactive', Boolean(v)),
  onLog: subscribe('overlay:log'),
  onStatus: subscribe('overlay:status'),
  onActivity: subscribe('overlay:activity'),
  onThumb: subscribe('overlay:thumb'),
  onThumbState: subscribe('overlay:thumb-state'),
});