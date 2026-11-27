const crypto=require("node:crypto");
const fs=require("node:fs");
const path=require("node:path");
const {
  AttachmentBuilder,ContainerBuilder,TextDisplayBuilder,SeparatorBuilder,SeparatorSpacingSize,SectionBuilder,
  ActionRowBuilder,ButtonBuilder,ButtonStyle,StringSelectMenuBuilder,ChannelType,
  MessageFlags,PermissionFlagsBits
}=require("discord.js");
  const {BackupStore}=require("./store");
const {encode,decode}=require("./archive");
const engine=require("./engine");
const {serverName}=require("../brand");
const {errorText,statusText,safeMessage}=require("../error-ui");
const painelEmojis=require("../lumiya-ui/emojis");

module.exports=function installBackups({client,registry,db,botData,dataFile,restorePanels}){
  const botConfig=require("./bot-config")({db,botData,dataFile});
  const store=new BackupStore(db,process.env.BACKUP_DIRECTORY||path.join(__dirname,"..","backups","files"));
  const sessions=new Map(),running=new Set(),locks=new Set();
  const ADMIN_IDS=new Set((process.env.BACKUP_ADMIN_IDS||"").split(",").map(x=>x.trim()).filter(Boolean));
  const authorizeMember=member=>Boolean(member&&(member.guild?.ownerId===member.id||ADMIN_IDS.has(member.id)||member.permissions?.has(PermissionFlagsBits.Administrator)));
  const nowText=ts=>ts?`<t:${Math.floor(ts/1000)}:R>`:"Nunca";
  const sizeText=n=>n<1024?`${n} B`:n<1048576?`${(n/1024).toFixed(1)} KB`:`${(n/1048576).toFixed(2)} MB`;
  const parseSummary=row=>{try{return JSON.parse(row.summary);}catch{return {};}};
  const text=s=>new TextDisplayBuilder().setContent(statusText(s));
  const sep=()=>new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small);
  const button=(s,action,label,style=ButtonStyle.Secondary,emoji=null)=>{const b=new ButtonBuilder().setCustomId(`bk:${action}:${s.id}`).setLabel(label).setStyle(style);if(emoji)b.setEmoji(emoji);return b;};
  const row=(...items)=>new ActionRowBuilder().addComponents(...items);
  const box=(s,body,color=0)=>new ContainerBuilder().setAccentColor(color).addTextDisplayComponents(text(body));
  const payload=(container,ephemeral=false,files)=>require("../lumiya-ui/canonical").canonical({components:[container],flags:MessageFlags.IsComponentsV2|(ephemeral?MessageFlags.Ephemeral:0),allowedMentions:{parse:[]},...(files?{files}:{})});
  function newSession(guildId,userId,view,values={}){
    const s={id:crypto.randomUUID(),guildId,userId,view,page:0,selected:null,createdAt:Date.now(),...values};sessions.set(s.id,s);store.saveSession(s);return s;
  }
  function save(s){sessions.set(s.id,s);store.saveSession(s);}
  function get(id){return sessions.get(id)||store.getSession(id);}
  async function authorize(guildId,userId){
    const guild=client.guilds.cache.get(guildId)||await client.guilds.fetch(guildId).catch(()=>null);
    if(!guild)return null;
    const member=await guild.members.fetch(userId).catch(()=>null);
    const authorized=Boolean(member&&(guild.ownerId===userId||ADMIN_IDS.has(userId)||member.permissions.has(PermissionFlagsBits.Administrator)));
    return authorized?{guild,member}:null;
  }
  async function getSessionContext(i){
    const s=get(i.customId.split(":").at(-1));
    if(!s||s.expiresAt&&s.expiresAt<Date.now()||s.userId!==i.user.id)return null;
    const auth=await authorize(s.guildId,i.user.id);return auth?{s,...auth}:null;
  }
  function home(guild,s){
    const settings=store.settings(guild.id),backups=store.list(guild.id,1000),last=backups[0];
    const c=box(s,`# Gerenciamento de Backups\n**| ${serverName(guild)}**\n-# Proteja a estrutura e as configurações do seu servidor.\n\n`+
      `Mantenha cópias de segurança do servidor e restaure configurações quando necessário.\n\n**Informações do servidor**\n`+
      `**Servidor:** ${guild.name}\n**Último backup:** ${last?nowText(last.createdAt):"Nunca"}\n**Backups armazenados:** ${backups.length}\n`+
      `**Backup automático:** ${settings.automatic?"Ativado":"Desativado"}\n**Próximo backup:** ${settings.automatic?nowText(settings.nextAt):"Não programado"}`)
      .addSeparatorComponents(sep()).addSectionComponents(new SectionBuilder().addTextDisplayComponents(text("**Gerenciamento**\nInicie uma cópia estrutural do servidor."))
        .setButtonAccessory(button(s,"create","Criar Backup",ButtonStyle.Primary)))
      .addActionRowComponents(row(button(s,"list","Meus Backups")))
      .addActionRowComponents(row(button(s,"listrestore","Restaurar Backup"),button(s,"settings","Configurações")))
      .addActionRowComponents(row(button(s,"autotoggle","Backup Automático"),button(s,"download","Baixar Backup")));
    return c;
  }
  function createPanel(guild,s){return box(s,`# Criar Backup\n**Servidor:** ${guild.name}\n**Tipo:** Estrutural completo\n**Status:** Pronto para iniciar\n\n**Itens coletados:**\n• Cargos e permissões\n• Canais e categorias\n• Emojis e stickers acessíveis\n• Configurações básicas disponíveis\n${process.env.BACKUP_ENCRYPTION_KEY?"• Dados internos do bot filtrados por servidor (seção protegida)":""}\n\n`+
    `${process.env.BACKUP_ENCRYPTION_KEY?"-# Arquivo criptografado com AES-256-GCM.":"⚠️ BACKUP_ENCRYPTION_KEY não configurada: o arquivo será apenas comprimido, sem criptografia."}\n-# Mensagens, integrações e recursos não expostos pela API não serão anunciados como restauráveis.`)
    .addSeparatorComponents(sep()).addActionRowComponents(row(button(s,"start","Iniciar Backup",ButtonStyle.Primary),button(s,"cancel","Cancelar",ButtonStyle.Danger)));}
  function progressPanel(guild,progress,start){
    const pct=Math.max(0,Math.min(100,progress.percent||0)),bar="█".repeat(Math.round(pct/10))+"░".repeat(10-Math.round(pct/10));
    return box(null,`# Criando Backup\n**Servidor:** ${guild.name}\n**Progresso:** ${pct}%\n\`${bar} ${pct}%\`\n\n`+
      `**Etapa atual:** ${String(progress.stage||"Preparando").slice(0,150)}\n**Cargos:** ${progress.rolesDone??0}/${progress.rolesTotal??0}\n**Canais:** ${progress.channelsDone??0}/${progress.channelsTotal??0}\n**Emojis:** ${progress.emojisDone??0}/${progress.emojisTotal??0}\n`+
      `**Tempo decorrido:** ${((Date.now()-start)/1000).toFixed(0)} s`);
  }
  function backupsPanel(guild,s){
    const backups=store.list(guild.id,200),page=Math.max(0,Math.min(s.page,Math.ceil(backups.length/8)-1));s.page=page;
    const list=backups.slice(page*8,page*8+8);
    const c=box(s,`# Backups Salvos\n**| ${serverName(guild)}**\n\n${list.length?list.map((b,n)=>{
      const summary=parseSummary(b),numb=String(page*8+n+1).padStart(3,"0");
      return `**Backup #${numb} · ${b.id.slice(0,8)}**\nCriado: ${nowText(b.createdAt)} · Tipo: Estrutural · Tamanho: ${sizeText(b.size)} · ${summary.failures?"Parcial":"Disponível"}`;
    }).join("\n\n"):"Nenhum backup armazenado."}`)
      .addSeparatorComponents(sep());
    if(list.length)c.addActionRowComponents(row(new StringSelectMenuBuilder().setCustomId(`bk:select:${s.id}`).setPlaceholder("Selecione um backup")
      .setMinValues(1).setMaxValues(1).addOptions(list.map((b,n)=>({label:`#${String(page*8+n+1).padStart(3,"0")} · ${b.id.slice(0,8)}`.slice(0,100),
        description:`${new Date(b.createdAt).toLocaleString("pt-BR")} · ${sizeText(b.size)}`.slice(0,100),value:b.id,default:s.selected===b.id})))));
    c.addActionRowComponents(row(button(s,"details","Detalhes"),button(s,"restoreselected","Restaurar"),button(s,"downloadselected","Baixar",ButtonStyle.Primary)));
    c.addActionRowComponents(row(button(s,"prev","< Anterior").setDisabled(page<=0),button(s,"pageinfo",`${page+1}/${Math.max(1,Math.ceil(backups.length/8))}`).setDisabled(true),
      button(s,"next","> Próxima").setDisabled((page+1)*8>=backups.length),button(s,"home","Painel")));
    return c;
  }
  function settingsPanel(guild,s){
    const st=store.settings(guild.id),mc=JSON.parse(st.messageConfig||"{}");
    return box(s,`# Configurações de Backup\n\n**Backup automático:** ${st.automatic?"Ativado":"Desativado"}\n**Frequência:** ${st.intervalHours===168?"Semanal":`A cada ${st.intervalHours} horas`}\n`+
      `**Backups armazenados:** ${store.list(guild.id,1000).length}\n**Limite de retenção:** ${st.retention}\n**Arquivar mensagens:** ${mc.enabled?"Ativado":"Desativado"}\n`+
      `**Canais de mensagens selecionados:** ${(mc.channelIds||[]).length}\n**Canal de logs:** ${st.notifyChannel?`<#${st.notifyChannel}>`:"Não configurado"}\n\n`+
      "-# Arquivo de mensagens é opcional; apenas canais selecionados explicitamente serão lidos.")
      .addActionRowComponents(row(button(s,"frequency","Alterar Frequência"),button(s,"retention","Retenção")))
      .addActionRowComponents(row(button(s,"msgsettings","Configurar Conteúdo"),button(s,"logchannel","Canal de Logs")))
      .addActionRowComponents(row(button(s,"messagesToggle",mc.enabled?"Desativar arquivo de mensagens":"Ativar arquivo de mensagens",mc.enabled?ButtonStyle.Danger:ButtonStyle.Secondary,painelEmojis.toggleEmoji(mc.enabled)),
        button(s,"autotoggle",st.automatic?"Desativar automático":"Ativar automático",ButtonStyle.Secondary,painelEmojis.toggleEmoji(st.automatic)),button(s,"home","Voltar")));
  }
  function messageSettings(guild,s){
    const st=store.settings(guild.id),mc=JSON.parse(st.messageConfig||"{}");
    const available=[...guild.channels.cache.values()].filter(ch=>[ChannelType.GuildText,ChannelType.GuildAnnouncement].includes(ch.type))
      .sort((a,b)=>a.rawPosition-b.rawPosition),pages=Math.max(1,Math.ceil(available.length/25));
    s.channelPage=Math.max(0,Math.min(s.channelPage||0,pages-1));
    const page=available.slice(s.channelPage*25,s.channelPage*25+25);
    const c=box(s,`# Arquivo Opcional de Mensagens\n\n**Status:** ${mc.enabled?"Ativado":"Desativado"}\n**Canais selecionados:** ${(mc.channelIds||[]).length}\n**Período:** ${mc.days||30} dias\n**Limite:** ${mc.limit||500} mensagens/canal\n**Anexos:** ${mc.attachments?"Incluídos":"Excluídos"}\n\n`+
      "Selecione canais explicitamente. O conteúdo será arquivado, não restaurado como mensagens originais; threads e anexos inacessíveis serão omitidos.");
    if(page.length)c.addActionRowComponents(row(new StringSelectMenuBuilder().setCustomId(`bk:msgchannels:${s.id}`).setMinValues(0).setMaxValues(Math.min(10,page.length))
      .setPlaceholder(`Canais a arquivar · grupo ${s.channelPage+1}/${pages}`).addOptions(page.map(ch=>({label:`# ${ch.name}`.slice(0,100),value:ch.id,
        default:(mc.channelIds||[]).includes(ch.id)})))));
    else c.addTextDisplayComponents(text("Nenhum canal de texto compatível foi encontrado."));
    if(pages>1)c.addActionRowComponents(row(button(s,"msgchannelspageprev","Canais <").setDisabled(s.channelPage===0),
        button(s,"msgchannelspageinfo",`${s.channelPage+1}/${pages}`).setDisabled(true),
        button(s,"msgchannelspagenext","Canais >").setDisabled(s.channelPage>=pages-1)));
    c.addActionRowComponents(row(button(s,"msgdays","Período"),button(s,"msglimit","Limite"),button(s,"msgattach",mc.attachments?"Sem anexos":"Incluir anexos")))
      .addActionRowComponents(row(button(s,"settings","Voltar")));
    return c;
  }
  function logChannelPanel(guild,s){
    const channels=[...guild.channels.cache.values()].filter(ch=>ch.type===ChannelType.GuildText&&
      ch.permissionsFor?.(guild.roles.everyone)&&!ch.permissionsFor(guild.roles.everyone).has(PermissionFlagsBits.ViewChannel));
    const options=channels.slice(0,25).map(ch=>({label:`# ${ch.name}`.slice(0,100),value:ch.id,default:store.settings(guild.id).notifyChannel===ch.id}));
    const c=box(s,`# Canal de Logs\nSelecione um canal privado ao qual apenas a equipe administrativa tenha acesso.\n\n`+
      `${channels.length>25?"-# Exibindo até 25 canais privados disponíveis.":""}`);
    if(options.length)c.addActionRowComponents(row(new StringSelectMenuBuilder().setCustomId(`bk:logselect:${s.id}`).setPlaceholder("Canal privado de notificações")
      .setMinValues(0).setMaxValues(1).addOptions(options)));
    else c.addTextDisplayComponents(text("Nenhum canal privado de texto foi encontrado."));
    return c.addActionRowComponents(row(button(s,"settings","Voltar")));
  }
  function restorePanel(guild,s,preview,notice=""){
    const rowAction=(items)=>items.addActionRowComponents(row(button(s,"restoreconfirm","Criar backup de segurança e confirmar",ButtonStyle.Danger),button(s,"cancel","Cancelar")));
    const roles=preview.roles,channels=preview.channels;
    let c=box(s,`# Prévia de Restauração\n**Backup:** \`${s.backupId}\`\n**Servidor de origem:** ${s.originName}\n**Destino:** ${guild.name} (\`${guild.id}\`)\n${preview.crossGuild?"**Importação entre servidores:** somente estrutura e configurações compatíveis; sem acessos pessoais da origem.\n":""}**Criado:** ${new Date(s.backupCreatedAt).toLocaleString("pt-BR")}\n\n`+
      `**Cargos:** ${roles.filter(x=>x.action==="criar").length} criar · ${roles.filter(x=>x.action!=="criar").length} mapear\n`+
      `**Canais/categorias:** ${channels.filter(x=>x.action==="criar").length} criar · ${channels.filter(x=>x.action!=="criar").length} mapear\n`+
      `**O que será atualizado:** configurações internas do bot com os novos IDs de canais e cargos; painéis conhecidos nos canais recriados. Backups antigos sem snapshot de configuração usam as configurações disponíveis atualmente.\n**Não restaurado:** configurações globais do servidor, membros, mensagens nativas, threads, históricos, integrações e itens listados abaixo.\n\n`+
      `**Limitações:** ${(preview.limitations||[]).slice(0,5).join("; ").slice(0,900)||"Nenhuma registrada."}\n`+
      `**Falhas no backup:** ${(preview.failures||[]).length}\n\n${notice?`⚠️ ${notice}\n\n`:""}⚠️ A confirmação cria um backup de segurança do estado atual e depois cria somente os itens ausentes. Nenhum canal/cargo existente será apagado ou editado.` ,0)
      .addSeparatorComponents(sep()).addTextDisplayComponents(text("Confirme apenas se reconhece a origem e revisou a prévia."));
    return rowAction(c);
  }
  async function dmPanel(message,s,container){
    try{await message.author.send(payload(container));await message.react("📩").catch(()=>{});}
      catch{await message.reply(errorText("Não consegui enviar o painel por mensagem privada. Ative suas DMs para receber backups sem expor os arquivos no servidor.")).catch(()=>{});}
  }
  async function loadBackup(guild,rowDb,{allowCrossGuild=false}={}){
    const file=store.resolveFile(rowDb),bytes=fs.readFileSync(file),hash=crypto.createHash("sha256").update(bytes).digest("hex");
    if(hash!==rowDb.sha256)throw new Error("Checksum do arquivo não confere; restauração/download bloqueado.");
    const data=decode(bytes,process.env.BACKUP_ENCRYPTION_KEY);
    const verifyAssets=value=>{
      if(!value||typeof value!=="object")return;
      if(typeof value.data==="string"&&/^[a-f0-9]{64}$/i.test(value.sha256||"")){
        const actual=crypto.createHash("sha256").update(Buffer.from(value.data,"base64")).digest("hex");
        if(actual!==value.sha256)throw new Error("Checksum de recurso interno não confere.");
      }else for(const child of Object.values(value))verifyAssets(child);
    };
    verifyAssets(data);
    if(data.originGuildId!==rowDb.guildId)throw new Error("Origem do arquivo não confere com o registro do backup.");
    if(data.originGuildId!==guild.id&&!allowCrossGuild)throw new Error("Backup de outro servidor não autorizado.");
    return {bytes,data};
  }
  async function loadForRestore(guild,id,userId){
    const rowDb=store.findById(id);
    if(!rowDb)throw new Error("Backup não encontrado ou sem autorização.");
    if(rowDb.guildId!==guild.id&&rowDb.createdBy!==userId&&!await authorize(rowDb.guildId,userId))
      throw new Error("Você precisa ser o criador do backup ou ter autorização administrativa na origem.");
    const loaded=await loadBackup(guild,rowDb,{allowCrossGuild:true});
    return {...loaded,rowDb};
  }
  async function createBackup(guild,userId,{automatic=false,progress=()=>{},lockHeld=false}={}){
    if(!lockHeld&&locks.has(guild.id))throw new Error("Já existe uma operação de backup/restauração neste servidor.");
    if(!lockHeld)locks.add(guild.id);
    try{
      const settings=store.settings(guild.id),msgConfig=JSON.parse(settings.messageConfig||"{}");
      const internalData=process.env.BACKUP_ENCRYPTION_KEY?captureInternal(guild.id):null;
      const result=await engine.capture(guild,{progress,messageConfig:msgConfig,internalData,botConfiguration:botConfig.capture(guild.id)});
      const checksum=crypto.createHash("sha256").update(result.bytes).digest("hex"),createdAt=Date.now();
      const rowDb=store.insertBackup({guildId:guild.id,createdAt,size:result.bytes.length,sha256:checksum,summary:result.summary,createdBy:userId||"automatic"},result.bytes);
      const deleted=store.retain(guild.id);
      progress({done:1,total:1,stage:"Arquivo validado, salvo e registrado",percent:100,
        rolesDone:result.data.manifest.inventory.roles,rolesTotal:result.data.manifest.inventory.roles,
        channelsDone:result.data.manifest.inventory.channels,channelsTotal:result.data.manifest.inventory.channels,
        emojisDone:result.data.manifest.inventory.emojis,emojisTotal:result.data.manifest.inventory.emojis});
      return {row:rowDb,result,deleted};
    }finally{if(!lockHeld)locks.delete(guild.id);}
  }
  function listPage(guildId,s){return backupsPanel(client.guilds.cache.get(guildId),s);}
  async function sendDownload(i,guild,rowDb){
    const {bytes}=await loadBackup(guild,rowDb);
    const attachment=new AttachmentBuilder(bytes,{name:`mds-backup-${rowDb.id.slice(0,8)}.mdsbak`,description:`Backup do servidor ${serverName(guild)}; pode conter informações privadas.`});
    const c=box(null,`# Download de Backup\n**ID:** \`${rowDb.id}\`\n**Tamanho:** ${sizeText(bytes.length)}\n**Privacidade:** visível somente nesta conversa administrativa.`);
    const p=payload(c,true,[attachment]);
    if(i.deferred||i.replied)return i.followUp(p);return i.reply(p);
  }
  async function notify(guild,settings,content){
    if(!settings.notifyChannel)return;
    const ch=await client.channels.fetch(settings.notifyChannel).catch(()=>null);
    const everyone=ch?.permissionsFor?.(guild.roles.everyone);
    if(ch?.guildId===guild.id&&ch.isTextBased()&&everyone&&!everyone.has(PermissionFlagsBits.ViewChannel))
      await ch.send(require("../lumiya-ui/logs").card({
        category:"backups",title:"Relatório de Backup",subtitle:"Rotina de backup do servidor",
        details:[statusText(content)],source:"Backups",
        metadata:[["Servidor",guild.id]],botAvatarURL:client.user?.displayAvatarURL?.({size:128})
      })).catch(e=>console.warn("[Backups] Falha no canal de logs:",e.message));
    else console.warn(`[Backups] Canal de logs ${settings.notifyChannel} não é privado ou não está disponível; relatório não enviado.`);
  }
  function audit(guildId,userId,action,detail){
    store.audit(guildId,userId,action,detail);
    console.info(`[BACKUP-AUDIT] ${JSON.stringify({guildId,userId,action,detail,at:new Date().toISOString()})}`);
  }

  function captureInternal(guildId){
    const tables=["totals","weeks","active","voice_segments","up_config","up_levels","up_members","up_operations","up_unlocks",
      "command_center_panels","server_backup_settings","server_backup_audit","server_backups"];
    const internal={formatVersion:1,createdAt:Date.now(),sqlite:{},roleHistory:[],botData:{tickets:{},claims:{},pendingCloses:{},rolePanels:{}}};
    const available=new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row=>row.name));
    db.exec("BEGIN DEFERRED");
    try{
      for(const table of tables){
        if(!available.has(table))continue;
        const columns=db.prepare(`PRAGMA table_info(${table})`).all().map(row=>row.name);
        if(!columns.includes("guildId"))continue;
        internal.sqlite[table]=db.prepare(`SELECT * FROM ${table} WHERE guildId=?`).all(guildId);
      }
      db.exec("COMMIT");
    }catch(error){try{db.exec("ROLLBACK");}catch{}throw error;}
    const root=path.join(__dirname,"..");
    const historyPath=process.env.ROLE_HISTORY_FILE||path.join(root,"role-history.json");
    try{const history=JSON.parse(fs.readFileSync(historyPath,"utf8"));internal.roleHistory=(history.records||[]).filter(row=>row.guildId===guildId);}
    catch(error){if(error.code!=="ENOENT")throw new Error(`Não foi possível criar snapshot do histórico de cargos: ${error.message}`);}
    const dataPath=process.env.DATA_FILE||path.join(root,"data.json");
    try{
      const source=JSON.parse(fs.readFileSync(dataPath,"utf8"));
      for(const [id,ticket]of Object.entries(source.tickets||{}))if(ticket.guildId===guildId)internal.botData.tickets[id]=ticket;
      const allowedIds=new Set(Object.keys(internal.botData.tickets));
      for(const key of ["claims","pendingCloses"])for(const [id,value]of Object.entries(source[key]||{}))if(allowedIds.has(id))internal.botData[key][id]=value;
      for(const [id,panel]of Object.entries(source.rolePanels||{}))if(panel.guildId===guildId)internal.botData.rolePanels[id]=panel;
    }catch(error){if(error.code!=="ENOENT")throw new Error(`Não foi possível criar snapshot dos dados administrativos: ${error.message}`);}
    return internal;
  }

  registry.register({name:"backuppainel",description:"Abre o painel administrativo e as configurações de backup do servidor.",category:"Administração",public:true,
    permissions:["ManageGuild"],permissionLabel:"Proprietário, Administrador ou ID autorizado",authorize:authorizeMember,
    result:"Envia por DM um painel privado para criar, listar, baixar e preparar restaurações. Proprietário e administradores do servidor podem usar.",examples:["!backuppainel"],
    prefix:{trigger:"!backuppainel",exact:true,execute:async m=>{
      const auth=await authorize(m.guild.id,m.author.id);if(!auth)return registry.deny(m);
      const s=newSession(m.guild.id,m.author.id,"home");await dmPanel(m,s,home(m.guild,s));
    }}});
  registry.register({name:"backup",description:"Inicia um backup estrutural do servidor com progresso e validação.",category:"Administração",public:true,
    permissions:["ManageGuild"],permissionLabel:"Proprietário, Administrador ou ID autorizado",authorize:authorizeMember,
    result:"Abre por DM um fluxo para confirmar e executar backup estrutural; o arquivo é armazenado privadamente no servidor do bot.",examples:["!backup"],
    prefix:{trigger:"!backup",exact:true,execute:async m=>{
      const auth=await authorize(m.guild.id,m.author.id);if(!auth)return registry.deny(m);
      const s=newSession(m.guild.id,m.author.id,"create");await dmPanel(m,s,createPanel(m.guild,s));audit(m.guild.id,m.author.id,"request-create",{});
    }}});
  registry.register({name:"backups",description:"Lista, baixa e permite preparar a restauração de backups salvos.",category:"Administração",public:true,
    permissions:["ManageGuild"],permissionLabel:"Proprietário, Administrador ou ID autorizado",authorize:authorizeMember,
    result:"Abre por DM uma lista privada paginada. Apenas o proprietário ou administradores autorizados acessam arquivos.",examples:["!backups"],
    prefix:{trigger:"!backups",exact:true,execute:async m=>{
      const auth=await authorize(m.guild.id,m.author.id);if(!auth)return registry.deny(m);
      const s=newSession(m.guild.id,m.author.id,"list");await dmPanel(m,s,backupsPanel(m.guild,s));
    }}});
  registry.register({name:"restaurar",description:"Gera uma prévia e solicita confirmação antes de uma restauração não destrutiva.",category:"Administração",public:true,
    permissions:["ManageGuild"],permissionLabel:"Proprietário, Administrador ou ID autorizado",authorize:authorizeMember,
    result:"Uso: !restaurar ID. Restaura apenas itens ausentes após validar origem, arquivo e backup de segurança.",examples:["!restaurar UUID"],
    prefix:{trigger:"!restaurar",usage:["!restaurar ID_DO_BACKUP"],execute:async m=>{
      const auth=await authorize(m.guild.id,m.author.id);if(!auth)return registry.deny(m);
       const id=m.content.trim().split(/\s+/)[1];
       if(!id)return m.reply("Uso: !restaurar ID_DO_BACKUP no servidor de destino.").catch(()=>{});
       try{const {data,rowDb}=await loadForRestore(m.guild,id,m.author.id),preview=await engine.previewRestore(m.guild,data,{allowCrossGuild:true});
        const s=newSession(m.guild.id,m.author.id,"restore",{backupId:id,backupCreatedAt:rowDb.createdAt,originName:data.originGuildName,preview});
        await dmPanel(m,s,restorePanel(m.guild,s,preview));audit(m.guild.id,m.author.id,"request-restore",{backupId:id});
      }catch(e){await m.reply(`Restauração bloqueada: ${e.message}`).catch(()=>{});}
    }}});

  client.on("interactionCreate",async i=>{
    if(!i.customId?.startsWith("bk:"))return;
    const [,action,sessionId]=i.customId.split(":");let ctx;
    try{
      ctx=await getSessionContext(i);
      if(!ctx){if(i.isRepliable())await i.reply({components:[box(null,"# Acesso negado\nEsta interface expirou ou não pertence a você.",0)],flags:MessageFlags.IsComponentsV2|MessageFlags.Ephemeral,allowedMentions:{parse:[]}}).catch(()=>{});return;}
      const {s,guild}=ctx;
      if(action==="select"){s.selected=i.values[0];save(s);await i.update(payload(backupsPanel(guild,s)));return;}
      if(action==="msgchannels"){
        const settings=store.settings(guild.id),mc=JSON.parse(settings.messageConfig||"{}");
        const available=[...guild.channels.cache.values()].filter(ch=>[ChannelType.GuildText,ChannelType.GuildAnnouncement].includes(ch.type)).sort((a,b)=>a.rawPosition-b.rawPosition);
        const page=available.slice((s.channelPage||0)*25,(s.channelPage||0)*25+25).map(ch=>ch.id);
        mc.channelIds=[...new Set([...(mc.channelIds||[]).filter(id=>!page.includes(id)),...i.values])].slice(0,10);mc.explicitSelection=true;
        store.updateSettings(guild.id,{messageConfig:mc});await i.update(payload(messageSettings(guild,s)));return;
      }
      if(action==="search")return;
      if(action==="start"){
        if(locks.has(guild.id))throw new Error("Já existe uma operação em andamento neste servidor.");
        await i.deferUpdate();const started=Date.now();
        await i.message.edit(payload(progressPanel(guild,{stage:"Preparando coleta",percent:0},started)));
        let last=0;
        const out=await createBackup(guild,i.user.id,{progress:p=>{
          if(Date.now()-last<900&&p.percent<100)return;last=Date.now();
          i.message.edit(payload(progressPanel(guild,p,started))).catch(()=>{});
        }});
        const summary=out.result.data.manifest,partial=summary.failures.length>0;
        const completion=box(null,`# Backup ${partial?"Parcial":"Concluído"}\n**Identificador:** \`${out.row.id}\`\n**Data:** <t:${Math.floor(out.row.createdAt/1000)}:F>\n`+
          `**Cargos salvos:** ${summary.inventory.roles}\n**Canais salvos:** ${summary.inventory.channels}\n**Emojis/stickers:** ${summary.inventory.emojis}/${summary.inventory.stickers}\n`+
          `**Tamanho:** ${sizeText(out.row.size)}\n**Falhas:** ${summary.failures.length} · **Avisos/limitações:** ${summary.warnings.length+summary.limitations.length}\n`+
          `**Criptografado:** ${summary.encrypted?"Sim":"Não"}\n-# As limitações do manifesto acompanham o arquivo.` ,partial?0:0)
          .addActionRowComponents(row(button(s,"downloadselected","Baixar Backup",ButtonStyle.Primary),button(s,"details","Ver Detalhes"),button(s,"home","Painel")));
        s.selected=out.row.id;s.view="list";save(s);await i.message.edit(payload(completion));
        audit(guild.id,i.user.id,"backup-completed",{id:out.row.id,bytes:out.row.size,summary:out.result.summary});
        await notify(guild,store.settings(guild.id),`Backup ${out.row.id}: ${partial?"parcial":"concluído"}; ${sizeText(out.row.size)}.`);
        return;
      }
      if(action==="cancel"){await i.update(payload(box(s,"# Operação cancelada\nNenhuma alteração foi feita.")));return;}
      if(action==="home"){s.view="home";save(s);await i.update(payload(home(guild,s)));return;}
      if(action==="create"){s.view="create";save(s);await i.update(payload(createPanel(guild,s)));return;}
      if(action==="list"||action==="listrestore"){s.view="list";save(s);await i.update(payload(backupsPanel(guild,s)));return;}
      if(action==="settings"){s.view="settings";save(s);await i.update(payload(settingsPanel(guild,s)));return;}
      if(action==="msgsettings"){s.view="msgsettings";save(s);await i.update(payload(messageSettings(guild,s)));return;}
      if(action==="msgchannelspageprev"||action==="msgchannelspagenext"){
        s.channelPage=(s.channelPage||0)+(action==="msgchannelspagenext"?1:-1);save(s);await i.update(payload(messageSettings(guild,s)));return;
      }
      if(action==="prev"||action==="next"){s.page+=action==="next"?1:-1;save(s);await i.update(payload(backupsPanel(guild,s)));return;}
      if(action==="autotoggle"){
        const st=store.settings(guild.id),enabled=!st.automatic,interval=st.intervalHours||24;
        store.updateSettings(guild.id,{automatic:enabled,nextAt:enabled?Date.now()+interval*3600000:null});
        s.view="home";save(s);await i.update(payload(home(guild,s)));audit(guild.id,i.user.id,"auto-toggle",{enabled});return;
      }
      if(action==="frequency"){
        const st=store.settings(guild.id),choices=[6,12,24,168],next=choices[(choices.indexOf(st.intervalHours)+1+choices.length)%choices.length];
        store.updateSettings(guild.id,{intervalHours:next,nextAt:st.automatic?Date.now()+next*3600000:st.nextAt});
        await i.update(payload(settingsPanel(guild,s)));return;
      }
      if(action==="retention"){
        const st=store.settings(guild.id),choices=[5,10,20,50],next=choices[(choices.indexOf(st.retention)+1+choices.length)%choices.length];
        store.updateSettings(guild.id,{retention:next});store.retain(guild.id);await i.update(payload(settingsPanel(guild,s)));return;
      }
      if(action==="messagesToggle"){
        const st=store.settings(guild.id),mc=JSON.parse(st.messageConfig||"{}");mc.enabled=!mc.enabled;
        store.updateSettings(guild.id,{messageConfig:mc});s.view="settings";save(s);await i.update(payload(settingsPanel(guild,s)));return;
      }
      if(action==="msgdays"||action==="msglimit"||action==="msgattach"){
        const st=store.settings(guild.id),mc=JSON.parse(st.messageConfig||"{}");
        if(action==="msgdays")mc.days=mc.days===7?30:mc.days===30?90:mc.days===90?365:7;
        if(action==="msglimit")mc.limit=mc.limit===100?500:mc.limit===500?1000:mc.limit===1000?5000:100;
        if(action==="msgattach")mc.attachments=!mc.attachments;
        store.updateSettings(guild.id,{messageConfig:mc});await i.update(payload(messageSettings(guild,s)));return;
      }
      if(action==="logchannel"){
        await i.update(payload(logChannelPanel(guild,s)));return;
      }
      if(action==="logselect"){
        store.updateSettings(guild.id,{notifyChannel:i.values[0]||null});s.view="settings";save(s);await i.update(payload(settingsPanel(guild,s)));return;
      }
      if(action==="download"){
        const rowDb=store.get(s.selected,guild.id)||store.list(guild.id,1)[0];if(!rowDb)throw new Error("Nenhum backup disponível.");
        await sendDownload(i,guild,rowDb);return;
      }
      if(action==="downloadselected"){
        const rowDb=store.get(s.selected,guild.id);if(!rowDb)throw new Error("Selecione um backup primeiro.");
        audit(guild.id,i.user.id,"download",{id:rowDb.id});await sendDownload(i,guild,rowDb);return;
      }
      if(action==="details"){
        const rowDb=store.get(s.selected,guild.id);if(!rowDb)throw new Error("Selecione um backup primeiro.");
        const {data}=await loadBackup(guild,rowDb),manifest=data.manifest;
        await i.reply(payload(box(s,`# Detalhes do Backup\n**ID:** \`${rowDb.id}\`\n**Criado:** <t:${Math.floor(rowDb.createdAt/1000)}:F>\n**Por:** ${rowDb.createdBy}\n**Tamanho:** ${sizeText(rowDb.size)}\n**Checksum:** \`${rowDb.sha256}\`\n\n`+
          `**Cargos:** ${manifest.inventory.roles} · **Canais:** ${manifest.inventory.channels}\n**Emojis:** ${manifest.inventory.emojis} · **Stickers:** ${manifest.inventory.stickers}\n`+
          `**Falhas:** ${(manifest.failures||[]).length}\n**Limitações:** ${(manifest.limitations||[]).join("; ").slice(0,1800)}`),true));return;
      }
       if(action==="restoreselected"){
        const rowDb=store.get(s.selected,guild.id);if(!rowDb)throw new Error("Selecione um backup primeiro.");
        const {data}=await loadForRestore(guild,rowDb.id,i.user.id),preview=await engine.previewRestore(guild,data,{allowCrossGuild:true});
        Object.assign(s,{view:"restore",backupId:rowDb.id,backupCreatedAt:rowDb.createdAt,originName:data.originGuildName,preview});save(s);
        await i.update(payload(restorePanel(guild,s,preview)));audit(guild.id,i.user.id,"restore-preview",{backupId:rowDb.id});return;
      }
      if(action==="restoreconfirm"){
        if(locks.has(guild.id))throw new Error("Já existe outra operação neste servidor.");
        const {data:restoreData}=await loadForRestore(guild,s.backupId,i.user.id);
        const currentPreview=await engine.previewRestore(guild,restoreData,{allowCrossGuild:true});
        const summary=p=>JSON.stringify({roles:p.roles.map(x=>[x.id,x.action]),channels:p.channels.map(x=>[x.id,x.action])});
        if(summary(currentPreview)!==summary(s.preview||{roles:[],channels:[]})){
          s.preview=currentPreview;save(s);
          await i.update(payload(restorePanel(guild,s,currentPreview,"A estrutura mudou desde a prévia. Revise as contagens atualizadas e confirme novamente.")));
          return;
        }
        await i.deferUpdate();locks.add(guild.id);
        audit(guild.id,i.user.id,"restore-confirmed",{backupId:s.backupId});
        try{
          await i.message.edit(payload(box(s,"# Backup de segurança\nCriando backup do estado atual antes da restauração...")));
          const safety=await createBackup(guild,i.user.id,{lockHeld:true});
          await i.message.edit(payload(box(s,`# Restaurando estrutura\nBackup de segurança criado: \`${safety.row.id}\`\nNão feche esta mensagem.`)));
          const result=await engine.restore(guild,restoreData,{allowCrossGuild:true,progress:p=>{
            if(p.done===1||p.done===p.total||p.done%5===0)i.message.edit(payload(box(s,`# Restaurando\n**Etapa:** ${p.stage}\n**Progresso:** ${p.percent}%`))).catch(()=>{});
          }});
          let configuration=null;
          try{
            configuration=botConfig.apply(guild,restoreData,result,{allowCrossGuild:true});
            result.errors.push(...configuration.errors);
            if(restorePanels)await restorePanels(guild,configuration.panels,result,botConfig);
          }catch(error){result.errors.push(`Configurações do bot não concluídas: ${error.message}`);}
          const c=box(s,`# Restauração ${result.errors.length?"Parcial":"Concluída"}\n**Backup:** \`${s.backupId}\`\n**Cópia de segurança:** \`${safety.row.id}\`\n\n`+
            `**Criados nesta execução:** ${result.created.roles} cargos, ${result.created.channels} canais, ${result.created.emojis} emojis, ${result.created.stickers} stickers.\n`+
            `**Falhas:** ${result.errors.length}\n${result.errors.slice(0,8).map(e=>`• ${e}`).join("\n").slice(0,1400)}\n\n`+
            `**Configurações:** ${configuration?`${configuration.tables} seções SQLite e ${configuration.dataSections} seções de tickets reaplicadas com novos IDs.${configuration.snapshot?"":" Backup antigo: usadas as configurações disponíveis; dados que nunca foram salvos não podem ser recuperados."}`:"não concluídas; verifique as falhas."}\nItens existentes e históricos foram preservados. Mensagens antigas e tickets privados não são recriados.`,result.errors.length?0:0);
          await i.message.edit(payload(c));audit(guild.id,i.user.id,"restore-completed",{backupId:s.backupId,safetyBackup:safety.row.id,created:result.created,errors:result.errors});
          await notify(guild,store.settings(guild.id),`Restauração ${s.backupId}: ${result.errors.length} falhas; criada cópia de segurança ${safety.row.id}.`);
        }finally{locks.delete(guild.id);}return;
      }
    }catch(error){
      console.error("[Backups] Erro na operação:",error);
      if(ctx?.s)try{audit(ctx.s.guildId,i.user.id,"operation-failed",{action,error:String(error.message||error).slice(0,500)});}catch{}
      const msg=box(null,`# Operação não concluída\n${safeMessage(error)}`,0);
      if(i.deferred&&i.message?.edit)await i.message.edit(payload(msg)).catch(()=>{});
      else if(i.isRepliable())await i.reply(payload(msg,true)).catch(()=>{});
    }
  });

  const timer=setInterval(async()=>{
    for(const guild of client.guilds.cache.values()){
      const st=store.settings(guild.id);
      if(!st.automatic||!st.nextAt||st.nextAt>Date.now()||running.has(guild.id))continue;
      running.add(guild.id);store.updateSettings(guild.id,{nextAt:Date.now()+st.intervalHours*3600000});
      try{const result=await createBackup(guild,"automatic",{automatic:true});
        await notify(guild,st,`Backup automático ${result.row.id} concluído (${sizeText(result.row.size)}).`);
        audit(guild.id,"automatic","automatic-completed",{id:result.row.id,size:result.row.size});
      }catch(error){console.error(`[Backups] Backup automático ${guild.id}:`,error);audit(guild.id,"automatic","automatic-failed",{error:String(error.message).slice(0,500)});await notify(guild,st,`Falha no backup automático: ${String(error.message).slice(0,500)}`);}
      finally{running.delete(guild.id);}
    }
  },60_000);timer.unref();
  client.once("clientReady",()=>{for(const guild of client.guilds.cache.values())store.settings(guild.id);});
  return {store,botConfig,close:()=>clearInterval(timer)};
};
