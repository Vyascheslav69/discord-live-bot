// Forma alternativa de ligar o servidor, num processo só (Pterodactyl ou qualquer host com um comando de inicialização).
// Instala as dependências, compila a atividade, sobe o relay servindo a página e abre o túnel da Cloudflare.
// Variáveis: SERVER_PORT (o Pterodactyl define), SENHA_TRANSMISSOR, DISCORD_BOT_TOKEN, VITE_DISCORD_CLIENT_ID,
// CLOUDFLARE_TUNNEL_TOKEN (opcional: endereço fixo), CLOUDFLARED (opcional: caminho do cloudflared).
// Cada uma pode vir do painel ou de server/.env.
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = __dirname;
// No Pterodactyl nem sempre dá para criar variáveis no painel: server/.env também vale (sem sobrescrever as do painel).
try {
  process.loadEnvFile(path.join(root, 'server', '.env'));
} catch {}
const PORT = process.env.SERVER_PORT || process.env.PORT || '8787';
const win = process.platform === 'win32';

function run(cmd, args, cwd) {
  console.log(`> ${cmd} ${args.join(' ')} (${path.relative(root, cwd) || '.'})`);
  // No Windows npm/npx são .cmd e precisam de shell (só para testar localmente; os argumentos são fixos).
  const r = win ? spawnSync([cmd, ...args].join(' '), { cwd, stdio: 'inherit', shell: true }) : spawnSync(cmd, args, { cwd, stdio: 'inherit' });
  if (r.status !== 0) {
    console.error(`Falhou: ${cmd} ${args.join(' ')}`);
    process.exit(1);
  }
}

// cloudflared do PATH/variável ou baixado para ./bin na primeira vez (só Linux).
async function cloudflared() {
  if (process.env.CLOUDFLARED) return process.env.CLOUDFLARED;
  if (process.platform !== 'linux') return 'cloudflared';
  const bin = path.join(root, 'bin', 'cloudflared');
  if (fs.existsSync(bin)) return bin;
  const arch = { x64: 'amd64', arm64: 'arm64' }[process.arch] ?? 'amd64';
  const url = `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${arch}`;
  console.log(`Baixando o cloudflared (${arch})...`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download do cloudflared respondeu ${res.status}`);
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(bin, Buffer.from(await res.arrayBuffer()), { mode: 0o755 });
  return bin;
}

function startTunnel(bin) {
  const token = process.env.CLOUDFLARE_TUNNEL_TOKEN;
  // Com token: túnel nomeado (endereço fixo, configurado no painel da Cloudflare). Sem: túnel rápido (endereço muda).
  const args = token
    ? ['tunnel', '--no-autoupdate', 'run', '--token', token]
    : ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${PORT}`];
  const tunnel = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let shown = false;
  const onOutput = (chunk) => {
    const text = chunk.toString();
    const url = !shown && text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (url) {
      shown = true;
      console.log(`\n==> Endereço público: ${url[0]}`);
      console.log(`==> No portal do Discord, URL Mapping "/" = ${url[0].slice(8)}\n`);
    }
    if (/ERR|error/i.test(text)) process.stderr.write(`[túnel] ${text}`);
    if (token && /Registered tunnel connection/.test(text) && !shown) {
      shown = true;
      console.log('==> Túnel nomeado conectado (endereço fixo).');
    }
  };
  tunnel.stdout.on('data', onOutput);
  tunnel.stderr.on('data', onOutput);
  tunnel.on('exit', (code) => console.error(`O túnel parou (código ${code}). O servidor continua, mas sem acesso público.`));
  tunnel.on('error', (e) => console.error(`Não consegui abrir o túnel: ${e.message}`));
  return tunnel;
}

(async () => {
  run('npm', ['install', '--no-audit', '--no-fund', '--omit=dev'], path.join(root, 'server'));
  run('npm', ['install', '--no-audit', '--no-fund'], path.join(root, 'activity'));
  // VITE_DISCORD_CLIENT_ID vem do painel ou de activity/.env.
  run('npx', ['vite', 'build'], path.join(root, 'activity'));

  const relay = spawn(process.execPath, ['relay.js'], {
    cwd: path.join(root, 'server'),
    stdio: 'inherit',
    env: { ...process.env, PORT, HOST: '0.0.0.0', STATIC_DIR: path.join(root, 'activity', 'dist') },
  });
  relay.on('exit', (code) => process.exit(code ?? 1));

  let tunnel = null;
  try {
    tunnel = startTunnel(await cloudflared());
  } catch (e) {
    console.error(`Sem túnel: ${e.message}`);
  }

  // "stop" no console do Pterodactyl, ou Ctrl+C.
  const stop = () => {
    tunnel?.kill();
    relay.kill();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  process.stdin.on('data', (d) => d.toString().trim() === 'stop' && stop());
})();
