import { DatabaseSync } from 'node:sqlite';

export class RoomStore {
  constructor(filename = ':memory:') {
    this.db = new DatabaseSync(filename);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS rooms (
        id TEXT PRIMARY KEY, ownerId TEXT NOT NULL, name TEXT NOT NULL,
        description TEXT NOT NULL, inviteKey TEXT NOT NULL,
        createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, archived INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS memberships (
        roomId TEXT NOT NULL REFERENCES rooms(id), userId TEXT NOT NULL,
        savedAt INTEGER NOT NULL, PRIMARY KEY (roomId, userId)
      );
      CREATE INDEX IF NOT EXISTS memberships_user ON memberships(userId);
      CREATE TABLE IF NOT EXISTS visitors (id TEXT PRIMARY KEY, name TEXT NOT NULL, updatedAt INTEGER NOT NULL);
    `);
    const columns = this.db.prepare('PRAGMA table_info(rooms)').all().map(c => c.name);
    if (!columns.includes('emptySince')) this.db.exec('ALTER TABLE rooms ADD COLUMN emptySince INTEGER');
    if (!columns.includes('lastActiveAt')) this.db.exec('ALTER TABLE rooms ADD COLUMN lastActiveAt INTEGER');
    this.db.exec('UPDATE rooms SET emptySince = updatedAt, lastActiveAt = updatedAt WHERE lastActiveAt IS NULL');
  }
  create(room) {
    this.db.prepare('INSERT INTO rooms (id,ownerId,name,description,inviteKey,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?)')
      .run(room.id, room.ownerId, room.name, room.description, room.inviteKey, room.createdAt, room.updatedAt);
    this.db.prepare('UPDATE rooms SET emptySince = ?, lastActiveAt = ? WHERE id = ?').run(room.createdAt, room.createdAt, room.id);
  }
  get(id) { return this.db.prepare('SELECT * FROM rooms WHERE id = ? AND archived = 0').get(id); }
  all() { return this.db.prepare('SELECT * FROM rooms WHERE archived = 0 ORDER BY createdAt DESC, id').all(); }
  profile(id) { return this.db.prepare('SELECT name FROM visitors WHERE id = ?').get(id); }
  setProfile(id, name) { this.db.prepare('INSERT INTO visitors VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, updatedAt=excluded.updatedAt').run(id, name, Date.now()); }
  occupied(id, now) { this.db.prepare('UPDATE rooms SET emptySince = NULL, lastActiveAt = ? WHERE id = ?').run(now, id); }
  empty(id, time) { this.db.prepare('UPDATE rooms SET emptySince = ? WHERE id = ? AND emptySince IS NULL').run(time, id); }
  resetPresence(grace) { this.db.prepare('UPDATE rooms SET emptySince = lastActiveAt + ? WHERE archived = 0 AND emptySince IS NULL').run(grace); }
  count(userId) {
    return this.db.prepare('SELECT count(*) AS count FROM rooms WHERE ownerId = ? AND archived = 0').get(userId).count;
  }
  list(userId) {
    return this.db.prepare(`SELECT r.* FROM rooms r WHERE r.archived = 0 AND
      (r.ownerId = ? OR EXISTS (SELECT 1 FROM memberships m WHERE m.roomId = r.id AND m.userId = ?))
      ORDER BY r.createdAt DESC, r.id`).all(userId, userId);
  }
  isMember(roomId, userId) { return !!this.db.prepare('SELECT 1 FROM memberships WHERE roomId = ? AND userId = ?').get(roomId, userId); }
  save(roomId, userId) { this.db.prepare('INSERT OR IGNORE INTO memberships VALUES (?,?,?)').run(roomId, userId, Date.now()); }
  remove(roomId, userId) { this.db.prepare('DELETE FROM memberships WHERE roomId = ? AND userId = ?').run(roomId, userId); }
  update(id, name, description) { this.db.prepare('UPDATE rooms SET name = ?, description = ?, updatedAt = ? WHERE id = ?').run(name, description, Date.now(), id); }
  archive(id) { this.db.prepare('UPDATE rooms SET archived = 1, updatedAt = ? WHERE id = ?').run(Date.now(), id); }
  close() { this.db.close(); }
}
