const DEFAULT_RULES={protectServer:true,childProtection:true,nazism:true,extremism:true,sexual:true,graphicViolence:true,violence:false,selfHarm:false,illicit:false,hate:true,targetedHarassment:true,scams:true,personalData:true,allowGameWeapons:true,ambiguousReview:true};
const RULE_VERSION="mds-media-rules-v7-video-coverage";
const {DEFAULT_MODEL}=require("./openai");
function createStore(db){
  db.exec(`
    CREATE TABLE IF NOT EXISTS media_moderation_settings(guildId TEXT PRIMARY KEY,enabled INTEGER NOT NULL DEFAULT 0,settings TEXT NOT NULL,updatedAt INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS media_moderation_channels(guildId TEXT NOT NULL,channelId TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('channel','category','exclude')),PRIMARY KEY(guildId,channelId,kind));
    CREATE TABLE IF NOT EXISTS media_moderation_cases(id TEXT PRIMARY KEY,guildId TEXT NOT NULL,channelId TEXT NOT NULL,authorId TEXT NOT NULL,originalMessageId TEXT NOT NULL,mediaType TEXT NOT NULL,createdAt INTEGER NOT NULL,status TEXT NOT NULL,decision TEXT,reason TEXT,categories TEXT NOT NULL DEFAULT '[]',model TEXT,rulesVersion TEXT NOT NULL,reviewerId TEXT,repostedMessageId TEXT,filePath TEXT,filename TEXT,mimeType TEXT,caption TEXT,sha256 TEXT,requestId TEXT);
    CREATE INDEX IF NOT EXISTS media_cases_queue ON media_moderation_cases(guildId,status,createdAt);
    CREATE TABLE IF NOT EXISTS media_moderation_budget(guildId TEXT NOT NULL,day TEXT NOT NULL,requests INTEGER NOT NULL DEFAULT 0,estimatedCost REAL NOT NULL DEFAULT 0,PRIMARY KEY(guildId,day));
    CREATE TABLE IF NOT EXISTS media_moderation_hashes(guildId TEXT NOT NULL,sha256 TEXT NOT NULL,decision TEXT NOT NULL,rulesVersion TEXT NOT NULL,createdAt INTEGER NOT NULL,PRIMARY KEY(guildId,sha256,rulesVersion));
  `);
  const columns=new Set(db.prepare("PRAGMA table_info(media_moderation_cases)").all().map(r=>r.name));
  if(!columns.has("replyMessageId"))db.exec("ALTER TABLE media_moderation_cases ADD COLUMN replyMessageId TEXT");
  for(const [name,type] of Object.entries({provider:"TEXT",analysisMs:"INTEGER",analysisData:"TEXT",errorKind:"TEXT",reviewerGuildId:"TEXT",deletedAt:"INTEGER",deletedById:"TEXT",externalReviewRequested:"INTEGER NOT NULL DEFAULT 0",inspectionMode:"TEXT NOT NULL DEFAULT 'full'",enforcementData:"TEXT"}))if(!columns.has(name))db.exec(`ALTER TABLE media_moderation_cases ADD COLUMN ${name} ${type}`);
  const getSettings=db.prepare("SELECT * FROM media_moderation_settings WHERE guildId=?");
  function settings(guildId){const row=getSettings.get(guildId);const settings=row?{...JSON.parse(row.settings),enabled:Boolean(row.enabled)}:{enabled:process.env.MEDIA_MODERATION_ENABLED==="true",rules:{...DEFAULT_RULES},channels:[],categories:[],excluded:[],reviewRoleIds:[],maxFileMB:Number(process.env.MEDIA_MODERATION_MAX_FILE_MB)||20,maxVideoSeconds:Number(process.env.MEDIA_MODERATION_MAX_VIDEO_SECONDS)||120,dailyBudgetUSD:Number(process.env.MEDIA_MODERATION_DAILY_BUDGET_USD)||5,retentionHours:Number(process.env.MEDIA_MODERATION_RETENTION_HOURS)||24};return {logChannelId:null,...settings,superficialChannelIds:Array.isArray(settings.superficialChannelIds)?settings.superficialChannelIds:[],rules:{...DEFAULT_RULES,...settings.rules},visionModel:process.env.OPENAI_MODERATION_MODEL?.trim()||DEFAULT_MODEL};}
  function saveSettings(guildId,value){const {enabled,...rest}=value;db.prepare(`INSERT INTO media_moderation_settings(guildId,enabled,settings,updatedAt) VALUES(?,?,?,?) ON CONFLICT(guildId) DO UPDATE SET enabled=excluded.enabled,settings=excluded.settings,updatedAt=excluded.updatedAt`).run(guildId,enabled?1:0,JSON.stringify(rest),Date.now());}
  function channels(guildId){return db.prepare("SELECT channelId,kind FROM media_moderation_channels WHERE guildId=?").all(guildId);}
  function setChannel(guildId,channelId,kind,on){if(on)db.prepare("INSERT OR IGNORE INTO media_moderation_channels VALUES(?,?,?)").run(guildId,channelId,kind);else db.prepare("DELETE FROM media_moderation_channels WHERE guildId=? AND channelId=? AND kind=?").run(guildId,channelId,kind);}
  return {db,settings,saveSettings,channels,setChannel,DEFAULT_RULES,RULE_VERSION};
}
module.exports={createStore,DEFAULT_RULES,RULE_VERSION};
