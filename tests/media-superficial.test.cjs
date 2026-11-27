const test=require("node:test");
const assert=require("node:assert/strict");
const {EventEmitter}=require("node:events");
const {DatabaseSync}=require("node:sqlite");
const {PermissionsBitField,PermissionFlagsBits,ChannelType}=require("discord.js");
const {randomUUID}=require("node:crypto");
const install=require("../media-moderation");
const {createStore}=require("../media-moderation/store");
const {buildMediaLog}=require("../media-moderation/logs");
const {HOUR}=require("../media-moderation/superficial");
const bytes=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWoQAAAAASUVORK5CYII=","base64");

function fixture(t,{decision="approved",requiresHumanReview=false,categories,fail=false}={}){
  const db=new DatabaseSync(":memory:"),client=new EventEmitter(),events=[],sent=[],commands=[];
  client.user={id:"bot"};
  const bot={id:"bot",permissions:new PermissionsBitField([PermissionFlagsBits.ViewChannel,PermissionFlagsBits.ManageMessages,PermissionFlagsBits.ModerateMembers])};
  const member={id:"user",moderatable:true,communicationDisabledUntilTimestamp:0,
    async timeout(ms){events.push(["timeout",ms]);}};
  const guild={id:randomUUID(),ownerId:"owner",members:{me:bot,async fetchMe(){return bot;},async fetch(){return member;}}};
  const channel={id:"media",guildId:guild.id,parentId:null,type:ChannelType.GuildText,isTextBased:()=>true,permissionsFor:()=>bot.permissions,
    async send(payload){sent.push(payload);return {id:randomUUID()};}};
  client.channels={async fetch(){return channel;}};
  guild.channels={async fetch(){return channel;}};
  const processor={configured:true,model:"mock-moderation",async moderate(buffer,mime,settings){
    events.push(["analyze",settings.superficial]);
    if(fail)throw new Error("quota failure");
    return {decision,reason:"mock",categories:categories|| (decision==="blocked"?["sexual"]:[]),confidence:null,requiresHumanReview,
      coverage:{method:"superficial-three-samples",complete:false}};
  }};
  const system=install({client,registry:{register(c){commands.push(c);},preserveMessage(){}},db,moderationProcessor:processor});
  const s=system.store.settings(guild.id);s.enabled=true;s.superficialChannelIds=["media"];system.store.saveSettings(guild.id,s);
  system.store.setChannel(guild.id,channel.id,"channel",true);
  const oldFetch=global.fetch;
  global.fetch=async()=>{events.push(["download"]);return new Response(bytes);};
  t.after(()=>{global.fetch=oldFetch;db.close();});
  function message(extra={}){
    return {id:randomUUID(),guild,guildId:guild.id,channel,channelId:channel.id,author:{id:"user",bot:false},content:"",
      attachments:new Map([["a",{id:"a",url:"https://cdn.discordapp.com/attachments/a.png",name:"a.png",contentType:"image/png",size:bytes.length}]]),
      async delete(){events.push(["delete"]);},...extra};
  }
  function interaction(admin=true){
    const replies=[];
    return {customId:"mds-media-superficial-save",guild,guildId:guild.id,user:{id:"staff"},
      member:{permissions:new PermissionsBitField(admin?[PermissionFlagsBits.ManageGuild]:[])},
      inGuild:()=>true,isModalSubmit:()=>true,fields:{getTextInputValue:()=>"1571711957927469096"},
      replies,async deferReply(){this.deferred=true;},async editReply(p){replies.push(p);},
      async update(p){replies.push(p);},async reply(p){replies.push(p);},async followUp(p){replies.push(p);}};
  }
  return {db,client,system,guild,bot,member,channel,processor,events,sent,commands,message,interaction,
    rows:()=>db.prepare("SELECT * FROM media_moderation_cases").all()};
}

test("superficial keeps clean original with no deletion, repost or file retention",async t=>{
  const f=fixture(t);
  await f.system.onMessage(f.message());
  assert.deepEqual(f.events,[["download"],["analyze",true]]);
  assert.equal(f.sent.length,0);
  const row=f.rows()[0];
  assert.equal(row.status,"approved");
  assert.equal(row.inspectionMode,"superficial");
  assert.equal(row.filePath,null);
  assert.equal(row.repostedMessageId,null);
});

test("confirmed rule violation deletes once then times out exactly 1h, including multi-attachment messages",async t=>{
  const f=fixture(t,{decision:"blocked"}),message=f.message();
  message.attachments.set("b",{...message.attachments.get("a"),id:"b"});
  await f.system.onMessage(message);
  await f.system.onMessage(message);
  assert.equal(f.events.filter(e=>e[0]==="delete").length,1);
  assert.deepEqual(f.events.filter(e=>e[0]==="timeout"),[["timeout",HOUR]]);
  assert.ok(f.events.findIndex(e=>e[0]==="delete")>f.events.findIndex(e=>e[0]==="analyze"));
  assert.equal(f.sent.length,0);
  assert.ok(f.rows().every(row=>row.status==="blocked"&&row.filePath===null&&JSON.parse(row.enforcementData).timeout==="applied_1h"));
});

test("technical failures and inconclusive results never delete or punish",async t=>{
  for(const options of [{fail:true},{decision:"review",requiresHumanReview:true},{decision:"blocked",requiresHumanReview:true},{decision:"blocked",categories:[]}]){
    const f=fixture(t,options);
    await f.system.onMessage(f.message());
    assert.equal(f.rows()[0].status,"review");
    assert.equal(f.events.some(e=>["delete","timeout"].includes(e[0])),false);
    assert.equal(f.sent.length,0);
  }
});

test("oversized and unsupported media never cause punishment",async t=>{
  const f=fixture(t),message=f.message();
  message.attachments.get("a").size=999999999;
  await f.system.onMessage(message);
  assert.deepEqual(f.events,[]);
  global.fetch=async()=>new Response(Buffer.from("invalid media"));
  await f.system.onMessage(f.message());
  assert.equal(f.events.some(e=>["analyze","delete","timeout"].includes(e[0])),false);
});

test("local rate limits keep originals without API or punishment",async t=>{
  const f=fixture(t,{decision:"blocked"});
  // Six different messages from the same user: sixth exceeds the existing user limit.
  for(let i=0;i<5;i++)await f.system.onMessage(f.message({author:{id:"user",bot:false}}));
  f.events.length=0;
  await f.system.onMessage(f.message());
  assert.deepEqual(f.events,[]);
  assert.equal(f.rows().at(-1).status,"review");
});

test("child-safety text is never downloaded or sent to API and never causes automatic timeout",async t=>{
  const f=fixture(t),message=f.message({content:"child sexual abuse material"});
  await f.system.onMessage(message);
  assert.equal(f.events.some(e=>["download","analyze","timeout"].includes(e[0])),false);
  assert.equal(f.rows()[0].errorKind,"child_safety");
});

test("missing timeout permission, protected member and longer existing timeout are recorded honestly",async t=>{
  const f=fixture(t,{decision:"blocked"});
  f.bot.permissions.remove(PermissionFlagsBits.ModerateMembers);
  await f.system.onMessage(f.message());
  assert.equal(JSON.parse(f.rows()[0].enforcementData).timeout,"missing_permission");
  f.bot.permissions.add(PermissionFlagsBits.ModerateMembers);
  f.member.moderatable=false;
  await f.system.onMessage(f.message());
  assert.equal(JSON.parse(f.rows()[1].enforcementData).timeout,"not_moderatable");
  f.member.moderatable=true;f.member.communicationDisabledUntilTimestamp=Date.now()+2*HOUR;
  await f.system.onMessage(f.message());
  assert.equal(JSON.parse(f.rows()[2].enforcementData).timeout,"longer_timeout_preserved");
  assert.equal(f.events.some(e=>e[0]==="timeout"),false);
});

test("failed deletion does not apply timeout, records failure and contains API errors",async t=>{
  const f=fixture(t,{decision:"blocked"});
  await f.system.onMessage(f.message({async delete(){throw new Error("Missing permissions");}}));
  assert.equal(f.events.some(e=>e[0]==="timeout"),false);
  assert.equal(JSON.parse(f.rows()[0].enforcementData).deletion,"failed");
});

test("mode disabled while processing prevents destructive actions",async t=>{
  const f=fixture(t,{decision:"blocked"});
  const moderate=f.processor.moderate;
  f.processor.moderate=async(...args)=>{
    const result=await moderate(...args);
    const s=f.system.store.settings(f.guild.id);s.superficialChannelIds=[];f.system.store.saveSettings(f.guild.id,s);
    return result;
  };
  await f.system.onMessage(f.message());
  assert.equal(f.events.some(e=>["delete","timeout"].includes(e[0])),false);
});

test("admin-only channel ID registration persists and validates bot permissions; disabled system stays disabled",async t=>{
  const f=fixture(t),s=f.system.store.settings(f.guild.id);
  s.enabled=false;s.superficialChannelIds=[];f.system.store.saveSettings(f.guild.id,s);
  f.channel.id="1571711957927469096";
  await f.system.onInteraction(f.interaction(false));
  assert.deepEqual(f.system.store.settings(f.guild.id).superficialChannelIds,[]);
  f.bot.permissions.remove(PermissionFlagsBits.ModerateMembers);
  await f.system.onInteraction(f.interaction());
  assert.deepEqual(f.system.store.settings(f.guild.id).superficialChannelIds,[]);
  f.bot.permissions.add(PermissionFlagsBits.ModerateMembers);
  const interaction=f.interaction();
  await f.system.onInteraction(interaction);
  assert.deepEqual(createStore(f.db).settings(f.guild.id).superficialChannelIds,["1571711957927469096"]);
  assert.equal(f.system.store.settings(f.guild.id).enabled,false);
  const json=JSON.stringify(interaction.replies.at(-1).components);
  assert.match(json,/análise superficial/);
  assert.match(json,/castigo de 1 hora/);
  const remove=f.interaction();remove.customId="mds-media-superficial-remove";remove.values=["1571711957927469096"];
  await f.system.onInteraction(remove);
  assert.deepEqual(f.system.store.settings(f.guild.id).superficialChannelIds,[]);
});

test("invalid IDs, foreign guilds and non-text channels are rejected",async t=>{
  const f=fixture(t);
  const before=f.system.store.settings(f.guild.id).superficialChannelIds;
  const bad=f.interaction();bad.fields.getTextInputValue=()=>"not-an-id";
  await f.system.onInteraction(bad);
  f.channel.guildId="foreign";
  await f.system.onInteraction(f.interaction());
  f.channel.guildId=f.guild.id;f.channel.type=ChannelType.GuildCategory;
  await f.system.onInteraction(f.interaction());
  assert.deepEqual(f.system.store.settings(f.guild.id).superficialChannelIds,before);
});

test("registered superficial channels need no full-mode registration; legacy global toggle has no effect",async t=>{
  const f=fixture(t);
  f.system.store.setChannel(f.guild.id,"media","channel",false);
  await f.system.onMessage(f.message());
  assert.equal(f.rows()[0].inspectionMode,"superficial");
  const s=f.system.store.settings(f.guild.id);s.superficialChannelIds=[];s.superficial=true;
  f.system.store.saveSettings(f.guild.id,s);
  await f.system.onMessage(f.message());
  assert.equal(f.rows().length,1);
});

test("other monitored channels retain full analysis and reposting even with legacy global flag",async t=>{
  const f=fixture(t),s=f.system.store.settings(f.guild.id);
  s.superficialChannelIds=["different-channel"];s.superficial=true;f.system.store.saveSettings(f.guild.id,s);
  await f.system.onMessage(f.message());
  assert.ok(f.events.some(e=>e[0]==="delete"));
  assert.ok(f.events.some(e=>e[0]==="analyze"&&e[1]===false));
  assert.equal(f.rows()[0].inspectionMode,"full");
  assert.equal(f.sent.filter(p=>p.files?.length).length,1);
  assert.equal(f.events.some(e=>e[0]==="timeout"),false);
});

test("dashboard exposes separate channel category and ID modal instead of a global toggle",async t=>{
  const f=fixture(t);
  let modal;
  const add=f.interaction();add.customId="mds-media-superficial-add";add.showModal=async p=>{modal=p;};
  await f.system.onInteraction(add);
  assert.match(JSON.stringify(modal),/mds-media-superficial-save/);
  const home=f.interaction();home.customId="mds-media-admin:home";
  await f.system.onInteraction(home);
  const json=JSON.stringify(home.replies[0].components);
  assert.match(json,/Canais de análise superficial/);
  assert.doesNotMatch(json,/mds-media-superficial-toggle/);
});

test("unconfigured/excluded channels and bots remain excluded",async t=>{
  const f=fixture(t);
  await f.system.onMessage(f.message({channelId:"other"}));
  await f.system.onMessage(f.message({author:{id:"bot",bot:true}}));
  f.system.store.setChannel(f.guild.id,"media","exclude",true);
  await f.system.onMessage(f.message());
  assert.equal(f.rows().length,0);
});

test("superficial logs do not claim reposting and include actual enforcement result",()=>{
  const row={id:"case",authorId:"user",channelId:"media",status:"blocked",inspectionMode:"superficial",
    enforcementData:JSON.stringify({deletion:"deleted",timeout:"applied_1h"})};
  const payload=buildMediaLog(row),content=JSON.stringify(payload.embeds);
  assert.equal(payload.components,undefined);
  assert.equal(payload.flags,undefined);
  assert.match(content,/sem republicação/);
  assert.match(content,/Castigo de 1 hora aplicado/);
  assert.doesNotMatch(content,/aprovada e republicada/);
});
