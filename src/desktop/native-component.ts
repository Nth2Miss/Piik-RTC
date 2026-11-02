import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { desktopBridge, isDesktopApp, type DesktopNativeComponentProgress, type DesktopNativeComponentStatus } from './bridge';

const SKIP_PREFIX = 'piik-native-component-skip:';
let sharedStatus: DesktopNativeComponentStatus | undefined;
const statusListeners = new Set<() => void>();

function subscribeStatus(listener: () => void) {
  statusListeners.add(listener);
  return () => { statusListeners.delete(listener); };
}

function readStatus() {
  return sharedStatus;
}

function publishStatus(value: DesktopNativeComponentStatus) {
  if (sharedStatus?.available && !value.available) return;
  sharedStatus = value;
  statusListeners.forEach(listener => listener());
}

function isVolcProvider(provider?: string) {
  return provider === 'volc' || provider === 'volc2';
}

function skipKey(version: string) {
  return SKIP_PREFIX + (version || 'unknown');
}

function readSkip(version: string) {
  if (!version) return false;
  try { return localStorage.getItem(skipKey(version)) === '1'; } catch { return false; }
}

function writeSkip(version: string) {
  if (!version) return;
  try { localStorage.setItem(skipKey(version), '1'); } catch { /* optional storage */ }
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/** Optional native component status and installer for Windows desktop Volc rooms. */
export function useNativeComponent(provider?: string, onInstalled?: () => Promise<unknown> | unknown) {
  const enabled = isDesktopApp && !!desktopBridge?.nativeComponent && isVolcProvider(provider);
  const status = useSyncExternalStore(subscribeStatus, readStatus);
  const [loading, setLoading] = useState(enabled);
  const [installing, setInstalling] = useState(false);
  const [progress, setProgress] = useState<DesktopNativeComponentProgress>();
  const [error, setError] = useState<string>();
  const [skipVersion, setSkipVersion] = useState('');
  const installedRef = useRef(onInstalled);
  installedRef.current = onInstalled;

  const version = status?.latestVersion || status?.installedVersion || '';
  const needsInstall = enabled && !!status && status.supported && !status.available;
  const showBanner = needsInstall && skipVersion !== version;
  const showSharePrompt = needsInstall && skipVersion !== version;

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      setInstalling(false);
      setProgress(undefined);
      setError(undefined);
      setSkipVersion('');
      return;
    }
    let cancelled = false;
    setLoading(true);
    setInstalling(false);
    setProgress(undefined);
    setError(undefined);
    setSkipVersion('');
    const unsubscribe = desktopBridge?.onNativeComponentProgress?.(value => {
      if (!cancelled) setProgress(value);
    });
    desktopBridge!.nativeComponent!({ operation: 'status' })
      .then(value => {
        if (cancelled) return;
        publishStatus(value);
        const current = value.latestVersion || value.installedVersion || '';
        setSkipVersion(readSkip(current) ? current : '');
      })
      .catch(reason => { if (!cancelled) setError(message(reason)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; unsubscribe?.(); };
  }, [enabled, provider]);

  const install = useCallback(async () => {
    if (!enabled || installing) return false;
    setInstalling(true);
    setError(undefined);
    setProgress(undefined);
    let installed = false;
    try {
      const value = await desktopBridge!.nativeComponent!({ operation: 'install' });
      publishStatus(value);
      setSkipVersion('');
      installed = value.available;
    } catch (reason) {
      setError(message(reason));
    } finally {
      setInstalling(false);
    }
    if (installed) {
      try { await installedRef.current?.(); } catch { /* media reconnection is reported by the service */ }
    }
    return installed;
  }, [enabled, installing]);

  const dismiss = useCallback(() => {
    if (!version) return;
    writeSkip(version);
    setSkipVersion(version);
  }, [version]);

  const refresh = useCallback(async () => {
    if (!enabled || installing) return;
    setLoading(true);
    setError(undefined);
    try {
      const value = await desktopBridge!.nativeComponent!({ operation: 'status', force: true });
      publishStatus(value);
      const current = value.latestVersion || value.installedVersion || '';
      setSkipVersion(readSkip(current) ? current : '');
    } catch (reason) {
      setError(message(reason));
    } finally {
      setLoading(false);
    }
  }, [enabled, installing]);

  return {
    enabled, status, loading, installing, progress, error, needsInstall,
    showBanner, showSharePrompt, install,
    dismissBanner: dismiss,
    skipShare: dismiss,
    refresh,
  };
}
