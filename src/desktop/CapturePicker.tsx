import { useEffect, useMemo, useRef, useState } from 'react';
import { Glyph } from '../vendor/piik/src/client/ui/icons.tsx';
import type { Preferences } from '../preferences.ts';
import {
  desktopBridge,
  type CaptureSelection,
  type DesktopApp,
  type DesktopSource,
  type DesktopSourceList,
} from './bridge.ts';

interface Props {
  preferences: Preferences;
  onClose: () => void;
  onConfirm: (selection: CaptureSelection, preferences: Preferences) => void;
}

type Tab = 'window' | 'screen';

interface ResolvedSource {
  pid: number | null;
  appName: string | null;
  voice: boolean;
}

const RESOLUTIONS: { value: Preferences['resolution']; label: string }[] = [
  { value: '720', label: '720p' },
  { value: '1080', label: '1080p' },
  { value: '1440', label: '1440p' },
  { value: 'native', label: '原画' },
];
const FRAME_RATES: Preferences['fps'][] = [15, 24, 30, 60];

function uniqueApps(apps: DesktopApp[]): DesktopApp[] {
  const byApp = new Map<string, DesktopApp>();
  for (const app of apps) {
    const key = (app.exe || app.name).toLowerCase();
    const existing = byApp.get(key);
    if (!existing
      || app.windows > existing.windows
      || (app.windows === existing.windows && app.pid < existing.pid)) {
      byApp.set(key, app);
    }
  }
  return [...byApp.values()].sort((left, right) => {
    if (left.voice !== right.voice) return left.voice ? -1 : 1;
    return left.name.localeCompare(right.name);
  });
}

export function DesktopCapturePicker({ preferences, onClose, onConfirm }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const confirmed = useRef(false);
  const [tab, setTab] = useState<Tab>('window');
  const [data, setData] = useState<DesktopSourceList | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<Partial<Record<Tab, string>>>({});
  const [resolved, setResolved] = useState<Record<string, ResolvedSource>>({});
  const [resolving, setResolving] = useState<Record<string, boolean>>({});
  const [resolution, setResolution] = useState<Preferences['resolution']>(preferences.resolution);
  const [fps, setFps] = useState<Preferences['fps']>(preferences.fps);
  const [audio, setAudio] = useState(preferences.audio);
  const [filterVoice, setFilterVoice] = useState(preferences.filterVoice);
  const [filterPid, setFilterPid] = useState<number | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    void desktopBridge?.clearSource();
    return () => {
      if (dialog?.open) dialog.close();
      if (!confirmed.current) void desktopBridge?.clearSource();
    };
  }, []);

  const apps = useMemo(() => uniqueApps(data?.apps ?? []), [data]);
  const voiceApps = useMemo(() => apps.filter(app => app.voice), [apps]);
  const otherApps = useMemo(() => apps.filter(app => !app.voice && app.windows > 0), [apps]);

  async function refresh() {
    const bridge = desktopBridge;
    if (!bridge) {
      setError('桌面采集组件不可用，请通过 Piik 桌面端打开。');
      setLoading(false);
      return;
    }
    setLoading(true);
    setError('');
    try {
      const next = await bridge.listSources();
      setData(next);
      setSelected(previous => {
        const keep = (id?: string) => id && next.sources.some(source => source.id === id) ? id : undefined;
        return { window: keep(previous.window), screen: keep(previous.screen) };
      });
      if (!next.sources.some(source => source.kind === 'window') && next.sources.some(source => source.kind === 'screen')) {
        setTab('screen');
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => {
    if (filterPid !== null && apps.some(app => app.pid === filterPid)) return;
    setFilterPid(voiceApps[0]?.pid ?? null);
  }, [apps, voiceApps, filterPid]);

  const capabilities = data?.capabilities;
  const canProcessAudio = capabilities?.available === true && capabilities.processLoopback === true;
  const sources = (data?.sources ?? []).filter(source => source.kind === tab);
  const currentId = selected[tab];
  const currentSource = sources.find(source => source.id === currentId);
  const currentResolved = currentId ? resolved[currentId] : undefined;
  const currentPid = currentResolved?.pid ?? currentSource?.pid ?? null;
  const currentResolving = currentId ? resolving[currentId] === true : false;
  const appAudioReady = canProcessAudio && currentPid !== null;
  const filterReady = canProcessAudio && (voiceApps.length > 0 || otherApps.length > 0);
  const filterEnabled = filterVoice && filterReady;
  const filterApp = apps.find(app => app.pid === filterPid) ?? null;

  async function pick(source: DesktopSource) {
    setSelected(previous => ({ ...previous, [source.kind]: source.id }));
    if (resolved[source.id] || resolving[source.id]) return;
    const bridge = desktopBridge;
    if (!bridge) return;
    setResolving(previous => ({ ...previous, [source.id]: true }));
    try {
      const result = await bridge.selectSource(source.id);
      if (result.ok) {
        setResolved(previous => ({
          ...previous,
          [source.id]: {
            pid: result.pid ?? source.pid ?? null,
            appName: result.appName ?? source.appName ?? null,
            voice: result.voice ?? source.voice,
          },
        }));
      }
    } catch {
      /* fall back to the process id from the source list */
    } finally {
      setResolving(previous => {
        const next = { ...previous };
        delete next[source.id];
        return next;
      });
    }
  }

  function confirm() {
    if (!currentSource) return;
    const pid = currentResolved?.pid ?? currentSource.pid ?? null;
    let mode: CaptureSelection['audio'] = 'none';
    let filter: number | null = null;
    if (audio) {
      if (currentSource.kind === 'screen') {
        mode = 'system';
        filter = filterEnabled ? filterPid : null;
      } else if (appAudioReady) {
        mode = 'app';
      }
    }
    confirmed.current = true;
    onConfirm({
      sourceId: currentSource.id,
      kind: currentSource.kind,
      name: currentSource.name,
      pid,
      audio: mode,
      filterPid: filter,
      filterName: filterApp?.title || filterApp?.name || null,
    }, {
      ...preferences,
      resolution,
      fps,
      audio,
      filterVoice: filterVoice,
    });
  }

  const screenIndex = currentSource?.kind === 'screen'
    ? (data?.sources.filter(source => source.kind === 'screen').findIndex(source => source.id === currentSource.id) ?? -1)
    : -1;
  const currentTitle = currentSource
    ? currentSource.kind === 'screen' ? `屏幕 ${screenIndex >= 0 ? screenIndex + 1 : 1}` : currentSource.name
    : '';

  return <dialog
    ref={dialogRef}
    className="sw-dialog sw-capture-dialog"
    aria-label="屏幕共享"
    onCancel={event => { event.preventDefault(); onClose(); }}
    onClick={event => {
      if (event.target !== event.currentTarget) return;
      const box = event.currentTarget.getBoundingClientRect();
      if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) onClose();
    }}
  >
    <header className="dsc-head">
      <div className="dsc-title"><h2>屏幕共享</h2><small>选择程序或屏幕，再开始共享</small></div>
      <button type="button" className="lr-btn is-compact is-quiet" onClick={onClose} aria-label="关闭"><Glyph name="x"/></button>
    </header>

    <div className="dsc-body">
      <main className="dsc-main">
        <div className="dsc-toolbar">
          <div className="dsc-tabs" role="tablist" aria-label="共享来源">
            <button type="button" role="tab" aria-selected={tab === 'window'} className={`dsc-tab${tab === 'window' ? ' is-active' : ''}`} onClick={() => setTab('window')}>程序<span>{data?.sources.filter(source => source.kind === 'window').length ?? 0}</span></button>
            <button type="button" role="tab" aria-selected={tab === 'screen'} className={`dsc-tab${tab === 'screen' ? ' is-active' : ''}`} onClick={() => setTab('screen')}>屏幕<span>{data?.sources.filter(source => source.kind === 'screen').length ?? 0}</span></button>
          </div>
          <button type="button" className="lr-btn is-dense is-quiet" onClick={() => void refresh()} disabled={loading}><Glyph name="refresh" size={14}/><span className="lr-cap">刷新</span></button>
        </div>

        {loading ? <div className="dsc-loading"><Glyph name="loader" size={22}/><span>正在读取可共享的程序和屏幕…</span></div>
          : error ? <div className="dsc-loading dsc-error"><Glyph name="alert" size={22}/><span>{error}</span><button type="button" className="lr-btn is-dense" onClick={() => void refresh()}>重试</button></div>
            : !sources.length ? <div className="dsc-empty"><Glyph name={tab === 'window' ? 'window' : 'display'} size={30}/><h3>{tab === 'window' ? '没有可共享的程序' : '没有检测到屏幕'}</h3><p>{tab === 'window' ? '最小化的窗口需要先恢复，再刷新列表。' : '请检查显示器连接后刷新。'}</p></div>
              : <div className="dsc-grid" role="listbox" aria-label={tab === 'window' ? '程序列表' : '屏幕列表'}>
                {sources.map((source, index) => {
                  const selectedNow = source.id === currentId;
                  const title = source.kind === 'screen' ? `屏幕 ${index + 1}` : source.name;
                  return <button
                    type="button"
                    role="option"
                    aria-selected={selectedNow}
                    key={source.id}
                    className={`dsc-card${selectedNow ? ' is-selected' : ''}`}
                    onClick={() => void pick(source)}
                  >
                    <span className="dsc-thumb">
                      {source.thumbnail
                        ? <img src={source.thumbnail} alt="" draggable={false}/>
                        : <span className="dsc-thumb-empty"><Glyph name={source.kind === 'screen' ? 'display' : 'window'} size={28}/></span>}
                    </span>
                    <span className="dsc-name">{source.icon && <img className="dsc-app-icon" src={source.icon} alt=""/>}<span title={title}>{title}</span></span>
                  </button>;
                })}
              </div>}
      </main>

      <aside className="dsc-side">
        <section className="dsc-section">
          <strong className="dsc-label">分辨率</strong>
          <div className="dsc-chips">{RESOLUTIONS.map(option => <button type="button" key={option.value} className={`dsc-chip${resolution === option.value ? ' is-selected' : ''}`} aria-pressed={resolution === option.value} onClick={() => setResolution(option.value)}>{option.label}</button>)}</div>
        </section>

        <section className="dsc-section">
          <strong className="dsc-label">帧率</strong>
          <div className="dsc-chips">{FRAME_RATES.map(value => <button type="button" key={value} className={`dsc-chip${fps === value ? ' is-selected' : ''}`} aria-pressed={fps === value} onClick={() => setFps(value)}>{value} fps</button>)}</div>
        </section>

        <section className="dsc-section">
          <strong className="dsc-label">音频</strong>
          {tab === 'window' ? <>
            <label className="dsc-check"><input type="checkbox" checked={audio && appAudioReady} disabled={!appAudioReady} onChange={event => setAudio(event.target.checked)}/><span>共享该程序的声音</span></label>
            <p className="dsc-note">{!capabilities?.available ? '原生音频组件不可用，本次只能共享画面。' : !capabilities.processLoopback ? '当前 Windows 版本不支持程序声音，需要 Windows 10 2004（19041）或更高版本。' : currentSource && !appAudioReady ? '暂时无法识别这个程序的进程，本次只能共享画面。' : '只采集所选程序及其子进程的声音；部分程序把声音放在独立进程里时可能采集不到。'}</p>
          </> : <>
            <label className="dsc-check"><input type="checkbox" checked={audio} onChange={event => setAudio(event.target.checked)}/><span>共享系统声音</span></label>
            {audio && <div className="dsc-filter">
              <label className="dsc-check"><input type="checkbox" checked={filterEnabled} disabled={!filterReady} onChange={event => setFilterVoice(event.target.checked)}/><span>过滤语音软件的声音</span></label>
              {filterEnabled && <select className="dsc-select" value={filterPid ?? ''} onChange={event => setFilterPid(event.target.value ? Number(event.target.value) : null)} aria-label="要过滤的程序">
                {voiceApps.length === 0 && otherApps.length === 0 && <option value="">未检测到可过滤的程序</option>}
                {voiceApps.length > 0 && <optgroup label="语音软件">{voiceApps.map(app => <option key={app.pid} value={app.pid}>{app.title || app.name}{app.pid === filterPid ? '' : ` · ${app.pid}`}</option>)}</optgroup>}
                {otherApps.length > 0 && <optgroup label="其他程序">{otherApps.map(app => <option key={app.pid} value={app.pid}>{app.title || app.name}{app.pid === filterPid ? '' : ` · ${app.pid}`}</option>)}</optgroup>}
              </select>}
            </div>}
            <p className="dsc-note">{!capabilities?.available ? '原生音频组件不可用，本次只能共享画面。' : !capabilities.processLoopback ? '当前 Windows 版本不支持过滤语音软件，你的小伙伴可能会听到回声。可改用 Windows 10 2004（19041）及以上版本。' : filterEnabled ? '开启后会自动过滤所选语音软件的声音，避免小伙伴听到回声。一次过滤一个程序；语音软件重启后请重新开始共享。' : '共享整个系统的声音。开启过滤可避免 Oopz、KOOK 等语音软件的声音被再次传出去。'}</p>
          </>}
          {capabilities?.available === false && <p className="dsc-warn"><Glyph name="alert" size={14}/><span>{capabilities.message || '原生音频组件不可用。'}</span></p>}
        </section>

        <span className="dsc-spacer"/>
        {currentSource && <p className="dsc-note">已选择：{currentTitle}{tab === 'window' && currentPid ? ` · PID ${currentPid}` : ''}</p>}
        <button type="button" className="lr-btn is-primary dsc-start" disabled={!currentSource || currentResolving} onClick={confirm}><Glyph name="share"/><span className="lr-cap">{currentResolving ? '正在准备…' : '开始共享'}</span></button>
      </aside>
    </div>
  </dialog>;
}
