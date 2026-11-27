const {createHash,randomUUID}=require("node:crypto");
const {createModeration}=require("../media-moderation/openai");
const {createProcessor}=require("../media-moderation/processor");
const {createStore}=require("../media-moderation/store");
const {childSafetySignal}=require("../media-moderation/safety");
const files=require("./images");
const POLICY="web-omni-v2";
module.exports=function worker({store,cfg,access,instagram,moderation=createModeration(),scope}){
  const db=store.db;
  const videoModeration={...moderation,configured:moderation.configured!==false,
    model:moderation.model||"omni-moderation-latest",transcribe:moderation.transcribe||(async()=>"")};
  const videoProcessor=createProcessor({moderation:videoModeration});
  const mediaStore=createStore(db);
  let busy=false,closed=false,timer,current;
  // A crash during analysis can safely retry. A crash during Discord send cannot.
  db.prepare("UPDATE iw_publications SET state='pending' WHERE state IN ('processing','analyzing')").run();
  db.prepare("UPDATE iw_publications SET state='uncertain',error='delivery_uncertain' WHERE state='publishing'").run();
  function digest(p,images){return createHash("sha256").update(JSON.stringify({caption:p.caption,handle:p.handle,images:images.map(i=>i.hash),policy:POLICY})).digest("hex");}
  function saveProfile(p){
    const source=`web:${p.id}`;
    db.prepare(`INSERT INTO instagram_submissions(id,guildId,originalMessageId,authorId,handle) VALUES(?,?,?,?,?)
      ON CONFLICT(guildId,originalMessageId) DO UPDATE SET handle=excluded.handle`).run(
      createHash("sha256").update(`${p.guildId}:${source}`).digest("hex"),p.guildId,source,p.userId,p.handle);
  }
  async function discard(p){await files.remove(cfg.storage,store.images(p.id));}
  async function analyze(p,images,buffers){
    if(moderation.model!=="omni-moderation-latest"||videoProcessor.model!=="omni-moderation-latest")throw new Error("invalid_moderation_model");
    const onRequest=()=>store.event("openai.request",p.id);
    const text=[p.caption,p.handle].filter(Boolean).join("\n");
    const videoIndex=images.findIndex(i=>i.kind==="video");
    let severe=childSafetySignal(text),blocked=false,review=false,result={};
    if(videoIndex>=0){
      // The same processor used by the bot: frames across the timeline, scene
      // changes and the end are submitted to the mandatory omni model.
      let decision;
      try{
        decision=await videoProcessor.moderate(buffers[videoIndex],images[videoIndex].mime||"video/mp4",
          {...mediaStore.settings(p.guildId),superficial:false,onRequest},text);
      }catch(error){
        if(error.kind==="child_safety"){severe=true;result={error:"child_safety"};}
        else throw error;
      }
      if(decision){
        result={video:decision,coverage:decision.coverage};
        severe=severe||decision.categories?.includes("sexual/minors");
        blocked=decision.decision==="blocked";
        review=decision.decision!=="approved"||decision.coverage?.complete===false;
      }
    }else{
      const results=[];
      if(text)results.push(await moderation.classify(text,"text",onRequest));
      for(const buffer of buffers)results.push(await moderation.classify([{type:"image_url",image_url:{url:`data:image/jpeg;base64,${buffer.toString("base64")}`}}],"image",onRequest));
      result={results};
      severe=severe||results.some(r=>r.categories["sexual/minors"]===true);
      blocked=results.some(r=>r.flagged||Object.keys(r.categories).some(k=>r.categories[k]&&r.category_applied_input_types[k]?.includes(r.modality)));
    }
    db.prepare("INSERT INTO iw_moderation VALUES(?,?,?,?,?)").run(randomUUID(),p.id,Date.now(),POLICY,JSON.stringify(result));
    if(severe){store.state(p,"rejected","safety_restricted");await discard(p);return false;}
    if(blocked){store.state(p,"rejected","policy");await discard(p);return false;}
    const approval=digest(p,images);
    db.prepare("UPDATE iw_publications SET approval=? WHERE id=?").run(approval,p.id);
    if(review){store.state(p,"review");return false;}
    const s=store.settings();
    if(s.manualReview||s.forbiddenWords.some(w=>text.toLocaleLowerCase().includes(w.toLocaleLowerCase()))){
      store.state(p,"review");return false;
    }
    return true;
  }
  async function deliver(p,images,buffers){
    const ctx=await access.check(p.userId,{publish:true});
    await access.botChannel(ctx.channel);
    const settings=store.settings();
    if(images.length>settings.maxImages||images.some(i=>i.bytes>settings.maxBytes))throw new Error("changed_limits");
    const r=store.restriction(p.userId);
    const dailyLimit=r?.dailyLimit||ctx.limits.daily;
    const dayStart=Math.floor((p.createdAt-3*3600000)/86400000)*86400000+3*3600000;
    const position=db.prepare("SELECT COUNT(*) n FROM iw_publications WHERE userId=? AND guildId=? AND createdAt>=? AND createdAt<=?").get(p.userId,cfg.guildId,dayStart,p.createdAt).n;
    if(position>dailyLimit)throw new Error("changed_daily_limit");
    const fresh=store.publication(p.id);
    if(fresh.state!=="approved"||fresh.approval!==digest(fresh,images))throw new Error("invalid_approval");
    if(fresh.operation==="edit"){
      const post=db.prepare("SELECT * FROM instagram_posts WHERE id=?").get(p.id);
      if(!post?.messageId)throw new Error("missing_publication");
      const channel=await ctx.guild.channels.fetch(post.channelId);
      const message=await channel.messages.fetch(post.messageId);
      const attachments=[...message.attachments.values()];
      const urls=attachments.map(a=>a.url);
      if(!urls.length)throw new Error("missing_media");
      db.prepare("UPDATE iw_publications SET state='publishing' WHERE id=?").run(p.id);
      await message.edit(instagram.render({...post,caption:p.caption},urls));
      db.prepare("UPDATE instagram_posts SET caption=? WHERE id=?").run(p.caption,p.id);
      db.prepare("UPDATE iw_publications SET operation='publish' WHERE id=?").run(p.id);
    }else{
      db.prepare("UPDATE iw_publications SET state='publishing',channelId=? WHERE id=?").run(ctx.channel.id,p.id);
      const sent=await instagram.publish({channel:ctx.channel,authorId:p.userId,id:p.id,filename:images[0].filename,
        images:images.map((i,n)=>({buffer:buffers[n],filename:i.filename})),caption:p.caption,originalMessageId:`web:${p.id}`});
      db.prepare("UPDATE iw_publications SET messageId=?,channelId=? WHERE id=?").run(sent.id,ctx.channel.id,p.id);
    }
    saveProfile(p);
    store.state(p,"published");
    // Keep private approved bytes for seven days to support re-moderated edits; cleanup removes later.
  }
  async function processOne(){
    const p=db.prepare("SELECT * FROM iw_publications WHERE state IN ('pending','retry','approved') AND nextAt<=? ORDER BY createdAt LIMIT 1").get(Date.now());
    if(!p)return;
    return scope?scope.run(p.guildId,()=>processPublication(p)):processPublication(p);
  }
  async function processPublication(p){
    // Claim synchronously before the first await so deletion cannot race an in-memory job.
    store.state(p,"processing");
    const start=Date.now();
    try{
      const images=store.images(p.id);
      if(!images.length)throw new Error("missing_media");
      const buffers=await Promise.all(images.map(i=>files.read(cfg.storage,i)));
      await access.check(p.userId,{publish:true});
      if(p.state!=="approved"){
        store.state(p,"analyzing");
        const t=Date.now();
        let approved;
        try{approved=await analyze(p,images,buffers);}
        catch(e){store.event("openai.error",p.id);throw e;}
        store.event("openai.duration",p.id,Date.now()-t);
        if(!approved)return;
        store.state(p,"approved");
      }else store.state(p,"approved");
      await deliver(p,images,buffers);
      store.event("processing.duration",p.id,Date.now()-start);
    }catch(error){
      const fresh=store.publication(p.id);
      // Unknown send outcome is quarantined rather than silently sending twice.
      if(fresh.state==="publishing"){
        const post=db.prepare("SELECT messageId,channelId FROM instagram_posts WHERE id=?").get(p.id);
        if(post?.messageId&&p.operation!=="edit"){db.prepare("UPDATE iw_publications SET messageId=?,channelId=? WHERE id=?").run(post.messageId,post.channelId,p.id);saveProfile(p);store.state(p,"published");}
        else store.state(p,"uncertain","delivery_uncertain");
        store.event("discord.error",p.id);
      }else{
        const attempts=p.attempts+1;
        const permanent=error.statusCode===403||error.kind==="configuration"||error.kind==="permanent";
        db.prepare("UPDATE iw_publications SET attempts=?,nextAt=? WHERE id=?").run(attempts,Date.now()+Math.min(3600000,10000*2**attempts),p.id);
        store.state(p,permanent||attempts>=4?"failed":"retry","temporarily_unavailable");
        store.event("processing.error",p.id);
      }
    }
  }
  async function cleanup(){
    const cutoff=Date.now()-7*86400000;
    const rows=db.prepare("SELECT * FROM iw_publications WHERE updatedAt<? AND state IN ('published','rejected','failed','deleted','review','uncertain')").all(cutoff);
    for(const p of rows){await discard(p);if(p.state==="review")store.state(p,"failed","retention_expired");}
    const fs=require("node:fs/promises"),path=require("node:path");
    const known=new Set(db.prepare("SELECT filename FROM iw_images").all().map(i=>i.filename));
    for(const filename of await fs.readdir(cfg.storage)){
      if(!/^[a-f0-9-]+\.(jpg|mp4|mov|webm)$/.test(filename)||known.has(filename))continue;
      const file=path.join(cfg.storage,filename),stat=await fs.stat(file);
      if(stat.mtimeMs<Date.now()-3600000)await fs.unlink(file);
    }
    db.prepare("DELETE FROM iw_sessions WHERE expiresAt<?").run(Date.now());
    db.prepare("DELETE FROM iw_native_tickets WHERE expiresAt<? OR usedAt IS NOT NULL").run(Date.now());
    db.prepare("DELETE FROM iw_events WHERE createdAt<?").run(Date.now()-90*86400000);
    db.prepare("DELETE FROM iw_audit WHERE createdAt<?").run(Date.now()-90*86400000);
    db.prepare("DELETE FROM iw_notifications WHERE createdAt<?").run(Date.now()-30*86400000);
    db.prepare("DELETE FROM iw_log_deliveries WHERE auditId NOT IN (SELECT id FROM iw_audit)").run();
  }
  async function tick(){if(busy||closed)return;busy=true;try{await processOne();}finally{busy=false;}}
  return {tick,cleanup,digest,policy:POLICY,
    start(){timer=setInterval(()=>{if(!busy&&!closed)current=tick().catch(()=>store.event("worker.error"));},2000);timer.unref();},
    async close(){closed=true;clearInterval(timer);await current;},
    reconcile(p){
      const post=db.prepare("SELECT * FROM instagram_posts WHERE id=?").get(p.id);
      if(post?.messageId){
        db.prepare("UPDATE iw_publications SET messageId=?,channelId=?,operation='publish' WHERE id=?").run(post.messageId,post.channelId,p.id);
        if(p.operation==="edit")db.prepare("UPDATE instagram_posts SET caption=? WHERE id=?").run(p.caption,p.id);
        saveProfile(p);store.state(p,"published");return true;
      }
      return false;
    }};
};
