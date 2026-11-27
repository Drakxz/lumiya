const test=require("node:test");
const assert=require("node:assert/strict");
const {DatabaseSync}=require("node:sqlite");
const {EventEmitter}=require("node:events");
const {PermissionFlagsBits,PermissionsBitField,MessageFlags,ButtonStyle}=require("discord.js");
const {approvedPublication}=require("../media-moderation/publication");
const install=require("../media-moderation");

test("approved image/video uses V2 container, formatted text and requested custom trash icon",()=>{
  for(const [mime,filename] of [["image/jpeg","photo.jpg"],["image/png","photo.png"],["image/gif","animation.gif"],["video/mp4","video.mp4"],["video/webm","video.webm"]]){
    const bytes=Buffer.from("original media fixture"),p=approvedPublication({authorId:"123",buffer:bytes,filename,mime,caption:"Approved caption"});
    assert.equal(p.components.length,1);const container=p.components[0].toJSON();assert.equal(container.type,17);assert.equal(container.accent_color,undefined);
    const components=container.components;assert.deepEqual(components.map(c=>c.type),[9,14,12,10]);
    assert.equal(components[0].components[0].content,"> **<@123>**");assert.equal(components[0].components[1].content,"-# Esta mídia foi verificada pelo nosso sistema.");
    assert.equal(components[0].accessory.custom_id,"mds-media-delete-approved");assert.equal(components[0].accessory.style,ButtonStyle.Secondary);assert.equal(components[0].accessory.emoji.name,"IconR_Delete");assert.equal(components[0].accessory.emoji.id,"1570542177510232144");
    assert.equal(components[1].divider,true);assert.equal(components[2].items[0].media.url,`attachment://${filename}`);assert.equal(components[3].content,"Approved caption");
    assert.equal(p.files[0].attachment,bytes);assert.equal(p.flags,MessageFlags.IsComponentsV2);assert.deepEqual(p.allowedMentions,{parse:[]});assert.equal(p.content,undefined);assert.equal(p.embeds,undefined);
  }
});

function fixture(t){
  const db=new DatabaseSync(":memory:"),client=new EventEmitter(),responses=[];client.user={id:"bot"};let deletions=0;
  const system=install({client,registry:{register(){},preserveMessage(){}},db});
  db.prepare("INSERT INTO media_moderation_cases(id,guildId,channelId,authorId,originalMessageId,mediaType,createdAt,status,decision,rulesVersion,repostedMessageId) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run("case","guild","channel","author","original","image/png",Date.now(),"approved","approved",system.store.RULE_VERSION,"repost");
  function i(userId="author",permissions=[]){return {customId:"mds-media-delete-approved",guildId:"guild",channelId:"channel",inGuild:()=>true,user:{id:userId},member:{permissions:new PermissionsBitField(permissions)},message:{id:"repost",author:{id:"bot"},async delete(){deletions++;}},
    async deferReply(p){assert.ok(p.flags&MessageFlags.Ephemeral);this.deferred=true;},async editReply(p){responses.push(p);},async reply(p){responses.push(p);},async followUp(p){responses.push(p);}};}
  t.after(()=>db.close());return {db,system,responses,i,deletions:()=>deletions};
}
const text=p=>JSON.stringify(p.components.map(c=>c.toJSON()));
test("trash button allows original sender and preserves analysis audit/history",async t=>{
  const f=fixture(t);await f.system.onInteraction(f.i());assert.equal(f.deletions(),1);
  const row=f.db.prepare("SELECT * FROM media_moderation_cases WHERE id='case'").get();assert.equal(row.status,"approved");assert.equal(row.repostedMessageId,"repost");assert.equal(row.deletedById,"author");assert.ok(row.deletedAt>0);
  await f.system.onInteraction(f.i());assert.equal(f.deletions(),1);assert.match(text(f.responses.at(-1)),/já removida/);
});
test("trash button rejects other members, including ManageGuild alone, but permits ManageMessages staff",async t=>{
  const f=fixture(t);for(const permissions of [[],[PermissionFlagsBits.ManageGuild]]){await f.system.onInteraction(f.i("other",permissions));assert.match(text(f.responses.at(-1)),/Somente quem enviou/);}
  assert.equal(f.deletions(),0);await f.system.onInteraction(f.i("moderator",[PermissionFlagsBits.ManageMessages]));assert.equal(f.deletions(),1);assert.equal(f.db.prepare("SELECT deletedById FROM media_moderation_cases").get().deletedById,"moderator");
});
test("trash button is bound to the actual approved bot message, origin guild and channel",async t=>{
  const f=fixture(t);for(const change of [{guildId:"other-guild"},{channelId:"other-channel"},{message:{id:"unrelated",author:{id:"bot"}}},{message:{id:"repost",author:{id:"other-bot"}}}])await assert.doesNotReject(f.system.onInteraction({...f.i(),...change}));
  assert.equal(f.deletions(),0);assert.equal(f.db.prepare("SELECT deletedAt FROM media_moderation_cases").get().deletedAt,null);
});
test("deletion failures do not corrupt audit or escape handler; missing Discord message is handled",async t=>{
  const f=fixture(t),failed=f.i();failed.message.delete=async()=>{throw Object.assign(new Error("no access"),{code:50013});};
  await assert.doesNotReject(f.system.onInteraction(failed));assert.equal(f.db.prepare("SELECT deletedAt FROM media_moderation_cases").get().deletedAt,null);assert.match(text(f.responses.at(-1)),/Não foi possível remover/);
  const gone=f.i();gone.message.delete=async()=>{throw Object.assign(new Error("deleted"),{code:10008});};await f.system.onInteraction(gone);assert.ok(f.db.prepare("SELECT deletedAt FROM media_moderation_cases").get().deletedAt>0);
});
