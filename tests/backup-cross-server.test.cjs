const test=require("node:test");
const assert=require("node:assert/strict");
const {EventEmitter}=require("node:events");
const {DatabaseSync}=require("node:sqlite");
const {Collection,PermissionsBitField,PermissionFlagsBits:P}=require("discord.js");
const {createHash}=require("node:crypto");
const fs=require("node:fs");
const os=require("node:os");
const path=require("node:path");
const install=require("../backups");
const {encode}=require("../backups/archive");
const {previewRestore,restore}=require("../backups/engine");

function fixture(t,{creator="user",sourceAdmin=false,destinationAdmin=true}={}){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"opencode","cross-backup-"));
  const before=process.env.BACKUP_DIRECTORY;process.env.BACKUP_DIRECTORY=dir;
  const db=new DatabaseSync(":memory:"),client=new EventEmitter(),commands=new Map(),dms=[],replies=[],denied=[];
  const member={id:"user",permissions:new PermissionsBitField(destinationAdmin?[P.Administrator]:[])};
  const destination={id:"destination",name:"Destino",ownerId:"owner",
    members:{async fetch(){return member;}},roles:{cache:new Collection(),async fetch(){}},
    channels:{cache:new Collection(),async fetch(){}}};
  const origin={id:"origin",name:"Origem",ownerId:"owner",members:{
    async fetch(){return {id:"user",permissions:new PermissionsBitField(sourceAdmin?[P.Administrator]:[])};}
  }};
  client.guilds={cache:new Collection([["destination",destination],["origin",origin]]),async fetch(id){return this.cache.get(id);}};
  const api=install({client,db,registry:{register:c=>commands.set(c.name,c),deny:async()=>denied.push(true)}});
  t.after(()=>{api.close();db.close();if(before===undefined)delete process.env.BACKUP_DIRECTORY;else process.env.BACKUP_DIRECTORY=before;fs.rmSync(dir,{recursive:true,force:true});});
  const data={formatVersion:1,originGuildId:"origin",originGuildName:"Origem",roles:[],channels:[],emojis:[],stickers:[],limitations:[]};
  const bytes=encode(data,process.env.BACKUP_ENCRYPTION_KEY);
  const row=api.store.insertBackup({guildId:"origin",createdAt:Date.now(),size:bytes.length,
    sha256:createHash("sha256").update(bytes).digest("hex"),summary:{},createdBy:creator},bytes);
  const message={guild:destination,content:`!restaurar ${row.id}`,author:{id:"user",async send(p){dms.push(p);}},
    async react(){},async reply(p){replies.push(p);}};
  const execute=()=>commands.get("restaurar").prefix.execute(message);
  return {api,db,client,origin,destination,member,message,row,data,dms,replies,denied,execute};
}

test("creator can import a backup from another server using only backup ID and destination admin permission",async t=>{
  const f=fixture(t);
  await f.execute();
  assert.equal(f.dms.length,1);
  const text=JSON.stringify(f.dms[0].components);
  assert.match(text,/Importação entre servidores/);
  assert.match(text,/Destino/);
  const state=JSON.parse(f.db.prepare("SELECT state FROM server_backup_sessions").get().state);
  assert.equal(state.guildId,"destination");
  assert.equal(state.preview.crossGuild,true);
});

test("source administrator can use backup created by someone else",async t=>{
  const f=fixture(t,{creator:"other-user",sourceAdmin:true});
  await f.execute();
  assert.equal(f.dms.length,1);
});

test("backup ID alone does not grant access to foreign private backup",async t=>{
  const f=fixture(t,{creator:"other-user"});
  await f.execute();
  assert.equal(f.dms.length,0);
  assert.match(f.replies[0],/criador do backup|autorização/);
});

test("destination authorization is required even for backup creator",async t=>{
  const f=fixture(t,{destinationAdmin:false});
  await f.execute();
  assert.equal(f.denied.length,1);
  assert.equal(f.dms.length,0);
});

test("source authorization is revalidated on confirmation",async t=>{
  const f=fixture(t,{creator:"other-user",sourceAdmin:true});
  await f.execute();
  const state=JSON.parse(f.db.prepare("SELECT state FROM server_backup_sessions").get().state);
  f.origin.members.fetch=async()=>({id:"user",permissions:new PermissionsBitField()});
  const edits=[];
  const i={customId:`bk:restoreconfirm:${state.id}`,user:{id:"user"},isRepliable:()=>true,
    async deferUpdate(){this.deferred=true;},message:{async edit(p){edits.push(p);}},async reply(p){edits.push(p);}};
  for(const listener of f.client.listeners("interactionCreate"))await listener(i);
  assert.match(JSON.stringify(edits),/criador do backup|autorização/);
  assert.equal(f.api.store.list("destination").length,0);
});

test("cross-server engine remaps everyone but never copies personal member overwrites",async()=>{
  const channels=new Collection(),roles=new Collection(),calls=[];
  const guild={id:"destination",roles:{cache:roles,async fetch(){}},
    channels:{cache:channels,async fetch(){},async create(options){
      calls.push(options);const channel={id:"new-channel",...options};channels.set(channel.id,channel);return channel;
    }},members:{cache:new Collection([["source-user",{}]]),async fetch(){assert.fail("cross import must not fetch source members");}}};
  const data={formatVersion:1,originGuildId:"origin",roles:[],channels:[{id:"old-channel",name:"private",type:0,position:0,
    overwrites:[{id:"origin",type:0,allow:"0",deny:"1024"},{id:"source-user",type:1,allow:"1024",deny:"0"}]}],emojis:[],stickers:[]};
  await assert.rejects(()=>previewRestore(guild,data),/outro servidor/);
  const result=await restore(guild,data,{allowCrossGuild:true});
  assert.equal(result.roleMap.origin,"destination");
  assert.deepEqual(calls[0].permissionOverwrites.map(o=>o.id),["destination"]);
  assert.equal(result.channelMap["old-channel"],"new-channel");
});
