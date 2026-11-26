const { app, BrowserWindow, desktopCapturer, ipcMain, session, shell, systemPreferences } = require('electron');
const { execFile } = require('child_process');
const path = require('path');
const { log, dir: logDir } = require('./log');

process.on('uncaughtException', (e) => log('erro', 'exceção não tratada:', e));
process.on('unhandledRejection', (e) => log('erro', 'promessa rejeitada:', e));

// Som do PC sem o Discord: Windows (WASAPI) e Linux (PipeWire). No Mac a biblioteca não existe: transmite só vídeo.
let LoopbackCapture = null;
try {
  ({ LoopbackCapture } = require('loopback-capture'));
} catch (e) {
  // macOS (ou plataforma sem binário): sem som
  log('info', `captura de som indisponível neste sistema (${e.code ?? e.message}): só vídeo`);
}

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
// Log vindo da página (estados, erros) e botão "Abrir logs".
ipcMain.on('log', (_, level, message) => log(level, message));
ipcMain.handle('open-logs', () => shell.openPath(logDir));
// No Mac a captura de tela depende da permissão "Gravação de Tela" do sistema.
ipcMain.handle('screen-access', () => (process.platform === 'darwin' ? systemPreferences.getMediaAccessStatus('screen') : 'granted'));
// Servidores/calls onde o bot pode avisar (pelo processo principal: a página file:// esbarraria em CORS).
ipcMain.handle('destinations', async (_, server, password) => {
  try {
    const res = await fetch(new URL('/destinations', server), { headers: { Authorization: `Bearer ${password}` } });
    if (res.status === 401) throw new Error('senha');
    if (!res.ok) throw new Error(`servidor respondeu ${res.status}`);
    return await res.json();
  } catch (e) {
    log('aviso', `lista de calls do bot em ${server}:`, e.message);
    throw e;
  }
});

/* ---------- áudio do PC sem o Discord (evita eco) ---------- */

const capture = LoopbackCapture ? new LoopbackCapture() : null;
let capturing = false;
let excludedPid = null;
let watchTimer = null;

// Processos do Discord (app desktop, PTB ou Canary) como [{ pid, ppid }].
function listDiscordProcesses() {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      const ps = `Get-CimInstance Win32_Process -Filter "Name like 'Discord%.exe'" | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress`;
      execFile('powershell.exe', ['-NoProfile', '-Command', ps], { timeout: 8000, windowsHide: true }, (err, out) => {
        if (err) log('aviso', 'não consegui listar processos do Discord:', err.message);
        if (err || !out.trim()) return resolve([]);
        resolve([].concat(JSON.parse(out)).map((p) => ({ pid: p.ProcessId, ppid: p.ParentProcessId })));
      });
    } else {
      execFile('ps', ['-eo', 'pid=,ppid=,comm='], { timeout: 8000 }, (err, out) => {
        if (err) {
          log('aviso', 'não consegui listar processos do Discord:', err.message);
          return resolve([]);
        }
        resolve(
          out
            .split('\n')
            .map((line) => line.trim().split(/\s+/))
            .filter(([, , comm]) => /^discord/i.test(comm ?? ''))
            .map(([pid, ppid]) => ({ pid: Number(pid), ppid: Number(ppid) }))
        );
      });
    }
  });
}

// PID raiz do Discord; excluir a árvore dele tira todo o áudio do Discord.
async function findDiscordRoot() {
  const list = await listDiscordProcesses();
  const pids = new Set(list.map((p) => p.pid));
  return list.find((p) => !pids.has(p.ppid))?.pid ?? null;
}

function startCapture(pid) {
  if (capturing) capture.stop();
  excludedPid = pid;
  // Sem Discord aberto, exclui o próprio laele viewer (mantém o mesmo modo de captura).
  capture.startSystemAudio((chunk) => win?.webContents.send('audio', chunk), pid ?? process.pid);
  capturing = true;
  log('info', pid ? `captura de som iniciada sem o Discord (pid ${pid})` : 'captura de som iniciada (Discord desktop não está aberto)');
}

async function checkDiscord() {
  if (capture?.lastError) log('erro', 'captura de som:', capture.lastError);
  const alive = excludedPid && (() => { try { return process.kill(excludedPid, 0); } catch { return false; } })();
  if (alive) return;
  const pid = await findDiscordRoot();
  if (capturing && pid !== excludedPid) startCapture(pid); // Discord abriu ou reiniciou
}

ipcMain.handle('audio-start', async () => {
  if (!capture) return { audio: false, discordFound: false };
  try {
    startCapture(await findDiscordRoot());
  } catch (e) {
    // Sem som é melhor do que sem transmissão.
    log('erro', 'não consegui iniciar a captura de som, seguindo só com vídeo:', e);
    return { audio: false, discordFound: false };
  }
  watchTimer = setInterval(checkDiscord, 5000);
  return { audio: true, discordFound: excludedPid !== null };
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

  // Erros e avisos do console da página também vão para o log.
  win.webContents.on('console-message', ({ level, message }) => {
    if (level === 'error') log('erro', 'página:', message);
    else if (level === 'warning') log('aviso', 'página:', message);
  });
  win.webContents.on('render-process-gone', (_, details) => log('erro', 'a página travou/fechou:', details));
});

app.on('window-all-closed', () => {
  if (capturing) capture.stop();
  log('info', 'app fechado');
  app.quit();
});
