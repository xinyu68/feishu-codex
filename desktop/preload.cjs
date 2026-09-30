const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('feishuCodex', Object.freeze({
  getStatus: () => ipcRenderer.invoke('desktop:getStatus'),
  getPreferences: () => ipcRenderer.invoke('desktop:getPreferences'),
  setPreferences: preferences => ipcRenderer.invoke('desktop:setPreferences', preferences),
  chooseWorkspace: () => ipcRenderer.invoke('desktop:chooseWorkspace'),
  openCodex: () => ipcRenderer.invoke('desktop:openCodex'),
  switchToShared: () => ipcRenderer.invoke('desktop:switchToShared'),
  retry: () => ipcRenderer.invoke('desktop:retry'),
  openLogs: () => ipcRenderer.invoke('desktop:openLogs'),
  checkForUpdates: () => ipcRenderer.invoke('desktop:checkForUpdates'),
  downloadUpdate: () => ipcRenderer.invoke('desktop:downloadUpdate'),
  installUpdate: () => ipcRenderer.invoke('desktop:installUpdate'),
  quit: () => ipcRenderer.invoke('desktop:quit'),
  migrate: () => ipcRenderer.invoke('desktop:migrate'),
  setupFresh: () => ipcRenderer.invoke('desktop:setupFresh'),
  restoreExisting: () => ipcRenderer.invoke('desktop:restoreExisting'),
  showWindow: () => ipcRenderer.invoke('desktop:showWindow'),
  onStatus: callback => {
    if (typeof callback !== 'function') throw new TypeError('callback must be a function');
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('desktop:status', listener);
    return () => ipcRenderer.removeListener('desktop:status', listener);
  },
}));
