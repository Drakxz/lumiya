module.exports = function createBanStore(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS bot_ban_audit(
    id TEXT PRIMARY KEY,guildId TEXT NOT NULL,targetId TEXT NOT NULL,actorId TEXT NOT NULL,
    action TEXT NOT NULL,reason TEXT NOT NULL,deleteSeconds INTEGER NOT NULL,
    status TEXT NOT NULL,createdAt INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS bot_ban_audit_guild ON bot_ban_audit(guildId,createdAt);
    CREATE INDEX IF NOT EXISTS bot_ban_audit_user ON bot_ban_audit(guildId,targetId,createdAt);
    CREATE INDEX IF NOT EXISTS bot_ban_audit_actor ON bot_ban_audit(guildId,actorId,createdAt);
    CREATE TABLE IF NOT EXISTS bot_ban_limits(
      guildId TEXT NOT NULL,roleId TEXT NOT NULL,limitCount INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL,PRIMARY KEY(guildId,roleId));
    CREATE INDEX IF NOT EXISTS bot_ban_limits_guild ON bot_ban_limits(guildId);`);
  const scope = `guildId=? AND targetId=? AND (?='all' OR action=?)
    AND (?='' OR instr(lower(reason),lower(?))>0 OR instr(actorId,?)>0 OR instr(id,?)>0)`;
  return {
    get: (guildId, userId, id) => db.prepare(
      "SELECT * FROM bot_ban_audit WHERE guildId=? AND targetId=? AND id=?").get(guildId, userId, id),
    stats(guildId, userId) {
      return db.prepare(`SELECT COUNT(*) total,
        COALESCE(SUM(action='ban' AND status='success'),0) bans,
        COALESCE(SUM(action='unban' AND status='success'),0) unbans,
        COALESCE(SUM(status='failed'),0) failed,
        COALESCE(SUM(status='pending'),0) pending,MAX(createdAt) latest
        FROM bot_ban_audit WHERE guildId=? AND targetId=?`).get(guildId, userId);
    },
    list(guildId, userId, { filter = "all", search = "", page = 1 } = {}) {
      if (!["all", "ban", "unban"].includes(filter)) filter = "all";
      const args = [guildId, userId, filter, filter, search, search, search, search];
      const total = db.prepare(`SELECT COUNT(*) total FROM bot_ban_audit WHERE ${scope}`).get(...args).total;
      const pages = Math.max(1, Math.ceil(total / 4));
      page = Math.min(Math.max(1, Number.isInteger(page) ? page : 1), pages);
      const rows = db.prepare(`SELECT * FROM bot_ban_audit WHERE ${scope}
        ORDER BY createdAt DESC,id DESC LIMIT 4 OFFSET ?`).all(...args, (page - 1) * 4);
      return { rows, total, pages, page };
    },
    limits(guildId) {
      return db.prepare(
        "SELECT roleId,limitCount FROM bot_ban_limits WHERE guildId=? ORDER BY limitCount DESC,roleId")
        .all(guildId);
    },
    limit(guildId, roleId) {
      const row = db.prepare("SELECT limitCount FROM bot_ban_limits WHERE guildId=? AND roleId=?")
        .get(guildId, roleId);
      return row ? row.limitCount : null;
    },
    setLimit(guildId, roleId, limitCount) {
      if (limitCount > 0) {
        db.prepare(`INSERT INTO bot_ban_limits VALUES(?,?,?,?) ON CONFLICT(guildId,roleId)
          DO UPDATE SET limitCount=excluded.limitCount,updatedAt=excluded.updatedAt`)
          .run(guildId, roleId, limitCount, Date.now());
        return;
      }
      db.prepare("DELETE FROM bot_ban_limits WHERE guildId=? AND roleId=?").run(guildId, roleId);
    },
    bansSince(guildId, actorId, from, to) {
      return db.prepare(`SELECT COUNT(*) n FROM bot_ban_audit
        WHERE guildId=? AND actorId=? AND action='ban' AND status='success'
        AND createdAt>=? AND createdAt<?`).get(guildId, actorId, from, to).n;
    }
  };
};
