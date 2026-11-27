const path=require("node:path");
const fs=require("node:fs/promises");
async function createServer({client,db,instagram,registry,env=process.env,fetchImpl,moderation,profileProvider}){
  const Fastify=require("fastify");
  const {config}=require("./config");
  const scope=require("./scope")(config(env)),cfg=scope.cfg;
  const frontendRoot=path.join(__dirname,"frontend");
  if(cfg.storage===frontendRoot||cfg.storage.startsWith(frontendRoot+path.sep))throw new Error("O armazenamento privado não pode ficar na pasta pública/frontend.");
  await fs.mkdir(cfg.storage,{recursive:true,mode:0o700});
  const store=require("./store")(db,cfg);
  store.settings(); // Fail startup if neither existing Instagram nor env has a destination.
  const app=Fastify({logger:false,bodyLimit:64*1024,trustProxy:env.WEB_TRUST_PROXY?env.WEB_TRUST_PROXY.split(",").map(x=>x.trim()):false,
    requestTimeout:60000,connectionTimeout:15000,routerOptions:{maxParamLength:128}});
  await app.register(require("@fastify/cookie"));
  await app.register(require("@fastify/rate-limit"),{max:60,timeWindow:60000,
    // Static badge images/fonts must not consume the authenticated API quota.
    // The independent per-IP limit below still covers every request.
    allowList:req=>!req.url.startsWith("/api/"),
    keyGenerator:req=>{
      const cookie=req.cookies.iw_session;
      const session=typeof cookie==="string"?db.prepare("SELECT userId FROM iw_sessions WHERE hash=? AND expiresAt>?").get(store.hash(cookie),Date.now()):null;
      return session?`account:${session.userId}`:store.hash(`${cfg.sessionSecret}:${req.ip}`);
    },skipOnError:false,
    errorResponseBuilder:()=>Object.assign(new Error("Muitas solicitações. Tente novamente em instantes."),{statusCode:429})});
  await app.register(require("@fastify/multipart"),{limits:{fileSize:10*1024*1024,files:5,fields:1,parts:6,fieldSize:4096}});
  const ipLimits=new Map();
  app.addHook("onRequest",async(req,res)=>{
    const bucket=Math.floor(Date.now()/60000),key=store.hash(`${cfg.sessionSecret}:${req.ip}`);
    if(ipLimits.size>10000)for(const [key,value] of ipLimits)if(value.bucket!==bucket)ipLimits.delete(key);
    if(ipLimits.size>10000&&!ipLimits.has(key))throw Object.assign(new Error("Muitas solicitações."),{statusCode:429});
    const previous=ipLimits.get(key),count=previous?.bucket===bucket?previous.count+1:1;
    ipLimits.set(key,{bucket,count});
    if(count>600)throw Object.assign(new Error("Muitas solicitações desta rede. Aguarde um minuto."),{statusCode:429});
    res.header("X-Content-Type-Options","nosniff").header("X-Frame-Options","DENY")
      .header("Referrer-Policy","no-referrer").header("Permissions-Policy","camera=(), microphone=(), geolocation=()")
      .header("Content-Security-Policy","default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: https://cdn.discordapp.com https://media.discordapp.net; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
      .header("Cross-Origin-Resource-Policy","same-origin");
    if(cfg.secure)res.header("Strict-Transport-Security","max-age=31536000; includeSubDomains");
    if(req.url.startsWith("/api/"))res.header("Cache-Control","no-store");
    if(req.headers.origin&&req.headers.origin!==cfg.origin)throw Object.assign(new Error("Origem não autorizada."),{statusCode:403});
  });
  app.setErrorHandler((err,req,res)=>{
    const validation=err.name==="ZodError"||err instanceof SyntaxError;
    const status=validation?400:err.statusCode>=400&&err.statusCode<600?err.statusCode:503;
    if(status>=500)store.event("http.error");
    res.code(status).send({error:validation?"Confira os campos enviados.":status>=500?"Serviço temporariamente indisponível. Tente novamente mais tarde.":err.message});
  });
  const access=require("./access")({client,store,cfg});
  const auth=require("./auth")({app,store,cfg,fetchImpl});
  const worker=require("./worker")({store,cfg,access,instagram,moderation,scope});
  const scopedApp=scope.routes(app);
  const profileLookup=profileProvider||(env.WEB_PROFILE_BADGES_USER_LOOKUP_ENABLED==="false"?null:
    require("../up/profile-client").getSharedProfileClient({token:env.DISCORD_BIO_CHECK_USER_TOKEN||""}));
  const routes=require("./routes")({app:scopedApp,store,cfg,access,auth,worker,instagram,client,profileProvider:profileLookup});
  require("./guild-admin")({app,store,cfg,access,auth,worker});
  require("./native-auth")({app,store,cfg,fetchImpl});
  app.get("/api/guilds",async req=>{
    auth.requireSession(req);
    return {items:await access.sharedGuilds(req.session.userId),defaultGuildId:cfg.defaultGuildId,csrf:req.session.csrf};
  });
  app.get("/api/health",async()=>({ok:true}));
  const latestPhoto=require("./latest-photo")({db,client});
  // The login preview is deliberately fixed to the primary guild.
  app.get("/api/latest-photo",async(req,res)=>{
    res.header("Cache-Control","no-store");
    const url=await latestPhoto(cfg.defaultGuildId);
    return url?res.redirect(url):res.code(404).send({error:"Fotografia indisponível."});
  });
  scopedApp.get("/api/status",async()=>{
    const s=store.settings(cfg.guildId,{allowUnconfigured:true}),g=client.guilds.cache.get(cfg.guildId);
    return {name:s.name==="Comunidade"?g?.name||s.name:s.name,logo:s.logo||g?.iconURL({size:128})||null,banner:s.banner,favicon:s.favicon,accent:s.accent,
      invite:s.invite,rules:s.rules,notice:s.notice,available:client.isReady()&&!s.maintenance&&!!s.channelId,
      maxImages:s.maxImages,maxBytes:s.maxBytes,captionLimit:s.captionLimit,allowInstagram:s.allowInstagram,
      allowVideo:s.allowVideo,maxVideoBytes:s.maxVideoBytes,maxVideoSeconds:s.maxVideoSeconds};
  });
  scopedApp.post("/api/preview",async req=>{
    auth.requireSession(req);auth.csrf(req);await access.check(req.session.userId);
    const {z}=require("zod");
    const {caption}=z.object({caption:z.string().max(500)}).strict().parse(req.body);
    // The exact Discord renderer, not a second template.
    return {components:instagram.render({id:"preview",authorId:req.session.userId,filename:"preview.jpg",caption}).components.map(c=>c.toJSON())};
  });
  const root=path.join(__dirname,"frontend","dist");
  const exists=await fs.access(path.join(root,"index.html")).then(()=>true,()=>false);
  if(!exists&&env.NODE_ENV==="production")throw new Error("Compile o frontend com npm run web:build antes de ativar o site.");
  if(exists){
    await app.register(require("@fastify/static"),{root,prefix:"/",wildcard:false});
    app.setNotFoundHandler((req,res)=>req.method==="GET"&&!req.url.startsWith("/api/")?res.sendFile("index.html"):res.code(404).send({error:"Rota indisponível."}));
  }
  let cleaner,logTimer,logging=false,closing=false,cleanupTask,logTask;
  async function flushLogs(){
    if(logging)return;logging=true;
    try{
        for(const guildId of client.guilds.cache.keys())await scope.run(guildId,async()=>{
          const id=store.settings(guildId,{allowUnconfigured:true}).logChannelId;if(!id)return;
          const guild=await access.guild(),channel=await guild.channels.fetch(id);
          if(!channel||channel.permissionsFor(guild.roles.everyone)?.has(1024n))return;
          const rows=db.prepare("SELECT * FROM iw_audit WHERE guildId=? AND id NOT IN (SELECT auditId FROM iw_log_deliveries) AND createdAt>? ORDER BY createdAt LIMIT 10").all(guildId,Date.now()-86400000);
          for(const row of rows){
            const message=await channel.send(require("../lumiya-ui/logs").card({
              category:"community",title:"Instagram Web",subtitle:row.action,
              summary:[["Ação",require("../lumiya-ui/logs").safe(row.action)],
                ["Responsável",row.actorId?`<@${row.actorId}>`:"Sistema"],["Recurso",`\`${row.resourceId||"—"}\``]],
              metadata:[["Servidor",guildId]],
              botAvatarURL:client.user?.displayAvatarURL?.({size:128}),
              at:row.createdAt,source:"Portal da comunidade",eventId:row.id
            }));
            // Existing registry keeps bot logs; no photographs or captions are forwarded.
            db.prepare("INSERT OR IGNORE INTO iw_log_deliveries VALUES(?)").run(row.id);
            registry?.preserveMessage(message);
          }
        });
    }catch{store.event("audit.delivery.error");}finally{logging=false;}
  }
  const onDelete=message=>{
     const p=db.prepare("SELECT * FROM iw_publications WHERE messageId=? AND state='published'").get(message.id);
    if(p){store.state(p,"deleted");db.prepare("UPDATE instagram_posts SET messageId=NULL WHERE id=?").run(p.id);}
  };
  client.on("messageDelete",onDelete);
  app.addHook("onClose",async()=>{closing=true;clearInterval(cleaner);clearInterval(logTimer);client.removeListener("messageDelete",onDelete);await Promise.allSettled([worker.close(),cleanupTask,logTask]);});
  return {app,store,cfg,access,auth,worker,routes,
    async start(){
      await app.listen({host:cfg.host,port:cfg.port});
      worker.start();
      logTimer=setInterval(()=>{if(!closing&&!logging)logTask=flushLogs();},60000);logTimer.unref();
      cleaner=setInterval(()=>{if(!closing)cleanupTask=worker.cleanup().catch(()=>store.event("cleanup.error"));},3600000);cleaner.unref();
      await worker.cleanup();
      console.log(`[Instagram Web] Ativo em ${cfg.host}:${cfg.port}.`);
    }};
}
function install(options){
  if((options.env||process.env).INSTAGRAM_WEB_ENABLED!=="true")return {enabled:false};
  let server,starting;
  const start=()=>starting=createServer(options).then(async s=>{server=s;await s.start();}).catch(()=>{
    // Do not print config contents or provider errors; the rest of the bot stays alive.
    console.error("[Instagram Web] Inicialização recusada. Verifique as variáveis documentadas e a porta; o site permanece offline.");
  });
  if(options.client.isReady())start();else options.client.once("clientReady",start);
  const close=async()=>{await starting;await server?.app.close();};
  options.client.once("invalidated",close);
  options.onShutdown?.(close);
  return {enabled:true,close};
}
module.exports=install;
module.exports.createServer=createServer;
