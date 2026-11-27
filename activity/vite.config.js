import { defineConfig } from 'vite';

const RELAY = '127.0.0.1:8787'; // server/relay.js

const shared = {
  port: 5173,
  strictPort: true,
  allowedHosts: ['.trycloudflare.com', 'live.laeleviewer.dpdns.org'],
  // Uma porta só para o túnel: a página, a lista de transmissões e os WebSockets do relay (assistir e transmitir).
  proxy: {
    '/ws/': { target: `ws://${RELAY}`, ws: true },
    '/streams': `http://${RELAY}`,
    // Mantém o Host público: o relay monta com ele o endereço de volta do login do Discord.
    '/auth/': { target: `http://${RELAY}`, changeOrigin: false },
    '/me': `http://${RELAY}`,
    '/avatar/': `http://${RELAY}`,
  },
};

export default defineConfig({
  // `npm run dev` para mexer no código; `npm start` (build + preview) para usar no Discord.
  server: { ...shared, hmr: false },
  preview: shared,
});
