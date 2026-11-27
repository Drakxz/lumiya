const {AuditLogEvent,PermissionFlagsBits}=require("discord.js");
const EXTERNAL_ALLOWED_ROLE_IDS=new Set(["1560458283117191188"]);
const EXTERNAL_ALLOWED_BOT_IDS=new Set(["1568767491713409125"]);

// Não remove com base apenas no cache: a auditoria deve confirmar uma adição
// externa recente. Preserva o próprio MDS, bots explicitamente autorizados
// e cargos liberados; pessoas acima do bot também podem adicionar manualmente.
// Os demais executores continuam sujeitos à proteção.
module.exports=function installRoleGuard({client,history,additionLog,resolveRoleId=(_guildId,id)=>id}){
  const handled=new Set(),pending=new Set(),timers=new Set();
  const recent=entry=>Number.isFinite(entry.createdTimestamp)&&Math.abs(Date.now()-entry.createdTimestamp)<60_000;
  async function inspect(entry,guild,expected=null){
    if(entry.action!==AuditLogEvent.MemberRoleUpdate||!recent(entry))return;
    const targetId=entry.targetId||entry.target?.id;
    if(expected&&targetId!==expected.userId)return;
    // O log é independente da remoção e também registra adições da própria MDS.
    // Não espera a API do canal para iniciar a proteção.
    const log=additionLog?.inspect(entry,guild);
    log?.catch?.(()=>{});
    const additions=(entry.changes||[]).filter(change=>change.key==="$add").flatMap(change=>change.new||[]);
    if(!additions.length)return;
    const actorId=entry.executorId||entry.executor?.id;
    if(!actorId||!client.user?.id||actorId===client.user.id||EXTERNAL_ALLOWED_BOT_IDS.has(actorId))return;
    if(actorId===guild.ownerId)return;
    let bot;
    try{
      bot=await guild.members.fetchMe();
      if(!bot.permissions.has(PermissionFlagsBits.ManageRoles))return;
      if(!entry.executor?.bot){
        const actor=await guild.members.fetch({user:actorId,force:true});
        if(actor?.id===actorId&&actor.user?.bot===false&&
          actor.roles.highest.comparePositionTo(bot.roles.highest)>0)return;
      }
    }catch(error){
      // Do not undo an action if we cannot verify the executor's authority.
      console.warn("[Proteção de cargos] Não foi possível verificar a hierarquia:",error.message);
      return;
    }
    for(const addition of additions){
      if([...EXTERNAL_ALLOWED_ROLE_IDS].some(id=>resolveRoleId(guild.id,id)===addition.id))continue;
      if(expected&&!expected.roleIds.has(addition.id))continue;
      const key=`${guild.id}:${entry.id}:${addition.id}`;
      if(handled.has(key)||pending.has(key))continue;
      pending.add(key);
      try{
        const role=await guild.roles.fetch(addition.id);
        if(!role||role.managed||role.id===guild.id||role.comparePositionTo(bot.roles.highest)>=0)continue;
        const target=await guild.members.fetch({user:targetId,force:true});
        if(!target.roles.cache.has(role.id))continue;
        await history.alterarCargo({guild,alvo:target,cargo:role,action:"remove",autor:client.user,
          source:"Proteção de cargos fora do painel MDS",
          reason:`Adição externa fora do MDS por ${actorId}; auditoria ${entry.id}`,
          executar:reason=>target.roles.remove(role,reason)});
        handled.add(key);
        // Limita a memória; IDs de auditoria antigos não serão reprocessados.
        if(handled.size>5000)handled.delete(handled.values().next().value);
      }catch(error){console.warn("[Proteção de cargos] Não foi possível reverter adição externa:",error.message);}
      finally{pending.delete(key);}
    }
  }
  const onAudit=(entry,guild)=>inspect(entry,guild).catch(error=>console.warn("[Proteção de cargos] Auditoria:",error.message));
  const onMember=(before,after)=>{
    if(before.partial||after.partial)return;
    const roleIds=new Set([...after.roles.cache.keys()].filter(id=>id!==after.guild.id&&!before.roles.cache.has(id)));
    if(!roleIds.size)return;
    const observedAt=Date.now(),expected={userId:after.id,roleIds};
    // Fallback para o caso de a auditoria não chegar pelo Gateway.
    for(const delay of [1000,3500,8000]){
      const timer=setTimeout(async()=>{
        timers.delete(timer);
        try{
          if(!after.guild.members.me?.permissions.has(PermissionFlagsBits.ViewAuditLog))return;
          const logs=await after.guild.fetchAuditLogs({type:AuditLogEvent.MemberRoleUpdate,limit:30});
          for(const entry of logs.entries.values()){
            if(entry.createdTimestamp<observedAt-5000)continue;
            await inspect(entry,after.guild,expected);
          }
        }catch(error){console.warn("[Proteção de cargos] Consulta de auditoria:",error.message);}
      },delay);
      timer.unref();timers.add(timer);
    }
  };
  client.on("guildAuditLogEntryCreate",onAudit);
  client.on("guildMemberUpdate",onMember);
  return {inspect,close(){client.off("guildAuditLogEntryCreate",onAudit);client.off("guildMemberUpdate",onMember);for(const timer of timers)clearTimeout(timer);timers.clear();}};
};
