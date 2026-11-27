const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('capture', {
  listSources: () => ipcRenderer.invoke('list-sources'),
  selectSource: (id) => ipcRenderer.invoke('select-source', id),
  serverInfo: (server) => ipcRenderer.invoke('server-info', server),
  discordLogin: (server, clientId) => ipcRenderer.invoke('discord-login', server, clientId),
  me: (server, password, session) => ipcRenderer.invoke('me', server, password, session),
  screenAccess: () => ipcRenderer.invoke('screen-access'),
  log: (level, message) => ipcRenderer.send('log', level, String(message)),
  openLogs: () => ipcRenderer.invoke('open-logs'),
  startAudio: () => ipcRenderer.invoke('audio-start'),
  stopAudio: () => ipcRenderer.invoke('audio-stop'),
  onAudio: (cb) => ipcRenderer.on('audio', (_, chunk) => cb(chunk)),
  windowAction: (action) => ipcRenderer.send('window', action),
  version: () => ipcRenderer.invoke('app-version'),
  checkUpdate: () => ipcRenderer.invoke('check-update'),
  installUpdate: () => ipcRenderer.invoke('install-update'),
  onUpdateProgress: (cb) => ipcRenderer.on('update-progress', (_, pct) => cb(pct)),
});
