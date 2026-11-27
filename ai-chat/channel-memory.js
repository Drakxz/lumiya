// Memória conversacional por canal.
// Cada linha pertence a exatamente um servidor + canal. Nunca há consulta
// cruzada entre escopos: todas as instruções SQL filtram guildId e channelId.

const DEFAULT_RETENTION_DAYS = 14;
const DEFAULT_MAX_MESSAGES = 240;
const MAX_CONTENT_CHARS = 1200;
const MAX_REFERENCE_CHARS = 400;

const clean = (value, max) => String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
const scopeKey = (guildId, channelId) => `${guildId}:${channelId}`;
const retentionMs = days => Math.max(1, Math.min(365, Number(days) || DEFAULT_RETENTION_DAYS)) * 86400000;

function normalizeMentions(mentions) {
  if (!Array.isArray(mentions)) return [];
  return mentions.slice(0, 20).map(item => ({
    id: clean(item?.id, 32),
    name: clean(item?.name, 80)
  })).filter(item => item.id);
}

function normalizeEntry(entry) {
  if (!entry || !entry.guildId || !entry.channelId || !entry.authorId) return null;
  const role = entry.role === "assistant" ? "assistant" : "user";
  const content = clean(entry.content, MAX_CONTENT_CHARS);
  if (!content) return null;
  return {
    guildId: String(entry.guildId),
    channelId: String(entry.channelId),
    messageId: entry.messageId ? String(entry.messageId).slice(0, 64) : null,
    authorId: String(entry.authorId).slice(0, 64),
    authorName: clean(entry.authorName, 80) || (role === "assistant" ? "Lumiya" : "Usuário"),
    role,
    content,
    mentions: normalizeMentions(entry.mentions),
    referenceId: entry.referenceId ? String(entry.referenceId).slice(0, 64) : null,
    referenceAuthorId: entry.referenceAuthorId ? String(entry.referenceAuthorId).slice(0, 64) : null,
    referenceAuthorName: clean(entry.referenceAuthorName, 80) || null,
    referenceContent: entry.referenceContent ? clean(entry.referenceContent, MAX_REFERENCE_CHARS) : null,
    source: entry.source === "voice" ? "voice" : "text",
    createdAt: Number(entry.createdAt) || Date.now()
  };
}

function rowToMessage(row) {
  if (!row) return null;
  let mentions = [];
  try { mentions = normalizeMentions(JSON.parse(row.mentions || "[]")); } catch { mentions = []; }
  return {
    id: Number(row.id),
    guildId: row.guildId,
    channelId: row.channelId,
    messageId: row.messageId || null,
    authorId: row.authorId,
    authorName: row.authorName,
    role: row.role,
    content: row.content,
    mentions,
    referenceId: row.referenceId || null,
    referenceAuthorId: row.referenceAuthorId || null,
    referenceAuthorName: row.referenceAuthorName || null,
    referenceContent: row.referenceContent || null,
    source: row.source || "text",
    createdAt: Number(row.createdAt) || 0
  };
}

function createChannelMemory(db, {
  maxMessages = DEFAULT_MAX_MESSAGES,
  retentionDays = DEFAULT_RETENTION_DAYS
} = {}) {
  const store = new Map();
  const summaries = new Map();
  let nextId = 1;
  const limit = Math.max(10, Math.min(1000, Number(maxMessages) || DEFAULT_MAX_MESSAGES));

  if (db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS ai_chat_channel_messages(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guildId TEXT NOT NULL,
        channelId TEXT NOT NULL,
        messageId TEXT,
        authorId TEXT NOT NULL,
        authorName TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('user','assistant')),
        content TEXT NOT NULL,
        mentions TEXT NOT NULL DEFAULT '[]',
        referenceId TEXT,
        referenceAuthorId TEXT,
        referenceAuthorName TEXT,
        referenceContent TEXT,
        source TEXT NOT NULL DEFAULT 'text',
        createdAt INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS ai_chat_channel_messages_scope
        ON ai_chat_channel_messages(guildId,channelId,id);
      CREATE INDEX IF NOT EXISTS ai_chat_channel_messages_time
        ON ai_chat_channel_messages(guildId,createdAt);
      CREATE UNIQUE INDEX IF NOT EXISTS ai_chat_channel_messages_unique
        ON ai_chat_channel_messages(guildId,channelId,messageId)
        WHERE messageId IS NOT NULL;
      CREATE TABLE IF NOT EXISTS ai_chat_channel_summaries(
        guildId TEXT NOT NULL,
        channelId TEXT NOT NULL,
        summary TEXT NOT NULL,
        coveredUntilId INTEGER NOT NULL DEFAULT 0,
        messageCount INTEGER NOT NULL DEFAULT 0,
        updatedAt INTEGER NOT NULL,
        PRIMARY KEY(guildId,channelId)
      );
    `);
  }

  const insert = db?.prepare(`INSERT OR IGNORE INTO ai_chat_channel_messages(
    guildId,channelId,messageId,authorId,authorName,role,content,mentions,
    referenceId,referenceAuthorId,referenceAuthorName,referenceContent,source,createdAt
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const trim = db?.prepare(`DELETE FROM ai_chat_channel_messages
    WHERE guildId=? AND channelId=? AND id NOT IN (
      SELECT id FROM ai_chat_channel_messages
      WHERE guildId=? AND channelId=? ORDER BY id DESC LIMIT ?
    )`);
  const expireScope = db?.prepare(`DELETE FROM ai_chat_channel_messages
    WHERE guildId=? AND channelId=? AND createdAt<?`);
  const expireGuild = db?.prepare("DELETE FROM ai_chat_channel_messages WHERE guildId=? AND createdAt<?");
  const expireAll = db?.prepare("DELETE FROM ai_chat_channel_messages WHERE createdAt<?");
  const selectRecent = db?.prepare(`SELECT * FROM ai_chat_channel_messages
    WHERE guildId=? AND channelId=? ORDER BY id DESC LIMIT ?`);
  const selectByMessage = db?.prepare(`SELECT * FROM ai_chat_channel_messages
    WHERE guildId=? AND channelId=? AND messageId=? LIMIT 1`);
  const selectOlder = db?.prepare(`SELECT * FROM ai_chat_channel_messages
    WHERE guildId=? AND channelId=? AND id<? AND id>? ORDER BY id ASC LIMIT ?`);
  const countScope = db?.prepare(`SELECT COUNT(*) AS n FROM ai_chat_channel_messages
    WHERE guildId=? AND channelId=?`);
  const countGuild = db?.prepare("SELECT COUNT(*) AS n FROM ai_chat_channel_messages WHERE guildId=?");
  const countChannels = db?.prepare(`SELECT COUNT(DISTINCT channelId) AS n
    FROM ai_chat_channel_messages WHERE guildId=?`);
  const selectSummary = db?.prepare(`SELECT summary,coveredUntilId,messageCount,updatedAt
    FROM ai_chat_channel_summaries WHERE guildId=? AND channelId=?`);
  const upsertSummary = db?.prepare(`INSERT INTO ai_chat_channel_summaries(
    guildId,channelId,summary,coveredUntilId,messageCount,updatedAt
  ) VALUES(?,?,?,?,?,?)
  ON CONFLICT(guildId,channelId) DO UPDATE SET
    summary=excluded.summary,coveredUntilId=excluded.coveredUntilId,
    messageCount=excluded.messageCount,updatedAt=excluded.updatedAt`);
  const deleteSummary = db?.prepare("DELETE FROM ai_chat_channel_summaries WHERE guildId=? AND channelId=?");
  const deleteScope = db?.prepare("DELETE FROM ai_chat_channel_messages WHERE guildId=? AND channelId=?");
  const deleteGuild = db?.prepare("DELETE FROM ai_chat_channel_messages WHERE guildId=?");
  const deleteSummariesGuild = db?.prepare("DELETE FROM ai_chat_channel_summaries WHERE guildId=?");

  function memoryList(guildId, channelId) {
    const key = scopeKey(guildId, channelId);
    if (!store.has(key)) store.set(key, []);
    return store.get(key);
  }

  function record(entry) {
    const row = normalizeEntry(entry);
    if (!row) return null;

    if (db) {
      const result = insert.run(
        row.guildId, row.channelId, row.messageId, row.authorId, row.authorName,
        row.role, row.content, JSON.stringify(row.mentions), row.referenceId,
        row.referenceAuthorId, row.referenceAuthorName, row.referenceContent,
        row.source, row.createdAt
      );
      if (!result.changes) return null;
      trim.run(row.guildId, row.channelId, row.guildId, row.channelId, limit);
      expireScope.run(row.guildId, row.channelId, Date.now() - retentionMs(retentionDays));
      return Number(result.lastInsertRowid);
    }

    const list = memoryList(row.guildId, row.channelId);
    if (row.messageId && list.some(item => item.messageId === row.messageId)) return null;
    const stored = { ...row, id: nextId++ };
    list.push(stored);
    if (list.length > limit) list.splice(0, list.length - limit);
    const cutoff = Date.now() - retentionMs(retentionDays);
    while (list.length && list[0].createdAt < cutoff) list.shift();
    return stored.id;
  }

  function recent(guildId, channelId, count = 50) {
    const max = Math.max(0, Math.min(limit, Number(count) || 0));
    if (!guildId || !channelId || !max) return [];
    if (db) return selectRecent.all(guildId, channelId, max).reverse().map(rowToMessage);
    return memoryList(guildId, channelId).slice(-max).map(item => ({ ...item }));
  }

  function byMessageId(guildId, channelId, messageId) {
    if (!guildId || !channelId || !messageId) return null;
    if (db) return rowToMessage(selectByMessage.get(guildId, channelId, String(messageId)));
    return memoryList(guildId, channelId).find(item => item.messageId === String(messageId)) || null;
  }

  function olderThan(guildId, channelId, beforeId, afterId = 0, count = 60) {
    const max = Math.max(0, Math.min(200, Number(count) || 0));
    if (!guildId || !channelId || !max) return [];
    if (db) return selectOlder.all(guildId, channelId, Number(beforeId) || 0, Number(afterId) || 0, max).map(rowToMessage);
    return memoryList(guildId, channelId)
      .filter(item => item.id < (Number(beforeId) || 0) && item.id > (Number(afterId) || 0))
      .slice(0, max).map(item => ({ ...item }));
  }

  function count(guildId, channelId) {
    if (!guildId || !channelId) return 0;
    if (db) return Number(countScope.get(guildId, channelId)?.n) || 0;
    return memoryList(guildId, channelId).length;
  }

  function channelCount(guildId) {
    if (!guildId) return 0;
    if (db) return Number(countChannels.get(guildId)?.n) || 0;
    let total = 0;
    for (const [key, list] of store) if (key.startsWith(`${guildId}:`) && list.length) total++;
    return total;
  }

  function guildCount(guildId) {
    if (!guildId) return 0;
    if (db) return Number(countGuild.get(guildId)?.n) || 0;
    let total = 0;
    for (const [key, list] of store) if (key.startsWith(`${guildId}:`)) total += list.length;
    return total;
  }

  function summary(guildId, channelId) {
    if (!guildId || !channelId) return null;
    if (db) {
      const row = selectSummary.get(guildId, channelId);
      return row ? {
        summary: row.summary,
        coveredUntilId: Number(row.coveredUntilId) || 0,
        messageCount: Number(row.messageCount) || 0,
        updatedAt: Number(row.updatedAt) || 0
      } : null;
    }
    return summaries.get(scopeKey(guildId, channelId)) || null;
  }

  function setSummary(guildId, channelId, summaryText, coveredUntilId = 0, messageCount = 0) {
    const text = clean(summaryText, 1600);
    if (!guildId || !channelId || !text) return null;
    const value = {
      summary: text,
      coveredUntilId: Number(coveredUntilId) || 0,
      messageCount: Math.max(0, Number(messageCount) || 0),
      updatedAt: Date.now()
    };
    if (db) {
      upsertSummary.run(guildId, channelId, value.summary, value.coveredUntilId, value.messageCount, value.updatedAt);
    } else summaries.set(scopeKey(guildId, channelId), value);
    return value;
  }

  function clearChannel(guildId, channelId) {
    if (!guildId || !channelId) return 0;
    if (db) {
      const removed = Number(deleteScope.run(guildId, channelId).changes) || 0;
      deleteSummary.run(guildId, channelId);
      return removed;
    }
    const removed = memoryList(guildId, channelId).length;
    store.delete(scopeKey(guildId, channelId));
    summaries.delete(scopeKey(guildId, channelId));
    return removed;
  }

  function clearGuild(guildId) {
    if (!guildId) return 0;
    if (db) {
      const removed = Number(deleteGuild.run(guildId).changes) || 0;
      deleteSummariesGuild.run(guildId);
      return removed;
    }
    let removed = 0;
    for (const [key, list] of store) {
      if (!key.startsWith(`${guildId}:`)) continue;
      removed += list.length;
      store.delete(key);
      summaries.delete(key);
    }
    return removed;
  }

  function purge(days = retentionDays, guildId = null) {
    const cutoff = Date.now() - retentionMs(days);
    if (db) return Number((guildId ? expireGuild.run(guildId, cutoff) : expireAll.run(cutoff)).changes) || 0;
    let removed = 0;
    for (const [key, list] of store) {
      if (guildId && !key.startsWith(`${guildId}:`)) continue;
      const kept = list.filter(item => item.createdAt >= cutoff);
      removed += list.length - kept.length;
      if (kept.length) store.set(key, kept);
      else { store.delete(key); summaries.delete(key); }
    }
    return removed;
  }

  return {
    record, recent, byMessageId, olderThan, count, channelCount, guildCount,
    summary, setSummary, clearChannel, clearGuild, purge,
    retentionDays, maxMessages: limit
  };
}

module.exports = { createChannelMemory, DEFAULT_RETENTION_DAYS, DEFAULT_MAX_MESSAGES };
