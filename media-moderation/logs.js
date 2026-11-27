const {escapeMarkdown}=require("discord.js");
const logs=require("../lumiya-ui/logs");
const STATES={approved:"APROVADA",blocked:"BLOQUEADA",review:"EM_REVISAO"};
const {DENIED_EMOJI}=require("../error-ui");
const {isInstagramGuild}=require("../server-logs/policy");
function buildMediaLog(row,{avatarURL=null,botAvatarURL=null,now=Date.now(),publication=null}={}){
  const technical=row.status==="review"&&row.errorKind!=="child_safety"&&(row.errorKind||!row.model&&/falha|incompleta|não foi possível|indisponível/i.test(row.reason||""));
  const state=technical?"ERRO_TECNICO":STATES[row.status]||"EM_REVISAO";
  const details=[];
  let statusText=row.status==="approved"?"Mídia aprovada e republicada pelo sistema.":row.status==="blocked"?"Mídia bloqueada; não será republicada.":"Mídia retida; aguarda análise da equipe autorizada.";
  if(row.inspectionMode==="superficial"){
    statusText="Análise superficial; sem republicação. Resultado limitado às amostras analisadas.";
    let actions={};try{actions=JSON.parse(row.enforcementData||"{}");}catch{}
    const deletion={deleted:"Mensagem excluída",already_deleted:"Mensagem já estava excluída",failed:"Falha ao excluir a mensagem",not_attempted:"Exclusão não realizada"};
    const timeout={applied_1h:"Castigo de 1 hora aplicado",longer_timeout_preserved:"Castigo maior já existente preservado",
      missing_permission:"Castigo não aplicado: falta Moderar Membros",not_moderatable:"Castigo não aplicado: membro protegido/hierarquia",
      failed:"Falha ao aplicar castigo",not_attempted:"Castigo não aplicado",not_applied_unconfirmed:"Sem castigo: sinal não confirmado"};
    statusText+=`\n${deletion[actions.deletion]||"Mensagem original mantida"}.\n${timeout[actions.timeout]||"Sem castigo automático"}.`;
  }
  const stateEmoji=technical||row.status==="blocked"?DENIED_EMOJI:row.status==="approved"?"<:Icon_Access_Approve:1569949091880902747>":"<:Icon_Circle_Required:1570299467490533448>";
  details.push(`${stateEmoji} **Estado da Mídia:** \`${state}\`\n${statusText}`);
  if(publication)details.push(`[Ver publicação](https://discord.com/channels/${publication.guildId}/${publication.channelId}/${publication.messageId})`);
  // Metadata only: do not copy captions, model prose, URLs or retained files into logs.
  if(row.reviewerId)details.push(`**Moderador:** <@${row.reviewerId}>${row.reviewerGuildId&&row.reviewerGuildId!==row.guildId?`\n**Servidor de revisão:** \`${row.reviewerGuildId}\``:""}`);
  if(row.provider)details.push(`**Provedor:** ${escapeMarkdown(row.provider)}\n**Modelo:** ${escapeMarkdown(row.model||"análise não concluída")}\n**Tempo de análise:** ${row.analysisMs??0} ms\n**Categorias:** ${escapeMarkdown(JSON.parse(row.categories||"[]").join(", ")||"nenhuma sinalizada")}`);
  if(row.analysisData)try{
    const coverage=JSON.parse(row.analysisData).coverage;
    if(coverage?.method==="uniform-scenes-end"){
      const audioLabels={disabled:"não analisado (desativado)",absent:"sem faixa de áudio","transcribed-and-moderated":"transcrito e moderado","transcribed-empty":"transcrito sem fala reconhecida"};
      const frames=Number.isInteger(coverage.frames)?coverage.frames:"—";
      details.push(`**Cobertura visual:** por amostragem · ${frames} quadros únicos analisados\n**Áudio:** ${audioLabels[coverage.audio]||"não informado"}`);
    }
  }catch{/* Metadados antigos não devem impedir o envio do log. */}
  return logs.card({
    category:publication?"community":"media",
    title:publication?"Instagram · publicação":technical?"Mídia · erro técnico":
      row.status==="approved"?"Mídia aprovada":row.status==="blocked"?"Mídia bloqueada":"Mídia em revisão",
    subtitle:"Proteção de Sensibilidade · registro da análise",
    summary:[["Executor",`<@${row.authorId}>\n-# ID: ${row.authorId}`],["Canal",`<#${row.channelId}>`],["Resultado",state]],
    details,
    metadata:[["Servidor",row.guildId],["Usuário",row.authorId],["Canal",row.channelId],
      ...(row.originalMessageId?[["Mensagem original",row.originalMessageId]]:[])],
    avatarURL,botAvatarURL,at:now,source:"Proteção de mídias",eventId:row.id
  });
}
function createMediaLogger({client,registry,store}){
  store.db.exec(`CREATE TABLE IF NOT EXISTS media_moderation_log_events(caseId TEXT NOT NULL,channelId TEXT NOT NULL,eventKey TEXT NOT NULL,messageId TEXT NOT NULL,createdAt INTEGER NOT NULL,PRIMARY KEY(caseId,channelId,eventKey))`);
  const pending=new Set();
  async function logCase(id){
    let key,claimed=false;
    try{
      const row=store.db.prepare("SELECT * FROM media_moderation_cases WHERE id=?").get(id);
      if(!row||!STATES[row.status])return;
      let publication=null;
      if(isInstagramGuild(row.guildId)){
        if(row.status!=="approved"||!row.repostedMessageId)return;
        publication=store.db.prepare("SELECT guildId,channelId,messageId FROM instagram_posts WHERE messageId=? AND authorId=?").get(row.repostedMessageId,row.authorId);
        if(!publication)return;
      }
      const channelId=store.settings(row.guildId).logChannelId;if(!channelId)return;
      const eventKey=JSON.stringify([row.status,row.reviewerId||null,row.reason||null]);
      key=JSON.stringify([id,channelId,eventKey]);if(pending.has(key))return;
      if(store.db.prepare("SELECT 1 FROM media_moderation_log_events WHERE caseId=? AND channelId=? AND eventKey=?").get(id,channelId,eventKey))return;
      pending.add(key);claimed=true;
      const channel=await client.channels.fetch(channelId);
      if(!channel?.isTextBased()||channel.guildId!==row.guildId)throw new Error("Canal de logs indisponível");
      const avatarURL=channel.guild?.iconURL?.({extension:"png",size:128})||null;
      const sent=await channel.send(buildMediaLog(row,{avatarURL,publication,
        botAvatarURL:client.user?.displayAvatarURL?.({size:128})}));
      registry.preserveMessage(sent);
      store.db.prepare("INSERT OR IGNORE INTO media_moderation_log_events VALUES(?,?,?,?,?)").run(id,channelId,eventKey,sent.id,Date.now());
    }catch{
      // Delivery failures must not change a moderation decision or leak secrets.
      console.warn("[Moderação de mídia] Não foi possível enviar o log; verifique o canal e as permissões do bot.");
    }finally{if(claimed)pending.delete(key);}
  }
  return {logCase};
}
module.exports={createMediaLogger,buildMediaLog};
