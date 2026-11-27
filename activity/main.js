import { DiscordSDK } from '@discord/embedded-app-sdk';
import '@fontsource-variable/unbounded';
import '@fontsource-variable/figtree';

// Modo em que o Discord mostra a atividade (em foco, janelinha ou quadrado da grade): vai para o log do relay com o tamanho.
let layoutMode = '';
let sizeSent = false;

// Fora do Discord (navegador comum) não há frame_id e o SDK lançaria erro.
if (new URLSearchParams(location.search).has('frame_id')) {
  const sdk = new DiscordSDK(import.meta.env.VITE_DISCORD_CLIENT_ID);
  sdk
    .ready()
    .then(() =>
      sdk.subscribe('ACTIVITY_LAYOUT_MODE_UPDATE', ({ layout_mode }) => {
        layoutMode = ['foco', 'janelinha', 'grade'][layout_mode] ?? `modo${layout_mode}`;
        sizeSent = false;
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

// Um AudioContext para a página; o navegador só libera o som depois de um clique.
const audioCtx = new AudioContext({ latencyHint: 'interactive', sampleRate: 48000 });
document.addEventListener('pointerdown', () => audioCtx.resume(), { capture: true });

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

  const setupVideo = () => {
    video = new VideoDecoder({
      output: (frame) => {
        if (slot.canvas.width !== frame.displayWidth || slot.canvas.height !== frame.displayHeight) {
          slot.canvas.width = frame.displayWidth;
          slot.canvas.height = frame.displayHeight;
        }
        ctx.drawImage(frame, 0, 0);
        frame.close();
        slot.onFrame();
      },
      // Decodificador quebrou (dado corrompido): recria e espera o próximo quadro-chave.
      error: () => {
        if (stopped) return;
        needKey = true;
        setupVideo();
      },
    });
    video.configure({ codec: config.video.codec, optimizeForLatency: true });
  };

  const setupAudio = () => {
    audio = null;
    if (!config.audio) return; // transmissão sem som (laele viewer no Mac)
    audio = new AudioDecoder({ output: (data) => slot.playAudio(data), error: () => {} });
    audio.configure(config.audio);
  };

  ws.onmessage = async (e) => {
    if (typeof e.data === 'string') {
      config = JSON.parse(e.data);
      const ok = await VideoDecoder.isConfigSupported({ codec: config.video.codec });
      if (!ok.supported) return slot.showMessage(`Este aparelho não consegue mostrar vídeo ${config.video.codec}.`);
      for (const d of [video, audio]) if (d && d.state !== 'closed') d.close();
      needKey = true;
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
      needKey = true;
      return;
    }
    needKey = false;
    video.decode(new EncodedVideoChunk({ type: kind === VIDEO_KEY ? 'key' : 'delta', timestamp, data }));
  };
  ws.onclose = () => !stopped && onDrop();

  return {
    stop() {
      stopped = true;
      ws.close();
      for (const d of [video, audio]) if (d && d.state !== 'closed') d.close();
    },
  };
}

/* ---------- telas ---------- */

let live = []; // ids transmitindo agora
let focused = 0;

function createSlot(index) {
  const el = tpl.content.firstElementChild.cloneNode(true);
  const slot = {
    el,
    canvas: el.querySelector('canvas'),
    name: el.querySelector('.name'),
    message: el.querySelector('.message'),
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
    if (el.classList.contains('live')) return;
    el.classList.remove('switching');
    el.classList.add('live');
    slot.message.textContent = '';
  };
  slot.showMessage = (text) => (slot.message.textContent = text);

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
  slot.canvas.addEventListener('dblclick', () => toggleFullscreen(slot));

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
  slot.el.classList.remove('live');
  slot.el.classList.add('switching');
  slot.name.textContent = path ? decodeName(path) : '';
  if (!path) {
    slot.canvas.getContext('2d').clearRect(0, 0, slot.canvas.width, slot.canvas.height);
    slot.message.textContent = live.length ? 'Escolha alguém na barra de cima' : '';
  } else {
    connect(slot);
  }
  renderChannels();
}

function connect(slot) {
  const { path } = slot;
  const token = ++slot.token;
  const current = () => slot.token === token;
  slot.message.textContent = `Conectando em ${decodeName(path)}…`;

  const onDrop = () => {
    if (!current()) return;
    slot.token++; // invalida esta conexão
    slot.player?.stop();
    slot.player = null;
    slot.el.classList.remove('live');
    slot.message.textContent = live.includes(path) ? 'Reconectando…' : `${decodeName(path)} parou de transmitir`;
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
      const dot = document.createElement('span');
      dot.className = 'dot';
      const label = document.createElement('span');
      label.textContent = decodeName(path);
      b.append(dot, label);
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
}

function autofill() {
  const visible = stage.dataset.layout === '1' ? [slots[0]] : slots;
  for (const slot of visible) {
    if (slot.path) {
      // Voltou a transmitir: reconecta.
      if (!slot.player && live.includes(slot.path)) connect(slot);
      continue;
    }
    const used = visible.map((s) => s.path);
    const next = live.find((p) => !used.includes(p));
    if (next) show(slot, next);
    else slot.message.textContent = live.length ? 'Só tem uma transmissão no ar agora' : '';
  }
}

async function poll() {
  try {
    // Ao abrir e a cada mudança: tamanho e modo de exibição vão para o log do relay (ajuda a acertar o layout).
    const headers = sizeSent ? {} : { 'X-Tela': `${innerWidth}x${innerHeight}${layoutMode && ` ${layoutMode}`}` };
    sizeSent = true;
    const res = await fetch('/streams', { headers });
    const next = (await res.json()).map((s) => s.id).sort();
    if (next.join() !== live.join()) {
      live = next;
      renderChannels();
    }
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

setFocus(0);
renderChannels();
poll();
