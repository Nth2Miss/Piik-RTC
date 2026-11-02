import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const version = '3.60.107.2100';
const download = 'https://portal.volccdn.com/obj/volcfe/cloud-universal-doc/upload_ea0375d4e0a1dba99e6c4adc082da1b3.zip';
const sha256 = '3c90a7cb0e57a4e6b1f5eda3fa8dbfdb190635360a149cb739098713623463d7';
const archive = path.join(root,'node_modules','volc-native-sdk.zip');
const extracted = path.join(root,'node_modules','volc-native-sdk');
const sdk = path.join(extracted,`VolcEngineRTC_Windows_${version}`,'VolcEngineRTC');
const output = path.join(root,'desktop','native','PiikVolc','bin');
function run(command,args) {
  const result = spawnSync(command,args,{cwd:root,stdio:'inherit',windowsHide:true});
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} 执行失败（${result.status}）。`);
}
if (process.platform !== 'win32') throw new Error('原生 RTC 桥接需要 Windows 与 Visual Studio C++ Build Tools。');
if (!existsSync(archive)) run('curl.exe',['--fail','--location','--max-time','180',download,'--output',archive]);
if (createHash('sha256').update(readFileSync(archive)).digest('hex') !== sha256) throw new Error('火山 SDK 压缩包摘要不匹配，请删除缓存包后重新下载。');
if (!existsSync(path.join(sdk,'include','bytertc_engine.h'))) run('powershell.exe',['-NoProfile','-Command',`Expand-Archive -LiteralPath '${archive.replaceAll("'","''")}' -DestinationPath '${extracted.replaceAll("'","''")}' -Force`]);
const vswhere = path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)','Microsoft Visual Studio','Installer','vswhere.exe');
const found = spawnSync(vswhere,['-latest','-products','*','-requires','Microsoft.VisualStudio.Component.VC.Tools.x86.x64','-find','VC\\Auxiliary\\Build\\vcvars64.bat'],{encoding:'utf8',windowsHide:true});
if (found.error) throw found.error;
const vcvars = found.stdout?.trim().split(/\r?\n/)[0];
if (!vcvars || !existsSync(vcvars)) throw new Error('未找到 Visual Studio x64 C++ 编译工具。');
mkdirSync(output,{recursive:true});
const batch = path.join(output,'build.cmd');
const q = text => `"${text}"`;
writeFileSync(batch,`@echo off\r\ncall ${q(vcvars)} >nul\r\nif errorlevel 1 exit /b 1\r\ncl /nologo /std:c++17 /EHsc /MT /LD /utf-8 /I ${q(path.join(sdk,'include'))} ${q(path.join(root,'desktop','native','PiikVolc','PiikVolc.cpp'))} /Fo:${q(path.join(output,'PiikVolc.obj'))} /link /OUT:${q(path.join(output,'PiikVolc.dll'))} /IMPLIB:${q(path.join(output,'PiikVolc.lib'))} /LIBPATH:${q(path.join(sdk,'lib','x64'))} VolcEngineRTC.lib user32.lib\r\nexit /b %errorlevel%\r\n`);
run('cmd.exe',['/d','/c',batch]);
// Keep the runtime beside each development/release host; vendor binaries stay ignored.
const destinations = [path.join(root,'desktop','PiikDesktop','bin','Release','net48','native-volc'),path.join(root,'release','native-volc')];
const runtime = path.join(sdk,'bin','x64');
const dlls = readdirSync(runtime).filter(name => name.endsWith('.dll'));
for (const destination of destinations) {
  mkdirSync(destination,{recursive:true});
  copyFileSync(path.join(output,'PiikVolc.dll'),path.join(destination,'PiikVolc.dll'));
  for (const name of dlls) copyFileSync(path.join(runtime,name),path.join(destination,name));
  writeFileSync(path.join(destination,'version.json'),JSON.stringify({provider:'volc',sdk:version,archiveSha256:sha256})+'\n');
}
const bytes = dlls.reduce((sum,name)=>sum+statSync(path.join(runtime,name)).size,statSync(path.join(output,'PiikVolc.dll')).size);
console.log(`火山原生测试组件 ${version}：${(bytes/1024/1024).toFixed(1)} MiB。桌面 exe 与 native-volc 目录必须一起分发。`);
