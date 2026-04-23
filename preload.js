const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getUsage:        ()   => ipcRenderer.invoke('get-usage'),
  closeWindow:     ()   => ipcRenderer.send('close-window'),
setWindowHeight: (h)  => ipcRenderer.send('set-window-height', h),
  onUsageData:     (cb) => ipcRenderer.on('usage-data',    (_e, d) => cb(d)),
  onShowAnimate:   (cb) => ipcRenderer.on('show-animate',  ()      => cb()),
});
