const test=require("node:test");
const assert=require("node:assert/strict");
const {DatabaseSync}=require("node:sqlite");
const {EventEmitter}=require("node:events");
const {Collection,PermissionsBitField,PermissionFlagsBits:P,UserFlagsBitField}=require("discord.js");
const {randomBytes,createHash}=require("node:crypto");
const fs=require("node:fs/promises");
const path=require("node:path");
const os=require("node:os");
const sharp=require("sharp");
const {createServer}=require("../instagram-web");
const G="100000000000000001",U="100000000000000002",C="100000000000000003",B="100000000000000004";
async function fixture(t,{blocked=false,severe=false,apiError=false,discordError=false,identifyPremium=false,premiumGranted=true,premiumType,profileProvider}={}){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"iw-test-"));
  const db=new DatabaseSync(":memory:"),client=new EventEmitter();
  const perms=new PermissionsBitField([P.ViewChannel,P.SendMessages,P.AttachFiles,P.ReadMessageHistory]);
  const member={id:U,user:{username:"member"},displayName:"Pessoa",joinedTimestamp:Date.now()-86400000,
    displayAvatarURL:()=>"https://cdn.discordapp.com/embed/avatars/0.png",roles:{cache:new Collection()},permissions:new PermissionsBitField([])};
  const me={id:B,permissions:perms};
  const sent=[],checks=[];
  const messages=new Collection();
  const channel={id:C,guildId:G,type:0,isTextBased:()=>true,isThread:()=>false,permissionsFor:()=>perms,messages:{fetch:async id=>{
    if(messages.has(id))return messages.get(id);throw Object.assign(new Error(),{code:10008});
  }},send:async payload=>{
    if(discordError)throw new Error("transport unavailable");
    sent.push(payload);const id=String(100000000000000098n+BigInt(sent.length)),message={id,attachments:new Collection(payload.files.map((f,n)=>[String(n),{url:"https://cdn.discordapp.com/attachments/test/"+f.name}])),
      edit:async p=>{message.lastEdit=p;return message;},delete:async()=>{messages.delete(id);client.emit("messageDelete",{id});}};
    messages.set(id,message);return message;
  }};
  const guild={id:G,name:"Comunidade de teste",ownerId:"100000000000000009",iconURL:()=>null,
    roles:{everyone:{id:G},fetch:async id=>id?{id,name:"Cargo"}:new Collection()},
    members:{fetch:async()=>{if(member.outside)throw Object.assign(new Error(),{code:10007});return member;},fetchMe:async()=>me},
    channels:{fetch:async id=>id?channel:new Collection([[C,channel]])}};
  channel.guild=guild;
  client.isReady=()=>true;client.user={id:B};client.guilds={cache:new Collection([[G,guild]]),fetch:async()=>guild};
  client.channels={fetch:async()=>channel};client.users={cache:new Collection()};
  const instagram=require("../instagram")({client,db,registry:{register(){},preserveMessage(){}}});
  db.prepare("INSERT INTO instagram_settings VALUES(?,?)").run(G,C);
  const env={DISCORD_CLIENT_ID:B,DISCORD_CLIENT_SECRET:"oauth-test-secret",DISCORD_GUILD_ID:G,DISCORD_IDENTIFY_PREMIUM_ENABLED:String(identifyPremium),
    DISCORD_REDIRECT_URI:"http://localhost/api/auth/discord/callback",APP_URL:"http://localhost",
    SESSION_SECRET:"a".repeat(64),OPENAI_API_KEY:"test-only",STORAGE_PATH:root};
  const moderation={model:"omni-moderation-latest",classify:async(input,modality,onRequest)=>{
    onRequest();checks.push({input,modality});
    if(apiError)throw Object.assign(new Error("secret-provider-body"),{kind:"transient"});
    return {flagged:blocked||severe,categories:{"sexual/minors":severe,sexual:blocked},category_scores:{sexual:blocked?1:0},
      category_applied_input_types:{sexual:[modality],"sexual/minors":[modality]},modality};
  }};
  const oauthCalls=[];
  const fetchImpl=async(url,opts)=>{
    oauthCalls.push({url,opts});
    if(url.endsWith("/token"))return Response.json({access_token:"oauth-private",token_type:"Bearer",scope:identifyPremium&&premiumGranted?"identify identify.premium":"identify"});
    if(url.endsWith("/@me"))return Response.json({id:U,username:"member",avatar:null,...(premiumType===undefined?{}:{premium_type:premiumType})});
    return Response.json({});
  };
  const server=await createServer({client,db,instagram,env,moderation,fetchImpl,profileProvider});
  await server.app.ready();
  const raw=randomBytes(32).toString("hex"),csrf=randomBytes(32).toString("hex");
  const hash=createHash("sha256").update(raw).digest("hex");
  db.prepare("INSERT INTO iw_users VALUES(?,?,?,?)").run(U,JSON.stringify({id:U,username:"member"}),"{}",Date.now());
  db.prepare("INSERT INTO iw_sessions VALUES(?,?,?,?,?)").run(hash,U,csrf,Date.now(),Date.now()+3600000);
  const headers={cookie:"iw_session="+raw,origin:env.APP_URL,"x-csrf-token":csrf};
  t.after(async()=>{await server.app.close();db.close();await fs.rm(root,{recursive:true,force:true});});
  async function upload({color="blue",caption="Meu momento",handle="pessoa",files=1,key=randomBytes(16).toString("hex"),buffer,filename="foto.png",mime="image/png",guildId}={}){
    const bound="boundary"+randomBytes(8).toString("hex");
    const chunks=[Buffer.from(`--${bound}\r\nContent-Disposition: form-data; name="data"\r\n\r\n${JSON.stringify({caption,handle,consent:true})}\r\n`)];
    for(let n=0;n<files;n++){
      const img=buffer||await sharp({create:{width:80+n,height:60,channels:3,background:color}}).png().toBuffer();
      chunks.push(Buffer.from(`--${bound}\r\nContent-Disposition: form-data; name="images"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`),img,Buffer.from("\r\n"));
    }
    chunks.push(Buffer.from(`--${bound}--\r\n`));
    return server.app.inject({method:"POST",url:"/api/publications"+(guildId?`?guildId=${guildId}`:""),headers:{...headers,"content-type":`multipart/form-data; boundary=${bound}`,"idempotency-key":key},payload:Buffer.concat(chunks)});
  }
  return {...server,instagram,db,client,guild,member,channel,sent,checks,headers,upload,root,hash,oauthCalls};
}
test("featured photos keep primary-guild scope and personal ownership",async t=>{
  const f=await fixture(t);
  const add=(id,author,message)=>f.db.prepare("INSERT INTO instagram_posts(id,guildId,channelId,messageId,authorId,filename,caption) VALUES(?,?,?,?,?,?,?)").run(id,G,C,message,author,"photo.jpg","");
  add("own",U,"100000000000000099");
  add("other","100000000000000088","100000000000000100");
  f.channel.messages.fetch=async id=>({author:{id:B},attachments:new Collection([["photo",{name:"photo.jpg",url:`https://cdn.discordapp.com/attachments/${C}/${id}/photo.jpg`}]])});
  const publicPhoto=await f.app.inject({url:"/api/latest-photo?guildId=200000000000000001"});
  assert.equal(publicPhoto.statusCode,302);
  assert.match(publicPhoto.headers.location,/100000000000000100/);
  assert.equal(publicPhoto.headers["cache-control"],"no-store");
  assert.equal((await f.app.inject({url:"/api/me/latest-photo"})).statusCode,401);
  const personal=await f.app.inject({url:"/api/me/latest-photo?authorId=100000000000000088",headers:f.headers});
  assert.equal(personal.statusCode,302);
  assert.match(personal.headers.location,/100000000000000099/);
  assert.equal(personal.headers["cache-control"],"private, no-store");
  f.member.outside=true;
  assert.equal((await f.app.inject({url:"/api/me/latest-photo",headers:f.headers})).statusCode,403);
});
test("web is opt-in and incomplete configuration fails closed",async()=>{
  assert.deepEqual(require("../instagram-web")({env:{}}),{enabled:false});
  await assert.rejects(createServer({env:{}}),/DISCORD_CLIENT_ID/);
});
test("static requests do not exhaust the API quota, while API requests remain rate limited",async t=>{
  const f=await fixture(t);
  for(let n=0;n<65;n++){
    const asset=await f.app.inject({url:"/discord-badges/early_supporter.png",headers:f.headers});
    // An unbuilt checkout may not serve the frontend yet; neither outcome may consume API quota.
    assert.ok([200,404].includes(asset.statusCode),`Unexpected static response: ${asset.statusCode}`);
  }
  for(let n=0;n<60;n++)assert.equal((await f.app.inject({url:"/api/health",headers:f.headers})).statusCode,200);
  assert.equal((await f.app.inject({url:"/api/health",headers:f.headers})).statusCode,429);
});
test("OAuth uses identify, state, PKCE, HttpOnly cookie and creates a token-free session",async t=>{
  const f=await fixture(t);
  const login=await f.app.inject({url:"/api/auth/discord"});
  const redirect=new URL(login.headers.location);
  assert.equal(redirect.searchParams.get("scope"),"identify");assert.equal(redirect.searchParams.get("code_challenge_method"),"S256");
  assert.ok(login.headers["set-cookie"].includes("HttpOnly"));assert.ok(login.headers["set-cookie"].includes("SameSite=Lax"));
  const cookie=login.cookies[0];
  const response=await f.app.inject({url:"/api/auth/discord/callback?code=test&state="+redirect.searchParams.get("state"),headers:{cookie:`${cookie.name}=${cookie.value}`}});
  assert.equal(response.statusCode,302);assert.equal(response.headers.location,"/app");
  assert.equal(f.oauthCalls.length,3);
  assert.equal(f.oauthCalls[0].opts.body.get("code_verifier").length,43);
  assert.equal(f.oauthCalls[0].opts.body.get("client_secret"),"oauth-test-secret");
  assert.ok(!JSON.stringify(f.db.prepare("SELECT * FROM iw_users").all()).includes("oauth-private"));
  const invalid=await f.app.inject({url:"/api/auth/discord/callback?code=x&state=wrong"});
  assert.equal(invalid.statusCode,400);
});
for(const options of [
  {identifyPremium:true,premiumGranted:true,premiumType:2},
  {identifyPremium:false,premiumGranted:true,premiumType:2},
  {identifyPremium:true,premiumGranted:false,premiumType:2},
  {identifyPremium:true,premiumGranted:true,premiumType:0},
  {identifyPremium:true,premiumGranted:true,premiumType:99}
])test(`Nitro OAuth metadata respects explicit consent and valid values: ${JSON.stringify(options)}`,async t=>{
  const f=await fixture(t,options),login=await f.app.inject({url:"/api/auth/discord"}),redirect=new URL(login.headers.location);
  assert.equal(redirect.searchParams.get("scope"),options.identifyPremium?"identify identify.premium":"identify");
  const cookie=login.cookies[0];
  const response=await f.app.inject({url:`/api/auth/discord/callback?code=test&state=${redirect.searchParams.get("state")}`,headers:{cookie:`${cookie.name}=${cookie.value}`}});
  assert.equal(response.statusCode,302,response.body);
  const nitro=f.store.profile(U).nitro;
  if(options.identifyPremium&&options.premiumGranted&&[0,1,2,3].includes(options.premiumType)){
    assert.equal(nitro.type,options.premiumType);assert.ok(Date.now()-nitro.checkedAt<5000);
  }else assert.equal(nitro,undefined);
  assert.ok(!JSON.stringify(f.db.prepare("SELECT * FROM iw_users").all()).includes("oauth-private"));
});
test("native account badges include confirmed Nitro and local boost, without guessing global tiers or subscription status",async t=>{
  const f=await fixture(t),describe=require("../instagram-web/profile");
  const ctx={guild:f.guild,admin:false,moderator:false,vip:false};
  f.member.premiumSinceTimestamp=Date.now()-86400000;
  f.member.displayBannerURL=()=>"https://cdn.discordapp.com/banners/test/a_example.gif";
  f.member.user.avatar="a_animated-avatar";
  let result=describe(f.member,ctx);
  assert.deepEqual(result.accountBadges.map(b=>b.id),["discord:Boost"]);
  assert.match(result.accountBadges[0].description,/não informa o nível global/);
  result=describe(f.member,ctx,f.member.user,{nitro:{type:2,checkedAt:Date.now()}});
  assert.ok(result.accountBadges.some(b=>b.id==="discord:Nitro"));
  for(const nitro of [{type:0,checkedAt:Date.now()},{type:99,checkedAt:Date.now()},{type:2,checkedAt:Date.now()-13*3600000},{type:2,checkedAt:Date.now()+3600000}]){
    assert.ok(!describe(f.member,ctx,f.member.user,{nitro}).accountBadges.some(b=>b.id==="discord:Nitro"));
  }
  f.member.user.flags=new UserFlagsBitField(["PremiumEarlySupporter"]);
  result=describe(f.member,ctx);
  assert.ok(result.accountBadges.some(b=>b.id==="discord:PremiumEarlySupporter"&&b.label==="Apoiador inicial"));
  assert.ok(!result.accountBadges.some(b=>b.id==="discord:Nitro"));
});
test("profile cosmetic badges use the visible-profile lookup without changing permissions or trusting browser data",async t=>{
  const calls=[],checkedAt=Date.now(),icon="a".repeat(32);
  const profileProvider={enabled:true,visuals:async(gid,uid)=>{
    calls.push([gid,uid]);
    return {status:"available",checkedAt,badges:[{id:"native:nitro",kind:"discord",label:"Discord Nitro",description:"Nitro visível no perfil.",icon:`https://cdn.discordapp.com/badge-icons/${icon}.png`}]};
  }};
  const f=await fixture(t,{profileProvider});
  f.member.premiumSinceTimestamp=Date.now()-10000;
  const response=await f.app.inject({url:"/api/profile",headers:f.headers});
  assert.equal(response.statusCode,200,response.body);
  const body=response.json();
  assert.equal(body.accountBadgesSource,"visible-profile");
  assert.equal(body.accountBadgesCheckedAt,checkedAt);
  assert.deepEqual(body.accountBadges.map(b=>b.id),["native:nitro","discord:Boost"]);
  assert.equal(body.admin,false);assert.equal(body.canManageGuilds,false);
  assert.deepEqual(calls,[[G,U]]);
  // The public identity endpoint never triggers the extra lookup.
  assert.equal((await f.app.inject({url:"/api/auth/me",headers:f.headers})).json().accountBadgesSource,undefined);
  // The local boost fallback is not duplicated when the visible profile already shows one.
  profileProvider.visuals=async()=>({status:"available",checkedAt,badges:[{id:"native:booster",kind:"discord",label:"Server Booster",description:"Impulsionador.",icon:`https://cdn.discordapp.com/badge-icons/${icon}.png`}]});
  assert.deepEqual((await f.app.inject({url:"/api/profile",headers:f.headers})).json().accountBadges.map(b=>b.id),["native:booster"]);
  // Provider failures fall back to the official API without breaking the page.
  profileProvider.visuals=async()=>{throw new Error("secondary account unavailable");};
  const fallback=(await f.app.inject({url:"/api/profile",headers:f.headers})).json();
  assert.equal(fallback.accountBadgesSource,"official-api");
  assert.ok(fallback.accountBadges.some(b=>b.id==="discord:Boost"));
});
test("sessions, CSRF, CORS, membership and actual Administrator permission are enforced",async t=>{
  const f=await fixture(t);
  assert.equal((await f.app.inject({url:"/api/profile"})).statusCode,401);
  const request=(url="/api/profile",headers=f.headers)=>f.app.inject({url,headers});
  assert.equal((await request()).statusCode,200);
  assert.equal((await request("/api/admin/settings")).statusCode,403);
  assert.equal((await f.app.inject({method:"POST",url:"/api/auth/logout",headers:{cookie:f.headers.cookie}})).statusCode,403);
  assert.equal((await request("/api/profile",{...f.headers,origin:"https://evil.example"})).statusCode,403);
  f.member.permissions=new PermissionsBitField([P.Administrator]);
  assert.equal((await request("/api/admin/settings")).statusCode,200);
  f.member.permissions=new PermissionsBitField([]);
  assert.equal((await request("/api/admin/settings")).statusCode,403);
  f.member.outside=true;
  assert.equal((await request()).statusCode,403);
  f.member.outside=false;
  f.db.prepare("UPDATE iw_sessions SET expiresAt=0").run();
  assert.equal((await request()).statusCode,401);
});
test("profile badges and role colors reflect real current server membership and public Discord flags",async t=>{
  const f=await fixture(t),rid="100000000000000015";
  f.member.roles.cache.set(rid,{id:rid,name:"Equipe VIP",hexColor:"#bbaaff",position:10});
  f.member.roles.cache.set("100000000000000016",{id:"100000000000000016",name:"Sem cor",hexColor:"invalid",position:1});
  f.member.user.flags=new UserFlagsBitField(["ActiveDeveloper"]);
  f.member.premiumSinceTimestamp=Date.now()-10000;
  f.store.saveSettings({...f.store.settings(),vipRoles:[rid],moderatorRoles:[rid]},U);
  const get=()=>f.app.inject({url:"/api/auth/me",headers:f.headers});
  const profile=(await get()).json();
  assert.deepEqual(profile.badges.map(b=>b.id),["member","moderator","vip","booster","discord:ActiveDeveloper"]);
  assert.equal(profile.roles[0].color,"#bbaaff");assert.equal(profile.roles[1].color,null);
  assert.ok(!profile.badges.some(b=>b.kind==="admin"||b.kind==="owner"));
  f.member.roles.cache.clear();f.member.premiumSinceTimestamp=null;f.member.user.flags=new UserFlagsBitField([]);
  assert.deepEqual((await get()).json().badges.map(b=>b.id),["member"]);
  f.member.permissions=new PermissionsBitField([P.Administrator]);
  assert.deepEqual((await get()).json().badges.map(b=>b.id),["member","admin"]);
  f.guild.ownerId=U;
  assert.deepEqual((await get()).json().badges.map(b=>b.id),["member","owner"]);
});
test("profile loads the real Discord banner on demand and retains a usable fallback if Discord fails",async t=>{
  const f=await fixture(t);let fetches=0;
  const banner="https://cdn.discordapp.com/banners/100000000000000002/example.png";
  f.member.user.fetch=async()=>{fetches++;return {bannerURL:()=>banner,flags:new UserFlagsBitField(["ActiveDeveloper"])};};
  assert.equal((await f.app.inject({url:"/api/auth/me",headers:f.headers})).json().banner,null);
  assert.equal(fetches,0);
  const profile=await f.app.inject({url:"/api/profile",headers:f.headers});
  assert.equal(profile.statusCode,200,profile.body);assert.equal(profile.json().banner,banner);assert.equal(fetches,1);
  assert.ok(profile.json().badges.some(b=>b.id==="discord:ActiveDeveloper"));
  f.member.user.fetch=async()=>{throw new Error("Discord unavailable");};
  const fallback=await f.app.inject({url:"/api/profile",headers:f.headers});
  assert.equal(fallback.statusCode,200);assert.equal(fallback.json().banner,null);assert.equal(fallback.json().badges[0].id,"member");
});
function addManagedGuild(f,{admin=true}={}){
  const gid="200000000000000001",cid="200000000000000003",rid="200000000000000005";
  const member={...f.member,permissions:new PermissionsBitField(admin?[P.Administrator]:[])};
  const channel={...f.channel,id:cid,guildId:gid,name:"instagram-outro"};
  const roles=new Collection([[rid,{id:rid,name:"Equipe do outro servidor"}]]);
  const guild={...f.guild,id:gid,name:"Outro servidor",roles:{everyone:{id:gid},fetch:async id=>id?roles.get(id):roles},
    members:{fetch:async()=>{if(member.outside)throw Object.assign(new Error(),{code:10007});return member;},fetchMe:f.guild.members.fetchMe},
    channels:{fetch:async id=>id?(id===cid?channel:null):new Collection([[cid,channel]])}};
  channel.guild=guild;
  f.client.guilds.cache.set(gid,guild);
  return {gid,cid,rid,guild,member};
}
test("server discovery lists only shared administered guilds, and supports admins outside the primary guild",async t=>{
  const f=await fixture(t),other=addManagedGuild(f);
  const get=url=>f.app.inject({url,headers:f.headers});
  assert.equal((await f.app.inject({url:"/api/admin/guilds"})).statusCode,401);
  let list=await get("/api/admin/guilds");
  assert.deepEqual(list.json().items.map(g=>g.id),[other.gid]);
  const me=(await get("/api/auth/me")).json();
  assert.equal(me.canManageGuilds,true);assert.equal(me.admin,false);assert.equal(me.adminOnly,false);
  f.member.outside=true;
  const external=await get("/api/auth/me");
  assert.equal(external.statusCode,200,external.body);assert.equal(external.json().adminOnly,true);
  assert.equal((await get("/api/publications")).statusCode,403);
  other.member.permissions=new PermissionsBitField([]);
  assert.deepEqual((await get("/api/admin/guilds")).json().items,[]);
  assert.equal((await get("/api/auth/me")).statusCode,403);
});
test("per-server settings validate channel and role ownership, enforce CSRF and live admin permission, and stay isolated",async t=>{
  const f=await fixture(t),other=addManagedGuild(f);
  const url=`/api/admin/guilds/${other.gid}/settings`;
  const initial=f.store.settings();
  const get=()=>f.app.inject({url,headers:f.headers});
  const update=(payload,headers=f.headers)=>f.app.inject({method:"PATCH",url,headers,payload});
  const response=await get();assert.equal(response.statusCode,200,response.body);
  const draft=response.json().settings;
  assert.equal(draft.channelId,"");assert.deepEqual(response.json().channels.map(c=>c.id),[other.cid]);
  assert.equal((await update({...draft,channelId:other.cid},{cookie:f.headers.cookie})).statusCode,403);
  assert.equal((await update({...draft,channelId:C})).statusCode,400);
  assert.equal((await update({...draft,channelId:other.cid,allowedRoles:[G]})).statusCode,400);
  assert.equal((await update({...draft,channelId:other.cid,logChannelId:C})).statusCode,400);
  const saved=await update({...draft,channelId:other.cid,allowedRoles:[other.rid],name:"Outro site"});
  assert.equal(saved.statusCode,200,saved.body);
  assert.equal(f.db.prepare("SELECT channelId FROM instagram_settings WHERE guildId=?").get(other.gid).channelId,other.cid);
  assert.equal(f.store.settings(other.gid).name,"Outro site");
  assert.deepEqual(f.store.settings(),initial);
  assert.equal(f.db.prepare("SELECT resourceId FROM iw_audit WHERE action='settings.changed'").get().resourceId,other.gid);
  other.member.permissions=new PermissionsBitField([]);
  assert.equal((await get()).statusCode,403);
  assert.equal((await update({...draft,channelId:other.cid})).statusCode,403);
  assert.equal((await f.app.inject({url:"/api/admin/guilds/300000000000000001/settings",headers:f.headers})).statusCode,403);
});
test("shared server discovery includes ordinary members, excludes outsiders, and requires authentication",async t=>{
  const f=await fixture(t),other=addManagedGuild(f,{admin:false});
  assert.equal((await f.app.inject({url:"/api/guilds"})).statusCode,401);
  const list=await f.app.inject({url:"/api/guilds",headers:f.headers});
  assert.equal(list.statusCode,200,list.body);
  assert.equal(list.json().csrf,f.headers["x-csrf-token"]);
  assert.deepEqual(new Set(list.json().items.map(g=>g.id)),new Set([G,other.gid]));
  assert.equal(list.json().items.find(g=>g.id===other.gid).admin,false);
  assert.equal(list.json().items.find(g=>g.id===other.gid).configured,false);
  other.member.outside=true;
  assert.deepEqual((await f.app.inject({url:"/api/guilds",headers:f.headers})).json().items.map(g=>g.id),[G]);
});
test("members outside the primary guild can select a shared guild; unconfigured servers never accept photos",async t=>{
  const f=await fixture(t),other=addManagedGuild(f,{admin:false});
  f.member.outside=true;
  const me=await f.app.inject({url:`/api/auth/me?guildId=${other.gid}`,headers:f.headers});
  assert.equal(me.statusCode,200,me.body);assert.equal(me.json().guildId,other.gid);assert.equal(me.json().adminOnly,false);
  assert.equal((await f.app.inject({url:`/api/status?guildId=${other.gid}`})).json().available,false);
  assert.equal((await f.upload({guildId:other.gid})).statusCode,503);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM iw_publications").get().n,0);
  assert.equal((await f.app.inject({url:"/api/publications?guildId=300000000000000001",headers:f.headers})).statusCode,403);
});
test("concurrent server requests and queued jobs keep destinations, quotas, history, previews and notifications isolated",async t=>{
  const f=await fixture(t),other=addManagedGuild(f,{admin:false});
  f.store.saveSettings({...f.store.settings(),cooldownSeconds:0,name:"Principal"},U);
  f.store.saveSettings({...f.store.settings(),channelId:other.cid,cooldownSeconds:0,name:"Secundário"},U,other.gid);
  const key=randomBytes(16).toString("hex");
  const [first,second]=await Promise.all([f.upload({key}),f.upload({key,guildId:other.gid})]);
  assert.equal(first.statusCode,202,first.body);assert.equal(second.statusCode,202,second.body);
  assert.equal(first.json().guildId,G);assert.equal(second.json().guildId,other.gid);
  assert.notEqual(first.json().id,second.json().id);
  await f.worker.tick();await f.worker.tick();
  const primary=f.store.publication(first.json().id);
  const secondary=f.db.prepare("SELECT * FROM iw_publications WHERE id=?").get(second.json().id);
  assert.equal(primary.state,"published");assert.equal(primary.channelId,C);
  assert.equal(secondary.state,"published");assert.equal(secondary.channelId,other.cid);
  assert.equal(f.db.prepare("SELECT guildId FROM instagram_submissions WHERE originalMessageId=?").get(`web:${secondary.id}`).guildId,other.gid);
  for(const [guildId,p,name] of [[G,primary,"Principal"],[other.gid,secondary,"Secundário"]]){
    const [status,list,me,notifications]=await Promise.all(["/api/status","/api/publications","/api/auth/me","/api/notifications"].map(url=>f.app.inject({url:`${url}?guildId=${guildId}`,headers:f.headers})));
    assert.equal(status.json().name,name);
    assert.deepEqual(list.json().items.map(p=>p.id),[p.id]);
    assert.equal(me.json().stats.published,1);
    assert.equal(notifications.json().items.length,1);
    assert.equal(notifications.json().items[0].publicationId,p.id);
    const img=f.store.images(p.id)[0];
    assert.equal((await f.app.inject({url:`/api/publications/${p.id}/images/${img.id}?guildId=${guildId}`,headers:f.headers})).statusCode,200);
    const wrongGuild=guildId===G?other.gid:G;
    assert.equal((await f.app.inject({url:`/api/publications/${p.id}?guildId=${wrongGuild}`,headers:f.headers})).statusCode,404);
    assert.equal((await f.app.inject({url:`/api/publications/${p.id}/images/${img.id}?guildId=${wrongGuild}`,headers:f.headers})).statusCode,404);
  }
});
test("restrictions, administrative activity and moderation access are scoped to the selected server",async t=>{
  const f=await fixture(t),other=addManagedGuild(f);
  f.member.permissions=new PermissionsBitField([P.Administrator]);
  f.store.saveSettings({...f.store.settings(),channelId:other.cid,cooldownSeconds:0},U,other.gid);
  f.db.prepare("INSERT INTO iw_restrictions VALUES(?,?,?,NULL)").run(U,Date.now()+3600000,"Apenas principal");
  const secondary=await f.upload({guildId:other.gid});
  assert.equal(secondary.statusCode,202,secondary.body);
  assert.equal((await f.upload()).statusCode,403);
  await f.worker.tick();
  const selected=await f.app.inject({url:`/api/admin/stats?guildId=${other.gid}`,headers:f.headers});
  assert.equal(selected.statusCode,200,selected.body);assert.equal(selected.json().states[0].count,1);
  assert.deepEqual((await f.app.inject({url:"/api/admin/stats",headers:f.headers})).json().states,[]);
  const logs=await f.app.inject({url:`/api/admin/logs?guildId=${other.gid}`,headers:f.headers});
  assert.ok(logs.json().items.some(l=>l.resourceId===secondary.json().id));
  assert.ok(!(await f.app.inject({url:"/api/admin/logs",headers:f.headers})).json().items.some(l=>l.resourceId===secondary.json().id));
  other.member.permissions=new PermissionsBitField([]);
  assert.equal((await f.app.inject({url:`/api/admin/publications?guildId=${other.gid}`,headers:f.headers})).statusCode,403);
});
test("leaving the chosen server after enqueue never falls back to another server",async t=>{
  const f=await fixture(t),other=addManagedGuild(f,{admin:false});
  f.store.saveSettings({...f.store.settings(),channelId:other.cid},U,other.gid);
  const response=await f.upload({guildId:other.gid});assert.equal(response.statusCode,202,response.body);
  other.member.outside=true;await f.worker.tick();
  assert.equal(f.sent.length,0);
  assert.equal(f.db.prepare("SELECT state FROM iw_publications WHERE id=?").get(response.json().id).state,"failed");
});
test("real sanitized images and text must pass moderation before publication; renderer is identical",async t=>{
  const f=await fixture(t);
  const r=await f.upload();assert.equal(r.statusCode,202,r.body);
  const p=r.json();assert.equal(p.state,"pending");assert.equal(f.sent.length,0);
  const img=f.store.images(p.id)[0];const data=await require("../instagram-web/images").read(f.root,img);
  assert.equal((await sharp(data).metadata()).format,"jpeg");assert.equal((await sharp(data).metadata()).exif,undefined);
  await f.worker.tick();
  assert.equal(f.store.publication(p.id).state,"published");assert.equal(f.checks.length,2);assert.equal(f.sent.length,1);
  const native=f.instagram; // compare against the actual module, same data.
  const shared=require("../instagram")({client:f.client,db:f.db,registry:{register(){},preserveMessage(){}}});
  const row=f.db.prepare("SELECT * FROM instagram_posts WHERE id=?").get(p.id);
  assert.equal(row.authorId,U);
  assert.deepEqual(f.sent[0].components[0].toJSON(),shared.render(row,`attachment://${img.filename}`).components[0].toJSON());
  assert.equal(f.sent[0].allowedMentions.parse.length,0);
  assert.ok(!JSON.stringify(f.sent[0].components).includes("web:"));
  // Compare the actual legacy single-image publication entry point with the web entry point.
  const legacyId=randomBytes(32).toString("hex");
  await f.instagram.publish({channel:f.channel,authorId:U,buffer:data,filename:img.filename,caption:p.caption,id:legacyId});
  const normalize=(payload,pid)=>JSON.parse(JSON.stringify(payload.components.map(c=>c.toJSON())).replaceAll(pid,"POST_ID"));
  assert.deepEqual(normalize(f.sent[0],p.id),normalize(f.sent[1],legacyId));
  f.sent.pop();
  const input=f.checks.find(c=>c.modality==="image").input[0].image_url.url;
  assert.equal(Buffer.from(input.split(",")[1],"base64").compare(data),0);
  const info=shared.profilePanel(row,U).components[0].toJSON();assert.ok(JSON.stringify(info).includes("@pessoa"));
  await f.worker.tick();assert.equal(f.sent.length,1);
});
test("multiple images keep all gallery items during likes and restart refresh",async t=>{
  const f=await fixture(t);
  const r=await f.upload({files:2});assert.equal(r.statusCode,202,r.body);await f.worker.tick();
  assert.equal(f.checks.filter(c=>c.modality==="image").length,2);
  const gallery=f.sent[0].components[0].toJSON().components.find(c=>c.type===12);assert.equal(gallery.items.length,2);
  const p=f.store.publication(r.json().id),post=f.db.prepare("SELECT * FROM instagram_posts WHERE id=?").get(p.id);
  const message=await f.channel.messages.fetch(p.messageId);
  const api=require("../instagram")({client:f.client,db:f.db,registry:{register(){},preserveMessage(){}}});
  await api.handle({customId:`insta:like:${post.id}`,guildId:G,user:{id:U},message,
    deferReply:async()=>{},editReply:async()=>{}});
  assert.equal(message.lastEdit.components[0].toJSON().components.find(c=>c.type===12).items.length,2);
});
for(const mode of ["blocked","severe","apiError"])test(`${mode}: never publishes and never exposes a private image`,async t=>{
  const f=await fixture(t,{[mode]:true});
  const r=await f.upload();assert.equal(r.statusCode,202);const p=r.json();
  await f.worker.tick();assert.equal(f.sent.length,0);
  assert.equal(f.store.publication(p.id).state,mode==="apiError"?"retry":"rejected");
  assert.equal((await f.app.inject({url:`/api/publications/${p.id}/images/${f.store.images(p.id)[0].id}`,headers:f.headers})).statusCode,404);
  if(mode!=="apiError")assert.equal((await fs.readdir(f.root)).length,0);
  if(mode==="severe"){f.member.permissions=new PermissionsBitField([P.Administrator]);assert.equal((await f.app.inject({url:"/api/admin/publications",headers:f.headers})).json().items.length,0);}
});
test("MIME mismatches, SVG disguised as JPEG, corrupt images and duplicate images are refused",async t=>{
  const f=await fixture(t);
  for(const opts of [{buffer:Buffer.from("<svg/>"),filename:"x.jpg",mime:"image/jpeg"},{buffer:Buffer.from("not an image")},{filename:"x.html"},{mime:"text/html"}]){
    const r=await f.upload(opts);assert.equal(r.statusCode,415,r.body);
  }
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM iw_publications").get().n,0);
  const valid=await f.upload();assert.equal(valid.statusCode,202);
  assert.equal((await f.upload()).statusCode,409);
});
test("idempotency and cooldown block duplicate tasks; ownership prevents IDOR",async t=>{
  const f=await fixture(t);const key=randomBytes(16).toString("hex");
  const first=await f.upload({key});const again=await f.upload({key});
  assert.equal(first.json().id,again.json().id);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM iw_publications").get().n,1);
  assert.equal((await f.upload({color:"red"})).statusCode,429);
  f.db.prepare("UPDATE iw_sessions SET userId=?").run("100000000000000050");
  assert.equal((await f.app.inject({url:"/api/publications/"+first.json().id,headers:f.headers})).statusCode,404);
});
test("restriction, role revocation and bot permissions fail closed at delivery",async t=>{
  const f=await fixture(t);const r=await f.upload();assert.equal(r.statusCode,202);
  const s=f.store.settings();f.store.saveSettings({...s,allowedRoles:["100000000000000019"]},U);
  await f.worker.tick();assert.equal(f.sent.length,0);assert.equal(f.store.publication(r.json().id).state,"failed");
  assert.equal((await f.upload({color:"red"})).statusCode,403);
});
test("human review never bypasses mandatory omni approval, and records actor and reason",async t=>{
  const f=await fixture(t);
  f.member.permissions=new PermissionsBitField([P.Administrator]);
  f.store.saveSettings({...f.store.settings(),manualReview:true},U);
  const r=await f.upload();await f.worker.tick();const p=r.json();
  assert.equal(f.store.publication(p.id).state,"review");assert.equal(f.sent.length,0);
  const response=await f.app.inject({method:"POST",url:`/api/admin/publications/${p.id}/review`,headers:f.headers,payload:{approve:true,reason:"Adicional conferido"}});
  assert.equal(response.statusCode,200,response.body);await f.worker.tick();
  assert.equal(f.store.publication(p.id).state,"published");
  assert.equal(f.db.prepare("SELECT actorId FROM iw_audit WHERE action='review.approved'").get().actorId,U);
});
test("Discord delivery errors become uncertain and cannot be replayed blindly",async t=>{
  const f=await fixture(t,{discordError:true});const r=await f.upload();await f.worker.tick();
  assert.equal(f.store.publication(r.json().id).state,"uncertain");
  await f.worker.tick();assert.equal(f.checks.length,2);
});
test("editing re-moderates, deletion removes the native message and reports are deduplicated",async t=>{
  const f=await fixture(t);const r=await f.upload();await f.worker.tick();const p=r.json();
  const report=()=>f.app.inject({method:"POST",url:`/api/publications/${p.id}/report`,headers:f.headers,payload:{reason:"Fotografia sem consentimento"}});
  assert.equal((await report()).statusCode,200);await report();assert.equal(f.db.prepare("SELECT COUNT(*) n FROM iw_reports").get().n,1);
  const edit=await f.app.inject({method:"PATCH",url:`/api/publications/${p.id}`,headers:f.headers,payload:{caption:"Nova legenda",handle:"outro",consent:true}});
  assert.equal(edit.statusCode,200,edit.body);await f.worker.tick();assert.equal(f.checks.length,4);
  assert.equal(f.db.prepare("SELECT caption FROM instagram_posts WHERE id=?").get(p.id).caption,"Nova legenda");
  const del=await f.app.inject({method:"DELETE",url:`/api/publications/${p.id}`,headers:f.headers});
  assert.equal(del.statusCode,200,del.body);assert.equal(f.store.publication(p.id).state,"deleted");
});
test("integrity changes invalidate moderation, and cleanup removes retained files",async t=>{
  const f=await fixture(t);const r=await f.upload();const p=r.json(),image=f.store.images(p.id)[0];
  await fs.writeFile(path.join(f.root,image.filename),"changed");
  await f.worker.tick();assert.equal(f.sent.length,0);
  f.db.prepare("UPDATE iw_publications SET state='failed',updatedAt=0 WHERE id=?").run(p.id);
  await f.worker.cleanup();assert.equal((await fs.readdir(f.root)).length,0);
});
test("logout, renewal and revocation invalidate the old session token",async t=>{
  const f=await fixture(t);
  const renewed=await f.app.inject({method:"POST",url:"/api/auth/renew",headers:f.headers});
  assert.equal(renewed.statusCode,200);
  assert.equal((await f.app.inject({url:"/api/profile",headers:f.headers})).statusCode,401);
  const cookie=renewed.cookies.find(c=>c.name==="iw_session");
  const next={cookie:`iw_session=${cookie.value}`};
  const profile=await f.app.inject({url:"/api/profile",headers:next});assert.equal(profile.statusCode,200);
  const h={...next,origin:"http://localhost","x-csrf-token":profile.json().csrf};
  assert.equal((await f.app.inject({method:"POST",url:"/api/auth/revoke",headers:h})).statusCode,200);
  assert.equal((await f.app.inject({url:"/api/profile",headers:next})).statusCode,401);
});
test("web members can publish without Discord send or attachment permissions",async t=>{
  const f=await fixture(t);
  const permissionsFor=f.channel.permissionsFor;
  f.channel.permissionsFor=target=>target.id===B?permissionsFor(target):new PermissionsBitField([P.ViewChannel]);
  const r=await f.upload();assert.equal(r.statusCode,202,r.body);
  await f.worker.tick();
  assert.equal(f.store.publication(r.json().id).state,"published");
});
test("web uploads do not require membership or ticket approval in the remote source",async t=>{
  const f=await fixture(t);
  f.db.prepare("INSERT INTO instagram_sources (guildId,sourceGuildId,sourceChannelId) VALUES(?,?,?)")
    .run(G,"100000000000000070","100000000000000071");
  f.client.channels.fetch=async()=>{throw new Error("No access to remote intake");};
  const r=await f.upload();assert.equal(r.statusCode,202,r.body);
  await f.worker.tick();
  assert.equal(f.store.publication(r.json().id).state,"published");
});
test("missing bot permission and platform restriction reject uploads before accepting files",async t=>{
  const f=await fixture(t);
  const old=f.channel.permissionsFor;
  f.channel.permissionsFor=target=>target.id===B?new PermissionsBitField([]):old(target);
  assert.equal((await f.upload()).statusCode,503);
  f.channel.permissionsFor=old;
  f.db.prepare("INSERT INTO iw_restrictions VALUES(?,?,?,NULL)").run(U,Date.now()+3600000,"restrição de teste");
  assert.equal((await f.upload()).statusCode,403);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM iw_publications").get().n,0);
});
test("oversized uploads and animated images cannot be processed",async t=>{
  const f=await fixture(t);
  const r=await f.upload({buffer:Buffer.alloc(10*1024*1024+1)});
  assert.equal(r.statusCode,413,r.body);
  const gif=Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7","base64");
  assert.equal((await f.upload({buffer:gif,filename:"image.gif",mime:"image/gif"})).statusCode,415);
});
test("policy settings cannot disable moderation, change message design or grant access through payloads",async t=>{
  const f=await fixture(t);f.member.permissions=new PermissionsBitField([P.Administrator]);
  for(const change of [{moderationEnabled:false},{discordAccent:"#ffffff"},{isAdmin:true}]){
    const r=await f.app.inject({method:"PATCH",url:"/api/admin/settings",headers:f.headers,payload:{...f.store.settings(),...change}});
    assert.equal(r.statusCode,400);
  }
  const r=await f.app.inject({method:"PATCH",url:"/api/admin/settings",headers:f.headers,payload:{...f.store.settings(),dailyLimit:8}});
  assert.equal(r.statusCode,200,r.body);assert.equal(f.store.settings().dailyLimit,8);
  assert.ok(f.db.prepare("SELECT * FROM iw_audit WHERE action='settings.changed'").get());
});
test("restart recovers analysis jobs but quarantines uncertain Discord sends",async t=>{
  const f=await fixture(t);const r=await f.upload();const pid=r.json().id;
  f.db.prepare("UPDATE iw_publications SET state='analyzing' WHERE id=?").run(pid);
  const w=require("../instagram-web/worker")({store:f.store,cfg:f.cfg,access:f.access,instagram:f.instagram});
  assert.equal(f.store.publication(pid).state,"pending");
  f.db.prepare("UPDATE iw_publications SET state='publishing' WHERE id=?").run(pid);
  const w2=require("../instagram-web/worker")({store:f.store,cfg:f.cfg,access:f.access,instagram:f.instagram});
  assert.equal(f.store.publication(pid).state,"uncertain");
  await w2.tick();assert.equal(f.sent.length,0);await w.close();await w2.close();
});
test("review image access is opt-in, audited and cannot reveal severe or blocked images",async t=>{
  const f=await fixture(t);f.member.permissions=new PermissionsBitField([P.Administrator]);
  f.store.saveSettings({...f.store.settings(),manualReview:true},U);
  const r=await f.upload();await f.worker.tick();const pid=r.json().id;
  const reveal=await f.app.inject({method:"POST",url:`/api/admin/publications/${pid}/reveal`,headers:f.headers,payload:{reason:"Verificar regra adicional"}});
  assert.equal(reveal.statusCode,200);
  const image=await f.app.inject({url:reveal.json().images[0].url,headers:f.headers});
  assert.equal(image.statusCode,200);assert.equal(image.headers["content-type"],"image/jpeg");
  assert.ok(f.db.prepare("SELECT id FROM iw_audit WHERE action='review.image.accessed'").get());
  f.member.permissions=new PermissionsBitField([]);
  assert.equal((await f.app.inject({url:reveal.json().images[0].url,headers:f.headers})).statusCode,403);
});

function makeVideo(seconds=0.6){
  const {execFileSync}=require("node:child_process");
  const ffmpeg=require("ffmpeg-static");
  return execFileSync(ffmpeg,["-nostdin","-v","error","-f","lavfi","-i",`color=c=blue:s=160x120:d=${seconds}`,"-c:v","libvpx-vp9","-b:v","100k","-an","-f","webm","pipe:1"],{maxBuffer:10*1024*1024});
}
test("videos pass mandatory frame moderation and publish as attachments",async t=>{
  const f=await fixture(t),video=makeVideo();
  const upload=await f.upload({buffer:video,filename:"momento.webm",mime:"video/webm"});
  assert.equal(upload.statusCode,202,upload.body);
  const id=upload.json().id,p=f.store.publication(id),image=f.store.images(id)[0];
  assert.equal(image.kind,"video");
  assert.equal(image.mime,"video/webm");
  assert.ok(image.duration>0);
  await f.worker.tick();
  assert.equal(f.store.publication(id).state,"published");
  assert.ok(f.checks.length>=2,"caption and sampled frames must be moderated");
  assert.ok(f.sent.length===1);
  const parts=f.sent[0].components[0].components.map(c=>c.toJSON?.()||c);
  assert.equal(parts.some(c=>c.type===12),true,"videos use the same media gallery as photos");
  assert.equal(f.sent[0].flags,32768);
  assert.match(f.sent[0].files[0].name,/\.webm$/);
});
test("videos above the duration limit and mismatched containers are refused",async t=>{
  const f=await fixture(t);
  f.store.saveSettings({...f.store.settings(),maxVideoSeconds:1});
  const long=await f.upload({buffer:makeVideo(2),filename:"longo.webm",mime:"video/webm"});
  assert.equal(long.statusCode,415);
  const invalid=await f.upload({buffer:makeVideo(),filename:"falso.mp4",mime:"video/mp4"});
  assert.equal(invalid.statusCode,415);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM iw_publications").get().n,0);
});

test("native app exchange creates a one-time web session without exposing tokens",async t=>{
  const f=await fixture(t);
  const sessionsBefore=f.db.prepare("SELECT COUNT(*) n FROM iw_sessions").get().n;
  const verifier="a".repeat(43);
  const exchange=await f.app.inject({method:"POST",url:"/api/auth/native/exchange",payload:{code:"native-code",codeVerifier:verifier}});
  assert.equal(exchange.statusCode,200,exchange.body);
  const body=exchange.json();
  assert.match(body.url,/^\/api\/auth\/native\/consume\?ticket=/);
  assert.ok(!/access_token|oauth-private/.test(exchange.body));
  const tokenCall=f.oauthCalls.find(c=>c.url.endsWith("/token"));
  assert.equal(tokenCall.opts.body.get("code_verifier"),verifier);
  assert.equal(tokenCall.opts.body.get("redirect_uri"),`discord-${B}:/authorize/callback`);
  const ticket=new URL("http://localhost"+body.url).searchParams.get("ticket");
  const consume=await f.app.inject({url:body.url});
  assert.equal(consume.statusCode,302);
  assert.equal(consume.headers.location,"/app");
  assert.match(consume.headers["set-cookie"],/HttpOnly/);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM iw_sessions").get().n,sessionsBefore+1);
  const replay=await f.app.inject({url:body.url+"&x=1"});
  assert.notEqual(replay.statusCode,302,"ticket must be single use");
});
test("native app rejects invalid redirect and verifier",async t=>{
  const f=await fixture(t);
  const badRedirect=await f.app.inject({method:"POST",url:"/api/auth/native/exchange",payload:{code:"x",codeVerifier:"a".repeat(43),redirectUri:"https://evil.example/callback"}});
  assert.equal(badRedirect.statusCode,400);
  const badVerifier=await f.app.inject({method:"POST",url:"/api/auth/native/exchange",payload:{code:"x",codeVerifier:"short"}});
  assert.equal(badVerifier.statusCode,400);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM iw_native_tickets").get().n,0);
});
test("mobile SDK redirect is exchanged exactly and tickets expire without creating sessions",async t=>{
  const f=await fixture(t),redirect=`discord-${B}:/authorize/callback`;
  const sessions=f.db.prepare("SELECT COUNT(*) n FROM iw_sessions").get().n;
  const exchange=await f.app.inject({method:"POST",url:"/api/auth/native/exchange",
    payload:{code:"mobile-sdk-code",codeVerifier:"b".repeat(43),redirectUri:redirect}});
  assert.equal(exchange.statusCode,200,exchange.body);
  const tokenCall=f.oauthCalls.find(c=>c.url.endsWith("/token"));
  assert.equal(tokenCall.opts.body.get("redirect_uri"),redirect);
  assert.equal(tokenCall.opts.body.get("client_secret"),"oauth-test-secret");
  assert.equal(tokenCall.opts.body.get("code_verifier"),"b".repeat(43));
  const ticket=new URL("http://localhost"+exchange.json().url).searchParams.get("ticket");
  const row=f.db.prepare("SELECT * FROM iw_native_tickets").get();
  assert.equal(row.hash,f.store.hash(ticket));
  assert.ok(!JSON.stringify(row).includes(ticket),"raw ticket is never stored");
  assert.equal(exchange.headers["cache-control"],"no-store");
  assert.ok(f.oauthCalls.some(c=>c.url.endsWith("/revoke")));
  f.db.prepare("UPDATE iw_native_tickets SET expiresAt=?").run(Date.now()-1);
  const expired=await f.app.inject({url:exchange.json().url});
  assert.equal(expired.statusCode,404);
  assert.equal(expired.headers["set-cookie"],undefined);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM iw_sessions").get().n,sessions);
});
test("native mobile callbacks reject other app IDs, double slash redirects and extra fields",async t=>{
  const f=await fixture(t);
  for(const payload of [
    {redirectUri:`discord-${U}:/authorize/callback`},
    {redirectUri:`discord-${B}://authorize/callback`},
    {redirectUri:`discord-${B}:/authorize/callback?redirect=https://evil.example`},
    {clientSecret:"must-not-come-from-mobile"}
  ]){
    const response=await f.app.inject({method:"POST",url:"/api/auth/native/exchange",
      payload:{code:"mobile-code",codeVerifier:"c".repeat(43),...payload}});
    assert.equal(response.statusCode,400,response.body);
  }
  assert.equal(f.oauthCalls.length,0);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM iw_native_tickets").get().n,0);
});
