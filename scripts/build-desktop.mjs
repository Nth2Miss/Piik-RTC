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

run('dotnet', ['build', hostProject, '-c', 'Release', '-v', 'minimal']);
if (!existsSync(hostExe)) {
  console.error('桌面端没有生成：' + hostExe);
  process.exit(1);
}

mkdirSync(release, { recursive: true });
const target = path.join(release, 'Piik.exe');
writeFileSync(target, readFileSync(hostExe));
console.log(`单文件桌面端：${target}（${(statSync(target).size / 1024 / 1024).toFixed(2)} MB）`);
