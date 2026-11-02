import { readFileSync, appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function releaseVersion(input, packageVersion) {
  const version = String(input || '').replace(/^v/, '');
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version) || version !== packageVersion) {
    throw new Error(`发布版本必须与 package.json 的 ${packageVersion} 一致（可带 v 前缀）。`);
  }
  return version;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const validated = releaseVersion(process.env.PIIK_RELEASE_VERSION, version);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `version=${validated}\n`);
  console.log(`Piik-RTC-v${validated}`);
}
