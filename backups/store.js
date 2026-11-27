const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

class BackupStore {
  constructor(db, directory) {
    this.db = db;this.directory = path.resolve(directory);fs.mkdirSync(this.directory, { recursive: true });
    try { fs.chmodSync(this.directory, 0o700); } catch {}
    db.exec(`
      CREATE TABLE IF NOT EXISTS server_backups(id TEXT PRIMARY KEY,guildId TEXT NOT NULL,createdAt INTEGER NOT NULL,
        size INTEGER NOT NULL,filename TEXT NOT NULL,sha256 TEXT NOT NULL,summary TEXT NOT NULL,createdBy TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS server_backups_guild_date ON server_backups(guildId,createdAt DESC);
      CREATE TABLE IF NOT EXISTS server_backup_settings(guildId TEXT PRIMARY KEY,automatic INTEGER NOT NULL DEFAULT 0,
        intervalHours INTEGER NOT NULL DEFAULT 24,nextAt INTEGER,includeMessages INTEGER NOT NULL DEFAULT 0,
        retention INTEGER NOT NULL DEFAULT 10,notifyChannel TEXT,messageConfig TEXT NOT NULL DEFAULT '{}');
      CREATE TABLE IF NOT EXISTS server_backup_sessions(id TEXT PRIMARY KEY,guildId TEXT NOT NULL,userId TEXT NOT NULL,
        state TEXT NOT NULL,expiresAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS server_backup_audit(id INTEGER PRIMARY KEY AUTOINCREMENT,guildId TEXT NOT NULL,
        userId TEXT NOT NULL,action TEXT NOT NULL,detail TEXT NOT NULL,createdAt INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS server_backup_audit_guild_date ON server_backup_audit(guildId,createdAt DESC);
    `);
  }
  settings(guildId) {
    this.db.prepare("INSERT OR IGNORE INTO server_backup_settings(guildId) VALUES(?)").run(guildId);
    for (const [column, declaration] of [["retention","INTEGER NOT NULL DEFAULT 10"],["notifyChannel","TEXT"],["messageConfig","TEXT NOT NULL DEFAULT '{}'" ]]) {
      try { this.db.exec(`ALTER TABLE server_backup_settings ADD COLUMN ${column} ${declaration}`); } catch {}
    }
    return this.db.prepare("SELECT * FROM server_backup_settings WHERE guildId=?").get(guildId);
  }
  updateSettings(guildId, values) {
    const current = this.settings(guildId), next = { ...current, ...values };
    this.db.prepare(`UPDATE server_backup_settings SET automatic=?,intervalHours=?,nextAt=?,includeMessages=?,retention=?,notifyChannel=?,messageConfig=? WHERE guildId=?`)
      .run(next.automatic ? 1 : 0, next.intervalHours, next.nextAt ?? null, next.includeMessages ? 1 : 0,
        next.retention, next.notifyChannel ?? null, typeof next.messageConfig === "string" ? next.messageConfig : JSON.stringify(next.messageConfig||{}), guildId);
    return this.settings(guildId);
  }
  list(guildId, limit = 100) { return this.db.prepare("SELECT * FROM server_backups WHERE guildId=? ORDER BY createdAt DESC LIMIT ?").all(guildId, limit); }
  get(id, guildId) { return this.db.prepare("SELECT * FROM server_backups WHERE id=? AND guildId=?").get(id, guildId); }
  findById(id) { return this.db.prepare("SELECT * FROM server_backups WHERE id=?").get(id); }
  file(row) {
    if (!row || !/^[a-zA-Z0-9_-]{1,80}\.mdsbak$/.test(row.filename)) throw new Error("Arquivo de backup inválido.");
    const target = path.resolve(this.directory, row.filename);
    if (!target.startsWith(this.directory + path.sep)) throw new Error("Caminho de backup inválido.");
    return target;
  }
  saveSession(s) {
    this.db.prepare(`INSERT INTO server_backup_sessions VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,expiresAt=excluded.expiresAt`)
      .run(s.id, s.guildId, s.userId, JSON.stringify(s), Date.now() + 30 * 60_000);
  }
  getSession(id) {
    const row = this.db.prepare("SELECT state FROM server_backup_sessions WHERE id=? AND expiresAt>?").get(id, Date.now());
    return row ? JSON.parse(row.state) : null;
  }
  insertBackup({ guildId, createdAt, size, sha256, summary, createdBy }, bytes) {
    const id = randomUUID(), date = new Date(createdAt).toISOString().slice(0, 10);
    const filename = `${guildId}-${createdAt}-${id.slice(0, 8)}.mdsbak`;
    const finalPath = path.join(this.directory, date);
    fs.mkdirSync(finalPath, { recursive: true });
    const absolute = path.join(finalPath, filename);fs.writeFileSync(absolute, bytes, { flag: "wx", mode: 0o600 });
    const relative = `${date}/${filename}`;
    try {
      this.db.prepare("INSERT INTO server_backups VALUES(?,?,?,?,?,?,?,?)")
        .run(id, guildId, createdAt, size, relative, sha256, JSON.stringify(summary), createdBy);
    } catch (error) { fs.rmSync(absolute, { force: true });throw error; }
    return this.db.prepare("SELECT * FROM server_backups WHERE id=?").get(id);
  }
  resolveFile(row) {
    if (!row || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}[\\/][a-zA-Z0-9_-]{1,100}\.mdsbak$/.test(row.filename)) throw new Error("Arquivo de backup inválido.");
    const target = path.resolve(this.directory, row.filename);
    if (!target.startsWith(this.directory + path.sep)) throw new Error("Caminho inválido.");
    return target;
  }
  retain(guildId) {
    const count = this.settings(guildId).retention;
    const rows = this.list(guildId, 1000).slice(Math.max(0, count));
    for (const row of rows) {
      try { fs.rmSync(this.resolveFile(row), { force: true }); } catch {}
      this.db.prepare("DELETE FROM server_backups WHERE id=? AND guildId=?").run(row.id,guildId);
    }
    return rows.length;
  }
  audit(guildId,userId,action,detail={}) {
    this.db.prepare("INSERT INTO server_backup_audit(guildId,userId,action,detail,createdAt) VALUES(?,?,?,?,?)")
      .run(guildId,userId,action,JSON.stringify(detail),Date.now());
  }
}
module.exports = { BackupStore };
