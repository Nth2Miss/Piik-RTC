import 'dotenv/config';
import { createApp } from './app.js';
import { attachRealtime } from './rooms/realtime.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import express from 'express';
import { mkdirSync } from 'node:fs';
import { RoomStore } from './rooms/store.js';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDirectory = path.join(root, 'data');
mkdirSync(dataDirectory, { recursive: true });
const app = createApp(process.env, new RoomStore(path.join(dataDirectory, 'rooms.sqlite')));
if (process.argv.includes('--production')) {
  app.use(express.static(path.join(root, 'dist')));
} else {
  const { createServer } = await import('vite');
  const vite = await createServer({ root, server: { middlewareMode: true }, appType: 'spa' });
  app.use(vite.middlewares);
}
const server = http.createServer(app);
const realtime = attachRealtime(server, app, process.env);
const port = Number(process.env.PORT || 3000);
server.listen(port, '0.0.0.0', () => console.log(`Piik-sw 已启动：http://localhost:${port}`));
const shutdown = () => {
  realtime.close();
  server.close(() => { app.locals.close(); process.exit(0); });
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
