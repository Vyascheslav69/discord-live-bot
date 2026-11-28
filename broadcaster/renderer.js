const $ = (id) => document.getElementById(id);
const setupForm = $('setup');
const app = $('app');
const statusEl = $('status');
const sourcesEl = $('sources');
const toggleBtn = $('toggle');

// Protocolo com o relay (server/relay.js): [tipo u8][timestamp float64 LE µs][dados]
const VIDEO_KEY = 0;
const VIDEO_DELTA = 1;
const AUDIO = 2;
// Qualidade: altura escolhida -> largura máxima (16:9) e taxa de bits a 30 fps (60 fps usa 1,5x).
const MAX_WIDTH = { 1080: 1920, 720: 1280, 480: 854 };
const BITRATE = { 1080: 4_000_000, 720: 2_500_000, 480: 1_200_000 };

let ws = null;
let selectedId = null;
let captured = null;
let lastFrame = null;
let pump = null;
let videoEncoder = null;
let audioEncoder = null;
let audioQueue = [];
let audioTime = 0; // amostras (por canal) já enviadas
let audioConfig;
let audioInfo = {};
let startedAt = 0;

/* ---------- dados salvos ---------- */

const settings = () => ({
  name: localStorage.getItem('name') ?? '', // só em servidor sem login do Discord
  server: localStorage.getItem('server') ?? 'http://localhost:5173',
  password: localStorage.getItem('password') ?? '',
  session: localStorage.getItem('session') ?? '', // login do Discord, assinado pelo relay
});
let askName = false; // o servidor não tem login do Discord: o nome é digitado
let me = null; // { name } da conta do Discord vinculada

// Erro de um ipcRenderer.invoke sem o prefixo "Error invoking remote method …".
const ipcError = (e) => e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

function showSetup(error = '') {
  const s = settings();
  $('name').value = s.name;
  $('server').value = s.server;
  $('password').value = s.password;
  $('name-field').hidden = !askName;
  // Conta já vinculada: trocar endereço ou senha não pede o vínculo de novo.
  $('linked').hidden = !s.session;
  $('linked-name').textContent = me?.name ?? '';
  $('setup-submit').textContent = askName || s.session ? 'Salvar' : 'Vincular conta do Discord';
  $('setup-error').textContent = error;
  app.hidden = true;
  setupForm.hidden = false;
  $(askName && !s.name ? 'name' : 'password').focus();
}

function showApp() {
  const s = settings();
  $('who').textContent = s.session ? me?.name ?? '' : s.name;
  setupForm.hidden = true;
  app.hidden = false;
  loadSources();
  refreshMe();
  // Mac: sem a permissão "Gravação de Tela" as telas aparecem pretas e nada é capturado.
  window.capture.screenAccess().then((status) => {
    if (status === 'denied' || status === 'restricted') {
      setState('error', 'Libere o laele viewer em Ajustes do Sistema → Privacidade e Segurança → Gravação de Tela e abra o app de novo.');
    }
  });
}

setupForm.onsubmit = async (e) => {
  e.preventDefault();
  const server = $('server').value.trim().replace(/\/+$/, '');
  const submit = $('setup-submit');
  localStorage.setItem('server', server);
  localStorage.setItem('password', $('password').value);
  submit.disabled = true;
  try {
    const { discord, clientId } = await window.capture.serverInfo(server);
    if (!discord) {
      const name = $('name').value.trim();
      if (!askName || !name) {
        askName = true;
        return showSetup('Este servidor não tem login do Discord: escreva seu nome.');
      }
      localStorage.setItem('name', name);
      localStorage.removeItem('session');
      return showApp();
    }
    askName = false;
    if (settings().session) return showApp();
    if (!clientId) throw new Error('bot-fora'); // bot ainda conectando ou caído // já vinculada (se o servidor não aceitar a sessão, ele pede de novo)
    $('setup-error').textContent = 'Clique em "Autorizar" na janela que abriu no Discord…';
    localStorage.setItem('session', await window.capture.discordLogin(server, clientId));
    me = null;
    showApp();
  } catch (error) {
    const msg = ipcError(error);
    const texts = {
      servidor: `Não achei o servidor em ${server}. Ele está ligado?`,
      'discord-fechado': 'Abra o Discord neste PC (o app do Discord, não o site) e tente de novo.',
      'discord-admin': 'O Discord está aberto como administrador e o Windows bloqueia a conexão. Feche o Discord e abra de novo normalmente (sem "Executar como administrador").',
      recusado: 'A autorização foi recusada no Discord.',
      'bot-fora': 'O bot do Discord está fora do ar no servidor. Tente de novo em instantes.',
    };
    $('setup-error').textContent = texts[msg] ?? `Não deu para vincular: ${msg}`;
  } finally {
    submit.disabled = false;
  }
};

$('edit').onclick = () => showSetup();
$('unlink').onclick = () => {
  localStorage.removeItem('session');
  me = null;
  showSetup();
};
$('logs').onclick = () => window.capture.openLogs();

// Vai para o arquivo de log (erros do console da página já são registrados pelo processo principal).
const log = (level, ...parts) => window.capture.log(level, parts.join(' '));

/* ---------- conta do Discord: nome no servidor ---------- */

async function refreshMe() {
  const { server, password, session } = settings();
  if (!session) return;
  try {
    me = await window.capture.me(server, password, session);
    $('who').textContent = me.name;
  } catch (e) {
    const code = ipcError(e);
    if (code === 'sessao') {
      localStorage.removeItem('session');
      return showSetup('Vincule sua conta do Discord de novo.');
    }
    // Fora dos servidores do bot ou bot fora do ar: o erro aparece ao transmitir.
    if (code !== 'discord') log('aviso', 'não consegui ver a conta do Discord:', code);
  }
}

// O apelido pode mudar no servidor: confere a cada 5 s com a janela em primeiro plano.
setInterval(() => !app.hidden && document.hasFocus() && refreshMe(), 5000);

/* ---------- fontes ---------- */

let loadingSources = false;
const sourceLabel = (s) => (s.minimized ? `${s.name} (minimizada)` : s.name);
const setThumb = (img, thumb) => (thumb ? (img.src = thumb) : img.removeAttribute('src'));

async function loadSources() {
  if (loadingSources) return;
  loadingSources = true;
  let sources;
  try {
    sources = await window.capture.listSources();
  } finally {
    loadingSources = false;
  }
  if (!sources.some((s) => s.id === selectedId)) selectedId = sources[0]?.id ?? null;
  // Mesma lista: só renova miniaturas e nomes (sem recriar os botões, o foco do teclado não se perde).
  const buttons = [...sourcesEl.children];
  if (buttons.length === sources.length && buttons.every((b, i) => b.dataset.id === sources[i].id)) {
    sources.forEach((s, i) => {
      buttons[i].title = s.name;
      setThumb(buttons[i].querySelector('img'), s.thumb);
      buttons[i].querySelector('span').textContent = sourceLabel(s);
      buttons[i].setAttribute('aria-checked', s.id === selectedId);
    });
    return;
  }
  sourcesEl.replaceChildren(
    ...sources.map((s) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'source';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', s.id === selectedId);
      b.dataset.id = s.id;
      b.disabled = app.dataset.state === 'connecting';
      b.title = s.name;
      const img = new Image();
      setThumb(img, s.thumb);
      img.alt = '';
      const label = document.createElement('span');
      label.textContent = sourceLabel(s);
      b.append(img, label);
      b.onclick = () => {
        if (s.id === selectedId) return;
        selectedId = s.id;
        sourcesEl.querySelectorAll('.source').forEach((el) => el.setAttribute('aria-checked', el === b));
        // Ao vivo: troca a captura sem derrubar a conexão.
        liveChange(async () => {
          await openSource();
          await goLive();
        });
      };
      return b;
    })
  );
}

// Lista viva: atualiza a cada 1 s, só com a janela em primeiro plano.
setInterval(() => !app.hidden && document.hasFocus() && loadSources(), 1000);

/* ---------- qualidade ---------- */

const quality = () => ({ res: localStorage.getItem('res') ?? '1080', fps: Number(localStorage.getItem('fps') ?? 30) });

function renderQuality() {
  const q = quality();
  for (const [id, value] of [['res', q.res], ['fps', String(q.fps)]]) {
    $(id).querySelectorAll('button').forEach((b) => b.setAttribute('aria-checked', b.dataset.value === value));
  }
}

for (const id of ['res', 'fps']) {
  $(id).querySelectorAll('button').forEach((b) => {
    b.onclick = () => {
      localStorage.setItem(id, b.dataset.value);
      renderQuality();
      liveChange(goLive);
    };
  });
}
renderQuality();

/* ---------- estado ---------- */

// Bipe curto ao ligar (sobe) e ao desligar (desce) a transmissão, sem arquivo de som.
// Toca só com a captura de som desligada: ela exclui o Discord e não consegue excluir o app junto.
const beepCtx = new AudioContext();
function beep(up) {
  const t = beepCtx.currentTime;
  const osc = beepCtx.createOscillator();
  const gain = beepCtx.createGain();
  osc.frequency.setValueAtTime(up ? 660 : 880, t);
  osc.frequency.setValueAtTime(up ? 880 : 660, t + 0.09);
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(0.2, t + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
  osc.connect(gain).connect(beepCtx.destination);
  osc.start(t);
  osc.stop(t + 0.21);
}

function setState(state, text) {
  const prev = app.dataset.state;
  if (state !== prev || state === 'error') log(state === 'error' ? 'erro' : 'info', `${state}: ${text}`);
  if (prev === 'live' && state !== 'live') beep(false); // stop() já desligou a captura de som
  app.dataset.state = state;
  statusEl.textContent = text;
  $('viewers').hidden = state !== 'live';
  const busy = state === 'connecting' || state === 'live';
  $('edit').disabled = busy;
  // Ao vivo dá para trocar tela e qualidade; só durante a conexão fica travado.
  const connecting = state === 'connecting';
  sourcesEl.querySelectorAll('button').forEach((b) => (b.disabled = connecting));
  document.querySelectorAll('.seg button').forEach((b) => (b.disabled = connecting));
  toggleBtn.disabled = state === 'connecting';
  $('toggle-label').textContent = state === 'live' ? 'Parar transmissão' : state === 'connecting' ? 'Conectando…' : 'Transmitir';
}

/* ---------- envio ---------- */

let skipUntilKey = false;
let forceKey = false;

function sendChunk(kind, chunk) {
  if (ws?.readyState !== WebSocket.OPEN) return;
  if (kind !== AUDIO) {
    // Upload engasgado: descarta vídeo (sem acumular atraso) e pede um quadro-chave para recomeçar limpo.
    if (ws.bufferedAmount > 1_500_000) {
      skipUntilKey = forceKey = true;
      return;
    }
    if (kind === VIDEO_DELTA && skipUntilKey) return;
    if (kind === VIDEO_KEY) skipUntilKey = false;
  }
  const msg = new Uint8Array(9 + chunk.byteLength);
  msg[0] = kind;
  new DataView(msg.buffer).setFloat64(1, chunk.timestamp, true);
  chunk.copyTo(msg.subarray(9));
  ws.send(msg);
}

// Primeiro codec suportado: H.264 nível 4.2 (aceleração por hardware na maioria dos PCs, até 1080p60), senão VP8.
// Se o PC não aguenta 60 fps, cai para 30.
// Alguém assistindo num Discord sem H.264 pediu (pelo relay): VP8 até o fim desta transmissão.
let avoidH264 = false;
async function pickVideoConfig(width, height, res, fps) {
  for (const framerate of fps === 60 ? [60, 30] : [30]) {
    for (const codec of avoidH264 ? ['vp8'] : ['avc1.64002A', 'avc1.4D402A', 'avc1.42E02A', 'vp8']) {
      const config = {
        codec,
        width,
        height,
        bitrate: BITRATE[res] * (framerate === 60 ? 1.5 : 1),
        framerate,
        latencyMode: 'realtime',
        ...(codec.startsWith('avc1') && { avc: { format: 'annexb' } }),
      };
      if ((await VideoEncoder.isConfigSupported(config)).supported) return config;
    }
  }
  throw new Error('este PC não consegue codificar vídeo (H.264/VP8)');
}

// Cabe na resolução escolhida mantendo a proporção da tela; nunca aumenta. Codificadores pedem dimensões pares.
function fitSize(w, h, res) {
  const scale = Math.min(1, MAX_WIDTH[res] / w, Number(res) / h);
  return [Math.round((w * scale) / 2) * 2, Math.round((h * scale) / 2) * 2];
}

function connect(server, name, password) {
  return new Promise((resolve, reject) => {
    const url = server.replace(/^http/, 'ws') + '/ws/publish';
    const sock = new WebSocket(url);
    sock.binaryType = 'arraybuffer';
    const timer = setTimeout(() => (sock.close(), reject(new Error('servidor'))), 8000);
    // Com a conta vinculada o relay tira o nome e a call da sessão (e o bot sempre avisa na call).
    const { session } = settings();
    sock.onopen = () => sock.send(JSON.stringify(session ? { session, password } : { name, password }));
    sock.onerror = () => (clearTimeout(timer), reject(new Error('servidor')));
    sock.onmessage = (e) => {
      clearTimeout(timer);
      const msg = JSON.parse(e.data);
      if (msg.type === 'ok') resolve(sock);
      else reject(new Error(msg.code));
    };
  });
}

/* ---------- áudio ---------- */

// PCM16 estéreo 48 kHz vindo do processo principal (áudio do PC menos o Discord).
window.capture.onAudio((chunk) => {
  if (!audioEncoder) return;
  audioQueue.push(new Int16Array(chunk.slice().buffer));
  // Guarda no máximo 200 ms: se acumular mais, descarta o mais antigo para não criar atraso.
  while (audioQueue.reduce((n, c) => n + c.length, 0) > 2 * 9600) audioQueue.shift();
});

// Codifica exatamente o tempo decorrido desde o início: som real da fila e silêncio onde faltar.
// O loopback não entrega trechos silenciosos e chega em rajadas; contar só as amostras faria o áudio adiantar ou ter buracos.
function pumpAudio(audioStart) {
  const due = Math.round(((performance.now() - audioStart) / 1000) * 48000) - audioTime;
  if (due <= 0) return;
  const out = new Int16Array(due * 2);
  let filled = 0;
  while (filled < out.length && audioQueue.length) {
    const head = audioQueue[0];
    const n = Math.min(head.length, out.length - filled);
    out.set(head.subarray(0, n), filled);
    filled += n;
    if (n === head.length) audioQueue.shift();
    else audioQueue[0] = head.subarray(n);
  }
  const data = new AudioData({
    format: 's16',
    sampleRate: 48000,
    numberOfChannels: 2,
    numberOfFrames: due,
    timestamp: (audioTime / 48000) * 1e6,
    data: out,
  });
  audioEncoder.encode(data);
  data.close();
  audioTime += due;
}

/* ---------- transmissão ---------- */

toggleBtn.onclick = () => (ws ? stop() : start());

// Captura a tela/janela escolhida; numa troca ao vivo substitui a anterior.
async function openSource() {
  await window.capture.selectSource(selectedId);
  const track = (await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: quality().fps }, audio: false })).getVideoTracks()[0];
  if (!ws) return track.stop(); // parou enquanto abria
  const old = captured;
  captured = track;
  if (old) {
    old.onended = null;
    old.stop();
  }
  // Se a janela capturada fechar, encerra a transmissão.
  track.onended = () => stop();

  // Com a tela parada o Chrome quase não manda quadros: guardamos o último e codificamos a quadros/s constantes.
  const reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
  (async () => {
    for (;;) {
      const { value, done } = await reader.read().catch(() => ({ done: true }));
      if (done) return;
      if (track !== captured) return value.close(); // captura trocada
      lastFrame?.close();
      lastFrame = value;
    }
  })();
}

// (Re)cria o codificador de vídeo para a captura e a qualidade atuais. Numa troca, a config nova faz quem assiste
// recriar o decodificador e esperar o próximo quadro-chave; a conexão e o áudio seguem.
async function goLive() {
  const { res, fps: wantedFps } = quality();
  await captured.applyConstraints({ frameRate: wantedFps }).catch(() => {});
  const { width: cw = 1920, height: ch = 1080 } = captured.getSettings();
  const [width, height] = fitSize(cw, ch, res);
  const videoConfig = await pickVideoConfig(width, height, res, wantedFps);
  if (!ws) return;
  const fps = videoConfig.framerate;
  const keyframeEvery = fps * 2; // quem entra no meio espera no máximo 2 s
  log('info', `transmitindo para ${settings().server}: tela ${cw}x${ch} -> ${width}x${height} ${fps} fps, ${videoConfig.codec}, ${videoConfig.bitrate / 1e6} Mbps`);

  clearInterval(pump);
  // close() descarta o que o codificador antigo ainda tinha na fila (quadros do tamanho velho).
  if (videoEncoder?.state === 'configured') videoEncoder.close();
  videoEncoder = new VideoEncoder({
    output: (chunk) => sendChunk(chunk.type === 'key' ? VIDEO_KEY : VIDEO_DELTA, chunk),
    error: (e) => fail(`erro no vídeo: ${e.message}`),
  });
  videoEncoder.configure(videoConfig);
  ws.send(JSON.stringify({ type: 'config', video: { codec: videoConfig.codec }, audio: audioConfig }));

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  let frameNo = 0;
  pump = setInterval(() => {
    if (audioEncoder) pumpAudio(startedAt);
    if (!lastFrame) return;
    // Codificador atrasado: pula este quadro em vez de acumular fila.
    if (videoEncoder.encodeQueueSize > 2) return;
    ctx.drawImage(lastFrame, 0, 0, width, height);
    const frame = new VideoFrame(canvas, { timestamp: (performance.now() - startedAt) * 1000 });
    const keyFrame = forceKey || frameNo++ % keyframeEvery === 0;
    forceKey = false;
    videoEncoder.encode(frame, { keyFrame });
    frame.close();
  }, 1000 / fps);

  const parts = [`Ao vivo em ${height}p ${fps} fps.`];
  if (fps < wantedFps) parts.push('Este PC não aguenta 60 fps, então ficou em 30.');
  if (!audioInfo.hasAudio) parts.push('Sem som: no Mac vai só o vídeo.');
  if (avoidH264) parts.push('Em VP8: alguém não consegue ver o formato normal.');
  setState('live', parts.join(' '));
}

// Trocas ao vivo (tela, qualidade) uma de cada vez; se falhar, encerra com a mensagem de erro.
let changing = Promise.resolve();
function liveChange(fn) {
  changing = changing.then(async () => {
    if (app.dataset.state !== 'live') return;
    try {
      await fn();
    } catch (err) {
      log('erro', 'falha ao trocar durante a transmissão:', err.stack ?? err.message);
      if (ws) fail(err.message);
    }
  });
}

async function start() {
  const { name, server, password } = settings();
  if (!selectedId) return setState('error', 'Escolha uma tela ou janela para mostrar.');

  setState('connecting', 'Conectando ao servidor…');
  try {
    ws = await connect(server, name, password);
    showViewers(0);
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === 'viewers') showViewers(msg.count);
      if (msg.type === 'evitar-h264' && !avoidH264) {
        log('info', 'alguém não consegue ver H.264: trocando para VP8');
        avoidH264 = true;
        liveChange(goLive);
      }
    };
    ws.onclose = (e) => {
      if (ws) log('erro', `conexão com o servidor caiu (código ${e.code}${e.reason ? `, ${e.reason}` : ''})`);
      if (!ws) return;
      stop();
      setState('error', `A conexão com o servidor caiu. Ele ainda está ligado em ${server}?`);
    };

    await openSource();
    if (!ws) return;
    beep(true);
    await new Promise((r) => setTimeout(r, 300)); // o bipe termina antes de a captura de som começar

    // No Mac não há captura de som: a transmissão vai só com vídeo (a config sai sem "audio").
    const { audio: hasAudio } = await window.capture.startAudio();
    audioInfo = { hasAudio };
    audioConfig = undefined;
    if (hasAudio) {
      audioEncoder = new AudioEncoder({
        output: (chunk) => sendChunk(AUDIO, chunk),
        error: (e) => fail(`erro no áudio: ${e.message}`),
      });
      audioConfig = { codec: 'opus', sampleRate: 48000, numberOfChannels: 2, bitrate: 128_000 };
      audioEncoder.configure(audioConfig);
    }

    audioQueue = [];
    audioTime = 0;
    startedAt = performance.now();
    await goLive();
  } catch (err) {
    const msg = err.message;
    log('erro', 'falha ao iniciar a transmissão:', err.stack ?? msg);
    stop();
    if (msg === 'senha') return showSetup('Senha errada. Confira com quem cuida do servidor.');
    if (msg === 'bloqueado') return showSetup('Muitas senhas erradas seguidas. Espere 10 minutos e tente de novo.');
    if (msg === 'nome') {
      const who = settings().session ? me?.name ?? 'você' : name;
      return setState('error', `Já tem alguém transmitindo como ${who}.${settings().session ? '' : ' Troque seu nome em "Alterar endereço ou senha".'}`);
    }
    if (msg === 'sessao') {
      localStorage.removeItem('session');
      return showSetup('Este servidor pede a conta do Discord vinculada.');
    }
    if (msg === 'discord') return setState('error', 'Sua conta do Discord não está em nenhum servidor do bot (ou o bot está fora do ar).');
    if (msg === 'servidor') return setState('error', `Não achei o servidor em ${server}. Ele está ligado? O endereço do túnel mudou?`);
    setState('error', `Não deu para transmitir: ${msg}`);
  }
}

function showViewers(n) {
  $('viewers-text').textContent = n === 0 ? 'Ninguém assistindo ainda' : n === 1 ? '1 pessoa assistindo' : `${n} pessoas assistindo`;
}

function fail(text) {
  stop();
  setState('error', `Não deu para transmitir: ${text}`);
}

function stop() {
  const sock = ws;
  ws = null;
  sock?.close();
  window.capture.stopAudio();
  clearInterval(pump);
  for (const enc of [videoEncoder, audioEncoder]) if (enc?.state === 'configured') enc.close();
  videoEncoder = audioEncoder = null;
  audioQueue = [];
  lastFrame?.close();
  lastFrame = null;
  captured?.stop();
  captured = null;
  skipUntilKey = forceKey = false;
  avoidH264 = false;
  setState('idle', 'Transmissão encerrada');
}

/* ---------- barra da janela, versão e atualização ---------- */

$('minimize').onclick = () => window.capture.windowAction('minimize');
$('close').onclick = () => window.capture.windowAction('close');

const aboutBtn = $('about');
const aboutPanel = $('about-panel');
const updateBtn = $('update');
const updateStatus = $('update-status');
window.capture.version().then((v) => ($('version').textContent = v));

async function checkUpdate() {
  updateStatus.textContent = 'Procurando atualização…';
  updateBtn.hidden = true;
  try {
    const { latest, newer } = await window.capture.checkUpdate();
    updateStatus.textContent = newer ? `Versão ${latest} disponível.` : 'Você está na versão mais recente.';
    updateBtn.hidden = !newer;
    $('update-dot').hidden = !newer;
  } catch (e) {
    log('aviso', 'não consegui procurar atualização:', e.message);
    updateStatus.textContent = 'Não consegui procurar atualização. Confira a internet.';
  }
}
checkUpdate(); // ao abrir o app: acende o ponto no botão se houver versão nova

function toggleAbout(open) {
  aboutPanel.hidden = !open;
  aboutBtn.setAttribute('aria-expanded', open);
  if (open) checkUpdate();
}
aboutBtn.onclick = () => toggleAbout(aboutPanel.hidden);
document.addEventListener('pointerdown', (e) => !aboutPanel.hidden && !e.target.closest('.about') && toggleAbout(false));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !aboutPanel.hidden) {
    toggleAbout(false);
    aboutBtn.focus();
  }
});

updateBtn.onclick = async () => {
  // O app fecha para o instalador rodar: a transmissão cairia.
  if (ws) return (updateStatus.textContent = 'Pare a transmissão antes de atualizar.');
  updateBtn.disabled = true;
  updateStatus.textContent = 'Baixando…';
  try {
    if ((await window.capture.installUpdate()) === 'browser') {
      updateStatus.textContent = 'O download abriu no navegador. Instale por cima da versão atual.';
      updateBtn.disabled = false;
    }
  } catch (e) {
    log('erro', 'falha ao atualizar:', e.message);
    updateStatus.textContent = `Não deu para atualizar: ${e.message}`;
    updateBtn.disabled = false;
  }
};
window.capture.onUpdateProgress((pct) => (updateStatus.textContent = `Baixando… ${pct}%`));

if (settings().password && (settings().session || settings().name)) showApp();
else showSetup();
