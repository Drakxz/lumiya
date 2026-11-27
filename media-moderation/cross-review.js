const {createHash}=require("node:crypto");
const fs=require("node:fs/promises");
const {fileTypeFromBuffer}=require("file-type");
const {ContainerBuilder,TextDisplayBuilder,MediaGalleryBuilder,ActionRowBuilder,ButtonBuilder,ButtonStyle,MessageFlags,PermissionFlagsBits,ChannelType}=require("discord.js");
const MEDIA_EXT={"image/png":"png","image/jpeg":"jpg","image/webp":"webp","image/gif":"gif","video/mp4":"mp4","video/webm":"webm","video/quicktime":"mov"};

function createCrossReview({client,registry,store}){
  const db=store.db,pending=new Set();
  db.exec("CREATE TABLE IF NOT EXISTS media_moderation_external_reviews(caseId TEXT NOT NULL,channelId TEXT NOT NULL,eventKey TEXT NOT NULL,messageId TEXT NOT NULL,PRIMARY KEY(caseId,channelId,eventKey))");
  if(!db.prepare("PRAGMA table_info(media_moderation_external_reviews)").all().some(c=>c.name==="mediaAttached"))db.exec("ALTER TABLE media_moderation_external_reviews ADD COLUMN mediaAttached INTEGER NOT NULL DEFAULT 0");
  const admin=member=>Boolean(member?.permissions?.has(PermissionFlagsBits.ManageGuild));
  const hasRole=(member,id)=>Boolean(id&&(member?.roles?.cache?.has(id)||Array.isArray(member?.roles)&&member.roles.includes(id)));
  function canReview(i,row){
    const config=store.settings(row.guildId).externalReview;
    return Boolean(config&&i.guildId===config.guildId&&i.channelId===config.channelId&&(admin(i.member)||hasRole(i.member,config.roleId)));
  }
  function validateChannel(channel,guildId){
    if(!channel||channel.type!==ChannelType.GuildText||!channel.guild||channel.guildId!==guildId)throw new Error("Escolha um canal de texto comum do servidor de revisão.");
    const everyonePermissions=channel.permissionsFor(channel.guild.roles.everyone);
    if(!everyonePermissions||everyonePermissions.has(PermissionFlagsBits.ViewChannel))throw new Error("O canal de revisão deve ser privado: remova Ver Canal de @everyone.");
    if(!channel.permissionsFor(channel.guild.members.me)?.has([PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages,PermissionFlagsBits.AttachFiles]))throw new Error("O bot precisa de Ver Canal, Enviar Mensagens e Anexar Arquivos no destino.");
  }
  async function configure({sourceGuild,actorId,channelId,roleId=null}){
    if(!/^\d{17,20}$/.test(channelId)||roleId&&!/^\d{17,20}$/.test(roleId))throw new Error("Informe IDs válidos de canal e cargo.");
    const sourceMember=await sourceGuild.members.fetch(actorId).catch(()=>null);
    if(!admin(sourceMember))throw new Error("Você precisa de Gerenciar Servidor na origem.");
    const channel=await client.channels.fetch(channelId).catch(()=>null);
    if(!channel?.guild||channel.guildId===sourceGuild.id)throw new Error("Escolha um canal de outro servidor onde o bot também esteja.");
    const targetMember=await channel.guild.members.fetch(actorId).catch(()=>null);
    if(!admin(targetMember))throw new Error("Você precisa de Gerenciar Servidor também no servidor de revisão.");
    validateChannel(channel,channel.guildId);
    if(roleId){const role=await channel.guild.roles.fetch(roleId).catch(()=>null);if(!role||role.id===channel.guildId||role.managed||role.guild.id!==channel.guildId)throw new Error("O cargo de revisão deve ser um cargo comum do servidor de destino, diferente de @everyone.");}
    const settings=store.settings(sourceGuild.id);
    settings.externalReview={guildId:channel.guildId,channelId,roleId};store.saveSettings(sourceGuild.id,settings);
    return settings.externalReview;
  }
  function notice(row,{media=null,available=true,roleId=null}={}){
    const reviewing=row.status==="review"&&available;
    const status=row.status==="review"?(available?"Aguardando revisão":"Arquivo indisponível, expirado ou revisão externa desativada"):row.status==="approved"?"Aprovada e republicada na origem":"Finalizada: não republicada";
     const c=new ContainerBuilder().setAccentColor(0);
     if(roleId)c.addTextDisplayComponents(new TextDisplayBuilder().setContent(`<@&${roleId}>`));
     c.addTextDisplayComponents(new TextDisplayBuilder().setContent(
      `# Revisão de mídia — outro servidor\n**Servidor de origem:** \`${row.guildId}\`\n**Canal de origem:** <#${row.channelId}>\n**Enviado por:** <@${row.authorId}>\n**Status:** ${status}\n**Caso:** \`${row.id}\`\n\nA mídia anexada é visível a quem pode ver este canal. Somente a equipe autorizada pode decidir. Aprovar republica no canal de origem; reprovar não publica.`));
    if(media)c.addMediaGalleryComponents(new MediaGalleryBuilder().addItems(item=>item.setURL(`attachment://${media.name}`)));
    c.addActionRowComponents(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`mds-media-review:approve:${row.id}`).setLabel("Aprovar").setStyle(ButtonStyle.Success).setDisabled(!reviewing||!media),
      new ButtonBuilder().setCustomId(`mds-media-review:reject:${row.id}`).setLabel("Reprovar").setStyle(ButtonStyle.Danger).setDisabled(!reviewing),
      new ButtonBuilder().setCustomId(`mds-media-open:${row.id}`).setLabel("Abrir caso privado").setStyle(ButtonStyle.Secondary).setDisabled(!reviewing)));
     const p={components:[c],flags:MessageFlags.IsComponentsV2,allowedMentions:{parse:[],roles:roleId?[roleId]:[]}};
    if(media)p.files=[{attachment:media.buffer,name:media.name}];
    return p;
  }
  function eligible(row){
    if(!row)return false;
    const retention=Math.max(1,Math.min(72,Number(store.settings(row.guildId).retentionHours)||24))*3600000;
    return row.status==="review"&&row.filePath&&row.createdAt>=Date.now()-retention&&row.errorKind!=="child_safety"&&!JSON.parse(row.categories||"[]").includes("sexual/minors");
  }
  async function removeCopies(row){
    for(const entry of db.prepare("SELECT * FROM media_moderation_external_reviews WHERE caseId=?").all(row.id))try{
      const channel=await client.channels.fetch(entry.channelId),message=await channel.messages.fetch(entry.messageId);
      if(message.author.id!==client.user.id)continue;
      await message.edit({...notice(row,{available:false}),attachments:[]});
      db.prepare("UPDATE media_moderation_external_reviews SET mediaAttached=0 WHERE caseId=? AND channelId=? AND eventKey=?").run(row.id,entry.channelId,entry.eventKey);
    }catch(error){
      if(error.code===10008||error.code===10003)db.prepare("UPDATE media_moderation_external_reviews SET mediaAttached=0 WHERE caseId=? AND channelId=? AND eventKey=?").run(row.id,entry.channelId,entry.eventKey);
      else console.warn("[Moderação de mídia] Não foi possível remover uma cópia de revisão externa; a limpeza tentará novamente.");
    }
  }
  async function notify(id){
    let key,claimed=false;
    try{
      const row=db.prepare("SELECT * FROM media_moderation_cases WHERE id=?").get(id);if(!row)return;
      if(!eligible(row)){await removeCopies(row);return;}
      const config=store.settings(row.guildId).externalReview;
      if(!config)return;
      if((row.mimeType||row.mediaType||"").startsWith("video/")&&!row.externalReviewRequested)return;
      const eventKey=createHash("sha256").update(JSON.stringify([row.reason,row.reviewerId])).digest("hex");
      key=`${id}:${config.channelId}:${eventKey}`;
      const existing=db.prepare("SELECT * FROM media_moderation_external_reviews WHERE caseId=? AND channelId=? AND eventKey=?").get(id,config.channelId,eventKey);
      if(pending.has(key)||existing?.mediaAttached)return;
      pending.add(key);claimed=true;
      const channel=await client.channels.fetch(config.channelId);validateChannel(channel,config.guildId);
      const maxBytes=Math.min(100,Number(store.settings(row.guildId).maxFileMB)||20)*1024*1024;
      if((await fs.stat(row.filePath)).size>maxBytes)throw new Error("Arquivo de revisão acima do limite");
      const buffer=await fs.readFile(row.filePath),type=await fileTypeFromBuffer(buffer);
      if(!type||!MEDIA_EXT[type.mime])throw new Error("Formato de mídia não verificado; cópia externa suspensa");
      const media={buffer,name:`${row.id}.${MEDIA_EXT[type.mime]}`};
      const currentConfig=store.settings(row.guildId).externalReview;
      if(currentConfig?.channelId!==config.channelId||currentConfig?.guildId!==config.guildId)return;
      if(!eligible(db.prepare("SELECT * FROM media_moderation_cases WHERE id=?").get(id)))return;
      if(existing){
        const message=await channel.messages.fetch(existing.messageId);
        if(message.author.id!==client.user.id)throw new Error("Aviso não pertence ao bot");
        await message.edit({...notice(row,{media}),attachments:[]});
        db.prepare("UPDATE media_moderation_external_reviews SET mediaAttached=1 WHERE caseId=? AND channelId=? AND eventKey=?").run(id,config.channelId,eventKey);
        return;
      }
      const nonce=BigInt(`0x${createHash("sha256").update(key).digest("hex").slice(0,16)}`).toString();
       const sent=await channel.send({...notice(row,{media,roleId:config.roleId}),nonce,enforceNonce:true});registry.preserveMessage(sent);
      db.prepare("INSERT OR IGNORE INTO media_moderation_external_reviews(caseId,channelId,eventKey,messageId,mediaAttached) VALUES(?,?,?,?,1)").run(id,config.channelId,eventKey,sent.id);
      const latest=db.prepare("SELECT * FROM media_moderation_cases WHERE id=?").get(id),latestConfig=store.settings(row.guildId).externalReview;
      if(!eligible(latest)||latestConfig?.channelId!==config.channelId)await removeCopies(latest);
    }catch{console.warn("[Moderação de mídia] Aviso de revisão externa indisponível; o caso permanece na fila de origem.");}
    finally{if(claimed)pending.delete(key);}
  }
  async function cleanup(guildId){
    const rows=db.prepare("SELECT DISTINCT c.* FROM media_moderation_cases c JOIN media_moderation_external_reviews r ON r.caseId=c.id WHERE r.mediaAttached=1").all();
    let cleaned=0;
    for(const row of rows){
      if(guildId&&row.guildId!==guildId)continue;
      const s=store.settings(row.guildId),entries=db.prepare("SELECT channelId FROM media_moderation_external_reviews WHERE caseId=? AND mediaAttached=1").all(row.id);
      const expired=row.createdAt<Date.now()-Math.max(1,Math.min(72,Number(s.retentionHours)||24))*3600000;
      if(!eligible(row)||expired||!s.externalReview||entries.some(e=>e.channelId!==s.externalReview.channelId)){
        await removeCopies(row);if(++cleaned>=50)break;
      }
    }
  }
  async function flush(guildId){
    await cleanup(guildId);
    const rows=guildId?db.prepare("SELECT id FROM media_moderation_cases WHERE guildId=? AND status='review' AND filePath IS NOT NULL AND (mimeType NOT LIKE 'video/%' OR externalReviewRequested=1) ORDER BY createdAt LIMIT 50").all(guildId):
      db.prepare("SELECT id FROM media_moderation_cases WHERE status='review' AND filePath IS NOT NULL AND (mimeType NOT LIKE 'video/%' OR externalReviewRequested=1) ORDER BY createdAt LIMIT 50").all();
    for(const row of rows)await notify(row.id);
  }
  return {configure,canReview,notify,flush,cleanup};
}
module.exports={createCrossReview};
