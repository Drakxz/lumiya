const test=require("node:test");
const assert=require("node:assert/strict");
const {DatabaseSync}=require("node:sqlite");
const {EventEmitter}=require("node:events");
const {randomUUID}=require("node:crypto");
const fs=require("node:fs/promises");
const path=require("node:path");
const os=require("node:os");
const install=require("../media-moderation");

function fixture(t){
  const db=new DatabaseSync(":memory:"),client=new EventEmitter(),responses=[],sent=[];
  const system=install({client,registry:{register(){},preserveMessage(){}},db});
  const guild={id:"guild",members:{async fetch(){return {id:"author"};}}};
  client.channels={async fetch(){return {guildId:guild.id,isTextBased:()=>true,async send(p){sent.push(p);return {id:"repost"};}};}};
  function insert(filePath=null){const id=randomUUID();db.prepare("INSERT INTO media_moderation_cases(id,guildId,channelId,authorId,originalMessageId,mediaType,createdAt,status,rulesVersion,filePath,mimeType) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(id,guild.id,"channel","author","original","image/png",Date.now(),"review",system.store.RULE_VERSION,filePath,"image/png");return id;}
  function interaction(customId){return {customId,guild,guildId:guild.id,user:{id:"moderator"},member:{permissions:{has:()=>true}},inGuild:()=>true,
    async deferUpdate(){this.deferred=true;},async deferReply(){this.deferred=true;},async editReply(p){responses.push(p);},async update(p){responses.push(p);},async reply(p){responses.push(p);},async followUp(p){responses.push(p);}};}
  const dispatch=async i=>{for(const listener of client.listeners("interactionCreate"))await listener(i);};
  t.after(()=>db.close());return {db,system,client,responses,sent,insert,interaction,dispatch};
}
const content=p=>JSON.stringify(p.components.map(c=>c.toJSON()));

test("expired-file approval is caught through the real event handler, preserves status and releases lock",async t=>{
  const f=fixture(t),id=f.insert();
  for(let count=0;count<2;count++)await assert.doesNotReject(f.dispatch(f.interaction(`mds-media-review:approve:${id}`)));
  assert.equal(f.responses.length,2);assert.match(content(f.responses[1]),/Arquivo indisponível ou expirado/);assert.doesNotMatch(content(f.responses[1]),/Revisão já em andamento/);
  assert.equal(f.sent.length,0);assert.equal(f.db.prepare("SELECT status FROM media_moderation_cases WHERE id=?").get(id).status,"review");
  await f.dispatch(f.interaction(`mds-media-review:reject:${id}`));assert.equal(f.db.prepare("SELECT status FROM media_moderation_cases WHERE id=?").get(id).status,"blocked");
});

test("missing local file clears stale path and cannot cause fatal rejection during approval or preview",async t=>{
  const f=fixture(t),missing=path.join(os.tmpdir(),"opencode",`missing-${randomUUID()}.png`),id=f.insert(missing);
  const approve=f.interaction(`mds-media-review:approve:${id}`);await assert.doesNotReject(f.dispatch(approve));assert.equal(approve.deferred,true);
  assert.equal(f.db.prepare("SELECT filePath FROM media_moderation_cases WHERE id=?").get(id).filePath,null);assert.match(content(f.responses.at(-1)),/novo envio/);
  const preview=f.interaction(`mds-media-open:${id}`);await f.dispatch(preview);
  const p=f.responses.at(-1),json=JSON.parse(content(p));assert.match(content(p),/Arquivo indisponível ou expirado/);assert.equal(p.files,undefined);
  const buttons=json[0].components.flatMap(c=>c.components||[]);assert.equal(buttons.find(b=>b.custom_id===`mds-media-review:approve:${id}`).disabled,true);
  const stale=f.insert(missing);await assert.doesNotReject(f.dispatch(f.interaction(`mds-media-open:${stale}`)));assert.equal(f.db.prepare("SELECT filePath FROM media_moderation_cases WHERE id=?").get(stale).filePath,null);
});

test("returned Discord promise failures and failed error notifications are both contained",async t=>{
  const f=fixture(t);let attempts=0;
  const i=f.interaction("mds-media-admin:home");i.update=async()=>{throw new Error("Discord unavailable");};i.reply=async()=>{attempts++;throw new Error("Reply unavailable");};
  await assert.doesNotReject(f.dispatch(i));assert.equal(attempts,1);
  await assert.doesNotReject(f.dispatch(f.interaction(`mds-media-review:approve:${randomUUID()}`)));assert.match(content(f.responses.at(-1)),/Caso já finalizado/);
});

test("successful approval acknowledges before upload and posts once even after repeated clicks",async t=>{
  const f=fixture(t),file=path.join(os.tmpdir(),"opencode",`review-${randomUUID()}.png`);await fs.writeFile(file,Buffer.from("local fixture"));t.after(()=>fs.rm(file,{force:true}));
  const id=f.insert(file),i=f.interaction(`mds-media-review:approve:${id}`);
  f.client.channels.fetch=async()=>{assert.equal(i.deferred,true);return {guildId:f.db.prepare("SELECT guildId FROM media_moderation_cases WHERE id=?").get(id).guildId,isTextBased:()=>true,async send(p){f.sent.push(p);return {id:"repost"};}};};
  await f.dispatch(i);assert.equal(f.sent.length,1);assert.equal(f.db.prepare("SELECT status FROM media_moderation_cases WHERE id=?").get(id).status,"approved");
  await f.dispatch(f.interaction(`mds-media-review:approve:${id}`));assert.equal(f.sent.length,1);assert.match(content(f.responses.at(-1)),/Caso já finalizado/);
});
