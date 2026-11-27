const {randomUUID,createHash}=require("node:crypto");
const fs=require("node:fs/promises");
const path=require("node:path");
const os=require("node:os");
const {
  ContainerBuilder,TextDisplayBuilder,SeparatorBuilder,SeparatorSpacingSize,SectionBuilder,ThumbnailBuilder,
  ActionRowBuilder,ButtonBuilder,ButtonStyle,StringSelectMenuBuilder,ChannelSelectMenuBuilder,RoleSelectMenuBuilder,
  ChannelType,MessageFlags,PermissionFlagsBits,ModalBuilder,LabelBuilder,TextInputBuilder,TextInputStyle
}=require("discord.js");
const {fileTypeFromBuffer}=require("file-type");
const {createStore,RULE_VERSION}=require("./store");
const {createProcessor,downloadAttachment,MIME_EXT}=require("./processor");
const {createMediaLogger}=require("./logs");
const {approvedPublication,replyMessageId}=require("./publication");
const {childSafetySignal}=require("./safety");
const {mediaEnvelope}=require("./forwarded");
const {channelScope,isThread}=require("./channel-scope");
const {createCrossReview}=require("./cross-review");
const {createSuperficial}=require("./superficial");
const {serverName}=require("../brand");
const {errorText,statusText,safeMessage}=require("../error-ui");
const painelEmojis=require("../lumiya-ui/emojis");

const TEMP_ROOT=path.join(process.platform==="win32"?path.join(os.tmpdir(),"opencode"):os.tmpdir(),"mds-media-moderation");
const SAFE_NOTICE="Mídias e legendas dos canais monitorados poderão ser analisadas pelo serviço externo OpenAI Moderation. Vídeos/GIFs são amostrados; áudio pode ser transcrito se habilitado. Não envie dados pessoais ou sensíveis. A exposição antes da remoção não pode ser eliminada.";
const MAX_CAPTION=1000;
const RULE_LABELS={childProtection:"Proteção de menores (procedimento especial)",nazism:"Nazismo / neonazismo (sinais de ódio em texto)",extremism:"Extremismo (ódio/ilícitos violentos em texto)",sexual:"Conteúdo sexual explícito",graphicViolence:"Violência gráfica",violence:"Violência",selfHarm:"Automutilação",illicit:"Atividades ilícitas (somente texto)",hate:"Ódio (somente texto)",targetedHarassment:"Assédio (somente texto)",scams:"Golpes (sem classificador automático)",personalData:"Dados pessoais (sem detector automático)",allowGameWeapons:"Permitir armas em jogos/ficção",ambiguousReview:"Enviar ambiguidades para revisão"};
module.exports=function installMediaModeration({client,registry,db,moderationProcessor}){
  const store=createStore(db),processor=moderationProcessor||createProcessor({store}),inflight=new Set(),userWindow=new Map(),queue=[],reviewLocks=new Set();
  const instagram=require("../instagram")({client,registry,db});
  async function publishApproved(channel,data){
    const destination=data.caseId?await instagram.deliveryChannel(data.caseId):null;
    if(destination)return instagram.publish({channel:destination,...data});
    if(instagram.isChannel(channel.guildId,channel.id))return instagram.publish({channel,...data});
    const original=data.caseId?store.db.prepare("SELECT guildId,channelId,replyMessageId FROM media_moderation_cases WHERE id=?").get(data.caseId):null;
    const reply=original?.guildId===channel.guildId&&original.channelId===channel.id?original.replyMessageId:null;
    return channel.send(approvedPublication({...data,replyMessageId:reply}));
  }
  store.db.prepare("UPDATE media_moderation_cases SET status='review',decision='review',reason='Análise interrompida por reinicialização; revisão necessária',errorKind='interrupted' WHERE status='processing'").run();
  const localLogger=createMediaLogger({client,registry,store}),crossReview=createCrossReview({client,registry,store});
  const logger={async logCase(id){await localLogger.logCase(id);await crossReview.notify(id);}};
  const superficial=createSuperficial({store,processor,enqueue,dailyBudget,recordBudget,
    logCase:id=>localLogger.logCase(id),isMonitored,isSuperficial});
  store.db.exec("CREATE TABLE IF NOT EXISTS media_moderation_notices(channelId TEXT PRIMARY KEY,provider TEXT NOT NULL,messageId TEXT NOT NULL)");
  const noticeLocks=new Set(),publicationDeletes=new Set();
  async function announceConfigured(guild){if(!guild||!store.settings(guild.id).enabled)return;try{const channels=await guild.channels.fetch();for(const channel of channels.values())await announce(channel);}catch{console.warn("[Moderação de mídia] Verifique o aviso de análise externa nos canais configurados.");}}
  async function announce(channel){
    if(!channel?.isTextBased?.()||!isMonitored({guildId:channel.guildId,channelId:channel.id,channel}))return;
    if(noticeLocks.has(channel.id))return;
    if(store.db.prepare("SELECT 1 FROM media_moderation_notices WHERE channelId=? AND provider='OpenAI'").get(channel.id))return;
    noticeLocks.add(channel.id);
    try{const sent=await channel.send({content:`**Aviso de moderação de mídias**\n${SAFE_NOTICE}`,allowedMentions:{parse:[]}});registry.preserveMessage(sent);store.db.prepare("INSERT OR REPLACE INTO media_moderation_notices VALUES(?,'OpenAI',?)").run(channel.id,sent.id);}catch{console.warn("[Moderação de mídia] Publique o aviso de análise externa no canal monitorado; aviso automático indisponível.");}finally{noticeLocks.delete(channel.id);}
  }
  const maxConcurrent=Math.max(1,Math.min(8,Number(process.env.MEDIA_MODERATION_MAX_CONCURRENT)||3));let active=0,activeVideos=0;
  const V2=MessageFlags.IsComponentsV2;
  const text=content=>new TextDisplayBuilder().setContent(statusText(content));
  const separator=()=>new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small);
  const payload=(container,ephemeral=false)=>{
    const files=require("../configuration/runtime").filesFor([container]);
    return require("../lumiya-ui/canonical").canonical({components:[container],...(files.length?{files}:{}),
      flags:V2|(ephemeral?MessageFlags.Ephemeral:0),allowedMentions:{parse:[]}});
  };
  const admin=member=>Boolean(member?.permissions?.has(PermissionFlagsBits.ManageGuild));
  function authorized(member,guildId){if(admin(member))return true;const ids=store.settings(guildId).reviewRoleIds||[];return ids.some(id=>member?.roles?.cache?.has(id));}
  function instagramIntakeId(message){
    const scope=channelScope(message);
    return scope.channelIds.find(id=>instagram.isIntake(message.guildId,id));
  }
  function isSuperficial(message){
    if(instagramIntakeId(message))return false;
    const ids=store.settings(message.guildId).superficialChannelIds;
    return channelScope(message).channelIds.some(id=>ids.includes(id));
  }
  function isAutomaticChat(channel){return channel?.name==="chat"&&[ChannelType.GuildText,ChannelType.GuildAnnouncement].includes(channel.type);}
  function isMonitored(message){
    if(instagramIntakeId(message))return true;
    const scope=channelScope(message),rows=store.channels(message.guildId);
    if(rows.some(x=>x.kind==="exclude"&&scope.channelIds.includes(x.channelId)))return false;
    return isAutomaticChat(scope.channel)||isAutomaticChat(scope.parent)||isSuperficial(message)||
      rows.some(x=>x.kind==="channel"&&scope.channelIds.includes(x.channelId))||
      rows.some(x=>x.kind==="category"&&x.channelId===scope.categoryId);
  }
  async function resolveThreadParent(message){
    if(!isThread(message.channel)||message.channel.parent||
        message.guild?.channels?.cache?.get(message.channel.parentId)||!message.channel.parentId)return message;
    const parent=await message.guild?.channels?.fetch?.(message.channel.parentId).catch(()=>null);
    if(!parent||(parent.guildId||parent.guild?.id)!==message.guildId)return message;
    const scoped=Object.create(message);
    Object.defineProperty(scoped,"moderationParent",{value:parent});
    return scoped;
  }
  const threadJoins=new Set();
  async function watchThread(thread){
    if(!isThread(thread)||!thread.guild||thread.archived||thread.locked||thread.joined||thread.joinable===false)return;
    if(threadJoins.has(thread.id))return;
    threadJoins.add(thread.id);
    try{
      const context=await resolveThreadParent({guild:thread.guild,guildId:thread.guildId||thread.guild.id,channelId:thread.id,channel:thread});
      if((!store.settings(context.guildId).enabled&&!instagramIntakeId(context))||!isMonitored(context))return;
      await thread.join?.();
    }finally{threadJoins.delete(thread.id);}
  }
  client.on("threadCreate",thread=>{void watchThread(thread).catch(()=>console.warn("[Moderação de mídia] Não foi possível acompanhar o tópico; verifique o acesso do bot."));});
  client.on("threadUpdate",(_before,thread)=>{void watchThread(thread).catch(()=>console.warn("[Moderação de mídia] Não foi possível acompanhar o tópico; verifique o acesso do bot."));});
  function likelyChildSafety(message){return childSafetySignal(String(message.content||"")+" "+[...message.attachments.values()].map(a=>a.name||"").join(" "));}
  function componentsError(title,body){return new ContainerBuilder().setAccentColor(0).addTextDisplayComponents(text(errorText(`# ${title}\n${body}`)));}
  async function privateNotice(userId,guildId,title,body,caseId=null){
    try{const user=await client.users.fetch(userId);const c=new ContainerBuilder().setAccentColor(0).addTextDisplayComponents(text(`# ${title}\n\n${body}`));
       if(caseId)c.addActionRowComponents(new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`mds-media-appeal:${caseId}`).setLabel("Solicitar revisão").setStyle(ButtonStyle.Secondary)));
      await user.send(payload(c));
    }catch{/* DM fechada: não falha o fluxo de moderação */}
  }
  function insertCase(data){store.db.prepare(`INSERT INTO media_moderation_cases(id,guildId,channelId,authorId,originalMessageId,mediaType,createdAt,status,decision,reason,categories,model,rulesVersion,filePath,filename,mimeType,caption,sha256,requestId) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(data.id,data.guildId,data.channelId,data.authorId,data.originalMessageId,data.mediaType,data.createdAt,data.status,data.decision||null,data.reason||null,JSON.stringify(data.categories||[]),data.model||null,RULE_VERSION,data.filePath||null,data.filename||null,data.mimeType||null,data.caption||null,data.sha256||null,data.requestId||null);}
  function dailyBudget(guildId,settings){const day=new Date().toISOString().slice(0,10);const row=store.db.prepare("SELECT * FROM media_moderation_budget WHERE guildId=? AND day=?").get(guildId,day);return {day,ok:(row?.requests||0)<Math.max(1,Number(process.env.MEDIA_MODERATION_DAILY_REQUESTS)||Math.floor(settings.dailyBudgetUSD*100)),requests:row?.requests||0};}
  function recordBudget(guildId,day,cost=0){store.db.prepare(`INSERT INTO media_moderation_budget(guildId,day,requests,estimatedCost) VALUES(?,?,1,?) ON CONFLICT(guildId,day) DO UPDATE SET requests=requests+1,estimatedCost=estimatedCost+excluded.estimatedCost`).run(guildId,day,cost);}
  async function preserveApproved(message,attachment,buffer,filename,mime,caption,caseId){
    const channel=await client.channels.fetch(message.channelId).catch(()=>null);if(!channel?.isTextBased()||channel.guildId!==message.guildId)throw new Error("Canal de origem indisponível");
    const member=await message.guild.members.fetch(message.author.id).catch(()=>null);if(!member||member.user?.bot)throw new Error("Autor não está mais elegível");
    const sent=await publishApproved(channel,{authorId:message.author.id,buffer,filename,mime,caption,originalMessageId:message.id,caseId});
    registry.preserveMessage(sent);
    return sent;
  }
  async function processAttachment(message,attachment,caseId,capturedPath=null){
    const settings=store.settings(message.guildId),maxBytes=Math.min(100,settings.maxFileMB)*1024*1024;
    if(attachment.size>maxBytes)throw new Error("Arquivo acima do limite; requer revisão");
    if(likelyChildSafety(message))throw Object.assign(new Error("Segurança infantil: procedimento especializado, sem envio à API"),{kind:"child_safety"});
    if(!capturedPath){const dir=path.join(TEMP_ROOT,message.guildId);await fs.mkdir(dir,{recursive:true,mode:0o700});capturedPath=path.join(dir,`${caseId}.bin`);await downloadAttachment(attachment.url,maxBytes,capturedPath);store.db.prepare("UPDATE media_moderation_cases SET filePath=?,filename=? WHERE id=?").run(capturedPath,attachment.name||"media",caseId);}
    const buffer=await fs.readFile(capturedPath);
    const type=await fileTypeFromBuffer(buffer);if(!type||!MIME_EXT[type.mime])throw new Error("Formato real do arquivo não permitido; requer revisão");
    const digest=createHash("sha256").update(buffer).digest("hex"),analysisCaption=String(message.content||"").slice(0,20000),caption=analysisCaption.slice(0,MAX_CAPTION);
    // Invalidate approvals when provider/model or guild rules change.
    const cacheVersion=`${RULE_VERSION}:${createHash("sha256").update(JSON.stringify({model:processor.model,rules:settings.rules})).digest("hex")}`;
    const existing=!analysisCaption&&!type.mime.startsWith("video/")&&type.mime!=="image/gif"?store.db.prepare("SELECT decision FROM media_moderation_hashes WHERE guildId=? AND sha256=? AND rulesVersion=? AND createdAt>?").get(message.guildId,digest,cacheVersion,Date.now()-3600000):null;
    const budget=dailyBudget(message.guildId,settings);if(!budget.ok)throw new Error("Limite diário de análise atingido; requer revisão");
    if(likelyChildSafety(message))throw new Error("Sinalização de possível risco de segurança infantil; conteúdo não enviado à API e requer procedimento especializado");
    store.db.prepare("UPDATE media_moderation_cases SET provider='OpenAI',model=? WHERE id=?").run(processor.model,caseId);
    const onRequest=()=>{const quota=dailyBudget(message.guildId,settings);if(!quota.ok)throw new Error("Cota diária atingida");recordBudget(message.guildId,quota.day,0);};
    const decision=existing?.decision==="approved"?{decision:"approved",reason:"Hash aprovado sob a versão atual das regras (cache até 1 hora).",categories:[],confidence:null,requiresHumanReview:false}:await processor.moderate(buffer,type.mime,{...settings,superficial:false,onRequest},analysisCaption);
    if(decision.categories.includes("sexual/minors")){
      await fs.rm(capturedPath,{force:true});
      store.db.prepare("UPDATE media_moderation_cases SET status='review',decision='review',reason='Sinalização de segurança infantil; procedimento especializado, sem republicação',categories=?,errorKind='child_safety',filePath=NULL WHERE id=?").run(JSON.stringify(decision.categories),caseId);
      await privateNotice(message.author.id,message.guildId,"Envio retido para procedimento especializado","O envio não será republicado automaticamente. A equipe deve seguir as diretrizes de segurança da plataforma.");return;
    }
    store.db.prepare("UPDATE media_moderation_cases SET provider='OpenAI',analysisMs=?,analysisData=?,requestId=? WHERE id=?").run(decision.analysisMs??0,JSON.stringify({results:decision.rawResults||[],coverage:decision.coverage||null,cacheHit:Boolean(existing)}),decision.rawResults?.[0]?.id||null,caseId);
    const row=store.db.prepare("SELECT * FROM media_moderation_cases WHERE id=?").get(caseId);
    if(decision.decision==="approved"){
      const sent=await preserveApproved(message,attachment,buffer,`${caseId}.${MIME_EXT[type.mime]}`,type.mime,caption,caseId);
      store.db.prepare("UPDATE media_moderation_cases SET status='approved',decision='approved',reason=?,categories=?,model=?,sha256=?,repostedMessageId=?,filename=?,mimeType=?,caption=? WHERE id=?").run(decision.reason,JSON.stringify(decision.categories),settings.visionModel,digest,sent.id,`${caseId}.${MIME_EXT[type.mime]}`,type.mime,caption,caseId);
      store.db.prepare("INSERT OR REPLACE INTO media_moderation_hashes VALUES(?,?,?,?,?)").run(message.guildId,digest,"approved",cacheVersion,Date.now());
      if(capturedPath){await fs.rm(capturedPath,{force:true});store.db.prepare("UPDATE media_moderation_cases SET filePath=NULL WHERE id=?").run(caseId);}
      return;
    }
    const tempDir=path.join(TEMP_ROOT,message.guildId);await fs.mkdir(tempDir,{recursive:true,mode:0o700});
    const filePath=capturedPath||path.join(tempDir,`${caseId}.${MIME_EXT[type.mime]}`);if(!capturedPath)await fs.writeFile(filePath,buffer,{flag:"wx",mode:0o600});
    const status=decision.decision==="blocked"?"blocked":"review";
    store.db.prepare("UPDATE media_moderation_cases SET status=?,decision=?,reason=?,categories=?,model=?,sha256=?,filePath=?,filename=?,mimeType=?,caption=? WHERE id=?").run(status,decision.decision,decision.reason,JSON.stringify(decision.categories),settings.visionModel,digest,filePath,attachment.name||filePath.split(path.sep).at(-1),type.mime,caption,caseId);
    store.db.prepare("INSERT OR REPLACE INTO media_moderation_hashes VALUES(?,?,?,?,?)").run(message.guildId,digest,status,cacheVersion,Date.now());
    if(status==="blocked")await privateNotice(message.author.id,message.guildId,"Mídia bloqueada",`Sua mídia não foi aprovada pelo sistema de moderação de ${serverName(message.guild)}.\n\n**Motivo:** ${decision.categories.join(", ")||decision.reason}\n\n**Status:** Bloqueada`,caseId);
       else await privateNotice(message.author.id,message.guildId,"Mídia retida para revisão","A análise exige avaliação humana. Isso não confirma uma violação. Se quiser encaminhar o vídeo para revisão humana no servidor de revisão, clique abaixo.",caseId);
  }
  async function onMessage(message){
    if(!message.guild||message.author?.bot||message.webhookId)return;
    message=mediaEnvelope(message);
    if(!message.attachments?.size)return;
    message=await resolveThreadParent(message);
    if((!store.settings(message.guildId).enabled&&!instagramIntakeId(message))||!isMonitored(message))return;
    const eligible=[...message.attachments.values()].filter(a=>a.contentType?.startsWith("image/")||a.contentType?.startsWith("video/")||/\.(png|jpe?g|webp|gif|mp4|mov|webm)$/i.test(a.name||""));if(!eligible.length)return;
    if(inflight.has(message.id)||store.db.prepare("SELECT 1 FROM media_moderation_cases WHERE originalMessageId=? AND guildId=? LIMIT 1").get(message.id,message.guildId))return;inflight.add(message.id);
    const key=`${message.guildId}:${message.author.id}`,now=Date.now(),times=(userWindow.get(key)||[]).filter(t=>now-t<60000);
    const channelKey=`channel:${message.guildId}:${message.channelId}`,channelTimes=(userWindow.get(channelKey)||[]).filter(t=>now-t<60000);
    const limited=times.length>=5||channelTimes.length>=Math.max(1,Number(process.env.MEDIA_MODERATION_CHANNEL_PER_MINUTE)||30)||queue.length>=Math.max(1,Number(process.env.MEDIA_MODERATION_MAX_QUEUE)||50);
    times.push(now);channelTimes.push(now);userWindow.set(key,times);userWindow.set(channelKey,channelTimes);
    const cases=eligible.map(attachment=>({id:randomUUID(),attachment}));
    for(const item of cases){
      insertCase({id:item.id,guildId:message.guildId,channelId:message.channelId,authorId:message.author.id,originalMessageId:message.id,mediaType:item.attachment.contentType||"unknown",createdAt:message.createdTimestamp||now,status:"processing",caption:String(message.content||"").slice(0,MAX_CAPTION)});
      instagram.captureDelivery(item.id,message.guildId,instagramIntakeId(message)||message.channelId);
      const reply=replyMessageId(message);
      if(reply)store.db.prepare("UPDATE media_moderation_cases SET replyMessageId=? WHERE id=?").run(reply,item.id);
    }
    if(isSuperficial(message)){
      try{await superficial.inspect(message,cases,limited);}
      finally{inflight.delete(message.id);}
      return;
    }
    // Discord attachments may disappear immediately after deletion. Capture BEFORE
    // deleting, outside the AI queue, and retain the copy even if analysis fails.
    const safetyHold=likelyChildSafety(message);
    if(!safetyHold)for(const item of cases){
      try{
        const limit=Math.min(100,store.settings(message.guildId).maxFileMB)*1024*1024;
        if(item.attachment.size>limit)throw new Error("Arquivo acima do limite");
        const dir=path.join(TEMP_ROOT,message.guildId);await fs.mkdir(dir,{recursive:true,mode:0o700});
        item.capturedPath=path.join(dir,`${item.id}.bin`);
        await downloadAttachment(item.attachment.url,limit,item.capturedPath);
        store.db.prepare("UPDATE media_moderation_cases SET filePath=?,filename=? WHERE id=?").run(item.capturedPath,item.attachment.name||"media",item.id);
      }catch(error){item.captureError=error;}
    }
    try{await message.delete();}catch(error){
      if(error.code!==10008){
        console.warn("[Moderação de mídia] Não foi possível remover a mensagem original:",error.message);
        for(const item of cases)store.db.prepare("UPDATE media_moderation_cases SET status='review',decision='review',reason='Falha ao remover mensagem original; republicação suspensa' WHERE id=?").run(item.id);
        for(const item of cases)await logger.logCase(item.id);
        inflight.delete(message.id);return;
      }
    }
    await announce(message.channel);
    if(likelyChildSafety(message)){for(const item of cases){store.db.prepare("UPDATE media_moderation_cases SET status='review',decision='review',reason='Sinalização de segurança infantil; não enviado à API' WHERE id=?").run(item.id);await logger.logCase(item.id);}await privateNotice(message.author.id,message.guildId,"Mídia retida para procedimento especializado","O envio não foi analisado pela API externa e foi encaminhado para tratamento conforme as diretrizes de segurança da plataforma.");inflight.delete(message.id);return;}
    if(limited){for(const item of cases){store.db.prepare("UPDATE media_moderation_cases SET status='review',decision='review',reason='Limite de processamento atingido; arquivo retido para equipe' WHERE id=?").run(item.id);await logger.logCase(item.id);}await privateNotice(message.author.id,message.guildId,"Mídia retida","Limite de processamento atingido. A mídia requer revisão da equipe.");inflight.delete(message.id);return;}
    try{
      await enqueue(async()=>{
        for(const item of cases){
          const started=Date.now();
          try{
            if(item.captureError)throw item.captureError;
            await processAttachment(message,item.attachment,item.id,item.capturedPath);
          }catch(error){
            if(error.kind==="child_safety"){
              if(item.capturedPath)await fs.rm(item.capturedPath,{force:true}).catch(()=>{});
              store.db.prepare("UPDATE media_moderation_cases SET status='review',decision='review',reason='Sinalização de segurança infantil; procedimento especializado, sem republicação',errorKind='child_safety',filePath=NULL WHERE id=?").run(item.id);
              await privateNotice(message.author.id,message.guildId,"Envio retido para procedimento especializado","A análise foi interrompida. A equipe deve seguir as diretrizes de segurança da plataforma.");continue;
            }
            console.warn("[Moderação de mídia] Análise não concluída; revisão necessária.");
            store.db.prepare("UPDATE media_moderation_cases SET status='review',decision='review',reason=?,errorKind=?,analysisMs=? WHERE id=? AND status='processing'").run(
              item.captureError?"Não foi possível obter o anexo antes da exclusão; solicite reenvio privado.":"Análise incompleta ou falha técnica; revisão necessária.",
              error.kind||"technical",Date.now()-started,item.id);
            await privateNotice(message.author.id,message.guildId,"Mídia retida para revisão",item.captureError?
              "Não foi possível obter uma cópia do arquivo. Envie novamente pelo modo privado ao bot.":
              "Não foi possível concluir a análise automática. A equipe avaliará o envio; nenhum arquivo foi presumido seguro.");
          }
        }
      },eligible.some(a=>a.contentType?.startsWith("video/")||/\.(gif|mp4|mov|webm)$/i.test(a.name||"")));
    }
    catch(error){console.warn("[Moderação de mídia] Falha de fila:",error.message);for(const item of cases)store.db.prepare("UPDATE media_moderation_cases SET status='review',decision='review',reason=? WHERE id=? AND status='processing'").run("Fila indisponível; revisão necessária.",item.id);}
    finally{for(const item of cases)await logger.logCase(item.id);inflight.delete(message.id);}
  }
  async function onPrivateMessage(message){
    if(message.guild||message.author?.bot)return;
    const command=message.content?.trim().match(/^!midiaenviar\s+(\d{17,20})$/);if(!command)return;
    const incoming=mediaEnvelope(message);if(!incoming.attachments?.size)return;
    const forwardedCaption=incoming===message?"":incoming.content.replace(message.content,"").trim();message=incoming;
    const channelId=command[1],channel=await client.channels.fetch(channelId).catch(()=>null);
    if(!channel?.isTextBased?.()||!channel.guildId){await message.reply(errorText("Canal inválido. Peça a um moderador o ID de um canal monitorado.")).catch(()=>{});return;}
    const settings=store.settings(channel.guildId);if(!settings.enabled||!store.channels(channel.guildId).some(r=>r.kind==="channel"&&r.channelId===channelId)){await message.reply(errorText("Esse canal não está explicitamente habilitado para moderação.")).catch(()=>{});return;}
    if(inflight.has(message.id)||store.db.prepare("SELECT 1 FROM media_moderation_cases WHERE originalMessageId=? AND guildId=? LIMIT 1").get(message.id,channel.guildId))return;
    const privateKey=`${channel.guildId}:${message.author.id}`,now=Date.now(),recent=(userWindow.get(privateKey)||[]).filter(t=>now-t<60000);
    if(recent.length>=5){await message.reply(errorText("Limite de envios por minuto atingido. Tente novamente mais tarde.")).catch(()=>{});return;}
    recent.push(now);userWindow.set(privateKey,recent);inflight.add(message.id);
    const dummy={guild:channel.guild,guildId:channel.guildId,channelId,channel,author:message.author,attachments:message.attachments,content:forwardedCaption,createdTimestamp:message.createdTimestamp,id:`dm-${message.id}`,delete:async()=>{}};
    try{await enqueue(async()=>{for(const attachment of message.attachments.values()){
      const id=randomUUID();insertCase({id,guildId:channel.guildId,channelId,authorId:message.author.id,originalMessageId:message.id,mediaType:attachment.contentType||"unknown",createdAt:Date.now(),status:"processing"});
       try{await processAttachment(dummy,attachment,id);}catch(error){
         if(error.kind==="child_safety"){
           const held=store.db.prepare("SELECT filePath FROM media_moderation_cases WHERE id=?").get(id);
           if(held?.filePath)await fs.rm(held.filePath,{force:true}).catch(()=>{});
           store.db.prepare("UPDATE media_moderation_cases SET status='review',decision='review',reason='Sinalização de segurança infantil; procedimento especializado, sem republicação',errorKind='child_safety',filePath=NULL WHERE id=?").run(id);
         }else store.db.prepare("UPDATE media_moderation_cases SET status='review',decision='review',reason='Envio privado: análise incompleta' WHERE id=?").run(id);
         await privateNotice(message.author.id,channel.guildId,"Mídia retida",error.kind==="child_safety"?"O envio exige procedimento especializado de segurança da plataforma.":"A mídia está aguardando revisão humana.");
         console.warn("[Moderação de mídia] Envio privado retido para avaliação da equipe.");
       }finally{await logger.logCase(id);}
    }},[...message.attachments.values()].some(a=>a.contentType?.startsWith("video/")||/\.(gif|mp4|mov|webm)$/i.test(a.name||"")));await message.reply("Mídia recebida e submetida à moderação. Ela só será publicada se aprovada.").catch(()=>{});}catch{await message.reply(errorText("Não foi possível receber a mídia neste momento.")).catch(()=>{});}finally{inflight.delete(message.id);}
  }
  function enqueue(task,video=false){return new Promise((resolve,reject)=>{if(queue.length>=Math.max(1,Number(process.env.MEDIA_MODERATION_MAX_QUEUE)||50))return reject(new Error("Fila cheia"));queue.push({task,video,resolve,reject});drain();});}
  function drain(){while(active<maxConcurrent&&queue.length){const index=queue.findIndex(job=>!job.video||activeVideos<1);if(index<0)break;const [job]=queue.splice(index,1);active++;if(job.video)activeVideos++;Promise.resolve().then(job.task).then(job.resolve,job.reject).finally(()=>{active--;if(job.video)activeVideos--;drain();});}}
  function rowsSummary(guildId){return store.db.prepare("SELECT status,COUNT(*) count FROM media_moderation_cases WHERE guildId=? GROUP BY status").all(guildId).reduce((a,r)=>(a[r.status]=r.count,a),{});}
  function settingsCard(guildId){
    const s=store.settings(guildId);
    const menu=new ChannelSelectMenuBuilder().setCustomId("mds-media-log-channel").setPlaceholder("Escolher canal de logs de mídia")
      .setChannelTypes(ChannelType.GuildText,ChannelType.GuildAnnouncement).setMinValues(0).setMaxValues(1);
    if(s.logChannelId)menu.setDefaultChannels(s.logChannelId);
    const roles=new RoleSelectMenuBuilder().setCustomId("mds-media-review-role").setPlaceholder("Escolher cargo de revisão humana").setMinValues(0).setMaxValues(1);
    if(s.reviewRoleIds?.length)roles.setDefaultRoles(s.reviewRoleIds[0]);
    return new ContainerBuilder().setAccentColor(0)
      .addTextDisplayComponents(text("# Configurações de Mídia"),text(`**Arquivo:** ${s.maxFileMB} MB\n**Vídeo:** ${s.maxVideoSeconds} s\n**Cota local:** ${Math.max(1,Number(process.env.MEDIA_MODERATION_DAILY_REQUESTS)||Math.floor(s.dailyBudgetUSD*100))} tentativas de API/dia (inclui quadros/retries; não é cobrança)\n**Retenção:** ${s.retentionHours} h\n**Fila:** ${queue.length} · **Ativos:** ${active} · **Vídeos ativos:** ${activeVideos}`))
      .addTextDisplayComponents(text(`**Áudio dos vídeos:** ${process.env.MEDIA_MODERATION_AUDIO_ENABLED==="true"?"Transcrição ativada (pode gerar cobrança)":"Desativado — moderação somente visual"}\n**Exigir áudio:** ${process.env.MEDIA_MODERATION_REQUIRE_AUDIO==="true"?"Sim; áudio presente e não analisado exige revisão":"Não; áudio desativado não força revisão"}\nVídeos usam quadros distribuídos pela duração, mudanças de cena e amostra final. A amostragem não examina cada instante.`))
      .addSeparatorComponents(separator())
      .addTextDisplayComponents(text(`### Canal de Logs\n**Atual:** ${s.logChannelId?`<#${s.logChannelId}>`:"Não configurado"}\nRecebe aprovações, bloqueios, revisões e erros técnicos. Prefira um canal restrito à equipe. Não enviamos cópias dos arquivos ou legendas nos logs.`))
      .addActionRowComponents(new ActionRowBuilder().addComponents(menu))
      .addSeparatorComponents(separator())
      .addTextDisplayComponents(text(`### Revisão humana\n**Cargo:** ${s.reviewRoleIds?.length?s.reviewRoleIds.map(id=>`<@&${id}>`).join(", "):"Não configurado"}\nUse \`!midiarevisao\` para abrir a fila privada. O cargo pode visualizar, aprovar e reprovar mídias, mas não alterar configurações. Limpe a seleção para remover o acesso; administradores continuam autorizados.`))
      .addActionRowComponents(new ActionRowBuilder().addComponents(roles))
      .addSeparatorComponents(separator())
      .addTextDisplayComponents(text(`### Revisão em outro servidor\n**Canal:** ${s.externalReview?`<#${s.externalReview.channelId}> (servidor ${s.externalReview.guildId})`:"Não configurado"}\n**Cargo no destino:** ${s.externalReview?.roleId?`<@&${s.externalReview.roleId}>`:"Somente administradores do destino"}\nCasos em revisão enviam a mídia original, com prévia e botões, ao canal escolhido. Quem puder ver esse canal poderá ver/baixar o arquivo: restrinja todos os cargos à equipe. Aprovar republica na origem. As cópias do bot são removidas após a decisão ou retenção. Exige Gerenciar Servidor nos dois servidores para configurar.`))
      .addActionRowComponents(new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("mds-media-external-config").setLabel("Canal em outro servidor").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId("mds-media-external-disable").setLabel("Desativar revisão externa").setEmoji(painelEmojis.object("desativar")).setStyle(ButtonStyle.Danger).setDisabled(!s.externalReview)))
      .addActionRowComponents(new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("mds-media-log-disable").setLabel("Desativar logs").setEmoji(painelEmojis.object("desativar")).setStyle(ButtonStyle.Danger).setDisabled(!s.logChannelId),
        new ButtonBuilder().setCustomId("mds-media-admin:home").setLabel("Voltar").setStyle(ButtonStyle.Secondary)));
  }
  function dashboard(guildId){const settings=store.settings(guildId),counts=rowsSummary(guildId),automaticChannels=[...(client.guilds?.cache?.get(guildId)?.channels?.cache?.values()||[])].filter(channel=>isAutomaticChat(channel)&&isMonitored({guildId,channelId:channel.id,channel})),channelCount=new Set([...store.channels(guildId).filter(x=>x.kind!=="exclude").map(x=>`${x.kind}:${x.channelId}`),...settings.superficialChannelIds.map(id=>`channel:${id}`),...automaticChannels.map(channel=>`channel:${channel.id}`)]).size;return new ContainerBuilder().setAccentColor(0)
    .addTextDisplayComponents(text(`# Moderação de Mídias | ${serverName(client.guilds?.cache?.get(guildId))}\n-# Gerenciamento da análise automática de imagens e vídeos.`),text(`**Sistema:** ${settings.enabled?"Ativado":"Desativado"}\n**IA:** ${processor.configured?"OpenAI Moderation":"OpenAI Moderation (OPENAI_API_KEY ausente)"}\n**Modelo:** ${processor.model}\n**Mídias analisadas:** ${Object.values(counts).reduce((a,b)=>a+b,0)}\n**Aprovadas:** ${counts.approved||0}\n**Bloqueadas:** ${counts.blocked||0}\n**Em revisão:** ${(counts.review||0)+(counts.processing||0)}\n**Canais monitorados:** ${channelCount}`))
    .addSeparatorComponents(separator())
    .addActionRowComponents(new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("mds-media-admin:channels").setLabel("Configurar Canais").setStyle(ButtonStyle.Primary),new ButtonBuilder().setCustomId("mds-media-admin:rules").setLabel("Regras da IA").setStyle(ButtonStyle.Secondary)))
    .addActionRowComponents(new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("mds-media-admin:history").setLabel("Histórico").setStyle(ButtonStyle.Secondary),new ButtonBuilder().setCustomId("mds-media-admin:queue").setLabel("Fila de Revisão").setStyle(ButtonStyle.Secondary)))
    .addActionRowComponents(new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("mds-media-admin:settings").setLabel("Configurações").setStyle(ButtonStyle.Secondary),new ButtonBuilder().setCustomId("mds-media-admin:toggle").setLabel(settings.enabled?"Desativar":"Ativar").setEmoji(painelEmojis.toggleEmoji(settings.enabled)).setStyle(settings.enabled?ButtonStyle.Danger:ButtonStyle.Success)))
    .addTextDisplayComponents(text(`**Monitoramento automático:** canais com nome exatamente \`chat\`, enquanto o sistema estiver ativado. Exclusões prevalecem.\n**Canais de análise superficial:** ${settings.superficialChannelIds.length}\nO modo superficial é configurado por canal, sem alterar os demais canais.`))
    .addActionRowComponents(new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("mds-media-admin:superficial").setLabel("Canais de análise superficial").setStyle(ButtonStyle.Primary)));}
  function superficialCard(guildId){
    const ids=store.settings(guildId).superficialChannelIds;
    const c=new ContainerBuilder().setAccentColor(0)
      .addTextDisplayComponents(text("# Canais de análise superficial"),
        text("Cadastre o ID de cada canal que deve manter as mídias originais, sem reenvio. Violações detectadas são excluídas e geram castigo de 1 hora. Outros canais continuam com análise completa.\nImagens reduzidas e até 3 quadros por vídeo/GIF, sem áudio: pode deixar passar detalhes. Falhas e resultados inconclusivos não punem. As exclusões de canais prevalecem."),
        text(`**Canais cadastrados:**\n${ids.map(id=>`<#${id}> · \`${id}\``).join("\n")||"Nenhum canal cadastrado."}`))
      .addActionRowComponents(new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("mds-media-superficial-add").setLabel("Adicionar canal por ID").setStyle(ButtonStyle.Primary)));
    if(ids.length)c.addActionRowComponents(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder()
      .setCustomId("mds-media-superficial-remove").setPlaceholder("Remover canal da análise superficial")
      .setMinValues(1).setMaxValues(Math.min(25,ids.length))
      .addOptions(ids.slice(0,25).map(id=>({label:`Canal ${id}`,value:id})))));
    return c.addActionRowComponents(new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("mds-media-admin:home").setLabel("Voltar").setStyle(ButtonStyle.Secondary)));
  }
  function channelsCard(guildId){const selected=store.channels(guildId);const remover=new ActionRowBuilder();if(selected.length)remover.addComponents(new StringSelectMenuBuilder().setCustomId("mds-media-remove-channel").setPlaceholder("Remover configuração de canal/categoria").setMinValues(1).setMaxValues(Math.min(25,selected.length)).addOptions(selected.slice(0,25).map(x=>({label:`${x.kind}: ${x.channelId}`.slice(0,100),value:`${x.kind}:${x.channelId}`}))));return new ContainerBuilder().setAccentColor(0).addTextDisplayComponents(text("# Canais monitorados"),text(`${SAFE_NOTICE}\nCanais com nome exatamente \`chat\` são incluídos automaticamente enquanto o sistema estiver ativado, inclusive canais novos ou renomeados. Outros nomes, como \`chat-geral\`, não entram nessa regra. Selecione canais/categorias adicionais a incluir. As exclusões sempre prevalecem.`))
    .addActionRowComponents(new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder().setCustomId("mds-media-select:channel").setPlaceholder("Adicionar canais específicos").setChannelTypes(ChannelType.GuildText,ChannelType.GuildAnnouncement,ChannelType.GuildForum,ChannelType.GuildMedia).setMinValues(1).setMaxValues(25)))
    .addActionRowComponents(new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder().setCustomId("mds-media-select:category").setPlaceholder("Adicionar categorias (opt-in explícito)").setChannelTypes(ChannelType.GuildCategory).setMinValues(1).setMaxValues(25)))
    .addActionRowComponents(new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder().setCustomId("mds-media-select:exclude").setPlaceholder("Excluir canais").setChannelTypes(ChannelType.GuildText,ChannelType.GuildAnnouncement,ChannelType.GuildForum,ChannelType.GuildMedia).setMinValues(1).setMaxValues(25)))
    .addTextDisplayComponents(text(`**Configurados:** ${selected.map(x=>`${x.kind}: <#${x.channelId}>`).join(" · ")||"nenhum"}`))
    .addActionRowComponents(...(selected.length?[remover]:[]))
    .addActionRowComponents(new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("mds-media-admin:home").setLabel("Voltar").setStyle(ButtonStyle.Secondary)));}
  function rulesCard(guildId){const s=store.settings(guildId),opts=Object.entries(RULE_LABELS).map(([value,label])=>({label, value,description:painelEmojis.enabled(Boolean(s.rules[value])),default:Boolean(s.rules[value])}));return new ContainerBuilder().setAccentColor(0).addTextDisplayComponents(text("# Regras da IA"),text(`**Proteção reforçada:** ${s.rules.protectServer?"Ativada":"Desativada"}\nAplica as categorias oficiais à modalidade suportada. A IA decide automaticamente: categoria protegida sinalizada bloqueia; análise concluída sem violação aprova. Revisão é o último recurso para falhas persistentes, análise incompleta ou resposta inconclusiva, não o destino padrão.\n\nAs opções individuais valem quando a proteção reforçada está desativada. Golpes/dados pessoais não têm detector automático; ódio/assédio/ilícitos só são analisados em texto. Essas limitações não enviam toda imagem para revisão, mas também não significam que esses riscos foram descartados. Não há garantia contra punições do Discord. Falhas técnicas nunca viram aprovação automática.\nVersão: ${RULE_VERSION}.`))
    .addTextDisplayComponents(text("**Proteções específicas:** a API não determina idade nem identifica visualmente símbolos nazistas/extremistas. As regras de nazismo/extremismo usam sinais oficiais de ódio/ilícitos em texto, sem detector específico. Menções ou nomes de arquivo isolados não causam revisão automática. Imagens comuns de crianças não são violações por si só. Suspeitas de abuso infantil permanecem no procedimento especializado, sem republicação pela fila comum."))
    .addActionRowComponents(new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("mds-media-protection-toggle").setLabel(s.rules.protectServer?"Desativar proteção reforçada":"Ativar proteção reforçada").setEmoji(painelEmojis.toggleEmoji(s.rules.protectServer)).setStyle(s.rules.protectServer?ButtonStyle.Danger:ButtonStyle.Success)))
    .addActionRowComponents(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId("mds-media-rules").setPlaceholder("Escolha categorias para ativar").setMinValues(0).setMaxValues(opts.length).addOptions(opts)))
    .addActionRowComponents(new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("mds-media-admin:home").setLabel("Voltar").setStyle(ButtonStyle.Secondary)));}
  function caseCard(row){return new ContainerBuilder().setAccentColor(0).addTextDisplayComponents(text(`# Revisão de Mídia\n\n**Usuário:** <@${row.authorId}>\n**Canal:** <#${row.channelId}>\n**Tipo:** ${row.mediaType}\n**Enviada:** <t:${Math.floor(row.createdAt/1000)}:F>\n**Motivo:** ${row.reason||"Análise inconclusiva"}\n**Status:** Aguardando revisão`))
    .addActionRowComponents(new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`mds-media-review:approve:${row.id}`).setLabel("Aprovar").setStyle(ButtonStyle.Success).setDisabled(!row.filePath||row.errorKind==="child_safety"||JSON.parse(row.categories||"[]").includes("sexual/minors")),new ButtonBuilder().setCustomId(`mds-media-review:reject:${row.id}`).setLabel("Reprovar").setStyle(ButtonStyle.Danger),new ButtonBuilder().setCustomId(`mds-media-review:details:${row.id}`).setLabel("Detalhes").setStyle(ButtonStyle.Secondary)));}
  async function showQueue(i,privateReply=false){
    const rows=store.db.prepare("SELECT * FROM media_moderation_cases WHERE guildId=? AND status='review' ORDER BY createdAt LIMIT 8").all(i.guildId);
    const c=new ContainerBuilder().setAccentColor(0).addTextDisplayComponents(text(`# Fila de Revisão\n${rows.length?"Casos pendentes; arquivos visíveis somente à equipe autorizada. Mostrando até 8; atualize após finalizar.":"Nenhum caso aguardando revisão."}`));
    for(const row of rows)c.addSectionComponents(new SectionBuilder().addTextDisplayComponents(text(`<@${row.authorId}> · <#${row.channelId}> · ${row.mediaType}\n<t:${Math.floor(row.createdAt/1000)}:R> — ${(row.reason||"Análise inconclusiva").slice(0,180)}`)).setButtonAccessory(new ButtonBuilder().setCustomId(`mds-media-open:${row.id}`).setLabel("Abrir").setStyle(ButtonStyle.Secondary)));
    const buttons=[new ButtonBuilder().setCustomId("mds-media-queue-refresh").setLabel("Atualizar fila").setStyle(ButtonStyle.Secondary)];
    if(admin(i.member))buttons.push(new ButtonBuilder().setCustomId("mds-media-admin:home").setLabel("Voltar").setStyle(ButtonStyle.Secondary));
    c.addActionRowComponents(new ActionRowBuilder().addComponents(...buttons));
    return privateReply?i.reply(payload(c,true)):i.update(payload(c,true));
  }
  async function retainedFile(row){
    if(!row.filePath)return null;
    try{return await fs.readFile(row.filePath);}catch(error){
      if(error.code!=="ENOENT")throw new Error("Não foi possível ler o arquivo retido. Verifique o armazenamento e tente novamente.");
      store.db.prepare("UPDATE media_moderation_cases SET filePath=NULL WHERE id=? AND filePath=?").run(row.id,row.filePath);
      row.filePath=null;return null;
    }
  }
  function reviewCase(i,id,pendingOnly=true){
    const row=store.db.prepare("SELECT * FROM media_moderation_cases WHERE id=?").get(id);
    if(!row||pendingOnly&&row.status!=="review")throw new Error("Caso já finalizado ou inexistente.");
    if(!(row.guildId===i.guildId?authorized(i.member,row.guildId):crossReview.canReview(i,row)))throw new Error("Você não tem acesso a este caso de revisão.");
    return row;
  }
  async function revealCase(i,id){
    const row=reviewCase(i,id);
    if(typeof i.deferReply==="function")await i.deferReply({flags:MessageFlags.Ephemeral});
    const buffer=await retainedFile(row),c=caseCard(row);
    if(buffer){
      const name=MIME_EXT[row.mimeType]?`${row.id}.${MIME_EXT[row.mimeType]}`:`${row.id}.bin`;
      if(row.mimeType?.startsWith("image/"))c.addMediaGalleryComponents({items:[{media:{url:`attachment://${name}`}}]});
      else c.addTextDisplayComponents(text("Arquivo disponível como anexo privado à equipe; tipo inválido exige cuidado."));
    }else if(row.inspectionMode==="superficial")c.addTextDisplayComponents(text(`**Análise superficial:** não há cópia retida nem republicação. Consulte a mensagem original, se ainda existir e você tiver acesso ao canal:\nhttps://discord.com/channels/${row.guildId}/${row.channelId}/${row.originalMessageId}`));
    else c.addTextDisplayComponents(text("**Arquivo indisponível ou expirado.** Não é possível aprovar/republicar. Solicite um novo envio para análise; o histórico foi preservado."));
    const p=payload(c,true);
    if(buffer)p.files=[{attachment:buffer,name:MIME_EXT[row.mimeType]?`${row.id}.${MIME_EXT[row.mimeType]}`:`${row.id}.bin`}];
    return i.deferred?i.editReply(p):i.reply(p);
  }
  async function finalizeReview(i,id,decision){if(reviewLocks.has(id))throw new Error("Revisão já em andamento");reviewLocks.add(id);try{const row=reviewCase(i,id);let repostId=null;
    if(typeof i.deferUpdate==="function")await i.deferUpdate();
    if(decision==="approved"){
      if(row.errorKind==="child_safety"||JSON.parse(row.categories||"[]").includes("sexual/minors"))throw new Error("Ocorrência de segurança infantil exige procedimento especializado; republicação pela fila comum não permitida.");
      if(!row.filePath)throw new Error("Arquivo indisponível ou expirado; não é possível republicar. Solicite um novo envio para análise.");
      const bytes=await retainedFile(row);if(!bytes)throw new Error("Arquivo indisponível ou expirado; não é possível republicar. Solicite um novo envio para análise.");
      const channel=await client.channels.fetch(row.channelId).catch(()=>null);if(!channel?.isTextBased()||channel.guildId!==row.guildId)throw new Error("Canal de origem indisponível.");
      const sourceGuild=i.guildId===row.guildId?i.guild:await client.guilds.fetch(row.guildId).catch(()=>null);
      const member=await sourceGuild?.members.fetch(row.authorId).catch(()=>null);if(!member||member.user?.bot)throw new Error("Autor não está mais elegível no servidor de origem.");const filename=MIME_EXT[row.mimeType]?`${row.id}.${MIME_EXT[row.mimeType]}`:row.filename||"media";const sent=await publishApproved(channel,{authorId:row.authorId,buffer:bytes,filename,mime:row.mimeType,caption:row.caption,originalMessageId:row.originalMessageId,caseId:row.id});registry.preserveMessage(sent);repostId=sent.id;}
    store.db.prepare("UPDATE media_moderation_cases SET status=?,decision=?,reviewerId=?,reviewerGuildId=?,repostedMessageId=?,filePath=NULL WHERE id=?").run(decision==="blocked"?"blocked":"approved",decision,i.user.id,i.guildId,repostId,id);
    if(row.filePath)await fs.rm(row.filePath,{force:true}).catch(()=>{});
    // Updates retain the existing public/ephemeral visibility; never try to
    // change a channel review message to ephemeral after its button was clicked.
    const p={...payload(new ContainerBuilder().setAccentColor(decision==="approved"?0:0).addTextDisplayComponents(text(`# Caso ${decision==="approved"?"aprovado":"reprovado"}\nRevisão registrada por <@${i.user.id}>.`))),attachments:[]};
    await logger.logCase(id);return i.deferred?i.editReply(p):i.update(p);
    }finally{reviewLocks.delete(id);}}
  async function handleInteraction(i){if(!i.customId?.startsWith("mds-media-"))return;
       if(i.customId.startsWith("mds-media-appeal:")){const id=i.customId.split(":")[1],row=store.db.prepare("SELECT * FROM media_moderation_cases WHERE id=? AND authorId=?").get(id,i.user.id);if(!row)throw new Error("Ocorrência não localizada.");
         const isVideo=(row.mimeType||row.mediaType||"").startsWith("video/");
         if(isVideo&&row.status==="review"){
           if(!row.filePath)throw new Error("O arquivo expirou ou não está disponível para encaminhamento.");
           if(row.externalReviewRequested)throw new Error("A revisão externa já foi solicitada.");
           store.db.prepare("UPDATE media_moderation_cases SET externalReviewRequested=1 WHERE id=? AND authorId=? AND status='review'").run(id,i.user.id);
           const response=await i.reply(payload(new ContainerBuilder().setAccentColor(0).addTextDisplayComponents(text("# Revisão solicitada\nO vídeo foi encaminhado para a fila de revisão humana.")),true));await logger.logCase(id);return response;
         }
         if(row.status!=="blocked")throw new Error("Esta ocorrência não pode ser contestada.");
         store.db.prepare("UPDATE media_moderation_cases SET status='review',decision='review',reason='Contestação do usuário' WHERE id=?").run(id);const response=await i.reply(payload(new ContainerBuilder().setAccentColor(0).addTextDisplayComponents(text("# Revisão solicitada\nA equipe autorizada analisará a ocorrência.")),true));await logger.logCase(id);return response;}
       if(!i.inGuild?.())return;
       if(i.customId==="mds-media-delete-approved"){
         const message=i.message;
         if(!message||message.author?.id!==client.user?.id)throw new Error("Esta mensagem não é uma publicação aprovada do bot.");
         const row=store.db.prepare("SELECT * FROM media_moderation_cases WHERE repostedMessageId=? AND guildId=? AND channelId=? AND status='approved' AND deletedAt IS NULL").get(message.id,i.guildId,i.channelId);
         if(!row)throw new Error("Publicação não localizada ou já removida.");
         if(i.user.id!==row.authorId&&!i.member?.permissions?.has(PermissionFlagsBits.ManageMessages))throw new Error("Somente quem enviou a mídia ou a equipe com Gerenciar Mensagens pode removê-la.");
         if(publicationDeletes.has(row.id))throw new Error("A remoção desta mídia já está em andamento.");
         publicationDeletes.add(row.id);
         try{
           await i.deferReply({flags:MessageFlags.Ephemeral});
           try{await message.delete();}catch(error){if(error.code!==10008)throw new Error("Não foi possível remover a mídia. Verifique as permissões do bot e tente novamente.");}
           store.db.prepare("UPDATE media_moderation_cases SET deletedAt=?,deletedById=? WHERE id=?").run(Date.now(),i.user.id,row.id);
           return await i.editReply(payload(new ContainerBuilder().setAccentColor(0).addTextDisplayComponents(text("Mídia removida. O histórico da análise foi preservado.")),true));
         }finally{publicationDeletes.delete(row.id);}
       }
       if(i.customId==="mds-media-external-config"){
         if(!admin(i.member))throw new Error("Ação administrativa não autorizada.");
         const config=store.settings(i.guildId).externalReview;
         const channelInput=new TextInputBuilder().setCustomId("channel").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(20).setPlaceholder("ID do canal privado no outro servidor");
         const roleInput=new TextInputBuilder().setCustomId("role").setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(20).setPlaceholder("Vazio: somente administradores do destino");
         if(config?.channelId)channelInput.setValue(config.channelId);if(config?.roleId)roleInput.setValue(config.roleId);
         return i.showModal(new ModalBuilder().setCustomId("mds-media-external-save").setTitle("Revisão em outro servidor")
           .addLabelComponents(new LabelBuilder().setLabel("ID do canal de revisão").setTextInputComponent(channelInput),new LabelBuilder().setLabel("ID do cargo no servidor de destino (opcional)").setTextInputComponent(roleInput)));
       }
       if(i.customId==="mds-media-external-save"){
         if(!admin(i.member))throw new Error("Ação administrativa não autorizada.");
         if(!i.isModalSubmit?.())return;
         await i.deferReply({flags:MessageFlags.Ephemeral});
         await crossReview.configure({sourceGuild:i.guild,actorId:i.user.id,channelId:i.fields.getTextInputValue("channel").trim(),roleId:i.fields.getTextInputValue("role").trim()||null});
         await i.editReply(payload(settingsCard(i.guildId),true));await crossReview.flush(i.guildId);return;
       }
       if(i.customId==="mds-media-external-disable"){
         if(!admin(i.member))throw new Error("Ação administrativa não autorizada.");
         const s=store.settings(i.guildId);s.externalReview=null;store.saveSettings(i.guildId,s);
         await i.update(payload(settingsCard(i.guildId),true));await crossReview.cleanup(i.guildId);return;
       }
      if(["mds-media-queue","mds-media-queue-refresh","mds-media-admin:queue"].includes(i.customId)){
        if(!authorized(i.member,i.guildId))throw new Error("Você não tem acesso à fila de revisão.");
        return showQueue(i,i.customId!=="mds-media-queue-refresh");
      }
      if(i.customId==="mds-media-review-role"){
        if(!admin(i.member))throw new Error("Ação administrativa não autorizada.");
        if(!i.isRoleSelectMenu?.())return;
        await i.deferUpdate();
        const id=i.values[0]||null;
        if(id){const role=await i.guild.roles.fetch(id);if(!role||role.id===i.guildId||role.managed||role.guild?.id!==i.guildId)throw new Error("Escolha um cargo comum deste servidor, diferente de @everyone.");}
        const s=store.settings(i.guildId);s.reviewRoleIds=id?[id]:[];store.saveSettings(i.guildId,s);
        return i.editReply(payload(settingsCard(i.guildId)));
      }
       if(i.customId==="mds-media-protection-toggle"){
        if(!admin(i.member))throw new Error("Ação administrativa não autorizada.");
        const s=store.settings(i.guildId);s.rules.protectServer=!s.rules.protectServer;store.saveSettings(i.guildId,s);
        return i.update(payload(rulesCard(i.guildId),true));
       }
       if(i.customId==="mds-media-superficial-add"){
         if(!admin(i.member))throw new Error("Ação administrativa não autorizada.");
         return i.showModal(new ModalBuilder().setCustomId("mds-media-superficial-save").setTitle("Canal de análise superficial")
           .addLabelComponents(new LabelBuilder().setLabel("ID do canal deste servidor").setTextInputComponent(
             new TextInputBuilder().setCustomId("channel").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(20).setPlaceholder("Cole o ID do canal"))));
       }
       if(i.customId==="mds-media-superficial-save"){
         if(!admin(i.member))throw new Error("Ação administrativa não autorizada.");
         if(!i.isModalSubmit?.())return;
         const id=i.fields.getTextInputValue("channel").trim();
         if(!/^\d{17,20}$/.test(id))throw new Error("ID de canal inválido.");
         await i.deferReply({flags:MessageFlags.Ephemeral});
         const channel=await i.guild.channels.fetch(id).catch(()=>null);
         if(!channel||(channel.guildId||channel.guild?.id)!==i.guildId||![ChannelType.GuildText,ChannelType.GuildAnnouncement].includes(channel.type))
           throw new Error("Escolha um canal de texto deste servidor.");
         const me=await i.guild.members.fetchMe();
         if(!me.permissions.has(PermissionFlagsBits.ModerateMembers)||
            !channel.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel,PermissionFlagsBits.ManageMessages]))
           throw new Error("O bot precisa de Moderar Membros e de Ver Canal/Gerenciar Mensagens nesse canal.");
         const s=store.settings(i.guildId);
         s.superficialChannelIds=[...new Set([...s.superficialChannelIds,id])];
         if(s.superficialChannelIds.length>50)throw new Error("Limite de 50 canais superficiais por servidor.");
         delete s.superficial;store.saveSettings(i.guildId,s);
         await i.editReply(payload(superficialCard(i.guildId),true));
         if(s.enabled)await announce(channel);
         return;
       }
       if(i.customId==="mds-media-superficial-remove"){
         if(!admin(i.member))throw new Error("Ação administrativa não autorizada.");
         const s=store.settings(i.guildId),remove=new Set(i.values||[]);
         s.superficialChannelIds=s.superficialChannelIds.filter(id=>!remove.has(id));
         store.saveSettings(i.guildId,s);
         return i.update(payload(superficialCard(i.guildId),true));
       }
      if(i.customId.startsWith("mds-media-admin:")){if(!admin(i.member))throw new Error("Somente administradores com Gerenciar Servidor podem acessar o painel.");const action=i.customId.split(":")[1],s=store.settings(i.guildId);
        if(action==="home")return i.update(payload(dashboard(i.guildId),true));if(action==="toggle"){s.enabled=!s.enabled;store.saveSettings(i.guildId,s);await i.update(payload(dashboard(i.guildId),true));await announceConfigured(i.guild);return;}
        if(action==="channels")return i.update(payload(channelsCard(i.guildId),true));if(action==="rules")return i.update(payload(rulesCard(i.guildId),true));
        if(action==="queue")return showQueue(i);if(action==="history"){const rows=store.db.prepare("SELECT * FROM media_moderation_cases WHERE guildId=? ORDER BY createdAt DESC LIMIT 10").all(i.guildId);const c=new ContainerBuilder().setAccentColor(0).addTextDisplayComponents(text(`# Histórico recente\n${rows.map(r=>`<t:${Math.floor(r.createdAt/1000)}:R> <@${r.authorId}> · ${r.decision||r.status} · ${r.reason||"—"}\n-# ${r.provider||"Registro legado"} · ${r.model||"sem análise"} · ${r.analysisMs??"—"} ms · ${JSON.parse(r.categories||"[]").join(", ")||"nenhuma categoria sinalizada"}`).join("\n")||"Sem ocorrências."}`));return i.update(payload(c,true));}
         if(action==="settings")return i.update(payload(settingsCard(i.guildId),true));
         if(action==="superficial")return i.update(payload(superficialCard(i.guildId),true));
      }
      if(i.customId==="mds-media-log-channel"){
        if(!admin(i.member))throw new Error("Ação administrativa não autorizada.");
        if(!i.isChannelSelectMenu?.())return;
        await i.deferUpdate();
        const id=i.values[0]||null;
        if(id){
          const channel=await client.channels.fetch(id).catch(()=>null);
          if(!channel||channel.guildId!==i.guildId||![ChannelType.GuildText,ChannelType.GuildAnnouncement].includes(channel.type))throw new Error("Selecione um canal de texto deste servidor.");
          const bot=i.guild.members.me||await i.guild.members.fetchMe();
          const permissions=channel.permissionsFor(bot);
          if(!permissions?.has([PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages]))throw new Error("O bot precisa de Ver Canal e Enviar Mensagens no canal de logs.");
        }
        const s=store.settings(i.guildId);s.logChannelId=id;store.saveSettings(i.guildId,s);
        return i.editReply(payload(settingsCard(i.guildId)));
      }
      if(i.customId==="mds-media-log-disable"){
        if(!admin(i.member))throw new Error("Ação administrativa não autorizada.");
        const s=store.settings(i.guildId);s.logChannelId=null;store.saveSettings(i.guildId,s);return i.update(payload(settingsCard(i.guildId),true));
      }
      if(i.customId.startsWith("mds-media-select:")){if(!admin(i.member))throw new Error("Ação administrativa não autorizada.");const kind=i.customId.split(":")[1];for(const id of i.values)store.setChannel(i.guildId,id,kind,true);await i.update(payload(channelsCard(i.guildId),true));await announceConfigured(i.guild);return;}
      if(i.customId==="mds-media-remove-channel"){if(!admin(i.member))throw new Error("Ação administrativa não autorizada.");for(const item of i.values){const [kind,id]=item.split(":");if(["channel","category","exclude"].includes(kind))store.setChannel(i.guildId,id,kind,false);}return i.update(payload(channelsCard(i.guildId),true));}
      if(i.customId==="mds-media-rules"){if(!admin(i.member))throw new Error("Ação administrativa não autorizada.");const s=store.settings(i.guildId),chosen=new Set(i.values);for(const key of Object.keys(RULE_LABELS))s.rules[key]=chosen.has(key);store.saveSettings(i.guildId,s);return i.update(payload(rulesCard(i.guildId),true));}
       if(i.customId.startsWith("mds-media-open:"))return revealCase(i,i.customId.split(":")[1]);
       if(i.customId.startsWith("mds-media-review:")){const [,action,id]=i.customId.split(":");if(action==="details"){const row=reviewCase(i,id,false);return i.reply(payload(new ContainerBuilder().setAccentColor(0).addTextDisplayComponents(text(`# Detalhes da análise\n**Provedor:** ${row.provider||"Registro legado"}\n**Modelo:** ${row.model||"indisponível"}\n**Tempo:** ${row.analysisMs??"—"} ms\n**Erro técnico:** ${row.errorKind||"nenhum"}\n**Categorias:** ${JSON.parse(row.categories||"[]").join(", ")||"nenhuma"}\n**Hash SHA-256:** ${row.sha256||"indisponível"}\n**Versão:** ${row.rulesVersion}`)),true));}if(!["approve","reject"].includes(action))throw new Error("Ação de revisão inválida.");return finalizeReview(i,id,action==="approve"?"approved":"blocked");}
  }
  async function onInteraction(i){
    try{return await handleInteraction(i);}catch(error){
      // Await the whole dispatch, including returned promises from helpers and
      // Discord replies. Expected operational failures must not reach anticrash.
      try{
        const p=payload(componentsError("Ação não concluída",safeMessage(error)),true);
        await (i.deferred||i.replied?i.followUp(p):i.reply(p));
      }catch{console.warn("[Moderação de mídia] Não foi possível informar a falha da interação; o bot continua ativo.");}
    }
  }
  // The private intake accepts uploads in DMs and performs the same validation before publication.
  client.on("messageCreate",message=>{Promise.resolve(message.guild?onMessage(message):onPrivateMessage(message)).catch(()=>console.warn("[Moderação de mídia] Falha na recepção; verifique os casos pendentes."));});client.on("interactionCreate",onInteraction);
  const command={name:"midiaadmin",description:"Gerencia a moderação automática de mídias.",category:"Moderação",permissions:["ManageGuild"],result:"Abre o painel administrativo da moderação de mídias.",examples:["!midiaadmin","!Midiaadmin"],prefix:{trigger:"!midiaadmin",exact:true,caseInsensitive:true,usage:["!midiaadmin"],execute:async message=>{
    try{return await message.channel.send(payload(dashboard(message.guild.id)));}
    catch{console.warn("[Moderação de mídia] Falha ao abrir painel; verifique Enviar Mensagens e acesso ao canal.");await message.reply(payload(componentsError("Painel indisponível","Não foi possível abrir o painel de mídia. Verifique as permissões do bot e os logs do processo."))).catch(()=>{});}
  }} };
  registry.register(command);
  function reviewEntry(guild){
    return require("../configuration/runtime").decorate(new ContainerBuilder().setAccentColor(0)
      .addTextDisplayComponents(text("# Revisão humana de mídias\nA fila e os arquivos serão exibidos em resposta privada somente à equipe autorizada."))
      .addActionRowComponents(new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("mds-media-queue").setLabel("Abrir fila privada").setStyle(ButtonStyle.Primary))),guild,"media-review-entry");
  }
  registry.register({name:"midiarevisao",description:"Abre o acesso à fila privada de revisão humana de mídias.",category:"Moderação",
    authorize:member=>authorized(member,member?.guild?.id),permissionLabel:"Gerenciar Servidor ou cargo de revisão humana configurado",
    result:"Permite à equipe autorizada visualizar, aprovar e reprovar mídias retidas, sem alterar as configurações administrativas.",examples:["!midiarevisao"],
    prefix:{trigger:"!midiarevisao",exact:true,caseInsensitive:true,execute:message=>message.reply(payload(reviewEntry(message.guild)))}
  });
  async function cleanup(){const rows=store.db.prepare("SELECT id,guildId,createdAt,filePath FROM media_moderation_cases WHERE filePath IS NOT NULL AND status!='processing'").all();for(const row of rows)if(row.createdAt<Date.now()-Math.max(1,Math.min(72,store.settings(row.guildId).retentionHours))*3600000){await fs.rm(row.filePath,{force:true}).catch(()=>{});store.db.prepare("UPDATE media_moderation_cases SET filePath=NULL WHERE id=?").run(row.id);}for(const [key,times] of userWindow)if(!times.some(t=>Date.now()-t<60000))userWindow.delete(key);await crossReview.cleanup();}
  const timer=setInterval(()=>cleanup().catch(error=>console.warn("[Moderação de mídia] Limpeza:",error.message)),3600000);timer.unref();
  client.once("clientReady",async()=>{
    await cleanup();
    for(const guild of client.guilds?.cache?.values?.()||[]){
      await announceConfigured(guild);
      try{
        const active=await guild.channels?.fetchActiveThreads?.();
        for(const thread of active?.threads?.values?.()||[])await watchThread(thread);
      }catch{console.warn("[Moderação de mídia] Não foi possível consultar tópicos ativos; o acesso depende das permissões do bot.");}
    }
    await crossReview.flush();
  });
  const channelRemap=require("./channel-remap")({store,isMonitored,isSuperficial,instagram,announce});
  return {store,instagram,onMessage,onPrivateMessage,onInteraction,cleanup,notice:SAFE_NOTICE,isMonitored,isSuperficial,watchThread,reviewEntry,...channelRemap};
};
