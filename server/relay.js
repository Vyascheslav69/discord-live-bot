// Relay das transmissões: recebe vídeo/áudio já codificados do laele viewer e repassa para quem assiste.
// Protocolo binário (cada mensagem): [tipo u8][timestamp float64 LE, µs][dados]
//   tipo 0 = vídeo quadro-chave, 1 = vídeo delta, 2 = áudio (Opus)
// Texto (JSON): hello/ok/error na entrada do laele viewer, "config" (codecs) repassado aos espectadores,
// "viewers" (quantos assistem) para o laele viewer e "ping" (apontar na tela) entre espectadores.
import { createServer } from 'node:http';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { WebSocketServer } from 'ws';
import * as bot from './bot.js';

const PORT = Number(process.env.PORT ?? 8787);
// Modo normal: só localhost (o acesso de fora passa pelo Vite e pelo túnel). Modo Pterodactyl: HOST=0.0.0.0 e STATIC_DIR.
const HOST = process.env.HOST ?? '127.0.0.1';
// Pasta com a atividade já compilada (activity/dist). Sem ela, quem serve a página é o Vite.
const STATIC_DIR = process.env.STATIC_DIR;
const PASSWORD_FILE = process.env.PASSWORD_FILE ?? new URL('../SENHA-TRANSMISSOR.txt', import.meta.url);
const VIDEO_KEY = 0;
const VIDEO_DELTA = 1;
const AUDIO = 2;
// Acima disso o espectador está atrasado: descarta vídeo até o próximo quadro-chave em vez de acumular atraso.
const MAX_BUFFERED = 1_000_000;

const sha = (s) => createHash('sha256').update(s).digest();
// shortcut: a senha é lida uma vez ao iniciar; reinicie o relay depois de trocá-la.
// Variável SENHA_TRANSMISSOR (painel do Pterodactyl) ou linha 2 do arquivo.
let passwordLine = process.env.SENHA_TRANSMISSOR?.trim();
if (!passwordLine) try {
  passwordLine = readFileSync(PASSWORD_FILE, 'utf8').split(/\r?\n/)[1]?.trim();
} catch {
  // arquivo ausente: cai na mensagem abaixo
}
if (!passwordLine) {
  console.error('Falta a senha: defina SENHA_TRANSMISSOR ou copie SENHA-TRANSMISSOR.example.txt para SENHA-TRANSMISSOR.txt e escreva a senha na linha 2.');
  process.exit(1);
}
const passwordHash = sha(passwordLine);
export const checkPassword = (p) => typeof p === 'string' && timingSafeEqual(sha(p), passwordHash);

// O endereço do túnel é público: depois de 5 senhas erradas o IP fica 10 minutos sem poder tentar (nem com a certa).
const MAX_FAILS = 5;
const LOCK_MS = 10 * 60_000;
const fails = new Map(); // ip -> { count, last }
// O túnel e o Vite rodam nesta máquina: só nesse caso o IP vem do cabeçalho da Cloudflare (de fora ele seria forjável).
const clientIp = (req) => {
  const remote = req.socket.remoteAddress ?? '';
  return (/^(::ffff:)?127\.|^::1$/.test(remote) && req.headers['cf-connecting-ip']) || remote;
};
// 'ok', 'senha' (errada) ou 'bloqueado' (errou demais).
export function tryPassword(ip, password) {
  const now = Date.now();
  const f = fails.get(ip);
  if (f && now - f.last > LOCK_MS) fails.delete(ip);
  else if (f?.count >= MAX_FAILS) return 'bloqueado';
  if (checkPassword(password)) return fails.delete(ip), 'ok';
  if (fails.size > 10_000) for (const [k, v] of fails) if (now - v.last > LOCK_MS) fails.delete(k);
  const count = (fails.get(ip)?.count ?? 0) + 1;
  fails.set(ip, { count, last: now });
  if (count === MAX_FAILS) console.log(`  ${ip} errou a senha ${MAX_FAILS} vezes: bloqueado por ${LOCK_MS / 60_000} min`);
  return count >= MAX_FAILS ? 'bloqueado' : 'senha';
}

/* ---------- login com o Discord (OAuth2) ---------- */

// Com DISCORD_CLIENT_SECRET (server/.env) e o bot no ar, quem transmite entra com a conta do Discord: o nome vem do
// apelido no servidor e o aviso vai para a call em que a pessoa está. Sem isso, vale o nome digitado no laele viewer.
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
// Decide pela configuração, nunca pelo bot estar conectado agora: com o bot caído o relay recusa (não aceita nome digitado).
const discordLogin = () => !!CLIENT_SECRET && bot.enabled;

// Sessão = id do Discord assinado: nada fica guardado e ela continua valendo depois de reiniciar o relay.
const sessionKey = CLIENT_SECRET ? sha(`laele-sessao:${CLIENT_SECRET}`) : null;
const sign = (id) => createHmac('sha256', sessionKey).update(id).digest('base64url');
export const makeSession = (id) => `${id}.${sign(id)}`;
export function sessionUser(session) {
  const [id, mac] = String(session ?? '').split('.');
  if (!sessionKey || !/^\d{1,20}$/.test(id) || !mac) return null;
  const a = Buffer.from(mac);
  const b = Buffer.from(sign(id));
  return a.length === b.length && timingSafeEqual(a, b) ? id : null;
}

// Endereço público por onde o pedido chegou (túnel, Vite ou direto).
function publicOrigin(req) {
  const proto = String(req.headers['x-forwarded-proto'] ?? 'http').split(',')[0];
  return `${proto}://${req.headers['x-forwarded-host'] ?? req.headers.host}`;
}

// O laele viewer pede a autorização ao Discord aberto no PC (RPC local) e manda aqui o código; o relay confirma com
// o Discord quem autorizou e devolve a sessão. Só quem clicou em "Autorizar" no próprio Discord recebe a sessão.
async function onDiscordCode(req, res) {
  if (!discordLogin() || !bot.ready()) return res.writeHead(503).end();
  let body = '';
  for await (const chunk of req) if ((body += chunk).length > 4096) return res.writeHead(413).end();
  const code = (() => { try { return JSON.parse(body).code; } catch { return null; } })();
  if (typeof code !== 'string' || !code) return res.writeHead(400).end();
  try {
    let token = null;
    // Código do RPC não tem redirect_uri; se o Discord exigir um, usa o endereço de volta cadastrado no portal.
    for (const redirect of [null, `${publicOrigin(req)}/auth/callback`]) {
      const params = new URLSearchParams({ grant_type: 'authorization_code', code });
      if (redirect) params.set('redirect_uri', redirect);
      const r = await fetch('https://discord.com/api/oauth2/token', {
        method: 'POST',
        headers: { Authorization: `Basic ${Buffer.from(`${bot.applicationId()}:${CLIENT_SECRET}`).toString('base64')}` },
        body: params,
      });
      if (r.ok) {
        token = await r.json();
        break;
      }
      console.error(`Login do Discord: troca do código${redirect ? ' (com redirect)' : ''} respondeu ${r.status} ${await r.text()}`);
    }
    if (!token) return res.writeHead(401).end();
    const user = await fetch('https://discord.com/api/users/@me', { headers: { Authorization: `Bearer ${token.access_token}` } })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`usuário: ${r.status}`))));
    console.log(`  conta do Discord vinculada: ${user.username}`);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ session: makeSession(user.id) }));
  } catch (e) {
    console.error(`Login do Discord falhou (${e.message})`);
    return res.writeHead(502).end();
  }
}

// "Júlia", "julia" e " JULIA " são o mesmo nome.
export const sameName = (a, b) => {
  const norm = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
  return norm(a) === norm(b);
};
const idOf = (name) => Buffer.from(name).toString('base64url');
// Cada transmissão aparece só no servidor do Discord de quem transmite (o da call, senão o primeiro em que a pessoa está).
// Sem servidor de um dos lados (nome digitado, ou página aberta fora do Discord) aparece para todos.
// shortcut: é organização, não segurança; quem tem o endereço do túnel pode pedir a lista de outro servidor.
export const visibleIn = (stream, guild) => !guild || !stream.guildId || stream.guildId === guild;

const streams = new Map(); // id -> { name, config, viewers: Set<WebSocket>, publisher, avatar }

const send = (ws, msg) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(msg));
// Quem transmite vê no laele viewer quantas pessoas estão assistindo.
const sendViewers = (stream) => send(stream.publisher, { type: 'viewers', count: stream.viewers.size });

// Foto do Discord de quem transmite, baixada uma vez e servida pelo relay (a atividade só acessa o próprio endereço).
async function loadAvatar(stream, url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!r.ok) throw new Error(`foto: ${r.status}`);
  const body = Buffer.from(await r.arrayBuffer());
  if (body.length < 256 * 1024) stream.avatar = { type: r.headers.get('content-type') ?? 'image/png', body };
}

// Codificadores H.264 por hardware às vezes só mandam SPS/PPS (a configuração do vídeo) no primeiro quadro-chave:
// quem entra depois nunca consegue decodificar. O relay guarda os últimos e completa os quadros-chave que vierem sem.
const START_CODE = Buffer.from([0, 0, 0, 1]);
// Unidades NAL do começo do quadro (Annex B) até o primeiro pedaço de imagem: { type, at (código de início), start, end }.
function leadingNals(data) {
  const nals = [];
  for (let i = 0; i + 3 < data.length; i++) {
    if (data[i] || data[i + 1] || data[i + 2] !== 1) continue;
    const at = i > 0 && data[i - 1] === 0 ? i - 1 : i;
    if (nals.length) nals.at(-1).end = at;
    const type = data[i + 3] & 0x1f;
    nals.push({ type, at, start: i + 3, end: data.length });
    if (type >= 1 && type <= 5) break;
    i += 3;
  }
  return nals;
}
// Recebe a mensagem inteira ([tipo][timestamp][dados]) de um quadro-chave H.264 e devolve a mesma ou uma completada.
export function completeKeyframe(stream, msg) {
  const data = msg.subarray(9);
  const nals = leadingNals(data);
  const params = nals.filter((n) => n.type === 7 || n.type === 8);
  if (params.some((n) => n.type === 7) && params.some((n) => n.type === 8)) {
    stream.paramSets = Buffer.concat(params.flatMap((n) => [START_CODE, data.subarray(n.start, n.end)]));
    return msg;
  }
  if (!stream.paramSets) return msg;
  if (!stream.completing) console.log(`  ${stream.name}: quadros-chave sem SPS/PPS, o relay completa para quem entra depois`);
  stream.completing = true;
  const at = nals.find((n) => n.type !== 9)?.at ?? 0; // depois do delimitador de quadro (AUD), se houver
  return Buffer.concat([msg.subarray(0, 9), data.subarray(0, at), stream.paramSets, data.subarray(at)]);
}

function onPublish(ws, ip) {
  let id = null;
  let stream = null;
  const helloTimer = setTimeout(() => ws.close(4001, 'sem hello'), 5000);

  let helloSeen = false;
  ws.on('message', async (data, isBinary) => {
    if (!stream) {
      if (helloSeen) return; // nada chega antes do "ok"; ignora enquanto confere o hello
      helloSeen = true;
      clearTimeout(helloTimer);
      let hello;
      try {
        hello = JSON.parse(data);
      } catch {
        return ws.close(4002, 'hello inválido');
      }
      const pass = tryPassword(ip, hello.password);
      if (pass !== 'ok') return send(ws, { type: 'error', code: pass }), ws.close(4003, pass);
      let name = String(hello.name ?? '').trim().slice(0, 32);
      let call = null;
      let guildId = null;
      let avatarUrl = null;
      if (discordLogin()) {
        // Com login do Discord o nome digitado não vale: ninguém transmite com o nome de outra pessoa.
        const userId = sessionUser(hello.session);
        if (!userId) return send(ws, { type: 'error', code: 'sessao' }), ws.close(4003, 'sessão');
        const who = await bot.member(userId).catch(() => null);
        if (!who) return send(ws, { type: 'error', code: 'discord' }), ws.close(4003, 'fora dos servidores');
        name = who.name.trim().slice(0, 32);
        call = who.channel; // o bot sempre avisa na call em que a pessoa está
        guildId = call?.guildId ?? who.guildId;
        avatarUrl = who.avatar;
        if (ws.readyState !== ws.OPEN) return; // desistiu enquanto conferia
      }
      if (!name) return send(ws, { type: 'error', code: 'nome-vazio' }), ws.close(4002, 'nome');
      if ([...streams.values()].some((s) => sameName(s.name, name))) {
        return send(ws, { type: 'error', code: 'nome' }), ws.close(4009, 'nome em uso');
      }
      id = idOf(name);
      stream = { name, guildId, config: null, viewers: new Set(), publisher: ws, avatar: null };
      streams.set(id, stream);
      console.log(`+ ${name} começou a transmitir`);
      if (avatarUrl) loadAvatar(stream, avatarUrl).catch((e) => console.error(`  sem foto de ${name} (${e.message})`));
      // Aviso no Discord com o link da atividade, na call em que a pessoa está (login do Discord).
      stream.announcement = bot
        .announce(name, call?.guildId, call?.id)
        .then((msg) => {
          if (msg) console.log(`  aviso enviado em #${msg.channel.name} (${msg.url})`);
          return msg;
        })
        .catch((e) => {
          console.error(`Bot: não consegui avisar no Discord (${e.message})`);
          return null;
        });
      return send(ws, { type: 'ok' });
    }

    if (!isBinary) {
      const msg = JSON.parse(data);
      if (msg.type === 'config') {
        stream.config = JSON.stringify(msg);
        stream.avc = String(msg.video?.codec).startsWith('avc1');
        stream.paramSets = null; // codificador novo: configuração nova
        for (const v of stream.viewers) {
          v.needKey = true;
          v.send(stream.config);
        }
      }
      return;
    }

    const kind = data[0];
    if (kind === VIDEO_KEY && stream.avc) data = completeKeyframe(stream, data);
    for (const v of stream.viewers) {
      if (v.readyState !== v.OPEN) continue;
      if (kind !== AUDIO) {
        if (kind === VIDEO_DELTA && v.needKey) continue;
        if (v.bufferedAmount > MAX_BUFFERED) {
          v.needKey = true;
          continue;
        }
        if (kind === VIDEO_KEY) v.needKey = false;
      } else if (v.bufferedAmount > 2 * MAX_BUFFERED) continue;
      v.send(data, { binary: true });
    }
  });

  ws.on('close', () => {
    clearTimeout(helloTimer);
    if (!stream) return;
    streams.delete(id);
    console.log(`- ${stream.name} parou de transmitir`);
    stream.announcement.then((msg) => bot.finish(msg, stream.name)).catch(() => {});
    for (const v of stream.viewers) v.close(4000, 'fim');
  });
}

function onWatch(ws, id) {
  const stream = streams.get(id);
  if (!stream) return ws.close(4004, 'não encontrado');
  ws.needKey = true;
  stream.viewers.add(ws);
  sendViewers(stream);
  if (stream.config) ws.send(stream.config);
  ws.on('close', () => {
    stream.viewers.delete(ws);
    sendViewers(stream);
  });
  // O espectador manda: apontar um ponto da tela (x, y de 0 a 1 sobre o vídeo), repassado a todos,
  // e diagnóstico quando fica sem imagem (vai só para o log, no máximo 5 por espectador).
  let lastPing = 0;
  let diags = 0;
  ws.on('message', (data, isBinary) => {
    if (isBinary || data.length > 800) return;
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (msg?.type === 'diag' && typeof msg.text === 'string') {
      // Sem caracteres de controle: quem assiste não consegue forjar linhas no log.
      if (++diags <= 5) console.log(`  espectador de ${stream.name}: ${msg.text.slice(0, 600).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')}`);
      return;
    }
    // Este espectador não decodifica H.264 (Discord sem o codec): pede ao laele viewer para trocar para VP8.
    if (msg?.type === 'sem-h264') {
      if (stream.avc && !stream.askedVp8) {
        stream.askedVp8 = true;
        console.log(`  ${stream.name}: um espectador não consegue ver H.264, pedindo VP8`);
        send(stream.publisher, { type: 'evitar-h264' });
      }
      return;
    }
    if (Date.now() - lastPing < 150) return;
    lastPing = Date.now();
    const { x, y, hue } = msg ?? {};
    const ok = (n, max) => typeof n === 'number' && n >= 0 && n <= max;
    if (msg?.type !== 'ping' || !ok(x, 1) || !ok(y, 1) || !Number.isInteger(hue) || !ok(hue, 359)) return;
    const ping = JSON.stringify({ type: 'ping', x, y, hue });
    for (const v of stream.viewers) if (v.readyState === v.OPEN) v.send(ping);
  });
}

export const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://relay');
  if (req.method === 'GET' && url.pathname === '/streams') {
    const tela = String(req.headers['x-tela'] ?? '');
    if (/^\d{1,5}x\d{1,5}( [a-z0-9-]{1,12})?$/.test(tela)) console.log(`  atividade: área de ${tela}`);
    const guild = /^\d{1,20}$/.test(url.searchParams.get('guild')) ? url.searchParams.get('guild') : null;
    const list = [...streams]
      .filter(([, s]) => s.config && visibleIn(s, guild))
      .map(([id, s]) => ({ id, name: s.name, viewers: s.viewers.size, avatar: !!s.avatar }));
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(list));
  }
  // Servidores/calls onde o bot pode avisar. Só para quem tem a senha (os nomes dos servidores não são públicos).
  if (req.method === 'GET' && url.pathname === '/auth/config') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ discord: discordLogin(), clientId: bot.applicationId() ?? null }));
  }
  if (req.method === 'POST' && url.pathname === '/auth/discord') return onDiscordCode(req, res);
  const avatar = req.method === 'GET' && url.pathname.startsWith('/avatar/') && streams.get(url.pathname.slice(8))?.avatar;
  if (avatar) return res.writeHead(200, { 'Content-Type': avatar.type, 'Cache-Control': 'private, max-age=300' }).end(avatar.body);
  // Nome no servidor do dono da sessão (só para quem tem a senha).
  if (req.method === 'GET' && url.pathname === '/me') {
    const pass = tryPassword(clientIp(req), (req.headers.authorization ?? '').replace(/^Bearer /, ''));
    if (pass !== 'ok') return res.writeHead(pass === 'bloqueado' ? 429 : 401).end();
    const userId = sessionUser(req.headers['x-session']);
    if (!userId) return res.writeHead(403).end();
    return bot.member(userId).then((who) => {
      if (!who) return res.writeHead(404).end();
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ name: who.name }));
    }, () => res.writeHead(502).end());
  }
  if (STATIC_DIR && req.method === 'GET') return serveStatic(req, res);
  res.writeHead(404).end();
});

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
function serveStatic(req, res) {
  const { pathname } = new URL(req.url, 'http://relay');
  let file;
  try {
    file = join(STATIC_DIR, decodeURIComponent(pathname === '/' ? '/index.html' : pathname));
  } catch {
    return res.writeHead(400).end();
  }
  // join resolve "..": o que sair da pasta é recusado.
  if (!file.startsWith(join(STATIC_DIR, '/'))) return res.writeHead(404).end();
  let body;
  try {
    body = readFileSync(file);
  } catch {
    return res.writeHead(404).end();
  }
  // Arquivos em /assets têm hash no nome: podem ficar em cache.
  const cache = pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache';
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Cache-Control': cache }).end(body);
}

const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });
server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url, 'http://relay');
  const watch = pathname.match(/^\/ws\/watch\/([A-Za-z0-9_-]+)$/);
  if (pathname !== '/ws/publish' && !watch) return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => (watch ? onWatch(ws, watch[1]) : onPublish(ws, clientIp(req))));
});

server.listen(PORT, HOST, () => console.log(`Relay ouvindo em ${HOST}:${server.address().port}`));
