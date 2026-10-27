import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const helperProject = path.join(root, 'desktop', 'native', 'PiikAudio', 'PiikAudio.csproj');
const helperOutput = path.join(root, 'desktop', 'bin');
const helperExe = path.join(helperOutput, 'PiikAudio.exe');
const hostProject = path.join(root, 'desktop', 'PiikDesktop', 'PiikDesktop.csproj');
const hostExe = path.join(root, 'desktop', 'PiikDesktop', 'bin', 'Release', 'net48', 'Piik.exe');
const resource = path.join(root, 'desktop', 'PiikDesktop', 'Resources', 'PiikAudio.exe.gz');
const release = path.join(root, 'release');

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
  if (result.error) {
    console.error('无法运行 ' + command + '：' + result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function option(names) {
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    for (const name of names) {
      if (argument === '--' + name) {
        const next = args[index + 1];
        return next && !next.startsWith('--') ? next : '';
      }
      if (argument.startsWith('--' + name + '=')) return argument.slice(name.length + 3);
    }
  }
  return '';
}

function parseServer(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  let url;
  try { url = new URL(text); } catch { throw new Error('服务器地址格式不正确：' + text); }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('服务器地址必须以 https:// 或 http:// 开头。');
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname)) {
    throw new Error('除 localhost / 127.0.0.1 外，请使用 HTTPS 服务器地址。');
  }
  return url.origin;
}

let embeddedServer = '';
try {
  embeddedServer = parseServer(
    option(['server', 'server-url', 's']) || process.env.PIIK_DEFAULT_SERVER_URL || ''
  );
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

if (!embeddedServer && process.env.npm_lifecycle_event === 'desktop:build:embed') {
  console.error('请通过 --server=https://... 或 PIIK_DEFAULT_SERVER_URL 指定要内嵌的服务器地址。');
  process.exit(1);
}

rmSync(helperOutput, { recursive: true, force: true });
mkdirSync(helperOutput, { recursive: true });
run('dotnet', [
  'publish', helperProject,
  '-c', 'Release',
  '-r', 'win-x64',
  '--self-contained', 'true',
  '-p:PublishSingleFile=true',
  '-p:PublishTrimmed=true',
  '-p:TrimMode=partial',
  '-p:DebugType=None',
  '-p:DebugSymbols=false',
  '-o', helperOutput,
]);
if (!existsSync(helperExe)) {
  console.error('音频组件没有生成：' + helperExe);
  process.exit(1);
}

const raw = readFileSync(helperExe);
const compressed = gzipSync(raw, { level: 9 });
writeFileSync(resource, compressed);
console.log(`音频组件：${(raw.length / 1024 / 1024).toFixed(1)} MB -> 压缩 ${(compressed.length / 1024 / 1024).toFixed(1)} MB`);

run('dotnet', ['build', hostProject, '-c', 'Release', '-v', 'minimal',
  ...(embeddedServer ? ['-p:PiikDefaultServerUrl=' + embeddedServer] : [])]);
if (!existsSync(hostExe)) {
  console.error('桌面端没有生成：' + hostExe);
  process.exit(1);
}

if (embeddedServer) console.log(`内嵌服务端：${embeddedServer}`);

mkdirSync(release, { recursive: true });
const target = path.join(release, 'Piik.exe');
writeFileSync(target, readFileSync(hostExe));
console.log(`单文件桌面端：${target}（${(statSync(target).size / 1024 / 1024).toFixed(2)} MB）`);
