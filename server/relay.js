// Relay das transmissões: recebe vídeo/áudio já codificados do laele viewer e repassa para quem assiste.
// Protocolo binário (cada mensagem): [tipo u8][timestamp float64 LE, µs][dados]
//   tipo 0 = vídeo quadro-chave, 1 = vídeo delta, 2 = áudio (Opus)
// Texto (JSON): hello/ok/error na entrada do laele viewer e "config" (codecs) repassado aos espectadores.
import { createServer } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
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

// "Júlia", "julia" e " JULIA " são o mesmo nome.
export const sameName = (a, b) => {
  const norm = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
  return norm(a) === norm(b);
};
const idOf = (name) => Buffer.from(name).toString('base64url');

const streams = new Map(); // id -> { name, config, viewers: Set<WebSocket> }

const send = (ws, msg) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(msg));

function onPublish(ws) {
  let id = null;
  let stream = null;
  const helloTimer = setTimeout(() => ws.close(4001, 'sem hello'), 5000);

  ws.on('message', (data, isBinary) => {
    if (!stream) {
      clearTimeout(helloTimer);
      let hello;
      try {
        hello = JSON.parse(data);
      } catch {
        return ws.close(4002, 'hello inválido');
      }
      const name = String(hello.name ?? '').trim().slice(0, 32);
      if (!checkPassword(hello.password)) return send(ws, { type: 'error', code: 'senha' }), ws.close(4003, 'senha');
      if (!name) return send(ws, { type: 'error', code: 'nome-vazio' }), ws.close(4002, 'nome');
      if ([...streams.values()].some((s) => sameName(s.name, name))) {
        return send(ws, { type: 'error', code: 'nome' }), ws.close(4009, 'nome em uso');
      }
      id = idOf(name);
      stream = { name, config: null, viewers: new Set() };
      streams.set(id, stream);
      console.log(`+ ${name} começou a transmitir`);
      // Aviso no Discord com o link da atividade (na call que o laele viewer escolheu).
      stream.announcement = bot
        .announce(name, hello.guildId, hello.channelId)
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
        for (const v of stream.viewers) {
          v.needKey = true;
          v.send(stream.config);
        }
      }
      return;
    }

    const kind = data[0];
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
  if (stream.config) ws.send(stream.config);
  ws.on('close', () => stream.viewers.delete(ws));
  ws.on('message', () => {}); // espectadores não mandam nada
}

export const server = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/streams') {
    const list = [...streams].filter(([, s]) => s.config).map(([id, s]) => ({ id, name: s.name }));
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(list));
  }
  // Servidores/calls onde o bot pode avisar. Só para quem tem a senha (os nomes dos servidores não são públicos).
  if (req.method === 'GET' && req.url === '/destinations') {
    const password = (req.headers.authorization ?? '').replace(/^Bearer /, '');
    if (!checkPassword(password)) return res.writeHead(401).end();
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(bot.destinations()));
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
  wss.handleUpgrade(req, socket, head, (ws) => (watch ? onWatch(ws, watch[1]) : onPublish(ws)));
});

server.listen(PORT, HOST, () => console.log(`Relay ouvindo em ${HOST}:${server.address().port}`));
