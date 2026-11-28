import { DiscordSDK } from '@discord/embedded-app-sdk';
import '@fontsource-variable/unbounded';
import '@fontsource-variable/figtree';

// Modo em que o Discord mostra a atividade (em foco, janelinha ou quadrado da grade): vai para o log do relay com o tamanho.
let layoutMode = '';
let sizeSent = false;
// Servidor do Discord onde a atividade foi aberta: a lista mostra só quem transmite dele (fora do Discord, todos).
const guildId = new URLSearchParams(location.search).get('guild_id');

// Fora do Discord (navegador comum) não há frame_id e o SDK lançaria erro.
if (new URLSearchParams(location.search).has('frame_id')) {
  const sdk = new DiscordSDK(import.meta.env.VITE_DISCORD_CLIENT_ID);
  sdk
    .ready()
    .then(() =>
      sdk.subscribe('ACTIVITY_LAYOUT_MODE_UPDATE', ({ layout_mode }) => {
        layoutMode = ['foco', 'janelinha', 'grade'][layout_mode] ?? `modo${layout_mode}`;
        sizeSent = false;
        // Janelinha ou quadrado da grade: só o vídeo, sem barras.
        document.body.classList.toggle('compact', layout_mode !== 0);
      })
    )
    .catch((e) => console.warn('modo de exibição do Discord:', e));
}
addEventListener('resize', () => (sizeSent = false));

const stage = document.getElementById('stage');
const channelsEl = document.getElementById('channels');
const tpl = document.getElementById('slot-tpl');

// O relay usa o nome em base64url como id da transmissão.
function decodeName(id) {
  try {
    const bin = atob(id.replace(/-/g, '+').replace(/_/g, '/'));
    return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  } catch {
    return id;
  }
}

/* ---------- player (WebSocket + WebCodecs) ---------- */

// Dentro do Discord o WebRTC é desligado e o HLS fica com segundos de atraso: o vídeo chega já codificado
// por WebSocket (permitido pelo proxy do Discord) e é decodificado aqui. Protocolo em server/relay.js.
const VIDEO_KEY = 0;
const AUDIO = 2;
// O Discord no PC às vezes diz que aceita H.264 e recusa ao configurar (sem decodificação por hardware):
// tenta sem a opção de baixa latência e depois por software antes de desistir.
const VIDEO_OPTIONS = [{ optimizeForLatency: true }, {}, { hardwareAcceleration: 'prefer-software' }];

// Um AudioContext para a página; o navegador só libera o som depois de um clique.
const audioCtx = new AudioContext({ latencyHint: 'interactive', sampleRate: 48000 });
document.addEventListener('pointerdown', () => audioCtx.resume(), { capture: true });

// Placa de vídeo que o Discord está usando ("SwiftShader" ou parecido = sem acesso à placa): vai para o log do relay
// quando o aparelho não decodifica H.264.
function gpuName() {
  try {
    const gl = document.createElement('canvas').getContext('webgl');
    if (!gl) return 'sem WebGL';
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
  } catch {
    return 'desconhecida';
  }
}

function playWS(slot, id, onDrop) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws/watch/${id}`);
  ws.binaryType = 'arraybuffer';
  const ctx = slot.canvas.getContext('2d');
  let config = null;
  let video = null;
  let audio = null;
  let needKey = true;
  let stopped = false;
  let option = 0; // índice em VIDEO_OPTIONS

  let frames = 0;
  let switchTimer = null;
  // Recusas do decodificador vão para o log do relay (ajuda a entender aparelhos que não mostram vídeo).
  const send = (msg) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(msg));
  const report = (text) => send({ type: 'diag', text });
  const where = new URLSearchParams(location.search).get('platform') ?? 'navegador';

  const setupVideo = () => {
    video = new VideoDecoder({
      output: (frame) => {
        if (slot.canvas.width !== frame.displayWidth || slot.canvas.height !== frame.displayHeight) {
          slot.canvas.width = frame.displayWidth;
          slot.canvas.height = frame.displayHeight;
        }
        ctx.drawImage(frame, 0, 0);
        frame.close();
        if (!frames++ && option > 0) report(`funcionou com ${JSON.stringify(VIDEO_OPTIONS[option])} (${where})`);
        slot.onFrame();
      },
      // Antes da primeira imagem, erro = o aparelho recusou esta configuração: tenta a próxima e, sem mais
      // nenhuma, desiste (recriar sem parar travava o processador). Depois, erro = dado corrompido: recria.
      error: (e) => {
        if (stopped) return;
        if (!frames) {
          report(`decodificador recusou ${config.video.codec} ${JSON.stringify(VIDEO_OPTIONS[option])} (${where}): ${e.message}`);
          if (++option >= VIDEO_OPTIONS.length) return cannotDecode(e.message);
        }
        needKey = true;
        setupVideo();
      },
    });
    video.configure({ codec: config.video.codec, ...VIDEO_OPTIONS[option] });
  };

  // Nenhuma configuração serviu. H.264: pede VP8 a quem transmite (o laele viewer troca ao vivo e a config nova chega
  // aqui); se não vier em 10 s (laele viewer antigo), desiste com a mensagem.
  const cannotDecode = (reason) => {
    const codec = config.video.codec;
    if (!codec.startsWith('avc1')) return slot.showMessage(`Este aparelho não consegue mostrar vídeo ${codec} (${reason}).`);
    report(`sem H.264: placa ${gpuName()}, ${where}, ${navigator.userAgent}`);
    send({ type: 'sem-h264' });
    slot.setNotice('loading', 'Ajustando o vídeo para este aparelho', 'Pedindo a quem transmite um formato que funcione aqui…', slot.path);
    switchTimer = setTimeout(() => {
      slot.showMessage(`Este aparelho não consegue mostrar vídeo H.264. Quem transmite precisa atualizar o laele viewer.`);
    }, 10_000);
  };

  const setupAudio = () => {
    audio = null;
    if (!config.audio) return; // transmissão sem som (laele viewer no Mac)
    audio = new AudioDecoder({ output: (data) => slot.playAudio(data), error: () => {} });
    audio.configure(config.audio);
  };

  ws.onmessage = async (e) => {
    if (typeof e.data === 'string') {
      const msg = JSON.parse(e.data);
      if (msg.type === 'ping') return slot.showPing(msg.x, msg.y, msg.hue);
      config = msg;
      clearTimeout(switchTimer);
      const ok = await VideoDecoder.isConfigSupported({ codec: config.video.codec });
      if (!ok.supported) {
        report(`codec ${config.video.codec} não suportado (${where}, ${navigator.userAgent})`);
        return cannotDecode('não suportado');
      }
      for (const d of [video, audio]) if (d && d.state !== 'closed') d.close();
      needKey = true;
      option = 0;
      frames = 0;
      setupVideo();
      setupAudio();
      return;
    }
    const kind = new Uint8Array(e.data, 0, 1)[0];
    const timestamp = new DataView(e.data).getFloat64(1, true);
    const data = new Uint8Array(e.data, 9);
    if (kind === AUDIO) {
      if (audio?.state === 'configured') audio.decode(new EncodedAudioChunk({ type: 'key', timestamp, data }));
      return;
    }
    if (video?.state !== 'configured') return;
    // Atrasado: descarta deltas até o próximo quadro-chave (o atraso não acumula).
    if (kind !== VIDEO_KEY && (needKey || video.decodeQueueSize > 3)) {
      if (!needKey) slot.onLag();
      needKey = true;
      return;
    }
    needKey = false;
    video.decode(new EncodedVideoChunk({ type: kind === VIDEO_KEY ? 'key' : 'delta', timestamp, data }));
  };
  ws.onclose = (e) => !stopped && onDrop(e.code);

  return {
    ping(x, y) {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping', x, y, hue: myHue }));
    },
    stop() {
      stopped = true;
      clearTimeout(switchTimer);
      ws.close();
      for (const d of [video, audio]) if (d && d.state !== 'closed') d.close();
    },
  };
}

/* ---------- telas ---------- */

let live = []; // ids transmitindo agora
let info = new Map(); // id -> { viewers, avatar } (da lista do relay)
let focused = 0;
// Cor dos pontos que este espectador aponta na tela.
const myHue = Math.floor(Math.random() * 360);

// Foto do Discord no lugar da bolinha, só depois que carregou (se falhar, fica a bolinha).
// shortcut: uma falha não é tentada de novo até recarregar a atividade.
const avatarLoaded = new Map(); // id -> true (carregou) | false (carregando ou falhou)
function setAvatar(el, id) {
  if (info.get(id)?.avatar && !avatarLoaded.has(id)) {
    avatarLoaded.set(id, false);
    const img = new Image();
    img.onload = () => (avatarLoaded.set(id, true), updateInfo());
    img.src = `/avatar/${id}`;
  }
  const has = !!info.get(id)?.avatar && avatarLoaded.get(id) === true;
  el.classList.toggle('has-avatar', has);
  el.style.backgroundImage = has ? `url(/avatar/${id})` : '';
}

function setCount(el, id) {
  const n = info.get(id)?.viewers;
  el.hidden = !n;
  if (!n) return;
  el.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></svg>';
  el.append(String(n));
  el.title = n === 1 ? '1 pessoa assistindo' : `${n} pessoas assistindo`;
}

// Parte do canvas onde o vídeo aparece de fato (object-fit: contain deixa faixas pretas).
function videoBox(canvas) {
  const r = canvas.getBoundingClientRect();
  const scale = Math.min(r.width / canvas.width, r.height / canvas.height);
  const width = canvas.width * scale;
  const height = canvas.height * scale;
  return { r, width, height, x: (r.width - width) / 2, y: (r.height - height) / 2 };
}

function createSlot(index) {
  const el = tpl.content.firstElementChild.cloneNode(true);
  const slot = {
    el,
    canvas: el.querySelector('canvas'),
    name: el.querySelector('.name'),
    dot: el.querySelector('.bar .dot'),
    count: el.querySelector('.bar .count'),
    notice: el.querySelector('.notice'),
    signal: el.querySelector('.signal'),
    pings: el.querySelector('.pings'),
    dropped: false,
    lastFrameAt: 0,
    lagUntil: 0,
    mute: el.querySelector('.mute'),
    volume: el.querySelector('.volume'),
    path: null,
    player: null,
    token: 0,
    lastVolume: 0.8,
    volumeValue: 0,
    gain: audioCtx.createGain(),
    nextTime: 0,
  };
  slot.gain.gain.value = 0;
  slot.gain.connect(audioCtx.destination);

  slot.onFrame = () => {
    slot.lastFrameAt = performance.now();
    if (el.classList.contains('live') && slot.notice.hidden) return; // com aviso na tela (ex.: troca de formato), limpa
    el.classList.remove('switching');
    el.classList.add('live');
    slot.dropped = false;
    slot.setNotice(null);
  };
  slot.onLag = () => (slot.lagUntil = performance.now() + 3000);
  slot.showMessage = (text) => slot.setNotice('error', 'Não dá para mostrar esta tela', text, slot.path);

  // Aviso no meio da tela: foto (ou inicial) de quem transmite, com um anel girando enquanto conecta.
  // kind: loading | reconnecting | ended | error | info | null (some)
  slot.setNotice = (kind, title = '', sub = '', id = null) => {
    const n = slot.notice;
    n.hidden = !kind;
    if (!kind) return;
    n.dataset.kind = kind;
    n.querySelector('.title').textContent = title;
    n.querySelector('.sub').textContent = sub;
    const badge = n.querySelector('.badge');
    badge.hidden = !id;
    if (!id) return;
    setAvatar(badge, id);
    n.querySelector('.initial').textContent = [...decodeName(id).trim()][0]?.toUpperCase() ?? '';
  };

  // Alt+clique aponta um ponto do vídeo para todo mundo que assiste esta tela.
  slot.canvas.addEventListener('pointerdown', (e) => {
    if (!e.altKey || !slot.player || !el.classList.contains('live')) return;
    e.preventDefault();
    const box = videoBox(slot.canvas);
    const x = (e.clientX - box.r.left - box.x) / box.width;
    const y = (e.clientY - box.r.top - box.y) / box.height;
    if (x >= 0 && x <= 1 && y >= 0 && y <= 1) slot.player.ping(x, y);
  });
  slot.showPing = (x, y, hue) => {
    if (!el.classList.contains('live')) return;
    const box = videoBox(slot.canvas);
    const p = document.createElement('span');
    p.className = 'ping';
    p.style.left = `${box.x + x * box.width}px`;
    p.style.top = `${box.y + y * box.height}px`;
    p.style.setProperty('--hue', hue);
    slot.pings.append(p);
    setTimeout(() => p.remove(), 1600); // timer em vez de animationend: com movimento reduzido não há animação
  };

  // Toca cada pedaço de áudio logo depois do anterior, ~60 ms à frente; se escorregar, realinha (atraso não acumula).
  slot.playAudio = (data) => {
    if (slot.volumeValue === 0 || audioCtx.state !== 'running') return data.close();
    const buffer = audioCtx.createBuffer(data.numberOfChannels, data.numberOfFrames, data.sampleRate);
    for (let c = 0; c < data.numberOfChannels; c++) {
      data.copyTo(buffer.getChannelData(c), { planeIndex: c, format: 'f32-planar' });
    }
    data.close();
    const src = audioCtx.createBufferSource();
    src.buffer = buffer;
    src.connect(slot.gain);
    const now = audioCtx.currentTime;
    if (slot.nextTime < now + 0.02 || slot.nextTime > now + 0.3) slot.nextTime = now + 0.06;
    src.start(slot.nextTime);
    slot.nextTime += buffer.duration;
  };

  el.addEventListener('pointerdown', () => setFocus(index));
  el.addEventListener('focusin', () => setFocus(index));

  el.querySelector('.full').onclick = () => toggleFullscreen(slot);
  slot.canvas.addEventListener('dblclick', (e) => !e.altKey && toggleFullscreen(slot)); // dois Alt+cliques apontam, não abrem

  slot.volume.oninput = () => setVolume(slot, Number(slot.volume.value));
  slot.mute.onclick = () => setVolume(slot, slot.volumeValue === 0 ? slot.lastVolume || 0.8 : 0);
  syncSound(slot);
  stage.append(el);
  return slot;
}

function setVolume(slot, v) {
  slot.volumeValue = v;
  slot.gain.gain.value = v;
  if (v > 0) slot.lastVolume = v;
  audioCtx.resume();
  syncSound(slot);
}

function syncSound(slot) {
  const muted = slot.volumeValue === 0;
  slot.volume.value = slot.volumeValue;
  slot.el.classList.toggle('muted', muted);
  slot.mute.setAttribute('aria-label', muted ? 'Ativar som' : 'Silenciar');
  slot.el.style.setProperty('--vol', slot.volume.value);
}

const slots = [createSlot(0), createSlot(1)];

// Tela cheia de verdade quando o navegador/Discord permite; senão a tela ocupa a atividade inteira.
async function toggleFullscreen(slot) {
  if (document.fullscreenElement) return document.exitFullscreen();
  if (document.querySelector('.slot.expanded')) return setExpanded(null);
  try {
    // Alguns iframes deixam a promessa pendurada em vez de recusar: desiste após 1 s.
    await Promise.race([slot.el.requestFullscreen(), new Promise((_, no) => setTimeout(no, 1000))]);
  } catch {
    if (!document.fullscreenElement) setExpanded(slot);
  }
}

function setExpanded(slot) {
  slots.forEach((s) => s.el.classList.toggle('expanded', s === slot));
  document.body.classList.toggle('has-expanded', !!slot);
}

document.addEventListener('keydown', (e) => e.key === 'Escape' && setExpanded(null));
document.addEventListener('fullscreenchange', () =>
  slots.forEach((s) => s.el.classList.toggle('is-full', document.fullscreenElement === s.el))
);

function setFocus(index) {
  if (stage.dataset.layout === '1') index = 0;
  focused = index;
  slots.forEach((s, i) => s.el.classList.toggle('focused', i === focused));
  renderChannels();
}

function show(slot, path) {
  if (slot.path === path) return;
  slot.player?.stop();
  slot.player = null;
  slot.path = path;
  slot.token++;
  slot.dropped = false;
  slot.el.classList.remove('live');
  slot.el.classList.add('switching');
  slot.name.textContent = path ? decodeName(path) : '';
  setAvatar(slot.dot, path);
  setCount(slot.count, path);
  if (!path) {
    slot.canvas.getContext('2d').clearRect(0, 0, slot.canvas.width, slot.canvas.height);
    if (live.length) slot.setNotice('info', 'Escolha alguém na barra de cima');
    else slot.setNotice(null);
  } else {
    connect(slot);
  }
  renderChannels();
}

function connect(slot) {
  const { path } = slot;
  const token = ++slot.token;
  const current = () => slot.token === token;
  const name = decodeName(path);
  if (slot.dropped) slot.setNotice('reconnecting', 'Reconectando…', `A conexão com ${name} caiu. Tentando de novo.`, path);
  else slot.setNotice('loading', `Conectando em ${name}`, 'Esperando a primeira imagem…', path);

  const onDrop = (code) => {
    if (!current()) return;
    slot.token++; // invalida esta conexão
    slot.player?.stop();
    slot.player = null;
    slot.el.classList.remove('live');
    // 4000 = a transmissão acabou, 4004 = já não existe; o resto é queda de conexão.
    if (code === 4000 || code === 4004 || !live.includes(path)) {
      slot.setNotice('ended', `${name} parou de transmitir`, 'Escolha outra pessoa na barra de cima.', path);
    } else {
      slot.dropped = true;
      slot.setNotice('reconnecting', 'Reconectando…', `A conexão com ${name} caiu. Tentando de novo.`, path);
    }
    // Se ainda estiver na lista, o autofill() do próximo poll reconecta.
  };

  slot.player = playWS(slot, path, onDrop);
}

/* ---------- canais ---------- */

function renderChannels() {
  if (!live.length) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = 'Ninguém transmitindo agora.';
    document.body.classList.remove('idle'); // sem ninguém no ar a barra fica à vista
    channelsEl.replaceChildren(p);
    return;
  }
  const visible = stage.dataset.layout === '1' ? [slots[0]] : slots;
  channelsEl.replaceChildren(
    ...live.map((path) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'channel';
      b.setAttribute('aria-pressed', slots[focused].path === path);
      b.classList.toggle('on-screen', visible.some((s) => s.path === path));
      b.dataset.id = path;
      const dot = document.createElement('span');
      dot.className = 'dot';
      const label = document.createElement('span');
      label.textContent = decodeName(path);
      const count = document.createElement('span');
      count.className = 'count';
      b.append(dot, label, count);
      b.onclick = () => {
        const target = slots[focused];
        // Já está na outra tela: troca as duas de lugar (a mesma transmissão nunca aparece duas vezes).
        const other = visible.find((s) => s !== target && s.path === path);
        if (other) show(other, target.path);
        show(target, path);
      };
      return b;
    })
  );
  updateInfo();
}

// Foto e quantos assistem mudam sem a lista mudar: atualiza no lugar (recriar os botões repetiria a animação).
function updateInfo() {
  for (const b of channelsEl.querySelectorAll('.channel')) {
    setAvatar(b.querySelector('.dot'), b.dataset.id);
    setCount(b.querySelector('.count'), b.dataset.id);
  }
  for (const s of slots) {
    setAvatar(s.dot, s.path);
    setCount(s.count, s.path);
  }
}

function autofill() {
  const visible = stage.dataset.layout === '1' ? [slots[0]] : slots;
  for (const slot of visible) {
    if (slot.path) {
      // Voltou a transmitir: reconecta. Sumiu da lista enquanto reconectava: acabou.
      if (!slot.player && live.includes(slot.path)) connect(slot);
      else if (!slot.player && slot.dropped) {
        slot.dropped = false;
        slot.setNotice('ended', `${decodeName(slot.path)} parou de transmitir`, 'Escolha outra pessoa na barra de cima.', slot.path);
      }
      continue;
    }
    const used = visible.map((s) => s.path);
    const next = live.find((p) => !used.includes(p));
    if (next) show(slot, next);
    else if (live.length) slot.setNotice('info', 'Só tem uma transmissão no ar agora');
    else slot.setNotice(null);
  }
}

async function poll() {
  try {
    // Ao abrir e a cada mudança: tamanho e modo de exibição vão para o log do relay (ajuda a acertar o layout).
    const headers = sizeSent ? {} : { 'X-Tela': `${innerWidth}x${innerHeight}${layoutMode && ` ${layoutMode}`}` };
    sizeSent = true;
    const res = await fetch(guildId ? `/streams?guild=${encodeURIComponent(guildId)}` : '/streams', { headers });
    const list = await res.json();
    info = new Map(list.map((s) => [s.id, s]));
    const next = list.map((s) => s.id).sort();
    if (next.join() !== live.join()) {
      live = next;
      renderChannels();
    } else updateInfo();
    autofill();
  } catch {
    // servidor fora do ar: tenta de novo no próximo ciclo
  }
  setTimeout(poll, 2500);
}

/* ---------- layout ---------- */

document.querySelectorAll('#layout button').forEach((btn) => {
  btn.onclick = () => {
    stage.dataset.layout = btn.dataset.layout;
    document.querySelectorAll('#layout button').forEach((b) => b.setAttribute('aria-pressed', b === btn));
    if (btn.dataset.layout === '1') show(slots[1], null);
    setFocus(btn.dataset.layout === '2' ? 1 : 0);
    autofill();
  };
});

// Barra de nomes some depois de 3 s sem mexer o mouse (ou tocar na tela); fica à vista se ninguém transmite.
let idleTimer = null;
function wake() {
  document.body.classList.remove('idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => live.length && document.body.classList.add('idle'), 3000);
}
for (const ev of ['pointermove', 'pointerdown', 'keydown']) document.addEventListener(ev, wake, { passive: true });
wake();

// Sem imagem nova há 2 s ou quadros descartados agora há pouco: aviso discreto de conexão instável.
setInterval(() => {
  const now = performance.now();
  for (const s of slots) {
    const bad = !!s.player && s.el.classList.contains('live') && (now - s.lastFrameAt > 2000 || now < s.lagUntil);
    s.signal.hidden = !bad;
  }
}, 500);

// Versão nova publicada (o `npm start` recompila e o nome do script muda): recarrega sozinha a cada 30 s de checagem,
// para ninguém ficar preso numa versão antiga. Em `npm run dev` o script é /main.js e nunca recarrega.
const myScript = new URL(import.meta.url).pathname;
setInterval(async () => {
  try {
    const html = await (await fetch('/', { cache: 'no-store' })).text();
    if (html.includes('/assets/') && !html.includes(myScript)) location.reload();
  } catch {
    // servidor fora do ar: tenta na próxima
  }
}, 30_000);

setFocus(0);
renderChannels();
poll();
