const {PermissionFlagsBits:P,ChannelType}=require("discord.js");
const fault=(statusCode,message)=>Object.assign(new Error(message),{statusCode});
module.exports=function access({client,store,cfg}){
  const resources=require("../resource-ids")(store.db);
  async function guild(){if(!client.isReady())throw fault(503,"O Discord está temporariamente indisponível.");const g=client.guilds.cache.get(cfg.guildId);if(!g)throw fault(403,"O bot não está neste servidor.");return g;}
  async function check(userId,{publish=false,admin=false,moderator=false}={}){
    let g,m;
    try{g=await guild();m=await g.members.fetch({user:userId,force:true});}
    catch(e){if(e.statusCode)throw e;throw fault(e.code===10007?403:503,e.code===10007?"Acesso exclusivo para membros do servidor.":"Não foi possível verificar sua participação.");}
    const s=store.settings(cfg.guildId,{allowUnconfigured:true});
    const isAdmin=m.id===g.ownerId||m.permissions.has(P.Administrator);
    const has=ids=>ids.some(id=>m.roles.cache.has(id));
    const isMod=isAdmin||has(s.moderatorRoles);
    if(admin&&!isAdmin||moderator&&!isMod)throw fault(403,"Você não tem permissão para esta ação.");
    const c=s.channelId?await g.channels.fetch(resources.resolve(cfg.guildId,s.channelId)).catch(()=>null):null;
    if((!c||c.type!==ChannelType.GuildText)&&publish)throw fault(503,"Este servidor ainda não tem um canal de Instagram disponível.");
    if(c&&!c.permissionsFor(m)?.has(P.ViewChannel))throw fault(403,"Você não tem acesso ao canal de Instagram.");
    if(publish){
      if(s.maintenance)throw fault(503,"Publicações temporariamente em manutenção.");
      if(has(s.blockedRoles)||s.allowedRoles.length&&!has(s.allowedRoles))throw fault(403,"Seus cargos não permitem publicar.");
      const r=store.restriction(userId);
      if(r&&r.untilAt>Date.now())throw fault(403,"Sua conta está temporariamente restrita na plataforma.");
      if(m.communicationDisabledUntilTimestamp>Date.now()||m.pending)throw fault(403,"Conclua a verificação do servidor antes de publicar.");
      if(!m.joinedTimestamp||Date.now()-m.joinedTimestamp<s.minMembershipHours*3600000)throw fault(403,"Tempo mínimo no servidor ainda não atingido.");
      // Web uploads do not require ticket approval or Discord intake-channel
      // permissions. Destination membership and web safety policies still apply.
    }
    const vip=has(s.vipRoles);
    return {guild:g,member:m,channel:c,admin:isAdmin,moderator:isMod,vip,
      limits:{daily:vip?s.vipDailyLimit:s.dailyLimit,cooldown:vip?s.vipCooldownSeconds:s.cooldownSeconds}};
  }
  async function botChannel(channel){
    const me=await channel.guild.members.fetchMe();
    if(!channel.permissionsFor(me)?.has([P.ViewChannel,P.SendMessages,P.AttachFiles,P.ReadMessageHistory]))throw fault(503,"O bot não tem as permissões necessárias no canal.");
  }
  async function manageGuild(userId,guildId){
    if(!client.isReady())throw fault(503,"O Discord está temporariamente indisponível.");
    const g=client.guilds.cache.get(guildId);
    if(!g)throw fault(403,"Você não pode gerenciar este servidor.");
    let member;
    try{member=await g.members.fetch({user:userId,force:true});}
    catch(e){if(e.code===10007||e.code===50001)throw fault(403,"Você não pode gerenciar este servidor.");throw fault(503,"Não foi possível verificar suas permissões no Discord.");}
    if(member.id!==g.ownerId&&!member.permissions.has(P.Administrator))throw fault(403,"Você precisa ser administrador deste servidor.");
    return {guild:g,member};
  }
  async function manageableGuilds(userId){
    if(!client.isReady())throw fault(503,"O Discord está temporariamente indisponível.");
    const guilds=[...client.guilds.cache.values()],items=[];
    let next=0;
    // Bound concurrent Discord requests, without trusting cached member permissions.
    await Promise.all(Array.from({length:Math.min(4,guilds.length)},async()=>{
      while(next<guilds.length){
        const g=guilds[next++];
        try{await manageGuild(userId,g.id);items.push({id:g.id,name:g.name,icon:g.iconURL({size:64}),primary:g.id===cfg.defaultGuildId});}
        catch(e){if(e.statusCode!==403)throw e;}
      }
    }));
    return items.sort((a,b)=>Number(b.primary)-Number(a.primary)||a.name.localeCompare(b.name,"pt-BR"));
  }
  async function sharedGuilds(userId){
    if(!client.isReady())throw fault(503,"O Discord está temporariamente indisponível.");
    const guilds=[...client.guilds.cache.values()],items=[];let next=0;
    await Promise.all(Array.from({length:Math.min(4,guilds.length)},async()=>{
      while(next<guilds.length){
        const g=guilds[next++];let m;
        try{m=await g.members.fetch({user:userId,force:true});}
        catch(e){if(e.code===10007||e.code===50001)continue;throw fault(503,"Não foi possível consultar seus servidores. Tente novamente.");}
        const s=store.settings(g.id,{allowUnconfigured:true});
        items.push({id:g.id,name:g.name,icon:g.iconURL({size:128}),configured:!!s.channelId,maintenance:s.maintenance,
          admin:m.id===g.ownerId||m.permissions.has(P.Administrator)});
      }
    }));
    return items.sort((a,b)=>a.name.localeCompare(b.name,"pt-BR"));
  }
  return {check,botChannel,guild,manageGuild,manageableGuilds,sharedGuilds};
};
module.exports.fault=fault;
