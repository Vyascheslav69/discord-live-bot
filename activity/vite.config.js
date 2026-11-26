import { defineConfig } from 'vite';

const RELAY = '127.0.0.1:8787'; // server/relay.js

const shared = {
  port: 5173,
  strictPort: true,
  allowedHosts: ['.trycloudflare.com'],
  // Uma porta só para o túnel: a página, a lista de transmissões e os WebSockets do relay (assistir e transmitir).
  proxy: {
    '/ws/': { target: `ws://${RELAY}`, ws: true },
    '/streams': `http://${RELAY}`,
    '/destinations': `http://${RELAY}`,
  },
};

export default defineConfig({
  // `npm run dev` para mexer no código; `npm start` (build + preview) para usar no Discord.
  server: { ...shared, hmr: false },
  preview: shared,
});
