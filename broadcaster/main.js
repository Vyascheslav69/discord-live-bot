const { app, BrowserWindow, desktopCapturer, ipcMain, session } = require('electron');
const { execFile } = require('child_process');
const path = require('path');
const { LoopbackCapture } = require('loopback-capture');

let win = null;
let selectedId = null;

ipcMain.handle('list-sources', async () =>
  (await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 180 } })).map((s) => ({
    id: s.id,
    name: s.name,
    thumb: s.thumbnail.toDataURL(),
  }))
);
ipcMain.handle('select-source', (_, id) => (selectedId = id));
// Servidores/calls onde o bot pode avisar (pelo processo principal: a página file:// esbarraria em CORS).
ipcMain.handle('destinations', async (_, server, password) => {
  const res = await fetch(new URL('/destinations', server), { headers: { Authorization: `Bearer ${password}` } });
  if (res.status === 401) throw new Error('senha');
  if (!res.ok) throw new Error(`servidor respondeu ${res.status}`);
  return res.json();
});

/* ---------- áudio do PC sem o Discord (evita eco) ---------- */

const capture = new LoopbackCapture();
let capturing = false;
let excludedPid = null;
let watchTimer = null;

// PID raiz do Discord (app desktop, PTB ou Canary); excluir a árvore dele tira todo o áudio do Discord.
function findDiscordRoot() {
  const ps = `Get-CimInstance Win32_Process -Filter "Name like 'Discord%.exe'" | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress`;
  return new Promise((resolve) =>
    execFile('powershell.exe', ['-NoProfile', '-Command', ps], { timeout: 8000, windowsHide: true }, (err, out) => {
      if (err || !out.trim()) return resolve(null);
      const list = [].concat(JSON.parse(out));
      const pids = new Set(list.map((p) => p.ProcessId));
      resolve(list.find((p) => !pids.has(p.ParentProcessId))?.ProcessId ?? null);
    })
  );
}

function startCapture(pid) {
  if (capturing) capture.stop();
  excludedPid = pid;
  // Sem Discord aberto, exclui o próprio laele viewer (mantém o mesmo modo de captura).
  capture.startSystemAudio((chunk) => win?.webContents.send('audio', chunk), pid ?? process.pid);
  capturing = true;
}

async function checkDiscord() {
  const alive = excludedPid && (() => { try { return process.kill(excludedPid, 0); } catch { return false; } })();
  if (alive) return;
  const pid = await findDiscordRoot();
  if (capturing && pid !== excludedPid) startCapture(pid); // Discord abriu ou reiniciou
}

ipcMain.handle('audio-start', async () => {
  startCapture(await findDiscordRoot());
  watchTimer = setInterval(checkDiscord, 5000);
  return { discordFound: excludedPid !== null };
});

ipcMain.handle('audio-stop', () => {
  clearInterval(watchTimer);
  if (capturing) capture.stop();
  capturing = false;
  excludedPid = null;
});

app.whenReady().then(() => {
  session.defaultSession.setDisplayMediaRequestHandler(async (_, callback) => {
    const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] });
    callback({ video: sources.find((s) => s.id === selectedId) ?? sources[0] });
  });

  win = new BrowserWindow({
    width: 520,
    height: 720,
    // Tamanho fixo: sem redimensionar, maximizar ou tela cheia (F11 incluso).
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    backgroundColor: '#000000',
    autoHideMenuBar: true,
    title: 'laele viewer',
    // Sem isso o Chromium freia os timers com a janela minimizada/atrás de outras e o vídeo para de ser enviado.
    webPreferences: { preload: path.join(__dirname, 'preload.js'), backgroundThrottling: false },
  });
  win.loadFile('index.html');
});

app.on('window-all-closed', () => {
  if (capturing) capture.stop();
  app.quit();
});
