// Live, per-guild aliases for resource IDs recreated by a backup restore.
module.exports = function resourceIds(db) {
  if (!db) return { resolve: (_guildId, id) => id, remap: (_guildId, value) => value };
  db.exec(`CREATE TABLE IF NOT EXISTS bot_resource_remaps(
    guildId TEXT NOT NULL,oldId TEXT NOT NULL,newId TEXT NOT NULL,
    PRIMARY KEY(guildId,oldId))`);
  const read = db.prepare("SELECT newId FROM bot_resource_remaps WHERE guildId=? AND oldId=?");
  function resolve(guildId, id) {
    if(typeof id!=="string")return id;
    return read.get(guildId,id)?.newId||id;
  }
  function remap(guildId, value) {
    if (typeof value === "string") return resolve(guildId, value);
    if (Array.isArray(value)) return value.map(item => remap(guildId, item));
    if (value && typeof value === "object") return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [resolve(guildId, key), remap(guildId, item)])
    );
    return value;
  }
  return { resolve, remap };
};
