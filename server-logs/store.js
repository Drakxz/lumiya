const { allowsLog } = require("./policy");
module.exports = function createLogStore(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS bot_log_channels(
    guildId TEXT NOT NULL,kind TEXT NOT NULL,channelId TEXT NOT NULL,
    PRIMARY KEY(guildId,kind));
    CREATE TABLE IF NOT EXISTS bot_log_setup(
      guildId TEXT PRIMARY KEY,enabled INTEGER NOT NULL DEFAULT 0,updatedAt INTEGER NOT NULL)`);
  return {
    automatic: guildId => Boolean(db.prepare("SELECT enabled FROM bot_log_setup WHERE guildId=?").get(guildId)?.enabled),
    setAutomatic: (guildId,enabled) => db.prepare(`INSERT INTO bot_log_setup VALUES(?,?,?)
      ON CONFLICT(guildId) DO UPDATE SET enabled=excluded.enabled,updatedAt=excluded.updatedAt`).run(guildId,enabled?1:0,Date.now()),
    get: (guildId, kind) => allowsLog(guildId, kind)
      ? db.prepare("SELECT channelId FROM bot_log_channels WHERE guildId=? AND kind=?").get(guildId, kind)?.channelId
      : undefined,
    set: (guildId, kind, channelId) => db.prepare(`INSERT INTO bot_log_channels VALUES(?,?,?)
      ON CONFLICT(guildId,kind) DO UPDATE SET channelId=excluded.channelId`).run(guildId, kind, channelId)
  };
};
