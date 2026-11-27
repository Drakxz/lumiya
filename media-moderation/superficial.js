const { PermissionFlagsBits } = require("discord.js");
const { fileTypeFromBuffer } = require("file-type");
const { downloadAttachment, MIME_EXT, validateDecision } = require("./processor");
const { childSafetySignal } = require("./safety");
const HOUR = 60 * 60 * 1000;

function createSuperficial({store,processor,enqueue,dailyBudget,recordBudget,logCase,isMonitored,isSuperficial}) {
  const enabled = message => {
    const s=store.settings(message.guildId);
    return s.enabled&&isSuperficial(message)&&isMonitored(message);
  };
  const update=store.db.prepare("UPDATE media_moderation_cases SET status=?,decision=?,reason=?,categories=?,provider='OpenAI',model=?,analysisMs=?,analysisData=?,errorKind=? WHERE id=?");
  async function inspect(message,cases,limited) {
    let violation=false,childHold=false;
    const ids=cases.map(item=>item.id);
    store.db.prepare("UPDATE media_moderation_cases SET inspectionMode='superficial' WHERE id=?").run(ids[0]);
    for(const id of ids.slice(1))store.db.prepare("UPDATE media_moderation_cases SET inspectionMode='superficial' WHERE id=?").run(id);
    const mark=(item,decision,started,errorKind=null)=>update.run(
      decision.decision,decision.decision,decision.reason,JSON.stringify(decision.categories||[]),
      processor.model,Date.now()-started,JSON.stringify({mode:"superficial",coverage:decision.coverage||null,results:decision.rawResults||[]}),errorKind,item.id);
    try {
      if(limited)throw new Error("Limite local de processamento");
      await enqueue(async()=>{
        for(const item of cases){
          const started=Date.now();
          try{
            if(!enabled(message))throw new Error("Modo desativado durante a análise");
            const settings=store.settings(message.guildId);
            const text=String(message.content||"");
            if(childSafetySignal(text+" "+cases.map(c=>c.attachment.name||"").join(" "))){
              childHold=true;
              throw Object.assign(new Error("Sinal de segurança infantil; procedimento especializado"),{kind:"child_safety"});
            }
            if(!dailyBudget(message.guildId,settings).ok)throw new Error("Cota diária atingida");
            const maxBytes=Math.min(100,settings.maxFileMB)*1024*1024;
            if(item.attachment.size>maxBytes)throw new Error("Arquivo acima do limite");
            const buffer=await downloadAttachment(item.attachment.url,maxBytes);
            const type=await fileTypeFromBuffer(buffer);
            if(!type||!MIME_EXT[type.mime])throw new Error("Formato real não permitido");
            const onRequest=()=>{
              const quota=dailyBudget(message.guildId,store.settings(message.guildId));
              if(!quota.ok)throw new Error("Cota diária atingida");
              recordBudget(message.guildId,quota.day);
            };
            const decision=validateDecision(await processor.moderate(buffer,type.mime,{...settings,superficial:true,onRequest},text.slice(0,20000)));
            if(decision.categories.includes("sexual/minors")){
              childHold=true;
              mark(item,{...decision,decision:"review",reason:"Sinal de segurança infantil; procedimento especializado"},started,"child_safety");
            }else if(decision.decision==="blocked"&&decision.categories.length&&!decision.requiresHumanReview){
              violation=true;
              mark(item,decision,started);
            }else{
              const safe={...decision};
              if(safe.decision==="blocked")safe.decision="review";
              safe.reason=safe.decision==="approved"
                ?"Análise superficial sem violação detectada; original mantido. Não garante ausência de riscos."
                :"Análise superficial inconclusiva; original mantido, sem castigo automático.";
              mark(item,safe,started);
            }
          }catch(error){
            if(error.kind==="child_safety")childHold=true;
            mark(item,{decision:"review",reason:error.kind==="child_safety"
              ?"Sinal de segurança infantil; procedimento especializado, sem API."
              :"Análise superficial não concluída; sem punição automática.",categories:[]},started,error.kind||"technical");
          }
        }
      },cases.some(c=>c.attachment.contentType?.startsWith("video/")||/\.(gif|mp4|mov|webm)$/i.test(c.attachment.name||"")));
      if((violation||childHold)&&enabled(message)){
        const action={deletion:"not_attempted",timeout:violation?"not_attempted":"not_applied_unconfirmed"};
        try{
          const me=await message.guild.members.fetchMe();
          const permissions=message.channel.permissionsFor(me);
          if(!permissions?.has(PermissionFlagsBits.ManageMessages))throw new Error("Sem Gerenciar Mensagens");
          try{await message.delete();action.deletion="deleted";}
          catch(error){if(error.code!==10008)throw error;action.deletion="already_deleted";}
          if(violation&&enabled(message)){
            if(!me.permissions.has(PermissionFlagsBits.ModerateMembers))action.timeout="missing_permission";
            else{
              const member=await message.guild.members.fetch({user:message.author.id,force:true});
              if(!member?.moderatable||member.id===message.guild.ownerId)action.timeout="not_moderatable";
              else if(member.communicationDisabledUntilTimestamp>=Date.now()+HOUR)action.timeout="longer_timeout_preserved";
              else{
                await member.timeout(HOUR,"MDS: violação detectada na análise superficial de mídia");
                action.timeout="applied_1h";
              }
            }
          }
        }catch{
          if(action.deletion==="not_attempted")action.deletion="failed";
          else action.timeout="failed";
          console.warn("[Moderação de mídia] Falha ao aplicar ação superficial; verifique permissões e hierarquia.");
        }
        for(const id of ids)store.db.prepare("UPDATE media_moderation_cases SET enforcementData=?,deletedAt=?,deletedById=? WHERE id=?")
          .run(JSON.stringify(action),["deleted","already_deleted"].includes(action.deletion)?Date.now():null,["deleted","already_deleted"].includes(action.deletion)?meId(message):null,id);
      }
    }catch{
      for(const id of ids)store.db.prepare("UPDATE media_moderation_cases SET status='review',decision='review',reason='Limite ou falha na análise superficial; original mantido, sem punição.',errorKind='technical' WHERE id=? AND status='processing'").run(id);
    }finally{
      for(const id of ids)await logCase(id);
    }
  }
  function meId(message){return message.guild.members.me?.id||null;}
  return {inspect};
}
module.exports={createSuperficial,HOUR};
