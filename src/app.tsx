import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { StageOverlay, StageTv } from './vendor/piik/src/client/components/living/Stage';
import { Couch, type CouchEntry } from './vendor/piik/src/client/components/living/Couch';
import { BrandMark } from './vendor/piik/src/client/components/living/BrandMark';
import { Btn, Chip, NameTag, Row, SwitchItem } from './vendor/piik/src/client/components/living/primitives';
import { SharingSettings } from './vendor/piik/src/client/components/living/SharingSettings';
import { QualityTileGlyph } from './vendor/piik/src/client/components/living/QualityTileGlyph';
import { LanguageControl } from './vendor/piik/src/client/components/living/LanguageControl';
import { Glyph, type GlyphName } from './vendor/piik/src/client/ui/icons';
import { useCopy } from './vendor/piik/src/client/ui/copy';
import { applyTheme, currentTheme, subscribeTheme } from './vendor/piik/src/client/ui/theme';
import { automaticBitrate, defaults, ZEGO_MAX_BITRATE, type Preferences } from './preferences';
import { errorText, inviteUrl, type ConnectionSnapshot, type RoomService, type RoomState } from './room-service';
import { DesktopCapturePicker } from './desktop/CapturePicker.tsx';
import { isDesktopApp, desktopBridge, type CaptureSelection, type DesktopNativeComponentProgress, type DesktopNativeComponentStatus, type DesktopUpdateProgress, type DesktopUpdateStatus } from './desktop/bridge.ts';
import { useNativeComponent, setNativeComponentStatus } from './desktop/native-component.ts';
import { usernameError } from './username';
import type { Room, RtcProvider } from './types';
import { PlaybackSampler, formatFps } from './playback-stats';

const appVersion = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev';

type Usage = { status:string; total?:number; used?:number; remaining?:number; unit?:string; from?:string; to?:string; packages?:number; estimated?:boolean; localUsed?:number; basis?:string; supplier?:Usage; kind?:string; queriedFrom?:string; missingDays?:string[]; delayHours?:number };
type ServiceStatus = Record<RtcProvider, Usage> & { updatedAt:string; cacheSeconds:number };
const providerNames = { volc:'火山引擎 1', volc2:'火山引擎 2', agora:'声网', zego:'即构 ZEGO' } as const;
const providerKeys:readonly RtcProvider[] = ['volc','volc2','agora','zego'];
const recommendedProviders:ReadonlySet<RtcProvider> = new Set(['volc','volc2']);
const lowBalance = (usage?:Usage) => usage?.status === 'ok' && typeof usage.remaining === 'number' && Number.isFinite(usage.remaining) && usage.remaining <= 500;
const formatAmount = (value?:number) => value === undefined ? '—' : (value <= 500 ? Math.floor(value * 100) / 100 : value).toLocaleString('zh-CN', { maximumFractionDigits:2 });
const usageMessage = (usage?:Usage) => !usage ? '正在查询…' : usage.status === 'unconfigured' ? '尚未配置查询凭据' : usage.status === 'auth_expired' ? '控制台登录已失效，请更新 Cookie' : usage.status === 'forbidden' ? '缺少火山 RTC 用量查询权限（rtc:ListUsages）' : usage.status === 'unavailable' ? '余量查询暂未接入' : '查询失败或数据无法换算';
function useServiceStatus(enabled = true) {
  const [data, setData] = useState<ServiceStatus>();
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const update = () => {
      fetch('/api/service-status', { signal:controller.signal }).then(response => {
        if (!response.ok) throw new Error('查询失败');
        return response.json() as Promise<ServiceStatus>;
      }).then(result => { setData(result); setError(false); }).catch(() => { if (!controller.signal.aborted) setError(true); });
    };
    setError(false); update();
    const timer = setInterval(update, 30000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [enabled, revision]);
  return { data, error, refresh:() => setRevision(value => value + 1) };
}
function UsageProgress({ name, usage }: { name:string; usage:Usage }) {
  const available = usage.status === 'ok' && typeof usage.remaining === 'number' && typeof usage.total === 'number' && usage.total > 0;
  if (!available) return <div className="sw-usage-progress is-empty" aria-label={`${name}余量暂无数据`} />;
  const percentage = Math.max(0, Math.min(100, usage.remaining! / usage.total! * 100));
  const level = lowBalance(usage) || percentage <= 20 ? 'low' : percentage <= 50 ? 'medium' : 'high';
  return <div className={`sw-usage-progress is-${level}`} role="progressbar" aria-label={`${name}剩余额度`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(percentage)} aria-valuetext={`预计剩余 ${formatAmount(usage.remaining)} ${usage.unit || '分钟'}`}><span style={{ width:`${percentage}%` }}/></div>;
}
function UsageDetails({ name, usage, queriedAt }: {name:string; usage:Usage; queriedAt?:string}) {
  const supplier = usage.supplier;
  const unit = usage.unit || '分钟';
  const usageEstimate = supplier?.kind === 'usage_estimate';
  const consoleQuota = supplier?.kind === 'console_quota';
  return <div className="sw-usage-details"><section><h4>{usageEstimate ? '供应商用量统计' : consoleQuota ? '控制台免费余量' : '供应商查询'}</h4><UsageProgress name={`${name}服务商`} usage={supplier || {status:'unavailable'}}/>{supplier?.status === 'ok' || (usageEstimate && supplier?.status === 'partial') ? <dl>{supplier.remaining !== undefined && <><dt>{usageEstimate ? '估算剩余' : '剩余'}</dt><dd>{formatAmount(supplier.remaining)} {supplier.unit || unit}</dd><dt>{usageEstimate || consoleQuota ? '每月估算额度' : '总额度'}</dt><dd>{formatAmount(supplier.total)} {supplier.unit || unit}</dd></>}{supplier.used !== undefined && <><dt>{usageEstimate ? '已统计用量' : consoleQuota ? '推算已用' : '已用'}</dt><dd>{formatAmount(supplier.used)} {supplier.unit || unit}</dd></>}{supplier.packages !== undefined && <><dt>有效资源包</dt><dd>{supplier.packages} 个</dd></>}</dl> : <p className="sw-connection-empty">{usageMessage(supplier)}</p>}</section>
    <section><h4>本地估算与保护</h4><UsageProgress name={`${name}本地估算`} usage={usage}/><dl><dt>预计可用</dt><dd>{formatAmount(usage.remaining)} {unit}</dd><dt>本月本地用量</dt><dd>{formatAmount(usage.localUsed)} {unit}</dd></dl><p className="sw-connection-empty">{usage.basis || '等待数据'}</p>{lowBalance(usage) && <p className="sw-usage-warning">已达到 500 分钟保护线，暂不可选择。</p>}</section>
    <p className="sw-usage-note">{usageEstimate ? <>来源：供应商用量统计。{supplier.from && supplier.to && ` 查询范围：${supplier.from} 至 ${supplier.to}。`}{supplier.delayHours !== undefined && ` 数据约延迟 ${supplier.delayHours} 小时。`} 余量按每月 10,000 分钟推算。{supplier.missingDays?.length ? ` 缺少 ${supplier.missingDays.join('、')}，无法计算完整月度余量。` : ''}</> : consoleQuota ? '来源：即构控制台当月免费余量；总额度及已用量按每月 10,000 分钟推算。' : '供应商查询结果暂不可用。'}{queriedAt && ` 本系统查询时间：${new Date(queriedAt).toLocaleString('zh-CN')}。`}</p></div>;
}
function ServiceStatusPage({ providers, ready, room }: {providers:RoomState['providers']; ready:boolean; room?:Room}) {
  const { data, error, refresh } = useServiceStatus();
  const configured = providerKeys.filter(key => providers[key]);
  return <main className="lr-room sw-lobby"><header className="sw-lobby-heading"><div><h1>服务状态</h1><p>查看各 RTC 服务的用量和资源包余量。</p></div><div className="sw-status-actions"><a className="lr-btn" href={room ? `#room=${room.id}` : '#'}><Glyph name="chevron" size={14} className="lr-home-arrow"/><span className="lr-cap">{room ? '返回房间' : '返回大厅'}</span></a><Action icon="refresh" onClick={refresh}>刷新</Action></div></header>
    {(!ready || (!data && !error)) && <p>正在查询…</p>}{error && <p role="alert">状态查询失败，请稍后重试。</p>}{ready && !configured.length && <p>暂无已配置的 RTC 服务商。</p>}
    <div className="sw-connection-grid">{data && configured.map(key => <section className="sw-connection-card sw-usage-card" key={key}><h3>{providerNames[key]}</h3><UsageDetails name={providerNames[key]} usage={data[key]} queriedAt={data.updatedAt}/></section>)}</div>
    {configured.length > 0 && <p className="sw-settings-note">上方为供应商查询数据，下方是用于房间保护的本地估算。火山数据按应用统计，不等于资源包实际余额，最终以账单为准。部分服务商未取得供应商余量时按每月 10,000 分钟估算。预计剩余达到或低于 500 分钟时关闭该服务商的房间。{data && ` 供应商数据更新于 ${new Date(data.updatedAt).toLocaleString('zh-CN')}，缓存 ${data.cacheSeconds} 秒。`}</p>}</main>;
}

function Action({ icon, children, onClick, disabled, primary, danger, type = 'button', label }: {
  icon:GlyphName; children?:ReactNode; onClick?:() => void; disabled?:boolean; primary?:boolean; danger?:boolean; type?:'button'|'submit'; label?:string;
}) {
  return <button type={type} className={`lr-btn${primary ? ' is-primary' : ''}${danger ? ' is-danger' : ''}`} onClick={onClick} disabled={disabled} aria-label={label}><Glyph name={icon}/>{children && <span className="lr-cap">{children}</span>}</button>;
}
function Modal({ title, children, close, wide = false }: { title:string; children:ReactNode; close:() => void; wide?:boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); }, []);
  return <dialog ref={ref} className={`sw-dialog${wide ? ' is-wide' : ''}`} onCancel={event => { event.preventDefault(); close(); }} onClick={event => {
    if (event.target !== event.currentTarget) return;
    const box = event.currentTarget.getBoundingClientRect();
    if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) close();
  }} aria-label={title}><header className="sw-dialog-heading"><h2>{title}</h2><Action icon="x" onClick={close} label="关闭"/></header>{children}</dialog>;
}
function Header({ state, service, help }: { state:RoomState; service:RoomService; help:() => void }) {
  const theme = useSyncExternalStore(subscribeTheme, currentTheme);
  const { t } = useCopy();
  return <header className="lr-top"><button className="lr-brand" aria-label={state.view === 'room' ? '返回房间大厅' : 'Piik-RTC'} onClick={() => { if (state.view === 'room') void service.leave(); }} disabled={state.busy}>
    {state.view === 'room' && <Glyph name="chevron" size={14} className="lr-home-arrow"/>}<BrandMark size={34} motion="once"/>
  </button><span className="lr-top-right">
    {state.view === 'room' && <span className="sw-header-provider" data-state={state.connecting || state.connection === '正在重连…' ? 'busy' : state.connected ? 'live' : 'warn'} role="status" aria-label={`当前服务商：${providerNames[state.room?.provider || 'agora']}，${state.connection}`} title={state.connection}><span className="lr-connection-dots" aria-hidden="true"><i/><i/><i/></span>{providerNames[state.room?.provider || 'agora']}</span>}
    {state.view !== 'welcome' && <button className="sw-header-name" onClick={() => void service.changeName()} disabled={state.busy} aria-label="更改用户名"><NameTag name={state.name} identity={String(state.uid || state.name)}/></button>}
    <span className="lr-top-right lr-header-controls">{state.view !== 'room' && <a className="lr-btn is-compact sw-status-link" href="#status" aria-label="服务状态"><Glyph name="gauge"/><span className="lr-cap">服务状态</span></a>}<LanguageControl/><button className="lr-btn is-compact lr-theme-toggle" onClick={() => applyTheme(theme === 'dark' ? 'light' : 'dark')} aria-label={t(theme === 'dark' ? 'theme.light' : 'theme.dark')}><Glyph name={theme === 'dark' ? 'sun' : 'moon'} size={16}/><span className="lr-cap">{t(theme === 'dark' ? 'theme.light.short' : 'theme.dark.short')}</span></button><button className="lr-btn is-compact is-quiet" onClick={help} aria-label="使用帮助"><Glyph name="help"/></button></span>
  </span></header>;
}
function Welcome({ state, service }: { state:RoomState; service:RoomService }) {
  const [name, setName] = useState(state.name);
  const [error, setError] = useState<string | null>(() => state.name ? usernameError(state.name) : null);
  return <main className="lr-client-launch"><form className="lr-client-launch-panel" onSubmit={event => { event.preventDefault(); const invalid = usernameError(name); if (invalid) { setError(invalid); return; } void service.confirmName(name); }}>
    <header className="lr-client-launch-heading"><div className="lr-client-launch-brand"><BrandMark size={64} motion="once"/><h1 className="lr-client-launch-title">Piik-RTC<span className="lr-client-brand-dot">.</span><small>屏幕共享</small></h1></div><p className="lr-welcome is-still"><span className="lr-welcome-text">不同的屏幕，同一个小客厅。</span></p></header>
    <section className="lr-client-standby sw-name-entry"><Glyph name="couch" size={30}/><h2>先认识一下，再一起分享。</h2><label className="lr-input"><Glyph name="users"/><input name="username" aria-label="你的用户名" autoComplete="nickname" autoFocus required maxLength={24} value={name} onChange={event => { setName(event.target.value); setError(null); }} placeholder="大家该怎么称呼你？" disabled={state.busy}/></label>{error && <p className="sw-field-error" role="alert">{error}</p>}<Action icon="arrowRight" primary type="submit" disabled={state.busy || !state.ready || !name.trim()}>进入房间大厅</Action></section>
    <p className="sw-footnote">无需注册 · 同一房间内用户名不可重复 · 房间连续无人 15 分钟后自动关闭</p>
  </form></main>;
}
function RoomGlyph() {
  return <svg className="lr-glyph" width={28} height={28} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><rect pathLength={1} x="2" y="5" width="20" height="14" rx="2"/><path pathLength={1} d="M8 2l4 3 4-3"/><path d="M10 9.5v5l4.5-2.5Z" fill="currentColor" stroke="none"/></svg>;
}
function GitHubMark() {
  return <svg className="lr-glyph" width={18} height={18} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false"><path d="M12 .5C5.73.5.5 5.73.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.56 0-.28-.01-1.02-.02-2-3.2.7-3.88-1.54-3.88-1.54-.53-1.34-1.3-1.7-1.3-1.7-1.06-.72.08-.71.08-.71 1.17.08 1.79 1.2 1.79 1.2 1.04 1.78 2.73 1.27 3.4.97.11-.75.41-1.27.74-1.56-2.55-.29-5.23-1.28-5.23-5.7 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11.1 11.1 0 0 1 2.9-.39c.98 0 1.97.13 2.9.39 2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.84 1.19 3.1 0 4.43-2.69 5.41-5.25 5.7.42.36.79 1.08.79 2.18 0 1.57-.01 2.84-.01 3.23 0 .31.21.68.8.56A11.51 11.51 0 0 0 23.5 12C23.5 5.73 18.27.5 12 .5Z"/></svg>;
}
function Lobby({ state, service, create, join, remove }: { state:RoomState; service:RoomService; create:() => void; join:() => void; remove:(room:Room) => void }) {
  const [query, setQuery] = useState('');
  const rooms = state.rooms.filter(room => `${room.name} ${room.description}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  return <main className="lr-room sw-lobby"><header className="sw-lobby-heading"><div><h1>来客厅坐坐。</h1><p>挑一个房间，和大家一起看、一起分享。</p></div><Action icon="plus" primary onClick={create} disabled={state.busy || !state.configured}>创建房间</Action></header>
    {!state.configured && <div className="lr-notice is-bad"><span className="lr-pill"><Glyph name="alert"/>尚未配置 RTC 服务，请填写服务端 .env 后重启。</span></div>}
    <Row><label className="lr-input sw-search"><Glyph name="eye"/><input type="search" placeholder="搜索房间" aria-label="搜索房间" value={query} onChange={event => setQuery(event.target.value)}/></label><span className="sw-count">{state.rooms.length} 个开放房间</span><span className="lr-spacer"/><Action icon="refresh" onClick={() => void service.refresh()} disabled={state.busy}>刷新</Action><Action icon="link" onClick={join} disabled={state.busy}>使用邀请链接</Action></Row>
    <div className="lr-viewer-overview-scroll sw-room-list" role="list" aria-label="开放房间">{rooms.map(room => <article key={room.id} className="sw-room-row" role="listitem"><button className="sw-room-enter" disabled={state.busy} onClick={() => void service.join(room)} aria-label={room.joinable === false ? `无法进入房间：${room.name}，需要更新到 v${room.minVersion}` : `进入房间：${room.name}`} title={room.joinable === false ? `该房间由 v${room.minVersion} 创建，请更新后再进入。` : undefined}><span className="sw-room-icon"><RoomGlyph/></span><span className="sw-room-copy"><strong>{room.name}</strong><span>{providerNames[room.provider || 'agora']} · {room.description || '欢迎加入，一起分享屏幕。'}</span></span><span className="sw-room-presence">{room.joinable === false ? `需更新到 v${room.minVersion}` : room.onlineCount ? `${room.onlineCount} 人在线` : `空房间 · ${Math.max(1, Math.ceil(((room.closesAt || Date.now()) - Date.now()) / 60000))} 分钟后关闭`}</span><Glyph name="arrowRight"/></button>{room.isOwner && <button className="lr-btn is-dense is-quiet" onClick={() => remove(room)} disabled={state.busy} aria-label={`关闭房间：${room.name}`}><Glyph name="x"/></button>}</article>)}
      {!rooms.length && <div className="sw-lobby-empty"><BrandMark size={64}/><h2>{query ? '没有找到这个房间。' : '客厅准备好了，等你开场。'}</h2><p>{query ? '换个关键词试试。' : '创建一个房间，邀请朋友一起分享。'}</p></div>}
    </div><p className="sw-footnote"><Glyph name="clock" size={14}/>房间空置 15 分钟自动关闭 · 每位成员都能同时共享</p>
  </main>;
}
function VideoSurface({ state, paused, service }: { state:RoomState; paused:boolean; service:RoomService }) {
  const ref = useRef<HTMLDivElement>(null);
  const pausedRef = useRef(paused);
  useEffect(() => { pausedRef.current = paused; }, [paused]);
  useEffect(() => {
    const container = ref.current;
    if (!container) return;
    // Agora's Chromium player calls play() from its own pause handler, so a plain
    // video.pause() is immediately undone. Hold the event back while paused here.
    const holdPause = (event: Event) => { if (pausedRef.current) event.stopPropagation(); };
    container.addEventListener('pause', holdPause, true);
    return () => container.removeEventListener('pause', holdPause, true);
  }, []);
  useEffect(() => { if (!ref.current || !state.video) return; state.video.play(ref.current, { fit:state.preferences.fit, mirror:false }); return () => { state.video?.stop(); }; }, [state.video, state.preferences.fit]);
  useEffect(() => {
    let sampler = new PlaybackSampler(), previous: HTMLVideoElement | null = null;
    const timer = setInterval(() => {
      const video = ref.current?.querySelector('video') ?? null;
      if (video !== previous || !video || video.paused || video.readyState < 2) {
        sampler = new PlaybackSampler(); previous = video; service.reportPlayback(undefined);
      }
      if (!video || video.paused || video.readyState < 2 || typeof video.getVideoPlaybackQuality !== 'function') return;
      service.reportPlayback(sampler.sample(video.getVideoPlaybackQuality(), performance.now()));
    }, 2000);
    return () => { clearInterval(timer); service.reportPlayback(undefined); };
  }, [state.video, state.preferences.fit, service]);
  useEffect(() => {
    const video = ref.current?.querySelector('video');
    if (!video) return;
    if (paused) video.pause(); else void video.play().catch(() => {});
  }, [paused, state.video, state.preferences.fit]);
  return <div ref={ref} id="agora-player" className="sw-video" hidden={!state.video}/>;
}
function RoomPage({ state, service, settings, edit, members, connection, capture }: { state:RoomState; service:RoomService; settings:() => void; edit:() => void; members:() => void; connection:() => void; capture:() => void }) {
  const { t } = useCopy();
  const [paused, setPaused] = useState(false);
  const [fullscreenView, setFullscreenView] = useState(false);
  const [pipView, setPipView] = useState(false);
  const wide = state.preferences.wide;
  const native = useNativeComponent(state.room?.provider, () => service.activateNativeRtc());
  const [nativeSharePrompt, setNativeSharePrompt] = useState(false);
  const nativeProgressText = native.progress?.phase === 'downloading' ? `正在下载 ${native.progress.percent}%`
    : native.progress?.phase === 'verifying' ? '正在校验 SHA-256…'
    : native.progress?.phase === 'extracting' ? '正在安装…'
    : '准备下载…';
  const startShare = () => {
    if (!isDesktopApp) { void service.share(); return; }
    if (native.needsInstall) { setNativeSharePrompt(true); return; }
    capture();
  };
  const installAndShare = async () => {
    if (!(await native.install())) return;
    if (!service.getSnapshot().room) return;
    setNativeSharePrompt(false);
    capture();
  };
  const shareWithoutInstall = () => {
    setNativeSharePrompt(false);
    capture();
  };
  useEffect(() => { setPaused(false); service.setPlaybackPaused(false); }, [state.video, service]);
  useEffect(() => {
    const syncFullscreen = () => setFullscreenView(!!document.fullscreenElement);
    const syncPip = () => setPipView(!!document.pictureInPictureElement);
    document.addEventListener('fullscreenchange', syncFullscreen);
    document.addEventListener('enterpictureinpicture', syncPip);
    document.addEventListener('leavepictureinpicture', syncPip);
    return () => {
      document.removeEventListener('fullscreenchange', syncFullscreen);
      document.removeEventListener('enterpictureinpicture', syncPip);
      document.removeEventListener('leavepictureinpicture', syncPip);
    };
  }, []);
  useEffect(() => {
    if (!wide) return;
    const exitWide = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || document.fullscreenElement || document.querySelector('dialog[open]')) return;
      service.savePreferences({ ...service.getSnapshot().preferences, wide: false });
    };
    document.addEventListener('keydown', exitWide);
    return () => document.removeEventListener('keydown', exitWide);
  }, [wide, service]);
  const owner = state.members.find(person => person.isOwner);
  const selected = state.members.find(person => person.uid === state.selected);
  const entries:CouchEntry[] = state.members.filter(person => person !== owner).map(person => ({ key:String(person.uid), name:person.name, you:person.uid === state.uid, selectable:true, status:{ tone:person.sharing ? 'live' : 'off', labelKey:person.sharing ? 'state.peer.connected' : 'state.peer.present', icon:person.sharing ? 'share' : 'users', comic:'signal-connected' } }));
  const fitOptions = [
    ['contain', 'fitContain', 'playback.fit.contain'],
    ['cover', 'fitCover', 'playback.fit.cover'],
    ['fill', 'fitStretch', 'playback.fit.fill'],
  ] as const;
  const toggleFullscreen = () => { const element = document.querySelector<HTMLElement>('.lr-tv-screen'); const task = document.fullscreenElement ? document.exitFullscreen() : element?.requestFullscreen(); void task?.catch(() => {}); };
  const togglePip = async () => {
    const video = document.querySelector<HTMLVideoElement>('#agora-player video');
    if (!video) return;
    try { if (document.pictureInPictureElement) await document.exitPictureInPicture(); else await video.requestPictureInPicture(); }
    catch { /* picture-in-picture is unavailable in this browser */ }
  };
  return <><main className={`lr-room sw-room${wide ? ' is-wide' : ''}`}><div className="sw-room-heading"><div><h1>{state.room?.name}</h1><p>{state.room?.description || '每个人都可以分享，点击成员切换观看。'}</p></div><span className="sw-count">{state.members.length} 人在线 · {state.members.filter(person => person.sharing).length} 路共享</span></div>
    <div className="lr-scene"><StageTv label="共享画面" live={!!state.video} indicator={<span className={`sw-tv-lamp${state.connected ? ' is-live' : ''}`} aria-label={state.connection}/>}>
      <VideoSurface state={state} paused={paused} service={service}/>{!state.video && <StageOverlay icon={state.connecting ? 'loader' : 'tv'} comic={state.connecting ? 'signal-connecting' : 'waiting-for-host'} waiting={state.connecting} message={state.connecting ? '正在连接媒体…' : selected ? `${selected.name} 暂未共享画面` : '等待大家分享画面'}/>}
      <div className="sw-playback"><span className="sw-watching">{state.video ? `${paused ? '已暂停' : '正在观看'} · ${selected?.name || '共享画面'}${state.selected === state.uid ? '（你）' : ''}` : '选择下方成员，切换共享画面'}</span><div className="sw-playback-tools">
        <Btn icon={paused ? 'play' : 'pause'} title={paused ? 'playback.play' : 'playback.pause'} size="dense" quiet pressed={paused} disabled={!state.video} onClick={() => { const next = !paused; setPaused(next); service.setPlaybackPaused(next); }}/>
        <Btn icon={state.preferences.muted ? 'speakerOff' : 'speaker'} title={state.preferences.muted ? 'playback.unmute' : 'playback.mute'} size="dense" quiet onClick={() => service.savePreferences({ ...state.preferences,muted:!state.preferences.muted })}/>
        <label className="sw-volume"><input type="range" min={0} max={100} value={state.preferences.volume} onChange={event => service.savePreferences({ ...state.preferences,volume:Number(event.target.value) })} aria-label={t('playback.volumeBasic')}/></label>
        <span className="sw-playback-sep" aria-hidden="true"/>
        <Btn icon="switchSource" title="playback.viewControls" size="dense" quiet onClick={members}/>
        <Btn icon="sliders" title="playback.more" size="dense" quiet onClick={settings}/>
        <Btn icon={pipView ? 'pipExit' : 'pip'} title={pipView ? 'playback.exitPip' : 'playback.pip'} size="dense" quiet disabled={!state.video} onClick={() => void togglePip()}/>
        <div className="sw-fit-group" role="group" aria-label={t('playback.pictureFit')}>{fitOptions.map(([fit, icon, title]) => <Btn key={fit} icon={icon} title={title} size="dense" quiet pressed={state.preferences.fit === fit} onClick={() => service.savePreferences({ ...state.preferences,fit })}/>)}</div>
        {!fullscreenView && <span className="sw-wide-toggle"><Btn icon={wide ? 'theaterExit' : 'theater'} title={wide ? 'playback.exitWide' : 'playback.wide'} size="dense" quiet pressed={wide} onClick={() => service.savePreferences({ ...state.preferences, wide: !wide })}/></span>}
        <Btn icon={fullscreenView ? 'contract' : 'expand'} title={fullscreenView ? 'playback.exitFullscreen' : 'playback.fullscreen'} size="dense" quiet onClick={toggleFullscreen}/>
      </div></div>
    </StageTv><div className="lr-host-controls"><div className="lr-media-controls lr-host-share-controls"><div className="lr-host-action-dock">
      {state.sharing ? <Btn icon="stop" tone="danger" title="host.stop" cap="host.stop" disabled={state.busy} onClick={() => void service.stop()}/> : <Btn icon="share" tone="primary" title="host.start" cap="host.start" busy={state.connecting} disabled={state.busy || state.connecting} onClick={startShare}/>}
    </div><div className="lr-host-tool-dock"><Btn icon="sliders" title="host.settings.button" cap="host.settings.button" onClick={settings}/><Btn icon="link" title="host.invite.copy" cap="host.invite.copy" onClick={() => void service.copyInvite()}/><Action icon="refresh" onClick={() => void service.refresh()} disabled={state.busy}>刷新</Action><Action icon="users" onClick={members}>成员</Action><Action icon="arrowLeft" onClick={() => void service.leave()} disabled={state.busy}>离开房间</Action></div></div></div>
    <p className="sw-stage-caption">{state.caption}</p><div className="sw-roster"><Couch view="host" host={owner ? { key:String(owner.uid),name:owner.name,you:owner.uid === state.uid,selected:state.selected === owner.uid,onSelect:() => void service.select(owner.uid) } : undefined} entries={entries} selectedKey={state.selected === undefined ? undefined : String(state.selected)} onSelect={key => void service.select(Number(key))} footerAction={<><span className="lr-couch-count sw-total-count" aria-label={`房间成员 ${state.members.length}`}><Glyph name="users" size={14}/><b>{state.members.length}</b></span><button className="lr-btn is-dense is-quiet" onClick={members}><Glyph name="users" size={14}/><span className="lr-cap">房间成员</span></button></>}/></div></div>
    <div className="lr-deck"><Row><span className="sw-room-code"><Glyph name="tv"/><span>{state.room?.id.toUpperCase()}</span></span><NameTag name={state.name} identity={String(state.uid)}/><span className="lr-spacer"/><Action icon="gauge" onClick={connection}>连接详情</Action>{state.room?.isOwner && <Action icon="pencil" onClick={edit}>编辑房间</Action>}<details className="sw-invite"><summary>邀请链接</summary><input className="lr-invite-url" readOnly value={state.room ? inviteUrl(state.room) : ''} aria-label="房间邀请链接" onFocus={event => event.currentTarget.select()}/></details></Row></div>
  </main>
  {nativeSharePrompt && <Modal title="安装火山原生组件" close={() => { if (!native.installing) setNativeSharePrompt(false); }}>
    <div className="sw-native-modal">
      <span className="sw-native-badge">推荐</span>
      <p>首次共享改用 WGC 原生采集，帧率和清晰度更稳定（约 22 MB）</p>
      {native.installing && <div className="sw-native-download"><div className="sw-native-progress"><span style={{ width:`${Math.max(0, Math.min(100, native.progress?.percent || 0))}%` }}/></div><small>{nativeProgressText}</small></div>}
      {native.error && <p className="sw-native-error">{native.error}</p>}
    </div>
    <footer className="sw-dialog-footer">
      <Action icon="share" onClick={shareWithoutInstall} disabled={native.installing}>直接共享</Action>
      <Action icon="arrowDown" primary onClick={() => void installAndShare()} disabled={native.installing || state.busy || state.connecting}>{native.installing ? '正在安装…' : '推荐安装并共享'}</Action>
    </footer>
  </Modal>}</>;
}
const qualityLabels = ['未知', '极佳', '优秀', '良好', '一般', '较差', '已断开'];
const formatSize = (width: number, height: number) => width > 0 && height > 0 ? `${width}×${height}` : '—';
const formatBitrate = (value?: number) => value && value > 0 ? `${(value / 1_000_000).toFixed(1)} Mbps` : '—';
const formatBandwidth = (kbps?: number) => kbps !== undefined && kbps > 0 ? (kbps >= 1000 ? `${(kbps / 1000).toFixed(1)} Mbps` : `${Math.round(kbps)} Kbps`) : '—';
const formatPercent = (value: number) => Number.isFinite(value) && value > 0 ? `${value.toFixed(value >= 10 ? 0 : 2)}%` : '0%';
const surfaceLabel = (surface: string) => surface === 'monitor' ? '屏幕' : surface === 'window' ? '窗口' : surface === 'browser' ? '标签页' : '未知来源';
function ConnectionDetails({ state, service, close }: { state:RoomState; service:RoomService; close:() => void }) {
  const [snapshot, setSnapshot] = useState<ConnectionSnapshot>(() => service.getConnectionSnapshot());
  useEffect(() => {
    const timer = setInterval(() => setSnapshot(service.getConnectionSnapshot()), 2000);
    return () => clearInterval(timer);
  }, [service]);
  const local = snapshot.local, remote = snapshot.remote, network = snapshot.network;
  return <Modal title="连接详情" close={close} wide><div className="sw-connection">
    <div className="sw-connection-head"><span className="sw-room-code"><Glyph name="tv"/><span>{state.room?.id.toUpperCase()}</span></span><span className="sw-connection-state" data-state={snapshot.connected ? 'live' : snapshot.connecting ? 'busy' : 'idle'}>{snapshot.connected ? '媒体已连接' : snapshot.connecting ? '正在连接…' : '媒体未连接'}</span></div>
    <div className="sw-connection-grid">
      <section className="sw-connection-card"><h3><Glyph name="display"/>本机采集</h3>{local ? <dl>
        <dt>分辨率</dt><dd>{formatSize(local.width, local.height)}</dd>
        <dt>采集帧率</dt><dd>{formatFps(local.captureFrameRate)}</dd>
        <dt>发送帧率</dt><dd>{formatFps(local.sendFrameRate)}</dd>
        <dt>视频编码</dt><dd>{local.codec || '—'}</dd>
        <dt>发送码率</dt><dd>{formatBitrate(local.sendBitrate)}{(local.targetBitrate ?? 0) > 0 ? ` / ${formatBitrate(local.targetBitrate)}` : ''}</dd>
        <dt>来源声音</dt><dd>{local.hasAudio ? '已包含' : '未包含'}</dd>
        <dt>采集来源</dt><dd>{surfaceLabel(local.surface)}</dd>
      </dl> : <p className="sw-connection-empty">{state.sharing ? '正在获取采集统计…' : '当前没有共享画面。'}</p>}</section>
      <section className="sw-connection-card"><h3><Glyph name="eye"/>当前观看</h3>{remote ? <dl>
        <dt>成员</dt><dd>{remote.name}</dd>
        <dt>分辨率</dt><dd>{formatSize(remote.width, remote.height)}</dd>
        <dt>接收 / 解码帧率</dt><dd>{formatFps(remote.receiveFrameRate)} / {formatFps(remote.decodeFrameRate)}</dd>
        <dt>实际播放帧率</dt><dd>{formatFps(snapshot.playback?.fps)}</dd>
        <dt>本次采样播放丢帧</dt><dd>{snapshot.playback ? `${snapshot.playback.dropped} / ${snapshot.playback.total}（${formatPercent(snapshot.playback.droppedPercent)}）` : '—'}</dd>
        <dt>视频编码</dt><dd>{remote.codec || '—'}</dd>
        <dt>接收码率</dt><dd>{formatBitrate(remote.receiveBitrate)}</dd>
        <dt>丢包率</dt><dd>{formatPercent(remote.packetLossRate)}</dd>
        <dt>端到端延迟</dt><dd>{remote.endToEndDelay > 0 ? `${remote.endToEndDelay} ms` : '—'}</dd>
      </dl> : <p className="sw-connection-empty">{state.video ? (state.selected === state.uid ? '正在预览自己的共享。' : '正在等待远端统计…') : '当前没有观看画面。'}</p>}</section>
      <section className="sw-connection-card"><h3><Glyph name="network"/>网络</h3>{network ? <dl>
        <dt>往返时延</dt><dd>{network.rtt !== undefined ? `${network.rtt} ms` : '—'}</dd>
        <dt>上行可用带宽</dt><dd>{formatBandwidth(network.uplinkKbps)}</dd>
        <dt>发送码率</dt><dd>{formatBitrate(network.sendBitrate)}</dd>
        <dt>接收码率</dt><dd>{formatBitrate(network.recvBitrate)}</dd>
        <dt>网络质量</dt><dd>{qualityLabels[network.quality] || '未知'}</dd>
      </dl> : <p className="sw-connection-empty">连接媒体后显示实时网络统计。</p>}</section>
    </div>
    <p className="sw-settings-note">连接统计每 2 秒刷新；远端统计在首次收到画面后约 1–3 秒内出现。</p>
  </div></Modal>;
}
function Choices<T extends string | number>({ label, options, value, onChange }: { label:string; options:[T,string][]; value:T; onChange:(value:T) => void }) {
  return <div className="lr-door-group"><strong className="lr-field-cap">{label}</strong><div className="lr-row-group" role="group" aria-label={label}>{options.map(([item,title]) => <Chip key={item} title={title} selected={value === item} onClick={() => onChange(item)}>{title}</Chip>)}</div></div>;
}
function NativeComponentSettings({ state, service }: { state:RoomState; service:RoomService }) {
  const native = useNativeComponent(state.room?.provider, () => service.activateNativeRtc());
  if (!native.enabled || native.status?.available || !native.status?.supported) return null;
  const progressText = native.progress?.phase === 'downloading' ? `正在下载 ${native.progress.percent}%`
    : native.progress?.phase === 'verifying' ? '正在校验 SHA-256…'
    : native.progress?.phase === 'extracting' ? '正在安装…'
    : '准备下载…';
  return <div className="lr-door-group sw-native-settings">
    <strong className="lr-field-cap">火山原生组件 <span className="sw-native-badge">推荐</span></strong>
    <p className="sw-settings-note">安装后可改善首次共享帧率（约 22 MB）。</p>
    {native.installing ? <div className="sw-native-download"><div className="sw-native-progress"><span style={{ width:`${Math.max(0, Math.min(100, native.progress?.percent || 0))}%` }}/></div><small>{progressText}</small></div>
      : <Action icon="arrowDown" primary onClick={() => void native.install()} disabled={state.sharing || state.busy || state.connecting}>{state.sharing ? '停止共享后可安装' : '安装火山原生组件'}</Action>}
    {native.error && <p className="sw-native-error">{native.error}</p>}
  </div>;
}
function Settings({ state, service, close }: { state:RoomState; service:RoomService; close:() => void }) {
  const isZego = state.room?.provider === 'zego';
  const [draft, setDraft] = useState<Preferences>(() => {
    const value = state.preferences;
    return {
      ...value,
      ...(isZego && (value.resolution === '1440' || value.resolution === 'native') ? { resolution:'1080' as const } : {}),
      ...(isZego && value.bitrate > ZEGO_MAX_BITRATE ? { bitrate:ZEGO_MAX_BITRATE } : {}),
    };
  });
  const change = (patch:Partial<Preferences>, immediate = false) => { setDraft(previous => ({ ...previous,...patch })); if (immediate) service.savePreferences({ ...state.preferences,...patch }); };
  const presets:[string,Preferences['resolution'],Preferences['fps'],Preferences['bitrate']][] = [['轻量','720',30,3000],['高清','1080',30,5000],['高帧率','1080',60,16000]];
  const presetNodes = <div className="lr-tiles">{presets.map(([title,resolution,fps,bitrate]) => <button type="button" key={title} className={`lr-tile${draft.bitrateMode === 'auto' && draft.resolution === resolution && draft.fps === fps ? ' is-selected' : ''}`} aria-pressed={draft.bitrateMode === 'auto' && draft.resolution === resolution && draft.fps === fps} onClick={() => change({ resolution,fps,bitrate,bitrateMode:'auto' })}><QualityTileGlyph resolution={`${resolution}p`} framerate={fps}/><strong>{title}</strong><small>{resolution}p {fps} 帧</small></button>)}</div>;
  const resolutionOptions = ([['480','480p'],['720','720p'],['1080','1080p'],['1440','1440p'],...(isDesktopApp ? [['native','原画'] as [Preferences['resolution'],string]] : [])] as [Preferences['resolution'],string][]).filter(([value]) => !isZego || (value !== '1440' && value !== 'native'));
  const autoBitrate = Math.min(automaticBitrate(draft), isZego ? ZEGO_MAX_BITRATE : 16000) as Preferences['bitrate'];
  const bitrateOptions:[Preferences['bitrate'] | 'auto',string][] = [['auto','自动（推荐）'], ...([1000,2000,3000,5000,8000,10000,12000,16000] as const)
    .filter(value => !isZego || value <= ZEGO_MAX_BITRATE)
    .map(value => [value, `${value/1000} Mbps`] as [Preferences['bitrate'], string])];
  return <Modal title="共享与观看设置" close={close} wide><SharingSettings id="sharing-options" open presets={presetNodes} pictureSummary={<span className="lr-sharing-picture-summary"><span>{draft.resolution === 'native' ? '原画' : `${draft.resolution}p`}</span><span>{draft.fps} fps</span><span>{draft.bitrateMode === 'auto' ? `自动 ${autoBitrate/1000} Mbps` : `${draft.bitrate/1000} Mbps`}</span></span>} picture={<>
    <Choices label="目标分辨率" options={resolutionOptions} value={draft.resolution} onChange={resolution => change({ resolution })}/>{isZego && <p className="sw-settings-note">即构共享画面最高为 1080P，码率最高为 10 Mbps。</p>}
    <div className="lr-sharing-limits"><Choices label="目标帧率" options={([15,24,30,60] as const).map(value => [value,`${value} fps`])} value={draft.fps} onChange={fps => change({ fps })}/><Choices label="最大视频码率" options={bitrateOptions} value={draft.bitrateMode === 'auto' ? 'auto' : draft.bitrate} onChange={value => change(value === 'auto' ? { bitrateMode:'auto',bitrate:autoBitrate } : { bitrateMode:'manual',bitrate:value })}/></div>
    <Choices label="弱网优化" options={[["detail","清晰优先"],["balanced","均衡"],["motion","流畅优先"]]} value={draft.optimization} onChange={optimization => change({ optimization })}/>
    <Choices label="观看画面适配" options={[["contain","完整显示"],["cover","填满画面"],["fill","拉伸铺满"]]} value={draft.fit} onChange={fit => change({ fit },true)}/>
  </>} audio={<>
    <div className="lr-door-group"><SwitchItem checked={draft.audio} onChange={audio => change({ audio })} label="共享所选来源的音频" icon="speaker"/><p className="sw-settings-note">{isDesktopApp ? '桌面端在每次开始共享时选择共享哪个程序或屏幕的声音；这里只决定默认是否勾选音频。共享系统声音时可以过滤 Oopz、KOOK 等语音软件。' : '标签页带标签页音频，窗口带窗口音频，整个屏幕带系统音频。在浏览器选择器中勾选共享音频，实际可用性由浏览器和操作系统决定。'}</p></div>
    {isDesktopApp && <SwitchItem checked={draft.filterVoice} onChange={filterVoice => change({ filterVoice })} label="默认过滤语音软件的声音" icon="headphonesOff"/>}
    <SwitchItem checked={draft.includeSelf} onChange={includeSelf => change({ includeSelf })} label="允许选择本站标签页" icon="window"/>
    <div className="lr-door-group"><strong className="lr-field-cap">观看音量</strong><label className="lr-slider"><Glyph name="speaker"/><input type="range" min={0} max={100} value={draft.volume} onChange={event => change({ volume:Number(event.target.value) },true)} aria-label="观看音量"/><output>{draft.volume}%</output></label></div>
    <SwitchItem checked={draft.muted} onChange={muted => change({ muted },true)} label="静音观看" icon="speakerOff"/>
  </>}/><NativeComponentSettings state={state} service={service}/><footer className="sw-dialog-footer"><Action icon="refresh" onClick={() => { setDraft({ ...defaults }); service.savePreferences({ ...state.preferences,volume:defaults.volume,muted:defaults.muted,fit:defaults.fit }); }}>恢复默认</Action><span className="sw-settings-note">共享参数在下次开始共享时生效。</span><Action icon="check" primary onClick={() => { service.savePreferences(draft); close(); }}>保存设置</Action></footer></Modal>;
}
function RoomEditor({ room, state, service, close, busy }: { room?:Room; state:RoomState; service:RoomService; close:() => void; busy:boolean }) {
  const { data:status, error:statusError } = useServiceStatus(!room);
  const [provider, setProvider] = useState<RtcProvider>(() => providerKeys.find(key => state.providers[key]) || 'agora');
  useEffect(() => {
    if (room || !status || !lowBalance(status[provider])) return;
    const available = providerKeys.find(key => state.providers[key] && !lowBalance(status[key]));
    if (available) setProvider(available);
  }, [room, status, provider, state.providers]);
  return <Modal title={room ? '编辑房间' : '给大家留个位置。'} close={close}><form className="sw-form" onSubmit={async event => { event.preventDefault(); const form = new FormData(event.currentTarget); if (await service.saveRoom({ name:String(form.get('name')),description:String(form.get('description')),provider },room)) close(); }}>
    <label>房间名称 {!room && <small>选填</small>}<span className="lr-input"><Glyph name="tv"/><input name="name" defaultValue={room?.name} placeholder={room ? '请输入房间名称' : `留空使用用户名：${state.name}`} required={!!room} maxLength={40} autoFocus/></span></label><label>房间描述 <small>选填</small><textarea name="description" defaultValue={room?.description} placeholder="正在分享什么，想一起做什么？" maxLength={160} rows={3}/></label>{!room && <fieldset className="sw-provider-list"><legend>RTC 服务商</legend>{providerKeys.filter(key => state.providers[key]).map(key => { const usage = status?.[key]; return <label key={key}><input type="radio" name="provider" checked={provider === key} onChange={() => setProvider(key)} disabled={!state.providers[key] || lowBalance(usage)}/><span className="sw-provider-content"><span className="sw-provider-heading"><strong>{providerNames[key]}{recommendedProviders.has(key) && <em className="sw-provider-badge">推荐</em>}</strong><small>{!state.providers[key] ? '未配置' : usage?.status === 'ok' ? `预计剩余 ${formatAmount(usage.remaining)} / ${formatAmount(usage.total)} ${usage.unit || '分钟'}${lowBalance(usage) ? ' · 达到 500 分钟保护线' : ''}` : statusError && !usage ? '查询失败' : usageMessage(usage)}</small></span><UsageProgress name={providerNames[key]} usage={usage || {status:'loading'}}/></span></label>; })}<p className="sw-settings-note">余量达到或低于 500 分钟时不可选择；同一房间的成员使用同一家服务商，创建后不可更改。</p></fieldset>}<p className="sw-settings-note">房间会出现在大厅，空置 15 分钟后自动关闭。</p><Action icon="arrowRight" primary type="submit" disabled={busy || (!room && (!state.providers[provider] || lowBalance(status?.[provider])))}>{room ? '保存修改' : '创建并进入'}</Action>
  </form></Modal>;
}
function NativeEntryPrompt({ onDone }: { onDone:(proceed:boolean) => void }) {
  const [installing, setInstalling] = useState(false);
  const [progress, setProgress] = useState<DesktopNativeComponentProgress>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    const unsubscribe = desktopBridge?.onNativeComponentProgress?.(setProgress);
    return () => { unsubscribe?.(); };
  }, []);
  const progressText = progress?.phase === 'downloading' ? `正在下载 ${progress.percent}%`
    : progress?.phase === 'verifying' ? '正在校验 SHA-256…'
    : progress?.phase === 'extracting' ? '正在安装…'
    : '准备下载…';
  const install = async () => {
    if (!desktopBridge?.nativeComponent) { onDone(true); return; }
    setInstalling(true);
    setError(undefined);
    try {
      const result = await desktopBridge.nativeComponent({ operation: 'install' });
      if (!result.available) throw new Error('安装完成后未找到原生组件。');
      setNativeComponentStatus(result);
      onDone(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setInstalling(false);
    }
  };
  return <Modal title="安装火山原生组件" close={() => { if (!installing) onDone(true); }}>
    <div className="sw-native-gate">
      <div className="sw-native-gate-head">
        <span className="sw-native-gate-icon"><Glyph name="tv"/></span>
        <div><span className="sw-native-badge">推荐</span><h3>火山原生组件未安装</h3></div>
      </div>
      <p>安装后可改善首次共享帧率（约 22 MB）。进入房间前安装只需一次。</p>
      {installing && <div className="sw-native-download"><div className="sw-native-progress"><span style={{ width:`${Math.max(0, Math.min(100, progress?.percent || 0))}%` }}/></div><small>{progressText}</small></div>}
      {error && <p className="sw-native-error">{error}</p>}
    </div>
    <footer className="sw-dialog-footer">
      <Action icon="share" onClick={() => onDone(true)} disabled={installing}>暂不，直接进房</Action>
      <Action icon="arrowDown" primary onClick={() => void install()} disabled={installing}>{installing ? '正在安装…' : '推荐安装'}</Action>
    </footer>
  </Modal>;
}
type UpdateDialog = { kind:'available'; status:DesktopUpdateStatus } | { kind:'installing'; status?:DesktopUpdateStatus } | { kind:'latest'; status:DesktopUpdateStatus; required?:string } | { kind:'error'; message:string; retry:'check'|'install' };
const updateSpeed = (bytes:number) => bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB/s` : bytes > 0 ? `${Math.max(1, Math.round(bytes / 1024))} KB/s` : '';
const updateProgressText = (progress?:DesktopUpdateProgress) => {
  if (!progress) return '正在准备下载…';
  if (progress.phase === 'starting' || progress.percent >= 100) return '下载完成，正在重启…';
  if (progress.percent < 0) return '正在选择更新线路…';
  const speed = updateSpeed(progress.bytesPerSecond);
  return `正在下载 ${Math.round(progress.percent)}%${speed ? ` · ${speed}` : ''}`;
};
function UpdatePrompt({ dialog, progress, onDismiss, onInstall }: { dialog:UpdateDialog; progress?:DesktopUpdateProgress; onDismiss:()=>void; onInstall:()=>void }) {
  const installing = dialog.kind === 'installing';
  const status = dialog.kind === 'error' ? undefined : dialog.status;
  const version = status?.latestVersion || status?.currentVersion || '';
  const title = dialog.kind === 'error' ? (dialog.retry === 'install' ? '更新未完成' : '检查更新') : dialog.kind === 'latest' ? '检查更新' : installing ? '正在更新 Piik-RTC' : `发现新版本 v${version}`;
  const heading = dialog.kind === 'error' ? (dialog.retry === 'install' ? '更新未完成' : '检查更新失败') : dialog.kind === 'latest' ? '当前已是最新版本' : installing ? '正在下载更新' : '有新版本可用';
  return <Modal title={title} close={onDismiss}>
    <div className="sw-native-gate">
      <div className="sw-native-gate-head">
        <span className="sw-native-gate-icon"><Glyph name={dialog.kind === 'error' ? 'alert' : 'arrowDown'}/></span>
        <div><span className="sw-native-badge">应用更新</span><h3>{heading}</h3></div>
      </div>
      {dialog.kind === 'error' ? <p>{dialog.message}</p> : dialog.kind === 'latest' ? <p>{dialog.required ? `当前版本 v${status?.currentVersion}，最新发布版本为 v${status?.latestVersion}，仍低于房间要求的 v${dialog.required}，请稍后再试。` : `当前版本 v${status?.currentVersion}，无需更新。`}</p> : <>
        <p>当前版本 v{status?.currentVersion}，最新版本 v{version}。更新完成后应用会自动重启。</p>
        {installing && <div className="sw-native-download"><div className="sw-native-progress"><span style={{ width:`${Math.max(0, Math.min(100, progress?.percent || 0))}%` }}/></div><small>{updateProgressText(progress)}</small></div>}
      </>}
    </div>
    <footer className="sw-dialog-footer">
      {!installing && <Action icon="x" onClick={onDismiss}>{dialog.kind === 'available' ? '稍后更新' : '关闭'}</Action>}
      {(dialog.kind === 'available' || dialog.kind === 'error') && <Action icon="arrowDown" primary onClick={onInstall}>{dialog.kind === 'error' ? (dialog.retry === 'install' ? '重试下载' : '重试检查') : '立即更新'}</Action>}
    </footer>
  </Modal>;
}
function VersionEntryPrompt({ room, onDone, onUpdate }: { room:Room; onDone:() => void; onUpdate:() => void }) {
  const directUpdate = !!desktopBridge?.checkUpdate && !!desktopBridge?.installUpdate;
  return <Modal title="需要更新 Piik-RTC" close={onDone}>
    <div className="sw-native-gate">
      <div className="sw-native-gate-head">
        <span className="sw-native-gate-icon"><Glyph name="alert"/></span>
        <div><span className="sw-native-badge">版本要求</span><h3>当前客户端版本过低</h3></div>
      </div>
      {directUpdate
        ? <p>该房间由 Piik-RTC v{room.minVersion} 创建，请更新到 v{room.minVersion} 或更高版本后再进入。点击“立即更新”下载并安装，或右键选择“检查更新…”。</p>
        : <p>该房间由 Piik-RTC v{room.minVersion} 创建，请更新到 v{room.minVersion} 或更高版本后再进入。右键选择“检查更新”，或重新启动客户端进行更新。</p>}
    </div>
    <footer className="sw-dialog-footer">
      {directUpdate
        ? <><Action icon="x" onClick={onDone}>暂不更新</Action><Action icon="arrowDown" primary onClick={onUpdate}>立即更新</Action></>
        : <Action icon="check" primary onClick={onDone}>知道了</Action>}
    </footer>
  </Modal>;
}
function App({ service }: { service:RoomService }) {
  const state = useSyncExternalStore(service.subscribe, service.getSnapshot);
  const [statusPage, setStatusPage] = useState(location.hash === '#status');
  useEffect(() => { const update = () => setStatusPage(location.hash === '#status'); window.addEventListener('hashchange', update); return () => window.removeEventListener('hashchange', update); }, []);
  const [dialog,setDialog] = useState<'create'|'edit'|'join'|'settings'|'help'|'members'|'connection'|'capture'|null>(null);
  const [removing,setRemoving] = useState<Room>();
  const [troubleshooting,setTroubleshooting] = useState(false);
  const [entryStatus,setEntryStatus] = useState<DesktopNativeComponentStatus>();
  const entryResolve = useRef<((proceed:boolean) => void) | null>(null);
  const [blockedRoom,setBlockedRoom] = useState<Room>();
  const versionResolve = useRef<((proceed:boolean) => void) | null>(null);
  const [updateDialog,setUpdateDialog] = useState<UpdateDialog>();
  const [updateProgress,setUpdateProgress] = useState<DesktopUpdateProgress>();
  const [checkingUpdate,setCheckingUpdate] = useState(false);
  const close = () => { setDialog(null); setTroubleshooting(false); };
  useEffect(() => {
    service.setNativeEntryGate(async provider => {
      if (!isDesktopApp || (provider !== 'volc' && provider !== 'volc2') || !desktopBridge?.nativeComponent) return true;
      let status: DesktopNativeComponentStatus;
      try { status = await desktopBridge.nativeComponent({ operation: 'status' }); }
      catch { return true; }
      setNativeComponentStatus(status);
      if (!status.supported || status.available) return true;
      return await new Promise<boolean>(resolve => {
        entryResolve.current = resolve;
        setEntryStatus(status);
      });
    });
    return () => service.setNativeEntryGate(undefined);
  }, [service]);
  const finishEntry = (proceed:boolean) => {
    const resolve = entryResolve.current;
    entryResolve.current = null;
    setEntryStatus(undefined);
    resolve?.(proceed);
  };
  useEffect(() => {
    service.setVersionEntryGate(async room => {
      if (room.joinable !== false) return true;
      return await new Promise<boolean>(resolve => {
        versionResolve.current = resolve;
        setBlockedRoom(room);
      });
    });
    return () => service.setVersionEntryGate(undefined);
  }, [service]);
  const finishVersionEntry = () => {
    const resolve = versionResolve.current;
    versionResolve.current = null;
    setBlockedRoom(undefined);
    resolve?.(false);
  };
  const startInstall = async (status?:DesktopUpdateStatus) => {
    const bridge = desktopBridge;
    if (!bridge?.installUpdate) return;
    setUpdateDialog({ kind:'installing', status });
    setUpdateProgress(undefined);
    try { await bridge.installUpdate(); }
    catch (error) { setUpdateDialog({ kind:'error', message:errorText(error), retry:'install' }); }
  };
  const checkForUpdate = useCallback(async (manual:boolean, requiredVersion?:string, autoInstall = false) => {
    const bridge = desktopBridge;
    if (!bridge?.checkUpdate) return;
    if (manual) setCheckingUpdate(true);
    try {
      const status = await bridge.checkUpdate({ manual });
      if (status.status === 'available') {
        setUpdateDialog({ kind:'available', status });
        if (autoInstall) void startInstall(status);
      }
      else if (manual && status.status === 'latest') setUpdateDialog({ kind:'latest', status, required:requiredVersion });
      else if (manual && status.status === 'error') setUpdateDialog({ kind:'error', message:status.error || '检查更新失败，请稍后重试。', retry:'check' });
      else if (manual && status.status === 'disabled') setUpdateDialog({ kind:'error', message:'更新检查已被禁用（PIIK_DISABLE_UPDATE）。', retry:'check' });
    } catch (error) {
      if (manual) setUpdateDialog({ kind:'error', message:errorText(error), retry:'check' });
    } finally {
      if (manual) setCheckingUpdate(false);
    }
  }, []);
  useEffect(() => {
    const bridge = desktopBridge;
    if (!isDesktopApp || !bridge) return;
    const offProgress = bridge.onUpdateProgress?.(value => {
      setUpdateProgress(value);
      setUpdateDialog(current => current && (current.kind === 'available' || current.kind === 'error') ? { kind:'installing', status:current.kind === 'available' ? current.status : undefined } : current);
    });
    const offError = bridge.onUpdateError?.(info => setUpdateDialog({ kind:'error', message:info.message || '更新下载失败，请稍后重试。', retry:'install' }));
    const offRequested = bridge.onUpdateRequested?.(() => { void checkForUpdate(true); });
    void checkForUpdate(false);
    return () => { offProgress?.(); offError?.(); offRequested?.(); };
  }, [checkForUpdate]);
  const installUpdate = async () => {
    const bridge = desktopBridge;
    if (!bridge?.installUpdate) return;
    await startInstall(updateDialog?.kind === 'available' ? updateDialog.status : undefined);
  };
  const handleUpdateAction = () => {
    if (updateDialog?.kind === 'error' && updateDialog.retry === 'check') { setUpdateDialog(undefined); void checkForUpdate(true); return; }
    void installUpdate();
  };
  const updateFromGate = () => {
    const required = blockedRoom?.minVersion || undefined;
    finishVersionEntry();
    setUpdateDialog(undefined);
    void checkForUpdate(true, required, true);
  };
  useEffect(() => { document.body.dataset.view = state.view; },[state.view]);
  return <div className={`lr-app sw-app${state.view === 'room' ? ' is-room' : ''}`}><Header state={state} service={service} help={() => setDialog('help')}/>
    {statusPage ? <ServiceStatusPage providers={state.providers} ready={state.ready} room={state.view === 'room' ? state.room : undefined}/> : state.view === 'welcome' ? <Welcome state={state} service={service}/> : state.view === 'lobby' ? <Lobby state={state} service={service} create={() => setDialog('create')} join={() => setDialog('join')} remove={setRemoving}/> : <RoomPage state={state} service={service} settings={() => setDialog('settings')} edit={() => setDialog('edit')} members={() => setDialog('members')} connection={() => setDialog('connection')} capture={() => setDialog('capture')}/>}
    {state.notice && <div className={`lr-notice sw-notice ${state.notice.error ? 'is-bad' : 'is-good'}`} role={state.notice.error ? 'alert' : 'status'}><span className="lr-pill"><Glyph name={state.notice.error ? 'alert' : 'check'}/>{state.notice.message}</span><button className="lr-btn is-dense is-quiet" onClick={service.dismissNotice} aria-label="关闭通知"><Glyph name="x"/></button></div>}
    {state.budgetAlert && <Modal title="服务余量不足" close={service.dismissBudgetAlert}><p>{state.budgetAlert}</p><footer className="sw-dialog-footer"><Action icon="check" primary onClick={service.dismissBudgetAlert}>知道了</Action></footer></Modal>}
    {entryStatus && <NativeEntryPrompt onDone={finishEntry}/>}
    {blockedRoom && <VersionEntryPrompt room={blockedRoom} onDone={finishVersionEntry} onUpdate={updateFromGate}/>}
    {checkingUpdate && <Modal title="检查更新" close={() => setCheckingUpdate(false)}><p>正在检查更新…</p></Modal>}
    {updateDialog && <UpdatePrompt dialog={updateDialog} progress={updateProgress} onDismiss={() => setUpdateDialog(undefined)} onInstall={handleUpdateAction}/>}
    {(dialog === 'create' || dialog === 'edit') && <RoomEditor key={dialog} room={dialog === 'edit' ? state.room : undefined} state={state} service={service} busy={state.busy} close={close}/>}
    {dialog === 'join' && <Modal title="进入朋友的房间" close={close}><form className="sw-form" onSubmit={async event => { event.preventDefault(); const form = new FormData(event.currentTarget); if (await service.joinInvite(String(form.get('invite')))) close(); }}><label>房间邀请链接<span className="lr-input"><Glyph name="link"/><input name="invite" type="url" placeholder="粘贴邀请链接" required autoFocus/></span></label><Action icon="arrowRight" primary type="submit" disabled={state.busy}>进入房间</Action></form></Modal>}
    {dialog === 'settings' && <Settings state={state} service={service} close={close}/>}
    {dialog === 'capture' && <DesktopCapturePicker preferences={state.preferences} max1080={state.room?.provider === 'zego'} onClose={close} onConfirm={(selection:CaptureSelection, preferences:Preferences) => { service.savePreferences(preferences); void service.share(selection); close(); }}/>}
    {dialog === 'connection' && <ConnectionDetails state={state} service={service} close={close}/>}
    {dialog === 'help' && <Modal title="一起分享，随时切换。" close={close}><div className="sw-help"><div className="sw-help-brand"><BrandMark size={60}/><div className="sw-help-brand-line"><strong>Piik-RTC</strong><a className="sw-help-github" href="https://github.com/Nth2Miss/Piik-RTC" target="_blank" rel="noreferrer" aria-label="在 GitHub 查看 Piik-RTC 源码"><GitHubMark/></a></div></div><p>输入用户名，在大厅选择房间或创建房间。房间内每位成员都可以同时共享。</p><p>点击沙发上的成员或成员列表，切换到对方的画面和声音。切换观看不会结束自己的共享。</p>{isDesktopApp && <p><strong>桌面端共享：</strong>点击“开始共享”选择程序或屏幕。共享程序声音只采集该程序；共享系统声音时可以过滤 Oopz、KOOK 等语音软件，避免小伙伴听到回声。在窗口内右键打开菜单。</p>}<p>最后一人离开后，房间连续空置 15 分钟会自动关闭。</p><div className="sw-help-tools"><a className="lr-btn" href="#status" onClick={close}><Glyph name="gauge"/><span className="lr-cap">服务状态</span></a><Action icon="help" onClick={() => setTroubleshooting(value => !value)}>问题排查</Action><Action icon="network" onClick={() => service.exportDiagnostics()}>诊断</Action></div>{troubleshooting && <div className="sw-troubleshoot">{isDesktopApp ? <><p><strong>无法开始共享：</strong>要共享的窗口需要先恢复，最小化的窗口不会出现在列表里；确认桌面端已连接服务器。</p><p><strong>没有声音：</strong>开始共享时勾选“共享系统声音”或“共享该程序的声音”；程序声音和语音过滤需要 Windows 10 2004（19041）及以上。</p></> : <><p><strong>无法开始共享：</strong>需要 HTTPS 或 localhost，并使用桌面 Chrome / Edge；在浏览器选择器中选择屏幕、窗口或标签页。</p><p><strong>没有声音：</strong>共享时在浏览器选择器中勾选“共享音频”；窗口声音需要较新的 Chrome / Edge。</p></>}<p><strong>画面卡顿：</strong>在共享设置中降低分辨率、帧率或码率；弱网时选择“流畅优先”。</p><p><strong>连接失败：</strong>确认服务端已配置所选服务商的凭据，并检查网络。</p><p><strong>诊断：</strong>导出报告包含浏览器环境、房间与媒体统计、最近错误；报告不包含访问令牌。</p></div>}<p className="sw-help-version">Piik-RTC v{appVersion}</p><a href="https://github.com/TNTcraftHIM/Piik" target="_blank" rel="noreferrer">界面基于 Piik 开源前端 · MIT</a></div></Modal>}
    {dialog === 'members' && <Modal title={`房间成员 · ${state.members.length}`} close={close}><div className="sw-members" role="list">{state.members.map(person => <button key={person.uid} className={`lr-viewer-overview-row${state.selected === person.uid ? ' is-selected' : ''}`} onClick={() => { void service.select(person.uid); close(); }} aria-label={`观看 ${person.name} 的共享`}><NameTag name={`${person.name}${person.uid === state.uid ? '（你）' : ''}`} identity={String(person.uid)}/><span>{person.sharing ? '正在共享' : '在线'}{person.isOwner ? ' · 房主' : ''}</span></button>)}</div></Modal>}
    {removing && <Modal title="关闭这个房间？" close={() => setRemoving(undefined)}><p>关闭“{removing.name}”后，所有成员将退出，邀请链接会失效。</p><footer className="sw-dialog-footer"><Action icon="x" onClick={() => setRemoving(undefined)}>取消</Action><Action icon="stop" danger disabled={state.busy} onClick={async () => { if (await service.removeRoom(removing)) setRemoving(undefined); }}>确认关闭</Action></footer></Modal>}
  </div>;
}
export function mountApp(service:RoomService) { createRoot(document.getElementById('app')!).render(<App service={service}/>); }
