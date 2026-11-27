module.exports = function createModerationStore(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS moderation_guard_events(
    id TEXT PRIMARY KEY,guildId TEXT NOT NULL,actorId TEXT NOT NULL,targetId TEXT NOT NULL,
    kind TEXT NOT NULL,reason TEXT,auditId TEXT NOT NULL,createdAt INTEGER NOT NULL,
    sanction TEXT NOT NULL DEFAULT 'none',sanctionRoleId TEXT,sanctionAuditId TEXT,sanctionAt INTEGER);
    CREATE INDEX IF NOT EXISTS moderation_guard_recent ON moderation_guard_events(guildId,actorId,kind,createdAt);
    CREATE INDEX IF NOT EXISTS moderation_guard_target ON moderation_guard_events(guildId,targetId,createdAt);`);
  return {
    hasAudit: (guildId, auditId) => Boolean(db.prepare(
      "SELECT 1 FROM moderation_guard_events WHERE guildId=? AND auditId=?").get(guildId, auditId)),
    hasAuditId: (guildId, auditId, targetId) => Boolean(db.prepare(
      "SELECT 1 FROM moderation_guard_events WHERE guildId=? AND auditId=? AND targetId=?").get(guildId, auditId, targetId)),
    add(event) {
      db.prepare("INSERT OR IGNORE INTO moderation_guard_events VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run(
        event.id, event.guildId, event.actorId, event.targetId, event.kind, event.reason,
        event.auditId, event.createdAt, event.sanction, event.sanctionRoleId || null,
        event.sanctionAuditId || null, event.sanctionAt || null);
      return db.prepare("SELECT * FROM moderation_guard_events WHERE id=?").get(event.id);
    },
    sanction: (id, sanction, roleId, auditId, at) => db.prepare(
      "UPDATE moderation_guard_events SET sanction=?,sanctionRoleId=?,sanctionAuditId=?,sanctionAt=? WHERE id=?")
      .run(sanction, roleId || null, auditId || null, at || null, id),
    recentKicks(guildId, actorId, since) {
      return db.prepare("SELECT * FROM moderation_guard_events WHERE guildId=? AND actorId=? AND kind='kick' AND createdAt>=? AND createdAt<=? ORDER BY createdAt DESC")
        .all(guildId, actorId, since, Date.now() + 2000);
    },
    history(guildId, targetId) {
      return db.prepare("SELECT * FROM moderation_guard_events WHERE guildId=? AND targetId=? ORDER BY createdAt DESC,id DESC LIMIT 50")
        .all(guildId, targetId);
    },
    byActor(guildId, actorId) {
      return db.prepare("SELECT * FROM moderation_guard_events WHERE guildId=? AND actorId=? ORDER BY createdAt DESC,id DESC LIMIT 50")
        .all(guildId, actorId);
    }
  };
};
