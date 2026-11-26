// Teste do relay: senha, nome único, repasse de quadros e quadro-chave para quem entra no meio.
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
const { server } = await import('./relay.js');
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

// espectador recebe config, ignora delta até chegar quadro-chave
const viewer = new WebSocket(`${base}/ws/watch/${list[0].id}`);
const firstMsg = nextMsg(viewer); // o relay manda a config logo na conexão
assert.equal((await firstMsg).video.codec, 'vp8');
const got = [];
viewer.on('message', (d, bin) => bin && got.push(d[9]));
juan.ws.send(frame(1, 1)); // delta antes do chave: descartado
juan.ws.send(frame(2, 2)); // áudio passa
juan.ws.send(frame(0, 3)); // chave
juan.ws.send(frame(1, 4)); // delta depois do chave
await new Promise((r) => setTimeout(r, 100));
assert.deepEqual(got, [2, 3, 4]);

// lista de servidores/calls exige a senha (sem bot: lista vazia)
const http = `http://127.0.0.1:${server.address().port}`;
assert.equal((await fetch(`${http}/destinations`)).status, 401);
assert.deepEqual(await (await fetch(`${http}/destinations`, { headers: { Authorization: 'Bearer segredo' } })).json(), []);

// fim da transmissão fecha o espectador e libera o nome
juan.ws.close();
const [code] = await once(viewer, 'close');
assert.equal(code, 4000);
assert.equal((await publisher('julia')).reply.type, 'ok');

console.log('relay ok');
process.exit(0);
