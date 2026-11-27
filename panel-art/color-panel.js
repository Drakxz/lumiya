const {
  ContainerBuilder,TextDisplayBuilder,ActionRowBuilder,ButtonBuilder,ButtonStyle,
  ModalBuilder,TextInputBuilder,TextInputStyle,MessageFlags,PermissionFlagsBits
}=require("discord.js");
const {randomUUID}=require("node:crypto");
const {initializeColors,panelColor,colorHex,DEFAULT_COLOR}=require("./colors");

module.exports=function installColorPanel({client,registry,db}){
  const store=initializeColors(db),sessions=new Map();
  const flags=MessageFlags.IsComponentsV2;
  const admin=member=>Boolean(member?.permissions?.has(PermissionFlagsBits.Administrator));
  function card(guild,session,notice=""){
    const color=panelColor(guild);
    return {components:[new ContainerBuilder().setAccentColor(color)
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(
        `# Cor dos painéis\n${notice?`${notice}\n\n`:""}**Cor atual:** \`${colorHex(color)}\`\n**Padrão:** \`${colorHex(DEFAULT_COLOR)}\`\n\nEsta é a prévia da cor dos painéis gerais deste servidor. A mudança vale para os próximos envios e atualizações; mensagens antigas não são editadas automaticamente.\n\nCores de alertas, punições e publicações dos membros são preservadas.`))
      .addActionRowComponents(new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`panel-color:${session}:edit`).setLabel("Alterar cor").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`panel-color:${session}:reset`).setLabel("Restaurar padrão").setStyle(ButtonStyle.Secondary)
      ))],flags,allowedMentions:{parse:[]}};
  }
  registry.register({
    name:"corpainel",description:"Configura a cor dos painéis gerais deste servidor.",
    category:"Administração",public:true,permission:PermissionFlagsBits.Administrator,
    authorize:admin,permissionLabel:"Administrador",result:"Prévia da cor, edição hexadecimal e restauração do padrão.",
    prefix:{trigger:"!corpainel",exact:true,async execute(message){
      const member=await message.guild.members.fetch(message.author.id);
      if(!admin(member))return message.reply("Somente administradores podem alterar a cor dos painéis.");
      for(const [id,state] of sessions)if(state.expires<Date.now())sessions.delete(id);
      const id=randomUUID();
      sessions.set(id,{guildId:message.guild.id,userId:message.author.id,expires:Date.now()+10*60_000});
      await message.reply(card(message.guild,id));
    }}
  });
  async function handle(interaction){
    if(!interaction.customId?.startsWith("panel-color:"))return;
    const [,id,action]=interaction.customId.split(":");
    const session=sessions.get(id);
    const deny=text=>interaction.reply({content:text,flags:MessageFlags.Ephemeral,allowedMentions:{parse:[]}});
    try{
      if(!interaction.guild||!session||session.expires<Date.now()||
        session.guildId!==interaction.guild.id||session.userId!==interaction.user.id)
        return await deny("Este painel expirou ou pertence a outra pessoa. Use !corpainel para abrir o seu.");
      const member=await interaction.guild.members.fetch(interaction.user.id);
      if(!admin(member))return await deny("Somente administradores podem alterar a cor dos painéis.");
      if(action==="edit"&&interaction.isButton()){
        const input=new TextInputBuilder().setCustomId("hex").setLabel("Cor hexadecimal")
          .setStyle(TextInputStyle.Short).setRequired(true).setMinLength(6).setMaxLength(7)
          .setValue(colorHex(panelColor(interaction.guild))).setPlaceholder("#C4A7E7");
        return await interaction.showModal(new ModalBuilder().setCustomId(`panel-color:${id}:save`)
          .setTitle("Alterar cor dos painéis").addComponents(new ActionRowBuilder().addComponents(input)));
      }
      if(action==="save"&&interaction.isModalSubmit()){
        try{store.set(session.guildId,interaction.fields.getTextInputValue("hex"));}
        catch(error){return await deny(error.message);}
        session.expires=Date.now()+10*60_000;
        return await interaction.update(card(interaction.guild,id,"Cor salva para este servidor."));
      }
      if(action==="reset"&&interaction.isButton()){
        store.reset(session.guildId);
        session.expires=Date.now()+10*60_000;
        return await interaction.update(card(interaction.guild,id,"Cor padrão restaurada."));
      }
    }catch(error){
      console.error("[Cor dos painéis] Falha ao processar a configuração:",error.code||error.name);
      if(!interaction.replied&&!interaction.deferred)
        await deny("Não foi possível atualizar a cor. Tente novamente com !corpainel.").catch(()=>{});
    }
  }
  client.on("interactionCreate",handle);
  return {card,store};
};
