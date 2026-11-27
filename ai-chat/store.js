const MEMORY_LIMIT = 40;
const DEFAULT_OPTIONS = Object.freeze({
  spontaneous: false,
  spontaneousCooldownMs: 8 * 60 * 1000,
  retentionDays: 14
});

function createStore(db) {
  const memory = new Map();
  const options = new Map();
  if (db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS ai_chat_settings(
        guildId TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS ai_chat_guild_options(
        guildId TEXT PRIMARY KEY,
        spontaneous INTEGER NOT NULL DEFAULT 0,
        spontaneousCooldownMs INTEGER NOT NULL DEFAULT 480000,
        retentionDays INTEGER NOT NULL DEFAULT 14,
        updatedAt INTEGER NOT NULL
      );
    `);
  }

  const read = db?.prepare("SELECT enabled FROM ai_chat_settings WHERE guildId=?");
  const write = db?.prepare(`
    INSERT INTO ai_chat_settings(guildId,enabled,updatedAt) VALUES(?,?,?)
    ON CONFLICT(guildId) DO UPDATE SET enabled=excluded.enabled,updatedAt=excluded.updatedAt
  `);
  const readOptions = db?.prepare(`SELECT spontaneous,spontaneousCooldownMs,retentionDays
    FROM ai_chat_guild_options WHERE guildId=?`);
  const writeOptions = db?.prepare(`INSERT INTO ai_chat_guild_options(
    guildId,spontaneous,spontaneousCooldownMs,retentionDays,updatedAt
  ) VALUES(?,?,?,?,?)
  ON CONFLICT(guildId) DO UPDATE SET
    spontaneous=excluded.spontaneous,
    spontaneousCooldownMs=excluded.spontaneousCooldownMs,
    retentionDays=excluded.retentionDays,
    updatedAt=excluded.updatedAt`);

  // Sem banco disponível, o estado continua em memória até o processo reiniciar.
  function enabled(guildId, fallback = true) {
    if (!guildId) return Boolean(fallback);
    if (db) {
      const row = read.get(guildId);
      return row ? Boolean(row.enabled) : Boolean(fallback);
    }
    return memory.has(guildId) ? memory.get(guildId) : Boolean(fallback);
  }

  function set(guildId, value) {
    if (!guildId) return false;
    const enabled = Boolean(value);
    if (db) write.run(guildId, enabled ? 1 : 0, Date.now());
    else memory.set(guildId, enabled);
    return enabled;
  }

  // Opções por servidor. O padrão é participação espontânea desligada:
  // a Lumiya só entra na conversa quando é chamada ou convidada.
  function getOptions(guildId) {
    const base = { ...DEFAULT_OPTIONS };
    if (!guildId) return base;
    const row = db ? readOptions.get(guildId) : options.get(guildId);
    if (!row) return base;
    return {
      spontaneous: Boolean(row.spontaneous),
      spontaneousCooldownMs: Math.max(60000, Number(row.spontaneousCooldownMs) || DEFAULT_OPTIONS.spontaneousCooldownMs),
      retentionDays: Math.max(1, Math.min(365, Number(row.retentionDays) || DEFAULT_OPTIONS.retentionDays))
    };
  }

  function setOptions(guildId, patch = {}) {
    if (!guildId) return getOptions(guildId);
    const next = { ...getOptions(guildId), ...patch };
    next.spontaneous = Boolean(next.spontaneous);
    next.spontaneousCooldownMs = Math.max(60000, Math.min(86400000,
      Number(next.spontaneousCooldownMs) || DEFAULT_OPTIONS.spontaneousCooldownMs));
    next.retentionDays = Math.max(1, Math.min(365, Number(next.retentionDays) || DEFAULT_OPTIONS.retentionDays));
    if (db) {
      writeOptions.run(guildId, next.spontaneous ? 1 : 0, next.spontaneousCooldownMs,
        next.retentionDays, Date.now());
    } else options.set(guildId, next);
    return next;
  }

  return { enabled, set, options: getOptions, setOptions };
}

function createMemoryStore(db) {
  const conversations = new Map();
  const profiles = new Map();
  const key = (guildId, userId) => `${guildId}:${userId}`;

  if (db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS ai_chat_memory(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guildId TEXT NOT NULL,
        userId TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('user','assistant')),
        content TEXT NOT NULL,
        createdAt INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS ai_chat_memory_user ON ai_chat_memory(guildId,userId,id);
      CREATE TABLE IF NOT EXISTS ai_chat_profiles(
        guildId TEXT NOT NULL,
        userId TEXT NOT NULL,
        messageCount INTEGER NOT NULL DEFAULT 0,
        firstSeenAt INTEGER NOT NULL,
        lastSeenAt INTEGER NOT NULL,
        PRIMARY KEY(guildId,userId)
      );
    `);
  }

  const insert = db?.prepare("INSERT INTO ai_chat_memory(guildId,userId,role,content,createdAt) VALUES(?,?,?,?,?)");
  const trim = db?.prepare(`
    DELETE FROM ai_chat_memory
    WHERE guildId=? AND userId=? AND id NOT IN (
      SELECT id FROM ai_chat_memory WHERE guildId=? AND userId=? ORDER BY id DESC LIMIT ?
    )
  `);
  const selectHistory = db?.prepare(`
    SELECT role,content FROM ai_chat_memory
    WHERE guildId=? AND userId=? ORDER BY id DESC LIMIT ?
  `);
  const upsertProfile = db?.prepare(`
    INSERT INTO ai_chat_profiles(guildId,userId,messageCount,firstSeenAt,lastSeenAt) VALUES(?,?,1,?,?)
    ON CONFLICT(guildId,userId) DO UPDATE SET
      messageCount=messageCount+1,
      lastSeenAt=excluded.lastSeenAt
  `);
  const selectProfile = db?.prepare(`
    SELECT messageCount,firstSeenAt,lastSeenAt FROM ai_chat_profiles WHERE guildId=? AND userId=?
  `);
  const deleteHistory = db?.prepare("DELETE FROM ai_chat_memory WHERE guildId=? AND userId=?");
  const deleteProfile = db?.prepare("DELETE FROM ai_chat_profiles WHERE guildId=? AND userId=?");
  const deleteGuildHistory = db?.prepare("DELETE FROM ai_chat_memory WHERE guildId=?");
  const deleteGuildProfiles = db?.prepare("DELETE FROM ai_chat_profiles WHERE guildId=?");
  const countGuildHistory = db?.prepare("SELECT COUNT(*) AS n FROM ai_chat_memory WHERE guildId=?");

  function record(guildId, userId, role, content, createdAt = Date.now()) {
    if (!guildId || !userId || !content || !["user", "assistant"].includes(role)) return;
    const text = String(content).trim();
    if (!text) return;

    if (db) {
      insert.run(guildId, userId, role, text, createdAt);
      trim.run(guildId, userId, guildId, userId, MEMORY_LIMIT);
      if (role === "user") upsertProfile.run(guildId, userId, createdAt, createdAt);
      return;
    }

    const conversationKey = key(guildId, userId);
    const list = conversations.get(conversationKey) || [];
    list.push({ role, content: text, createdAt });
    if (list.length > MEMORY_LIMIT) list.splice(0, list.length - MEMORY_LIMIT);
    conversations.set(conversationKey, list);

    if (role === "user") {
      const profile = profiles.get(conversationKey) || { messageCount: 0, firstSeenAt: createdAt };
      profile.messageCount++;
      profile.lastSeenAt = createdAt;
      profiles.set(conversationKey, profile);
    }
  }

  function history(guildId, userId, limit = 12) {
    const max = Math.max(0, Math.min(30, Number(limit) || 0));
    if (!guildId || !userId || !max) return [];
    if (db) {
      return selectHistory.all(guildId, userId, max).reverse()
        .map(row => ({ role: row.role, content: row.content }));
    }
    return (conversations.get(key(guildId, userId)) || []).slice(-max)
      .map(item => ({ role: item.role, content: item.content }));
  }

  function profile(guildId, userId) {
    if (!guildId || !userId) return null;
    if (db) {
      const row = selectProfile.get(guildId, userId);
      return row ? {
        messageCount: Number(row.messageCount) || 0,
        firstSeenAt: Number(row.firstSeenAt) || null,
        lastSeenAt: Number(row.lastSeenAt) || null
      } : null;
    }
    return profiles.get(key(guildId, userId)) || null;
  }

  function clear(guildId, userId) {
    if (!guildId || !userId) return;
    if (db) {
      deleteHistory.run(guildId, userId);
      deleteProfile.run(guildId, userId);
      return;
    }
    conversations.delete(key(guildId, userId));
    profiles.delete(key(guildId, userId));
  }

  function clearGuild(guildId) {
    if (!guildId) return 0;
    if (db) {
      const removed = Number(deleteGuildHistory.run(guildId).changes) || 0;
      deleteGuildProfiles.run(guildId);
      return removed;
    }
    let removed = 0;
    for (const [conversationKey, list] of conversations) {
      if (!conversationKey.startsWith(`${guildId}:`)) continue;
      removed += list.length;
      conversations.delete(conversationKey);
      profiles.delete(conversationKey);
    }
    return removed;
  }

  function count(guildId) {
    if (!guildId) return 0;
    if (db) return Number(countGuildHistory.get(guildId)?.n) || 0;
    let total = 0;
    for (const [conversationKey, list] of conversations)
      if (conversationKey.startsWith(`${guildId}:`)) total += list.length;
    return total;
  }

  return { record, history, profile, clear, clearGuild, count, MEMORY_LIMIT };
}

module.exports = { createStore, createMemoryStore, MEMORY_LIMIT };
