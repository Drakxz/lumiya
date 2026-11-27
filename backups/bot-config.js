const fs = require("node:fs");
const path = require("node:path");
const { randomUUID,createHash } = require("node:crypto");
const createResourceIds = require("../resource-ids");

// Configuration only: never restore chat memories, moderation cases, counters,
// audit history, credentials, sessions or live/pending role operations.
const TABLES = {
  ticket_management_config: ["config"],
  ticket_management_weekly_goals: [],
  management_everyone_goals: [],
  media_moderation_settings: ["settings"],
  media_moderation_channels: [],
  nickname_protection_config: [],
  games_roles_config: ["roleIds"],
  up_config: ["settings"],
  up_levels: [],
  up_maintenance_roles: [],
  role_wl_config: ["data"],
  role_wl_users: ["profile"],
  role_wl_presets: ["profile"],
  role_wl_role_presets: [],
  ai_chat_settings: [],
  initial_role_config: [],
  auto_calls_config: [],
  command_center_panels: [],
  server_backup_settings: ["messageConfig"]
};
const DATA_KEYS = ["ticketRoles", "ticketConfigRoles", "ticketClaimRoles", "ticketGoals", "ticketGoalsByRole"];
const clone = value => JSON.parse(JSON.stringify(value));

module.exports = function createBotConfig({ db, botData, dataFile }) {
  const aliases = createResourceIds(db);
  db.exec(`CREATE TABLE IF NOT EXISTS bot_configuration_panels(
    guildId TEXT NOT NULL,channelId TEXT NOT NULL,kind TEXT NOT NULL,messageId TEXT,
    PRIMARY KEY(guildId,channelId,kind))`);
  const available = () => new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
  function trackPanel(guildId, channelId, kind, messageId) {
    if (!["support", "migration", "hall"].includes(kind)) return;
    db.prepare("INSERT OR REPLACE INTO bot_configuration_panels VALUES(?,?,?,?)").run(guildId, channelId, kind, messageId);
  }
  function capture(guildId) {
    const tables = {}, present = available();
    for (const table of Object.keys(TABLES)) {
      if (present.has(table)) tables[table] = db.prepare(`SELECT * FROM "${table}" WHERE guildId=?`).all(guildId);
    }
    const data = {};
    for (const key of DATA_KEYS) {
      if(botData)data[key]=botData[key]&&Object.hasOwn(botData[key],guildId)?clone(botData[key][guildId]):null;
    }
    const panels = db.prepare("SELECT * FROM bot_configuration_panels WHERE guildId=?").all(guildId);
    // Existing tickets identify the opening-panel parent even before tracking
    // panel messages was introduced. Threads themselves are not restored.
    for (const ticket of Object.values(botData?.tickets || {})) {
      const parentId=aliases.resolve(guildId,ticket.parentId);
      if (ticket.guildId === guildId && ticket.parentId && ["support", "migration"].includes(ticket.sistema) &&
          !panels.some(p => p.channelId === parentId && p.kind === ticket.sistema)) {
        panels.push({ guildId, channelId: parentId, kind: ticket.sistema, messageId: null });
      }
    }
    const resourceAliases=db.prepare("SELECT oldId FROM bot_resource_remaps WHERE guildId=?").all(guildId)
      .map(row=>({oldId:row.oldId,newId:aliases.resolve(guildId,row.oldId)}));
    return clone({ version: 1, guildId, tables, data, panels,resourceAliases });
  }

  function apply(guild, backup, maps,{allowCrossGuild=false}={}) {
    const sourceGuildId=backup.originGuildId,crossGuild=sourceGuildId!==guild.id;
    if (!sourceGuildId||crossGuild&&!allowCrossGuild) throw new Error("Configurações pertencem a outro servidor.");
    const saved = backup.botConfiguration;
    if (saved && (saved.version !== 1 || saved.guildId !== sourceGuildId)) throw new Error("Snapshot de configuração inválido.");
    // Old archives have no configuration snapshot: only rebind current settings.
    const snapshot = saved || (crossGuild?{version:1,guildId:sourceGuildId,tables:{},data:{},panels:[]}:capture(guild.id));
    if(!saved&&backup.internal?.sqlite){
      for(const table of Object.keys(TABLES)){
        if(Array.isArray(backup.internal.sqlite[table]))snapshot.tables[table]=backup.internal.sqlite[table];
      }
    }
    const source = new Set([...(backup.roles || []), ...(backup.channels || [])].map(item => item.id));
    const mapping = new Map([...Object.entries(maps.roleMap || {}), ...Object.entries(maps.channelMap || {})]);
    mapping.set(sourceGuildId,guild.id);
    const errors = [];
    function remap(value) {
      if (typeof value === "string") {
        if (mapping.has(value)) return mapping.get(value);
        if (source.has(value)) throw new Error(`recurso ${value} não foi restaurado`);
        return value;
      }
      if (Array.isArray(value)) return value.map(remap);
      if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [remap(key), remap(item)]));
      return value;
    }
    const prepared = [];
    const present = available();
    for (const [table, jsonColumns] of Object.entries(TABLES)) {
      if(crossGuild&&table==="role_wl_users")continue;
      if (!Object.hasOwn(snapshot.tables || {}, table)) continue;
      if (!present.has(table)) { errors.push(`Configuração ${table}: módulo indisponível.`); continue; }
      try {
        const rows = snapshot.tables[table];
        if (!Array.isArray(rows)) throw new Error("lista inválida");
        const columns = db.prepare(`PRAGMA table_info("${table}")`).all().map(row => row.name);
        const transformed = rows.map(original => {
          if (original.guildId !== sourceGuildId) throw new Error("registro de outro servidor");
          const row = Object.fromEntries(Object.entries(original).filter(([key]) => columns.includes(key)));
          for (const column of jsonColumns) if (row[column] != null) row[column] = JSON.parse(row[column]);
          const next = remap(row);
          next.guildId=guild.id;
          if(crossGuild){
            if(table==="role_wl_config"&&next.data)next.data.adminIds=[];
            if(table==="ticket_management_config"&&next.config)next.config.adminUserIds=[];
            if(table==="media_moderation_settings"&&next.settings)delete next.settings.externalReview;
            if(["up_levels","command_center_panels"].includes(table)){
              const hash=createHash("sha256").update(`${table}:${guild.id}:${original.id}`).digest("hex");
              next.id=`${hash.slice(0,8)}-${hash.slice(8,12)}-${hash.slice(12,16)}-${hash.slice(16,20)}-${hash.slice(20,32)}`;
            }
          }
          if(table==="command_center_panels"&&next.channelId!==original.channelId){
            next.messageId=null;next.hash="";
          }
          for (const column of jsonColumns) if (next[column] != null) next[column] = JSON.stringify(next[column]);
          // Invalidate stale UP administrative panels without touching progress.
          if (table === "up_config") next.revision = Math.max(next.revision || 0,
            db.prepare("SELECT revision FROM up_config WHERE guildId=?").get(guild.id)?.revision || 0) + 1;
          return next;
        });
        prepared.push({ table, rows: transformed });
      } catch (error) {
        // Preserve the entire section if a dependency failed: never loosen an
        // authorization boundary by silently dropping a missing protected role.
        errors.push(`Configuração ${table} não aplicada: ${error.message}`);
      }
    }
    const nextData = botData ? clone(botData) : null;
    let dataSections = 0;
    if (nextData) for (const key of DATA_KEYS) {
      if (!Object.hasOwn(snapshot.data || {}, key)) continue;
      try {
        nextData[key] ||= {};
        if(snapshot.data[key]===null)delete nextData[key][guild.id];
        else nextData[key][guild.id] = remap(snapshot.data[key]);
        dataSections++;
      } catch (error) { errors.push(`Configuração ${key} não aplicada: ${error.message}`); }
    }
    const panels = [];
    for (const panel of snapshot.panels || []) {
      try {
        if (panel.guildId !== sourceGuildId || !["support", "migration", "hall"].includes(panel.kind)) throw new Error("painel inválido");
        const channelId=remap(panel.channelId);
        panels.push({ ...panel,guildId:guild.id,channelId, messageId:!crossGuild&&channelId===panel.channelId?panel.messageId:null });
      } catch (error) { errors.push(`Painel de tickets não aplicado: ${error.message}`); }
    }
    const inheritedAliases=[];
    for(const alias of snapshot.resourceAliases||[]){
      try{
        const newId=remap(alias.newId);
        if(typeof alias.oldId!=="string"||typeof newId!=="string"||
            (!guild.channels.cache.has(newId)&&!guild.roles.cache.has(newId)))throw new Error("destino indisponível");
        inheritedAliases.push([alias.oldId,newId]);
      }catch(error){errors.push(`Referência antiga não aplicada: ${error.message}`);}
    }
    // Never trust aliases pointing to resources absent from this guild.
    for (const [oldId, newId] of mapping) {
      if (oldId === sourceGuildId&&newId===guild.id) continue;
      if (!guild.channels.cache.has(newId) && !guild.roles.cache.has(newId)) {
        throw new Error(`Destino de configuração ${newId} não pertence ao servidor restaurado.`);
      }
    }
    let previousFile, stagedFile, fileReplaced=false;
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const { table, rows } of prepared) {
        db.prepare(`DELETE FROM "${table}" WHERE guildId=?`).run(guild.id);
        for (const row of rows) {
          const columns = Object.keys(row);
          db.prepare(`INSERT INTO "${table}" (${columns.map(c => `"${c}"`).join(",")}) VALUES(${columns.map(() => "?").join(",")})`)
            .run(...columns.map(column => row[column]));
        }
      }
      const saveAlias = db.prepare("INSERT INTO bot_resource_remaps VALUES(?,?,?) ON CONFLICT(guildId,oldId) DO UPDATE SET newId=excluded.newId");
      // Rebind all older roots in one pass. Alias values are canonical current
      // IDs, not traversed recursively (two existing resources can swap maps).
      const oldAliases=db.prepare("SELECT oldId,newId FROM bot_resource_remaps WHERE guildId=?").all(guild.id);
      for(const alias of oldAliases)if(mapping.has(alias.newId))saveAlias.run(guild.id,alias.oldId,mapping.get(alias.newId));
      for(const [oldId,newId]of inheritedAliases)if(oldId!==newId)saveAlias.run(guild.id,oldId,newId);
      for (const [oldId, newId] of mapping) saveAlias.run(guild.id, oldId, newId);
      if(!crossGuild||saved||snapshot.panels.length)db.prepare("DELETE FROM bot_configuration_panels WHERE guildId=?").run(guild.id);
      for (const panel of panels) trackPanel(guild.id, panel.channelId, panel.kind,panel.messageId);
      if (nextData && dataFile) {
        previousFile = fs.existsSync(dataFile) ? fs.readFileSync(dataFile) : null;
        stagedFile = `${dataFile}.${randomUUID()}.tmp`;
        fs.mkdirSync(path.dirname(path.resolve(dataFile)), { recursive: true });
        fs.writeFileSync(stagedFile, JSON.stringify(nextData, null, 2), { mode: 0o600, flag: "wx" });
        fs.renameSync(stagedFile, dataFile);
        fileReplaced=true;
      }
      db.exec("COMMIT");
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch {}
      if (stagedFile) {
        fs.rmSync(stagedFile, { force: true });
        if(fileReplaced){
          if(previousFile)fs.writeFileSync(dataFile,previousFile);
          else fs.rmSync(dataFile,{force:true});
        }
      }
      throw error;
    }
    if (nextData) for (const key of DATA_KEYS) if (nextData[key]) botData[key] = nextData[key];
    return { tables: prepared.length, dataSections, panels, errors, snapshot: Boolean(saved) };
  }
  return { capture, apply, trackPanel, aliases };
};
