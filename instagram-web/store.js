const {randomUUID,createHash}=require("node:crypto");
const {settingsSchema}=require("./config");
module.exports=function store(db,cfg){
  db.exec(`CREATE TABLE IF NOT EXISTS iw_migrations(version INTEGER PRIMARY KEY,appliedAt INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS iw_users(id TEXT PRIMARY KEY,profile TEXT NOT NULL,preferences TEXT NOT NULL DEFAULT '{}',updatedAt INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS iw_sessions(hash TEXT PRIMARY KEY,userId TEXT NOT NULL,csrf TEXT NOT NULL,createdAt INTEGER NOT NULL,expiresAt INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS iw_native_tickets(hash TEXT PRIMARY KEY,userId TEXT NOT NULL,expiresAt INTEGER NOT NULL,usedAt INTEGER);
    CREATE INDEX IF NOT EXISTS iw_session_user ON iw_sessions(userId);
    CREATE TABLE IF NOT EXISTS iw_settings(guildId TEXT PRIMARY KEY,value TEXT NOT NULL,version INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS iw_publications(id TEXT PRIMARY KEY,guildId TEXT NOT NULL,userId TEXT NOT NULL,
      state TEXT NOT NULL,caption TEXT NOT NULL,handle TEXT,createdAt INTEGER NOT NULL,updatedAt INTEGER NOT NULL,
      messageId TEXT,channelId TEXT,attempts INTEGER NOT NULL DEFAULT 0,nextAt INTEGER NOT NULL DEFAULT 0,
      approval TEXT,error TEXT,requestKey TEXT NOT NULL,operation TEXT NOT NULL DEFAULT 'publish',
      UNIQUE(guildId,userId,requestKey));
    CREATE INDEX IF NOT EXISTS iw_pub_user ON iw_publications(guildId,userId,createdAt);
    CREATE INDEX IF NOT EXISTS iw_pub_queue ON iw_publications(state,nextAt);
    CREATE TABLE IF NOT EXISTS iw_images(id TEXT PRIMARY KEY,publicationId TEXT NOT NULL,position INTEGER NOT NULL,
      filename TEXT NOT NULL,hash TEXT NOT NULL,bytes INTEGER NOT NULL,width INTEGER NOT NULL,height INTEGER NOT NULL,
      UNIQUE(publicationId,position));
    CREATE TABLE IF NOT EXISTS iw_moderation(id TEXT PRIMARY KEY,publicationId TEXT NOT NULL,createdAt INTEGER NOT NULL,policy TEXT NOT NULL,result TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS iw_moderation_pub ON iw_moderation(publicationId);
    CREATE TABLE IF NOT EXISTS iw_restrictions(userId TEXT PRIMARY KEY,untilAt INTEGER NOT NULL,reason TEXT NOT NULL,dailyLimit INTEGER);
    CREATE TABLE IF NOT EXISTS iw_reports(id TEXT PRIMARY KEY,publicationId TEXT NOT NULL,userId TEXT NOT NULL,reason TEXT NOT NULL,
      createdAt INTEGER NOT NULL,state TEXT NOT NULL DEFAULT 'open',reviewerId TEXT,UNIQUE(publicationId,userId));
    CREATE TABLE IF NOT EXISTS iw_reviews(publicationId TEXT PRIMARY KEY,userId TEXT NOT NULL,reason TEXT NOT NULL,createdAt INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS iw_notifications(id TEXT PRIMARY KEY,userId TEXT NOT NULL,publicationId TEXT,content TEXT NOT NULL,createdAt INTEGER NOT NULL,readAt INTEGER);
    CREATE INDEX IF NOT EXISTS iw_notify_user ON iw_notifications(userId,createdAt);
    CREATE TABLE IF NOT EXISTS iw_audit(id TEXT PRIMARY KEY,actorId TEXT,action TEXT NOT NULL,resourceId TEXT,
      reason TEXT,details TEXT,createdAt INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS iw_events(id INTEGER PRIMARY KEY,kind TEXT NOT NULL,publicationId TEXT,durationMs INTEGER,createdAt INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS iw_log_deliveries(auditId TEXT PRIMARY KEY);
    INSERT OR IGNORE INTO iw_migrations VALUES(1,${Date.now()});`);
  const primary=cfg.defaultGuildId||cfg.guildId;
  // Keep the legacy primary-server restriction table compatible with existing tooling.
  db.exec(`CREATE TABLE IF NOT EXISTS iw_server_restrictions(guildId TEXT NOT NULL,userId TEXT NOT NULL,untilAt INTEGER NOT NULL,reason TEXT NOT NULL,dailyLimit INTEGER,PRIMARY KEY(guildId,userId));
    CREATE TABLE IF NOT EXISTS iw_user_guilds(guildId TEXT NOT NULL,userId TEXT NOT NULL,PRIMARY KEY(guildId,userId));`);
  for(const table of ["iw_audit","iw_notifications"]){
    if(!db.prepare(`PRAGMA table_info(${table})`).all().some(c=>c.name==="guildId"))
      db.exec(`ALTER TABLE ${table} ADD COLUMN guildId TEXT NOT NULL DEFAULT '${primary}'`);
  }
  const imageColumns=new Set(db.prepare("PRAGMA table_info(iw_images)").all().map(c=>c.name));
  if(!imageColumns.has("kind"))db.exec("ALTER TABLE iw_images ADD COLUMN kind TEXT NOT NULL DEFAULT 'image'");
  if(!imageColumns.has("mime"))db.exec("ALTER TABLE iw_images ADD COLUMN mime TEXT NOT NULL DEFAULT 'image/jpeg'");
  if(!imageColumns.has("duration"))db.exec("ALTER TABLE iw_images ADD COLUMN duration INTEGER NOT NULL DEFAULT 0");
  if(!db.prepare("SELECT 1 FROM iw_migrations WHERE version=2").get()){
    db.prepare("INSERT OR IGNORE INTO iw_user_guilds SELECT ?,id FROM iw_users").run(primary);
    db.prepare("INSERT INTO iw_migrations VALUES(2,?)").run(Date.now());
  }
  const json=x=>JSON.stringify(x);
  const read=x=>x?JSON.parse(x):null;
  function settings(guildId=cfg.guildId,{allowUnconfigured=false}={}){
    const row=db.prepare("SELECT value FROM iw_settings WHERE guildId=?").get(guildId);
    if(row)return settingsSchema.parse(read(row.value));
    const isPrimary=guildId===primary;
    const channel=db.prepare("SELECT channelId FROM instagram_settings WHERE guildId=?").get(guildId)?.channelId||(isPrimary?cfg.initialChannel:undefined);
    const defaults={logChannelId:isPrimary?cfg.initialLog:null,name:"Comunidade",invite:isPrimary?cfg.invite:""};
    if(allowUnconfigured&&!channel)return {...settingsSchema.omit({channelId:true}).parse(defaults),channelId:""};
    return settingsSchema.parse({...defaults,channelId:channel});
  }
  function audit(actor,action,resource=null,reason=null,details=null,guildId=cfg.guildId){
    db.prepare("INSERT INTO iw_audit(id,actorId,action,resourceId,reason,details,createdAt,guildId) VALUES(?,?,?,?,?,?,?,?)").run(randomUUID(),actor,action,resource,reason,details?json(details):null,Date.now(),guildId);
  }
  function transaction(fn){db.exec("BEGIN IMMEDIATE");try{const r=fn();db.exec("COMMIT");return r;}catch(e){db.exec("ROLLBACK");throw e;}}
  const publication=id=>db.prepare("SELECT * FROM iw_publications WHERE id=? AND guildId=?").get(id,cfg.guildId);
  const images=id=>db.prepare("SELECT * FROM iw_images WHERE publicationId=? ORDER BY position").all(id);
  function notify(userId,publicationId,content,guildId=cfg.guildId){
    const prefs=db.prepare("SELECT preferences FROM iw_users WHERE id=?").get(userId);
    if(prefs&&read(prefs.preferences)?.notifications===false)return;
    db.prepare("INSERT INTO iw_notifications(id,userId,publicationId,content,createdAt,readAt,guildId) VALUES(?,?,?,?,?,NULL,?)").run(randomUUID(),userId,publicationId,content,Date.now(),guildId);
  }
  function state(p,value,error=null){
    db.prepare("UPDATE iw_publications SET state=?,error=?,updatedAt=? WHERE id=?").run(value,error,Date.now(),p.id);
    audit(p.userId,`publication.${value}`,p.id,null,null,p.guildId);
    if(["published","rejected","review","deleted","failed","uncertain"].includes(value))notify(p.userId,p.id,{
      published:"Sua fotografia foi publicada.",rejected:"A publicação não atende às diretrizes.",
      review:"Sua publicação aguarda revisão.",deleted:"A publicação foi removida.",
      failed:"Não foi possível concluir o processamento.",uncertain:"Entrega em verificação. Não reenvie a publicação."
    }[value],p.guildId);
  }
  return {db,settings,audit,transaction,publication,images,state,notify,
    touchMember(userId){db.prepare("INSERT OR IGNORE INTO iw_user_guilds VALUES(?,?)").run(cfg.guildId,userId);},
    restriction(userId){
      return cfg.guildId===primary?db.prepare("SELECT * FROM iw_restrictions WHERE userId=?").get(userId):
        db.prepare("SELECT * FROM iw_server_restrictions WHERE guildId=? AND userId=?").get(cfg.guildId,userId);
    },
    setRestriction(userId,untilAt,reason,dailyLimit){
      if(cfg.guildId===primary)db.prepare("INSERT OR REPLACE INTO iw_restrictions VALUES(?,?,?,?)").run(userId,untilAt,reason,dailyLimit);
      else db.prepare("INSERT OR REPLACE INTO iw_server_restrictions VALUES(?,?,?,?,?)").run(cfg.guildId,userId,untilAt,reason,dailyLimit);
    },
    clearRestriction(userId){
      if(cfg.guildId===primary)db.prepare("DELETE FROM iw_restrictions WHERE userId=?").run(userId);
      else db.prepare("DELETE FROM iw_server_restrictions WHERE guildId=? AND userId=?").run(cfg.guildId,userId);
    },
    saveSettings(s,actor,guildId=cfg.guildId){const prev=settings(guildId,{allowUnconfigured:true});const next=settingsSchema.parse(s);
      db.prepare("INSERT INTO iw_settings VALUES(?,?,1) ON CONFLICT(guildId) DO UPDATE SET value=excluded.value,version=version+1").run(guildId,json(next));
      audit(actor,"settings.changed",guildId,null,{before:prev,after:next},guildId);return next;},
    event(kind,pid=null,duration=null){db.prepare("INSERT INTO iw_events(kind,publicationId,durationMs,createdAt) VALUES(?,?,?,?)").run(kind,pid,duration,Date.now());},
    profile(id){const u=db.prepare("SELECT * FROM iw_users WHERE id=?").get(id);return u?{...read(u.profile),preferences:read(u.preferences)}:null;},
    hash:value=>createHash("sha256").update(value).digest("hex")};
};
