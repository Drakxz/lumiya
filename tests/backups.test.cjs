const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const os=require("node:os");
const path=require("node:path");
const crypto=require("node:crypto");
const {DatabaseSync}=require("node:sqlite");
const {Collection}=require("discord.js");
const {encode,decode}=require("../backups/archive");
const {BackupStore}=require("../backups/store");
const {capture,previewRestore,restore,FORMAT_VERSION}=require("../backups/engine");

test("backup archive round-trips, encrypts with authenticated encryption and rejects tampering",()=>{
  const content={formatVersion:FORMAT_VERSION,private:{token:"must remain private"},bytes:Buffer.from("image").toString("base64")};
  const plain=encode(content);assert.deepEqual(decode(plain),content);
  const key=crypto.randomBytes(32).toString("hex"),encrypted=encode(content,key);assert.deepEqual(decode(encrypted,key),content);
  assert.throws(()=>decode(encrypted),/BACKUP_ENCRYPTION_KEY/);
  const changed=Buffer.from(encrypted);changed[changed.length-1]^=1;assert.throws(()=>decode(changed,key));
  assert.throws(()=>decode(Buffer.from("not a backup")),/inválido/);
});

test("SQLite backup metadata, retention and path validation preserve only configured rows",t=>{
  const db=new DatabaseSync(":memory:"),directory=fs.mkdtempSync(path.join(os.tmpdir(),"mds-backup-store-"));
  const store=new BackupStore(db,directory);t.after(()=>{db.close();fs.rmSync(directory,{recursive:true,force:true});});
  assert.equal(store.settings("guild").retention,10);
  store.updateSettings("guild",{automatic:true,intervalHours:6,nextAt:123,retention:1,messageConfig:{enabled:false}});
  assert.equal(store.settings("guild").automatic,1);assert.equal(store.settings("guild").intervalHours,6);
  const first=Buffer.from("one"),second=Buffer.from("two"),now=Date.now();
  store.insertBackup({guildId:"guild",createdAt:now,size:first.length,sha256:crypto.createHash("sha256").update(first).digest("hex"),summary:{},createdBy:"admin"},first);
  const last=store.insertBackup({guildId:"guild",createdAt:now+1,size:second.length,sha256:crypto.createHash("sha256").update(second).digest("hex"),summary:{},createdBy:"admin"},second);
  assert.equal(store.retain("guild"),1);assert.equal(store.list("guild").length,1);
  assert.equal(fs.readFileSync(store.resolveFile(last)).toString(),"two");
  assert.throws(()=>store.resolveFile({...last,filename:"../../secrets.mdsbak"}),/inválido|Caminho/);
});

function testGuild(id="guild-a"){
  const role={id:"role-a",name:"Membro",managed:false,color:0x5865f2,colors:null,hoist:false,mentionable:false,
    permissions:{bitfield:1n},position:2,unicodeEmoji:null,iconURL:()=>null};
  const channel={id:"channel-a",type:0,name:"geral",parentId:null,rawPosition:1,topic:"Bem-vindos",nsfw:false,rateLimitPerUser:0,
    permissionOverwrites:{cache:new Collection()},isThread:()=>false};
  return {id,name:"Servidor",ownerId:"owner",roles:{cache:new Collection([[role.id,role]]),fetch:async()=>{}},
    channels:{cache:new Collection([[channel.id,channel]]),fetch:async()=>{}},emojis:{fetch:async()=>new Collection()},stickers:{fetch:async()=>new Collection()},
    verificationLevel:1,explicitContentFilter:2,defaultMessageNotifications:1,afkTimeout:300,preferredLocale:"pt-BR",premiumProgressBarEnabled:false,
    afkChannelId:null,rulesChannelId:null,publicUpdatesChannelId:null,systemChannelId:null,systemChannelFlags:{bitfield:0n},iconURL:()=>null,bannerURL:()=>null};
}
test("capture produces an honest manifest with inventories and unsupported-resource notes",async()=>{
  const guild=testGuild(),progress=[];const result=await capture(guild,{progress:p=>progress.push(p)});
  assert.equal(result.data.formatVersion,FORMAT_VERSION);assert.equal(result.data.roles.length,1);assert.equal(result.data.channels.length,1);
  assert.equal(result.data.manifest.inventory.roles,1);assert.equal(result.data.manifest.inventory.channels,1);
  assert.ok(result.data.limitations.some(x=>x.includes("IDs originais")));
  assert.ok(progress.length>0);assert.ok(result.bytes.length>0);
  assert.equal(decode(result.bytes).originGuildId,guild.id);
});

test("message archive is opt-in, channel-explicit and keeps original metadata as an archive",async()=>{
  const guild=testGuild(),channel=guild.channels.cache.get("channel-a"),{Collection}=require("discord.js");
  let calls=0;const message={id:"message-a",author:{id:"user-a",tag:"user#0001"},createdAt:new Date(),createdTimestamp:Date.now(),
    content:"archived text",reference:{messageId:"message-parent"},attachments:new Collection()};
  channel.isTextBased=()=>true;channel.name="ticket-private";
  channel.messages={fetch:async()=>++calls===1?new Collection([[message.id,message]]):new Collection()};
  const without=await capture(guild);assert.equal(without.data.archivedMessages.length,0);
  const result=await capture(guild,{messageConfig:{enabled:true,channelIds:[channel.id],explicitSelection:true,days:30,limit:10,attachments:false}});
  assert.equal(result.data.archivedMessages[0].messages[0].content,"archived text");
  assert.equal(result.data.archivedMessages[0].messages[0].authorId,"user-a");
  assert.equal(result.data.archivedMessages[0].messages[0].referenceId,"message-parent");
  assert.ok(result.data.limitations.some(note=>note.includes("cópias de conteúdo")));
});

test("restore preview is bound to the exact origin guild and never deletes resources",async()=>{
  const source=testGuild(),target=testGuild();const snapshot=(await capture(source)).data;
  const plan=await previewRestore(target,snapshot);assert.equal(plan.roles[0].action,"mapear existente");
  await assert.rejects(()=>previewRestore(testGuild("other-server"),snapshot),/outro servidor/);
});

test("restore remaps structurally identical roles one-to-one and never applies absent member overwrites",async()=>{
  const guild=testGuild(),calls={roles:[],channels:[]};let roleNumber=0,channelNumber=0;
  guild.members={cache:new Collection(),fetch:async()=>null,me:{roles:{highest:{position:100}}}};
  guild.roles.create=async options=>{
    calls.roles.push(options);const created={id:`new-role-${++roleNumber}`,name:options.name,color:options.colors.primaryColor,colors:null,hoist:options.hoist,
      mentionable:options.mentionable,unicodeEmoji:options.unicodeEmoji||null,permissions:{bitfield:options.permissions},position:1,
      setPosition:async position=>{created.position=position;}};guild.roles.cache.set(created.id,created);return created;
  };
  guild.channels.create=async options=>{
    calls.channels.push(options);const created={id:`new-channel-${++channelNumber}`,name:options.name,type:options.type,parentId:options.parent,
      setPosition:async()=>{}};guild.channels.cache.set(created.id,created);return created;
  };
  const source=testGuild(),baseRole=source.roles.cache.get("role-a");
  const secondRole={...baseRole,id:"role-b"};
  const savedChannel={id:"channel-new",type:0,name:"private-copy",parentId:null,position:2,overwrites:[
    {id:"role-a",type:0,allow:"1",deny:"0"},{id:"role-b",type:0,allow:"2",deny:"0"},{id:"absent-user",type:1,allow:"4",deny:"0"}]};
  const snapshot={formatVersion:FORMAT_VERSION,originGuildId:guild.id,originGuildName:guild.name,roles:[
    {id:"role-a",name:baseRole.name,color:baseRole.color,colors:null,unicodeEmoji:null,hoist:false,mentionable:false,permissions:"1",position:2},
    {id:"role-b",name:secondRole.name,color:secondRole.color,colors:null,unicodeEmoji:null,hoist:false,mentionable:false,permissions:"1",position:3}
  ],channels:[savedChannel],emojis:[],stickers:[],limitations:[]};
  const result=await restore(guild,snapshot);
  assert.notEqual(result.roleMap["role-a"],result.roleMap["role-b"]);
  assert.deepEqual(calls.channels[0].permissionOverwrites.map(x=>x.id),[result.roleMap["role-a"],result.roleMap["role-b"]]);
  assert.equal(calls.channels[0].permissionOverwrites.some(x=>x.id==="absent-user"),false);
  assert.equal(result.created.roles,1);assert.equal(result.created.channels,1);
  assert.equal(calls.roles[0].color,undefined);
  assert.equal(calls.roles[0].colors.primaryColor,baseRole.color);
});
