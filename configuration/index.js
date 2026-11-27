const {
  SlashCommandBuilder,PermissionFlagsBits,MessageFlags,ChannelType,
  ContainerBuilder,TextDisplayBuilder,ActionRowBuilder,ButtonBuilder,ButtonStyle
}=require("discord.js");
const {ConfigStore}=require("./store");
const {PanelRegistry}=require("./panels");
const {Publisher}=require("./publisher");
const {installRuntime}=require("./render");
const {discoverSystems}=require("./systems");
const {AccessService,LEVEL}=require("./access");
const ui=require("./ui");

module.exports=function installConfiguration({client,commands,db,apis={},definitions=[],imageTransport}){
  const store=new ConfigStore(db),panels=new PanelRegistry({store,client});
  installRuntime({store,client});
  let controller;
  const publisher=new Publisher({store,panels,client,commands,onPublish:async(id,message,ctx)=>{
    if(id==="rankings")apis.rankings?.track(message,ctx.guild,ctx.user.id);
    if(id==="onboarding")db.prepare("INSERT INTO lumiya_onboarding VALUES(?,'sent',?,?,?) ON CONFLICT(guildId) DO UPDATE SET status='sent',channelId=excluded.channelId,messageId=excluded.messageId,updatedAt=excluded.updatedAt")
      .run(ctx.guild.id,message.channelId,message.id,Date.now());
  }});
  const extraSystems=[
    {id:"logs",label:"Logs",description:"Canais e registros administrativos.",commands:[],status:g=>Boolean(apis.logs?.store.get(g.id,"general"))},
    {id:"welcome",label:"Boas-vindas",description:"Onboarding e recepção de novos membros.",commands:[],status:g=>Boolean(store.settings(g.id).welcomeEnabled)},
    {id:"appearance",label:"Personalização",description:"Textos, imagens e componentes dos painéis.",commands:[],status:g=>Boolean(db.prepare("SELECT 1 FROM lumiya_panels WHERE guildId=? LIMIT 1").get(g.id))},
    {id:"general",label:"Configurações gerais",description:"Acessos autorizados e opções da Lumiya.",commands:[],status:()=>true}
  ];
  const systems=()=>[...discoverSystems(commands,apis),...extraSystems];
  const access=new AccessService(store,systems);
  for(const definition of definitions)panels.register(definition);
  panels.register({id:"onboarding",label:"Boas-vindas da Lumiya",category:"Boas-vindas",render:ctx=>ui.onboarding({...ctx,client},systems())});
  panels.register({id:"member-welcome",label:"Recepção de membros",category:"Boas-vindas",render:ctx=>{
    const message=`### ${ui.brand({...ctx,client},"moon")} Boas-vindas, ${ui.cleanName(ctx.user?.displayName||ctx.user?.username||"novo membro")}!\n\nQue bom ter você em **${ui.cleanName(ctx.guild.name)}**. Sua presença torna a nossa comunidade ainda mais especial.\n-# Lumiya • ${ui.cleanName(ctx.guild.name)}`;
    return {components:[new ContainerBuilder().setAccentColor(ui.ACCENT).addTextDisplayComponents(new TextDisplayBuilder().setContent(message))],flags:MessageFlags.IsComponentsV2};
  }});
  async function member(interaction){
    if(!interaction.guild||!interaction.user)throw new Error("Use esta central dentro de um servidor.");
    const actor=await interaction.guild.members.fetch({user:interaction.user.id,force:true});
    const privileged=access.isPrivileged(actor.permissions);
    const effective=access.effective(interaction.guild.id,actor.id,[...actor.roles.cache.keys()],interaction.guild.ownerId,privileged);
    if(actor.id!==interaction.guild.ownerId&&!effective.levels.view)
      throw new Error("Você ainda não possui permissão para acessar esta configuração.");
    actor.lumiyaAccess=effective;
    return actor;
  }
  async function audit(guild,userId,action,panelId,detail){
    store.audit(guild.id,userId,action,panelId,null,detail);
    const channelId=apis.logs?.store.get(guild.id,"general");
    if(!channelId)return;
    try{
      const channel=await guild.channels.fetch(channelId);
      if(channel?.guildId!==guild.id)return;
      const logs=require("../lumiya-ui/logs");
      await channel.send(logs.card({
        category:"configuration",title:"Configuração da Lumiya",subtitle:"Atividade administrativa registrada",
        summary:[["Ação",logs.safe(action)],["Responsável",`<@${userId}>`],
          ...(panelId?[["Painel",logs.safe(panels.get(panelId).label)]]:[])],
        details:Object.entries(detail||{}).filter(([key])=>[
          "type","count","subjectId","draftId","messageId","updated","kind","enabled","channelId"
        ].includes(key)).map(([key,value])=>[{
          type:"Tipo",count:"Quantidade",subjectId:"Destinatário",draftId:"Rascunho",
          messageId:"Mensagem",updated:"Atualizados",kind:"Categoria",enabled:"Ativado",channelId:"Canal"
        }[key],logs.safe(value)]),
        metadata:[["Servidor",guild.id],["Responsável",userId]],
        botAvatarURL:client.user?.displayAvatarURL?.({size:128}),source:"Central /config"
      }));
    }catch{console.warn("[Central Lumiya] O registro administrativo não pôde ser enviado.");}
  }
  const context=i=>({guild:i.guild,user:i.user,channel:i.channel,bot:client.user,client});
  controller=require("./controller")({client,commands,store,panels,publisher,systems,apis,member,audit,context,identify,imageTransport,access});
  commands.register({
    name:"config",description:"Central privada de configurações e personalização da Lumiya.",
    category:"Administração",public:true,authorize:actor=>{
      if(!actor?.guild)return false;
      if(actor.id===actor.guild.ownerId)return true;
      return access.can(actor.guild.id,actor.id,[...actor.roles.cache.keys()],actor.guild.ownerId,"view",LEVEL.view,access.isPrivileged(actor.permissions));
    },permissionLabel:"Proprietário ou pessoa autorizada no painel",
    result:"Gerencia os sistemas existentes, rascunhos, imagens e publicações por servidor.",
    slash:{data:new SlashCommandBuilder().setName("config").setDescription("Configurar a Lumiya e personalizar os painéis do servidor").setDMPermission(false),execute:controller.open},
    prefix:{trigger:"!config",exact:true,execute:async message=>{
      const c=new ContainerBuilder().setAccentColor(ui.ACCENT)
        .addTextDisplayComponents(new TextDisplayBuilder().setContent("### Central da Lumiya\nUse o botão abaixo para abrir suas configurações privadas."))
        .addActionRowComponents(new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("lc:open").setLabel("Abrir configurações").setStyle(ButtonStyle.Primary)));
      await message.reply({components:[c],flags:MessageFlags.IsComponentsV2,allowedMentions:{parse:[]}});
    }}
  });
  function identify(message){
    const nodes=require("./render").flat((message.components||[]).map(c=>c.toJSON?.()||c));
    const ids=nodes.map(c=>c.custom_id);
    const signatures={
      support:"ticket-support",migration:"ticket-migration",unmute:"unmute:self",games:"mds-games-gartic",
      up:"up:claim","instagram-ticket":"ticket-instagram",onboarding:"lc:open","nickname-entry":"np:open","ban-home":"bm:open:ban","media-review-entry":"mds-media-queue"
    };
    for(const [panelId,id]of Object.entries(signatures))if(panels.items.has(panelId)&&ids.includes(id))return panelId;
    if(nodes.some(c=>c.url==="https://discord.com/terms")&&panels.items.has("hall"))return "hall";
    if(ids.some(id=>id?.startsWith("cc:"))&&panels.items.has("command-center"))return "command-center";
    const text=nodes.filter(c=>c.type===10).map(c=>c.content).join("\n");
    if(!nodes.some(c=>[11,12].includes(c.type))&&/TOP 3 CALLS/.test(text)&&/TOP 3 MENSAGENS/.test(text)&&panels.items.has("rankings"))return "rankings";
    return null;
  }
  const preserve=commands.preserveMessage;
  commands.preserveMessage=message=>{
    if(message?.ephemeral||Number(message?.flags?.bitfield||0)&MessageFlags.Ephemeral)return message;
    const result=preserve(message);
    if(message?.guildId&&message.author?.id===client.user?.id&&!(Number(message.flags?.bitfield||0)&MessageFlags.Ephemeral)){
      const id=identify(message);
      if(id)store.record(message.guildId,id,message.channelId||message.channel?.id,message.id);
    }
    return result;
  };
  const tables=new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r=>r.name));
  function importPublication(row,id){
    if(!db.prepare("SELECT 1 FROM lumiya_publications WHERE guildId=? AND channelId=? AND messageId=?").get(row.guildId,row.channelId,row.messageId))
      store.record(row.guildId,id,row.channelId,row.messageId);
  }
  if(tables.has("bot_configuration_panels"))for(const row of db.prepare("SELECT * FROM bot_configuration_panels WHERE messageId IS NOT NULL").all()){
    if(panels.items.has(row.kind))importPublication(row,row.kind);
  }
  for(const [table,id]of [["instagram_ticket_panels","instagram-ticket"],["instagram_media_panels","instagram-media"],["instagram_entry_panels","instagram-entry"],["ranking_panels","rankings"],["command_center_panels","command-center"]]){
    if(tables.has(table)&&panels.items.has(id))for(const row of db.prepare(`SELECT * FROM ${table}`).all())importPublication(row,id);
  }
  const onboardBusy=new Set();
  async function onboard(guild){
    if(!guild?.available||onboardBusy.has(guild.id))return;
    onboardBusy.add(guild.id);
    try{
      const previous=db.prepare("SELECT * FROM lumiya_onboarding WHERE guildId=?").get(guild.id);
      if(previous&&["sent","sending","uncertain"].includes(previous.status))return;
      const me=guild.members.me||await guild.members.fetchMe();
      const channels=await guild.channels.fetch();
      const canSend=channel=>channel&&[ChannelType.GuildText,ChannelType.GuildAnnouncement].includes(channel.type)&&
        channel.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages,PermissionFlagsBits.EmbedLinks]);
      const channel=canSend(guild.systemChannel)?guild.systemChannel:
        [...channels.values()].filter(canSend).sort((a,b)=>(a.rawPosition||0)-(b.rawPosition||0))[0];
      if(!channel){db.prepare("INSERT INTO lumiya_onboarding VALUES(?,'blocked',NULL,NULL,?) ON CONFLICT(guildId) DO UPDATE SET status='blocked',updatedAt=excluded.updatedAt").run(guild.id,Date.now());return;}
      const claimed=db.prepare("INSERT INTO lumiya_onboarding VALUES(?,'sending',?,NULL,?) ON CONFLICT(guildId) DO UPDATE SET status='sending',channelId=excluded.channelId,updatedAt=excluded.updatedAt WHERE lumiya_onboarding.status NOT IN ('sent','sending','uncertain')")
        .run(guild.id,channel.id,Date.now());
      if(!claimed.changes)return;
      try{
        const payload=await panels.render("onboarding",{guild,channel,bot:client.user,user:client.user,client});
        const message=await channel.send(payload);
        db.prepare("UPDATE lumiya_onboarding SET status='sent',messageId=?,updatedAt=? WHERE guildId=?").run(message.id,Date.now(),guild.id);
        store.record(guild.id,"onboarding",channel.id,message.id);
        commands.preserveMessage(message);
      }catch(error){
        db.prepare("UPDATE lumiya_onboarding SET status=?,updatedAt=? WHERE guildId=?").run([50001,50013].includes(error.code)?"blocked":"uncertain",Date.now(),guild.id);
        console.warn("[Central Lumiya] Boas-vindas não confirmadas; use /config para publicar manualmente.");
      }
    }catch{console.warn("[Central Lumiya] Não foi possível localizar um canal para as boas-vindas.");}
    finally{onboardBusy.delete(guild.id);}
  }
  async function welcome(member){
    const saved=store.settings(member.guild.id);
    if(!saved.welcomeEnabled||!saved.welcomeChannel||member.user.bot)return;
    const joinedAt=member.joinedTimestamp||0;
    const claimed=db.prepare("INSERT OR IGNORE INTO lumiya_member_welcomes VALUES(?,?,?,'sending')").run(member.guild.id,member.id,joinedAt);
    if(!claimed.changes)return;
    try{
      const channel=await publisher.channel(member.guild,saved.welcomeChannel);
      const payload=await panels.render("member-welcome",{guild:member.guild,user:member.user,channel,bot:client.user,client});
      await channel.send(payload);
      db.prepare("UPDATE lumiya_member_welcomes SET status='sent' WHERE guildId=? AND userId=? AND joinedAt=?").run(member.guild.id,member.id,joinedAt);
    }catch{console.warn("[Central Lumiya] Recepção do membro indisponível; verifique o canal e as permissões.");}
  }
  client.on("guildCreate",onboard);
  client.on("guildMemberAdd",m=>{void welcome(m).catch(()=>console.warn("[Central Lumiya] Falha contida na recepção."));});
  client.on("messageDelete",message=>{
    if(message.guildId&&message.id)db.prepare("UPDATE lumiya_publications SET status='missing',updatedAt=? WHERE guildId=? AND messageId=? AND status='published'").run(Date.now(),message.guildId,message.id);
  });
  client.on("channelDelete",channel=>{if(channel.guildId)db.prepare("UPDATE lumiya_publications SET status='missing',updatedAt=? WHERE guildId=? AND channelId=? AND status='published'").run(Date.now(),channel.guildId,channel.id);});
  client.on("interactionCreate",controller.handle);
  return {store,panels,publisher,controller,systems,access,onboard,welcome,identify,member,
    registerSystem:definition=>{extraSystems.push(definition);},
    close(){client.off("guildCreate",onboard);installRuntime(null);commands.preserveMessage=preserve;}};
};
