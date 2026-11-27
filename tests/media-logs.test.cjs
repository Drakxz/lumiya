const test=require("node:test");
const assert=require("node:assert/strict");
const {DatabaseSync}=require("node:sqlite");
const {EventEmitter}=require("node:events");
const {randomUUID}=require("node:crypto");
const d=require("discord.js");
const {createStore}=require("../media-moderation/store");
const {buildMediaLog,createMediaLogger}=require("../media-moderation/logs");
const install=require("../media-moderation");
const LOG_ID="100000000000000010";
const logJSON=payload=>JSON.stringify(payload.embeds.map(c=>c.toJSON()));

function fixture(t){
  const db=new DatabaseSync(":memory:"),store=createStore(db),client=new EventEmitter(),sent=[],preserved=[];
  const channel={id:LOG_ID,guildId:"g",type:d.ChannelType.GuildText,isTextBased:()=>true,
    guild:{iconURL:()=>"https://cdn.discordapp.com/embed/avatars/0.png"},
    permissionsFor:()=>new d.PermissionsBitField([d.PermissionFlagsBits.ViewChannel,d.PermissionFlagsBits.SendMessages]),
    async send(payload){const message={id:randomUUID()};sent.push({payload,message});return message;}};
  client.channels={async fetch(){return channel;}};
  const registry={register(){},preserveMessage(message){preserved.push(message.id);}};
  const logger=createMediaLogger({client,registry,store});
  function insert(status="review"){
    const id=randomUUID();db.prepare("INSERT INTO media_moderation_cases(id,guildId,channelId,authorId,originalMessageId,mediaType,createdAt,status,rulesVersion,reason) VALUES(?,?,?,?,?,?,?,?,?,?)")
      .run(id,"g","origin","author","original","image/png",Date.now(),status,store.RULE_VERSION,"Análise incompleta ou falha técnica; revisão necessária.");return id;
  }
  t.after(()=>db.close());return {db,store,client,registry,logger,sent,preserved,channel,insert};
}

test("sensitivity log matches reference structure without exposing captions, files or AI prose",()=>{
  const row={id:"case-id",authorId:"123",channelId:"456",status:"review",model:null,reason:"Análise incompleta",caption:"SECRET-CAPTION",filePath:"SECRET-PATH"};
  const payload=buildMediaLog(row,{avatarURL:"https://cdn.discordapp.com/embed/avatars/0.png",now:Date.UTC(2026,10,12,15,30,0)});
  const json=logJSON(payload);
  assert.match(json,/Proteção de Sensibilidade/);assert.match(json,/Executor/);assert.match(json,/Estado da Mídia/);assert.match(json,/ERRO_TECNICO/);assert.match(json,/12\/11\/2026/);assert.match(json,/12:30:00/);
  assert.match(json,/Lumiya/);assert.equal(payload.embeds[0].toJSON().thumbnail.url,"https://cdn.discordapp.com/embed/avatars/0.png");assert.doesNotMatch(json,/SECRET|SECRET-CAPTION|SECRET-PATH/);
  assert.ok(json.includes("<a:1175261181741641789:1569933923641983038>"));
  assert.doesNotMatch(json,/👤|❗/);
  assert.equal(payload.files,undefined);assert.equal(payload.flags,undefined);assert.equal(payload.components,undefined);assert.deepEqual(payload.allowedMentions,{parse:[]});
  const safety=logJSON(buildMediaLog({...row,reason:"Sinalização de segurança infantil; não enviado à API"}));assert.doesNotMatch(safety,/ERRO_TECNICO/);
});
test("video log distinguishes visual sampling from disabled audio without exposing analysis content",()=>{
  const p=buildMediaLog({id:"case",authorId:"user",channelId:"channel",status:"approved",provider:"OpenAI",model:"omni-moderation-latest",categories:"[]",analysisMs:20,
    analysisData:JSON.stringify({coverage:{method:"uniform-scenes-end",audio:"disabled",frames:4,sampledFrames:25},rawResults:[{text:"SECRET-CONTENT"}]})});
  const json=logJSON(p);assert.match(json,/4 quadros únicos/);assert.match(json,/não analisado \(desativado\)/);assert.doesNotMatch(json,/SECRET/);
});

test("logging is opt-in, durable, deduplicated, and exempts messages from cleanup",async t=>{
  const f=fixture(t),id=f.insert();await f.logger.logCase(id);assert.equal(f.sent.length,0);
  const s=f.store.settings("g");s.logChannelId=LOG_ID;f.store.saveSettings("g",s);
  await Promise.all([f.logger.logCase(id),f.logger.logCase(id)]);assert.equal(f.sent.length,1);assert.deepEqual(f.preserved,[f.sent[0].message.id]);
  await createMediaLogger(f).logCase(id);assert.equal(f.sent.length,1,"restart does not duplicate delivery");
  f.db.prepare("UPDATE media_moderation_cases SET status='blocked',reviewerId='moderator' WHERE id=?").run(id);await f.logger.logCase(id);
  assert.equal(f.sent.length,2);assert.match(logJSON(f.sent[1].payload),/BLOQUEADA/);assert.match(logJSON(f.sent[1].payload),/moderator/);
  f.db.prepare("UPDATE media_moderation_cases SET status='approved',reviewerId=NULL WHERE id=?").run(id);await f.logger.logCase(id);
  assert.equal(f.sent.length,3);const approved=logJSON(f.sent[2].payload);
  assert.match(approved,/Icon_Access_Approve:1569949091880902747/);assert.match(approved,/APROVADA/);
});

test("missing, foreign or inaccessible log channels never change moderation decisions",async t=>{
  const f=fixture(t),id=f.insert("approved"),s=f.store.settings("g");s.logChannelId=LOG_ID;f.store.saveSettings("g",s);
  f.channel.guildId="other";await f.logger.logCase(id);assert.equal(f.sent.length,0);
  f.channel.guildId="g";f.channel.send=async()=>{throw new Error("secret provider detail");};await f.logger.logCase(id);
  assert.equal(f.db.prepare("SELECT status FROM media_moderation_cases WHERE id=?").get(id).status,"approved");
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM media_moderation_log_events").get().n,0);
});

test("settings select validates guild, permissions and admin access and persists/removes log channel",async t=>{
  const f=fixture(t),system=install(f),updates=[],errors=[];
  function interaction(customId,admin=true){return {customId,guildId:"g",guild:{members:{me:{id:"bot"}}},member:{permissions:{has:()=>admin}},
    user:{id:"admin"},values:[LOG_ID],inGuild:()=>true,isChannelSelectMenu:()=>true,
    async deferUpdate(){this.deferred=true;},async editReply(p){updates.push(p);},async update(p){updates.push(p);},async reply(p){errors.push(p);},async followUp(p){errors.push(p);}};}
  await system.onInteraction(interaction("mds-media-admin:settings"));
  assert.match(JSON.stringify(updates.at(-1).components[0].toJSON()),/mds-media-log-channel/);
  await system.onInteraction(interaction("mds-media-log-channel",false));assert.equal(f.store.settings("g").logChannelId,null);
  f.channel.guildId="other";await system.onInteraction(interaction("mds-media-log-channel"));assert.equal(f.store.settings("g").logChannelId,null);
  f.channel.guildId="g";const permissions=f.channel.permissionsFor;f.channel.permissionsFor=()=>new d.PermissionsBitField();
  await system.onInteraction(interaction("mds-media-log-channel"));assert.equal(f.store.settings("g").logChannelId,null);
  f.channel.permissionsFor=permissions;await system.onInteraction(interaction("mds-media-log-channel"));assert.equal(createStore(f.db).settings("g").logChannelId,LOG_ID);
  assert.equal(errors.length,3);await system.onInteraction(interaction("mds-media-log-disable"));assert.equal(f.store.settings("g").logChannelId,null);
});

test("a real intake capture failure emits a permanent technical-error log",async t=>{
  const f=fixture(t),system=install(f),s=f.store.settings("g");s.enabled=true;s.logChannelId=LOG_ID;f.store.saveSettings("g",s);f.store.setChannel("g","origin","channel",true);
  const previous=global.fetch;global.fetch=async()=>new Response(null,{status:404});t.after(()=>{global.fetch=previous;});
  await system.onMessage({id:randomUUID(),guild:{id:"g"},guildId:"g",channelId:"origin",author:{id:"author"},content:"",attachments:new Map([["a",{name:"photo.png",size:10,url:"https://cdn.discordapp.com/attachments/test.png"}]]),async delete(){}});
  assert.equal(f.sent.length,1);assert.equal(f.preserved.length,1);assert.match(logJSON(f.sent[0].payload),/ERRO_TECNICO/);
});

test("Instagram server logs only actual Instagram publications, not blocked, pending or ordinary approved media",async t=>{
  const f=fixture(t),gid=require("../server-logs/policy").INSTAGRAM_GUILD_ID;
  f.channel.guildId=gid;
  f.store.saveSettings(gid,{...f.store.settings(gid),logChannelId:LOG_ID});
  f.db.exec("CREATE TABLE instagram_posts(guildId TEXT,channelId TEXT,messageId TEXT,authorId TEXT)");
  const cases=[];
  for(const status of ["review","blocked","approved","approved"]){
    const id=f.insert(status);
    f.db.prepare("UPDATE media_moderation_cases SET guildId=?,repostedMessageId=? WHERE id=?").run(gid,status==="approved"?`posted-${id}`:null,id);
    cases.push(id);
  }
  for(const id of cases)await f.logger.logCase(id);
  assert.equal(f.sent.length,0);
  const id=cases.at(-1);
  f.db.prepare("INSERT INTO instagram_posts VALUES('main-server','instagram-feed',?,'author')").run(`posted-${id}`);
  await f.logger.logCase(id);
  await f.logger.logCase(id);
  assert.equal(f.sent.length,1);
  const json=logJSON(f.sent[0].payload);
  assert.match(json,/Instagram · publicação/);
  assert.match(json,/discord.com\/channels\/main-server\/instagram-feed\/posted-/);
  assert.equal(f.sent[0].payload.files,undefined);
  assert.deepEqual(f.sent[0].payload.allowedMentions,{parse:[]});
});
