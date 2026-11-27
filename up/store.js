const { randomUUID } = require("node:crypto");

const DEFAULTS = { enabled: false, countMuted: true, removePrevious: true,
  retroactive: false, excludedChannels: [], initialRoles: [], notificationChannel: null };

class UpStore {
  constructor(hours) {
    this.hours = hours;
    this.db = hours.db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS up_config(guildId TEXT PRIMARY KEY, settings TEXT NOT NULL, revision INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS up_levels(id TEXT PRIMARY KEY, guildId TEXT NOT NULL, roleId TEXT NOT NULL,
        requiredMs INTEGER NOT NULL CHECK(requiredMs >= 0), UNIQUE(guildId,roleId), UNIQUE(guildId,requiredMs));
      CREATE INDEX IF NOT EXISTS up_levels_guild ON up_levels(guildId,requiredMs);
      CREATE TABLE IF NOT EXISTS up_members(guildId TEXT NOT NULL,userId TEXT NOT NULL,joinedAt INTEGER NOT NULL,
        baselineTotal INTEGER NOT NULL,currentLevelId TEXT,currentRoleId TEXT,bestMs INTEGER NOT NULL DEFAULT -1,
        lastEvolution INTEGER,updatedAt INTEGER NOT NULL,state TEXT NOT NULL,recalculate INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(guildId,userId));
      CREATE TABLE IF NOT EXISTS up_operations(id TEXT PRIMARY KEY,guildId TEXT NOT NULL,userId TEXT NOT NULL,
        levelId TEXT NOT NULL,roleId TEXT NOT NULL,requiredMs INTEGER NOT NULL,previousRoleId TEXT,
        hoursMs INTEGER NOT NULL,removePrevious INTEGER NOT NULL,recalculate INTEGER NOT NULL,
        state TEXT NOT NULL,createdAt INTEGER NOT NULL,finishedAt INTEGER,notification TEXT NOT NULL DEFAULT 'pending');
      CREATE UNIQUE INDEX IF NOT EXISTS up_one_pending ON up_operations(guildId,userId) WHERE state != 'done';
      CREATE INDEX IF NOT EXISTS up_operations_user ON up_operations(guildId,userId,state,notification);
      CREATE TABLE IF NOT EXISTS up_unlocks(guildId TEXT NOT NULL,userId TEXT NOT NULL,levelId TEXT NOT NULL,
        roleId TEXT NOT NULL,requiredMs INTEGER NOT NULL,achievedAt INTEGER NOT NULL,
        PRIMARY KEY(guildId,userId,levelId));
      CREATE TABLE IF NOT EXISTS up_sessions(id TEXT PRIMARY KEY,guildId TEXT NOT NULL,userId TEXT NOT NULL,
        data TEXT NOT NULL,expiresAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS up_maintenance_roles(guildId TEXT NOT NULL,roleId TEXT NOT NULL,
        requiredMs INTEGER NOT NULL,enabledAt INTEGER NOT NULL,PRIMARY KEY(guildId,roleId));
      CREATE TABLE IF NOT EXISTS up_maintenance_members(guildId TEXT NOT NULL,userId TEXT NOT NULL,
        checkedUntil INTEGER NOT NULL DEFAULT 0,blockedUntil INTEGER NOT NULL DEFAULT 0,
        eligibleOffset INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(guildId,userId));
      CREATE TABLE IF NOT EXISTS up_maintenance_operations(opId TEXT PRIMARY KEY);
    `);
  }
  config(guildId) {
    const row = this.db.prepare("SELECT * FROM up_config WHERE guildId=?").get(guildId);
    return { ...DEFAULTS, ...(row ? JSON.parse(row.settings) : {}), revision: row?.revision || 0 };
  }
  saveConfig(guildId, changes, expected) {
    return this.hours.transaction(() => {
      const config = this.config(guildId);
      if (expected !== undefined && config.revision !== expected) throw new Error("A configuração mudou em outro painel. Atualize e tente novamente.");
      const next = { ...config, ...changes, revision: config.revision + 1 };
      this.db.prepare(`INSERT INTO up_config VALUES(?,?,?) ON CONFLICT(guildId)
        DO UPDATE SET settings=excluded.settings,revision=excluded.revision`).run(guildId, JSON.stringify(next), next.revision);
      return next;
    });
  }
  levels(guildId) { return this.db.prepare("SELECT * FROM up_levels WHERE guildId=? ORDER BY requiredMs").all(guildId); }
  maintenance(guildId,roleId) {
    return this.db.prepare("SELECT * FROM up_maintenance_roles WHERE guildId=? AND roleId=?").get(guildId,roleId);
  }
  saveMaintenance(guildId,roleId,requiredMs,expected) {
    if(!Number.isSafeInteger(requiredMs)||requiredMs<0)throw new Error("Informe horas semanais válidas; 0 desativa a meta.");
    return this.hours.transaction(()=>{
      if(!this.levels(guildId).some(l=>l.roleId===roleId))throw new Error("Cargo não configurado na progressão.");
      const config=this.config(guildId);
      if(config.revision!==expected)throw new Error("A configuração mudou. Atualize o painel.");
      const next={...config,revision:config.revision+1};
      this.db.prepare(`INSERT INTO up_config VALUES(?,?,?) ON CONFLICT(guildId)
        DO UPDATE SET settings=excluded.settings,revision=excluded.revision`).run(guildId,JSON.stringify(next),next.revision);
      this.db.prepare(`INSERT INTO up_maintenance_roles VALUES(?,?,?,?) ON CONFLICT(guildId,roleId)
        DO UPDATE SET requiredMs=excluded.requiredMs,enabledAt=excluded.enabledAt`).run(guildId,roleId,requiredMs,Date.now());
    });
  }
  maintenanceState(guildId,userId) {
    return this.db.prepare("SELECT * FROM up_maintenance_members WHERE guildId=? AND userId=?").get(guildId,userId)||{checkedUntil:0,blockedUntil:0,eligibleOffset:0};
  }
  saveLevel(guildId, { id, roleId, requiredMs }, expected) {
    return this.hours.transaction(() => {
      const config = this.config(guildId);
      if (config.revision !== expected) throw new Error("A configuração mudou. Atualize o painel antes de salvar.");
      const levels = this.levels(guildId);
      const old = levels.find(level => level.id === id);
      if (id && !old) throw new Error("O nível não existe mais.");
      if (!Number.isSafeInteger(requiredMs) || requiredMs < 0) throw new Error("Informe horas não negativas e válidas.");
      if (levels.some(level => level.id !== id && (level.roleId === roleId || level.requiredMs === requiredMs))) {
        throw new Error("Cargo ou requisito já utilizado em outro nível.");
      }
      if (old?.requiredMs === 0 && requiredMs !== 0) throw new Error("O cargo inicial precisa manter a meta de 0 horas.");
      if (!old && !levels.length && requiredMs !== 0) throw new Error("Configure primeiro o cargo inicial com 0 horas.");
      if (config.initialRoles.includes(roleId) && requiredMs !== 0) throw new Error("Esse cargo está configurado como uma opção inicial.");
      const levelId = id || randomUUID();
      this.db.prepare(`INSERT INTO up_levels VALUES(?,?,?,?) ON CONFLICT(id)
        DO UPDATE SET roleId=excluded.roleId,requiredMs=excluded.requiredMs`).run(levelId,guildId,roleId,requiredMs);
      const next = { ...config, revision: config.revision + 1 };
      this.db.prepare(`INSERT INTO up_config VALUES(?,?,?) ON CONFLICT(guildId)
        DO UPDATE SET settings=excluded.settings,revision=excluded.revision`).run(guildId,JSON.stringify(next),next.revision);
      return levelId;
    });
  }
  removeLevel(guildId, id, expected) {
    this.hours.transaction(() => {
      const config = this.config(guildId);
      if (config.revision !== expected) throw new Error("A configuração mudou. Atualize o painel.");
      const levels = this.levels(guildId);
      const level = levels.find(item => item.id === id);
      if (!level) throw new Error("Nível não encontrado.");
      if (level.requiredMs === 0 && (levels.length > 1 || config.enabled)) throw new Error("Não remova o cargo inicial com o sistema ativo ou com outros níveis configurados.");
      this.db.prepare("DELETE FROM up_levels WHERE id=? AND guildId=?").run(id,guildId);
      this.db.prepare("DELETE FROM up_maintenance_roles WHERE guildId=? AND roleId=?").run(guildId,level.roleId);
      const next = { ...config, revision: config.revision + 1 };
      this.db.prepare("UPDATE up_config SET settings=?,revision=? WHERE guildId=?").run(JSON.stringify(next),next.revision,guildId);
    });
  }
  member(guildId,userId) { return this.db.prepare("SELECT * FROM up_members WHERE guildId=? AND userId=?").get(guildId,userId); }
  unlocks(guildId,userId) { return this.db.prepare("SELECT * FROM up_unlocks WHERE guildId=? AND userId=?").all(guildId,userId); }
  join(guildId,userId,baselineTotal,now) {
    this.db.prepare("INSERT OR IGNORE INTO up_members(guildId,userId,joinedAt,baselineTotal,updatedAt,state) VALUES(?,?,?,?,?,'enrolling')")
      .run(guildId,userId,now,baselineTotal,now);
    return this.member(guildId,userId);
  }
  pending(guildId,userId) { return this.db.prepare("SELECT * FROM up_operations WHERE guildId=? AND userId=? AND state!='done'").get(guildId,userId); }
  plan(member, level, roleId, hoursMs, config) {
    const op = { id: randomUUID(), guildId: member.guildId,userId: member.userId,levelId: level.id,
      roleId,requiredMs: level.requiredMs,previousRoleId: member.currentRoleId,hoursMs,
      removePrevious: config.removePrevious ? 1 : 0,recalculate: member.recalculate,state: "planned",createdAt: Date.now() };
    this.db.prepare(`INSERT INTO up_operations(id,guildId,userId,levelId,roleId,requiredMs,previousRoleId,hoursMs,removePrevious,recalculate,state,createdAt)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(op.id,op.guildId,op.userId,op.levelId,op.roleId,op.requiredMs,op.previousRoleId,
      op.hoursMs,op.removePrevious,op.recalculate,op.state,op.createdAt);
    return op;
  }
  markGranted(op) { this.db.prepare("UPDATE up_operations SET state='granted' WHERE id=?").run(op.id); }
  cancel(op) { this.db.prepare("UPDATE up_operations SET state='done',finishedAt=?,notification='skipped' WHERE id=?").run(Date.now(),op.id); }
  finish(op, now = Date.now()) {
    this.hours.transaction(() => {
      this.db.prepare("UPDATE up_operations SET state='done',finishedAt=? WHERE id=?").run(now,op.id);
      this.db.prepare(`UPDATE up_members SET currentLevelId=?,currentRoleId=?,bestMs=?,lastEvolution=?,updatedAt=?,state='active',recalculate=0
        WHERE guildId=? AND userId=?`).run(op.levelId,op.roleId,op.requiredMs,now,now,op.guildId,op.userId);
      this.db.prepare("INSERT OR IGNORE INTO up_unlocks VALUES(?,?,?,?,?,?)").run(op.guildId,op.userId,op.levelId,op.roleId,op.requiredMs,now);
    });
  }
  participants(guildId) { return this.db.prepare("SELECT COUNT(*) AS n FROM up_members WHERE guildId=? AND state!='absent'").get(guildId).n; }
  session(state) {
    this.db.prepare("INSERT INTO up_sessions VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,expiresAt=excluded.expiresAt")
      .run(state.id,state.guildId,state.userId,JSON.stringify(state),Date.now()+24*60*60*1000);
    return state;
  }
  getSession(id) {
    const row = this.db.prepare("SELECT data FROM up_sessions WHERE id=? AND expiresAt>?").get(id,Date.now());
    return row ? JSON.parse(row.data) : null;
  }
}

module.exports = { UpStore, DEFAULTS };
