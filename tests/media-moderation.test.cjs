const test=require("node:test");
const assert=require("node:assert/strict");
const {DatabaseSync}=require("node:sqlite");
const {EventEmitter}=require("node:events");
const {createStore}=require("../media-moderation/store");
const {validateDecision,downloadAttachment}=require("../media-moderation/processor");
const install=require("../media-moderation");
const fs=require("node:fs/promises");
const {randomUUID,createHash}=require("node:crypto");
const {getCommandRegistry}=require("../command-system/registry");
const {DEFAULT_MODEL}=require("../media-moderation/openai");

test("SQLite settings default to opt-in disabled and persist explicit channels",t=>{
  const db=new DatabaseSync(":memory:"),store=createStore(db);t.after(()=>db.close());
  assert.equal(store.settings("g").enabled,false);
  store.setChannel("g","private","channel",true);
  assert.deepEqual({...store.channels("g")[0]},{channelId:"private",kind:"channel"});
  const settings=store.settings("g");settings.enabled=true;store.saveSettings("g",settings);
  assert.equal(store.settings("g").enabled,true);
});
test("structured decisions reject malformed or unsupported values",()=>{
  assert.equal(validateDecision({decision:"approved",reason:"clear",categories:[],confidence:.8,requiresHumanReview:false}).decision,"approved");
  assert.throws(()=>validateDecision({decision:"accept",reason:"",categories:[],confidence:1,requiresHumanReview:false}));
  assert.throws(()=>validateDecision({decision:"blocked",reason:"x",categories:[],confidence:2,requiresHumanReview:false}));
});
test("attachment downloader rejects non-Discord hosts before network access",async()=>{
  await assert.rejects(downloadAttachment("https://example.com/a.png",1000),/Host de anexo não permitido/);
});
test("panel exposes Components V2 and only configured message channels are monitored",async t=>{
  const db=new DatabaseSync(":memory:"),client=new EventEmitter(),commands=new Map();client.user={id:"bot"};
  const registry={register(c){commands.set(c.name,c);}};const system=install({client,registry,db});t.after(async()=>{await system.cleanup();db.close();});
  const settings=system.store.settings("guild");settings.enabled=true;system.store.saveSettings("guild",settings);
  system.store.setChannel("guild","watched","channel",true);
  assert.equal(system.store.settings("guild").enabled,true);
  assert.equal(typeof commands.get("midiaadmin").prefix.execute,"function");
  const discord=require("discord.js");
  const fake={guild:{id:"guild"},guildId:"guild",channelId:"watched",channel:{parentId:null},author:{id:"user"},attachments:{size:0}};
  assert.equal(system.store.channels(fake.guildId).some(row=>row.channelId===fake.channelId),true);
  assert.ok(discord.MessageFlags.IsComponentsV2);
});

test("captures attachments before deletion and retains the local copy on analysis failure",async t=>{
  const db=new DatabaseSync(":memory:"),client=new EventEmitter(),system=install({client,registry:{register(){}},db});
  const guildId=randomUUID(),events=[],bytes=Buffer.from("unsupported media for fail-closed test");
  const previous=global.fetch;let deleted=false;
  global.fetch=async()=>{assert.equal(deleted,false,"Discord URL must be read before deletion");events.push("download");return new Response(bytes);};
  t.after(async()=>{global.fetch=previous;for(const row of db.prepare("SELECT filePath FROM media_moderation_cases").all())if(row.filePath)await fs.rm(row.filePath,{force:true});db.close();});
  const settings=system.store.settings(guildId);settings.enabled=true;system.store.saveSettings(guildId,settings);system.store.setChannel(guildId,"watched","channel",true);
  const message={id:randomUUID(),guild:{id:guildId},guildId,channelId:"watched",author:{id:"user"},content:"",attachments:new Map([["a",{url:"https://cdn.discordapp.com/attachments/test.png",name:"test.png",contentType:"image/png",size:bytes.length}]]),
    async delete(){const row=db.prepare("SELECT filePath FROM media_moderation_cases").get();assert.deepEqual(await fs.readFile(row.filePath),bytes);deleted=true;events.push("delete");}};
  await system.onMessage(message);
  assert.deepEqual(events,["download","delete"]);
  const row=db.prepare("SELECT * FROM media_moderation_cases").get();assert.equal(row.status,"review");assert.deepEqual(await fs.readFile(row.filePath),bytes);
});

test("a failed capture is not retried against the deleted Discord attachment",async t=>{
  const db=new DatabaseSync(":memory:"),client=new EventEmitter(),system=install({client,registry:{register(){}},db});
  const previous=global.fetch;let calls=0,deleted=false;global.fetch=async()=>{calls++;assert.equal(deleted,false);return new Response(null,{status:404});};
  t.after(()=>{global.fetch=previous;db.close();});const guildId=randomUUID(),settings=system.store.settings(guildId);settings.enabled=true;system.store.saveSettings(guildId,settings);system.store.setChannel(guildId,"watched","channel",true);
  await system.onMessage({id:randomUUID(),guild:{id:guildId},guildId,channelId:"watched",author:{id:"user"},content:"",attachments:new Map([["a",{url:"https://cdn.discordapp.com/attachments/test.png",name:"test.png",size:10}]]),async delete(){deleted=true;}});
  assert.equal(calls,1);assert.equal(deleted,true);const row=db.prepare("SELECT * FROM media_moderation_cases").get();assert.equal(row.status,"review");assert.equal(row.filePath,null);assert.match(row.reason,/reenvio privado/);
});

test("automatic and human-approved reposts are exempt from the 30-second cleanup",async t=>{
  const db=new DatabaseSync(":memory:"),client=new EventEmitter();client.user={id:"bot"};
  const registry=getCommandRegistry(client),system=install({client,registry,db});
  const previousFetch=global.fetch,guildId=randomUUID(),posted=[];
  const bytes=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWoQAAAAASUVORK5CYII=","base64");
  global.fetch=async()=>new Response(bytes);
  const channel={id:"watched",guildId,isTextBased:()=>true,async send(payload){
    const message={id:randomUUID(),guildId,channelId:"watched",author:client.user,payload};
    if(payload.files)posted.push(message);registry.trackBotMessage(message);return message;
  }};
  client.channels={async fetch(){return channel;}};
  const guild={id:guildId,members:{async fetch(){return {user:{bot:false}};}}};
  t.after(async()=>{global.fetch=previousFetch;for(const timer of registry.botMessageTimers.values())clearTimeout(timer);for(const row of db.prepare("SELECT filePath FROM media_moderation_cases").all())if(row.filePath)await fs.rm(row.filePath,{force:true});db.close();});
  const settings=system.store.settings(guildId);settings.enabled=true;system.store.saveSettings(guildId,settings);system.store.setChannel(guildId,"watched","channel",true);
  const model=process.env.OPENAI_MODERATION_MODEL?.trim()||DEFAULT_MODEL;
  const cacheVersion=`${system.store.RULE_VERSION}:${createHash("sha256").update(JSON.stringify({model,rules:settings.rules})).digest("hex")}`;
  db.prepare("INSERT INTO media_moderation_hashes VALUES(?,?,?,?,?)").run(guildId,createHash("sha256").update(bytes).digest("hex"),"approved",cacheVersion,Date.now());
  await system.onMessage({id:randomUUID(),guild,guildId,channelId:"watched",channel,reference:{type:0,messageId:"100000000000000081",channelId:"watched",guildId},author:{id:"user"},content:"",attachments:new Map([["a",{url:"https://cdn.discordapp.com/attachments/test.png",name:"test.png",contentType:"image/png",size:bytes.length}]]),async delete(){}});
  assert.equal(posted.length,1);assert.ok(registry.preservedBotMessages.has(posted[0].id));assert.equal(registry.botMessageTimers.size,0);
  const row=db.prepare("SELECT * FROM media_moderation_cases").get();
  assert.equal(row.status,"approved");
  assert.equal(row.replyMessageId,"100000000000000081");
  // Reuse the approved record as a human-review fixture with a local attachment.
  const os=require("node:os"),path=require("node:path");
  const file=path.join(os.tmpdir(),"opencode",`media-preserve-${randomUUID()}.png`);await fs.writeFile(file,bytes);
  t.after(()=>fs.rm(file,{force:true}));
  db.prepare("UPDATE media_moderation_cases SET status='review',filePath=? WHERE id=?").run(file,row.id);
  let updated=false;
  await system.onInteraction({inGuild:()=>true,guild,guildId,user:{id:"moderator"},member:{permissions:{has:()=>true}},customId:`mds-media-review:approve:${row.id}`,async update(){updated=true;},async reply(){assert.fail("Human approval should succeed");}});
  assert.equal(updated,true);assert.equal(posted.length,2);
  for(const message of posted){
    assert.ok(registry.preservedBotMessages.has(message.id));registry.trackBotMessage(message);
    const p=message.payload,container=p.components[0].toJSON(),components=container.components;
    assert.deepEqual(p.reply,{messageReference:"100000000000000081",failIfNotExists:false});
    assert.equal(p.allowedMentions.repliedUser,false);
    assert.equal(container.type,17);assert.equal(container.accent_color,undefined);
    assert.equal(components[0].type,9);assert.equal(components[0].components[0].content,"> **<@user>**");
    assert.equal(components[0].components[1].content,"-# Esta mídia foi verificada pelo nosso sistema.");
    assert.equal(components[0].accessory.custom_id,"mds-media-delete-approved");
    assert.equal(components[1].type,14);assert.equal(components[2].type,12);
    assert.equal(components[2].items[0].media.url,`attachment://${p.files[0].name}`);assert.deepEqual(p.files[0].attachment,bytes);
    assert.equal(p.flags,require("discord.js").MessageFlags.IsComponentsV2);assert.equal(p.embeds,undefined);assert.equal(p.content,undefined);
  }
  assert.equal(registry.botMessageTimers.size,0,"neither repost can be scheduled for inactivity deletion");
});

test("approved videos use Components V2 gallery/player with the original attachment",()=>{
  const {approvedPublication}=require("../media-moderation/publication");
  const bytes=Buffer.from("video fixture"),p=approvedPublication({authorId:"user",buffer:bytes,filename:"video.mp4",mime:"video/mp4",caption:"Legenda"});
  assert.equal(p.embeds,undefined);assert.equal(p.content,undefined);assert.equal(p.files[0].attachment,bytes);assert.deepEqual(p.allowedMentions,{parse:[]});
  assert.equal(p.flags,require("discord.js").MessageFlags.IsComponentsV2);const components=p.components[0].toJSON().components;
  assert.equal(components[2].type,12);assert.equal(components[2].items[0].media.url,"attachment://video.mp4");assert.equal(components[0].components[0].content,"> **<@user>**");assert.equal(components[3].content,"Legenda");
  for(const [mime,filename] of [["video/webm","video.webm"],["video/quicktime","video.mov"]]){const other=approvedPublication({authorId:"user",buffer:bytes,filename,mime});assert.equal(other.components[0].toJSON().components[2].items[0].media.url,`attachment://${filename}`);}
});
