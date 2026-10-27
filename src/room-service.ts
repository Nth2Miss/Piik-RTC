import AgoraRTC, { type ILocalAudioTrack, type ILocalVideoTrack, type IRemoteVideoTrack, type UID } from 'agora-rtc-sdk-ng';
import { captureScreen, type CapturedScreen } from './capture';
import { defaults, normalizePreferences, type Preferences } from './preferences';
import { SourceController } from './source-controller';
import { usernameError } from './username';
import type { Participant, Room, RtcProvider } from './types';
import { RtcClient } from './rtc-client';

export interface RoomState {
  view: 'welcome' | 'lobby' | 'room';
  name: string;
  configured: boolean;
  realtime: boolean;
  ready: boolean;
  busy: boolean;
  rooms: Room[];
  room?: Room;
  members: Participant[];
  uid?: number;
  selected?: UID;
  connected: boolean;
  connecting: boolean;
  sharing: boolean;
  video?: ILocalVideoTrack | IRemoteVideoTrack;
  connection: string;
  caption: string;
  notice?: { message: string; error: boolean };
  budgetAlert?: string;
  preferences: Preferences;
  providers: Record<RtcProvider, boolean>;
}
export interface ConnectionSnapshot {
  at: number;
  connected: boolean;
  connecting: boolean;
  connection: string;
  room?: { id: string; isOwner: boolean; members: number };
  network?: { rtt: number; uplinkKbps: number; recvBitrate: number; sendBitrate: number; quality: number };
  local?: {
    width: number; height: number;
    captureFrameRate?: number; sendFrameRate?: number;
    codec?: string; sendBitrate: number; targetBitrate: number;
    rtt: number; encodeDelay?: number;
    hasAudio: boolean; surface: string;
  };
  remote?: {
    uid: number; name: string;
    width: number; height: number;
    receiveFrameRate?: number; decodeFrameRate?: number;
    codec?: string; receiveBitrate: number;
    packetLossRate: number; currentPacketLossRate: number;
    receiveDelay: number; transportDelay: number; endToEndDelay: number;
  };
}
export interface DiagnosticsReport {
  capturedAt: string;
  app: { name: string; sdk: string; secureContext: boolean };
  environment: Record<string, unknown>;
  room: { id: string; name: string; isOwner: boolean; closesAt: number | null } | null;
  session: {
    view: string; uid?: number; selected?: number | string;
    connected: boolean; connecting: boolean; sharing: boolean;
    connection: string; members: { uid: number; name: string; sharing: boolean; isOwner: boolean }[];
  };
  preferences: Preferences;
  media: ConnectionSnapshot;
  rtcStats: unknown;
  localVideoStats: unknown;
  remoteVideoStats: unknown;
  networkQuality: unknown;
  capture: { surface: string; hasAudio: boolean; tracks: { kind: string; enabled: boolean }[] } | null;
  issues: { at: string; kind: string; message: string }[];
}
class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
export function errorText(error: unknown) {
  const e = error as { code?: string; name?: string; message?: string };
  if (e.code === 'PERMISSION_DENIED' || /NotAllowed|cancel|permission denied/i.test(e.message || '')) return '未获得共享权限，请重新选择要分享的画面。';
  if (e.name === 'TimeoutError') return '请求超时，请检查网络或稍后重试。';
  return e.message || '连接失败，请稍后重试。';
}
async function api<T>(url: string, body?: unknown, method?: string): Promise<T> {
  const response = await fetch(url, { method: method || (body === undefined ? 'GET' : 'POST'),
    headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  const data = await response.json();
  if (!response.ok) throw new ApiError(data.error || '请求失败，请稍后重试。', response.status);
  return data;
}
export const inviteUrl = (room: Room) => `${location.origin}/#room=${room.id}`;

/** Agora owns transport. Piik components consume this store through React. */
export function createRoomService() {
  let preferences = { ...defaults }, name = '';
  try { preferences = normalizePreferences(JSON.parse(localStorage.getItem('screen-preferences') || '{}')); name = localStorage.getItem('screen-display-name') || ''; } catch { /* optional storage */ }
  let state: RoomState = { view:'welcome', name, configured:false, realtime:false, ready:false, busy:false, rooms:[], members:[], connected:false, connecting:false, sharing:false, connection:'准备就绪', caption:'选择成员可切换观看，你自己的共享会继续。', preferences, providers:{ agora:false, zego:false, volc:false, volc2:false } };
  const listeners = new Set<() => void>();
  const issues: { at:string; kind:string; message:string }[] = [];
  const redact = (value: string) => value
    .replace(/((?:token|sessionKey|inviteKey|appId|password|secret)\s*[=:]\s*)[^\s,;&"']+/gi, '$1[redacted]')
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[token]');
  function recordIssue(kind: string, message: string) {
    issues.push({ at:new Date().toISOString(), kind, message:redact(String(message)).slice(0, 500) });
    if (issues.length > 50) issues.shift();
  }
  window.addEventListener('error', event => recordIssue('window-error', event.message || '未知错误'));
  window.addEventListener('unhandledrejection', event => {
    const reason = event.reason as { message?: string } | undefined;
    recordIssue('unhandled-rejection', reason?.message || String(event.reason));
  });
  const client = new RtcClient();
  AgoraRTC.setLogLevel(3);
  let joined = false, confirmed = false, attempt = 0, revision = 0, listRevision = 0;
  let sessionKey: string | undefined;
  let participants: Participant[] = [];
  let tracks: (ILocalAudioTrack | ILocalVideoTrack)[] = [];
  let capture: CapturedScreen | undefined;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let heartbeatPending = false, renewing = false;
  let socket: WebSocket | undefined;
  let socketRetry: ReturnType<typeof setTimeout> | undefined;
  let socketDelay = 1000;
  let noticeTimer: ReturnType<typeof setTimeout> | undefined;
  // Media is joined on demand: an empty room with nothing to watch costs nothing.
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let mediaConnecting: Promise<void> | undefined;
  let mediaLeaving: Promise<void> | undefined;
  let mediaRetryAt = 0;
  let mediaIdle = false;
  let presenceSignature = '';
  let quotaLeaseAt = 0;
  let quotaWatchdogBusy = false;
  function members(): Participant[] {
    if (!joined || state.uid === undefined) return [];
    const known = new Map(participants.map(person => [person.uid, person]));
    const result: Participant[] = [{ uid:state.uid, name:state.name, sharing:tracks.length > 0, isOwner:!!state.room?.isOwner }];
    for (const uid of new Set([...known.keys(), ...client.remoteUsers.map(user => Number(user.uid))])) {
      if (uid === state.uid) continue;
      const remote = client.remoteUsers.find(user => user.uid === uid);
      result.push({ uid, name:known.get(uid)?.name || `成员 ${uid}`, sharing:remote ? remote.hasVideo : known.get(uid)?.sharing || false, isOwner:known.get(uid)?.isOwner || false });
    }
    return result;
  }
  function emit(patch: Partial<RoomState> = {}) {
    state = { ...state, ...patch };
    state = { ...state, members:members(), selected:source.selected, sharing:tracks.length > 0 };
    listeners.forEach(listener => listener());
    if (joined && state.room && sessionKey) {
      const signature = JSON.stringify(presencePayload());
      if (signature !== presenceSignature) {
        presenceSignature = signature;
        if (!sendPresence()) void heartbeat();
      }
    }
  }
  function notify(message: string, error = false) {
    if (error) recordIssue('notice', message);
    clearTimeout(noticeTimer); emit({ notice:{ message, error } });
    noticeTimer = setTimeout(() => emit({ notice:undefined }), 9000);
  }
  function notifyClosure(message:string) {
    if (message.includes('达到 500 分钟保护线')) emit({ budgetAlert:message });
    else notify(message, true);
  }
  function connectionSnapshot(): ConnectionSnapshot {
    const snapshot: ConnectionSnapshot = {
      at:Date.now(), connected:state.connected, connecting:state.connecting, connection:state.connection,
      room:state.room ? { id:state.room.id, isOwner:state.room.isOwner, members:state.members.length } : undefined,
    };
    if (!state.connected) return snapshot;
    try {
      const rtc = client.getRTCStats();
      const quality = client.getNetworkQuality();
      snapshot.network = { rtt:Math.round(rtc.RTT || 0), uplinkKbps:Math.round(rtc.OutgoingAvailableBandwidth || 0),
        recvBitrate:Math.round(rtc.RecvBitrate || 0), sendBitrate:Math.round(rtc.SendBitrate || 0),
        quality:quality.uplinkNetworkQuality };
    } catch { /* stats are unavailable until media connects */ }
    if (tracks.length) {
      try {
        const stats = client.getLocalVideoStats();
        snapshot.local = {
          width:Math.round(stats.sendResolutionWidth || stats.captureResolutionWidth || 0),
          height:Math.round(stats.sendResolutionHeight || stats.captureResolutionHeight || 0),
          captureFrameRate:stats.captureFrameRate, sendFrameRate:stats.sendFrameRate,
          codec:stats.codecType, sendBitrate:Math.round(stats.sendBitrate || 0),
          targetBitrate:Math.round(stats.targetSendBitrate || 0),
          rtt:Math.round(stats.sendRttMs || 0), encodeDelay:stats.encodeDelay,
          hasAudio:!!capture?.hasAudio, surface:capture?.surface || 'unknown',
        };
      } catch { /* not publishing video */ }
    }
    if (state.selected !== undefined && state.selected !== state.uid) {
      try {
        const stats = client.getRemoteVideoStats()[String(state.selected)];
        if (stats) {
          const person = state.members.find(member => member.uid === state.selected);
          snapshot.remote = {
            uid:Number(state.selected), name:person?.name || `成员 ${state.selected}`,
            width:Math.round(stats.receiveResolutionWidth || 0), height:Math.round(stats.receiveResolutionHeight || 0),
            receiveFrameRate:stats.receiveFrameRate, decodeFrameRate:stats.decodeFrameRate,
            codec:stats.codecType, receiveBitrate:Math.round(stats.receiveBitrate || 0),
            packetLossRate:stats.packetLossRate || 0, currentPacketLossRate:stats.currentPacketLossRate || 0,
            receiveDelay:Math.round(stats.receiveDelay || 0), transportDelay:Math.round(stats.transportDelay || 0),
            endToEndDelay:Math.round(stats.end2EndDelay || 0),
          };
        }
      } catch { /* not subscribed yet */ }
    }
    return snapshot;
  }
  function collectDiagnostics(): DiagnosticsReport {
    const attempt = <T,>(read: () => T): T | { unavailable:string } => {
      try { return read(); } catch (error) { return { unavailable:errorText(error) }; }
    };
    const navigation = navigator as Navigator & { deviceMemory?: number };
    return {
      capturedAt:new Date().toISOString(),
      app:{ name:'piik-sw', sdk:state.room?.provider && state.room.provider !== 'agora' ? state.room.provider : `agora ${AgoraRTC.VERSION}`, secureContext:window.isSecureContext },
      environment:{
        userAgent:navigator.userAgent, platform:navigator.platform, language:navigator.language,
        languages:[...navigator.languages], hardwareConcurrency:navigator.hardwareConcurrency,
        deviceMemory:navigation.deviceMemory,
        screen:{ width:screen.width, height:screen.height, availWidth:screen.availWidth, availHeight:screen.availHeight },
        devicePixelRatio:window.devicePixelRatio, online:navigator.onLine, visibility:document.visibilityState,
      },
      room:state.room ? { id:state.room.id, name:state.room.name, isOwner:state.room.isOwner, closesAt:state.room.closesAt } : null,
      session:{
        view:state.view, uid:state.uid, selected:state.selected,
        connected:state.connected, connecting:state.connecting, sharing:state.sharing, connection:state.connection,
        members:state.members.map(({ uid, name, sharing, isOwner }) => ({ uid, name, sharing, isOwner })),
      },
      preferences:state.preferences,
      media:connectionSnapshot(),
      rtcStats:state.connected ? attempt(() => client.getRTCStats()) : null,
      localVideoStats:tracks.length ? attempt(() => client.getLocalVideoStats()) : null,
      remoteVideoStats:state.connected ? attempt(() => client.getRemoteVideoStats()) : null,
      networkQuality:state.connected ? attempt(() => client.getNetworkQuality()) : null,
      capture:capture ? { surface:capture.surface, hasAudio:capture.hasAudio,
        tracks:tracks.map(track => ({ kind:track.trackMediaType, enabled:track.enabled })) } : null,
      issues:[...issues],
    };
  }
  function exportDiagnostics() {
    const blob = new Blob([JSON.stringify(collectDiagnostics(), null, 2)], { type:'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `piik-sw-diagnostics-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    notify('诊断信息已导出，可附在问题反馈中。');
  }
  const source = new SourceController({ client: client as any,
    remote:uid => client.remoteUsers.find(user => user.uid === uid),
    video:video => emit({ video }), empty:() => emit({ video:undefined }),
    error:error => notify(`切换画面失败：${errorText(error)}`, true),
  });
  source.setAudio(preferences.volume, preferences.muted);
  async function run(action: () => Promise<void>): Promise<boolean> {
    if (state.busy) return false;
    emit({ busy:true });
    try { await action(); return true; }
    catch (error) { notify(errorText(error), true); return false; }
    finally { emit({ busy:false }); }
  }
  async function select(uid?: UID) {
    if (uid !== undefined && !state.connected) {
      const target = members().find(person => person.uid === uid);
      if (!target?.sharing) {
        notify(uid === state.uid ? '你还没有开始共享，点击“开始共享”选择画面。' : '对方暂未共享画面。');
        return;
      }
      try { await connectMedia(); }
      catch (error) { notify(errorText(error), true); return; }
      if (!state.connected) return;
    }
    const pending = source.select(uid); emit(); await pending; emit();
  }
  function fallback() { void select(members().find(person => person.uid !== source.selected && person.sharing)?.uid); }
  async function token() {
    if (!state.room) throw new Error('请先选择房间。');
    const result = await api<{ appId:string; token:string; uid:number; sessionKey:string; room:Room; displayName:string }>(`/api/rooms/${state.room.id}/token`, { sessionKey });
    sessionKey = result.sessionKey;
    emit({ uid:result.uid, room:result.room, name:result.displayName });
    return result;
  }
  function scheduleHeartbeat() {
    clearInterval(heartbeatTimer); heartbeatTimer = undefined;
    if (!joined || socket?.readyState === WebSocket.OPEN) return;
    heartbeatTimer = setInterval(() => {
      if (socket?.readyState === WebSocket.OPEN) { clearInterval(heartbeatTimer); heartbeatTimer = undefined; return; }
      void heartbeat();
    }, 30000);
  }
  function reactToParticipants(next: Participant[]) {
    const sharer = next.find(person => person.sharing && person.uid !== state.uid);
    if (sharer) {
      cancelIdleDisconnect();
      if (!state.connected && Date.now() > mediaRetryAt) {
        void connectMedia().then(() => { if (state.connected) void select(sharer.uid); }).catch(() => { mediaRetryAt = Date.now() + 30000; });
      }
    } else if (!tracks.length) {
      scheduleIdleDisconnect();
    }
  }
  function presencePayload() {
    const dimensions = (track:any) => {
      try { const settings = track?.getMediaStreamTrack?.().getSettings(); return { width:settings?.width || 0, height:settings?.height || 0 }; }
      catch { return { width:0, height:0 }; }
    };
    const receive = dimensions(state.video), publish = dimensions(tracks.find(track => track.trackMediaType === 'video'));
    // Keep accounting during reconnection while a published or selected stream may still be billed.
    return { sharing:tracks.length > 0, media:{ connected:state.connected || state.connecting || tracks.length > 0 || source.selected !== undefined, selected:typeof source.selected === 'number' ? source.selected : undefined,
      width:receive.width, height:receive.height, publishWidth:publish.width, publishHeight:publish.height, pulls:client.zegoPulls } };
  }
  function sendPresence() {
    if (!socket || socket.readyState !== WebSocket.OPEN || !state.room) return false;
    socket.send(JSON.stringify({ type:'presence', ...presencePayload() }));
    return true;
  }
  function openSocket() {
    if (!state.realtime || !joined || !state.room || !sessionKey || socket) return;
    const roomId = state.room.id;
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    socket = ws;
    ws.onopen = () => {
      if (ws !== socket) { ws.close(); return; }
      socketDelay = 1000;
      clearInterval(heartbeatTimer); heartbeatTimer = undefined;
      if (joined && sessionKey) { ws.send(JSON.stringify({ type:'subscribe', roomId, sessionKey })); sendPresence(); }
    };
    ws.onmessage = event => {
      if (ws !== socket) return;
      let message: { type?: string; participants?: Participant[]; room?: Room; reason?:string; quotaHealthy?:boolean };
      try { message = JSON.parse(String(event.data)); } catch { return; }
      if (message.type === 'room' && message.room?.id === state.room?.id && Array.isArray(message.participants)) {
        if (message.quotaHealthy) quotaLeaseAt = Date.now();
        participants = message.participants;
        emit({ room:message.room });
        reactToParticipants(message.participants);
      } else if (message.type === 'quota-lease') {
        quotaLeaseAt = Date.now();
      } else if (message.type === 'closed') {
        closeSocket();
        notifyClosure(message.reason || '房间已关闭，请选择其他房间。');
        void leave().then(() => refreshRooms());
      } else if (message.type === 'expired') {
        closeSocket();
        notify('会话已失效，请重新进入房间。', true);
        void leave().then(() => refreshRooms());
      }
    };
    ws.onclose = () => {
      if (socket === ws) socket = undefined;
      if (!joined) return;
      scheduleHeartbeat();
      if (socketRetry) return;
      socketRetry = setTimeout(() => { socketRetry = undefined; openSocket(); }, socketDelay);
      socketDelay = Math.min(socketDelay * 2, 30000);
    };
    ws.onerror = () => { ws.close(); };
  }
  function closeSocket() {
    clearTimeout(socketRetry); socketRetry = undefined;
    const ws = socket; socket = undefined;
    if (ws) { ws.onclose = null; ws.close(); }
  }
  async function heartbeat() {
    if (!joined || !state.room || !sessionKey || heartbeatPending) return;
    if (sendPresence()) return;
    const id = state.room.id, key = sessionKey, version = revision;
    heartbeatPending = true;
    try {
      const result = await api<{ participants:Participant[]; room:Room; quotaHealthy:boolean }>(`/api/rooms/${id}/presence`, { sessionKey:key, ...presencePayload() });
      if (version !== revision || key !== sessionKey) return;
      if (result.quotaHealthy) quotaLeaseAt = Date.now();
      participants = result.participants; emit({ room:result.room });
      reactToParticipants(result.participants);
    } catch (error) {
      if (version === revision && key === sessionKey && error instanceof ApiError && [403,404].includes(error.status)) {
        notifyClosure(errorText(error)); await leave(); await refreshRooms();
      }
    } finally { heartbeatPending = false; }
  }
  function cancelIdleDisconnect() {
    clearTimeout(idleTimer); idleTimer = undefined;
  }
  function scheduleIdleDisconnect() {
    if (idleTimer || !joined || !state.connected || tracks.length) return;
    idleTimer = setTimeout(() => {
      idleTimer = undefined;
      if (!joined || !state.connected || tracks.length) return;
      if (client.remoteUsers.some(user => user.hasVideo)) return;
      void disconnectMedia();
    }, 60_000);
  }
  async function disconnectMedia() {
    if (!joined || !state.connected || tracks.length) return;
    mediaIdle = true;
    emit({ connected:false });
    mediaLeaving = (async () => {
      await source.select(undefined);
      try { await client.leave(); } catch { /* already disconnected */ }
      emit({ video:undefined, connection:'等待共享' });
    })();
    try { await mediaLeaving; } finally { mediaLeaving = undefined; }
  }
  async function connectMedia() {
    if (!joined) return;
    if (mediaLeaving) await mediaLeaving;
    if (!joined || state.connected) return;
    if (mediaConnecting) return mediaConnecting;
    const current = ++attempt;
    mediaIdle = false;
    emit({ connecting:true });
    mediaConnecting = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await token();
        if (current !== attempt || !joined) return;
        await Promise.race([client.join(result.appId, state.room!.id, result.token, result.uid), new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('媒体连接超时，请检查网络后重试。')), 25000);
        })]);
        if (current !== attempt || !joined) return;
        cancelIdleDisconnect(); mediaRetryAt = 0;
        emit({ connected:true });
        const first = source.selected ?? client.remoteUsers.find(user => user.hasVideo)?.uid;
        if (first !== undefined) void select(first);
      } catch (error) {
        if (current !== attempt) return;
        await source.select(undefined); await client.leave().catch(() => {});
        emit({ connected:false }); throw error;
      } finally { clearTimeout(timer); if (current === attempt) emit({ connecting:false }); }
    })();
    try { await mediaConnecting; } finally { mediaConnecting = undefined; }
  }
  async function stop(switchSource = true) {
    const old = tracks; tracks = [];
    if (state.uid !== undefined) source.setLocal(state.uid);
    if (source.selected === state.uid) await source.select(switchSource ? members().find(person => person.uid !== state.uid && person.sharing)?.uid : undefined);
    if (old.length) {
      try { if (state.connected) await client.unpublish(old); } catch { /* release capture anyway */ }
      if (capture) capture.close(); else old.forEach(track => { track.stop(); track.close(); });
      capture = undefined;
    }
    emit({ caption:'你的共享已停止，其他成员的共享继续进行。' });
    if (switchSource && state.connected && !client.remoteUsers.some(user => user.hasVideo)) scheduleIdleDisconnect();
    if (switchSource) void heartbeat();
  }
  async function leave() {
    closeSocket();
    attempt++; revision++; clearInterval(heartbeatTimer); heartbeatTimer = undefined;
    cancelIdleDisconnect(); mediaIdle = false; source.setPaused(false);
    const room = state.room, key = sessionKey;
    await stop(false); await source.select(undefined);
    cancelIdleDisconnect();
    try { await client.leave(); }
    finally {
      joined = false; participants = []; sessionKey = undefined; presenceSignature = ''; quotaLeaseAt = 0;
      if (room && key) await api(`/api/rooms/${room.id}/leave`, { sessionKey:key }).catch(() => {});
      history.replaceState(null, '', '/');
      emit({ view:'lobby', room:undefined, uid:undefined, video:undefined, connected:false, connecting:false });
    }
  }
  async function enter(room: Room) {
    if (!confirmed || (joined && state.room?.id === room.id)) return;
    if (joined) await leave();
    await client.setProvider(room.provider || 'agora');
    emit({ room });
    try {
      await token(); joined = true; revision++; participants = []; mediaIdle = true; quotaLeaseAt = Date.now();
      emit({ view:'room', connection:'等待共享', caption:'选择成员可切换观看，你自己的共享会继续。' });
      history.replaceState(null, '', `/#room=${room.id}`);
      await heartbeat();
      if (!joined) return;
      scheduleHeartbeat();
      openSocket();
    } catch (error) { emit({ view:'lobby', room:undefined }); throw error; }
  }
  async function refreshRooms() {
    if (!confirmed) return;
    const current = ++listRevision;
    const result = await api<{ rooms:Room[] }>('/api/rooms');
    if (current !== listRevision) return;
    const active = result.rooms.find(room => room.id === state.room?.id);
    if (state.room && !active && !state.busy) {
      let reason = '房间已关闭，请选择其他房间。';
      try { await api<Room>(`/api/rooms/${state.room.id}`); } catch (error) { reason = errorText(error); }
      await leave(); notifyClosure(reason);
    }
    emit({ rooms:result.rooms, ...(active ? { room:active } : {}) });
  }
  async function confirm(value: string) {
    const trimmed = value.trim();
    const invalid = usernameError(trimmed);
    if (invalid) throw new Error(invalid);
    const profile = await api<{name:string}>('/api/profile', { name:trimmed.slice(0, 24) });
    confirmed = true; emit({ name:profile.name, view:'lobby' });
    try { localStorage.setItem('screen-display-name', profile.name); } catch { /* optional storage */ }
    await refreshRooms();
    const id = new URLSearchParams(location.hash.slice(1)).get('room');
    if (id && /^[a-f0-9]{12}$/.test(id)) await enter(await api<Room>(`/api/rooms/${id}`));
  }
  async function share() {
    if (!window.isSecureContext || !navigator.mediaDevices?.getDisplayMedia) throw new Error('请在桌面 Chrome / Edge 中，通过 localhost 或 HTTPS 共享。');
    // Capture first: getDisplayMedia must run while the click's activation is still valid.
    const isZego = state.room?.provider === 'zego';
    const sharePreferences = isZego && state.preferences.resolution === '1440' ? { ...state.preferences, resolution:'1080' as const } : state.preferences;
    const next = await captureScreen(sharePreferences, AgoraRTC, undefined, undefined, isZego);
    const video = next.tracks[0] as ILocalVideoTrack;
    let ended = false;
    next.onEnded(() => { ended = true; if (tracks.includes(video)) void stop(); });
    try {
      if (!state.connected) await connectMedia();
      if (ended || !joined || !state.connected) throw new Error('共享已停止，请重新选择。');
      cancelIdleDisconnect();
      await client.publish(next.tracks);
      if (ended || !joined) { await client.unpublish(next.tracks).catch(() => {}); throw new Error('共享已停止，请重新选择。'); }
      tracks = next.tracks; capture = next; source.setLocal(state.uid!, video);
      await source.select(state.uid);
      const audio = next.surface === 'monitor' ? '系统' : next.surface === 'window' ? '窗口' : '标签页';
      emit({ caption:`${sharePreferences.resolution}p · ${sharePreferences.fps} fps · ${next.hasAudio ? `含${audio}音频` : '仅画面'}，切换观看会保留你的共享。` });
      if (state.preferences.audio && !next.hasAudio) notify(`未获得${audio}音轨，本次仅共享画面。请在浏览器选择器中勾选共享音频。`);
      void heartbeat();
    } catch (error) { next.close(); throw error; }
  }
  client.on('connection-state-change', (connection:string) => {
    emit({ connection:({ CONNECTED:'媒体已连接', CONNECTING:'正在连接媒体…', RECONNECTING:'正在重连…', DISCONNECTING:'正在断开…', DISCONNECTED: mediaIdle ? '等待共享' : '媒体未连接' } as Record<string,string>)[connection], ...(connection === 'DISCONNECTED' ? { connected:false } : connection === 'CONNECTED' ? { connected:true } : {}) });
  });
  client.on('user-joined', () => { emit(); void heartbeat(); });
  client.on('billing-change', () => emit());
  client.on('user-published', (user:any, kind:string) => {
    if (kind !== 'video' && kind !== 'audio') return;
    if (source.selected === user.uid || (kind === 'video' && source.selected === undefined)) void select(user.uid);
    emit(); void heartbeat();
  });
  client.on('user-unpublished', (user:any, kind:string) => {
    if (source.selected === user.uid) { if (kind === 'video') fallback(); else void select(user.uid); }
    emit();
  });
  client.on('user-left', (user:any) => { if (source.selected === user.uid) fallback(); emit(); void heartbeat(); });
  async function renew() {
    if (!joined || renewing) return; renewing = true;
    try {
      const result = await token();
      if (state.connected) await client.renewToken(result.token);
    }
    catch (error) { notify(`续期失败：${errorText(error)}`, true); await leave(); }
    finally { renewing = false; }
  }
  client.on('token-privilege-will-expire', () => void renew());
  client.on('token-privilege-did-expire', () => void renew());
  AgoraRTC.onAutoplayFailed = () => { notify('点击页面可开启当前共享的声音。'); document.addEventListener('click', () => source.resumeAudio(), { once:true }); };
  const listTimer = setInterval(() => { if (confirmed && !state.busy && !document.hidden) void refreshRooms().catch(() => {}); }, 30000);
  // Stream tracks and their received resolution may change without a UI event.
  const mediaReport = setInterval(() => {
    if (!joined || !state.room || !sessionKey || state.room.provider !== 'zego') return;
    const signature = JSON.stringify(presencePayload());
    if (signature !== presenceSignature) {
      presenceSignature = signature;
      if (!sendPresence()) void heartbeat();
    }
  }, 10000);
  const quotaWatchdog = setInterval(() => {
    if (!joined || !(state.connected || state.connecting || tracks.length || source.selected !== undefined) || quotaWatchdogBusy || !quotaLeaseAt || Date.now() - quotaLeaseAt <= 60000) return;
    quotaWatchdogBusy = true;
    void (async () => {
      attempt++; cancelIdleDisconnect(); mediaIdle = true;
      await stop(false); await source.select(undefined); await client.leave().catch(() => {});
      emit({ connected:false, connecting:false, video:undefined, connection:'监控连接中断' });
      notify('余量监控连接中断，已停止媒体连接，请检查网络后重新开始共享。', true);
    })().finally(() => { quotaWatchdogBusy = false; });
  }, 15000);
  document.addEventListener('visibilitychange', () => {
    if (!joined) return;
    if (document.hidden) { scheduleHeartbeat(); return; }
    openSocket(); void heartbeat(); scheduleHeartbeat();
  });
  window.addEventListener('pagehide', () => {
    closeSocket();
    clearInterval(listTimer); clearInterval(mediaReport); clearInterval(quotaWatchdog); clearInterval(heartbeatTimer); clearTimeout(idleTimer); capture?.close();
    if (state.room && sessionKey) navigator.sendBeacon(`/api/rooms/${state.room.id}/leave`, new Blob([JSON.stringify({ sessionKey })], { type:'application/json' }));
    void client.leave();
  });
  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getSnapshot:() => state,
    async initialize() {
      let saved = name;
      try {
        const [config, profile] = await Promise.all([
          api<{configured:boolean; realtime?:boolean; providers:RoomState['providers']}>('/api/config'),
          api<{name:string|null}>('/api/profile'),
        ]);
        saved = profile.name || saved;
        emit({ configured:config.configured, realtime:config.realtime === true, providers:config.providers, name:saved });
      }
      catch (error) { notify(errorText(error), true); }
      finally { emit({ ready:true }); }
      if (!saved) return;
      try { await confirm(saved); }
      catch (error) {
        if (usernameError(saved)) emit({ name:saved });
        notify(errorText(error), true);
      }
    },
    confirmName:(value: string) => run(() => confirm(value)),
    refresh:() => run(async () => {
      if (joined) await heartbeat();
      await refreshRooms();
    }),
    join:(room:Room) => run(() => enter(room)),
    joinInvite:(value:string) => run(async () => {
      const url = new URL(value), id = new URLSearchParams(url.hash.slice(1)).get('room');
      if (url.origin !== location.origin || !/^[a-f0-9]{12}$/.test(id || '')) throw new Error('请使用本站生成的完整邀请链接。');
      await enter(await api<Room>(`/api/rooms/${id}`));
    }),
    saveRoom:(fields:{name:string;description:string;provider?:RtcProvider}, room?:Room) => run(async () => {
      const saved = await api<Room>(room ? `/api/rooms/${room.id}` : '/api/rooms', fields, room ? 'PATCH' : 'POST');
      if (room) emit({ room:saved }); else await enter(saved);
      await refreshRooms();
    }),
    removeRoom:(room:Room) => run(async () => {
      if (state.room?.id === room.id) await leave();
      await api(`/api/rooms/${room.id}`, {}, 'DELETE'); await refreshRooms();
    }),
    leave:() => run(async () => { await leave(); await refreshRooms(); }),
    changeName:() => run(async () => { if (joined) await leave(); confirmed = false; emit({ view:'welcome' }); }),
    share:() => run(share), stop:() => run(() => stop()), select,
    setPlaybackPaused: (paused: boolean) => source.setPaused(paused),
    savePreferences(value:Preferences) {
      const preferences = normalizePreferences(value);
      source.setAudio(preferences.volume, preferences.muted);
      try { localStorage.setItem('screen-preferences', JSON.stringify(preferences)); } catch { /* optional storage */ }
      emit({ preferences });
    },
    async copyInvite() {
      if (!state.room) return;
      try { await navigator.clipboard.writeText(inviteUrl(state.room)); notify('房间邀请链接已复制。'); }
      catch { notify('无法自动复制，请从房间信息中手动复制邀请链接。', true); }
    },
    dismissNotice:() => emit({ notice:undefined }),
    dismissBudgetAlert:() => emit({ budgetAlert:undefined }),
    getConnectionSnapshot: connectionSnapshot,
    exportDiagnostics,
  };
}
export type RoomService = ReturnType<typeof createRoomService>;
