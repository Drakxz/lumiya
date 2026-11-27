const {randomBytes,randomUUID}=require("node:crypto");
const fs=require("node:fs/promises");
const path=require("node:path");
const {z}=require("zod");
const {settingsSchema,id}=require("./config");
const {fault}=require("./access");
const images=require("./images");
const describeProfile=require("./profile");
const handle=z.string().trim().regex(/^@?[a-zA-Z0-9._]{1,30}$/).or(z.literal("")).default("");
const draftSchema=z.object({caption:z.string().trim().max(500).default(""),handle,consent:z.literal(true)}).strict();
module.exports=function routes({app,store,cfg,access,auth,worker,instagram,client,profileProvider}){
  const db=store.db;
  let uploads=0;
  const safe=p=>({id:p.id,guildId:p.guildId,authorId:p.userId,state:p.state,caption:p.caption,handle:p.handle,createdAt:p.createdAt,updatedAt:p.updatedAt,
    url:p.messageId?`https://discord.com/channels/${p.guildId}/${p.channelId}/${p.messageId}`:null,
    reviewEligible:p.state==="review",editable:p.state==="published"&&Date.now()-p.createdAt<7*86400000,
    imageCount:store.images(p.id).length,
    images:p.state==="published"?store.images(p.id).map(i=>({id:i.id,width:i.width,height:i.height,kind:i.kind,mime:i.mime,duration:i.duration})):[],
    error:p.error==="safety_restricted"?"policy":p.error});
  function page(req){return {limit:Math.floor(Math.min(50,Math.max(1,Number(req.query.limit)||20))),offset:Math.floor(Math.max(0,Math.min(100000,Number(req.query.offset)||0)))};}
  async function guard(req,options){auth.requireSession(req);if(!["GET","HEAD"].includes(req.method))auth.csrf(req);const ctx=await access.check(req.session.userId,options);store.touchMember(req.session.userId);return ctx;}
  function own(req){const p=store.publication(req.params.id);if(!p||p.userId!==req.session.userId)throw fault(404,"Publicação indisponível.");return p;}
  function quotas(ctx,userId){
    const day=Date.now()+(-3*3600000),start=Math.floor(day/86400000)*86400000+3*3600000;
    const restriction=store.restriction(userId);
    const limit=restriction?.dailyLimit||ctx.limits.daily;
    const used=db.prepare("SELECT COUNT(*) n FROM iw_publications WHERE userId=? AND guildId=? AND createdAt>=?").get(userId,cfg.guildId,start).n;
    const pending=db.prepare("SELECT COUNT(*) n FROM iw_publications WHERE userId=? AND guildId=? AND state IN ('pending','processing','analyzing','approved','retry','review','publishing','uncertain')").get(userId,cfg.guildId).n;
    const latest=db.prepare("SELECT MAX(createdAt) at FROM iw_publications WHERE userId=? AND guildId=?").get(userId,cfg.guildId).at||0;
    return {limit,used,remaining:Math.max(0,limit-used),pending,nextAt:latest+ctx.limits.cooldown*1000};
  }
  async function me(req){
    auth.requireSession(req);
    let ctx;
    try{ctx=await access.check(req.session.userId);}
    catch(e){
      if(e.statusCode!==403&&e.statusCode!==503)throw e;
      const guilds=await access.manageableGuilds(req.session.userId);
      if(!guilds.length)throw e;
      const {member:m}=await access.manageGuild(req.session.userId,guilds[0].id);
      return {id:m.id,name:m.displayName,username:m.user.username,nickname:m.nickname,avatar:m.displayAvatarURL({size:128}),
        joinedAt:m.joinedTimestamp,roles:[],admin:false,moderator:false,canManageGuilds:true,adminOnly:true,csrf:req.session.csrf,
        preferences:store.profile(m.id)?.preferences||{},quotas:{remaining:0,limit:0,pending:0,nextAt:0},stats:{total:0,published:0,rejected:0}};
    }
    const m=ctx.member;
    store.touchMember(m.id);
    const canManageGuilds=ctx.admin||!ctx.moderator&&(await access.manageableGuilds(m.id)).length>0;
    return {id:m.id,name:m.displayName,username:m.user.username,nickname:m.nickname,avatar:m.displayAvatarURL({size:256}),...describeProfile(m,ctx,m.user,{nitro:cfg.identifyPremium?store.profile(m.id)?.nitro:undefined}),
      joinedAt:m.joinedTimestamp,roles:[...m.roles.cache.values()].filter(r=>r.id!==cfg.guildId).sort((a,b)=>(b.position||0)-(a.position||0)).map(r=>({id:r.id,name:r.name,color:/^#[0-9a-f]{6}$/i.test(r.hexColor||"")?r.hexColor:null})),
      guildId:cfg.guildId,admin:ctx.admin,moderator:ctx.moderator,canManageGuilds,adminOnly:false,csrf:req.session.csrf,preferences:store.profile(m.id)?.preferences||{},quotas:quotas(ctx,m.id),
      stats:db.prepare("SELECT COUNT(*) total,COALESCE(SUM(state='published'),0) published,COALESCE(SUM(state='rejected'),0) rejected FROM iw_publications WHERE userId=? AND guildId=?").get(m.id,cfg.guildId)};
  }
  app.get("/api/auth/me",me);
  const latestPhoto=require("./latest-photo")({db,client});
  app.get("/api/me/latest-photo",async(req,res)=>{
    await guard(req);
    res.header("Cache-Control","private, no-store");
    const url=await latestPhoto(cfg.guildId,req.session.userId);
    return url?res.redirect(url):res.code(404).send({error:"Fotografia indisponível."});
  });
  app.get("/api/profile",async req=>{
    const identity=await me(req);
    if(identity.adminOnly)return identity;
    // Fetch the global banner only on the profile page, not on every queue poll.
    const ctx=await access.check(req.session.userId),{member}=ctx;
    let profile=identity;
    try{
      const user=await member.user.fetch?.();
      const banner=member.bannerURL?.({size:1024})||user?.bannerURL?.({size:1024})||identity.banner;
      profile={...identity,...describeProfile(member,ctx,user||member.user,{nitro:cfg.identifyPremium?store.profile(member.id)?.nitro:undefined}),banner};
    }catch{}
    if(profileProvider?.enabled){
      try{
        // Fixed to the logged-in member after the selected-guild access check.
        // This optional provider supplies cosmetic data only, never permissions.
        const visual=await profileProvider.visuals(cfg.guildId,req.session.userId);
        if(visual.status==="available"&&Array.isArray(visual.badges)){
          // Keep the guild-local boost when the visible profile does not render
          // one; the visual list otherwise mirrors the Discord client.
          const extra=(profile.accountBadges||[]).filter(b=>b.id==="discord:Boost"&&!visual.badges.some(v=>/boost|impulsion/i.test(v.label)));
          return {...profile,accountBadges:[...visual.badges,...extra],accountBadgesSource:"visible-profile",accountBadgesCheckedAt:visual.checkedAt};
        }
      }catch{}
    }
    return {...profile,accountBadgesSource:"official-api"};
  });
  app.patch("/api/profile",async req=>{
    await guard(req);
    const preferences=z.object({handle,showInstagram:z.boolean(),theme:z.enum(["dark","light","system"]),notifications:z.boolean().default(true)}).strict().parse(req.body);
    db.prepare("UPDATE iw_users SET preferences=? WHERE id=?").run(JSON.stringify(preferences),req.session.userId);
    store.audit(req.session.userId,"profile.updated");return {ok:true};
  });
  app.get("/api/publications",async req=>{
    await guard(req);const {limit,offset}=page(req);
    const state=typeof req.query.state==="string"?req.query.state:"";
    const search=String(req.query.search||"").slice(0,100);
    return {items:db.prepare("SELECT * FROM iw_publications WHERE guildId=? AND userId=? AND (?='' OR state=?) AND instr(lower(caption),lower(?))>0 ORDER BY createdAt DESC LIMIT ? OFFSET ?").all(cfg.guildId,req.session.userId,state,state,search,limit,offset).map(safe)};
  });
  app.get("/api/publications/:id",async req=>{await guard(req);return safe(own(req));});
  app.get("/api/publications/:id/preview",async req=>{
    await guard(req);const p=own(req);
    return {payload:instagram.render({id:p.id,authorId:p.userId,filename:"preview.jpg",caption:p.caption}).components.map(c=>c.toJSON())};
  });
  app.get("/api/publications/:id/images/:image",async(req,res)=>{
    await guard(req);const p=own(req);
    // Never serve pending, rejected, failed or restricted images, even to administrators.
    if(p.state!=="published")throw fault(404,"Imagem indisponível.");
    const image=store.images(p.id).find(i=>i.id===req.params.image);
    if(!image)throw fault(404,"Imagem indisponível.");
    return res.type(image.mime||"image/jpeg").header("Cache-Control","private, no-store").send(await images.read(cfg.storage,image));
  });
  app.post("/api/publications",async(req,res)=>{
    const ctx=await guard(req,{publish:true});await access.botChannel(ctx.channel);
    const key=z.string().regex(/^[a-zA-Z0-9_-]{16,100}$/).parse(req.headers["idempotency-key"]);
    const old=db.prepare("SELECT * FROM iw_publications WHERE guildId=? AND userId=? AND requestKey=?").get(cfg.guildId,req.session.userId,key);
    if(old)return safe(old);
    if(uploads>=2)throw fault(429,"Há outros uploads em andamento. Tente novamente em instantes.");
    const settings=store.settings(),processed=[];
    let fields={},committed=false;uploads++;
    try{
      for await(const part of req.parts()){
        if(part.type==="file"){
          if(part.fieldname!=="images"||processed.length>=Math.max(1,settings.maxImages))throw fault(400,"Quantidade de arquivos inválida.");
          const buffer=await part.toBuffer();
          if(part.file.truncated)throw fault(413,"Arquivo acima do limite.");
          if(Object.keys({ "video/mp4":1,"video/quicktime":1,"video/webm":1 }).includes(part.mimetype)&&!settings.allowVideo)throw fault(415,"Vídeos não estão habilitados neste servidor.");
          processed.push(await images.sanitizeAny(buffer,{filename:part.filename,mimetype:part.mimetype,
            maxBytes:settings.maxBytes,maxVideoBytes:settings.maxVideoBytes,maxVideoSeconds:settings.maxVideoSeconds}));
        }else{
          if(part.fieldname!=="data"||fields.received)throw fault(400,"Formulário inválido.");
          fields={...JSON.parse(part.value),received:true};
        }
      }
      const {received,...raw}=fields;const draft=draftSchema.parse(raw);
      const videos=processed.filter(i=>i.kind==="video");
      if(!processed.length||videos.length>1||videos.length&&processed.length>1||draft.caption.length>settings.captionLimit||!settings.allowInstagram&&draft.handle)
        throw fault(400,"Envie fotografias ou um único vídeo, e confira os campos permitidos.");
      if(processed.reduce((n,i)=>n+i.bytes,0)>24*1024*1024)throw fault(413,"O conjunto de arquivos deve ter no máximo 24 MB após o processamento.");
      const hashes=processed.map(i=>i.hash);
      if(new Set(hashes).size!==hashes.length)throw fault(409,"Não envie fotografias repetidas.");
      const duplicate=db.prepare(`SELECT 1 FROM iw_images i JOIN iw_publications p ON p.id=i.publicationId WHERE p.userId=? AND p.guildId=? AND p.createdAt>? AND i.hash IN (${hashes.map(()=>"?").join(",")}) LIMIT 1`).get(req.session.userId,cfg.guildId,Date.now()-86400000,...hashes);
      if(duplicate)throw fault(409,"Esta fotografia já foi enviada recentemente.");
      const names=await fs.readdir(cfg.storage);let total=0;
      for(const name of names)total+=(await fs.stat(path.join(cfg.storage,name))).size;
      if(total+processed.reduce((n,i)=>n+i.bytes,0)>cfg.maxStorageBytes)throw fault(503,"Armazenamento temporário ocupado. Tente mais tarde.");
      for(const image of processed)await images.save(cfg.storage,image);
      const finalCtx=await access.check(req.session.userId,{publish:true});
      const already=db.prepare("SELECT * FROM iw_publications WHERE guildId=? AND userId=? AND requestKey=?").get(cfg.guildId,req.session.userId,key);
      if(already)return safe(already);
      const pid=randomBytes(32).toString("hex"),now=Date.now();
      store.transaction(()=>{
        const q=quotas(finalCtx,req.session.userId);
        if(q.remaining<=0||q.pending>=2||q.nextAt>now)throw fault(429,"Limite diário, cooldown ou limite de pendências atingido.");
        db.prepare("INSERT INTO iw_publications(id,guildId,userId,state,caption,handle,createdAt,updatedAt,requestKey) VALUES(?,?,?,'pending',?,?,?,?,?)")
          .run(pid,cfg.guildId,req.session.userId,draft.caption,draft.handle.replace(/^@/,"")||null,now,now,key);
        processed.forEach((i,n)=>db.prepare("INSERT INTO iw_images(id,publicationId,position,filename,hash,bytes,width,height,kind,mime,duration) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
          .run(randomUUID(),pid,n,i.filename,i.hash,i.bytes,i.width,i.height,i.kind||"image",i.mime||"image/jpeg",i.duration||0));
        store.audit(req.session.userId,"publication.received",pid);
      });
      committed=true;res.code(202);return safe(store.publication(pid));
    }finally{uploads--;if(!committed)await images.remove(cfg.storage,processed);}
  });
  app.patch("/api/publications/:id",async req=>{
    await guard(req,{publish:true});const p=own(req),s=store.settings();
    if(!s.allowEdit||p.state!=="published"||Date.now()-p.createdAt>7*86400000)throw fault(409,"Edição indisponível. Imagens temporárias são descartadas após sete dias.");
    const d=draftSchema.parse(req.body);
    if(d.caption.length>s.captionLimit||!s.allowInstagram&&d.handle)throw fault(400,"Campos inválidos.");
    db.prepare("UPDATE iw_publications SET caption=?,handle=?,state='pending',approval=NULL,attempts=0,nextAt=0,operation='edit',updatedAt=? WHERE id=?").run(d.caption,d.handle.replace(/^@/,"")||null,Date.now(),p.id);
    store.audit(req.session.userId,"publication.edit.requested",p.id);return safe(store.publication(p.id));
  });
  async function remove(p,actor,reason){
    if(["publishing","processing","approved","analyzing"].includes(p.state))throw fault(409,"Aguarde o processamento antes de excluir.");
    if(p.messageId){
      const g=await access.guild(),c=await g.channels.fetch(p.channelId);
      const msg=await c.messages.fetch(p.messageId).catch(e=>{if(e.code!==10008)throw e;return null;});
      if(msg)await msg.delete();
    }
    db.prepare("UPDATE instagram_posts SET messageId=NULL WHERE id=?").run(p.id);
    store.state(p,"deleted");await images.remove(cfg.storage,store.images(p.id));
    store.audit(actor,"publication.deleted",p.id,reason);return {ok:true};
  }
  app.delete("/api/publications/:id",async req=>{await guard(req);const p=own(req);if(!store.settings().allowDelete)throw fault(403,"Exclusão pelo autor desativada.");return remove(p,req.session.userId,"Solicitado pelo autor");});
  app.post("/api/publications/:id/review",async req=>{
    await guard(req);const p=own(req);if(p.state!=="review"||!p.approval)throw fault(409,"Esta publicação não é elegível para revisão.");
    const {reason}=z.object({reason:z.string().trim().min(5).max(500)}).strict().parse(req.body);
    db.prepare("INSERT OR IGNORE INTO iw_reviews VALUES(?,?,?,?)").run(p.id,p.userId,reason,Date.now());
    store.audit(p.userId,"review.requested",p.id,reason);return {ok:true};
  });
  app.post("/api/publications/:id/retry",async req=>{
    await guard(req,{publish:true});const p=own(req);
    if(p.state!=="failed"||p.error!=="temporarily_unavailable"||Date.now()-p.createdAt>7*86400000)throw fault(409,"Reenvio indisponível.");
    db.prepare("UPDATE iw_publications SET state='pending',attempts=0,nextAt=0,approval=NULL WHERE id=?").run(p.id);
    store.audit(p.userId,"publication.retry",p.id);return {ok:true};
  });
  app.post("/api/publications/:id/report",async req=>{
    await guard(req);const p=store.publication(req.params.id);
    const native=db.prepare("SELECT * FROM instagram_posts WHERE id=? AND guildId=? AND messageId IS NOT NULL").get(req.params.id,cfg.guildId);
    if(!native||p&&p.state!=="published")throw fault(404,"Publicação indisponível.");
    const {reason}=z.object({reason:z.string().trim().min(5).max(500)}).strict().parse(req.body);
    db.prepare("INSERT OR IGNORE INTO iw_reports(id,publicationId,userId,reason,createdAt) VALUES(?,?,?,?,?)").run(randomUUID(),native.id,req.session.userId,reason,Date.now());
    store.audit(req.session.userId,"report.created",native.id);return {ok:true};
  });
  app.get("/api/notifications",async req=>{await guard(req);const {limit,offset}=page(req);return {items:db.prepare("SELECT * FROM iw_notifications WHERE userId=? AND guildId=? ORDER BY createdAt DESC LIMIT ? OFFSET ?").all(req.session.userId,cfg.guildId,limit,offset)};});
  app.patch("/api/notifications/:id",async req=>{await guard(req);db.prepare("UPDATE iw_notifications SET readAt=? WHERE id=? AND userId=? AND guildId=?").run(Date.now(),req.params.id,req.session.userId,cfg.guildId);return {ok:true};});
  app.get("/api/admin/settings",async req=>{
    const ctx=await guard(req,{admin:true});const roles=await ctx.guild.roles.fetch(),channels=await ctx.guild.channels.fetch();
    return {settings:store.settings(),roles:[...roles.values()].map(r=>({id:r.id,name:r.name})),
      channels:[...channels.values()].filter(c=>c?.isTextBased()&&!c.isThread()).map(c=>({id:c.id,name:c.name})),policy:worker.policy,moderationModel:"omni-moderation-latest"};
  });
  app.patch("/api/admin/settings",async req=>{
    const ctx=await guard(req,{admin:true});const s=settingsSchema.parse(req.body);
    const c=await ctx.guild.channels.fetch(s.channelId);
    if(!c||c.type!==0)throw fault(400,"Escolha um canal de texto deste servidor.");await access.botChannel(c);
    if(s.logChannelId){const logs=await ctx.guild.channels.fetch(s.logChannelId);if(!logs||logs.permissionsFor(ctx.guild.roles.everyone)?.has(1024n))throw fault(400,"O canal de logs deve ser privado.");}
    for(const rid of [...s.allowedRoles,...s.blockedRoles,...s.moderatorRoles,...s.vipRoles])if(!await ctx.guild.roles.fetch(rid))throw fault(400,"Cargo inválido.");
    // Channel changes must also use the existing Instagram configuration.
    db.prepare("INSERT OR REPLACE INTO instagram_settings VALUES(?,?)").run(cfg.guildId,s.channelId);
    return store.saveSettings(s,req.session.userId);
  });
  app.get("/api/admin/stats",async req=>{
    await guard(req,{moderator:true});
    const days=Math.min(90,Math.max(1,Number(req.query.days)||7)),since=Date.now()-days*86400000;
    const rows=db.prepare("SELECT state,COUNT(*) count FROM iw_publications WHERE guildId=? AND createdAt>=? GROUP BY state").all(cfg.guildId,since);
    const events=db.prepare("SELECT e.kind,COUNT(*) count,AVG(e.durationMs) averageMs FROM iw_events e JOIN iw_publications p ON p.id=e.publicationId WHERE e.createdAt>=? AND p.guildId=? GROUP BY e.kind").all(since,cfg.guildId);
    return {states:rows,events,activeMembers:db.prepare("SELECT COUNT(DISTINCT userId) n FROM iw_publications WHERE guildId=? AND createdAt>=?").get(cfg.guildId,since).n,
      queue:db.prepare("SELECT COUNT(*) n FROM iw_publications WHERE guildId=? AND state IN ('pending','analyzing','retry','approved','publishing')").get(cfg.guildId).n,
      bot:true,database:db.prepare("SELECT 1 ok").get().ok===1,model:"omni-moderation-latest",policy:worker.policy};
  });
  app.get("/api/admin/publications",async req=>{
    await guard(req,{moderator:true});const {limit,offset}=page(req),state=String(req.query.state||""),user=String(req.query.user||"");
    return {items:db.prepare("SELECT * FROM iw_publications WHERE guildId=? AND (?='' OR state=?) AND (?='' OR userId=?) AND COALESCE(error,'')!='safety_restricted' ORDER BY createdAt DESC LIMIT ? OFFSET ?").all(cfg.guildId,state,state,user,user,limit,offset).map(safe)};
  });
  app.delete("/api/admin/publications/:id",async req=>{
    await guard(req,{moderator:true});const p=store.publication(req.params.id);if(!p||p.error==="safety_restricted")throw fault(404,"Publicação indisponível.");
    const {reason}=z.object({reason:z.string().trim().min(5).max(500)}).parse(req.body);return remove(p,req.session.userId,reason);
  });
  app.post("/api/admin/publications/:id/review",async req=>{
    await guard(req,{moderator:true});const p=store.publication(req.params.id);
    if(!p||p.state!=="review"||!p.approval)throw fault(409,"Revisão indisponível.");
    const {approve,reason}=z.object({approve:z.boolean(),reason:z.string().trim().min(5).max(500)}).strict().parse(req.body);
    if(approve){
      // Only images already cleared by omni can enter this state. Integrity is checked again by the worker.
      db.prepare("UPDATE iw_publications SET state='approved',nextAt=0 WHERE id=? AND approval IS NOT NULL").run(p.id);
    }else{store.state(p,"rejected","additional_rules");await images.remove(cfg.storage,store.images(p.id));}
    store.audit(req.session.userId,approve?"review.approved":"review.denied",p.id,reason);return {ok:true};
  });
  app.post("/api/admin/publications/:id/reveal",async req=>{
    await guard(req,{moderator:true});const p=store.publication(req.params.id);
    if(!p||p.state!=="review"||!p.approval||p.error==="safety_restricted")throw fault(404,"Conteúdo indisponível para revisão comum.");
    const {reason}=z.object({reason:z.string().trim().min(5).max(500)}).parse(req.body);
    store.audit(req.session.userId,"review.images.revealed",p.id,reason);
    return {images:store.images(p.id).map(i=>({id:i.id,kind:i.kind,mime:i.mime,url:`/api/admin/publications/${p.id}/images/${i.id}?guildId=${p.guildId}`}))};
  });
  app.post("/api/admin/publications/:id/reconcile",async req=>{
    await guard(req,{moderator:true});
    const p=store.publication(req.params.id);
    if(!p||p.state!=="uncertain"||!p.approval)throw fault(409,"Esta publicação não está aguardando conferência.");
    const input=z.object({messageId:id,reason:z.string().trim().min(5).max(500)}).strict().parse(req.body);
    const photoRows=store.images(p.id);
    if(worker.digest(p,photoRows)!==p.approval)throw fault(409,"Aprovação de segurança inválida.");
    for(const photo of photoRows)await images.read(cfg.storage,photo);
    const guild=await access.guild(),channel=await guild.channels.fetch(p.channelId);
    const message=await channel.messages.fetch(input.messageId);
    const components=message.components?.[0]?.toJSON();
    const names=[...message.attachments.values()].map(a=>a.name).sort();
    const expected=photoRows.map(i=>i.filename).sort();
    const texts=(components?.components||[]).filter(c=>c.type===10).map(c=>c.content);
    const buttons=(components?.components||[]).flatMap(c=>c.components||[]).map(c=>c.custom_id);
    const bot=await guild.members.fetchMe();
    if(message.author?.id!==bot.id||JSON.stringify(names)!==JSON.stringify(expected)||
      texts[0]!==`<@${p.userId}>`||p.caption&&!texts.includes(p.caption)||
      !["like","comment","info","list"].every(action=>buttons.includes(`insta:${action}:${p.id}`)))
      throw fault(409,"A mensagem não corresponde a esta publicação aprovada.");
    db.prepare("UPDATE instagram_posts SET messageId=? WHERE id=? AND guildId=?").run(message.id,p.id,cfg.guildId);
    if(!worker.reconcile(p))throw fault(409,"O registro original da publicação não foi encontrado.");
    store.audit(req.session.userId,"publication.reconciled",p.id,input.reason);return {ok:true};
  });
  app.get("/api/admin/publications/:id/images/:image",async(req,res)=>{
    await guard(req,{moderator:true});const p=store.publication(req.params.id);
    if(!p||p.state!=="review"||!p.approval||p.error==="safety_restricted")throw fault(404,"Conteúdo indisponível.");
    const image=store.images(p.id).find(i=>i.id===req.params.image);
    if(!image)throw fault(404,"Imagem indisponível.");
    store.audit(req.session.userId,"review.image.accessed",p.id);
    return res.header("Cache-Control","no-store").type(image.mime||"image/jpeg").send(await images.read(cfg.storage,image));
  });
  app.get("/api/admin/reports",async req=>{await guard(req,{moderator:true});const {limit,offset}=page(req);return {items:db.prepare("SELECT r.* FROM iw_reports r JOIN instagram_posts p ON p.id=r.publicationId WHERE p.guildId=? ORDER BY r.createdAt DESC LIMIT ? OFFSET ?").all(cfg.guildId,limit,offset)};});
  app.patch("/api/admin/reports/:id",async req=>{
    await guard(req,{moderator:true});const {reason}=z.object({reason:z.string().trim().min(5).max(500)}).parse(req.body);
    const report=db.prepare("SELECT r.id FROM iw_reports r JOIN instagram_posts p ON p.id=r.publicationId WHERE r.id=? AND p.guildId=?").get(req.params.id,cfg.guildId);
    if(!report)throw fault(404,"Denúncia indisponível.");
    db.prepare("UPDATE iw_reports SET state='closed',reviewerId=? WHERE id=?").run(req.session.userId,req.params.id);
    store.audit(req.session.userId,"report.closed",req.params.id,reason);return {ok:true};
  });
  app.get("/api/admin/logs",async req=>{await guard(req,{moderator:true});const {limit,offset}=page(req);return {items:db.prepare("SELECT id,actorId,action,resourceId,reason,createdAt FROM iw_audit WHERE guildId=? ORDER BY createdAt DESC LIMIT ? OFFSET ?").all(cfg.guildId,limit,offset)};});
  app.get("/api/admin/users",async req=>{
    await guard(req,{moderator:true});const {limit,offset}=page(req);const search=String(req.query.search||"").slice(0,100);
    return {items:db.prepare("SELECT u.id,u.profile FROM iw_users u JOIN iw_user_guilds g ON g.userId=u.id WHERE g.guildId=? AND instr(u.id,?)>0 ORDER BY u.updatedAt DESC LIMIT ? OFFSET ?").all(cfg.guildId,search,limit,offset).map(u=>({...u,...store.restriction(u.id),profile:JSON.parse(u.profile)}))};
  });
  app.post("/api/admin/users/:id/restrict",async req=>{
    await guard(req,{moderator:true});id.parse(req.params.id);
    const d=z.object({hours:z.number().int().min(1).max(8760),reason:z.string().trim().min(5).max(500),dailyLimit:z.number().int().min(1).max(200).nullable().default(null)}).strict().parse(req.body);
    const target=await access.check(req.params.id);
    if(target.admin)throw fault(403,"Não é permitido restringir administradores.");
    store.setRestriction(req.params.id,Date.now()+d.hours*3600000,d.reason,d.dailyLimit);
    store.audit(req.session.userId,"member.restricted",req.params.id,d.reason);
    store.notify(req.params.id,null,"Seu acesso à publicação foi temporariamente restrito.");
    return {ok:true};
  });
  app.post("/api/admin/users/:id/unrestrict",async req=>{
    await guard(req,{moderator:true});const {reason}=z.object({reason:z.string().trim().min(5).max(500)}).parse(req.body);
    store.clearRestriction(req.params.id);store.audit(req.session.userId,"member.unrestricted",req.params.id,reason);
    store.notify(req.params.id,null,"Sua restrição na plataforma foi removida.");return {ok:true};
  });
  return {safe,quotas};
};
