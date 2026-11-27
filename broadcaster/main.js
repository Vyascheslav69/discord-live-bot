const { app, BrowserWindow, Menu, Tray, desktopCapturer, ipcMain, nativeImage, screen, session, shell, systemPreferences } = require('electron');
const { execFile, spawn } = require('child_process');
const { randomBytes } = require('crypto');
const net = require('net');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
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
let tray = null;
let quitting = false;

// Uma instância só: abrir o atalho de novo traz de volta a janela escondida na bandeja.
if (!app.requestSingleInstanceLock()) app.exit(0);
app.on('second-instance', () => showWindow());

const WIDTH = 580;
const HEIGHT = 880;

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  else win.show();
  win.focus();
}

// Fechar (X) esconde na bandeja e a transmissão continua; "Fechar" no menu da bandeja sai de verdade.
// Minimizar é o normal do sistema (fica na barra de tarefas).
function hideToTray() {
  win.hide();
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'build', 'icon.png')).resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.setToolTip('laele viewer');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Abrir laele viewer', click: showWindow },
      { label: 'Abrir logs', click: () => shell.openPath(logDir) },
      { type: 'separator' },
      { label: 'Fechar', click: () => app.quit() },
    ])
  );
  tray.on('click', showWindow);
}

app.on('before-quit', () => (quitting = true));
app.on('activate', () => showWindow()); // Mac: clique no ícone do Dock

/* ---------- lista de telas e janelas ---------- */

// desktopCapturer.getSources trava o processo principal (e a janela) por ~0,5 s a cada chamada e esconde janelas
// minimizadas. No Windows a lista de janelas vem de um PowerShell fixo (processo à parte, ~10 ms) e o getSources só
// roda quando aparece uma janela nova, para pegar as miniaturas.
const thumbs = new Map(); // id -> miniatura (data URL)
const noThumb = new Set(); // janelas que o getSources não devolve: não adianta pedir de novo
let screens = [];
let otherList = null;

async function fetchSources() {
  const list = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 180 } });
  for (const s of list) thumbs.set(s.id, `data:image/jpeg;base64,${s.thumbnail.toJPEG(75).toString('base64')}`);
  screens = list.filter((s) => s.id.startsWith('screen:')).map((s) => ({ id: s.id, name: s.name }));
  return list;
}

const WIN_CS = String.raw`
using System; using System.Text; using System.Collections.Generic; using System.Runtime.InteropServices;
public static class LaeleWin {
  delegate bool CB(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] static extern bool EnumWindows(CB cb, IntPtr p);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindowAsync(IntPtr h, int cmd);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int a, out int v, int s);
  // Janelas que aparecem na barra de tarefas: visíveis, com título, sem dono, não "ferramenta" e não ocultas (cloaked).
  public static string List() {
    var o = new List<string>();
    EnumWindows((h, p) => {
      int cloaked;
      if (!IsWindowVisible(h) || GetWindow(h, 4) != IntPtr.Zero || (GetWindowLong(h, -20) & 0x80) != 0) return true;
      if (DwmGetWindowAttribute(h, 14, out cloaked, 4) == 0 && cloaked != 0) return true;
      var s = new StringBuilder(512);
      if (GetWindowText(h, s, 512) == 0) return true;
      o.Add(h.ToInt64() + "\t" + (IsIconic(h) ? 1 : 0) + "\t" + s.ToString().Replace("\n", " "));
      return true;
    }, IntPtr.Zero);
    return string.Join("\n", o);
  }
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  // Restaura sem roubar o foco; "1" se estava minimizada. Alguns apps (o Discord) ignoram o ShowWindowAsync de
  // outro processo, mas aceitam o "restaurar" do menu da janela (WM_SYSCOMMAND SC_RESTORE).
  public static string Restore(long hwnd) {
    var h = new IntPtr(hwnd);
    if (!IsIconic(h)) return "0";
    ShowWindowAsync(h, 4);
    System.Threading.Thread.Sleep(150);
    if (IsIconic(h)) PostMessage(h, 0x0112, new IntPtr(0xF120), IntPtr.Zero);
    return "1";
  }
}`;

let winHelper = null;
let helperQueue = Promise.resolve();

// Uma pergunta por vez ao PowerShell fixo; a resposta termina em <<fim>>.
function askWindows(line) {
  if (!winHelper) {
    const script = [
      '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
      `Add-Type -TypeDefinition @'\n${WIN_CS}\n'@`,
      'while ($null -ne ($l = [Console]::In.ReadLine())) {',
      "  if ($l.StartsWith('restore ')) { [Console]::Out.Write([LaeleWin]::Restore([long]$l.Substring(8))) } else { [Console]::Out.Write([LaeleWin]::List()) }",
      '  [Console]::Out.Write("`n<<fim>>`n"); [Console]::Out.Flush()',
      '}',
    ].join('\n');
    const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true });
    ps.stdout.setEncoding('utf8');
    ps.on('error', (e) => log('aviso', 'PowerShell da lista de janelas:', e.message));
    ps.on('exit', () => winHelper === ps && (winHelper = null));
    winHelper = ps;
  }
  const ps = winHelper;
  const answer = helperQueue.then(
    () =>
      new Promise((resolve, reject) => {
        let buf = '';
        const done = () => (clearTimeout(timer), ps.stdout.off('data', onData));
        const onData = (d) => {
          buf += d;
          const end = buf.indexOf('<<fim>>');
          if (end >= 0) done(), resolve(buf.slice(0, end).trim());
        };
        const timer = setTimeout(() => (done(), ps.kill(), reject(new Error('PowerShell não respondeu'))), 10000);
        ps.stdout.on('data', onData);
        ps.stdin.write(`${line}\n`);
      })
  );
  helperQueue = answer.catch(() => {});
  return answer;
}

async function listSourcesWindows() {
  const out = await askWindows('list');
  const wins = out
    ? out.split('\n').map((line) => {
        const [hwnd, minimized, ...title] = line.split('\t');
        return { id: `window:${hwnd}:0`, name: title.join('\t'), minimized: minimized === '1' };
      })
    : [];
  // Janela nova à vista e sem miniatura: um getSources (trava ~0,5 s, só nessa hora).
  if (!screens.length || wins.some((w) => !w.minimized && !thumbs.has(w.id) && !noThumb.has(w.id))) {
    const got = new Set((await fetchSources()).map((s) => s.id));
    for (const w of wins) if (!w.minimized && !got.has(w.id)) noThumb.add(w.id);
  }
  return [...screens, ...wins];
}

// Mac/Linux: sem o PowerShell, o getSources roda de novo só quando a janela ganha foco.
async function listSourcesOther() {
  if (!otherList) otherList = (await fetchSources()).map((s) => ({ id: s.id, name: s.name }));
  return otherList;
}

ipcMain.handle('list-sources', async () => {
  let list;
  try {
    list = process.platform === 'win32' ? await listSourcesWindows() : await listSourcesOther();
  } catch (e) {
    log('aviso', 'lista de janelas pelo PowerShell falhou, usando a do Electron:', e.message);
    list = await listSourcesOther();
  }
  // A própria janela do laele viewer fica fora da lista (compara o HWND: o id de mídia dela termina em :1, o da lista em :0).
  const own = win && `window:${win.getMediaSourceId().split(':')[1]}:`;
  return list.filter((s) => !own || !s.id.startsWith(own)).map((s) => ({ ...s, thumb: thumbs.get(s.id) }));
});

ipcMain.handle('select-source', async (_, id) => {
  selectedId = id;
  // Janela minimizada não pode ser capturada: restaura (sem roubar o foco) e espera a animação.
  const hwnd = process.platform === 'win32' && id.match(/^window:(\d+):/)?.[1];
  if (hwnd && (await askWindows(`restore ${hwnd}`)) === '1') await new Promise((r) => setTimeout(r, 400));
});
// Log vindo da página (estados, erros) e botão "Abrir logs".
ipcMain.on('log', (_, level, message) => log(level, message));
ipcMain.handle('open-logs', () => shell.openPath(logDir));

/* ---------- barra própria da janela e atualização ---------- */

// Fechar passa pelo evento 'close' (esconde na bandeja), igual ao X do sistema.
ipcMain.on('window', (_, action) => (action === 'minimize' ? win.minimize() : win.close()));
ipcMain.handle('app-version', () => app.getVersion());

const REPO = 'Vyascheslav69/discord-live-bot';
// Instalador deste sistema entre os arquivos da Release (nomes definidos em package.json → build).
const ASSET = { win32: /\.exe$/, darwin: new RegExp(`-mac-${process.arch}\\.dmg$`), linux: /\.AppImage$/ }[process.platform];
let release = null;

// "1.10.0" é mais nova que "1.9.2".
const isNewer = (a, b) => {
  const [x, y] = [a, b].map((v) => v.split('.').map(Number));
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
};

ipcMain.handle('check-update', async () => {
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' } });
  if (!res.ok) throw new Error(`GitHub respondeu ${res.status}`);
  release = await res.json();
  const latest = release.tag_name.replace(/^v/, '');
  return { latest, newer: isNewer(latest, app.getVersion()) };
});

// Windows: baixa o instalador e abre (ele instala por cima). Mac/Linux: o download abre no navegador.
ipcMain.handle('install-update', async () => {
  const asset = release?.assets.find((a) => ASSET?.test(a.name));
  if (process.platform !== 'win32' || !asset) {
    await shell.openExternal(asset?.browser_download_url ?? release.html_url);
    return 'browser';
  }
  const file = path.join(app.getPath('temp'), asset.name);
  const res = await fetch(asset.browser_download_url);
  if (!res.ok) throw new Error(`download respondeu ${res.status}`);
  const body = Readable.fromWeb(res.body);
  let got = 0;
  let shown = -1;
  body.on('data', (chunk) => {
    const pct = Math.floor(((got += chunk.length) / asset.size) * 100);
    if (pct !== shown) win?.webContents.send('update-progress', (shown = pct));
  });
  await pipeline(body, fs.createWriteStream(file));
  log('info', `abrindo o instalador da versão ${release.tag_name}`);
  spawn(file, [], { detached: true, stdio: 'ignore' }).unref();
  app.quit(); // o instalador precisa do app fechado
});
// No Mac a captura de tela depende da permissão "Gravação de Tela" do sistema.
ipcMain.handle('screen-access', () => (process.platform === 'darwin' ? systemPreferences.getMediaAccessStatus('screen') : 'granted'));
/* ---------- conta do Discord (pelo processo principal: a página file:// esbarraria em CORS) ---------- */

// O servidor tem login do Discord? Sem ele, o laele viewer pede o nome digitado.
ipcMain.handle('server-info', async (_, server) => {
  const res = await fetch(new URL('/auth/config', server)).catch(() => null);
  if (!res) throw new Error('servidor');
  return res.ok ? res.json() : { discord: false }; // relay antigo, sem /auth
});

// Pede a autorização ao Discord aberto no PC (RPC local: pipe/socket "discord-ipc-N"). O Discord mostra a janela
// "Autorizar" e devolve um código, que o relay troca pela conta. Sem navegador e sem senha.
function discordAuthorize(clientId) {
  const base = (process.env.XDG_RUNTIME_DIR || process.env.TMPDIR || '/tmp').replace(/\/$/, '');
  // Windows: pipe. Mac: $TMPDIR. Linux: Discord normal, Flatpak e Snap põem o socket em lugares diferentes.
  const paths = process.platform === 'win32'
    ? [...Array(10).keys()].map((i) => `\\\\?\\pipe\\discord-ipc-${i}`)
    : [base, `${base}/app/com.discordapp.Discord`, `${base}/snap.discord`].flatMap((d) => [...Array(10).keys()].map((i) => `${d}/discord-ipc-${i}`));
  const open = (p) =>
    new Promise((resolve, reject) => {
      const sock = net.createConnection(p);
      sock.once('connect', () => resolve(sock));
      sock.once('error', reject);
    });
  return (async () => {
    let sock = null;
    let blocked = false;
    for (const p of paths) {
      sock = await open(p).catch((e) => ((blocked ||= e.code === 'EPERM' || e.code === 'EACCES'), null));
      if (sock) break;
    }
    // EPERM: o Discord existe, mas está aberto como administrador e o Windows bloqueia a conversa.
    if (!sock) throw new Error(blocked ? 'discord-admin' : 'discord-fechado');
    // Mensagem: [op int32 LE][tamanho int32 LE][JSON]. op 0 = handshake, 1 = comando, 2 = fechou.
    const send = (op, obj) => {
      const json = Buffer.from(JSON.stringify(obj));
      const head = Buffer.alloc(8);
      head.writeInt32LE(op, 0);
      head.writeInt32LE(json.length, 4);
      sock.write(Buffer.concat([head, json]));
    };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error('a autorização no Discord não terminou a tempo')), 2 * 60_000);
      const finish = (err, code) => {
        clearTimeout(timer);
        sock.destroy();
        err ? reject(err) : resolve(code);
      };
      let buf = Buffer.alloc(0);
      sock.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        while (buf.length >= 8 && buf.length >= 8 + buf.readInt32LE(4)) {
          const op = buf.readInt32LE(0);
          const msg = JSON.parse(buf.subarray(8, 8 + buf.readInt32LE(4)).toString());
          buf = buf.subarray(8 + buf.readInt32LE(4));
          if (op === 2) return finish(new Error(msg.message ?? 'o Discord fechou a conexão'));
          if (msg.evt === 'READY') send(1, { cmd: 'AUTHORIZE', args: { client_id: clientId, scopes: ['identify'] }, nonce: randomBytes(8).toString('hex') });
          else if (msg.evt === 'ERROR') return finish(new Error(/access_denied|cancel/i.test(msg.data?.message) ? 'recusado' : msg.data?.message ?? 'erro no Discord'));
          else if (msg.cmd === 'AUTHORIZE') return finish(null, msg.data.code);
        }
      });
      sock.on('error', (e) => finish(e));
      sock.on('close', () => finish(new Error('o Discord fechou a conexão')));
      send(0, { v: 1, client_id: clientId });
    });
  })();
}

ipcMain.handle('discord-login', async (_, server, clientId) => {
  const code = await discordAuthorize(clientId);
  const res = await fetch(new URL('/auth/discord', server), { method: 'POST', body: JSON.stringify({ code }) });
  if (!res.ok) throw new Error(`o servidor não confirmou a conta (${res.status})`);
  return (await res.json()).session;
});

// Nome no servidor e call atual de quem está logado.
ipcMain.handle('me', async (_, server, password, session) => {
  const res = await fetch(new URL('/me', server), { headers: { Authorization: `Bearer ${password}`, 'X-Session': session } });
  if (res.status === 401) throw new Error('senha');
  if (res.status === 403) throw new Error('sessao');
  if (res.status === 404) throw new Error('discord');
  if (!res.ok) throw new Error(`servidor respondeu ${res.status}`);
  return res.json();
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
  if (!capture) return { audio: false };
  try {
    startCapture(await findDiscordRoot());
  } catch (e) {
    // Sem som é melhor do que sem transmissão.
    log('erro', 'não consegui iniciar a captura de som, seguindo só com vídeo:', e);
    return { audio: false };
  }
  watchTimer = setInterval(checkDiscord, 5000);
  return { audio: true };
});

ipcMain.handle('audio-stop', () => {
  clearInterval(watchTimer);
  if (capturing) capture.stop();
  capturing = false;
  excludedPid = null;
});

app.whenReady().then(() => {
  // Pelo id direto: sem getSources (que trava a janela) e funciona com a janela que acabou de sair do minimizado.
  session.defaultSession.setDisplayMediaRequestHandler((_, callback) => callback({ video: { id: selectedId, name: selectedId } }));

  win = new BrowserWindow({
    width: WIDTH,
    height: Math.min(HEIGHT, screen.getPrimaryDisplay().workAreaSize.height), // cabe em telas baixas (notebook 768p)
    // Tamanho fixo: sem redimensionar, maximizar ou tela cheia (F11 incluso).
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    frame: false, // barra de título própria (index.html)
    icon: path.join(__dirname, 'build', 'icon.png'), // barra de tarefas (sem isso, rodando do código, aparece o do Electron)
    backgroundColor: '#000000',
    autoHideMenuBar: true,
    title: 'laele viewer',
    // Sem isso o Chromium freia os timers com a janela minimizada/atrás de outras e o vídeo para de ser enviado.
    webPreferences: { preload: path.join(__dirname, 'preload.js'), backgroundThrottling: false },
  });
  win.loadFile('index.html');
  win.on('focus', () => (otherList = null));
  createTray();
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    hideToTray();
  });

  // Erros e avisos do console da página também vão para o log.
  win.webContents.on('console-message', ({ level, message }) => {
    if (level === 'error') log('erro', 'página:', message);
    else if (level === 'warning') log('aviso', 'página:', message);
  });
  win.webContents.on('render-process-gone', (_, details) => log('erro', 'a página travou/fechou:', details));
});

// A janela só fecha de verdade ao sair pelo menu da bandeja (app.quit não emite window-all-closed).
app.on('will-quit', () => {
  if (capturing) capture.stop();
  winHelper?.kill();
  log('info', 'app fechado');
});
