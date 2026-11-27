// Teste do relay: senha (e bloqueio), nome único, repasse de quadros, quadro-chave para quem entra no meio,
// contagem de quem assiste e apontar na tela.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

const dir = mkdtempSync(join(tmpdir(), 'relay-'));
process.env.PASSWORD_FILE = join(dir, 'senha.txt');
writeFileSync(process.env.PASSWORD_FILE, 'Senha:\nsegredo\n');
process.env.PORT = '0';
process.env.DISCORD_BOT_TOKEN = ''; // teste sem conectar ao Discord
process.env.DISCORD_CLIENT_SECRET = 'segredo-de-teste'; // assina as sessões (o login fica desligado sem o bot)
const { server, makeSession, sessionUser } = await import('./relay.js');
await once(server, 'listening');
const base = `ws://127.0.0.1:${server.address().port}`;

const nextMsg = (ws) => once(ws, 'message').then(([d, bin]) => (bin ? d : JSON.parse(d)));
async function publisher(name, password = 'segredo') {
  const ws = new WebSocket(`${base}/ws/publish`);
  await once(ws, 'open');
  ws.send(JSON.stringify({ name, password }));
  return { ws, reply: await nextMsg(ws) };
}
const frame = (kind, byte) => Buffer.from([kind, 0, 0, 0, 0, 0, 0, 0, 0, byte]);

// senha errada
assert.equal((await publisher('Ana', 'errada')).reply.code, 'senha');

// publica e repassa config
const juan = await publisher('Júlia');
assert.equal(juan.reply.type, 'ok');
juan.ws.send(JSON.stringify({ type: 'config', video: { codec: 'vp8' } }));
await new Promise((r) => setTimeout(r, 50));

// nome repetido (sem acento/maiúscula) é recusado
assert.equal((await publisher(' JULIA ')).reply.code, 'nome');

// lista
const list = await (await fetch(`http://127.0.0.1:${server.address().port}/streams`)).json();
assert.deepEqual(list.map((s) => s.name), ['Júlia']);

// espectador recebe config, ignora delta até chegar quadro-chave; quem transmite fica sabendo que tem 1 assistindo
const countMsg = nextMsg(juan.ws);
const viewer = new WebSocket(`${base}/ws/watch/${list[0].id}`);
const firstMsg = nextMsg(viewer); // o relay manda a config logo na conexão
assert.equal((await firstMsg).video.codec, 'vp8');
assert.deepEqual(await countMsg, { type: 'viewers', count: 1 });
const listed = await (await fetch(`http://127.0.0.1:${server.address().port}/streams`)).json();
assert.equal(listed[0].viewers, 1);
const got = [];
viewer.on('message', (d, bin) => bin && got.push(d[9]));
juan.ws.send(frame(1, 1)); // delta antes do chave: descartado
juan.ws.send(frame(2, 2)); // áudio passa
juan.ws.send(frame(0, 3)); // chave
juan.ws.send(frame(1, 4)); // delta depois do chave
await new Promise((r) => setTimeout(r, 100));
assert.deepEqual(got, [2, 3, 4]);

// apontar na tela: repassado a todos os espectadores; fora de 0..1 é ignorado
const pings = [];
viewer.on('message', (d, bin) => !bin && pings.push(JSON.parse(d)));
viewer.send(JSON.stringify({ type: 'ping', x: 2, y: 0.5, hue: 10 }));
await new Promise((r) => setTimeout(r, 200));
viewer.send(JSON.stringify({ type: 'ping', x: 0.25, y: 0.5, hue: 10 }));
await new Promise((r) => setTimeout(r, 100));
assert.deepEqual(pings, [{ type: 'ping', x: 0.25, y: 0.5, hue: 10 }]);

// sem bot no ar não há login do Discord: vale o nome digitado
const http = `http://127.0.0.1:${server.address().port}`;
assert.deepEqual(await (await fetch(`${http}/auth/config`)).json(), { discord: false, clientId: null });
assert.equal((await fetch(`${http}/auth/discord`, { method: 'POST', body: '{"code":"x"}' })).status, 503);

// "quem sou eu" exige a senha e uma sessão válida
assert.equal((await fetch(`${http}/me`)).status, 401);
assert.equal((await fetch(`${http}/me`, { headers: { Authorization: 'Bearer segredo', 'X-Session': 'x' } })).status, 403);

// sessão assinada: aceita a própria, recusa id trocado ou assinatura mexida
const session = makeSession('123456789012345678');
assert.equal(sessionUser(session), '123456789012345678');
assert.equal(sessionUser(session.replace('123', '124')), null);
assert.equal(sessionUser(`${session}x`), null);
assert.equal(sessionUser(undefined), null);

// fim da transmissão fecha o espectador e libera o nome
juan.ws.close();
const [code] = await once(viewer, 'close');
assert.equal(code, 4000);
assert.equal((await publisher('julia')).reply.type, 'ok');

// 5 senhas erradas seguidas bloqueiam o IP, até com a senha certa (acertar zera a contagem)
for (let i = 0; i < 4; i++) assert.equal((await publisher('Bia', 'errada')).reply.code, 'senha');
assert.equal((await publisher('Bia', 'errada')).reply.code, 'bloqueado');
assert.equal((await publisher('Bia')).reply.code, 'bloqueado');
assert.equal((await fetch(`${http}/me`, { headers: { Authorization: 'Bearer segredo' } })).status, 429);

console.log('relay ok');
process.exit(0);
