import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import express from 'express';
import { createApp } from './app.js';
import { ReviewStore } from './store.js';

const production = import.meta.url.includes('/dist/server/');
const root = fileURLToPath(new URL(production ? '../../../' : '../../', import.meta.url));
const portValue = process.env.REVIEW_HELPER_PORT ?? '4318';
if (!/^\d+$/.test(portValue) || Number(portValue) < 1024 || Number(portValue) > 65535)
  throw new Error('REVIEW_HELPER_PORT 必须为 1024–65535 的整数。');
const port = Number(portValue);
const dataDirectory = process.env.REVIEW_HELPER_DATA_DIR
  ? path.resolve(process.env.REVIEW_HELPER_DATA_DIR)
  : path.join(root, '.review-helper');
const { app, stop } = createApp({ store: new ReviewStore(dataDirectory) });
const server = createServer(app);
let closeVite: (() => Promise<void>) | undefined;

if (production) {
  app.use(express.static(path.join(root, 'dist/web')));
  app.get('/', (_req, res) => res.sendFile(path.join(root, 'dist/web/index.html')));
} else {
  const { createServer: createVite } = await import('vite');
  const vite = await createVite({
    root,
    server: { middlewareMode: true, hmr: { server } },
    appType: 'spa',
  });
  app.use(vite.middlewares);
  closeVite = () => vite.close();
}

server.listen(port, '127.0.0.1', () => {
  console.log(`Diff Wingman: http://127.0.0.1:${port}`);
  console.log(`本地数据：${dataDirectory}`);
});
server.on('error', (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  stop();
  server.closeAllConnections();
  server.close();
  await closeVite?.();
  process.exitCode = 0;
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
