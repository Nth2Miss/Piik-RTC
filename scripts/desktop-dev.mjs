import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const port = Number(process.env.PORT || 3000);
const url = `http://localhost:${port}`;
const { version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const executable = path.join(root, 'release', `Piik-v${version}.exe`);

if (!existsSync(executable)) {
  console.log('单文件桌面端尚未构建，正在构建…');
  const build = spawnSync(process.execPath, [path.join(root, 'scripts', 'build-desktop.mjs')], { stdio: 'inherit', cwd: root });
  if (build.status !== 0) process.exit(build.status ?? 1);
}

async function serverReady() {
  try {
    const response = await fetch(`${url}/api/config`, { signal: AbortSignal.timeout(1200) });
    return response.ok;
  } catch {
    return false;
  }
}

let server = null;
let app = null;
let stopping = false;

if (!(await serverReady())) {
  server = spawn(process.execPath, ['server/index.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(port) },
    stdio: 'inherit',
  });
}

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  try { app?.kill(); } catch { /* already exited */ }
  try { server?.kill(); } catch { /* already exited */ }
  setTimeout(() => process.exit(code), 300);
}

process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
server?.on('exit', code => {
  if (stopping) return;
  console.error(`服务端已退出（${code}）。`);
  stop(code ?? 0);
});

async function waitForServer() {
  const deadline = Date.now() + 40000;
  while (Date.now() < deadline) {
    if (server && server.exitCode !== null) throw new Error(`服务端已退出（${server.exitCode}），请检查 .env 和端口 ${port}。`);
    if (await serverReady()) return;
    await new Promise(resolve => setTimeout(resolve, 400));
  }
  throw new Error(`等待服务端 ${url} 超时。`);
}

try {
  await waitForServer();
  console.log(`桌面端连接到 ${url}，WebView2 调试端口 9222`);
  app = spawn(executable, [`--server=${url}`, '--debug'], { cwd: root, stdio: 'inherit' });
  app.on('exit', code => stop(code ?? 0));
  app.on('error', error => {
    console.error('无法启动桌面端：', error.message);
    stop(1);
  });
} catch (error) {
  console.error(error.message);
  stop(1);
}
