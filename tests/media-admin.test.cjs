const test=require("node:test");
const assert=require("node:assert/strict");
const {EventEmitter}=require("node:events");
const {DatabaseSync}=require("node:sqlite");
const {PermissionFlagsBits,PermissionsBitField,MessageFlags}=require("discord.js");
const {getCommandRegistry}=require("../command-system/registry");
const install=require("../media-moderation");
const {interpret}=require("../media-moderation/openai");
const {createStore}=require("../media-moderation/store");

function fixture(t){
  const db=new DatabaseSync(":memory:"),client=new EventEmitter(),sent=[],replies=[],denied=[];
  client.user={id:"bot"};
  const registry=getCommandRegistry(client,{deny:async()=>denied.push(true)});
  const guild={id:"guild",roles:{async fetch(id){return {id,guild:{id:"guild"},managed:id==="managed"};}}};
  const system=install({client,registry,db});t.after(()=>{for(const timer of registry.botMessageTimers.values())clearTimeout(timer);db.close();});
  const member=(admin=false,role=false)=>({guild,permissions:new PermissionsBitField(admin?[PermissionFlagsBits.ManageGuild]:[]),roles:{cache:new Map(role?[["reviewer",{}]]:[])}});
  const emit=async m=>{for(const fn of client.listeners("messageCreate"))await fn(m);};
  const message=(content,admin=true,role=false)=>({content,guild,guildId:guild.id,author:{id:"staff",bot:false},member:member(admin,role),channel:{async send(p){sent.push(p);return {id:"panel"};}},async reply(p){replies.push(p);},async delete(){}});
  const interaction=(customId,admin=true,role=false,values=[])=>({customId,guild,guildId:guild.id,member:member(admin,role),user:{id:"staff"},values,
    inGuild:()=>true,isRoleSelectMenu:()=>true,async deferUpdate(){this.deferred=true;},async update(p){replies.push(p);},async editReply(p){replies.push(p);},async reply(p){replies.push(p);},async followUp(p){replies.push(p);}});
  return {db,registry,system,guild,sent,replies,denied,emit,message,interaction};
}

test("media admin dispatch accepts mixed case, remains admin-only and reports publication failures",async t=>{
  const f=fixture(t);for(const content of ["!midiaadmin","!Midiaadmin","!MIDIAADMIN"," !MidiaAdmin "])await f.emit(f.message(content));
  assert.equal(f.sent.length,4);assert.match(JSON.stringify(f.sent[0].components[0].toJSON()),/Moderação de Mídias/);
  await f.emit(f.message("!Midiaadmin",false));assert.equal(f.denied.length,1);assert.equal(f.sent.length,4);
  const failed=f.message("!Midiaadmin");failed.channel.send=async()=>{throw new Error("secret provider info");};await f.emit(failed);
  assert.match(JSON.stringify(f.replies.at(-1).components[0].toJSON()),/Painel indisponível/);
});

test("admin configures, validates, persists and clears reviewer role; reviewers cannot configure",async t=>{
  const f=fixture(t);await f.system.onInteraction(f.interaction("mds-media-admin:settings"));
  const json=JSON.stringify(f.replies.at(-1).components[0].toJSON());assert.match(json,/mds-media-review-role/);assert.match(json,/midiarevisao/);
  await f.system.onInteraction(f.interaction("mds-media-review-role",true,false,["reviewer"]));assert.deepEqual(createStore(f.db).settings("guild").reviewRoleIds,["reviewer"]);
  await f.system.onInteraction(f.interaction("mds-media-review-role",false,true,[]));assert.deepEqual(f.system.store.settings("guild").reviewRoleIds,["reviewer"]);
  for(const id of ["guild","managed"])await f.system.onInteraction(f.interaction("mds-media-review-role",true,false,[id]));
  assert.deepEqual(f.system.store.settings("guild").reviewRoleIds,["reviewer"]);
  f.guild.roles.fetch=async()=>({id:"foreign",guild:{id:"other"}});await f.system.onInteraction(f.interaction("mds-media-review-role",true,false,["foreign"]));assert.deepEqual(f.system.store.settings("guild").reviewRoleIds,["reviewer"]);
  await f.system.onInteraction(f.interaction("mds-media-review-role",true,false,[]));assert.deepEqual(f.system.store.settings("guild").reviewRoleIds,[]);
});

test("reviewer opens private queue without admin access and loses access immediately when unconfigured",async t=>{
  const f=fixture(t),s=f.system.store.settings("guild");s.reviewRoleIds=["reviewer"];f.system.store.saveSettings("guild",s);
  await f.emit(f.message("!Midiarevisao",false,true));assert.match(JSON.stringify(f.replies.at(-1).components[0].toJSON()),/Abrir fila privada/);
  await f.system.onInteraction(f.interaction("mds-media-queue",false,true));const p=f.replies.at(-1);assert.ok(p.flags&MessageFlags.Ephemeral);assert.match(JSON.stringify(p.components[0].toJSON()),/Fila de Revisão/);
  await f.system.onInteraction(f.interaction("mds-media-admin:settings",false,true));assert.match(JSON.stringify(f.replies.at(-1).components[0].toJSON()),/Somente administradores/);
  s.reviewRoleIds=[];f.system.store.saveSettings("guild",s);await f.system.onInteraction(f.interaction("mds-media-queue",false,true));assert.match(JSON.stringify(f.replies.at(-1).components[0].toJSON()),/não tem acesso/);
  await f.emit(f.message("!midiarevisao",false,true));assert.equal(f.denied.length,1);
});

test("protection defaults on, can be disabled only by admin and survives individual rule editing",async t=>{
  const f=fixture(t);assert.equal(f.system.store.settings("guild").rules.protectServer,true);
  await f.system.onInteraction(f.interaction("mds-media-protection-toggle",false));assert.equal(f.system.store.settings("guild").rules.protectServer,true);
  await f.system.onInteraction(f.interaction("mds-media-rules",true,false,["sexual"]));assert.equal(f.system.store.settings("guild").rules.protectServer,true);
  await f.system.onInteraction(f.interaction("mds-media-protection-toggle"));assert.equal(createStore(f.db).settings("guild").rules.protectServer,false);
  await f.system.onInteraction(f.interaction("mds-media-protection-toggle"));assert.equal(f.system.store.settings("guild").rules.protectServer,true);
});

test("protection trusts official flags, approves complete clean media and retains only inconclusive analyses",()=>{
  const rules={protectServer:true};
  for(const [category,modality] of [["sexual","image"],["violence","image"],["self-harm","image"],["hate","text"],["harassment","text"],["illicit","text"]]){
    const r={modality,flagged:true,categories:{[category]:true},category_scores:{[category]:0.99},category_applied_input_types:{[category]:[modality]}};
    assert.equal(interpret([r],rules).decision,"blocked");r.category_scores[category]=0.5;assert.equal(interpret([r],rules).decision,"blocked");
    assert.equal(interpret([r],{protectServer:false,allowGameWeapons:true}).decision,"approved");
  }
  const clean={modality:"image",flagged:false,categories:{sexual:false},category_scores:{sexual:0},category_applied_input_types:{sexual:["image"]}};
  assert.equal(interpret([clean],rules).decision,"approved");assert.equal(interpret([clean],{protectServer:false}).decision,"approved");
  assert.equal(interpret([clean],{protectServer:false},{complete:false}).decision,"review");
  assert.equal(interpret([],rules).decision,"review");
});
