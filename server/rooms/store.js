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
      CREATE TABLE IF NOT EXISTS rtc_quota (
        provider TEXT NOT NULL, month TEXT NOT NULL, estimated REAL NOT NULL DEFAULT 0,
        anchor_remaining REAL, anchor_estimated REAL, PRIMARY KEY (provider, month)
      );
      CREATE TABLE IF NOT EXISTS rtc_room_usage (
        provider TEXT NOT NULL, month TEXT NOT NULL, roomId TEXT NOT NULL,
        estimated REAL NOT NULL DEFAULT 0, PRIMARY KEY (provider, month, roomId)
      );
      CREATE TABLE IF NOT EXISTS zego_tier_duration (
        month TEXT NOT NULL, rate REAL NOT NULL, milliseconds INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (month, rate)
      );
      CREATE TABLE IF NOT EXISTS volc_daily_usage (
        appId TEXT NOT NULL, day TEXT NOT NULL, minutes REAL NOT NULL,
        PRIMARY KEY (appId, day)
      );
    `);
    const columns = this.db.prepare('PRAGMA table_info(rooms)').all().map(c => c.name);
    if (!columns.includes('emptySince')) this.db.exec('ALTER TABLE rooms ADD COLUMN emptySince INTEGER');
    if (!columns.includes('lastActiveAt')) this.db.exec('ALTER TABLE rooms ADD COLUMN lastActiveAt INTEGER');
    if (!columns.includes('provider')) this.db.exec("ALTER TABLE rooms ADD COLUMN provider TEXT NOT NULL DEFAULT 'agora'");
    if (!columns.includes('closeReason')) this.db.exec('ALTER TABLE rooms ADD COLUMN closeReason TEXT');
    this.db.exec('UPDATE rooms SET emptySince = updatedAt, lastActiveAt = updatedAt WHERE lastActiveAt IS NULL');
  }
  create(room) {
    this.db.prepare('INSERT INTO rooms (id,ownerId,name,description,inviteKey,createdAt,updatedAt,provider) VALUES (?,?,?,?,?,?,?,?)')
      .run(room.id, room.ownerId, room.name, room.description, room.inviteKey, room.createdAt, room.updatedAt, room.provider || 'agora');
    this.db.prepare('UPDATE rooms SET emptySince = ?, lastActiveAt = ? WHERE id = ?').run(room.createdAt, room.createdAt, room.id);
  }
  get(id) { return this.db.prepare('SELECT * FROM rooms WHERE id = ? AND archived = 0').get(id); }
  getAny(id) { return this.db.prepare('SELECT * FROM rooms WHERE id = ?').get(id); }
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
  archive(id, reason = null) { this.db.prepare('UPDATE rooms SET archived = 1, updatedAt = ?, closeReason = ? WHERE id = ?').run(Date.now(), reason, id); }
  quota(provider, month) {
    this.db.prepare('INSERT OR IGNORE INTO rtc_quota(provider,month) VALUES (?,?)').run(provider, month);
    return this.db.prepare('SELECT * FROM rtc_quota WHERE provider=? AND month=?').get(provider, month);
  }
  addUsage(provider, month, roomId, amount) {
    this.db.prepare('INSERT INTO rtc_quota(provider,month,estimated) VALUES (?,?,?) ON CONFLICT(provider,month) DO UPDATE SET estimated=estimated+excluded.estimated').run(provider, month, amount);
    this.db.prepare('INSERT INTO rtc_room_usage VALUES (?,?,?,?) ON CONFLICT(provider,month,roomId) DO UPDATE SET estimated=estimated+excluded.estimated').run(provider, month, roomId, amount);
  }
  addZegoDuration(month, roomId, rate, milliseconds) {
    this.db.exec('BEGIN');
    try {
      this.db.prepare('INSERT INTO zego_tier_duration VALUES (?,?,?) ON CONFLICT(month,rate) DO UPDATE SET milliseconds=milliseconds+excluded.milliseconds').run(month, rate, milliseconds);
      this.addUsage('zego', month, roomId, milliseconds / 60000 * rate);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  zegoRoundingReserve(month) {
    const tiers = this.db.prepare('SELECT rate, milliseconds FROM zego_tier_duration WHERE month=?').all(month);
    return tiers.reduce((total, tier) => total + (Math.ceil(tier.milliseconds / 60000) - tier.milliseconds / 60000) * tier.rate, 0);
  }
  setQuotaAnchor(provider, month, remaining, estimated) {
    this.db.prepare('UPDATE rtc_quota SET anchor_remaining=?,anchor_estimated=? WHERE provider=? AND month=? AND anchor_remaining IS NULL').run(remaining, estimated, provider, month);
  }
  volcDaily(appId, month) {
    return this.db.prepare('SELECT day, minutes FROM volc_daily_usage WHERE appId=? AND day>=? AND day<? ORDER BY day')
      .all(appId, `${month}-01`, `${month}-32`);
  }
  saveVolcDaily(appId, rows) {
    const put = this.db.prepare('INSERT INTO volc_daily_usage(appId,day,minutes) VALUES (?,?,?) ON CONFLICT(appId,day) DO UPDATE SET minutes=excluded.minutes');
    this.db.exec('BEGIN');
    try { for (const row of rows) put.run(appId, row.day, row.minutes); this.db.exec('COMMIT'); }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  close() { this.db.close(); }
}
