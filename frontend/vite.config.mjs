import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import dotenv from 'dotenv';
import { defineConfig } from 'vite';

export default defineConfig(({ command }) => {
  const config = {
    root: fileURLToPath(new URL('.', import.meta.url)),
    plugins: [react()]
  };
  if (command !== 'serve') return config;

  const local = {};
  dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)), processEnv: local, quiet: true });
  const rawPort = process.env.PORT ?? local.PORT ?? '3000';
  const port = Number(rawPort);
  if (!/^\d+$/.test(rawPort) || port < 1 || port > 65535) {
    throw new Error('PORT deve ser um inteiro entre 1 e 65535.');
  }

  return {
    ...config,
    server: {
      host: '127.0.0.1',
      port: process.env.DEV_WEB_PORT ? Number(process.env.DEV_WEB_PORT) : 5173,
      strictPort: true,
      proxy: {
        '/api': {
          target: `http://127.0.0.1:${port}`,
          changeOrigin: true,
          configure(proxy) {
            proxy.on('error', (_error, _request, response) => {
              if (!response || !('writeHead' in response) || response.headersSent || response.writableEnded) return;
              response.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
              response.end(JSON.stringify({ message: `API indisponível. Confira se o backend está ativo na porta ${port}.` }));
            });
          }
        }
      }
    }
  };
});
