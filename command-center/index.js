const {randomUUID,createHash}=require("node:crypto");
const {
  ContainerBuilder,SectionBuilder,ThumbnailBuilder,TextDisplayBuilder,SeparatorBuilder,SeparatorSpacingSize,ActionRowBuilder,
  ButtonBuilder,ButtonStyle,StringSelectMenuBuilder,ModalBuilder,LabelBuilder,TextInputBuilder,TextInputStyle,
  MessageFlags,PermissionFlagsBits,SlashCommandBuilder
}=require("discord.js");
const {CenterStore}=require("./store");
const {serverName}=require("../brand");
const ui=require("../lumiya-ui/theme");
const PANEL_VERSION="lumiya-command-center-v4";

module.exports=function instalarCentral({client,registry,db,responderSemPermissao,
  showRestricted=process.env.COMMAND_CENTER_SHOW_RESTRICTED==="true"}) {
  const store=new CenterStore(db);
  registry.attachRemoteStore(store.remoteAdapter());
  const inProgress=new Set();
  const publicationLocks=new Set();
  const norm=text=>String(text).normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase();
  const categoryKey=category=>createHash("sha256").update(category).digest("hex").slice(0,20);
  const {statusText}=require("../error-ui");
  const txt=content=>new TextDisplayBuilder().setContent(statusText(content));
  const sep=()=>new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small);
  const row=(...components)=>new ActionRowBuilder().addComponents(...components);
  const button=(s,action,label)=>new ButtonBuilder().setCustomId(`cc:${action}:${s.id}`).setLabel(label).setStyle(ButtonStyle.Secondary);
  const payload=(container,ephemeral=false)=>require("../lumiya-ui/canonical").canonical({components:[container],files:require("../configuration/runtime").filesFor([container]),flags:MessageFlags.IsComponentsV2|(ephemeral?MessageFlags.Ephemeral:0),allowedMentions:{parse:[]}});
  const nameOf=c=>registry.forms(c).map(f=>f.type==="slash"?`/${c.name}`:c.prefix.trigger).join(" · ");
  function fresh(guildId,userId) {
    return store.session({id:randomUUID(),guildId,userId,permanent:false,view:"home",category:null,query:"",page:1,group:0,detail:null,hasMessage:false});
  }
  function visible(s,member) {return registry.catalog({member,includeRestricted:showRestricted&&!s.permanent,all:s.permanent});}
  function navigation(container,s,categories,{listing=false,pages=1}={}) {
    const groups=Math.max(1,Math.ceil(categories.length/24));
    s.group=Math.min(Math.max(0,s.group),groups-1);
    if(categories.length) {
      const options=[{label:"Todas as categorias",value:"all",default:!s.category},
        ...categories.slice(s.group*24,s.group*24+24).map(category=>({label:category,value:categoryKey(category),default:s.category===category}))];
      container.addActionRowComponents(row(new StringSelectMenuBuilder().setCustomId(`cc:category:${s.id}`)
        .setPlaceholder("Qual cantinho você quer explorar?").setMinValues(1).setMaxValues(1).addOptions(options)));
    }
    if(groups>1)container.addActionRowComponents(row(
      button(s,"groupback","Categorias <").setDisabled(s.group===0),
      button(s,"groupinfo",`${s.group+1}/${groups}`).setDisabled(true),
      button(s,"groupnext","Categorias >").setDisabled(s.group===groups-1)));
    container.addActionRowComponents(row(
      button(s,"search","Pesquisar").setEmoji({id:"1569941293323255889",name:"1378484773118541847"}),
      button(s,listing?"home":"all",listing?"Início":"Ver comandos").setStyle(listing?ButtonStyle.Secondary:ButtonStyle.Primary),
      ...(s.query?[button(s,"clear","Limpar pesquisa")]:[])));
    if(listing)container.addSeparatorComponents(sep()).addActionRowComponents(row(
      button(s,"prev","Anterior").setDisabled(s.page<=1),button(s,"pageinfo",`${s.page}/${pages}`).setDisabled(true),
      button(s,"next","Próxima").setDisabled(s.page>=pages)));
    return container;
  }
  function render(s,member,guild=null) {
    const base=renderBase(s,member,guild);
    return s.view==="home"?require("../configuration/runtime").decorate(base,guild||client.guilds?.cache?.get(s.guildId),"command-center"):base;
  }
  function renderBase(s,member,guild=null) {
    const catalog=visible(s,member);
    const categories=[...new Set(catalog.map(c=>c.category))].sort((a,b)=>a.localeCompare(b,"pt-BR"));
    if(s.category&&!categories.includes(s.category))s.category=null;
    const container=new ContainerBuilder().setAccentColor(require("../panel-art/colors").panelColor(guild||s.guildId));
    const ctx={guild,client},moon=ui.emojiToken(ctx,"moon"),star=ui.emojiToken(ctx,"star");
    const heading=(title,subtitle)=>container.addTextDisplayComponents(txt(
      `### ${moon} ${title}\n-# ${subtitle}`));
    if(s.view==="detail") {
      const command=catalog.find(c=>c.name===s.detail);
      heading("Informações do comando","Tudo o que você precisa para usar este comando.");
      if(!command)container.addTextDisplayComponents(txt("Este comando não está mais disponível nesta consulta."));
      else {
        const usages=registry.forms(command).flatMap(f=>f.usage).map(u=>`\`${u}\``).join("\n");
        container.addSeparatorComponents(sep()).addTextDisplayComponents(txt(
          `**Comando:** ${nameOf(command)}\n**Categoria:** ${command.category}\n\n`+
          `**Descrição:** ${command.description}\n\n**Como utilizar:**\n${usages}\n\n`+
          `**Permissão:** ${registry.permissionText(command)}\n`+
          (!registry.canUse(command,member)?"-# Você não tem a permissão exigida para executar este comando.\n":"")+
          (command.result?`\n**Resultado:** ${command.result}\n`:"")+
          (command.examples.length?`\n**Exemplos:**\n${command.examples.map(e=>`\`${e}\``).join("\n")}`:"")+
          (command.prefix?.aliases.length?`\n**Aliases:** ${command.prefix.aliases.map(a=>`\`${a}\``).join(", ")}`:"")));
      }
      return container.addSeparatorComponents(sep()).addActionRowComponents(row(button(s,"back","Voltar aos comandos"),button(s,"home","Início")));
    }
    if(s.view==="home") {
      const slash=catalog.filter(c=>registry.forms(c).some(f=>f.type==="slash")).length;
      const name=serverName(guild);
      const title=[txt(`### ${moon} Central de Comandos | ${ui.cleanName(name)}`),
        txt("-# Seu cantinho para descobrir o que posso fazer. ♡"),
        txt(`Bem-vindo à Central de Comandos de ${ui.cleanName(name)}!\nEscolha uma categoria ou pesquise um comando. Eu te mostro como usar e quais permissões você precisa.`)];
      const icon=guild?.iconURL?.({extension:"png",size:256})||client.user?.displayAvatarURL?.({size:256});
      if(icon)container.addSectionComponents(new SectionBuilder().addTextDisplayComponents(...title).setThumbnailAccessory(new ThumbnailBuilder().setURL(icon)));
      else container.addTextDisplayComponents(...title);
      container
        .addSeparatorComponents(sep()).addTextDisplayComponents(txt(
          `### ${star} Explore à vontade\n**Comandos disponíveis:** ${catalog.length} · **Categorias:** ${categories.length}\n`+
          `**Prefixo:** \`!\`\n**Comandos slash:** ${slash?`${slash} comandos com versão registrada`:"Nenhum registrado no momento"}\n`+
          "-# Versões prefixo/slash e aliases não duplicam a contagem. O comando cl dispensa prefixo."+
          (s.permanent?"\n-# Este painel mostra o catálogo público. Ao navegar, você abre uma consulta privada conforme suas permissões.":"")))
        .addSeparatorComponents(sep()).addTextDisplayComponents(txt("-# Por onde vamos começar? Escolha uma categoria abaixo."));
      return navigation(container,s,categories);
    }
    const filtered=catalog.filter(c=>(!s.category||c.category===s.category)&&(!s.query||
      norm(`${c.name} ${c.description} ${registry.forms(c).flatMap(f=>f.usage).join(" ")}`).includes(norm(s.query))));
    const pages=Math.max(1,Math.ceil(filtered.length/4));s.page=Math.min(Math.max(1,s.page),pages);
    heading(s.category?`Comandos de ${ui.cleanName(s.category)}`:"Todos os comandos",
      s.query?`Pesquisa: ${ui.cleanName(s.query)}`:"Consulte o uso e as permissões de cada comando.");
    container.addSeparatorComponents(sep());
    const items=filtered.slice((s.page-1)*4,s.page*4);
    if(!items.length)container.addTextDisplayComponents(txt("Ainda não encontrei comandos com esses filtros. ♡\nTente outro termo, limpe a pesquisa ou escolha outra categoria."));
    items.forEach((command,index)=>{
      if(index)container.addSeparatorComponents(sep());
      const description=command.description.length>130?command.description.slice(0,127)+"…":command.description;
      container.addSectionComponents(new SectionBuilder().addTextDisplayComponents(txt(
        `**${nameOf(command)}**\n${description}\n`+
        `\`${registry.forms(command)[0].usage[0]}\`\n-# Permissão: ${registry.permissionText(command)}${registry.canUse(command,member)?"":" · 🔒"}`))
        .setButtonAccessory(button(s,`detail:${command.name}`,"Como usar").setEmoji(ui.emojiObject(ctx,"star"))));
    });
    return navigation(container.addSeparatorComponents(sep()),s,categories,{listing:true,pages});
  }
  async function error(origin,err) {
    console.warn("[Central de Comandos]",err.message);
    const p=payload(new ContainerBuilder().setAccentColor(0).addTextDisplayComponents(
      txt("# Não foi possível\nAbra a Central novamente ou verifique as permissões do bot.")),!origin.author);
    await(origin.author?origin.reply(p):origin.deferred||origin.replied?origin.followUp(p):origin.reply(p)).catch(()=>{});
  }
  async function open(origin,ephemeral) {
    const s=fresh(origin.guild.id,(origin.user||origin.author).id);
    const p=payload(render(s,origin.member,origin.guild),ephemeral);
    if(origin.author)await origin.reply(p);else await origin.editReply(p);
    s.hasMessage=true;store.session(s);
  }
  async function getPublicationMessage(publication) {
    const channel=await client.channels.fetch(publication.channelId);
    if(!channel?.isTextBased()||channel.guildId!==publication.guildId)throw new Error("Canal do painel indisponível ou de outro servidor.");
    return {channel,message:publication.messageId?await channel.messages.fetch(publication.messageId):null};
  }
  async function publish(origin) {
    if(!origin.member?.permissions.has(PermissionFlagsBits.ManageGuild))return responderSemPermissao(origin);
    const arg=origin.content.trim().split(/\s+/)[1];
    const id=arg?arg.replace(/[<#>]/g,""):origin.channel.id;
    if(!/^\d{17,20}$/.test(id))throw new Error("Canal inválido.");
    const key=`${origin.guild.id}:${id}`;
    if(publicationLocks.has(key))throw new Error("Esse painel já está sendo publicado.");
    publicationLocks.add(key);
    try {
      const channel=id===origin.channel.id?origin.channel:await origin.guild.channels.fetch(id);
      if(!channel?.isTextBased()||channel.guildId!==origin.guild.id ||
        !channel.permissionsFor(origin.guild.members.me)?.has([PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages]))throw new Error("Sem acesso ao canal solicitado.");
      const publication=store.preparePanel(origin.guild.id,id),s=store.publicationSession(publication.id);
      const p=payload(render(s,null,origin.guild));let message=null;
      if(publication.messageId) {
        try{message=await channel.messages.fetch(publication.messageId);}
        catch(err){if(err.code!==10008)throw err;}
      }
      if(message) {
        if(message.author.id!==client.user.id)throw new Error("O painel não pertence ao bot.");
        await message.edit({...p,attachments:[]});
      } else message=await channel.send({...p,nonce:BigInt(`0x${publication.id.replaceAll("-","").slice(0,16)}`).toString(),enforceNonce:true});
      store.savePanel(publication.id,message.id,publicationHash());
    } finally {publicationLocks.delete(key);}
  }
  const publicationHash=()=>createHash("sha256").update(`${PANEL_VERSION}:${registry.hash()}`).digest("hex");
  let refreshRunning=false,refreshAgain=false;
  async function refreshPanels() {
    if(!registry.synced)return;
    if(refreshRunning){refreshAgain=true;return;}
    refreshRunning=true;
    let blocked=false;
    try {
      do {
        refreshAgain=false;blocked=false;const hash=publicationHash();
        for(const publication of store.panels()) {
          if(publication.hash===hash||!publication.messageId)continue;
          const key=`${publication.guildId}:${publication.channelId}`;
          if(publicationLocks.has(key)){blocked=true;continue;}
          publicationLocks.add(key);
          try {
            const {message}=await getPublicationMessage(publication);
            if(!message||message.author.id!==client.user.id)throw new Error("Mensagem do painel ausente ou de outro autor.");
             await message.edit({...payload(render(store.publicationSession(publication.id),null,message.guild)),attachments:[]});
            store.savePanel(publication.id,message.id,hash);
          }catch(err){console.warn(`[Central] Não foi possível atualizar o painel ${publication.messageId}:`,err.message);}
          finally{publicationLocks.delete(key);}
        }
        refreshAgain=refreshAgain||publicationHash()!==hash;
      }while(refreshAgain);
    }finally{
      refreshRunning=false;
      if(blocked){clearTimeout(refreshTimer);refreshTimer=setTimeout(()=>refreshPanels().catch(err=>console.warn("[Central] Atualização:",err.message)),300);refreshTimer.unref();}
    }
  }
  let refreshTimer;
  const catalogChanged=()=>{
    if(!registry.synced)return;
    clearTimeout(refreshTimer);refreshTimer=setTimeout(()=>refreshPanels().catch(err=>console.warn("[Central] Atualização:",err.message)),300);refreshTimer.unref();
  };
  registry.on("changed",catalogChanged);
  client.once("clientReady",async()=>{
    try{await registry.ready;store.prune();await refreshPanels();}
    catch(err){console.warn("[Central] Inicialização:",err.message);}
  });
  client.on("interactionCreate",async i=>{
    if(!i.inGuild()||!i.customId?.startsWith("cc:"))return;
    try {
      // Ação pode conter um nome lógico, sem usar metadados enviados pelo usuário.
      const parts=i.customId.split(":");let action=parts[1],id=parts[2],commandName=null;
      if(action==="detail"){commandName=parts[2];id=parts[3];}
      let s=store.getSession(id)||store.publicationSession(id);
      if(!s||s.guildId!==i.guildId||(!s.permanent&&s.userId!==i.user.id))return responderSemPermissao(i).catch(()=>{});
      const fromPublication=s.permanent;
      if(fromPublication)s=fresh(i.guildId,i.user.id);
      if(inProgress.has(s.id)){await i.deferUpdate();return;}
      inProgress.add(s.id);
      try {
        if(action==="search") {
          store.session(s);
          const input=new TextInputBuilder().setCustomId("search").setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(100);
          if(s.query)input.setValue(s.query);
          await i.showModal(new ModalBuilder().setCustomId(`cc:modal:${s.id}`).setTitle("Pesquisar comandos")
            .addLabelComponents(new LabelBuilder().setLabel("Nome ou descrição").setTextInputComponent(input)));
          return;
        }
        if(fromPublication||!s.hasMessage)await i.deferReply({flags:MessageFlags.Ephemeral});else await i.deferUpdate();
        if(action==="category") {
          const value=i.values[0];const categories=[...new Set(visible(s,i.member).map(c=>c.category))];
          s.category=value==="all"?null:categories.find(c=>categoryKey(c)===value)||null;s.view="list";s.page=1;s.detail=null;
        } else if(action==="all"){s.category=null;s.query="";s.page=1;s.view="list";}
        else if(action==="home"){s.view="home";s.category=null;s.query="";s.page=1;s.detail=null;}
        else if(action==="clear"){s.query="";s.page=1;s.view="list";s.detail=null;}
        else if(action==="modal"){s.query=i.fields.getTextInputValue("search").trim();s.view="list";s.page=1;s.detail=null;}
        else if(action==="prev"||action==="next")s.page+=action==="next"?1:-1;
        else if(action==="groupback"||action==="groupnext")s.group+=action==="groupnext"?1:-1;
        else if(action==="detail"){s.detail=commandName;s.view="detail";}
        else if(action==="back"){s.detail=null;s.view="list";}
       const guild=i.guild||await client.guilds.fetch(i.guildId);
       const p=payload(render(s,i.member,guild));await i.editReply(p);s.hasMessage=true;store.session(s);
      }finally{inProgress.delete(s.id);}
    }catch(err){await error(i,err);}
  });
  registry.register({name:"comandos",description:"Explora a Central de Comandos com categorias, pesquisa e informações de uso.",category:"Geral",
    result:"Abre o catálogo atualizado de comandos disponíveis para suas permissões. A versão slash é privada.",
    examples:["!comandos","/comandos"],prefix:{trigger:"!comandos",exact:true,execute:origin=>open(origin,false)},
    slash:{data:new SlashCommandBuilder().setName("comandos").setDescription("Explorar a Central de Comandos mds"),
      execute:async i=>{await i.deferReply({flags:MessageFlags.Ephemeral});await open(i,true);}}});
  registry.register({name:"painelcomandos",description:"Publica ou atualiza o painel permanente da Central de Comandos.",category:"Administração",
    permissions:["ManageGuild"],result:"Edita o painel já conhecido do canal; não publica uma cópia em cada execução. Atualiza automaticamente quando o catálogo mudar.",
    examples:["!painelcomandos","!painelcomandos #canal"],
    prefix:{trigger:"!painelcomandos",usage:["!painelcomandos [#canal ou ID]"],execute:async origin=>{try{await publish(origin);}catch(err){await error(origin,err);}}}});
  async function republishRestoredPanels(guild,channelIds){
    const selected=new Set(channelIds),errors=[];
    for(const publication of store.panels()){
      if(publication.guildId!==guild.id||!selected.has(publication.channelId)||publication.messageId)continue;
      try{
        const channel=await guild.channels.fetch(publication.channelId);
        if(channel?.guildId!==guild.id||!channel.isTextBased()||
            !channel.permissionsFor(guild.members.me)?.has([PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages]))
          throw new Error("Canal indisponível");
        const sent=await channel.send(payload(render(store.publicationSession(publication.id),null,guild)));
        registry.preserveMessage?.(sent);
        store.savePanel(publication.id,sent.id,publicationHash());
      }catch{errors.push(`Central de comandos no canal ${publication.channelId}: não foi possível republicar.`);}
    }
    return errors;
  }
  return {store,render,refreshPanels,publish,publicationHash,republishRestoredPanels,close(){clearTimeout(refreshTimer);registry.off("changed",catalogChanged);}};
};
