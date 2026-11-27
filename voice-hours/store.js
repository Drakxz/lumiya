const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");
const path = require("node:path");
const { weekStart, WEEK_MS } = require("./time");

class VoiceHoursStore {
  constructor(filename) {
    if (filename !== ":memory:") fs.mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS totals (
        guildId TEXT NOT NULL, userId TEXT NOT NULL,
        callMs INTEGER NOT NULL DEFAULT 0 CHECK(callMs >= 0),
        mutedMs INTEGER NOT NULL DEFAULT 0 CHECK(mutedMs >= 0 AND mutedMs <= callMs),
        PRIMARY KEY (guildId, userId)
      );
      CREATE TABLE IF NOT EXISTS weeks (
        guildId TEXT NOT NULL, userId TEXT NOT NULL, weekStart INTEGER NOT NULL,
        callMs INTEGER NOT NULL DEFAULT 0 CHECK(callMs >= 0),
        mutedMs INTEGER NOT NULL DEFAULT 0 CHECK(mutedMs >= 0 AND mutedMs <= callMs),
        PRIMARY KEY (guildId, userId, weekStart)
      );
      CREATE TABLE IF NOT EXISTS active (
        guildId TEXT NOT NULL, userId TEXT NOT NULL, channelId TEXT NOT NULL,
        muted INTEGER NOT NULL, enteredAt INTEGER NOT NULL,
        muteStartedAt INTEGER, lastAt INTEGER NOT NULL,
        PRIMARY KEY (guildId, userId)
      );
      CREATE TABLE IF NOT EXISTS voice_segments (
        id INTEGER PRIMARY KEY, guildId TEXT NOT NULL, userId TEXT NOT NULL,
        channelId TEXT NOT NULL, muted INTEGER NOT NULL,
        startAt INTEGER NOT NULL, endAt INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS voice_segments_user ON voice_segments(guildId, userId, endAt);
    `);
    const setting = this.db.prepare("SELECT value FROM metadata WHERE key = 'timezone'").get();
    if (setting && setting.value !== "America/Sao_Paulo:UTC-03") throw new Error("Fuso do banco de horas incompatível.");
    this.db.prepare("INSERT OR IGNORE INTO metadata VALUES ('timezone', 'America/Sao_Paulo:UTC-03')").run();
    this.db.prepare("INSERT OR IGNORE INTO metadata VALUES ('monitoringStartedAt', ?)").run(String(Date.now()));
    this.db.prepare("INSERT OR IGNORE INTO metadata VALUES ('segmentsStartedAt', ?)").run(String(Date.now()));
    this.db.prepare("INSERT INTO metadata VALUES ('currentWeekStart', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(String(weekStart(Date.now())));
    this.getActive = this.db.prepare("SELECT * FROM active WHERE guildId = ? AND userId = ?");
    this.allActive = this.db.prepare("SELECT * FROM active");
    this.guildActive = this.db.prepare("SELECT * FROM active WHERE guildId = ?");
    this.getTotals = this.db.prepare("SELECT * FROM totals WHERE guildId = ? AND userId = ?");
    this.getWeek = this.db.prepare("SELECT callMs, mutedMs FROM weeks WHERE guildId = ? AND userId = ? AND weekStart = ?");
    this.addTotals = this.db.prepare(`INSERT INTO totals (guildId, userId, callMs, mutedMs) VALUES (?, ?, ?, ?)
      ON CONFLICT(guildId, userId) DO UPDATE SET callMs = callMs + excluded.callMs, mutedMs = mutedMs + excluded.mutedMs`);
    this.addWeek = this.db.prepare(`INSERT INTO weeks VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(guildId, userId, weekStart) DO UPDATE SET callMs = callMs + excluded.callMs, mutedMs = mutedMs + excluded.mutedMs`);
    this.advance = this.db.prepare("UPDATE active SET lastAt = ? WHERE guildId = ? AND userId = ?");
    this.latestSegment = this.db.prepare("SELECT * FROM voice_segments WHERE guildId = ? AND userId = ? ORDER BY endAt DESC, id DESC LIMIT 1");
    this.extendSegment = this.db.prepare("UPDATE voice_segments SET endAt = ? WHERE id = ?");
    this.addSegment = this.db.prepare("INSERT INTO voice_segments(guildId,userId,channelId,muted,startAt,endAt) VALUES(?,?,?,?,?,?)");
    this.sumEligible = this.db.prepare(`SELECT COALESCE(SUM(endAt - MAX(startAt, ?)), 0) AS ms
      FROM voice_segments WHERE guildId = ? AND userId = ? AND endAt > ?
      AND (? = 1 OR muted = 0) AND channelId NOT IN (SELECT value FROM json_each(?))`);
    this.remove = this.db.prepare("DELETE FROM active WHERE guildId = ? AND userId = ?");
    this.upsert = this.db.prepare(`INSERT INTO active VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(guildId, userId) DO UPDATE SET channelId = excluded.channelId, muted = excluded.muted,
      enteredAt = excluded.enteredAt, muteStartedAt = excluded.muteStartedAt, lastAt = excluded.lastAt`);
    // Não contabiliza o intervalo offline: o estado será reconstruído do Gateway.
    this.db.exec("DELETE FROM active");
  }

  transaction(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = fn(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  accumulate(row, now) {
    if (!row || now <= row.lastAt) return;
    const elapsed = now - row.lastAt;
    const latest = this.latestSegment.get(row.guildId, row.userId);
    if (latest && latest.channelId === row.channelId && latest.muted === row.muted && latest.endAt === row.lastAt) {
      this.extendSegment.run(now, latest.id);
    } else this.addSegment.run(row.guildId, row.userId, row.channelId, row.muted, row.lastAt, now);
    this.addTotals.run(row.guildId, row.userId, elapsed, row.muted ? elapsed : 0);
    let cursor = row.lastAt;
    while (cursor < now) {
      const week = weekStart(cursor);
      const end = Math.min(now, week + WEEK_MS);
      const duration = end - cursor;
      this.addWeek.run(row.guildId, row.userId, week, duration, row.muted ? duration : 0);
      cursor = end;
    }
    this.advance.run(now, row.guildId, row.userId);
  }

  update({ guildId, userId, channelId, muted }, now = Date.now()) {
    return this.transaction(() => {
      const previous = this.getActive.get(guildId, userId);
      const at = Math.max(now, previous?.lastAt || now);
      this.accumulate(previous, at);
      if (!channelId) { this.remove.run(guildId, userId); return; }
      const enteredAt = previous?.enteredAt ?? at;
      const muteStartedAt = muted ? (previous?.muted ? previous.muteStartedAt : at) : null;
      this.upsert.run(guildId, userId, channelId, muted ? 1 : 0, enteredAt, muteStartedAt, at);
    });
  }

  checkpoint(now = Date.now()) {
    this.transaction(() => {
      for (const row of this.allActive.all()) this.accumulate(row, now);
      this.db.prepare("INSERT INTO metadata VALUES ('currentWeekStart', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .run(String(weekStart(now)));
    });
  }

  stopGuild(guildId, now = Date.now()) {
    this.transaction(() => {
      for (const row of this.guildActive.all(guildId)) this.accumulate(row, now);
      this.db.prepare("DELETE FROM active WHERE guildId = ?").run(guildId);
    });
  }

  reconcile(guildId, states, now = Date.now()) {
    this.transaction(() => {
      // As sessões anteriores já foram fechadas ao suspender a conexão.
      this.db.prepare("DELETE FROM active WHERE guildId = ?").run(guildId);
      for (const state of states) {
        if (!state.channelId) continue;
        const muted = Boolean(state.selfMute || state.serverMute);
        this.upsert.run(guildId, state.id, state.channelId, muted ? 1 : 0, now, muted ? now : null, now);
      }
    });
  }

  stats(guildId, userId, now = Date.now()) {
    return this.transaction(() => {
      this.accumulate(this.getActive.get(guildId, userId), now);
      const totals = this.getTotals.get(guildId, userId);
      const current = weekStart(now);
      const week = this.getWeek.get(guildId, userId, current);
      const lastWeek = this.getWeek.get(guildId, userId, current - WEEK_MS);
      const active = this.getActive.get(guildId, userId);
      return {
        guildId, userId, totalCallMs: totals?.callMs || 0, totalMutedMs: totals?.mutedMs || 0,
        weekCallMs: week?.callMs || 0, weekMutedMs: week?.mutedMs || 0,
        lastWeekCallMs: lastWeek?.callMs || 0, lastWeekMutedMs: lastWeek?.mutedMs || 0,
        weekStart: current, lastWeekStart: current - WEEK_MS,
        channelId: active?.channelId || null, muted: Boolean(active?.muted),
        enteredAt: active?.enteredAt ?? null, muteStartedAt: active?.muteStartedAt ?? null
      };
    });
  }

  eligible(guildId, userId, { since = 0, countMuted = true, excluded = [] } = {}, now = Date.now()) {
    return this.transaction(() => {
      this.accumulate(this.getActive.get(guildId, userId), now);
      return this.sumEligible.get(since, guildId, userId, since, countMuted ? 1 : 0, JSON.stringify(excluded)).ms;
    });
  }

  close(now = Date.now()) {
    this.checkpoint(now);
    this.db.close();
  }
}

module.exports = { VoiceHoursStore };
