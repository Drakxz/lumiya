const {randomUUID}=require("node:crypto");
const clone=value=>JSON.parse(JSON.stringify(value));
const fail=message=>{throw new Error(message);};
class ConfigStore{
  constructor(db){
    this.db=db;
    db.exec(`
      CREATE TABLE IF NOT EXISTS lumiya_settings(guildId TEXT PRIMARY KEY,data TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS lumiya_panels(guildId TEXT NOT NULL,panelId TEXT NOT NULL,data TEXT NOT NULL,version INTEGER NOT NULL,updatedAt INTEGER NOT NULL,updatedBy TEXT NOT NULL,PRIMARY KEY(guildId,panelId));
      CREATE TABLE IF NOT EXISTS lumiya_drafts(id TEXT PRIMARY KEY,guildId TEXT NOT NULL,userId TEXT NOT NULL,panelId TEXT NOT NULL,data TEXT NOT NULL,baseVersion INTEGER NOT NULL,revision INTEGER NOT NULL,updatedAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS lumiya_sessions(id TEXT PRIMARY KEY,guildId TEXT NOT NULL,userId TEXT NOT NULL,data TEXT NOT NULL,revision INTEGER NOT NULL,expiresAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS lumiya_assets(id TEXT PRIMARY KEY,guildId TEXT NOT NULL,bytes BLOB NOT NULL,mime TEXT NOT NULL,hash TEXT NOT NULL,createdAt INTEGER NOT NULL,createdBy TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS lumiya_publications(id TEXT PRIMARY KEY,guildId TEXT NOT NULL,panelId TEXT NOT NULL,channelId TEXT NOT NULL,messageId TEXT,status TEXT NOT NULL,createdAt INTEGER NOT NULL,updatedAt INTEGER NOT NULL,createdBy TEXT,UNIQUE(guildId,channelId,messageId));
      CREATE INDEX IF NOT EXISTS lumiya_publications_guild ON lumiya_publications(guildId,panelId);
      CREATE TABLE IF NOT EXISTS lumiya_audit(id INTEGER PRIMARY KEY,guildId TEXT NOT NULL,userId TEXT,action TEXT NOT NULL,panelId TEXT,beforeData TEXT,afterData TEXT,createdAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS lumiya_onboarding(guildId TEXT PRIMARY KEY,status TEXT NOT NULL,channelId TEXT,messageId TEXT,updatedAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS lumiya_member_welcomes(guildId TEXT NOT NULL,userId TEXT NOT NULL,joinedAt INTEGER NOT NULL,status TEXT NOT NULL,PRIMARY KEY(guildId,userId,joinedAt));
      CREATE TABLE IF NOT EXISTS lumiya_access(
        guildId TEXT NOT NULL,subjectType TEXT NOT NULL,subjectId TEXT NOT NULL,
        level INTEGER NOT NULL,permissions TEXT NOT NULL,expiresAt INTEGER,
        grantedBy TEXT,reason TEXT,createdAt INTEGER NOT NULL,expiredLogged INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(guildId,subjectType,subjectId));
      CREATE TABLE IF NOT EXISTS lumiya_access_history(
        id INTEGER PRIMARY KEY,guildId TEXT NOT NULL,actorId TEXT,subjectType TEXT,subjectId TEXT,
        action TEXT NOT NULL,beforeData TEXT,afterData TEXT,reason TEXT,createdAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS lumiya_access_meta(guildId TEXT PRIMARY KEY,migrated INTEGER NOT NULL);
    `);
    if(!db.prepare("PRAGMA table_info(lumiya_publications)").all().some(c=>c.name==="state"))
      db.exec("ALTER TABLE lumiya_publications ADD COLUMN state TEXT NOT NULL DEFAULT '{}'");
  }
  tx(fn){this.db.exec("BEGIN IMMEDIATE");try{const result=fn();this.db.exec("COMMIT");return result;}catch(error){this.db.exec("ROLLBACK");throw error;}}
  settings(guildId){const row=this.db.prepare("SELECT * FROM lumiya_settings WHERE guildId=?").get(guildId);return {...(row?JSON.parse(row.data):{}),version:row?.version||0};}
  saveSettings(guildId,data,version,userId){
    return this.tx(()=>{
      const current=this.settings(guildId);if(current.version!==version)fail("As configurações mudaram. Atualize a central antes de salvar.");
      const next={...data};delete next.version;
      this.db.prepare("INSERT INTO lumiya_settings VALUES(?,?,?) ON CONFLICT(guildId) DO UPDATE SET data=excluded.data,version=excluded.version").run(guildId,JSON.stringify(next),version+1);
      this.audit(guildId,userId,"settings.saved",null,current,next);return {...next,version:version+1};
    });
  }
  panel(guildId,panelId){const row=this.db.prepare("SELECT * FROM lumiya_panels WHERE guildId=? AND panelId=?").get(guildId,panelId);return {data:row?JSON.parse(row.data):{},version:row?.version||0,updatedAt:row?.updatedAt,updatedBy:row?.updatedBy};}
  draft(guildId,userId,panelId){
    const row=this.db.prepare("SELECT * FROM lumiya_drafts WHERE guildId=? AND userId=? AND panelId=? ORDER BY updatedAt DESC LIMIT 1").get(guildId,userId,panelId);
    if(row)return {...row,data:JSON.parse(row.data)};
    const current=this.panel(guildId,panelId),id=randomUUID(),now=Date.now();
    this.db.prepare("INSERT INTO lumiya_drafts VALUES(?,?,?,?,?,?,0,?)").run(id,guildId,userId,panelId,JSON.stringify(current.data),current.version,now);
    return {id,guildId,userId,panelId,data:clone(current.data),baseVersion:current.version,revision:0,updatedAt:now};
  }
  getDraft(id,guildId,userId){
    const row=this.db.prepare("SELECT * FROM lumiya_drafts WHERE id=? AND guildId=? AND userId=?").get(id,guildId,userId);
    if(!row)fail("Rascunho indisponível. Abra novamente o editor.");
    return {...row,data:JSON.parse(row.data)};
  }
  editDraft(draft,data){
    const result=this.db.prepare("UPDATE lumiya_drafts SET data=?,revision=revision+1,updatedAt=? WHERE id=? AND guildId=? AND userId=? AND revision=?")
      .run(JSON.stringify(data),Date.now(),draft.id,draft.guildId,draft.userId,draft.revision);
    if(!result.changes)fail("O rascunho mudou em outra interação. Abra novamente o editor.");
    return this.getDraft(draft.id,draft.guildId,draft.userId);
  }
  discard(draft){this.db.prepare("DELETE FROM lumiya_drafts WHERE id=? AND guildId=? AND userId=?").run(draft.id,draft.guildId,draft.userId);}
  save(draft){
    return this.tx(()=>{
      const fresh=this.getDraft(draft.id,draft.guildId,draft.userId),current=this.panel(draft.guildId,draft.panelId);
      if(fresh.revision!==draft.revision||current.version!==draft.baseVersion)
        fail("Outro administrador salvou este painel. Descarte o rascunho e reabra para usar a versão atual.");
      const now=Date.now();
      this.db.prepare("INSERT INTO lumiya_panels VALUES(?,?,?,?,?,?) ON CONFLICT(guildId,panelId) DO UPDATE SET data=excluded.data,version=excluded.version,updatedAt=excluded.updatedAt,updatedBy=excluded.updatedBy")
        .run(draft.guildId,draft.panelId,JSON.stringify(draft.data),current.version+1,now,draft.userId);
      this.db.prepare("UPDATE lumiya_drafts SET baseVersion=?,revision=revision+1,updatedAt=? WHERE id=?").run(current.version+1,now,draft.id);
      this.audit(draft.guildId,draft.userId,"panel.saved",draft.panelId,current.data,draft.data);
      return this.getDraft(draft.id,draft.guildId,draft.userId);
    });
  }
  audit(guildId,userId,action,panelId=null,before=null,after=null){
    this.db.prepare("INSERT INTO lumiya_audit(guildId,userId,action,panelId,beforeData,afterData,createdAt) VALUES(?,?,?,?,?,?,?)")
      .run(guildId,userId,action,panelId,before===null?null:JSON.stringify(before),after===null?null:JSON.stringify(after),Date.now());
  }
  history(guildId,panelId){return this.db.prepare("SELECT userId,action,createdAt FROM lumiya_audit WHERE guildId=? AND panelId=? ORDER BY id DESC LIMIT 10").all(guildId,panelId);}
  session(guildId,userId,data={}){
    this.db.prepare("DELETE FROM lumiya_sessions WHERE expiresAt<?").run(Date.now());
    const id=randomUUID(),expiresAt=Date.now()+30*60_000;
    this.db.prepare("INSERT INTO lumiya_sessions VALUES(?,?,?,?,0,?)").run(id,guildId,userId,JSON.stringify(data),expiresAt);
    return {id,guildId,userId,data,revision:0,expiresAt};
  }
  getSession(id,guildId,userId,revision){
    const row=this.db.prepare("SELECT * FROM lumiya_sessions WHERE id=? AND guildId=? AND userId=? AND expiresAt>?").get(id,guildId,userId,Date.now());
    if(!row)fail("Este painel expirou ou pertence a outra pessoa. Use /config para continuar.");
    if(revision!==undefined&&row.revision!==Number(revision))fail("Esta tela já mudou. Use os controles da mensagem atual ou abra /config.");
    return {...row,data:JSON.parse(row.data)};
  }
  updateSession(session,data){
    const result=this.db.prepare("UPDATE lumiya_sessions SET data=?,revision=revision+1,expiresAt=? WHERE id=? AND revision=?")
      .run(JSON.stringify(data),Date.now()+30*60_000,session.id,session.revision);
    if(!result.changes)fail("Outra interação atualizou esta tela. Abra /config novamente.");
    return this.getSession(session.id,session.guildId,session.userId);
  }
  asset(guildId,id){return this.db.prepare("SELECT * FROM lumiya_assets WHERE id=? AND guildId=?").get(id,guildId);}
  addAsset(guildId,userId,image){
    return this.tx(()=>{
    const used=this.db.prepare("SELECT COALESCE(SUM(length(bytes)),0) total FROM lumiya_assets WHERE guildId=?").get(guildId).total;
    if(used+image.bytes.length>30*1024*1024)fail("Este servidor atingiu 30 MB de imagens personalizadas.");
    const id=randomUUID();
    this.db.prepare("INSERT INTO lumiya_assets VALUES(?,?,?,?,?,?,?)").run(id,guildId,image.bytes,image.mime,image.hash,Date.now(),userId);
    this.audit(guildId,userId,"image.stored",null,null,{id,bytes:image.bytes.length});
    return id;
    });
  }
  pruneAssets(guildId,userId){
    const references=[
      ...this.db.prepare("SELECT data FROM lumiya_panels WHERE guildId=?").all(guildId),
      ...this.db.prepare("SELECT data FROM lumiya_drafts WHERE guildId=?").all(guildId)
    ].map(row=>row.data).join("\n");
    let deleted=0;
    for(const row of this.db.prepare("SELECT id FROM lumiya_assets WHERE guildId=?").all(guildId)){
      if(!references.includes(row.id)){this.db.prepare("DELETE FROM lumiya_assets WHERE id=? AND guildId=?").run(row.id,guildId);deleted++;}
    }
    this.audit(guildId,userId,"images.pruned",null,null,{deleted});return deleted;
  }
  record(guildId,panelId,channelId,messageId,userId=null,status="published"){
    const existing=messageId&&this.db.prepare("SELECT id FROM lumiya_publications WHERE guildId=? AND channelId=? AND messageId=?").get(guildId,channelId,messageId);
    if(existing){this.db.prepare("UPDATE lumiya_publications SET panelId=?,status=?,updatedAt=? WHERE id=?").run(panelId,status,Date.now(),existing.id);return existing.id;}
    const id=randomUUID(),now=Date.now();
    this.db.prepare("INSERT INTO lumiya_publications(id,guildId,panelId,channelId,messageId,status,createdAt,updatedAt,createdBy) VALUES(?,?,?,?,?,?,?,?,?)").run(id,guildId,panelId,channelId,messageId,status,now,now,userId);
    return id;
  }
  publications(guildId,panelId){return panelId?this.db.prepare("SELECT * FROM lumiya_publications WHERE guildId=? AND panelId=? ORDER BY createdAt DESC").all(guildId,panelId):this.db.prepare("SELECT * FROM lumiya_publications WHERE guildId=? ORDER BY createdAt DESC").all(guildId);}
  publication(guildId,id){const row=this.db.prepare("SELECT * FROM lumiya_publications WHERE guildId=? AND id=?").get(guildId,id);if(!row)fail("Publicação de outro servidor ou indisponível.");return row;}
  publicationStatus(id,status){this.db.prepare("UPDATE lumiya_publications SET status=?,updatedAt=? WHERE id=?").run(status,Date.now(),id);}
  accessRows(guildId){return this.db.prepare("SELECT * FROM lumiya_access WHERE guildId=? ORDER BY createdAt DESC").all(guildId);}
  accessRow(guildId,type,id){return this.db.prepare("SELECT * FROM lumiya_access WHERE guildId=? AND subjectType=? AND subjectId=?").get(guildId,type,id);}
  saveAccess(row){this.db.prepare(`INSERT INTO lumiya_access(guildId,subjectType,subjectId,level,permissions,expiresAt,grantedBy,reason,createdAt,expiredLogged)
    VALUES(?,?,?,?,?,?,?,?,?,0) ON CONFLICT(guildId,subjectType,subjectId) DO UPDATE SET
    level=excluded.level,permissions=excluded.permissions,expiresAt=excluded.expiresAt,grantedBy=excluded.grantedBy,
    reason=excluded.reason,createdAt=excluded.createdAt,expiredLogged=0`).run(row.guildId,row.subjectType,row.subjectId,row.level,JSON.stringify(row.permissions),row.expiresAt??null,row.grantedBy,row.reason??null,row.createdAt);}
  deleteAccess(guildId,type,id){this.db.prepare("DELETE FROM lumiya_access WHERE guildId=? AND subjectType=? AND subjectId=?").run(guildId,type,id);}
  markExpired(guildId,type,id){this.db.prepare("UPDATE lumiya_access SET expiredLogged=1 WHERE guildId=? AND subjectType=? AND subjectId=?").run(guildId,type,id);}
  accessHistory(guildId,limit=100){return this.db.prepare("SELECT * FROM lumiya_access_history WHERE guildId=? ORDER BY id DESC LIMIT ?").all(guildId,limit);}
  addAccessHistory(row){this.db.prepare(`INSERT INTO lumiya_access_history(guildId,actorId,subjectType,subjectId,action,beforeData,afterData,reason,createdAt)
    VALUES(?,?,?,?,?,?,?,?,?)`).run(row.guildId,row.actorId,row.subjectType,row.subjectId,row.action,
    row.beforeData===null?null:JSON.stringify(row.beforeData),row.afterData===null?null:JSON.stringify(row.afterData),row.reason??null,row.createdAt);}
  accessMigrated(guildId){return Boolean(this.db.prepare("SELECT migrated FROM lumiya_access_meta WHERE guildId=?").get(guildId)?.migrated);}
  markAccessMigrated(guildId){this.db.prepare("INSERT INTO lumiya_access_meta VALUES(?,1) ON CONFLICT(guildId) DO UPDATE SET migrated=1").run(guildId);}
  invalidateSessions(guildId,exceptUserId=null){
    const query=exceptUserId?"DELETE FROM lumiya_sessions WHERE guildId=? AND userId<>?":"DELETE FROM lumiya_sessions WHERE guildId=?";
    return exceptUserId?this.db.prepare(query).run(guildId,exceptUserId).changes:this.db.prepare(query).run(guildId).changes;
  }
}
module.exports={ConfigStore};
