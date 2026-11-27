// Browser-test harness only. Never imported by the application or enabled by an environment flag.
const {DatabaseSync}=require("node:sqlite");
const {EventEmitter}=require("node:events");
const {createHash}=require("node:crypto");
const {Collection,PermissionsBitField,PermissionFlagsBits:P,UserFlagsBitField}=require("discord.js");
const fs=require("node:fs/promises"),path=require("node:path"),os=require("node:os");
(async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),"iw-browser-")),db=new DatabaseSync(":memory:");
  const gid="100000000000000001",uid="100000000000000002",mobileUid="100000000000000012",regularUid="100000000000000022",navigationUid="100000000000000032",profileUid="100000000000000042",visualUid="100000000000000052",cid="100000000000000003";
  const client=new EventEmitter(),perms=new PermissionsBitField([P.Administrator]);
  const member={id:uid,displayName:"Camila",user:{username:"camila"},joinedTimestamp:Date.now()-86400000,
    displayAvatarURL:()=>"/avatar.png",permissions:perms,roles:{cache:new Collection()}};
  const profileMember={...member,id:profileUid,premiumSinceTimestamp:Date.now()-3600000,
    user:{...member.user,createdTimestamp:Date.UTC(2020,1,1),flags:new UserFlagsBitField(["HypeSquadOnlineHouse2","PremiumEarlySupporter"]),fetch:async()=>({bannerURL:()=>"/profile-banner.png"})},
    roles:{cache:new Collection([["100000000000000005",{id:"100000000000000005",name:"Criadores",hexColor:"#c5abe8",position:1}]])}};
  const cache=new Collection();
  const channel={id:cid,name:"instagram-principal",guildId:gid,type:0,isTextBased:()=>true,isThread:()=>false,permissionsFor:()=>perms,
    messages:{fetch:async id=>cache.get(id)},send:async p=>{
      const id=String(100000000000000099n+BigInt(cache.size)),msg={id,attachments:new Collection(p.files.map((f,n)=>[n,{url:"https://cdn.discordapp.com/attachments/test/"+f.name}])),edit:async()=>{},delete:async()=>{cache.delete(id);}};
      cache.set(id,msg);return msg;
    }};
  const guild={id:gid,name:"GRIFE",ownerId:uid,iconURL:()=>null,members:{fetch:async({user}={})=>user===profileUid?profileMember:user===regularUid?{...member,id:regularUid,permissions:new PermissionsBitField([])}:user===visualUid?{...member,id:visualUid,permissions:new PermissionsBitField([])}:[mobileUid,navigationUid].includes(user)?{...member,id:user}:member,fetchMe:async()=>member},
    roles:{everyone:{id:gid},fetch:async id=>id?{id,name:"Equipe"}:new Collection()},
    channels:{fetch:async id=>id?channel:new Collection([[cid,channel]])}};
  channel.guild=guild;client.isReady=()=>true;client.guilds={fetch:async()=>guild,cache:new Collection([[gid,guild]])};client.channels={fetch:async()=>channel};client.user={id:"100000000000000004"};
  const otherId="200000000000000001",otherChannelId="200000000000000003";
  const otherChannel={...channel,id:otherChannelId,name:"insta-criadores",guildId:otherId};
  const otherGuild={...guild,id:otherId,name:"Clube dos Criadores",
    channels:{fetch:async id=>id?(id===otherChannelId?otherChannel:null):new Collection([[otherChannelId,otherChannel]])}};
  otherChannel.guild=otherGuild;client.guilds.cache.set(otherId,otherGuild);
  const registry={register(){},preserveMessage(){}};
  const instagram=require("../../instagram")({client,db,registry});
  db.prepare("INSERT INTO instagram_settings VALUES(?,?)").run(gid,cid);
  // Test-only stand-in for the secondary-account visual lookup. It must never
  // grant permissions: the user below remains an ordinary member.
  const visualIcon="c".repeat(32),profileProvider={enabled:true,visuals:async(_guild,user)=>user===visualUid?{status:"available",checkedAt:Date.now(),badges:[
    {id:"native:nitro",kind:"discord",label:"Discord Nitro",description:"Nitro exibido pela visualização do perfil.",icon:`https://cdn.discordapp.com/badge-icons/${visualIcon}.png`},
    {id:"native:early_supporter",kind:"discord",label:"Early Supporter",description:"Apoiador inicial do Discord.",icon:`https://cdn.discordapp.com/badge-icons/${"d".repeat(32)}.png`},
    {id:"native:premium_tenure_1_month_v2",kind:"discord",label:"Nitro há 1 mês",description:"Tempo de assinatura visível no perfil.",icon:`https://cdn.discordapp.com/badge-icons/${"e".repeat(32)}.png`}
  ]}:{status:"unknown",reason:"test_provider_unavailable"}};
  const server=await require("../").createServer({client,db,instagram,registry,profileProvider,env:{
    DISCORD_CLIENT_ID:client.user.id,DISCORD_CLIENT_SECRET:"browser-test",DISCORD_GUILD_ID:gid,
    DISCORD_IDENTIFY_PREMIUM_ENABLED:"true", // Test-only simulation of partner approval.
    DISCORD_REDIRECT_URI:"http://127.0.0.1:3111/api/auth/discord/callback",APP_URL:"http://127.0.0.1:3111",
    SESSION_SECRET:"b".repeat(64),OPENAI_API_KEY:"mock-never-sent",STORAGE_PATH:dir,PORT:"3111"},
    moderation:{model:"omni-moderation-latest",classify:async(_input,modality,onRequest)=>{
      onRequest();return {flagged:false,categories:{sexual:false},category_scores:{sexual:0},category_applied_input_types:{sexual:[modality]},modality};
    }}});
  server.store.saveSettings({...server.store.settings(),cooldownSeconds:0,dailyLimit:100},uid);
  const token="browser-test-only-session",hash=createHash("sha256").update(token).digest("hex");
  db.prepare("INSERT INTO iw_users VALUES(?,?,?,?)").run(uid,JSON.stringify({id:uid,username:"camila"}),"{}",Date.now());
  db.prepare("INSERT INTO iw_sessions VALUES(?,?,?,?,?)").run(hash,uid,"browser-csrf",Date.now(),Date.now()+3600000);
  db.prepare("INSERT INTO iw_users VALUES(?,?,?,?)").run(mobileUid,JSON.stringify({id:mobileUid,username:"camila"}),"{}",Date.now());
  db.prepare("INSERT INTO iw_sessions VALUES(?,?,?,?,?)").run(createHash("sha256").update("browser-test-only-mobile-session").digest("hex"),mobileUid,"browser-csrf",Date.now(),Date.now()+3600000);
  db.prepare("INSERT INTO iw_users VALUES(?,?,?,?)").run(regularUid,JSON.stringify({id:regularUid,username:"camila"}),"{}",Date.now());
  db.prepare("INSERT INTO iw_sessions VALUES(?,?,?,?,?)").run(createHash("sha256").update("browser-test-only-member-session").digest("hex"),regularUid,"browser-csrf",Date.now(),Date.now()+3600000);
  db.prepare("INSERT INTO iw_users VALUES(?,?,?,?)").run(navigationUid,JSON.stringify({id:navigationUid,username:"camila"}),"{}",Date.now());
  db.prepare("INSERT INTO iw_sessions VALUES(?,?,?,?,?)").run(createHash("sha256").update("browser-test-only-navigation-session").digest("hex"),navigationUid,"browser-csrf",Date.now(),Date.now()+3600000);
  db.prepare("INSERT INTO iw_users VALUES(?,?,?,?)").run(profileUid,JSON.stringify({id:profileUid,username:"camila",nitro:{type:2,checkedAt:Date.now()}}),"{}",Date.now());
  db.prepare("INSERT INTO iw_sessions VALUES(?,?,?,?,?)").run(createHash("sha256").update("browser-test-only-profile-session").digest("hex"),profileUid,"browser-csrf",Date.now(),Date.now()+3600000);
  db.prepare("INSERT INTO iw_users VALUES(?,?,?,?)").run(visualUid,JSON.stringify({id:visualUid,username:"camila"}),"{}",Date.now());
  db.prepare("INSERT INTO iw_sessions VALUES(?,?,?,?,?)").run(createHash("sha256").update("browser-test-only-visual-session").digest("hex"),visualUid,"browser-csrf",Date.now(),Date.now()+3600000);
  const avatar=await require("sharp")({create:{width:64,height:64,channels:3,background:"#b6a7d9"}}).png().toBuffer();
  server.app.get("/avatar.png",async(_req,res)=>res.type("image/png").send(avatar));
  const banner=await require("sharp")(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="300"><defs><linearGradient id="g"><stop stop-color="#675584"/><stop offset="1" stop-color="#253b3c"/></linearGradient></defs><rect width="1000" height="300" fill="url(#g)"/><circle cx="760" cy="100" r="220" fill="none" stroke="#bfbbd3" stroke-opacity=".22"/><circle cx="760" cy="100" r="280" fill="none" stroke="#bfbbd3" stroke-opacity=".12"/></svg>')).png().toBuffer();
  server.app.get("/profile-banner.png",async(_req,res)=>res.type("image/png").send(banner));
  await server.start();
  process.once("SIGTERM",async()=>{await server.app.close();db.close();await fs.rm(dir,{recursive:true,force:true});process.exit();});
})().catch(e=>{console.error(e);process.exit(1);});
