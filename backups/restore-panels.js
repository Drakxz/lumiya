const {ChannelType,MessageFlags}=require("discord.js");

module.exports=function createRestoredPanelPublisher({registry,threadAccess,commandCenter,renderSupport,renderMigration}){
  return async function restorePanels(guild,panels,result,config){
    const created=new Set(result.createdChannelIds||[]),seen=new Set();
    result.errors.push(...await commandCenter.republishRestoredPanels(guild,[...created]));
    for(const panel of panels){
      const key=`${panel.channelId}:${panel.kind}`;
      if(!created.has(panel.channelId)||seen.has(key)||!["support","migration"].includes(panel.kind))continue;
      seen.add(key);
      try{
        const channel=await guild.channels.fetch(panel.channelId);
        if(channel?.guildId!==guild.id||![ChannelType.GuildText,ChannelType.GuildAnnouncement].includes(channel.type))
          throw new Error("Canal de painel indisponível");
        await threadAccess.grantStaffRoleAccess(channel,panel.kind);
        const rendered=await (panel.kind==="support"?renderSupport(guild):renderMigration(guild));
        const sent=await channel.send({components:[rendered.component],files:rendered.files||[],
          flags:MessageFlags.IsComponentsV2,allowedMentions:{parse:[]}});
        registry.preserveMessage(sent);
        config.trackPanel(guild.id,channel.id,panel.kind,sent.id);
      }catch{result.errors.push(`Painel ${panel.kind} no canal ${panel.channelId}: não foi possível republicar; verifique permissões.`);}
    }
  };
};
