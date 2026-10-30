import type { IAgoraRTC } from 'agora-rtc-sdk-ng';

let sdk: IAgoraRTC | undefined;
let pending: Promise<IAgoraRTC> | undefined;
export function loadAgoraSdk(): Promise<IAgoraRTC> {
  if (sdk) return Promise.resolve(sdk);
  return pending ??= import('agora-rtc-sdk-ng').then(module => {
    sdk = module.default; sdk.setLogLevel(3); return sdk;
  }).catch(error => { pending = undefined; throw error; });
}
export function getAgoraSdk(): IAgoraRTC {
  if (!sdk) throw new Error('媒体组件尚未初始化，请重新进入房间。');
  return sdk;
}
