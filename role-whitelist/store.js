const {randomUUID}=require("node:crypto");

const DEFAULT_PROFILE={maxRoleId:null,add:true,remove:true,viewHistory:false,manageOthers:true,
  targetPolicy:"all",targetMaxRoleId:null,allowedAddRoleIds:[],allowedRemoveRoleIds:[],blockedRoleIds:[],
  protectedTargetRoleIds:[]};

class RoleWhitelistStore{
  constructor(db,managedRoleIds){this.db=db;this.managedRoleIds=[...new Set(managedRoleIds)];db.exec(`
    CREATE TABLE IF NOT EXISTS role_wl_config(guildId TEXT PRIMARY KEY,data TEXT NOT NULL,updatedAt INTEGER NOT NULL,updatedBy TEXT);
    CREATE TABLE IF NOT EXISTS role_wl_users(guildId TEXT NOT NULL,userId TEXT NOT NULL,status TEXT NOT NULL,profile TEXT NOT NULL,
      authorizedBy TEXT NOT NULL,createdAt INTEGER NOT NULL,updatedAt INTEGER NOT NULL,expiresAt INTEGER,reason TEXT,
      PRIMARY KEY(guildId,userId));
    CREATE INDEX IF NOT EXISTS role_wl_users_active ON role_wl_users(guildId,status,expiresAt);
    CREATE TABLE IF NOT EXISTS role_wl_events(id INTEGER PRIMARY KEY AUTOINCREMENT,guildId TEXT NOT NULL,userId TEXT NOT NULL,
      actorId TEXT NOT NULL,action TEXT NOT NULL,beforeData TEXT,afterData TEXT,reason TEXT,createdAt INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS role_wl_events_user ON role_wl_events(guildId,userId,createdAt DESC);
    CREATE TABLE IF NOT EXISTS role_wl_drafts(id TEXT PRIMARY KEY,guildId TEXT NOT NULL,actorId TEXT NOT NULL,userId TEXT NOT NULL,
      profile TEXT NOT NULL,status TEXT NOT NULL,durationMs INTEGER NOT NULL,reason TEXT,expiresAt INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS role_wl_presets(id TEXT PRIMARY KEY,guildId TEXT NOT NULL,name TEXT NOT NULL,
      profile TEXT NOT NULL,createdAt INTEGER NOT NULL,updatedAt INTEGER NOT NULL,updatedBy TEXT NOT NULL,
      UNIQUE(guildId,name));
    CREATE TABLE IF NOT EXISTS role_wl_role_presets(guildId TEXT NOT NULL,roleId TEXT NOT NULL,presetId TEXT NOT NULL,
      PRIMARY KEY(guildId,roleId));
  `);this.expireAll();}
  config(guildId){const row=this.db.prepare("SELECT data FROM role_wl_config WHERE guildId=?").get(guildId);const data=row?JSON.parse(row.data):{};return {hierarchy:[],...data,hierarchy:Array.isArray(data.hierarchy)?data.hierarchy:[],adminIds:Array.isArray(data.adminIds)?data.adminIds:[]};}
  saveConfig(guildId,config,actorId){this.db.prepare("INSERT INTO role_wl_config VALUES(?,?,?,?) ON CONFLICT(guildId) DO UPDATE SET data=excluded.data,updatedAt=excluded.updatedAt,updatedBy=excluded.updatedBy").run(guildId,JSON.stringify(config),Date.now(),actorId);}
  transaction(work){this.db.exec("BEGIN IMMEDIATE");try{const value=work();this.db.exec("COMMIT");return value;}catch(error){this.db.exec("ROLLBACK");throw error;}}
  isAdmin(guild,member){const c=this.config(guild.id);return Boolean(member?.id===guild.ownerId||c.adminIds.includes(member?.id));}
  row(guildId,userId){this.expire(guildId,userId);return this.db.prepare("SELECT * FROM role_wl_users WHERE guildId=? AND userId=?").get(guildId,userId)||null;}
  active(guildId,userId){const row=this.row(guildId,userId);return row?.status==="active"?{...row,profile:JSON.parse(row.profile)}:null;}
  list(guildId,status="active",page=0,limit=5){this.expireAll(guildId);const where=status==="all"?"":" AND status=?",args=status==="all"?[guildId]:[guildId,status];const total=this.db.prepare(`SELECT COUNT(*) n FROM role_wl_users WHERE guildId=?${where}`).get(...args).n;const rows=this.db.prepare(`SELECT * FROM role_wl_users WHERE guildId=?${where} ORDER BY updatedAt DESC LIMIT ? OFFSET ?`).all(...args,limit,page*limit);return {total,rows:rows.map(r=>({...r,profile:JSON.parse(r.profile)}))};}
  count(guildId,status){this.expireAll(guildId);return this.db.prepare("SELECT COUNT(*) n FROM role_wl_users WHERE guildId=? AND status=?").get(guildId,status).n;}
  event(guildId,userId,actorId,action,beforeData,afterData,reason=null){this.db.prepare("INSERT INTO role_wl_events(guildId,userId,actorId,action,beforeData,afterData,reason,createdAt) VALUES(?,?,?,?,?,?,?,?)").run(guildId,userId,actorId,action,beforeData?JSON.stringify(beforeData):null,afterData?JSON.stringify(afterData):null,reason,Date.now());}
  saveUser(guildId,userId,profile,status,actorId,durationMs,reason=null){
    const old=this.row(guildId,userId),now=Date.now(),expiresAt=durationMs>0?now+durationMs:null;
    this.transaction(()=>{
      this.db.prepare(`INSERT INTO role_wl_users VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(guildId,userId) DO UPDATE SET status=excluded.status,
        profile=excluded.profile,updatedAt=excluded.updatedAt,expiresAt=excluded.expiresAt,reason=excluded.reason`).run(guildId,userId,status,JSON.stringify(profile),old?.authorizedBy||actorId,old?.createdAt||now,now,expiresAt,reason);
      this.event(guildId,userId,actorId,old?"updated":"authorized",old?JSON.parse(old.profile):null,profile,reason);
    });
    return this.row(guildId,userId);
  }
  setStatus(guildId,userId,status,actorId,reason=null){const row=this.row(guildId,userId);if(!row)return null;this.transaction(()=>{this.db.prepare("UPDATE role_wl_users SET status=?,updatedAt=?,reason=? WHERE guildId=? AND userId=?").run(status,Date.now(),reason,guildId,userId);this.event(guildId,userId,actorId,status,JSON.parse(row.profile),JSON.parse(row.profile),reason);});return this.row(guildId,userId);}
  expire(guildId,userId,now=Date.now()){const r=this.db.prepare("SELECT * FROM role_wl_users WHERE guildId=? AND userId=? AND status='active' AND expiresAt IS NOT NULL AND expiresAt<=?").get(guildId,userId,now);if(!r)return false;return this.transaction(()=>{const result=this.db.prepare("UPDATE role_wl_users SET status='expired',updatedAt=? WHERE guildId=? AND userId=? AND status='active' AND expiresAt<=?").run(now,guildId,userId,now);if(result.changes)this.event(guildId,userId,"system","expired",JSON.parse(r.profile),JSON.parse(r.profile),"Autorização temporária expirada");return Boolean(result.changes);});}
  expireAll(guildId=null,now=Date.now()){const rows=this.db.prepare(`SELECT guildId,userId FROM role_wl_users WHERE status='active' AND expiresAt IS NOT NULL AND expiresAt<=?${guildId?" AND guildId=?":""}`).all(...(guildId?[now,guildId]:[now]));for(const r of rows)this.expire(r.guildId,r.userId,now);return rows.length;}
  createDraft(guildId,actorId,userId){const existing=this.row(guildId,userId),id=randomUUID(),profile=existing?JSON.parse(existing.profile):{...DEFAULT_PROFILE,allowedAddRoleIds:[],allowedRemoveRoleIds:[],blockedRoleIds:[],protectedTargetRoleIds:[]};Object.assign(profile,{add:true,remove:true,manageOthers:true,targetPolicy:"all",blockedRoleIds:[],protectedTargetRoleIds:[],allowedAddRoleIds:[],allowedRemoveRoleIds:[]});delete profile.blockAdministrators;this.db.prepare("INSERT INTO role_wl_drafts VALUES(?,?,?,?,?,'editing',?,NULL,?)").run(id,guildId,actorId,userId,JSON.stringify(profile),existing?.expiresAt?Math.max(0,existing.expiresAt-Date.now()):0,Date.now()+30*60*1000);return this.draft(id,guildId,actorId);}
  draft(id,guildId,actorId,now=Date.now()){const r=this.db.prepare("SELECT * FROM role_wl_drafts WHERE id=? AND guildId=? AND actorId=? AND expiresAt>?").get(id,guildId,actorId,now);return r?{...r,profile:JSON.parse(r.profile)}:null;}
  updateDraft(id,guildId,actorId,profile,durationMs){this.db.prepare("UPDATE role_wl_drafts SET profile=?,durationMs=? WHERE id=? AND guildId=? AND actorId=? AND expiresAt>?").run(JSON.stringify(profile),durationMs,id,guildId,actorId,Date.now());return this.draft(id,guildId,actorId);}
  deleteDraft(id){this.db.prepare("DELETE FROM role_wl_drafts WHERE id=?").run(id);}
  createPresetDraft(guildId,actorId,presetId){
    const preset=presetId==="new"?null:this.preset(guildId,presetId);
    const id=randomUUID(),profile=preset?JSON.parse(JSON.stringify(preset.profile)):{...DEFAULT_PROFILE,
      allowedAddRoleIds:[],allowedRemoveRoleIds:[],blockedRoleIds:[],protectedTargetRoleIds:[]};
    Object.assign(profile,{add:true,remove:true,manageOthers:true,targetPolicy:"all",blockedRoleIds:[],protectedTargetRoleIds:[]});
    delete profile.blockAdministrators;
    const userId=`__preset__:${presetId}`;
    this.db.prepare("INSERT INTO role_wl_drafts VALUES(?,?,?,?,?,'editing',0,?,?)")
      .run(id,guildId,actorId,userId,JSON.stringify(profile),preset?.name||"Novo preset",Date.now()+30*60*1000);
    return this.draft(id,guildId,actorId);
  }
  createUserDraftFromPreset(guildId,actorId,userId,presetId){
    const preset=this.preset(guildId,presetId);if(!preset)return null;
    const existing=this.row(guildId,userId),id=randomUUID();
    const profile=JSON.parse(JSON.stringify(preset.profile));
    Object.assign(profile,{add:true,remove:true,manageOthers:true});
    const durationMs=existing?.expiresAt?Math.max(0,existing.expiresAt-Date.now()):0;
    this.db.prepare("INSERT INTO role_wl_drafts VALUES(?,?,?,?,?,'editing',?,?,?)")
      .run(id,guildId,actorId,userId,JSON.stringify(profile),durationMs,`Preset: ${preset.name}`,Date.now()+30*60*1000);
    return this.draft(id,guildId,actorId);
  }
  presets(guildId){return this.db.prepare("SELECT * FROM role_wl_presets WHERE guildId=? ORDER BY updatedAt DESC").all(guildId).map(r=>({...r,profile:JSON.parse(r.profile)}));}
  preset(guildId,id){const r=this.db.prepare("SELECT * FROM role_wl_presets WHERE guildId=? AND id=?").get(guildId,id);return r?{...r,profile:JSON.parse(r.profile)}:null;}
  savePreset(guildId,id,name,profile,actorId){
    const now=Date.now(),existing=id?this.preset(guildId,id):null;
    if(!existing&&this.db.prepare("SELECT 1 FROM role_wl_presets WHERE guildId=? AND name=?").get(guildId,name))throw new Error("Já existe um preset com esse nome.");
    const finalId=existing?.id||randomUUID();
    this.transaction(()=>{
      this.db.prepare(`INSERT INTO role_wl_presets VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
        name=excluded.name,profile=excluded.profile,updatedAt=excluded.updatedAt,updatedBy=excluded.updatedBy`)
        .run(finalId,guildId,name,JSON.stringify(profile),existing?.createdAt||now,now,actorId);
      this.event(guildId,"__preset__",actorId,existing?"preset-updated":"preset-created",null,{id:finalId,name},`Preset: ${name}`);
    });
    return this.preset(guildId,finalId);
  }
  deletePreset(guildId,id,actorId){
    const preset=this.preset(guildId,id);if(!preset)return false;
    this.transaction(()=>{
      this.db.prepare("DELETE FROM role_wl_role_presets WHERE guildId=? AND presetId=?").run(guildId,id);
      this.db.prepare("DELETE FROM role_wl_presets WHERE guildId=? AND id=?").run(guildId,id);
      this.event(guildId,"__preset__",actorId,"preset-deleted",{id,name:preset.name},null,`Preset: ${preset.name}`);
    });return true;
  }
  rolePreset(guildId,roleId){
    const row=this.db.prepare("SELECT presetId FROM role_wl_role_presets WHERE guildId=? AND roleId=?").get(guildId,roleId);
    return row?this.preset(guildId,row.presetId):null;
  }
  roleLinks(guildId,presetId=null){
    const rows=presetId
      ?this.db.prepare("SELECT * FROM role_wl_role_presets WHERE guildId=? AND presetId=? ORDER BY roleId").all(guildId,presetId)
      :this.db.prepare("SELECT * FROM role_wl_role_presets WHERE guildId=? ORDER BY roleId").all(guildId);
    return rows.map(r=>({...r,preset:this.preset(guildId,r.presetId)})).filter(r=>r.preset);
  }
  linkRolePreset(guildId,roleId,presetId,actorId){
    const preset=this.preset(guildId,presetId);if(!preset)throw new Error("Preset não encontrado.");
    this.transaction(()=>{
      this.db.prepare("INSERT INTO role_wl_role_presets VALUES(?,?,?) ON CONFLICT(guildId,roleId) DO UPDATE SET presetId=excluded.presetId")
        .run(guildId,roleId,presetId);
      this.event(guildId,"__preset__",actorId,"preset-role-linked",{roleId},{presetId,name:preset.name},`Preset: ${preset.name}`);
    });
    return preset;
  }
  unlinkRolePreset(guildId,roleId,actorId){
    const row=this.db.prepare("SELECT presetId FROM role_wl_role_presets WHERE guildId=? AND roleId=?").get(guildId,roleId);
    if(!row)return false;
    const preset=this.preset(guildId,row.presetId);
    this.transaction(()=>{
      this.db.prepare("DELETE FROM role_wl_role_presets WHERE guildId=? AND roleId=?").run(guildId,roleId);
      this.event(guildId,"__preset__",actorId,"preset-role-unlinked",{roleId,presetId:row.presetId},null,preset?`Preset: ${preset.name}`:null);
    });return true;
  }
  history(guildId,userId,page=0,limit=5){return this.db.prepare("SELECT * FROM role_wl_events WHERE guildId=? AND userId=? ORDER BY createdAt DESC,id DESC LIMIT ? OFFSET ?").all(guildId,userId,limit,page*limit);}
  historyCount(guildId,userId){return this.db.prepare("SELECT COUNT(*) n FROM role_wl_events WHERE guildId=? AND userId=?").get(guildId,userId).n;}
}
module.exports={RoleWhitelistStore,DEFAULT_PROFILE};
