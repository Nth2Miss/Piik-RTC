export const PRESENCE_LIFETIME = 45_000;
export const EMPTY_ROOM_TIMEOUT = 15 * 60_000;

export class RoomLifecycle {
  constructor(store, sessions) { this.store = store; this.sessions = sessions; }
  active(roomId, now = Date.now()) {
    return [...this.sessions.values()].filter(s => s.roomId === roomId && s.lastSeen > now - PRESENCE_LIFETIME && s.expiresAt > now);
  }
  sweep(now = Date.now()) {
    for (const room of this.store.all()) {
      if (this.active(room.id, now).length) {
        if (room.emptySince !== null) this.store.occupied(room.id, now);
        continue;
      }
      let emptySince = room.emptySince;
      if (emptySince === null) {
        const deadlines = [...this.sessions.values()].filter(s => s.roomId === room.id && s.lastSeen > 0)
          .map(s => Math.min(s.lastSeen + PRESENCE_LIFETIME, s.expiresAt));
        emptySince = Math.min(now, deadlines.length ? Math.max(...deadlines) : room.lastActiveAt + PRESENCE_LIFETIME);
        this.store.empty(room.id, emptySince);
      }
      if (now - emptySince >= EMPTY_ROOM_TIMEOUT) {
        this.store.archive(room.id);
        for (const [key, session] of this.sessions) if (session.roomId === room.id) this.sessions.delete(key);
      }
    }
    for (const [key, session] of this.sessions) if (session.expiresAt + 300_000 < now) this.sessions.delete(key);
  }
  leave(key, now = Date.now()) {
    const session = this.sessions.get(key);
    this.sessions.delete(key);
    if (session && !this.active(session.roomId, now).length) this.store.empty(session.roomId, now);
  }
}
