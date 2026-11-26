const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('capture', {
  listSources: () => ipcRenderer.invoke('list-sources'),
  selectSource: (id) => ipcRenderer.invoke('select-source', id),
  destinations: (server, password) => ipcRenderer.invoke('destinations', server, password),
  startAudio: () => ipcRenderer.invoke('audio-start'),
  stopAudio: () => ipcRenderer.invoke('audio-stop'),
  onAudio: (cb) => ipcRenderer.on('audio', (_, chunk) => cb(chunk)),
});
