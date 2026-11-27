const test=require("node:test");
const assert=require("node:assert/strict");
const {EventEmitter}=require("node:events");
const {DatabaseSync}=require("node:sqlite");
const {randomUUID}=require("node:crypto");
const fs=require("node:fs/promises");
const path=require("node:path");
const os=require("node:os");
const d=require("discord.js");
const install=require("../media-moderation");
const {createCrossReview}=require("../media-moderation/cross-review");
const SOURCE="100000000000000001",TARGET="100000000000000002",CHANNEL="100000000000000003",ROLE="100000000000000004";
const permissions=admin=>new d.PermissionsBitField(admin?[d.PermissionFlagsBits.ManageGuild]:[]);
function fixture(t){
  const db=new DatabaseSync(":memory:"),client=new EventEmitter(),responses=[],notices=[],publications=[],edits=[],files=[];
  client.user={id:"bot"};const state={sourceAdmin:true,targetAdmin:true,public:false,botAllowed:true,failSend:false};
  const source={id:SOURCE,members:{async fetch(id){return id==="operator"?{permissions:permissions(state.sourceAdmin)}:{id,user:{bot:false}};}}};
  const target={id:TARGET,roles:{everyone:{id:TARGET},async fetch(id){return {id,managed:false,guild:{id:TARGET}};}},members:{me:{id:"bot"},async fetch(){return {permissions:permissions(state.targetAdmin)};}}};
  const channel={id:CHANNEL,guildId:TARGET,guild:target,type:d.ChannelType.GuildText,isTextBased:()=>true,
    permissionsFor(member){return new d.PermissionsBitField(member?.id===TARGET?(state.public?[d.PermissionFlagsBits.ViewChannel]:[]):state.botAllowed?[d.PermissionFlagsBits.ViewChannel,d.PermissionFlagsBits.SendMessages,d.PermissionFlagsBits.AttachFiles]:[]);},
    async send(payload){if(state.failSend)throw new Error("Discord down");const sent={id:randomUUID(),author:client.user,async edit(p){edits.push(p);}};notices.push({payload,sent});return sent;},
    messages:{async fetch(id){return notices.find(n=>n.sent.id===id)?.sent;}}};
  const originChannel={id:"origin-channel",guildId:SOURCE,isTextBased:()=>true,async send(p){publications.push(p);return {id:"repost"};}};
  client.channels={async fetch(id){return id===CHANNEL?channel:id==="origin-channel"?originChannel:null;}};
  client.guilds={async fetch(id){return id===SOURCE?source:null;}};
  const registry={register(){},preserveMessage(){}};
  const moderationProcessor={configured:true,model:"omni-moderation-latest",async moderate(){return {decision:"review",reason:"Mock inconclusive analysis",categories:[],requiresHumanReview:true};}};
  const system=install({client,registry,db,moderationProcessor}),cross=createCrossReview({client,registry,store:system.store});
  const configure=()=>cross.configure({sourceGuild:source,actorId:"operator",channelId:CHANNEL,roleId:ROLE});
  async function insert({status="review",safety=false}={}){const id=randomUUID(),file=path.join(os.tmpdir(),"opencode",`cross-review-${id}.png`);files.push(file);await fs.writeFile(file,Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWoQAAAAASUVORK5CYII=","base64"));db.prepare("INSERT INTO media_moderation_cases(id,guildId,channelId,authorId,originalMessageId,mediaType,createdAt,status,rulesVersion,filePath,mimeType,errorKind) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run(id,SOURCE,"origin-channel","author","message","image/png",Date.now(),status,system.store.RULE_VERSION,file,"image/png",safety?"child_safety":null);return id;}
  function interaction(customId,{guildId=TARGET,channelId=CHANNEL,admin=false,role=true}={}){return {customId,guildId,channelId,guild:guildId===SOURCE?source:target,user:{id:"operator"},member:{permissions:permissions(admin),roles:{cache:new Map(role?[[ROLE,{}]]:[])}},inGuild:()=>true,
    async deferUpdate(){this.deferred=true;},async deferReply(){this.deferred=true;},async reply(p){responses.push(p);},async editReply(p){responses.push(p);},async followUp(p){responses.push(p);},async update(p){responses.push(p);},async showModal(p){responses.push(p);}};}
  t.after(async()=>{for(const file of files)await fs.rm(file,{force:true});db.close();});
  return {db,client,system,cross,state,source,target,channel,originChannel,responses,notices,publications,edits,configure,insert,interaction,moderationProcessor};
}
const text=p=>JSON.stringify(p.components?.map(c=>c.toJSON()));

test("external review configuration requires both guild admins, private destination and bot permissions",async t=>{
  const f=fixture(t);
  for(const [key,value] of [["sourceAdmin",false],["targetAdmin",false],["public",true],["botAllowed",false]]){
    const before=f.state[key];f.state[key]=value;await assert.rejects(f.configure());assert.equal(f.system.store.settings(SOURCE).externalReview,undefined);f.state[key]=before;
  }
  const config=await f.configure();assert.deepEqual(config,{guildId:TARGET,channelId:CHANNEL,roleId:ROLE});
  assert.deepEqual(f.system.store.settings(SOURCE).externalReview,config);
});

test("only inconclusive available media is copied with gallery and decision buttons; no duplicates",async t=>{
  const f=fixture(t);await f.configure();const review=await f.insert(),approved=await f.insert({status:"approved"}),blocked=await f.insert({status:"blocked"}),safety=await f.insert({safety:true});
  await Promise.all([f.cross.notify(review),f.cross.notify(review)]);await f.cross.notify(review);
  for(const id of [approved,blocked,safety])await f.cross.notify(id);
  assert.equal(f.notices.length,1);const p=f.notices[0].payload;assert.equal(p.files.length,1);assert.match(text(p),/Abrir caso privado/);assert.equal(p.enforceNonce,true);
  const row=f.db.prepare("SELECT * FROM media_moderation_cases WHERE id=?").get(review);assert.deepEqual(p.files[0].attachment,await fs.readFile(row.filePath));
  const components=p.components[0].toJSON().components;assert.equal(components.find(c=>c.type===12).items[0].media.url,`attachment://${p.files[0].name}`);
  const buttons=components.flatMap(c=>c.components||[]);for(const action of ["approve","reject"])assert.equal(buttons.find(b=>b.custom_id===`mds-media-review:${action}:${review}`).disabled,false);
  const again=createCrossReview({client:f.client,registry:{preserveMessage(){}},store:f.system.store});await again.notify(review);assert.equal(f.notices.length,1);
});

test("external reviewer sees a private file and approval republishes only in the original guild/channel",async t=>{
  const f=fixture(t);await f.configure();const id=await f.insert();await f.cross.notify(id);
  await f.system.onInteraction(f.interaction(`mds-media-open:${id}`));const preview=f.responses.at(-1);assert.ok(preview.flags&d.MessageFlags.Ephemeral);assert.equal(preview.files.length,1);
  await f.system.onInteraction(f.interaction(`mds-media-review:approve:${id}`));assert.equal(f.publications.length,1);assert.equal(f.notices.length,1);assert.equal(f.edits.length,1);
  assert.deepEqual(f.edits[0].attachments,[]);assert.equal(f.edits[0].files,undefined);
  assert.equal(f.responses.at(-1).flags&d.MessageFlags.Ephemeral,0);assert.deepEqual(f.responses.at(-1).attachments,[]);
  const row=f.db.prepare("SELECT * FROM media_moderation_cases WHERE id=?").get(id);assert.equal(row.status,"approved");assert.equal(row.guildId,SOURCE);assert.equal(row.reviewerGuildId,TARGET);assert.equal(row.reviewerId,"operator");assert.equal(row.repostedMessageId,"repost");assert.equal(row.filePath,null);
  await f.system.onInteraction(f.interaction(`mds-media-review:approve:${id}`));assert.equal(f.publications.length,1);
});

test("foreign guilds, wrong channels and unconfigured reviewers cannot preview, approve or read details",async t=>{
  const f=fixture(t);await f.configure();const id=await f.insert();
  for(const options of [{role:false},{channelId:"other-channel",admin:true},{guildId:"other-guild",admin:true}])for(const action of [`mds-media-open:${id}`,`mds-media-review:approve:${id}`,`mds-media-review:details:${id}`]){
    await f.system.onInteraction(f.interaction(action,options));const p=f.responses.at(-1);assert.match(text(p),/não tem acesso/);assert.equal(p.files,undefined);
  }
  assert.equal(f.publications.length,0);assert.equal(f.db.prepare("SELECT status FROM media_moderation_cases WHERE id=?").get(id).status,"review");
  const s=f.system.store.settings(SOURCE);s.externalReview=null;f.system.store.saveSettings(SOURCE,s);await f.system.onInteraction(f.interaction(`mds-media-open:${id}`));assert.match(text(f.responses.at(-1)),/não tem acesso/);
});

test("remote rejection never posts media and notification failures preserve the origin review queue",async t=>{
  const f=fixture(t);await f.configure();const id=await f.insert();f.state.failSend=true;await assert.doesNotReject(f.cross.notify(id));assert.equal(f.db.prepare("SELECT status FROM media_moderation_cases WHERE id=?").get(id).status,"review");
  f.state.failSend=false;await f.cross.notify(id);assert.equal(f.notices.length,1);
  await f.system.onInteraction(f.interaction(`mds-media-review:reject:${id}`));assert.equal(f.publications.length,0);assert.equal(f.db.prepare("SELECT status FROM media_moderation_cases WHERE id=?").get(id).status,"blocked");
});

test("existing admin panel opens and saves cross-server modal, flushes pending cases and can disable access",async t=>{
  const f=fixture(t),options={guildId:SOURCE,channelId:"origin-channel",admin:true};
  await f.system.onInteraction(f.interaction("mds-media-external-config",options));assert.equal(f.responses.at(-1).toJSON().custom_id,"mds-media-external-save");
  const id=await f.insert(),submit=f.interaction("mds-media-external-save",options);submit.isModalSubmit=()=>true;submit.fields={getTextInputValue:key=>key==="channel"?CHANNEL:ROLE};
  await f.system.onInteraction(submit);assert.equal(f.system.store.settings(SOURCE).externalReview.channelId,CHANNEL);assert.equal(f.notices.length,1);
  await f.system.onInteraction(f.interaction("mds-media-external-disable",options));assert.equal(f.system.store.settings(SOURCE).externalReview,null);
  assert.deepEqual(f.edits.at(-1).attachments,[]);
  await f.system.onInteraction(f.interaction(`mds-media-review:approve:${id}`));assert.match(text(f.responses.at(-1)),/não tem acesso/);assert.equal(f.publications.length,0);
});
test("external media copies expire with retention and are not resent by flush",async t=>{
  const f=fixture(t);await f.configure();const id=await f.insert();await f.cross.notify(id);assert.equal(f.notices.length,1);
  f.db.prepare("UPDATE media_moderation_cases SET createdAt=? WHERE id=?").run(Date.now()-73*3600000,id);
  await f.system.cleanup();assert.deepEqual(f.edits.at(-1).attachments,[]);assert.equal(f.db.prepare("SELECT mediaAttached FROM media_moderation_external_reviews WHERE caseId=?").get(id).mediaAttached,0);
  await f.cross.flush(SOURCE);assert.equal(f.notices.length,1);assert.equal(f.edits.at(-1).files,undefined);
});
test("private-channel permissions are rechecked before uploading the retained media",async t=>{
  const f=fixture(t);await f.configure();const id=await f.insert();f.state.public=true;await f.cross.notify(id);assert.equal(f.notices.length,0);
  assert.equal(f.db.prepare("SELECT status FROM media_moderation_cases WHERE id=?").get(id).status,"review");
});
test("legacy metadata-only notices are upgraded in place with the original media",async t=>{
  const f=fixture(t);await f.configure();const id=await f.insert();await f.cross.notify(id);
  f.db.prepare("UPDATE media_moderation_external_reviews SET mediaAttached=0 WHERE caseId=?").run(id);
  await f.cross.notify(id);assert.equal(f.notices.length,1);assert.equal(f.edits.at(-1).files.length,1);assert.match(text(f.edits.at(-1)),/attachment:\/\//);
});
test("real local MP4 is uploaded unchanged to the review gallery with decision buttons",async t=>{
  const f=fixture(t);await f.configure();const id=await f.insert(),row=f.db.prepare("SELECT filePath FROM media_moderation_cases WHERE id=?").get(id);
  const {execBin}=require("../media-moderation/processor");
  await execBin(require("ffmpeg-static"),["-v","error","-f","lavfi","-i","color=c=white:s=64x64:r=2","-t","1","-an","-threads","1","-pix_fmt","yuv420p","-f","mp4","-y",row.filePath]);
  f.db.prepare("UPDATE media_moderation_cases SET mimeType='video/mp4',externalReviewRequested=1 WHERE id=?").run(id);
  await f.cross.notify(id);assert.equal(f.notices.length,1);const p=f.notices[0].payload;
  assert.deepEqual(p.allowedMentions.roles,[ROLE]);assert.equal(p.components[0].toJSON().components[0].content,`<@&${ROLE}>`);
  assert.equal(p.files[0].name,`${id}.mp4`);assert.deepEqual(p.files[0].attachment,await fs.readFile(row.filePath));
  assert.equal(p.components[0].toJSON().components.find(c=>c.type===12).items[0].media.url,`attachment://${id}.mp4`);
});
test("video cases are not exported before the author requests review; configured review role is mentioned after request",async t=>{
  const f=fixture(t);await f.configure();const id=await f.insert();f.db.prepare("UPDATE media_moderation_cases SET mimeType='video/mp4' WHERE id=?").run(id);
  await f.cross.notify(id);assert.equal(f.notices.length,0);
  f.db.prepare("UPDATE media_moderation_cases SET externalReviewRequested=1 WHERE id=?").run(id);await f.cross.notify(id);
  assert.equal(f.notices.length,1);assert.deepEqual(f.notices[0].payload.allowedMentions.roles,[ROLE]);
});
test("actual intake automatically notifies external review only when analysis is inconclusive",async t=>{
  const f=fixture(t);await f.configure();const settings=f.system.store.settings(SOURCE);settings.enabled=true;f.system.store.saveSettings(SOURCE,settings);f.system.store.setChannel(SOURCE,"origin-channel","channel",true);
  const previous=global.fetch,bytes=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWoQAAAAASUVORK5CYII=","base64");global.fetch=async()=>new Response(bytes);
  let retainedPath;t.after(async()=>{global.fetch=previous;if(retainedPath)await fs.rm(retainedPath,{force:true});});
  const message=()=>({id:randomUUID(),guild:f.source,guildId:SOURCE,channelId:"origin-channel",author:{id:"author"},content:"test caption",attachments:new Map([["a",{url:"https://cdn.discordapp.com/a.png",name:"a.png",contentType:"image/png",size:bytes.length}]]),async delete(){}});
  await f.system.onMessage(message());assert.equal(f.notices.length,1);assert.equal(f.publications.length,0);
  const pending=f.db.prepare("SELECT * FROM media_moderation_cases WHERE status='review'").get();retainedPath=pending.filePath;assert.ok(pending.filePath);
  f.moderationProcessor.moderate=async()=>({decision:"approved",reason:"Mock approved",categories:[]});
  await f.system.onMessage(message());assert.equal(f.notices.length,1);assert.equal(f.publications.length,1);
});
