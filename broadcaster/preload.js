const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('capture', {
  listSources: () => ipcRenderer.invoke('list-sources'),
  selectSource: (id) => ipcRenderer.invoke('select-source', id),
  destinations: (server, password) => ipcRenderer.invoke('destinations', server, password),
  screenAccess: () => ipcRenderer.invoke('screen-access'),
  log: (level, message) => ipcRenderer.send('log', level, String(message)),
  openLogs: () => ipcRenderer.invoke('open-logs'),
  startAudio: () => ipcRenderer.invoke('audio-start'),
  stopAudio: () => ipcRenderer.invoke('audio-stop'),
  onAudio: (cb) => ipcRenderer.on('audio', (_, chunk) => cb(chunk)),
});
