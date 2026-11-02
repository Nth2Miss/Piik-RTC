import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { desktopBridge, isDesktopApp, type DesktopNativeComponentProgress, type DesktopNativeComponentStatus } from './bridge';

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

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function setNativeComponentStatus(value: DesktopNativeComponentStatus) {
  publishStatus(value);
}

/** Optional native component status and installer for Windows desktop Volc rooms. */
export function useNativeComponent(provider?: string, onInstalled?: () => Promise<unknown> | unknown) {
  const enabled = isDesktopApp && !!desktopBridge?.nativeComponent && isVolcProvider(provider);
  const status = useSyncExternalStore(subscribeStatus, readStatus);
  const [loading, setLoading] = useState(enabled);
  const [installing, setInstalling] = useState(false);
  const [progress, setProgress] = useState<DesktopNativeComponentProgress>();
  const [error, setError] = useState<string>();
  const installedRef = useRef(onInstalled);
  installedRef.current = onInstalled;

  const needsInstall = enabled && !!status && status.supported && !status.available;

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      setInstalling(false);
      setProgress(undefined);
      setError(undefined);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setInstalling(false);
    setProgress(undefined);
    setError(undefined);
    const unsubscribe = desktopBridge?.onNativeComponentProgress?.(value => {
      if (!cancelled) setProgress(value);
    });
    desktopBridge!.nativeComponent!({ operation: 'status' })
      .then(value => { if (!cancelled) publishStatus(value); })
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

  const refresh = useCallback(async () => {
    if (!enabled || installing) return;
    setLoading(true);
    setError(undefined);
    try {
      publishStatus(await desktopBridge!.nativeComponent!({ operation: 'status', force: true }));
    } catch (reason) {
      setError(message(reason));
    } finally {
      setLoading(false);
    }
  }, [enabled, installing]);

  return { enabled, status, loading, installing, progress, error, needsInstall, install, refresh };
}
