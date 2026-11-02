import type { RtcRemoteUser } from './types';

/** Prevent late SDK results from restoring a subscription after timeout or exit. */
export class SubscriptionTasks {
  private current = new Map<RtcRemoteUser, { cancel: () => void }>();
  async run<T>(user: RtcRemoteUser, signal: AbortSignal | undefined, read: () => Promise<T>, commit: (value: T) => void, release: () => void | Promise<void>) {
    signal?.throwIfAborted();
    const cleanup = async () => { try { await release(); } catch { /* connection may already be closed */ } };
    let pending = true;
    const task = { cancel:() => {
      if (this.current.get(user) !== task) return;
      this.current.delete(user);
      if (pending) void cleanup();
    } };
    this.cancel(user);
    this.current.set(user, task);
    signal?.addEventListener('abort', task.cancel, { once:true });
    try {
      const value = await read();
      if (signal?.aborted || this.current.get(user) !== task) {
        if (!this.current.has(user)) await cleanup();
        throw new Error('订阅已取消。');
      }
      commit(value);
    } finally {
      signal?.removeEventListener('abort', task.cancel);
      // Retain the latest task identity so an older result cannot stop a successful retry.
      pending = false;
    }
  }
  cancel(user: RtcRemoteUser) { this.current.get(user)?.cancel(); }
  clear() { for (const task of this.current.values()) task.cancel(); }
}
