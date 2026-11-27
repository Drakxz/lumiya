const {createHash}=require("node:crypto");
const {errorText}=require("../error-ui");
const painelEmojis=require("../lumiya-ui/emojis");
const {VERIFICATION_BANNER,VERIFICATION_THUMBNAIL}=require("./art");
const {applyPanelAppearance}=require("../panel-art/appearance");
const {ContainerBuilder,TextDisplayBuilder,SectionBuilder,ThumbnailBuilder,SeparatorBuilder,MediaGalleryBuilder,ActionRowBuilder,ButtonBuilder,ButtonStyle,ChannelSelectMenuBuilder,ChannelType,MessageFlags,PermissionFlagsBits,ModalBuilder,LabelBuilder,TextInputBuilder,TextInputStyle}=require("discord.js");

module.exports=function installInstagram({client,registry,db}){
  db.exec(`CREATE TABLE IF NOT EXISTS instagram_settings(guildId TEXT PRIMARY KEY,channelId TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS instagram_posts(id TEXT PRIMARY KEY,guildId TEXT NOT NULL,channelId TEXT NOT NULL,messageId TEXT,authorId TEXT NOT NULL,filename TEXT NOT NULL,caption TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS instagram_likes(postId TEXT NOT NULL,userId TEXT NOT NULL,PRIMARY KEY(postId,userId));
    CREATE TABLE IF NOT EXISTS instagram_comments(id INTEGER PRIMARY KEY,postId TEXT NOT NULL,userId TEXT NOT NULL,content TEXT NOT NULL);`);
  db.exec("CREATE TABLE IF NOT EXISTS instagram_submissions(id TEXT PRIMARY KEY,guildId TEXT NOT NULL,originalMessageId TEXT NOT NULL,authorId TEXT NOT NULL,handle TEXT,UNIQUE(guildId,originalMessageId))");
  db.exec(`CREATE TABLE IF NOT EXISTS instagram_sources(guildId TEXT PRIMARY KEY,sourceGuildId TEXT NOT NULL,sourceChannelId TEXT NOT NULL UNIQUE);
    CREATE TABLE IF NOT EXISTS instagram_deliveries(caseId TEXT PRIMARY KEY,guildId TEXT NOT NULL,channelId TEXT NOT NULL,sourceGuildId TEXT NOT NULL,sourceChannelId TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS instagram_entry_panels(guildId TEXT NOT NULL,channelId TEXT PRIMARY KEY,messageId TEXT NOT NULL);`);
  if(!db.prepare("PRAGMA table_info(instagram_posts)").all().some(c=>c.name==="sourceId"))db.exec("ALTER TABLE instagram_posts ADD COLUMN sourceId TEXT");
  db.exec("CREATE TABLE IF NOT EXISTS instagram_post_images(postId TEXT NOT NULL,position INTEGER NOT NULL,filename TEXT NOT NULL,PRIMARY KEY(postId,position))");
  const mediaPanels=require("./media-panel")({client,registry,db});
  const admin=m=>Boolean(m?.permissions?.has?.(PermissionFlagsBits.ManageGuild));
  const isChannel=(gid,cid)=>db.prepare("SELECT 1 FROM instagram_settings WHERE guildId=? AND channelId=?").get(gid,cid);
  const sourceRoute=(gid,cid)=>db.prepare("SELECT s.guildId,d.channelId,s.sourceGuildId,s.sourceChannelId FROM instagram_sources s JOIN instagram_settings d ON d.guildId=s.guildId WHERE s.sourceGuildId=? AND s.sourceChannelId=?").get(gid,cid);
  const isIntake=(gid,cid)=>Boolean(sourceRoute(gid,cid)||isChannel(gid,cid)&&!db.prepare("SELECT 1 FROM instagram_sources WHERE guildId=?").get(gid));
  function captureDelivery(caseId,gid,cid){
    const route=sourceRoute(gid,cid);
    if(route)db.prepare("INSERT INTO instagram_deliveries VALUES(?,?,?,?,?)").run(caseId,route.guildId,route.channelId,gid,cid);
  }
  async function deliveryChannel(caseId){
    const route=db.prepare("SELECT * FROM instagram_deliveries WHERE caseId=?").get(caseId);
    if(!route)return null;
    const current=sourceRoute(route.sourceGuildId,route.sourceChannelId);
    if(!current||current.guildId!==route.guildId||current.channelId!==route.channelId)throw new Error("Conexão do Instagram alterada ou desativada; publicação suspensa.");
    const channel=await client.channels.fetch(route.channelId);
    if(!channel?.isTextBased()||channel.guildId!==route.guildId)throw new Error("Destino do Instagram indisponível.");
    return channel;
  }
  const privateText=content=>({content:errorText(content),flags:MessageFlags.Ephemeral,allowedMentions:{parse:[]}});
  const configError=message=>Object.assign(new Error(message),{instagramConfiguration:true});
  const count=(table,id)=>db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE postId=?`).get(id).n;
  function activityPanel(p,view="likes",requestedPage=0){
    const likes=count("instagram_likes",p.id),comments=count("instagram_comments",p.id);
    const isLikes=view==="likes",size=isLikes?15:4,total=isLikes?likes:comments;
    const pages=Math.max(1,Math.ceil(total/size));
    const page=Math.min(Math.max(0,Number.parseInt(requestedPage,10)||0),pages-1);
    const c=new ContainerBuilder().setAccentColor(0xD95B96)
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(
        `## <:GRIFE10:1572075340015075358> Atividade da publicação\nDe <@${p.authorId}> · [Ver publicação](https://discord.com/channels/${p.guildId}/${p.channelId}/${p.messageId})\n\n<:GRIFE34:1572075167805481020> **${likes.toLocaleString("pt-BR")} curtidas**　·　<:GRIFE40:1572075291374002306> **${comments.toLocaleString("pt-BR")} comentários**`))
      .addSeparatorComponents(new SeparatorBuilder().setDivider(true));
    const tab=(mode,label,emoji)=>new ButtonBuilder().setCustomId(`insta:${mode}:${p.id}:0:tab`)
      .setLabel(label).setEmoji(emoji).setStyle(view===mode?ButtonStyle.Primary:ButtonStyle.Secondary).setDisabled(view===mode);
    c.addActionRowComponents(new ActionRowBuilder().addComponents(
      tab("likes","Curtidas",{name:"GRIFE34",id:"1572075167805481020"}),
      tab("comments","Comentários",{name:"GRIFE40",id:"1572075291374002306"})));
    if(isLikes){
      const rows=db.prepare("SELECT userId FROM instagram_likes WHERE postId=? ORDER BY userId LIMIT ? OFFSET ?").all(p.id,size,page*size);
      c.addTextDisplayComponents(new TextDisplayBuilder().setContent(
        `### Quem curtiu\n${rows.map((r,index)=>`\`${String(page*size+index+1).padStart(2,"0")}\`  <@${r.userId}>`).join("\n")||"_Nenhuma curtida por enquanto. Seja o primeiro a curtir!_"}`));
    }else{
      const rows=db.prepare("SELECT userId,content FROM instagram_comments WHERE postId=? ORDER BY id DESC LIMIT ? OFFSET ?").all(p.id,size,page*size);
      c.addTextDisplayComponents(new TextDisplayBuilder().setContent("### Comentários\n-# Do mais recente ao mais antigo"));
      if(!rows.length)c.addTextDisplayComponents(new TextDisplayBuilder().setContent("_A conversa ainda não começou. Deixe o primeiro comentário!_"));
      for(const r of rows){
        const safe=r.content.replace(/\\/g,"\\\\").replace(/([`*_~|>])/g,"\\$1").replace(/\r?\n/g,"\n> ");
        c.addTextDisplayComponents(new TextDisplayBuilder().setContent(`**<@${r.userId}>**\n> ${safe}`));
      }
    }
    c.addSeparatorComponents(new SeparatorBuilder().setDivider(true))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# Página ${page+1} de ${pages} · ${total} ${isLikes?"curtidas":"comentários"} · Somente você pode ver este painel`));
    c.addActionRowComponents(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`insta:${view}:${p.id}:${page-1}:prev`).setLabel("Anterior").setStyle(ButtonStyle.Secondary).setDisabled(page===0),
      new ButtonBuilder().setCustomId(`insta:${view}:${p.id}:${page+1}:next`).setLabel("Próxima").setStyle(ButtonStyle.Secondary).setDisabled(page===pages-1),
      new ButtonBuilder().setCustomId(`insta:${view}:${p.id}:${page}:refresh`).setLabel("Atualizar").setEmoji({name:"Icon_Options",id:"1569951006547116082"}).setStyle(ButtonStyle.Secondary)));
    return {components:[c],flags:MessageFlags.IsComponentsV2|MessageFlags.Ephemeral,allowedMentions:{parse:[]}};
  }
  function render(p,url=`attachment://${p.filename}`,gallery=true){
    const c=new ContainerBuilder().addTextDisplayComponents(new TextDisplayBuilder().setContent(`<@${p.authorId}>`))
      .addSeparatorComponents(new SeparatorBuilder().setDivider(true));
    if(gallery&&url)c.addMediaGalleryComponents(new MediaGalleryBuilder().addItems(...(Array.isArray(url)?url:[url]).map(value=>item=>item.setURL(value))));
    if(p.caption)c.addTextDisplayComponents(new TextDisplayBuilder().setContent(p.caption));
    c.addSeparatorComponents(new SeparatorBuilder().setDivider(true));
    const button=(action,emoji,label)=>{const b=new ButtonBuilder().setCustomId(`insta:${action}:${p.id}`).setEmoji(emoji).setStyle(ButtonStyle.Secondary);if(label)b.setLabel(label);return b;};
    c.addActionRowComponents(new ActionRowBuilder().addComponents(
      button("like",{name:"GRIFE34",id:"1572075167805481020"},String(count("instagram_likes",p.id))),
      button("comment",{name:"GRIFE40",id:"1572075291374002306"},String(count("instagram_comments",p.id))),
      button("info",{name:"GRIFE10",id:"1572075340015075358"}),button("list",{name:"Icon_Options",id:"1569951006547116082"})));
    return {components:[c],flags:MessageFlags.IsComponentsV2,allowedMentions:{parse:[]}};
  }
  async function publish({channel,authorId,buffer,filename,images,caption="",originalMessageId=null,id=createHash("sha256").update(`${channel.guildId}:${channel.id}:${filename}`).digest("hex")}){
    const files=images||[{buffer,filename}];
    filename=filename||files[0].filename;
    let p=db.prepare("SELECT * FROM instagram_posts WHERE id=?").get(id);
    if(p?.messageId)return channel.messages.fetch(p.messageId);
    if(!p){
      db.prepare("INSERT INTO instagram_posts(id,guildId,channelId,messageId,authorId,filename,caption,sourceId) VALUES(?,?,?,?,?,?,?,?)").run(id,channel.guildId,channel.id,null,authorId,filename,caption,originalMessageId);
      p=db.prepare("SELECT * FROM instagram_posts WHERE id=?").get(id);
    }
    const nonce=BigInt(`0x${id.slice(0,16)}`).toString();
    const sent=await channel.send({...render(p,images?files.map(file=>`attachment://${file.filename}`):undefined),files:files.map(file=>({attachment:file.buffer,name:file.filename})),nonce,enforceNonce:true});
    db.prepare("UPDATE instagram_posts SET messageId=? WHERE id=?").run(sent.id,id);
    if(images)files.forEach((file,position)=>db.prepare("INSERT OR REPLACE INTO instagram_post_images VALUES(?,?,?)").run(id,position,file.filename));
    registry.preserveMessage(sent);
    return sent;
  }
  function settings(gid){
    const selected=db.prepare("SELECT channelId FROM instagram_settings WHERE guildId=?").get(gid);
    const source=db.prepare("SELECT * FROM instagram_sources WHERE guildId=?").get(gid);
    const menu=new ChannelSelectMenuBuilder().setCustomId("insta:channel").setPlaceholder("Canal de publicação neste servidor")
      .setChannelTypes(ChannelType.GuildText).setMinValues(0).setMaxValues(1);
    if(selected)menu.setDefaultChannels(selected.channelId);
    return {components:[new ContainerBuilder().setAccentColor(0xD95B96).addTextDisplayComponents(new TextDisplayBuilder().setContent(
      painelEmojis.panelText(`## Instagram\n**Envios:** ${source?`<#${source.sourceChannelId}> · servidor \`${source.sourceGuildId}\``:"No próprio canal de publicação"}\n**Publicações:** ${selected?`<#${selected.channelId}>`:"Não configurado"}`)))
      .addSeparatorComponents(new SeparatorBuilder().setDivider(true))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent("Envio → verificação → publicação\n\nSomente mídias aprovadas são publicadas. Bloqueios, falhas e dúvidas não chegam ao destino automaticamente.\n-# A análise usa as regras da proteção de mídias do servidor de origem."))
      .addActionRowComponents(new ActionRowBuilder().addComponents(menu))
      .addActionRowComponents(new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("insta:source").setLabel(source?"Alterar origem":"Conectar outro servidor").setStyle(ButtonStyle.Secondary).setDisabled(!selected),
        new ButtonBuilder().setCustomId("insta:sourceclear").setLabel("Usar envio local").setStyle(ButtonStyle.Secondary).setDisabled(!source)))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent("-# O bot deve estar nos dois servidores. Restrinja o envio de mensagens no destino à equipe e ao bot. Limpe a seleção para desativar."))],flags:MessageFlags.IsComponentsV2,allowedMentions:{parse:[]}};
  }
  registry.register({name:"instagram",description:"Configura o canal de Instagram com proteção de mídias.",category:"Instagram",permissions:["ManageGuild"],
    prefix:{trigger:"!instagram",exact:true,execute:async m=>{if(!m.guild||!admin(m.member))return;const sent=await m.channel.send(settings(m.guildId));registry.preserveMessage(sent);}}});
  function entryPanel(guild){
    const container=new ContainerBuilder().setAccentColor(0x000000)
      .addSectionComponents(new SectionBuilder()
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(
          "## Instagram · verificação\nSeu espaço no nosso Instagram começa aqui.\n\nAntes de compartilhar sua foto, entre no servidor de verificação e abra um ticket. Nossa equipe vai orientar você durante o processo."))
        .setThumbnailAccessory(new ThumbnailBuilder().setURL(VERIFICATION_THUMBNAIL).setDescription("Instagram")))
      .addSeparatorComponents(new SeparatorBuilder().setDivider(true))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(
        "**Como participar**\n1. Entre no servidor de verificação pelo botão abaixo.\n2. Abra um ticket e aguarde o atendimento da equipe.\n3. Se sua verificação for aprovada, você receberá acesso ao canal de envio de fotos.\n\nApós a liberação, envie sua foto no canal indicado. Ela passará pela análise de mídia antes de aparecer aqui."))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent("-# A liberação de acesso é feita pela equipe. Somente mídias aprovadas são publicadas."))
      .addMediaGalleryComponents(new MediaGalleryBuilder().addItems(item=>item.setURL(VERIFICATION_BANNER).setDescription("Instagram · verificação")))
      .addActionRowComponents(new ActionRowBuilder().addComponents(
        new ButtonBuilder().setLabel("Entrar no servidor de verificação").setStyle(ButtonStyle.Link).setURL("https://discord.gg/KMdAGUrZh7")));
    const rendered=applyPanelAppearance(container,guild,"instagram-entry");
    return require("../lumiya-ui/canonical").canonical({components:[rendered],files:require("../configuration/runtime").filesFor([rendered]),flags:MessageFlags.IsComponentsV2,allowedMentions:{parse:[]}});
  }
  registry.register({name:"instapainel",description:"Publica o painel de acesso à verificação do Instagram.",category:"Instagram",permissions:["ManageGuild"],
    examples:["!instapainel"],
    prefix:{trigger:"!instapainel",exact:true,execute:async m=>{
      if(!m.guild||!admin(m.member))return;
      const existing=db.prepare("SELECT messageId FROM instagram_entry_panels WHERE guildId=? AND channelId=?").get(m.guildId,m.channel.id);
      let sent;
      if(existing){
        try{sent=await m.channel.messages.fetch(existing.messageId);}
        catch(error){if(Number(error.code)!==10008)throw error;}
      }
      if(sent)await sent.edit({...entryPanel(m.guild),attachments:[]});else sent=await m.channel.send(entryPanel(m.guild));
      registry.preserveMessage(sent);
      db.prepare("INSERT OR REPLACE INTO instagram_entry_panels VALUES(?,?,?)").run(m.guildId,m.channel.id,sent.id);
    }}});
  // Serializa alterações no mesmo post para manter os contadores consistentes.
  const locks=new Map();
  function profileSubmission(p){
    return db.prepare("SELECT * FROM instagram_submissions WHERE guildId=? AND originalMessageId=? AND authorId=?")
      .get(p.guildId,p.sourceId||`post:${p.id}`,p.authorId);
  }
  function profilePanel(p,viewerId){
    const handle=profileSubmission(p)?.handle;
    const c=new ContainerBuilder().setAccentColor(0xD95B96)
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(`## <:GRIFE10:1572075340015075358> Instagram\nPublicação de <@${p.authorId}>`))
      .addSeparatorComponents(new SeparatorBuilder().setDivider(true))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(handle
        ?`### @${handle}\n[Visitar perfil no Instagram](https://www.instagram.com/${encodeURIComponent(handle)}/)\n-# Perfil informado pelo autor. O bot não verifica a titularidade.`
        :"### Nenhum Instagram informado\nO autor ainda não adicionou um @ a esta publicação."))
      .addSeparatorComponents(new SeparatorBuilder().setDivider(true))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent("-# Adicionar o Instagram é opcional · Somente você pode ver este painel"));
    if(viewerId===p.authorId){
      const row=new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`insta:profileedit:${p.id}`)
        .setLabel(handle?"Editar meu @":"Adicionar meu @").setEmoji({name:"GRIFE10",id:"1572075340015075358"}).setStyle(ButtonStyle.Primary));
      if(handle)row.addComponents(new ButtonBuilder().setCustomId(`insta:profileremove:${p.id}`).setLabel("Remover meu @").setStyle(ButtonStyle.Secondary));
      c.addActionRowComponents(row)
        .addActionRowComponents(new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`insta:delete:${p.id}`)
          .setLabel("Apagar minha publicação").setEmoji({name:"1563979203135807638",id:"1570281149094170736"}).setStyle(ButtonStyle.Danger)));
    }
    return {components:[c],flags:MessageFlags.IsComponentsV2|MessageFlags.Ephemeral,allowedMentions:{parse:[]}};
  }
  function mediaURL(message){
    if(message.attachments?.size>1)return [...message.attachments.values()].map(a=>a.url);
    const attachment=message.attachments?.first?.();
    if(attachment?.url)return attachment.url;
    // Galerias V2 podem ter mídia nos componentes sem message.attachments.
    function find(components){
      for(const component of components||[]){
        const raw=component.toJSON?.()||component;
        const urls=(raw.items||[]).map(item=>item.media?.url).filter(url=>url&&/^https:\/\//.test(url));
        if(urls.length)return urls.length===1?urls[0]:urls;
        const nested=find(raw.components);if(nested)return nested;
      }
    }
    return find(message.components);
  }
  async function postMessage(p,i){
    if(i?.message?.id===p.messageId&&typeof i.message.edit==="function")return i.message;
    const channel=await client.channels.fetch(p.channelId);
    return channel.messages.fetch(p.messageId);
  }
  async function refreshPosts(){
    for(const p of db.prepare("SELECT * FROM instagram_posts WHERE messageId IS NOT NULL").all()){
      try{
        const message=await postMessage(p);
        registry.preserveMessage(message);
        const url=mediaURL(message);
        if(url){
          await message.edit(render(p,url));
        }
      }catch(error){
        if(Number(error.code)===10008){
          // A publicação foi excluída no Discord. Preserva os dados, mas
          // deixa de tentar atualizar a referência inexistente ao reiniciar.
          db.prepare("UPDATE instagram_posts SET messageId=NULL WHERE id=? AND messageId=?").run(p.id,p.messageId);
        }else console.warn("[Instagram] Falha ao atualizar publicação:",error.message);
      }
    }
  }
  async function refreshEntryPanels(){
    for(const panel of db.prepare("SELECT * FROM instagram_entry_panels").all()){
      try{
        const channel=await client.channels.fetch(panel.channelId);
        if(channel.guildId!==panel.guildId)continue;
        const message=await channel.messages.fetch(panel.messageId);
        registry.preserveMessage(message);
        await message.edit({...entryPanel(channel.guildId),attachments:[]});
      }catch(error){
        if(Number(error.code)===10008)db.prepare("DELETE FROM instagram_entry_panels WHERE channelId=? AND messageId=?").run(panel.channelId,panel.messageId);
        else console.warn("[Instagram] Falha ao atualizar painel de verificação:",error.message);
      }
    }
  }
  client.once("clientReady",async()=>{await refreshPosts();await refreshEntryPanels();});
  async function handle(i){
    if(!i.guildId||!i.customId?.startsWith("insta:"))return;
    if(["insta:source","insta:sourcesave","insta:sourceclear"].includes(i.customId)){
      if(!admin(i.member))return i.reply(privateText("Somente quem tem Gerenciar Servidor pode configurar."));
      if(i.customId==="insta:source"){
        return i.showModal(new ModalBuilder().setCustomId("insta:sourcesave").setTitle("Origem dos envios")
          .addLabelComponents(new LabelBuilder().setLabel("ID do canal no outro servidor").setDescription("Ative o Modo Desenvolvedor no Discord e copie o ID do canal.").setTextInputComponent(
            new TextInputBuilder().setCustomId("channel").setStyle(TextInputStyle.Short).setRequired(true).setMinLength(17).setMaxLength(20))));
      }
      if(i.customId==="insta:sourceclear"){
        db.prepare("DELETE FROM instagram_sources WHERE guildId=?").run(i.guildId);
        return i.update(settings(i.guildId));
      }
      await i.deferReply({flags:MessageFlags.Ephemeral});
      const selected=db.prepare("SELECT channelId FROM instagram_settings WHERE guildId=?").get(i.guildId);
      if(!selected)throw configError("Configure o destino primeiro.");
      const cid=i.fields.getTextInputValue("channel").trim();
      if(!/^\d{17,20}$/.test(cid))throw configError("ID de canal inválido.");
      const channel=await client.channels.fetch(cid);
      if(!channel||channel.type!==ChannelType.GuildText||channel.guildId===i.guildId)throw configError("Escolha um canal de texto de outro servidor.");
      const member=await channel.guild.members.fetch(i.user.id);
      if(!admin(member))throw configError("Você precisa de Gerenciar Servidor também na origem.");
      if(!channel.permissionsFor(client.user)?.has([PermissionFlagsBits.ViewChannel,PermissionFlagsBits.ReadMessageHistory,PermissionFlagsBits.SendMessages,PermissionFlagsBits.ManageMessages]))throw configError("Faltam permissões do bot no canal de origem.");
      if(isChannel(channel.guildId,channel.id))throw configError("O canal de origem já é um destino do Instagram.");
      const occupied=db.prepare("SELECT guildId FROM instagram_sources WHERE sourceChannelId=?").get(cid);
      if(occupied&&occupied.guildId!==i.guildId)throw configError("Este canal já está conectado a outro destino.");
      await mediaPanels.publish(channel);
      db.prepare("INSERT OR REPLACE INTO instagram_sources VALUES(?,?,?)").run(i.guildId,channel.guildId,cid);
      return i.editReply(settings(i.guildId));
    }
    if(i.customId==="insta:channel"){
      if(!admin(i.member))return i.reply(privateText("Somente quem tem Gerenciar Servidor pode configurar."));
      const cid=i.values?.[0];
      if(cid){
        if(db.prepare("SELECT 1 FROM instagram_sources WHERE sourceChannelId=?").get(cid))return i.reply(privateText("Este canal já é uma origem de envios."));
        const channel=await i.guild.channels.fetch(cid);
        const perms=channel.permissionsFor(client.user);
        if(!perms?.has([PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages,PermissionFlagsBits.AttachFiles,PermissionFlagsBits.ManageMessages]))
          return i.reply(privateText("Preciso de Ver Canal, Enviar Mensagens, Anexar Arquivos e Gerenciar Mensagens nesse canal."));
        db.prepare("INSERT OR REPLACE INTO instagram_settings VALUES(?,?)").run(i.guildId,cid);
        await channel.send({content:"**Instagram** — Este canal recebe publicações aprovadas pela proteção de mídias. Configure a origem no painel. No modo local, os envios são removidos e analisados pela OpenAI antes da republicação; podem ficar visíveis brevemente. Não envie dados pessoais ou sensíveis.",allowedMentions:{parse:[]}});
      }else db.prepare("DELETE FROM instagram_settings WHERE guildId=?").run(i.guildId);
      return i.update(settings(i.guildId));
    }
    const [,action,id,page]=i.customId.split(":");
    const p=db.prepare("SELECT * FROM instagram_posts WHERE id=? AND guildId=?").get(id,i.guildId);
    if(!p||!p.messageId)return i.reply(privateText("Publicação indisponível."));
    if(["profileedit","profilesave","profileremove"].includes(action)){
      if(p.authorId!==i.user.id)return i.reply(privateText("Somente o autor pode alterar o Instagram desta publicação."));
      if(action==="profileedit"){
        const input=new TextInputBuilder().setCustomId("handle").setStyle(TextInputStyle.Short).setMaxLength(31).setRequired(true).setPlaceholder("@seu.usuario");
        const current=profileSubmission(p)?.handle;if(current)input.setValue(current);
        return i.showModal(new ModalBuilder().setCustomId(`insta:profilesave:${id}`).setTitle("Instagram · opcional")
          .addLabelComponents(new LabelBuilder().setLabel("Seu @ do Instagram").setDescription("Será exibido a quem abrir o terceiro botão do post.").setTextInputComponent(input)));
      }
      let handle=null;
      if(action==="profilesave"){
        handle=i.fields.getTextInputValue("handle").trim().replace(/^@/,"");
        if(!/^[a-zA-Z0-9._]{1,30}$/.test(handle))return i.reply(privateText("Informe apenas seu @, com até 30 letras, números, pontos ou sublinhados. Não envie o link."));
      }
      const source=p.sourceId||`post:${p.id}`;
      const submissionId=createHash("sha256").update(`${p.guildId}:${source}`).digest("hex");
      db.prepare(`INSERT INTO instagram_submissions(id,guildId,originalMessageId,authorId,handle) VALUES(?,?,?,?,?)
        ON CONFLICT(guildId,originalMessageId) DO UPDATE SET handle=excluded.handle WHERE authorId=excluded.authorId`).run(submissionId,p.guildId,source,p.authorId,handle);
      if(i.message&&i.update)return i.update(profilePanel(p,i.user.id));
      return i.reply(profilePanel(p,i.user.id));
    }
    if(action==="comment"&&i.isButton?.()){
      const input=new TextInputBuilder().setCustomId("text").setStyle(TextInputStyle.Paragraph).setMaxLength(500).setRequired(true);
      return i.showModal(new ModalBuilder().setCustomId(`insta:submit:${id}`).setTitle("Comentar")
        .addLabelComponents(new LabelBuilder().setLabel("Comentário").setTextInputComponent(input)));
    }
    if(action==="info"){
      return i.reply(profilePanel(p,i.user.id));
    }
    if(action==="list"){
      return i.reply(activityPanel(p));
    }
    if(action==="likes"||action==="comments")return i.update(activityPanel(p,action,page));
    if(!["like","submit","delete"].includes(action))return;
    if(action==="delete"&&p.authorId!==i.user.id)return i.reply(privateText("Somente o autor pode excluir esta publicação pelo bot."));
    await i.deferReply({flags:MessageFlags.Ephemeral});
    const previous=locks.get(id)||Promise.resolve();
    const task=previous.catch(()=>{}).then(async()=>{
      const message=await postMessage(p,i);
      if(action==="delete"){
        await message.delete();
        db.prepare("DELETE FROM instagram_posts WHERE id=?").run(id);
        db.prepare("DELETE FROM instagram_likes WHERE postId=?").run(id);
        db.prepare("DELETE FROM instagram_comments WHERE postId=?").run(id);
        return i.editReply({content:"Publicação excluída."});
      }
      const url=mediaURL(message);
      if(!url)throw new Error("Mídia da publicação indisponível");
      if(action==="like"){
        const removed=db.prepare("DELETE FROM instagram_likes WHERE postId=? AND userId=?").run(id,i.user.id);
        if(!removed.changes)db.prepare("INSERT INTO instagram_likes VALUES(?,?)").run(id,i.user.id);
      }else{
        if(count("instagram_comments",id)>=1000)return i.editReply({content:errorText("Limite de comentários atingido.")});
        const content=i.fields.getTextInputValue("text").trim().slice(0,500);
        if(!content)return i.editReply({content:errorText("Comentário vazio.")});
        db.prepare("INSERT INTO instagram_comments(postId,userId,content) VALUES(?,?,?)").run(id,i.user.id,content);
      }
      await message.edit(render(p,url));
      await i.editReply({content:action==="like"?"Curtida atualizada.":"Comentário enviado.",allowedMentions:{parse:[]}});
    });
    locks.set(id,task);
    try{await task;}finally{if(locks.get(id)===task)locks.delete(id);}
  }
  client.on("interactionCreate",i=>{void handle(i).catch(async error=>{
    console.warn("[Instagram]",error.message);
    const reply=privateText(error.instagramConfiguration?error.message:"Não foi possível concluir a ação. Verifique se o bot tem acesso ao canal e tente novamente.");
    if(i.deferred||i.replied)await i.editReply({content:reply.content}).catch(()=>{});
    else await i.reply(reply).catch(()=>{});
  });});
   return {isChannel,isIntake,captureDelivery,deliveryChannel,publish,render,settings,handle,activityPanel,profilePanel,entryPanel,
     isConfigured:gid=>Boolean(db.prepare("SELECT 1 FROM instagram_settings WHERE guildId=?").get(gid))};
};
