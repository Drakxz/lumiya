const {
  ContainerBuilder,TextDisplayBuilder,SeparatorBuilder,SeparatorSpacingSize,MediaGalleryBuilder,
  ActionRowBuilder,ButtonBuilder,ButtonStyle,MessageFlags,PermissionFlagsBits,ChannelType
}=require("discord.js");
const {titulo}=require("../brand");
const {applyPanelAppearance}=require("../panel-art/appearance");
const {errorText}=require("../error-ui");

const TITLE="<:emoji_21:1570176552476348647><:emoji_20:1570176386893615204><:emoji_19:1570176352378949722>";
const ACCENT=0;
function panel(guild){
  const support=guild.channels?.cache?.find(ch=>ch.name==="support"&&[ChannelType.GuildText,ChannelType.GuildAnnouncement].includes(ch.type));
  const supportMention=support?`<#${support.id}>`:"#support";
  const bannerUrl="https://cdn.discordapp.com/attachments/1570868736926425190/1572067596252094545/file_0000000015cc820eb61043a08ee060bc.png";
  const container=new ContainerBuilder().setAccentColor(ACCENT)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(titulo(guild, TITLE, "Desmutar")))
    .addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent("Foi mutado ou ensurdecido pelo servidor? Você pode remover o estado clicando no botão abaixo."))
    .addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(
      "### Importante:\n"+
      "> Se o mute ocorreu por desrespeito às regras, este canal não evita punições — você ainda pode ser punido.\n\n"+
      `> Se perceber abuso de permissões ou uso indevido do sistema, abra um ticket em: ${supportMention} e aguarde a equipe de suporte.`))
    .addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small))
     .addMediaGalleryComponents(new MediaGalleryBuilder().addItems(item=>item.setURL(bannerUrl)))
    .addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small))
    .addActionRowComponents(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("unmute:self").setLabel("Seja Desmutado").setStyle(ButtonStyle.Secondary)));
  const rendered=applyPanelAppearance(container,guild,"unmute");
  return require("../lumiya-ui/canonical").canonical({components:[rendered],files:require("../configuration/runtime").filesFor([rendered]),
    flags:MessageFlags.IsComponentsV2,allowedMentions:{parse:[]}});
}
function replyContainer(title,body,color=ACCENT){
  return {components:[new ContainerBuilder().setAccentColor(color).addTextDisplayComponents(
    new TextDisplayBuilder().setContent(title === "# Estado de voz atualizado" ? `${title}\n${body}` : errorText(`${title}\n${body}`)))],
  flags:MessageFlags.IsComponentsV2|MessageFlags.Ephemeral,allowedMentions:{parse:[]}};
}
async function handleUnmute(interaction,{client}){
  if(!interaction.inGuild?.()||!interaction.isButton?.()||interaction.customId!=="unmute:self")return;
  await interaction.deferReply({flags:MessageFlags.IsComponentsV2|MessageFlags.Ephemeral}).catch(()=>{});
  const answer=async(title,body,color)=>interaction.editReply(replyContainer(title,body,color)).catch(()=>{});
  try{
    const guild=interaction.guild;
    if(!guild)return answer("# Servidor indisponível","Não consegui verificar seu estado de voz.",0);
    const member=await guild.members.fetch({user:interaction.user.id,force:true});
    if(member.id!==interaction.user.id)return answer("# Ação não permitida","Este botão só pode ser usado por quem clicou nele.",0);
    if(member.communicationDisabledUntilTimestamp>Date.now())return answer("# Timeout ativo","Este botão não remove timeout/moderação. Aguarde o prazo ou fale com a equipe.",0);
    if(!member.voice.channelId)return answer("# Entre em uma call","Conecte-se a um canal de voz e tente novamente.");
    const removeMute=Boolean(member.voice.serverMute),removeDeaf=Boolean(member.voice.serverDeaf);
    if(!removeMute&&!removeDeaf){
      const local=[];
      if(member.voice.selfMute)local.push("auto-mute");
      if(member.voice.selfDeaf)local.push("auto-deafen");
      return answer("# Nenhum mute de servidor ativo",local.length?
        `Seu ${local.join(" e ")} é local. Desative-o nas configurações do Discord; o bot não pode alterar estados locais.`:
        "Não encontrei mute nem deafen de servidor para remover.");
    }
    const bot=guild.members.me;
    if(!bot)return answer("# Bot indisponível","Não consegui verificar as permissões do bot. Tente novamente.",0);
    if(removeMute&&!bot?.permissions.has(PermissionFlagsBits.MuteMembers))return answer("# Permissão ausente","O bot precisa da permissão **Silenciar membros** para remover o mute de servidor.",0);
    if(removeDeaf&&!bot?.permissions.has(PermissionFlagsBits.DeafenMembers))return answer("# Permissão ausente","O bot precisa da permissão **Ensurdecer membros** para remover o deafen de servidor.",0);
    const botIsAdmin=bot.permissions.has(PermissionFlagsBits.Administrator);
    if(!botIsAdmin&&bot.roles.highest.comparePositionTo(member.roles.highest)<=0)
      return answer("# Hierarquia de cargos","O cargo mais alto do bot precisa estar acima do seu para alterar seu estado de voz.",0);
    if(removeMute)await member.voice.setMute(false,`Self-service unmute requested by ${interaction.user.id}`);
    if(removeDeaf)await member.voice.setDeaf(false,`Self-service undeafen requested by ${interaction.user.id}`);
    return answer("# Estado de voz atualizado",`${[
      removeMute?"O mute de servidor foi removido.":null,
      removeDeaf?"O deafen de servidor foi removido.":null,
      (member.voice.selfMute||member.voice.selfDeaf)?"Estados locais ainda ativos precisam ser desligados por você no Discord.":null
    ].filter(Boolean).join(" ")}`,0);
  }catch(error){
    console.error("[Unmute] Não foi possível remover o mute de voz:",error);
    if(error.code===50013)return answer("# Permissão insuficiente","O bot não tem permissão ou hierarquia para remover o mute.",0);
    return answer("# Não foi possível desmutar","Confirme que está conectado a uma call e tente novamente. Se o problema continuar, abra um ticket em #support.",0);
  }
}

module.exports=function installUnmute({client,registry}){
  registry.register({name:"unmutepainel",description:"Publica o painel de auto-unmute e auto-deafen de voz para membros do servidor.",category:"Moderação",
    permissions:["ManageGuild"],public:true,result:"Publica painel. Botão remove somente server mute/deafen do próprio usuário, não estados locais nem timeout.",
    examples:["!unmutepainel"],prefix:{trigger:"!unmutepainel",exact:true,execute:async message=>{
      if(!message.member?.permissions.has(PermissionFlagsBits.ManageGuild))return registry.deny(message);
       try{const sent=await message.channel.send(panel(message.guild));registry.preserveMessage(sent);}
       catch(error){console.error("[Unmute] Falha ao publicar o painel:",error);await message.reply(errorText("Não consegui publicar o painel. Verifique permissões e acesso ao banner.")).catch(()=>{});}
    }}});
  client.on("interactionCreate",i=>handleUnmute(i,{client}));
  return {panel,handle: i=>handleUnmute(i,{client}),accent:ACCENT};
};
