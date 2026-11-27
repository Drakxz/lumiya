const {
  ContainerBuilder,TextDisplayBuilder,SeparatorBuilder,SeparatorSpacingSize,MediaGalleryBuilder,
  ActionRowBuilder,ButtonBuilder,ButtonStyle,RoleSelectMenuBuilder,MessageFlags,PermissionFlagsBits
}=require("discord.js");
const {randomUUID}=require("node:crypto");
const {titulo}=require("../brand");
const {applyPanelAppearance}=require("../panel-art/appearance");

const IMAGE="https://cdn.discordapp.com/attachments/1569908468440367188/1570281109927891004/file_000000001048820e90ef3d220c362384.png";
const GAMES=[
  ["Gartic","gartic","1561108577006002267","1570281229125681175"],
  ["Free Fire","freefire","1552839465565692074","1570281207982194738"],
  ["Valorant","valorant","valorant","1570281485133422592"],
  ["Roblox","roblox","roblox","1570280852913397852"]
];

module.exports=function installGamesRoles({client,registry,db}){
  if(!db)throw new Error("Games roles exige a conexão SQLite compartilhada do bot.");
  db.exec("CREATE TABLE IF NOT EXISTS games_roles_config(guildId TEXT PRIMARY KEY,roleIds TEXT NOT NULL,updatedAt INTEGER NOT NULL)");
  const setups=new Map(),V2=MessageFlags.IsComponentsV2;
  const payload=(container,ephemeral=false)=>require("../lumiya-ui/canonical").canonical({components:[container],files:require("../configuration/runtime").filesFor([container]),flags:V2|(ephemeral?MessageFlags.Ephemeral:0),allowedMentions:{parse:[]}});
  const {statusText}=require("../error-ui");
  const text=content=>new TextDisplayBuilder().setContent(statusText(content));
  const separator=()=>new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small);
  const admin=member=>Boolean(member?.permissions?.has(PermissionFlagsBits.ManageGuild));

  function panel(guild){
    const buttons=GAMES.map(([label,key,emojiName,emojiId])=>new ButtonBuilder()
      .setCustomId(`mds-games-${key}`).setLabel(label).setStyle(ButtonStyle.Secondary)
      .setEmoji({name:emojiName,id:emojiId}));
    const container=new ContainerBuilder().setAccentColor(0)
      .addTextDisplayComponents(text(titulo(guild, "<:emoji_29:1570189707667579000><:emoji_28:1570189682132652194><:emoji_27:1570189651539660951>", "Cargos de Games")))
      .addSeparatorComponents(separator())
      .addMediaGalleryComponents(new MediaGalleryBuilder().addItems(item=>item.setURL(IMAGE)))
      .addSeparatorComponents(separator())
      .addActionRowComponents(new ActionRowBuilder().addComponents(...buttons));
    return applyPanelAppearance(container,guild,"games");
  }

  function errorCard(message){
    return new ContainerBuilder().setAccentColor(0).addTextDisplayComponents(text(`# Não foi possível\n${message}`));
  }
  function setupCard(state){
    const summary=GAMES.map(([label,key])=>`**${label}:** ${state.roleIds[key]?`<@&${state.roleIds[key]}>`:"Não selecionado"}`).join("\n");
    const c=new ContainerBuilder().setAccentColor(0)
      .addTextDisplayComponents(text("# Configurar cargos de Games"),text("Escolha o cargo correspondente a cada jogo antes de publicar."),text(summary));
    for(const [label,key] of GAMES){
      c.addActionRowComponents(new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder()
        .setCustomId(`mds-games-config:${state.id}:${key}`).setPlaceholder(`Selecionar cargo: ${label}`)
        .setMinValues(1).setMaxValues(1)));
    }
    const complete=GAMES.every(([,key])=>state.roleIds[key]);
    c.addActionRowComponents(new ActionRowBuilder().addComponents(new ButtonBuilder()
      .setCustomId(`mds-games-publish:${state.id}`).setLabel("Salvar e publicar painel")
      .setStyle(ButtonStyle.Primary).setDisabled(!complete)));
    return c;
  }
  async function configured(guild,roleIds){
    const entries=GAMES.map(([label,key])=>({label,key,id:roleIds[key]}));
    const missing=entries.filter(entry=>!/^\d{17,20}$/.test(entry.id||""));
    if(missing.length)throw new Error(`Selecione o cargo de: ${missing.map(entry=>entry.label).join(", ")}.`);
    if(new Set(entries.map(entry=>entry.id)).size!==entries.length)throw new Error("Cada jogo precisa ter um cargo diferente.");
    return Promise.all(entries.map(async entry=>{
      const role=await guild.roles.fetch(entry.id).catch(()=>null);
      if(!role)throw new Error(`O cargo selecionado para ${entry.label} não existe neste servidor.`);
      return {...entry,role};
    }));
  }
  async function startSetup(message){
    const saved=db.prepare("SELECT roleIds FROM games_roles_config WHERE guildId=?").get(message.guild.id);
    const state={id:randomUUID(),guildId:message.guild.id,userId:message.author.id,channelId:message.channel.id,
      roleIds:saved?JSON.parse(saved.roleIds):{}};
    setups.set(state.id,state);
    const sent=await message.channel.send(payload(setupCard(state)));
    state.messageId=sent.id;
  }

  async function onInteraction(i){
    if(!i.inGuild?.()||!i.customId?.startsWith("mds-games-"))return;
    try{
      if(i.customId.startsWith("mds-games-config:")){
        const [,id,key]=i.customId.split(":"),state=setups.get(id);
        if(!admin(i.member))throw new Error("Somente administradores com Gerenciar Servidor podem configurar os cargos.");
        if(!state||state.guildId!==i.guildId||state.userId!==i.user.id)throw new Error("Esta configuração pertence a outro administrador ou expirou.");
        if(!GAMES.some(([,gameKey])=>gameKey===key)||!i.isRoleSelectMenu?.())return;
        state.roleIds[key]=i.values[0];
        return i.update({components:[setupCard(state)],allowedMentions:{parse:[]}});
      }
      if(i.customId.startsWith("mds-games-publish:")){
        if(!admin(i.member))throw new Error("Somente administradores com Gerenciar Servidor podem publicar o painel.");
        const id=i.customId.slice("mds-games-publish:".length),state=setups.get(id);
        if(!state||state.guildId!==i.guildId||state.userId!==i.user.id)throw new Error("Esta configuração pertence a outro administrador ou expirou.");
        const items=await validateRoleIds(i.guild,state.roleIds);
        const channel=await client.channels.fetch(state.channelId);
        if(!channel?.isTextBased()||channel.guildId!==state.guildId)throw new Error("O canal onde o painel será publicado não está disponível.");
        db.prepare(`INSERT INTO games_roles_config VALUES(?,?,?) ON CONFLICT(guildId)
          DO UPDATE SET roleIds=excluded.roleIds,updatedAt=excluded.updatedAt`)
          .run(state.guildId,JSON.stringify(state.roleIds),Date.now());
        const posted=await channel.send(payload(panel(i.guild)));registry.preserveMessage?.(posted);
        setups.delete(id);
        return i.update({components:[new ContainerBuilder().setAccentColor(0)
          .addTextDisplayComponents(text("# Painel publicado"),text(`Cargos salvos: ${items.map(item=>`${item.label} <@&${item.id}>`).join(" · ")}`))],allowedMentions:{parse:[]}});
      }
      if(!i.isButton?.())return;
      const gameKey=i.customId.slice("mds-games-".length),game=GAMES.find(([,key])=>key===gameKey);
      if(!game)return;
      const row=db.prepare("SELECT roleIds FROM games_roles_config WHERE guildId=?").get(i.guildId);
      if(!row)throw new Error("Os cargos ainda não foram configurados. Um administrador deve executar !cargosgames.");
      const items=await configured(i.guild,JSON.parse(row.roleIds)),item=items.find(entry=>entry.key===gameKey);
      const bot=i.guild.members.me||await i.guild.members.fetchMe();
      if(!bot.permissions.has(PermissionFlagsBits.ManageRoles))throw new Error("O bot precisa da permissão **Gerenciar Cargos**.");
      if(item.role.managed||item.role.position>=bot.roles.highest.position)throw new Error(`O bot não pode gerenciar ${item.label}; confira a hierarquia.`);
      const member=await i.guild.members.fetch({user:i.user.id,force:true});
      const added=!member.roles.cache.has(item.id);
      if(added)await member.roles.add(item.role,`Painel de cargos de games: ${i.user.id}`);
      else await member.roles.remove(item.role,`Painel de cargos de games: ${i.user.id}`);
      const result=new ContainerBuilder().setAccentColor(0).addTextDisplayComponents(text(
        `# Cargos atualizados\n\n${added?`Adicionado: ${item.label}`:`Removido: ${item.label}`}`));
      return i.reply(payload(result,true));
    }catch(error){
      const response=payload(errorCard(error.message||"Ocorreu um erro ao atualizar os cargos."),true);
      return i.reply(response).catch(()=>{});
    }
  }
  client.on("interactionCreate",onInteraction);

  registry.register({name:"cargosgames",description:"Configura os cargos por jogo e publica o painel de resgate.",category:"Games",
    permissions:["ManageGuild"],result:"Abre a configuração dos quatro cargos e publica o painel no canal atual.",examples:["!cargosgames"],
    prefix:{trigger:"!cargosgames",exact:true,usage:["!cargosgames"],execute:async message=>{
      try{await startSetup(message);}
      catch(error){
        console.error("[Cargos Games] Falha ao abrir configuração:",error.message);
        await message.channel.send(payload(errorCard("Não foi possível abrir a configuração dos cargos."))).catch(()=>{});
      }
    }}});
  async function validateRoleIds(guild,roleIds){
    const items=await configured(guild,roleIds),bot=guild.members.me||await guild.members.fetchMe();
    if(!bot.permissions.has(PermissionFlagsBits.ManageRoles))throw new Error("O bot precisa da permissão **Gerenciar Cargos**.");
    for(const item of items)if(item.role.managed||item.role.position>=bot.roles.highest.position)
      throw new Error(`O bot não pode gerenciar o cargo ${item.label}; ajuste a hierarquia.`);
    return items;
  }
  async function validatePanel(guild){
    const saved=db.prepare("SELECT roleIds FROM games_roles_config WHERE guildId=?").get(guild.id);
    if(!saved)throw new Error("Configure os cargos de jogos na categoria Cargos antes de publicar este painel.");
    await validateRoleIds(guild,JSON.parse(saved.roleIds));
  }
  return {panel,onInteraction,validatePanel};
};
