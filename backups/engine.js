const crypto = require("node:crypto");
const { ChannelType, PermissionFlagsBits } = require("discord.js");

const FORMAT_VERSION = 1;
const MAX_ASSET_BYTES = 8 * 1024 * 1024;
const MAX_BACKUP_BYTES = 40 * 1024 * 1024;
const safeJson = value => JSON.parse(JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item));
const digest = data => crypto.createHash("sha256").update(data).digest("hex");
const permissions = bits => ({ allow: bits.allow.bitfield.toString(), deny: bits.deny.bitfield.toString() });

async function asset(url, failures, label,budget,allowAnyType=false) {
  if (!url) return null;
  let parsed;
  try { parsed = new URL(url); } catch { failures.push(`${label}: URL inválida`);return null; }
  if (parsed.protocol !== "https:" || !["cdn.discordapp.com", "media.discordapp.net"].includes(parsed.hostname)) {
    failures.push(`${label}: origem não permitida`);return null;
  }
  try {
    const response = await fetch(parsed, { signal: AbortSignal.timeout(10_000), redirect: "error" });
    const contentType=response.headers.get("content-type")||"application/octet-stream";
    if (!response.ok || (!allowAnyType&&!contentType.startsWith("image/"))) throw new Error(`HTTP ${response.status}`);
    const advertised=Number(response.headers.get("content-length")||0);
    if(advertised>MAX_ASSET_BYTES)throw new Error("arquivo acima de 8 MB");
    if(budget&&advertised&&budget.used+advertised>budget.max)throw new Error("limite total de recursos do backup atingido");
    const chunks=[];let bytesRead=0;
    if(response.body){const reader=response.body.getReader();while(true){const {done,value}=await reader.read();if(done)break;
      bytesRead+=value.byteLength;
      if(bytesRead>MAX_ASSET_BYTES||(budget&&budget.used+bytesRead>budget.max)){await reader.cancel();throw new Error("limite de tamanho de recursos atingido");}
      chunks.push(Buffer.from(value));}}
    const bytes=Buffer.concat(chunks,bytesRead);
    if(budget)budget.used+=bytes.length;
    return { contentType, sha256: digest(bytes), data: bytes.toString("base64") };
  } catch (error) { failures.push(`${label}: ${error.message}`);return null; }
}

async function capture(guild, { progress = () => {}, includeMembers = false, messageConfig = {}, internalData = null, botConfiguration = null } = {}) {
  const failures = [], warnings = [], startedAt = Date.now();
  const assetBudget={used:0,max:24*1024*1024};
  await guild.roles.fetch();await guild.channels.fetch();
  const emojis = await guild.emojis.fetch().catch(error => { failures.push(`Emojis: ${error.message}`);return new Map(); });
  const stickers = await guild.stickers.fetch().catch(error => { failures.push(`Stickers: ${error.message}`);return new Map(); });
  const roles = [...guild.roles.cache.values()].filter(r => !r.managed && r.id !== guild.id).sort((a,b)=>a.position-b.position);
  const channels = [...guild.channels.cache.values()].sort((a,b)=>(a.rawPosition??0)-(b.rawPosition??0));
  const data = { formatVersion: FORMAT_VERSION, createdAt: startedAt, originGuildId: guild.id, originGuildName: guild.name,
    botVersion: require("../package.json").version, settings: {}, roles: [], channels: [], emojis: [], stickers: [],
    members: [], limitations: [], files: {}, internal:internalData,botConfiguration };
  if(!internalData)data.manifestUnavailableInternal=true;
  const addFile = (name, bytes) => { data.files[name] = { sha256: digest(bytes), data: Buffer.from(bytes).toString("base64") }; };
  const total = Math.max(1, roles.length + channels.length + emojis.size + stickers.size + 3);let done=0,rolesDone=0,channelsDone=0,emojisDone=0;
  const report = stage => progress({ done, total, stage, percent: Math.floor(done*100/total),
    rolesDone,rolesTotal:roles.length,channelsDone,channelsTotal:channels.length,emojisDone,emojisTotal:emojis.size });
  data.settings = {
    name: guild.name, description: guild.description, verificationLevel: guild.verificationLevel,
    explicitContentFilter: guild.explicitContentFilter, defaultMessageNotifications: guild.defaultMessageNotifications,
    afkTimeout: guild.afkTimeout, preferredLocale: guild.preferredLocale, premiumProgressBarEnabled: guild.premiumProgressBarEnabled,
    afkChannelId: guild.afkChannelId, rulesChannelId: guild.rulesChannelId, publicUpdatesChannelId: guild.publicUpdatesChannelId,
    systemChannelId: guild.systemChannelId, systemChannelFlags: guild.systemChannelFlags?.bitfield?.toString?.() ?? null,
    icon: await asset(guild.iconURL({ extension:"png", size:1024 }), failures, "Ícone do servidor",assetBudget),
    banner: await asset(guild.bannerURL({ extension:"png", size:1024 }), failures, "Banner do servidor",assetBudget)
  };
  done++;report("Configurações e recursos visuais");
  for (const role of roles) {
    const roleIcon = role.iconURL({ extension:"png", size:256 });
    data.roles.push({ id:role.id,name:role.name,color:role.color,colors:safeJson(role.colors?.toJSON?.() ?? null),hoist:role.hoist,
      mentionable:role.mentionable,permissions:role.permissions.bitfield.toString(),position:role.position,
      unicodeEmoji:role.unicodeEmoji,icon:await asset(roleIcon,failures,`Ícone do cargo ${role.name}`,assetBudget) });
    rolesDone++;done++;report(`Salvando cargo ${role.name}`);
  }
  const channelTypes = new Set(Object.values(ChannelType).filter(value=>typeof value==="number"));
  for (const channel of channels) {
    if (!channelTypes.has(channel.type) || channel.isThread?.()) { warnings.push(`Canal ${channel.name}: tipo/thread não recriado; threads não têm IDs e participantes recuperáveis.`);channelsDone++;done++;report("Ignorando canal não recriável");continue; }
    const overwrites = [...(channel.permissionOverwrites?.cache?.values?.()||[])].map(o=>({ id:o.id,type:o.type,...permissions(o) }));
    const saved = { id:channel.id,type:channel.type,name:channel.name,parentId:channel.parentId,position:channel.rawPosition??channel.position??0,
      topic:channel.topic??null,nsfw:channel.nsfw??false,rateLimitPerUser:channel.rateLimitPerUser??0,bitrate:channel.bitrate??null,
      userLimit:channel.userLimit??null,rtcRegion:channel.rtcRegion??null,videoQualityMode:channel.videoQualityMode??null,
      defaultAutoArchiveDuration:channel.defaultAutoArchiveDuration??null,defaultThreadRateLimitPerUser:channel.defaultThreadRateLimitPerUser??null,
      defaultSortOrder:channel.defaultSortOrder??null,defaultForumLayout:channel.defaultForumLayout??null,
      availableTags:channel.availableTags?.map(tag=>({name:tag.name,moderated:tag.moderated,emojiId:tag.emojiId,emojiName:tag.emojiName}))??[],
      defaultReactionEmoji:channel.defaultReactionEmoji??null,permissionsSynced:channel.permissionsLocked??false,overwrites };
    data.channels.push(saved);channelsDone++;done++;report(`Salvando permissões de ${channel.name}`);
  }
  for (const emoji of emojis.values()) {
    const image=await asset(emoji.imageURL({extension:emoji.animated?"gif":"png",size:256}),failures,`Emoji ${emoji.name}`,assetBudget);
    data.emojis.push({id:emoji.id,name:emoji.name,animated:emoji.animated,available:emoji.available,roles:[...emoji.roles.cache.keys()],image});emojisDone++;done++;report(`Salvando emoji ${emoji.name}`);
  }
  for (const sticker of stickers.values()) {
    const image=await asset(sticker.url,failures,`Sticker ${sticker.name}`,assetBudget);
    data.stickers.push({id:sticker.id,name:sticker.name,description:sticker.description,tags:sticker.tags,format:sticker.format,available:sticker.available,image});done++;report(`Salvando sticker ${sticker.name}`);
  }
  data.archivedMessages = [];
  const selectedChannels = messageConfig.enabled ? [...new Set(messageConfig.channelIds||[])] : [];
  const messageLimit = Math.max(1,Math.min(5000,Number(messageConfig.limit)||500));
  const cutoff = Date.now() - Math.max(1,Math.min(3650,Number(messageConfig.days)||30))*86400000;
  for(const channelId of selectedChannels){
    const channel=guild.channels.cache.get(channelId);
    if(!channel||channel.isThread?.()||!channel.isTextBased?.()||!channel.messages){warnings.push(`Mensagens ${channelId}: canal inválido, inacessível ou tópico.`);continue;}
    const privateName=/ticket|denuncia|denúncia|staff|mod|log|privad/i.test(channel.name||"");
    if(privateName&&!messageConfig.explicitSelection){warnings.push(`Mensagens ${channel.name}: ignorado por possível conteúdo confidencial.`);continue;}
    const archived={channelId,name:channel.name,messages:[]};let before;
    try{
      while(archived.messages.length<messageLimit){
        const batch=await channel.messages.fetch({limit:Math.min(100,messageLimit-archived.messages.length),...(before?{before}:{})});
        if(!batch.size)break;
        for(const message of batch.values()){
          if(message.createdTimestamp<cutoff)continue;
          const item={id:message.id,authorId:message.author?.id||null,authorTag:message.author?.tag||message.author?.username||"desconhecido",
            createdAt:message.createdAt?.toISOString?.()||null,content:message.content||"",referenceId:message.reference?.messageId||null,attachments:[]};
          if(messageConfig.attachments)for(const attachment of message.attachments.values()){
            const saved=await asset(attachment.url,failures,`Anexo de mensagem ${message.id}`,assetBudget,true);
            if(saved){const filename=String(attachment.name||"anexo").replace(/[^\w. -]/g,"_").slice(0,100);
              item.attachments.push({filename,contentType:saved.contentType,sha256:saved.sha256,data:saved.data});}
          }
          archived.messages.push(item);
        }
        before=batch.last()?.id;if(!before||batch.size<1)break;
        if(batch.last()?.createdTimestamp<cutoff)break;
      }
      data.archivedMessages.push(archived);
    }catch(error){failures.push(`Mensagens ${channel.name}: ${error.message}`);}
  }
  if (includeMembers) {
    warnings.push("Associações de cargos de membros não foram coletadas automaticamente: a paginação pode expor dados pessoais e atingir limites da API. Nenhum membro será adicionado durante restauração.");
  }
  data.limitations.push("IDs originais de cargos/canais não podem ser recriados; o restaurador cria mapeamentos novos.",
    "Mensagens, anexos, histórico de auditoria, convites, webhooks, AutoMod, eventos agendados, integrações e configurações indisponíveis não são capturados/restaurados por este formato.",
    "Canais de voz ativos, fóruns e recursos que a versão/API do Discord não aceite podem ser ignorados ou restaurados parcialmente.",
    "Threads e membros não são restaurados automaticamente.",
    data.archivedMessages.length?"Mensagens arquivadas são cópias de conteúdo, não preservam autoria nativa, IDs, timestamps ou anexos como objetos originais; este restaurador não republica mensagens.":"Mensagens não foram arquivadas.",
    internalData?"Históricos e dados operacionais internos são apenas exportados; não são reaplicados na restauração.":"Históricos internos não incluídos: configure BACKUP_ENCRYPTION_KEY para exportar a seção interna protegida.");
  if(botConfiguration)data.limitations.push("Configurações do bot são reaplicadas com IDs remapeados. Painéis de tickets conhecidos podem ser republicados em canais recriados; threads e históricos não são recriados.");
  const fileInventory={};
  const collectChecksums=(value,pathName="")=>{
    if(!value||typeof value!=="object")return;
    if(typeof value.data==="string"&&/^[a-f0-9]{64}$/i.test(value.sha256||""))fileInventory[pathName||"asset"]=value.sha256;
    else for(const [key,child]of Object.entries(value))collectChecksums(child,pathName?`${pathName}/${key}`:key);
  };
  collectChecksums({settings:data.settings,roles:data.roles,emojis:data.emojis,stickers:data.stickers,messages:data.archivedMessages});
  data.manifest={formatVersion:FORMAT_VERSION,sourceGuild:{id:guild.id,name:guild.name},createdAt:startedAt,botVersion:data.botVersion,
    inventory:{roles:data.roles.length,channels:data.channels.length,emojis:data.emojis.length,stickers:data.stickers.length,
      archivedMessages:data.archivedMessages.reduce((n,c)=>n+c.messages.length,0),messageChannels:data.archivedMessages.length},
    files:fileInventory,failures,warnings,limitations:data.limitations};
  const estimated=Buffer.byteLength(JSON.stringify(data));
  if (estimated>MAX_BACKUP_BYTES) throw new Error(`Backup excede o limite interno de ${Math.round(MAX_BACKUP_BYTES/1024/1024)} MB. Remova recursos ou reduza o escopo.`);
  const { encode } = require("./archive");const bytes=encode(data,process.env.BACKUP_ENCRYPTION_KEY);
  progress({done:total,total,stage:"Validando integridade do pacote",percent:95,rolesDone,rolesTotal:roles.length,
    channelsDone,channelsTotal:channels.length,emojisDone,emojisTotal:emojis.size});
  return { data,bytes,failures,warnings,summary:{...data.manifest.inventory,failures:failures.length,warnings:warnings.length,
    limitations:data.limitations.length,elapsedMs:Date.now()-startedAt,encrypted:Boolean(process.env.BACKUP_ENCRYPTION_KEY)} };
}

function overwriteFor(channel, roleMap, guildId, memberIds) {
  const output=[];
  for (const over of channel.overwrites||[]) {
    let id;
    if (over.type===0) id=roleMap.get(over.id);
    else if (over.type===1&&memberIds.has(over.id)) id=over.id;
    if (!id) continue;
    output.push({id,type:over.type,allow:BigInt(over.allow),deny:BigInt(over.deny)});
  }
  return output;
}
function signatureRole(role) { return JSON.stringify([role.name,role.color,role.colors??null,role.unicodeEmoji??null,role.hoist,role.mentionable,String(role.permissions)]); }

async function previewRestore(guild, data, {allowCrossGuild=false}={}) {
  if(data.formatVersion!==FORMAT_VERSION||!data.originGuildId||data.originGuildId!==guild.id&&!allowCrossGuild) throw new Error("Backup incompatível ou pertencente a outro servidor. Autorize a importação entre servidores antes de continuar.");
  await guild.roles.fetch();await guild.channels.fetch();
  const roles=[],usedRoleIds=new Set();
  for(const role of data.roles){
    const exact=guild.roles.cache.find(r=>!r.managed&&!usedRoleIds.has(r.id)&&signatureRole({name:r.name,color:r.color,
      colors:safeJson(r.colors?.toJSON?.()??null),unicodeEmoji:r.unicodeEmoji,hoist:r.hoist,mentionable:r.mentionable,permissions:r.permissions.bitfield})===signatureRole(role));
    if(exact)usedRoleIds.add(exact.id);
    roles.push({id:role.id,name:role.name,action:exact?"mapear existente":"criar"});
  }
  const channels=[],usedChannelIds=new Set(),channelMap=new Map();
  const orderedChannels=[...data.channels].sort((a,b)=>Number(a.type===ChannelType.GuildCategory?0:1)-Number(b.type===ChannelType.GuildCategory?0:1)||a.position-b.position);
  for(const ch of orderedChannels){
    const parentId=ch.parentId?channelMap.get(ch.parentId):null;
    const exact=guild.channels.cache.find(c=>!usedChannelIds.has(c.id)&&!c.isThread?.()&&c.name===ch.name&&c.type===ch.type&&
      (!ch.parentId||c.parentId===parentId));
    if(exact){usedChannelIds.add(exact.id);channelMap.set(ch.id,exact.id);}
    channels.push({id:ch.id,name:ch.name,type:ch.type,action:exact?"mapear existente":"criar"});
  }
  return {roles,channels,crossGuild:data.originGuildId!==guild.id,originGuildId:data.originGuildId,targetGuildId:guild.id,limitations:data.limitations||[],warnings:data.manifest?.warnings||[],failures:data.manifest?.failures||[]};
}

async function restore(guild, data, { progress=()=>{},allowCrossGuild=false }={}) {
  const preview=await previewRestore(guild,data,{allowCrossGuild}),errors=[],created={roles:0,channels:0,emojis:0,stickers:0};
  const roleMap=new Map([[data.originGuildId,guild.id]]),channelMap=new Map(),createdChannelIds=[];
  const roleTargets=[];
  const roleCache=new Map();for(const r of guild.roles.cache.values()){
    if(r.managed)continue;const key=signatureRole({name:r.name,color:r.color,colors:safeJson(r.colors?.toJSON?.()??null),unicodeEmoji:r.unicodeEmoji,
      hoist:r.hoist,mentionable:r.mentionable,permissions:r.permissions.bitfield});
    if(!roleCache.has(key))roleCache.set(key,[]);roleCache.get(key).push(r);
  }
  const usedRoleIds=new Set();
  const orderedRoles=[...data.roles].sort((a,b)=>a.position-b.position);
  for(let n=0;n<orderedRoles.length;n++){
    const role=orderedRoles[n];try{
      const key=signatureRole(role),existing=(roleCache.get(key)||[]).find(item=>!usedRoleIds.has(item.id));
      const createdRole=existing||await guild.roles.create({name:role.name,colors:{primaryColor:role.colors?.primaryColor??role.color??0},hoist:role.hoist,mentionable:role.mentionable,
        permissions:BigInt(role.permissions),unicodeEmoji:role.unicodeEmoji||undefined,
        ...(role.icon?.data?{icon:Buffer.from(role.icon.data,"base64")}:{}),reason:"Restauração de backup mds"});
      if(role.colors&&[role.colors.secondaryColor,role.colors.tertiaryColor].some(value=>value!=null&&value!==0))errors.push(`Cargo ${role.name}: gradiente/cor avançada foi preservado no arquivo, mas não recriado pela API utilizada.`);
      if(!existing)created.roles++;usedRoleIds.add(createdRole.id);roleMap.set(role.id,createdRole.id);
      roleTargets.push({role:createdRole,position:role.position,name:role.name,created:!existing});
      progress({stage:`Cargo ${role.name}`,done:n+1,total:orderedRoles.length+data.channels.length,percent:Math.floor((n+1)*100/Math.max(1,orderedRoles.length+data.channels.length))});
    }catch(e){errors.push(`Cargo ${role.name}: ${e.message}`);}
  }
  // Reordena somente os cargos que acabaram de ser criados, mantendo-os abaixo
  // do cargo mais alto do bot. A API pode ajustar posições conflitantes.
  for(const target of roleTargets.filter(item=>item.created)){
    try{const ceiling=Math.max(1,guild.members.me?.roles?.highest?.position||1);
      await target.role.setPosition(Math.min(Math.max(1,target.position),ceiling-1));}
    catch(e){errors.push(`Posição do cargo ${target.name}: ${e.message}`);}
  }
  const channels=[...data.channels].sort((a,b)=>Number(a.type===ChannelType.GuildCategory?0:1)-Number(b.type===ChannelType.GuildCategory?0:1)||a.position-b.position);
  const crossGuild=data.originGuildId!==guild.id;
  const referencedMembers=crossGuild?[]:[...new Set(channels.flatMap(ch=>(ch.overwrites||[]).filter(o=>o.type===1).map(o=>o.id)))];
  const memberIds=new Set(crossGuild?[]:guild.members.cache.keys());
  for(const id of referencedMembers.slice(0,100)){
    if(memberIds.has(id))continue;
    const member=await guild.members.fetch(id).catch(()=>null);
    if(member)memberIds.add(id);
  }
  if(referencedMembers.length>100)errors.push(`Foram ignoradas ${referencedMembers.length-100} substituições de membros para respeitar o limite seguro de validação.`);
  const pending=channels.filter(c=>c.type===ChannelType.GuildCategory);
  pending.push(...channels.filter(c=>c.type!==ChannelType.GuildCategory));
  const usedChannelIds=new Set();
  for(let n=0;n<pending.length;n++){
    const ch=pending[n];try{
      const exact=guild.channels.cache.find(c=>!usedChannelIds.has(c.id)&&!c.isThread?.()&&c.name===ch.name&&c.type===ch.type&&(!ch.parentId||c.parentId===channelMap.get(ch.parentId)));
      const type=ch.type;
      const options={name:ch.name,type,topic:ch.topic??undefined,nsfw:ch.nsfw,rateLimitPerUser:ch.rateLimitPerUser,
        bitrate:ch.bitrate??undefined,userLimit:ch.userLimit??undefined,rtcRegion:ch.rtcRegion??undefined,
        videoQualityMode:ch.videoQualityMode??undefined,parent:ch.parentId?channelMap.get(ch.parentId):undefined,
        permissionOverwrites:overwriteFor(ch,roleMap,guild.id,memberIds),reason:"Restauração não destrutiva de backup mds"};
      if(ch.availableTags?.length)options.availableTags=ch.availableTags.map(t=>({...t,emojiId:null}));
      const target=exact||await guild.channels.create(options);
      if(!exact){created.channels++;createdChannelIds.push(target.id);}usedChannelIds.add(target.id);channelMap.set(ch.id,target.id);
      if(ch.position!==undefined&&target.setPosition)await target.setPosition(ch.position).catch(e=>errors.push(`Posição ${ch.name}: ${e.message}`));
      progress({stage:`Canal ${ch.name}`,done:orderedRoles.length+n+1,total:Math.max(1,orderedRoles.length+pending.length),percent:Math.floor((orderedRoles.length+n+1)*100/Math.max(1,orderedRoles.length+pending.length))});
    }catch(e){errors.push(`Canal ${ch.name}: ${e.message}`);}
  }
  for(const emoji of data.emojis||[]){
    try{if(!emoji.image)throw new Error("Imagem não disponível no backup");
      if(guild.emojis.cache.some(e=>e.name===emoji.name))continue;
      await guild.emojis.create({attachment:Buffer.from(emoji.image.data,"base64"),name:emoji.name,roles:(emoji.roles||[]).map(id=>roleMap.get(id)).filter(Boolean)});created.emojis++;
    }catch(e){errors.push(`Emoji ${emoji.name}: ${e.message}`);}
  }
  for(const sticker of data.stickers||[]){
    try{if(!sticker.image)throw new Error("Imagem não disponível no backup");
      if(guild.stickers.cache.some(s=>s.name===sticker.name))continue;
      await guild.stickers.create({file:Buffer.from(sticker.image.data,"base64"),name:sticker.name,tags:sticker.tags,description:sticker.description||undefined});created.stickers++;
    }catch(e){errors.push(`Sticker ${sticker.name}: ${e.message}`);}
  }
  return {created,createdChannelIds,errors,preview,roleMap:Object.fromEntries(roleMap),channelMap:Object.fromEntries(channelMap),limitations:data.limitations||[]};
}

module.exports={capture,previewRestore,restore,FORMAT_VERSION,MAX_BACKUP_BYTES};
