import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
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
import { defaults, type Preferences } from './preferences';
import { inviteUrl, type RoomService, type RoomState } from './room-service';
import type { Room } from './types';

function RtcUsageBadge() {
  const [failed, setFailed] = useState(false);
  const url = 'https://img.shields.io/badge/dynamic/json?color=099dfd&labelColor=002550&style=flat-square&label=Agora-RTC&query=%24.usage&url=https%3A%2F%2Fconsole-open-cn.sh3.agoralab.co%2Fopen-api%2Fv1%2Fbadge%2Fproject%2F5326e3a4189871598abc87db254720ea%3A876f5bfa6f13640bb5&link=https%3A%2F%2Fagora.io';
  return <a className="sw-rtc-badge" href="https://agora.io" target="_blank" rel="noopener noreferrer" aria-label="声网 RTC 用量，由 Agora 提供服务">{failed ? <span>Agora · RTC 用量</span> : <img src={url} alt="声网 RTC 用量" height={20} referrerPolicy="no-referrer" onError={() => setFailed(true)}/>}</a>;
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
  return <header className="lr-top"><button className="lr-brand" aria-label={state.view === 'room' ? '返回房间大厅' : '同屏'} onClick={() => { if (state.view === 'room') void service.leave(); }} disabled={state.busy}>
    {state.view === 'room' && <Glyph name="chevron" size={14} className="lr-home-arrow"/>}<BrandMark size={34} motion="once"/>
  </button><span className="lr-top-right">
    {state.view === 'room' && <span role="status"><span className="lr-leds" data-state={state.connected ? 'live' : state.connecting ? 'busy' : 'warn'}><span className="lr-connection-dots" aria-hidden="true"><i/><i/><i/></span><span className="lr-leds-label">{state.connection}</span></span></span>}
    {state.view !== 'welcome' && <button className="sw-header-name" onClick={() => void service.changeName()} disabled={state.busy} aria-label="更改用户名"><NameTag name={state.name} identity={String(state.uid || state.name)}/></button>}
    <span className="lr-top-right lr-header-controls"><LanguageControl/><button className="lr-btn is-compact lr-theme-toggle" onClick={() => applyTheme(theme === 'dark' ? 'light' : 'dark')} aria-label={t(theme === 'dark' ? 'theme.light' : 'theme.dark')}><Glyph name={theme === 'dark' ? 'sun' : 'moon'} size={16}/><span className="lr-cap">{t(theme === 'dark' ? 'theme.light.short' : 'theme.dark.short')}</span></button><button className="lr-btn is-compact is-quiet" onClick={help} aria-label="使用帮助"><Glyph name="help"/></button></span>
  </span></header>;
}
function Welcome({ state, service }: { state:RoomState; service:RoomService }) {
  const [name, setName] = useState(state.name);
  return <main className="lr-client-launch"><form className="lr-client-launch-panel" onSubmit={event => { event.preventDefault(); void service.confirmName(name); }}>
    <header className="lr-client-launch-heading"><div className="lr-client-launch-brand"><BrandMark size={64} motion="once"/><h1 className="lr-client-launch-title">Piik<span className="lr-client-brand-dot">.</span><small>声网版</small></h1></div><p className="lr-welcome is-still"><span className="lr-welcome-text">不同的屏幕，同一个小客厅。</span></p></header>
    <section className="lr-client-standby sw-name-entry"><Glyph name="couch" size={30}/><h2>先认识一下，再一起分享。</h2><p>输入用户名，然后选择房间或创建自己的房间。</p><label className="lr-input"><Glyph name="users"/><input name="username" aria-label="你的用户名" autoComplete="nickname" autoFocus required maxLength={24} value={name} onChange={event => setName(event.target.value)} placeholder="大家该怎么称呼你？" disabled={state.busy}/></label><Action icon="arrowRight" primary type="submit" disabled={state.busy || !state.ready || !name.trim()}>进入房间大厅</Action></section>
    <p className="sw-footnote">无需注册 · 房间连续无人 15 分钟后自动关闭</p>
  </form></main>;
}
function Lobby({ state, service, create, join, remove }: { state:RoomState; service:RoomService; create:() => void; join:() => void; remove:(room:Room) => void }) {
  const [query, setQuery] = useState('');
  const rooms = state.rooms.filter(room => `${room.name} ${room.description}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  return <main className="lr-room sw-lobby"><header className="sw-lobby-heading"><div><h1>来客厅坐坐。</h1><p>挑一个房间，和大家一起看、一起分享。</p></div><Action icon="plus" primary onClick={create} disabled={state.busy || !state.configured}>创建房间</Action></header>
    {!state.configured && <div className="lr-notice is-bad"><span className="lr-pill"><Glyph name="alert"/>声网尚未配置，请填写服务端 .env 后重启。</span></div>}
    <Row><label className="lr-input sw-search"><Glyph name="eye"/><input type="search" placeholder="搜索房间" aria-label="搜索房间" value={query} onChange={event => setQuery(event.target.value)}/></label><span className="sw-count">{state.rooms.length} 个开放房间</span><span className="lr-spacer"/><Action icon="link" onClick={join} disabled={state.busy}>使用邀请链接</Action></Row>
    <div className="lr-viewer-overview-scroll sw-room-list" role="list" aria-label="开放房间">{rooms.map(room => <article key={room.id} className="sw-room-row" role="listitem"><button className="sw-room-enter" disabled={state.busy} onClick={() => void service.join(room)} aria-label={`进入房间：${room.name}`}><span className="sw-room-icon"><Glyph name="tv" size={28}/></span><span className="sw-room-copy"><strong>{room.name}</strong><span>{room.description || '欢迎加入，一起分享屏幕。'}</span></span><span className="sw-room-presence">{room.onlineCount ? `${room.onlineCount} 人在线` : `空房间 · ${Math.max(1, Math.ceil(((room.closesAt || Date.now()) - Date.now()) / 60000))} 分钟后关闭`}</span><Glyph name="arrowRight"/></button>{room.isOwner && <button className="lr-btn is-dense is-quiet" onClick={() => remove(room)} disabled={state.busy} aria-label={`关闭房间：${room.name}`}><Glyph name="x"/></button>}</article>)}
      {!rooms.length && <div className="sw-lobby-empty"><BrandMark size={64}/><h2>{query ? '没有找到这个房间。' : '客厅准备好了，等你开场。'}</h2><p>{query ? '换个关键词试试。' : '创建一个房间，邀请朋友一起分享。'}</p></div>}
    </div><p className="sw-footnote"><Glyph name="clock" size={14}/>房间空置 15 分钟自动关闭 · 每位成员都能同时共享</p>
  </main>;
}
function VideoSurface({ state }: { state:RoomState }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { if (!ref.current || !state.video) return; state.video.play(ref.current, { fit:state.preferences.fit, mirror:false }); return () => { state.video?.stop(); }; }, [state.video, state.preferences.fit]);
  return <div ref={ref} id="agora-player" className="sw-video" hidden={!state.video}/>;
}
function RoomPage({ state, service, settings, edit, members }: { state:RoomState; service:RoomService; settings:() => void; edit:() => void; members:() => void }) {
  const owner = state.members.find(person => person.isOwner);
  const selected = state.members.find(person => person.uid === state.selected);
  const entries:CouchEntry[] = state.members.filter(person => person !== owner).map(person => ({ key:String(person.uid), name:person.name, you:person.uid === state.uid, selectable:true, status:{ tone:person.sharing ? 'live' : 'off', labelKey:person.sharing ? 'state.peer.connected' : 'state.peer.present', icon:person.sharing ? 'share' : 'users', comic:'signal-connected' } }));
  const fullscreen = () => { const element = document.querySelector<HTMLElement>('.lr-tv-screen'); const task = document.fullscreenElement ? document.exitFullscreen() : element?.requestFullscreen(); void task?.catch(() => {}); };
  return <main className="lr-room sw-room"><div className="sw-room-heading"><div><h1>{state.room?.name}</h1><p>{state.room?.description || '每个人都可以分享，点击成员切换观看。'}</p></div><span className="sw-count">{state.members.length} 人在线 · {state.members.filter(person => person.sharing).length} 路共享</span></div>
    <div className="lr-scene"><StageTv label="共享画面" live={!!state.video} indicator={<span className={`sw-tv-lamp${state.connected ? ' is-live' : ''}`} aria-label={state.connection}/>}>
      <VideoSurface state={state}/>{!state.video && <StageOverlay icon={state.connecting ? 'loader' : 'tv'} comic={state.connecting ? 'signal-connecting' : 'waiting-for-host'} waiting={state.connecting} message={state.connecting ? '正在连接声网…' : selected ? `${selected.name} 暂未共享画面` : '等待大家分享画面'}/>}
      <div className="sw-playback"><span className="sw-watching">{state.video ? `正在观看 · ${selected?.name || '共享画面'}${state.selected === state.uid ? '（你）' : ''}` : '选择下方成员，切换共享画面'}</span><div><Btn icon={state.preferences.muted ? 'speakerOff' : 'speaker'} title={state.preferences.muted ? 'playback.unmute' : 'playback.mute'} size="dense" quiet onClick={() => service.savePreferences({ ...state.preferences,muted:!state.preferences.muted })}/><Btn icon="expand" title="playback.fullscreen" size="dense" quiet onClick={fullscreen}/></div></div>
    </StageTv><div className="lr-host-controls"><div className="lr-media-controls lr-host-share-controls"><div className="lr-host-action-dock">
      {state.sharing ? <Btn icon="stop" tone="danger" title="host.stop" cap="host.stop" disabled={state.busy} onClick={() => void service.stop()}/> : <Btn icon="share" tone="primary" title="host.start" cap="host.start" busy={state.connecting} disabled={state.busy || state.connecting} onClick={() => void service.share()}/>}
    </div><div className="lr-host-tool-dock"><Btn icon="sliders" title="host.settings.button" cap="host.settings.button" onClick={settings}/><Btn icon="link" title="host.invite.copy" cap="host.invite.copy" onClick={() => void service.copyInvite()}/><Action icon="users" onClick={members}>成员</Action><Action icon="arrowLeft" onClick={() => void service.leave()} disabled={state.busy}>离开房间</Action></div></div></div>
    <p className="sw-stage-caption">{state.caption}</p><div className="sw-roster"><Couch view="host" host={owner ? { key:String(owner.uid),name:owner.name,you:owner.uid === state.uid,selected:state.selected === owner.uid,onSelect:() => void service.select(owner.uid) } : undefined} entries={entries} selectedKey={state.selected === undefined ? undefined : String(state.selected)} onSelect={key => void service.select(Number(key))} footerAction={<><span className="lr-couch-count sw-total-count" aria-label={`房间成员 ${state.members.length}`}><Glyph name="users" size={14}/><b>{state.members.length}</b></span><button className="lr-btn is-dense is-quiet" onClick={members}><Glyph name="users" size={14}/><span className="lr-cap">房间成员</span></button></>}/></div></div>
    <div className="lr-deck"><Row><span className="sw-room-code"><Glyph name="tv"/><span>{state.room?.id.toUpperCase()}</span></span><NameTag name={state.name} identity={String(state.uid)}/><span className="lr-spacer"/>{state.room?.isOwner && <Action icon="pencil" onClick={edit}>编辑房间</Action>}<details className="sw-invite"><summary>邀请链接</summary><input className="lr-invite-url" readOnly value={state.room ? inviteUrl(state.room) : ''} aria-label="房间邀请链接" onFocus={event => event.currentTarget.select()}/></details></Row></div>
  </main>;
}
function Choices<T extends string | number>({ label, options, value, onChange }: { label:string; options:[T,string][]; value:T; onChange:(value:T) => void }) {
  return <div className="lr-door-group"><strong className="lr-field-cap">{label}</strong><div className="lr-row-group" role="group" aria-label={label}>{options.map(([item,title]) => <Chip key={item} title={title} selected={value === item} onClick={() => onChange(item)}>{title}</Chip>)}</div></div>;
}
function Settings({ state, service, close }: { state:RoomState; service:RoomService; close:() => void }) {
  const [draft, setDraft] = useState(state.preferences);
  const change = (patch:Partial<Preferences>, immediate = false) => { setDraft(previous => ({ ...previous,...patch })); if (immediate) service.savePreferences({ ...state.preferences,...patch }); };
  const presets:[string,Preferences['resolution'],Preferences['fps'],Preferences['bitrate']][] = [['轻量','720',30,3000],['高清','1080',30,5000],['高帧率','1080',60,8000]];
  const presetNodes = <div className="lr-tiles">{presets.map(([title,resolution,fps,bitrate]) => <button type="button" key={title} className={`lr-tile${draft.resolution === resolution && draft.fps === fps && draft.bitrate === bitrate ? ' is-selected' : ''}`} aria-pressed={draft.resolution === resolution && draft.fps === fps && draft.bitrate === bitrate} onClick={() => change({ resolution,fps,bitrate })}><QualityTileGlyph resolution={`${resolution}p`} framerate={fps}/><strong>{title}</strong><small>{resolution}p {fps} 帧</small></button>)}</div>;
  return <Modal title="共享与观看设置" close={close} wide><SharingSettings id="sharing-options" open presets={presetNodes} pictureSummary={<span className="lr-sharing-picture-summary"><span>{draft.resolution}p</span><span>{draft.fps} fps</span><span>{draft.bitrate/1000} Mbps</span></span>} picture={<>
    <Choices label="目标分辨率" options={(['480','720','1080','1440'] as const).map(value => [value,`${value}p`])} value={draft.resolution} onChange={resolution => change({ resolution })}/>
    <div className="lr-sharing-limits"><Choices label="目标帧率" options={([15,24,30,60] as const).map(value => [value,`${value} fps`])} value={draft.fps} onChange={fps => change({ fps })}/><Choices label="最大视频码率" options={([1000,2000,3000,5000,8000] as const).map(value => [value,`${value/1000} Mbps`])} value={draft.bitrate} onChange={bitrate => change({ bitrate })}/></div>
    <Choices label="弱网优化" options={[["detail","清晰优先"],["balanced","均衡"],["motion","流畅优先"]]} value={draft.optimization} onChange={optimization => change({ optimization })}/>
    <Choices label="观看画面适配" options={[["contain","完整显示"],["cover","填满画面"]]} value={draft.fit} onChange={fit => change({ fit },true)}/>
  </>} audio={<>
    <div className="lr-door-group"><SwitchItem checked={draft.audio} onChange={audio => change({ audio })} label="共享所选来源的音频" icon="speaker"/><p className="sw-settings-note">标签页带标签页音频，窗口带窗口音频，整个屏幕带系统音频。在浏览器选择器中勾选共享音频，实际可用性由浏览器和操作系统决定。</p></div>
    <SwitchItem checked={draft.includeSelf} onChange={includeSelf => change({ includeSelf })} label="允许选择本站标签页" icon="window"/>
    <div className="lr-door-group"><strong className="lr-field-cap">观看音量</strong><label className="lr-slider"><Glyph name="speaker"/><input type="range" min={0} max={100} value={draft.volume} onChange={event => change({ volume:Number(event.target.value) },true)} aria-label="观看音量"/><output>{draft.volume}%</output></label></div>
    <SwitchItem checked={draft.muted} onChange={muted => change({ muted },true)} label="静音观看" icon="speakerOff"/>
  </>}/><footer className="sw-dialog-footer"><Action icon="refresh" onClick={() => { setDraft({ ...defaults }); service.savePreferences({ ...state.preferences,volume:defaults.volume,muted:defaults.muted,fit:defaults.fit }); }}>恢复默认</Action><span className="sw-settings-note">共享参数在下次开始共享时生效。</span><Action icon="check" primary onClick={() => { service.savePreferences(draft); close(); }}>保存设置</Action></footer></Modal>;
}
function RoomEditor({ room, service, close, busy }: { room?:Room; service:RoomService; close:() => void; busy:boolean }) {
  return <Modal title={room ? '编辑房间' : '给大家留个位置。'} close={close}><form className="sw-form" onSubmit={async event => { event.preventDefault(); const form = new FormData(event.currentTarget); if (await service.saveRoom({ name:String(form.get('name')),description:String(form.get('description')) },room)) close(); }}>
    <label>房间名称<span className="lr-input"><Glyph name="tv"/><input name="name" defaultValue={room?.name} placeholder="比如：周末放映室" required maxLength={40} autoFocus/></span></label><label>房间描述 <small>选填</small><textarea name="description" defaultValue={room?.description} placeholder="正在分享什么，想一起做什么？" maxLength={160} rows={3}/></label><p className="sw-settings-note">房间会出现在大厅，空置 15 分钟后自动关闭。</p><Action icon="arrowRight" primary type="submit" disabled={busy}>{room ? '保存修改' : '创建并进入'}</Action>
  </form></Modal>;
}
function App({ service }: { service:RoomService }) {
  const state = useSyncExternalStore(service.subscribe, service.getSnapshot);
  const [dialog,setDialog] = useState<'create'|'edit'|'join'|'settings'|'help'|'members'|null>(null);
  const [removing,setRemoving] = useState<Room>();
  const close = () => setDialog(null);
  useEffect(() => { document.body.dataset.view = state.view; },[state.view]);
  return <div className={`lr-app sw-app${state.view === 'room' ? ' is-room' : ''}`}><Header state={state} service={service} help={() => setDialog('help')}/>
    {state.view === 'welcome' ? <Welcome state={state} service={service}/> : state.view === 'lobby' ? <Lobby state={state} service={service} create={() => setDialog('create')} join={() => setDialog('join')} remove={setRemoving}/> : <RoomPage state={state} service={service} settings={() => setDialog('settings')} edit={() => setDialog('edit')} members={() => setDialog('members')}/>}
    {state.notice && <div className={`lr-notice sw-notice ${state.notice.error ? 'is-bad' : 'is-good'}`} role={state.notice.error ? 'alert' : 'status'}><span className="lr-pill"><Glyph name={state.notice.error ? 'alert' : 'check'}/>{state.notice.message}</span><button className="lr-btn is-dense is-quiet" onClick={service.dismissNotice} aria-label="关闭通知"><Glyph name="x"/></button></div>}
    {(dialog === 'create' || dialog === 'edit') && <RoomEditor key={dialog} room={dialog === 'edit' ? state.room : undefined} service={service} busy={state.busy} close={close}/>}
    {dialog === 'join' && <Modal title="进入朋友的房间" close={close}><form className="sw-form" onSubmit={async event => { event.preventDefault(); const form = new FormData(event.currentTarget); if (await service.joinInvite(String(form.get('invite')))) close(); }}><label>房间邀请链接<span className="lr-input"><Glyph name="link"/><input name="invite" type="url" placeholder="粘贴邀请链接" required autoFocus/></span></label><Action icon="arrowRight" primary type="submit" disabled={state.busy}>进入房间</Action></form></Modal>}
    {dialog === 'settings' && <Settings state={state} service={service} close={close}/>}
    {dialog === 'help' && <Modal title="一起分享，随时切换。" close={close}><div className="sw-help"><BrandMark size={60}/><p>输入用户名，在大厅选择房间或创建房间。房间内每位成员都可以同时共享。</p><p>点击沙发上的成员或成员列表，切换到对方的画面和声音。切换观看不会结束自己的共享。</p><p>最后一人离开后，房间连续空置 15 分钟会自动关闭。</p><a href="https://github.com/TNTcraftHIM/Piik" target="_blank" rel="noreferrer">界面基于 Piik 开源前端 · MIT</a><div className="sw-help-badge"><span className="lr-field-cap">RTC 用量</span><RtcUsageBadge/></div></div></Modal>}
    {dialog === 'members' && <Modal title={`房间成员 · ${state.members.length}`} close={close}><div className="sw-members" role="list">{state.members.map(person => <button key={person.uid} className={`lr-viewer-overview-row${state.selected === person.uid ? ' is-selected' : ''}`} onClick={() => { void service.select(person.uid); close(); }} aria-label={`观看 ${person.name} 的共享`}><NameTag name={`${person.name}${person.uid === state.uid ? '（你）' : ''}`} identity={String(person.uid)}/><span>{person.sharing ? '正在共享' : '在线'}{person.isOwner ? ' · 房主' : ''}</span></button>)}</div></Modal>}
    {removing && <Modal title="关闭这个房间？" close={() => setRemoving(undefined)}><p>关闭“{removing.name}”后，所有成员将退出，邀请链接会失效。</p><footer className="sw-dialog-footer"><Action icon="x" onClick={() => setRemoving(undefined)}>取消</Action><Action icon="stop" danger disabled={state.busy} onClick={async () => { if (await service.removeRoom(removing)) setRemoving(undefined); }}>确认关闭</Action></footer></Modal>}
  </div>;
}
export function mountApp(service:RoomService) { createRoot(document.getElementById('app')!).render(<App service={service}/>); }
