import 'dotenv/config';
import { createApp } from './app.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { mkdirSync } from 'node:fs';
import { RoomStore } from './room-store.js';
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
const port = Number(process.env.PORT || 3000);
app.listen(port, '0.0.0.0', () => console.log(`同屏已启动：http://localhost:${port}`));
