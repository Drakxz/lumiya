const test=require("node:test");
const assert=require("node:assert/strict");
const {DatabaseSync}=require("node:sqlite");
const {EventEmitter}=require("node:events");
const {randomUUID}=require("node:crypto");
const fs=require("node:fs/promises");
const {ChannelType}=require("discord.js");
const install=require("../media-moderation");
function fixture(t,{fail=false}={}){
  const db=new DatabaseSync(":memory:"),client=new EventEmitter(),sent=[],notices=[];let analyses=0;
  const guildId=randomUUID(),guild={id:guildId,members:{fetch:async()=>({user:{bot:false}})}};
  const channel={guildId,id:"watched",isTextBased:()=>true,send:async p=>{sent.push(p);return {id:randomUUID()};}};
  client.channels={fetch:async()=>channel};client.users={fetch:async()=>({send:async p=>notices.push(p)})};
  const moderationProcessor={configured:true,model:"omni-moderation-latest",async moderate(){analyses++;if(fail)throw new Error("connection failure");return {decision:"approved",reason:"Mock API approved",categories:[],analysisMs:12,rawResults:[]};}};
  const registry={register(){},preserveMessage(){}};
  const system=install({client,registry,db,moderationProcessor});const s=system.store.settings(guildId);s.enabled=true;system.store.saveSettings(guildId,s);system.store.setChannel(guildId,"watched","channel",true);
  const bytes=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWoQAAAAASUVORK5CYII=","base64");
  const previous=global.fetch;global.fetch=async()=>new Response(bytes);
  t.after(async()=>{global.fetch=previous;for(const r of db.prepare("SELECT filePath FROM media_moderation_cases WHERE filePath IS NOT NULL").all())await fs.rm(r.filePath,{force:true});db.close();});
  const message=(n=1)=>({id:randomUUID(),guildId,guild,channelId:"watched",author:{id:"user"},content:"safe mock caption",attachments:new Map(Array.from({length:n},(_,i)=>[String(i),{url:"https://cdn.discordapp.com/a.png",name:"a.png",size:bytes.length,contentType:"image/png"}])),async delete(){}});
  return {db,system,client,registry,moderationProcessor,sent,notices,message,bytes,analyses:()=>analyses};
}
test("exact chat channels are monitored automatically without manual registration",async t=>{
  const f=fixture(t),m=f.message();
  f.system.store.setChannel(m.guildId,m.channelId,"channel",false);
  m.channel={name:"chat",type:ChannelType.GuildText};
  await f.system.onMessage(m);
  assert.equal(f.analyses(),1);
  assert.equal(f.db.prepare("SELECT status FROM media_moderation_cases").get().status,"approved");
  assert.deepEqual(f.system.store.channels(m.guildId),[]);
});
test("automatic chat monitoring follows exact current name and supported channel type",async t=>{
  const f=fixture(t),base=f.message();
  f.system.store.setChannel(base.guildId,base.channelId,"channel",false);
  for(const name of ["chat-geral","bate-chat","💬chat","Chat"," chat","chat "]){
    await f.system.onMessage({...f.message(),channel:{name,type:ChannelType.GuildText}});
  }
  for(const type of [ChannelType.GuildCategory,ChannelType.GuildVoice,ChannelType.PublicThread]){
    await f.system.onMessage({...f.message(),channel:{name:"chat",type}});
  }
  assert.equal(f.analyses(),0);
  const channel={name:"outro",type:ChannelType.GuildAnnouncement};
  await f.system.onMessage({...f.message(),channel});
  channel.name="chat";
  await f.system.onMessage({...f.message(),channel});
  channel.name="outro";
  await f.system.onMessage({...f.message(),channel});
  assert.equal(f.analyses(),1);
});
test("automatic chat monitoring respects exclusions and disabled system",async t=>{
  const f=fixture(t),m=f.message();
  f.system.store.setChannel(m.guildId,m.channelId,"channel",false);
  m.channel={name:"chat",type:ChannelType.GuildText};
  f.system.store.setChannel(m.guildId,m.channelId,"exclude",true);
  await f.system.onMessage(m);
  f.system.store.setChannel(m.guildId,m.channelId,"exclude",false);
  const settings=f.system.store.settings(m.guildId);settings.enabled=false;f.system.store.saveSettings(m.guildId,settings);
  await f.system.onMessage(m);
  assert.equal(f.analyses(),0);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM media_moderation_cases").get().n,0);
});
test("multiple attachments captured before deleted-message response; originals repost once, no bot loops",async t=>{
  const f=fixture(t),m=f.message(2);m.delete=async()=>{assert.equal(f.db.prepare("SELECT COUNT(*) n FROM media_moderation_cases WHERE filePath IS NOT NULL").get().n,2);throw Object.assign(new Error("already deleted"),{code:10008});};
  await f.system.onMessage(m);await f.system.onMessage(m);assert.equal(f.sent.length,2);assert.equal(f.analyses(),2);
  for(const p of f.sent){assert.deepEqual(p.files[0].attachment,f.bytes);assert.equal(p.enforceNonce,true);await f.system.onMessage({...m,id:randomUUID(),author:{id:"bot",bot:true}});}
  assert.equal(f.analyses(),2);for(const row of f.db.prepare("SELECT * FROM media_moderation_cases").all()){assert.equal(row.provider,"OpenAI");assert.equal(row.analysisMs,12);assert.equal(row.filePath,null);assert.equal(row.status,"approved");}
});
test("connection failures retain originals and notify technical review, not confirmed violations",async t=>{
  const f=fixture(t,{fail:true});await f.system.onMessage(f.message());const r=f.db.prepare("SELECT * FROM media_moderation_cases").get();assert.equal(r.status,"review");assert.equal(r.errorKind,"technical");assert.deepEqual(await fs.readFile(r.filePath),f.bytes);assert.equal(f.sent.length,0);assert.equal(f.notices.length,1);
});
test("Instagram forces full protection even when moderation is disabled or channel is superficial",async t=>{
  const f=fixture(t),m=f.message();
  const settings=f.system.store.settings(m.guildId);settings.enabled=false;settings.superficialChannelIds=["watched"];f.system.store.saveSettings(m.guildId,settings);
  f.db.prepare("INSERT INTO instagram_settings VALUES(?,?)").run(m.guildId,"watched");
  let deleted=false;m.delete=async()=>{deleted=true;};
  await f.system.onMessage(m);
  assert.equal(deleted,true);assert.equal(f.analyses(),1);assert.equal(f.sent.length,1);
  assert.equal(f.notices.length,0);
  const json=JSON.stringify(f.sent.find(p=>p.files).components[0].toJSON());
  assert.match(json,/insta:like:/);assert.match(json,/insta:comment:/);assert.doesNotMatch(json,/insta:delete:/);
  assert.equal(f.db.prepare("SELECT authorId FROM instagram_posts").get().authorId,"user");
});
test("Instagram never publishes after analysis failure",async t=>{
  const f=fixture(t,{fail:true}),m=f.message();
  f.db.prepare("INSERT INTO instagram_settings VALUES(?,?)").run(m.guildId,"watched");
  await f.system.onMessage(m);
  assert.equal(f.sent.filter(p=>p.files).length,0);assert.equal(f.db.prepare("SELECT COUNT(*) n FROM instagram_posts").get().n,0);
  assert.equal(f.db.prepare("SELECT status FROM media_moderation_cases").get().status,"review");
});

function connectInstagram(f,m){
  const published=[];
  const sourceFetch=f.client.channels.fetch;
  const destination={id:"instagram-feed",guildId:"destination-guild",isTextBased:()=>true,send:async payload=>{published.push(payload);return {id:"published-post"};}};
  f.client.channels.fetch=async id=>id===destination.id?destination:sourceFetch(id);
  f.db.prepare("INSERT INTO instagram_settings VALUES(?,?)").run(destination.guildId,destination.id);
  f.db.prepare("INSERT INTO instagram_sources VALUES(?,?,?)").run(destination.guildId,m.guildId,m.channelId);
  const settings=f.system.store.settings(m.guildId);
  settings.enabled=false;settings.superficialChannelIds=[m.channelId];f.system.store.saveSettings(m.guildId,settings);
  f.system.store.setChannel(m.guildId,m.channelId,"channel",false);
  return {published,destination};
}

function useThread(f,m,type=ChannelType.PublicThread){
  const parent={id:"watched",guildId:m.guildId,type:ChannelType.GuildText,parentId:"category",name:"parent"};
  const fetch=f.client.channels.fetch;
  const thread={id:"thread",guildId:m.guildId,type,parentId:parent.id,parent,
    isTextBased:()=>true,send:async payload=>{f.sent.push(payload);return {id:randomUUID()};}};
  m.channelId=thread.id;m.channel=thread;
  f.client.channels.fetch=async id=>id===thread.id?thread:fetch(id);
  return {parent,thread};
}

for(const type of [ChannelType.PublicThread,ChannelType.PrivateThread,ChannelType.AnnouncementThread]){
  test(`threads of type ${type} inherit full protection from the parent and keep approved media in the thread`,async t=>{
    const f=fixture(t),m=f.message();
    const {thread}=useThread(f,m,type);
    let deleted=false;m.delete=async()=>{deleted=true;};
    await f.system.onMessage(m);
    assert.equal(deleted,true);assert.equal(f.analyses(),1);
    const row=f.db.prepare("SELECT * FROM media_moderation_cases").get();
    assert.equal(row.channelId,thread.id);assert.equal(row.status,"approved");
    assert.equal(f.sent.filter(p=>p.files).length,1);
  });
}

test("forum posts inherit category protection even when the parent must be fetched",async t=>{
  const f=fixture(t),m=f.message(),{parent,thread}=useThread(f,m);
  parent.type=ChannelType.GuildForum;thread.parent=null;
  m.guild.channels={fetch:async id=>{assert.equal(id,parent.id);return parent;}};
  f.system.store.setChannel(m.guildId,parent.id,"channel",false);
  f.system.store.setChannel(m.guildId,"category","category",true);
  await f.system.onMessage(m);
  assert.equal(f.analyses(),1);
  assert.equal(f.db.prepare("SELECT status FROM media_moderation_cases").get().status,"approved");
});

test("threads respect exclusions on themselves and their parent and are not globally monitored",async t=>{
  const f=fixture(t),m=f.message(),{parent,thread}=useThread(f,m);
  f.system.store.setChannel(m.guildId,thread.id,"exclude",true);
  await f.system.onMessage(m);
  f.system.store.setChannel(m.guildId,thread.id,"exclude",false);
  f.system.store.setChannel(m.guildId,parent.id,"exclude",true);
  await f.system.onMessage(m);
  f.system.store.setChannel(m.guildId,parent.id,"exclude",false);
  f.system.store.setChannel(m.guildId,parent.id,"channel",false);
  await f.system.onMessage(m);
  assert.equal(f.analyses(),0);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM media_moderation_cases").get().n,0);
});

test("threads inherit superficial mode and automatic chat monitoring",async t=>{
  const f=fixture(t),m=f.message(),{parent}=useThread(f,m);
  f.system.store.setChannel(m.guildId,parent.id,"channel",false);
  parent.name="chat";
  assert.equal(f.system.isMonitored(m),true);
  parent.name="other";
  const settings=f.system.store.settings(m.guildId);settings.superficialChannelIds=[parent.id];
  f.system.store.saveSettings(m.guildId,settings);
  assert.equal(f.system.isSuperficial(m),true);
  assert.equal(f.system.isMonitored(m),true);
});

test("bot joins monitored active threads only, without reopening archived threads or duplicating joins",async t=>{
  const f=fixture(t),m=f.message(),{thread}=useThread(f,m);
  let joined=0;
  thread.guild=m.guild;
  thread.join=async()=>{joined++;};
  await Promise.all([f.system.watchThread(thread),f.system.watchThread(thread)]);
  assert.equal(joined,1);
  thread.archived=true;
  await f.system.watchThread(thread);
  thread.archived=false;thread.parentId="unmonitored";thread.parent={id:"unmonitored",parentId:"other-category"};
  await f.system.watchThread(thread);
  assert.equal(joined,1);
});

for(const decision of ["approved","blocked","review"]){
  test(`Instagram source threads route only approved media to the destination (${decision})`,async t=>{
    const f=fixture(t),m=f.message(),{published}=connectInstagram(f,m);
    useThread(f,m);
    f.moderationProcessor.moderate=async()=>({decision,reason:"mock",categories:decision==="blocked"?["sexual"]:[]});
    assert.equal(f.system.isSuperficial(m),false);
    await f.system.onMessage(m);
    assert.equal(published.length,decision==="approved"?1:0);
    assert.equal(f.sent.filter(p=>p.files).length,0);
    const row=f.db.prepare("SELECT * FROM media_moderation_cases").get();
    assert.equal(row.channelId,"thread");
    assert.equal(row.status,decision==="review"?"review":decision);
    assert.equal(f.db.prepare("SELECT sourceChannelId FROM instagram_deliveries WHERE caseId=?").get(row.id).sourceChannelId,"watched");
  });
}

test("remote Instagram analyses fully in the source and publishes only in the destination",async t=>{
  const f=fixture(t),m=f.message(),{published,destination}=connectInstagram(f,m);
  let deleted=false;m.delete=async()=>{deleted=true;assert.equal(published.length,0);};
  await f.system.onMessage(m);
  assert.equal(deleted,true);assert.equal(f.analyses(),1);
  assert.equal(f.sent.length,0);assert.equal(published.length,1);
  assert.deepEqual(published[0].files[0].attachment,f.bytes);
  const post=f.db.prepare("SELECT * FROM instagram_posts").get();
  assert.equal(post.guildId,destination.guildId);assert.equal(post.channelId,destination.id);
  assert.equal(post.authorId,m.author.id);assert.equal(post.sourceId,m.id);
  const row=f.db.prepare("SELECT * FROM media_moderation_cases").get();
  assert.equal(row.guildId,m.guildId);assert.equal(row.channelId,m.channelId);assert.equal(row.status,"approved");
  await f.system.onMessage(m);
  await f.system.onMessage({...m,id:randomUUID(),author:{id:"bot",bot:true}});
  assert.equal(published.length,1);
});

for(const decision of ["blocked","review","failure"]){
  test(`remote Instagram never publishes ${decision} media`,async t=>{
    const f=fixture(t),m=f.message(),{published}=connectInstagram(f,m);
    f.moderationProcessor.moderate=async()=>{
      if(decision==="failure")throw new Error("Offline");
      return {decision,reason:"mock",categories:decision==="blocked"?["sexual"]:[]};
    };
    await f.system.onMessage(m);
    assert.equal(published.length,0);assert.equal(f.sent.length,0);
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM instagram_posts").get().n,0);
    assert.equal(f.db.prepare("SELECT status FROM media_moderation_cases").get().status,decision==="blocked"?"blocked":"review");
  });
}

test("changing a remote route during analysis holds the media instead of misrouting it",async t=>{
  const f=fixture(t),m=f.message(),{published}=connectInstagram(f,m);
  f.moderationProcessor.moderate=async()=>{
    f.db.prepare("UPDATE instagram_settings SET channelId='different-feed'").run();
    return {decision:"approved",reason:"mock",categories:[]};
  };
  await f.system.onMessage(m);
  assert.equal(published.length,0);assert.equal(f.sent.length,0);
  const row=f.db.prepare("SELECT * FROM media_moderation_cases").get();
  assert.equal(row.status,"review");assert.ok(row.filePath);
});

test("human approval keeps the remote destination after an inconclusive analysis",async t=>{
  const f=fixture(t),m=f.message(),{published}=connectInstagram(f,m);
  f.moderationProcessor.moderate=async()=>({decision:"review",reason:"mock",categories:[]});
  await f.system.onMessage(m);
  const row=f.db.prepare("SELECT * FROM media_moderation_cases").get();
  assert.equal(published.length,0);
  await f.system.onInteraction({
    customId:`mds-media-review:approve:${row.id}`,guildId:m.guildId,guild:m.guild,
    inGuild:()=>true,user:{id:"reviewer"},member:{permissions:{has:()=>true}},
    deferUpdate:async()=>{},editReply:async()=>{},reply:async()=>{}
  });
  assert.equal(published.length,1);
  assert.equal(f.db.prepare("SELECT status FROM media_moderation_cases").get().status,"approved");
  assert.equal(f.sent.length,0);
});
test("oversized file never downloads; suspicious child safety never sent to API",async t=>{
  const f=fixture(t);global.fetch=async()=>assert.fail("no download allowed");const large=f.message();large.attachments.get("0").size=200*1024*1024;await f.system.onMessage(large);
  const suspect=f.message();suspect.content="abuso sexual infantil";await f.system.onMessage(suspect);assert.equal(f.analyses(),0);assert.equal(f.sent.length,0);assert.equal(f.db.prepare("SELECT COUNT(*) n FROM media_moderation_cases WHERE status='review'").get().n,2);
});
test("restart converts interrupted processing to review without discarding historical metadata",async t=>{
  const f=fixture(t);await f.system.onMessage(f.message());const before=f.db.prepare("SELECT * FROM media_moderation_cases").get();f.db.prepare("UPDATE media_moderation_cases SET status='processing',provider='Gemini',model='historical-model'").run();
  install({client:new EventEmitter(),registry:f.registry,db:f.db,moderationProcessor:f.moderationProcessor});const after=f.db.prepare("SELECT * FROM media_moderation_cases").get();assert.equal(after.status,"review");assert.equal(after.provider,"Gemini");assert.equal(after.model,"historical-model");assert.equal(after.id,before.id);
});
test("native forwarded attachments and captions are captured before deleting only the destination message",async t=>{
  const f=fixture(t),m=f.message(0),analysed=[];let deleted=0,downloads=0;
  const snapshot={id:"source-message",content:"Legenda original encaminhada",author:{id:"source-author",bot:true},attachments:new Map([
    ["one",{id:"one",url:"https://cdn.discordapp.com/forwarded.png",name:"forwarded.png",contentType:"image/png",size:f.bytes.length}],
    ["two",{id:"two",url:"https://cdn.discordapp.com/forwarded.webp",name:"forwarded.webp",contentType:"image/webp",size:f.bytes.length}]
  ]),delete:async()=>assert.fail("Source must never be deleted")};
  m.messageSnapshots=new Map([[snapshot.id,snapshot]]);
  global.fetch=async()=>{assert.equal(deleted,0);downloads++;return new Response(f.bytes);};
  m.delete=async()=>{deleted++;assert.equal(downloads,2);assert.equal(f.db.prepare("SELECT COUNT(*) n FROM media_moderation_cases WHERE filePath IS NOT NULL").get().n,2);};
  f.moderationProcessor.moderate=async(buffer,mime,settings,caption)=>{analysed.push({buffer,caption});return {decision:"approved",reason:"mock approved",categories:[]};};
  await f.system.onMessage(m);await f.system.onMessage(m);
  assert.equal(deleted,1);assert.equal(analysed.length,2);assert.equal(f.sent.length,2);
  for(const a of analysed){assert.deepEqual(a.buffer,f.bytes);assert.match(a.caption,/safe mock caption/);assert.match(a.caption,/Legenda original encaminhada/);}
  for(const row of f.db.prepare("SELECT * FROM media_moderation_cases").all()){assert.equal(row.authorId,"user");assert.equal(row.originalMessageId,m.id);assert.equal(row.channelId,"watched");}
  assert.equal(m.attachments.size,0);assert.equal(m.content,"safe mock caption");assert.equal(snapshot.attachments.size,2);
});
test("forwarded media uses existing blocks and bot/channel exclusions, without forwarding loops",async t=>{
  const f=fixture(t),m=f.message(0),attachment={id:"one",url:"https://cdn.discordapp.com/a.png",name:"a.png",size:f.bytes.length,contentType:"image/png"};
  m.messageSnapshots=new Map([["source",{content:"original caption",attachments:new Map([["one",attachment]])}]]);
  await f.system.onMessage({...m,author:{id:"bot",bot:true}});await f.system.onMessage({...m,channelId:"unmonitored"});assert.equal(f.db.prepare("SELECT COUNT(*) n FROM media_moderation_cases").get().n,0);
  f.moderationProcessor.moderate=async()=>({decision:"blocked",reason:"mock flagged category",categories:["sexual"]});
  await f.system.onMessage(m);assert.equal(f.sent.length,0);assert.equal(f.db.prepare("SELECT status FROM media_moderation_cases").get().status,"blocked");
});
test("forwarded child-safety signals are checked before downloading or calling the provider",async t=>{
  const f=fixture(t),m=f.message(0);m.messageSnapshots=new Map([["source",{content:"conteúdo +18 envolvendo menores",attachments:new Map([["a",{url:"https://cdn.discordapp.com/a.png",name:"a.png",size:10,contentType:"image/png"}]])}]]);
  global.fetch=async()=>assert.fail("Must not download suspected content");await f.system.onMessage(m);
  assert.equal(f.analyses(),0);assert.equal(f.sent.length,0);assert.equal(f.db.prepare("SELECT status FROM media_moderation_cases").get().status,"review");
});
