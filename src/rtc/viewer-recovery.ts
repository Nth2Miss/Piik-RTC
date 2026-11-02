export interface ViewerRecoveryState {
  scope?: string;
  enabled: boolean;
  connected: boolean;
  connecting: boolean;
  busy: boolean;
  sharing: boolean;
  visible: boolean;
  paused: boolean;
  leaseHealthy: boolean;
  intentRevision: number;
  targetUid?: number;
  published: boolean;
  videoReady: boolean;
  playbackBlocked: boolean;
}
export interface ViewerRecoveryRecord {
  uid: number;
  reason: 'missing-publication' | 'missing-first-frame';
  status: 'resubscribing' | 'resubscribed' | 'resubscribe-failed' | 'rejoining' | 'rejoined' | 'receiving' | 'cancelled' | 'failed';
  startedAt: number;
  completedAt?: number;
}
interface Options {
  read: () => ViewerRecoveryState;
  disconnect: () => Promise<void>;
  connect: () => Promise<void>;
  select: (uid: number) => Promise<void>;
  resubscribe?: (uid: number) => Promise<void>;
  changed: (record: ViewerRecoveryRecord) => void;
}

/** Rebuild a receiver only when authoritative presence and RTC delivery disagree. */
export class ViewerRecovery {
  private options: Options;
  private scope?: string;
  private missing?: {uid:number; reason:ViewerRecoveryRecord['reason']; since:number; publishedSince?:number};
  private attempted = new Set<number>();
  private softAttempted = new Set<number>();
  private hardRejoins = 0;
  private softWaitUntil?: {uid:number; at:number};
  private active?: object;
  private records: ViewerRecoveryRecord[] = [];
  constructor(options: Options) { this.options = options; }
  get running() { return this.active !== undefined; }
  get targetUid() { return this.active ? this.records.at(-1)?.uid : undefined; }
  export(): ViewerRecoveryRecord[] { return this.records.map(record => ({...record})); }
  cancel() { this.active = undefined; this.missing = undefined; }
  reset() { this.cancel(); this.scope = undefined; this.attempted.clear(); this.softAttempted.clear(); this.hardRejoins = 0; this.softWaitUntil = undefined; this.records = []; }
  private allowed(state: ViewerRecoveryState) {
    return !!state.scope && state.enabled && !state.busy && !state.sharing && state.visible && !state.paused && state.leaseHealthy;
  }
  tick(now = Date.now()) {
    const state = this.options.read();
    if (state.scope !== this.scope) {
      this.cancel(); this.scope = state.scope; this.attempted.clear(); this.softAttempted.clear(); this.hardRejoins = 0; this.softWaitUntil = undefined;
    }
    if (!this.allowed(state)) { this.missing = undefined; return; }
    const uid = state.targetUid;
    if (uid === undefined) { this.missing = undefined; return; }
    if (state.videoReady) {
      this.missing = undefined;
      this.softWaitUntil = undefined;
      const last = this.records.at(-1);
      if (last?.uid === uid && (last.status === 'rejoined' || last.status === 'resubscribed')) {
        last.status = 'receiving'; last.completedAt = now; this.options.changed({...last});
      }
      return;
    }
    if (this.running) return;
    if (!state.connected || state.connecting || state.playbackBlocked) { this.missing = undefined; return; }
    const reason = state.published ? 'missing-first-frame' : 'missing-publication';
    if (this.missing?.uid !== uid) { this.missing = {uid,reason,since:now,publishedSince:state.published ? now : undefined}; return; }
    if (reason !== this.missing.reason) this.missing.publishedSince = state.published ? now : undefined;
    this.missing.reason = reason;
    const elapsed = now - this.missing.since;
    const publishedElapsed = now - (this.missing.publishedSince ?? now);
    const soft = state.published && !!this.options.resubscribe && !this.softAttempted.has(uid) && publishedElapsed >= 14000;
    const last = this.records.at(-1);
    if (last?.uid === uid && (last.status === 'resubscribed' || last.status === 'resubscribe-failed') && this.softWaitUntil?.uid !== uid)
      this.softWaitUntil = {uid,at:now + 8000};
    if (!soft && (elapsed < 20000 || (state.published && publishedElapsed < 16000) || this.attempted.has(uid) || this.hardRejoins >= 1
      || (this.softWaitUntil?.uid === uid && now < this.softWaitUntil.at))) return;
    const token = {}, record: ViewerRecoveryRecord = {uid,reason,status:soft ? 'resubscribing' : 'rejoining',startedAt:now};
    this.active = token;
    if (soft) this.softAttempted.add(uid);
    else { this.attempted.add(uid); this.hardRejoins++; }
    this.records.push(record); if (this.records.length > 10) this.records.shift();
    this.options.changed({...record});
    const current = () => {
      const latest = this.options.read();
      return this.active === token && latest.scope === state.scope && latest.intentRevision === state.intentRevision
        && latest.targetUid === uid && this.allowed(latest);
    };
    const finish = (status: ViewerRecoveryRecord['status']) => {
      record.status = status; record.completedAt = Date.now(); this.options.changed({...record});
    };
    void (async () => {
      if (!current()) { finish('cancelled'); return; }
      if (soft) {
        await this.options.resubscribe?.(uid);
        finish(current() ? 'resubscribed' : 'cancelled'); return;
      }
      await this.options.disconnect();
      if (!current()) { finish('cancelled'); return; }
      await this.options.connect();
      if (!current()) { finish('cancelled'); return; }
      await this.options.select(uid);
      finish(current() ? 'rejoined' : 'cancelled');
    })().catch(() => finish(current() ? (soft ? 'resubscribe-failed' : 'failed') : 'cancelled')).finally(() => {
      if (this.active === token) this.active = undefined;
    });
  }
}
