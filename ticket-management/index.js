const {ContainerBuilder,TextDisplayBuilder,SectionBuilder,ThumbnailBuilder,ActionRowBuilder,ButtonBuilder,ButtonStyle,RoleSelectMenuBuilder,UserSelectMenuBuilder,ChannelSelectMenuBuilder,ChannelType,ModalBuilder,LabelBuilder,TextInputBuilder,TextInputStyle,MessageFlags,SlashCommandBuilder,PermissionFlagsBits}=require('discord.js');
const {errorText,statusText}=require("../error-ui");
const painelEmojis=require("../lumiya-ui/emojis");
const AREAS=['support','migration'],LABEL={support:'Suporte',migration:'Migração',null:'Gestão'};
const {AREAS:MANAGEMENT_AREAS,LABEL:MANAGEMENT_LABEL}=require('./areas');
Object.assign(LABEL,MANAGEMENT_LABEL);
const KIND={sup:'Suporte Geral',den:'Denúncia',role:'Devolução de cargo',transfer:'Transferência de conta',migration:'Migração'};
const ACTION_LABEL={opened:'Ticket aberto',imported:'Registro importado',claim:'Atendimento assumido',release:'Responsável liberado','transfer-to':'Responsável transferido',closed:'Ticket fechado','channel-deleted':'Canal excluído',archived:'Ticket fechado',unarchived:'Ticket reaberto','participant-added':'Participante adicionado','participant-removed':'Participante removido','area-access-granted':'Acesso da equipe concedido','area-access-revoked':'Acesso da equipe revogado','general-admins-updated':'Administradores atualizados'};
Object.assign(ACTION_LABEL,{'team-goals-updated':'Metas semanais atualizadas','team-member-added':'Membro adicionado à equipe','team-member-removed':'Membro removido da equipe'});
Object.assign(ACTION_LABEL,{'team-promoted':'Membro promovido','team-promotion-role-added':'Cargo de promoção adicionado','team-promotion-partial':'Promoção requer revisão'});
Object.assign(ACTION_LABEL,{'team-ranks-configured':'Sequência de promoção atualizada'});
Object.assign(ACTION_LABEL,{'area-configured':'Configuração da área atualizada'});
const {ACCENT,divider,permissionLabel,enabled,safeText,statusLabel,counted}=require('./appearance');
const {canManageTicket}=require('./permissions');
const text=s=>new TextDisplayBuilder().setContent(statusText(s));
const button=(id,label,style=ButtonStyle.Secondary,emoji=null)=>{const b=new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style);if(emoji)b.setEmoji(emoji);return b;};
const row=(...items)=>new ActionRowBuilder().addComponents(...items);
const pack=(c,ephemeral=true)=>require("../lumiya-ui/canonical").canonical({components:[c],flags:MessageFlags.IsComponentsV2|(ephemeral?MessageFlags.Ephemeral:0),allowedMentions:{parse:[]}});
const legacy=i=>/^(ticket-close|migration-close|ticket-claim:|ticket-users:|ticket-users-select:)/.test(i.customId||'');
module.exports=function install({client,registry,db,data,save,closeTicket,refreshTicket}){
  const resourceIds=require("../resource-ids")(db);
  const membersDirectory=require('./members').memberDirectory(client);
  const actionButton=(id,label,key,style=ButtonStyle.Secondary)=>button(id,label,style);
  db.exec(`CREATE TABLE IF NOT EXISTS ticket_management_config(guildId TEXT PRIMARY KEY,config TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS ticket_management_cases(id TEXT PRIMARY KEY,guildId TEXT NOT NULL,area TEXT,ownerId TEXT,kind TEXT,createdAt INTEGER,status TEXT NOT NULL,assigneeId TEXT,claimedAt INTEGER,closedAt INTEGER,closedBy TEXT,confidential INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS ticket_management_audit(id INTEGER PRIMARY KEY,ticketId TEXT,guildId TEXT NOT NULL,area TEXT,actorId TEXT,ownerId TEXT,assigneeId TEXT,action TEXT NOT NULL,at INTEGER NOT NULL,beforeStatus TEXT,afterStatus TEXT,details TEXT);
    CREATE TABLE IF NOT EXISTS ticket_management_access(ticketId TEXT NOT NULL,userId TEXT NOT NULL,PRIMARY KEY(ticketId,userId));
    CREATE INDEX IF NOT EXISTS ticket_management_area ON ticket_management_cases(guildId,area,status);`);
  const locks=new Set();
  const navigation=new Map(),navigationContext=new WeakMap();
  const panels=new Map(),PANEL_IDLE_MS=30_000;
  function closePanel(panel){
    clearTimeout(panel.timer);panels.delete(panel.message?.id||panel.id);
    navigation.delete(`${panel.guildId}:${panel.userId}:${panel.message?.id||panel.id}`);
    return Promise.resolve(panel.message?.delete?.()).catch(()=>{});
  }
  function schedulePanelExpiry(panel){
    clearTimeout(panel.timer);
    panel.timer=setTimeout(()=>{void closePanel(panel);},PANEL_IDLE_MS);
    panel.timer.unref?.();
  }
  function touchPanel(panel){panel.at=Date.now();schedulePanelExpiry(panel);}
  function config(gid){
    const saved=JSON.parse(db.prepare('SELECT config FROM ticket_management_config WHERE guildId=?').get(gid)?.config||'{}');
    const claims=data.ticketClaimRoles?.[gid];
    const result={supportRole:resourceIds.resolve(gid,process.env.GESTAO_SUPORTE_ROLE_ID||null),migrationRole:resourceIds.resolve(gid,process.env.GESTAO_MIGRACAO_ROLE_ID||null),adminRole:resourceIds.resolve(gid,process.env.GESTAO_TICKETS_ADMIN_ROLE_ID||null),
      supportTeam:Array.isArray(claims)?claims:claims?.support||[],migrationTeam:Array.isArray(claims)?claims:claims?.migration||[],movchatRole:null,passtimeRole:null,movchatTeam:[],passtimeTeam:[],passtimeChannel:null,close:true,transfer:true,participants:true,...saved};
    if(claims){result.supportTeam=Array.isArray(claims)?claims:claims.support||[];result.migrationTeam=Array.isArray(claims)?claims:claims.migration||[];}return result;
  }
  const has=(m,id)=>Boolean(id&&m?.roles?.cache?.has(id));
  function access(guild,m){const c=config(guild.id),admin=Boolean(m&&(m.id===guild.ownerId||has(m,c.adminRole)||(c.adminUserIds||[]).includes(m.id)));return {admin,...Object.fromEntries(MANAGEMENT_AREAS.map(area=>[area,admin||has(m,c[`${area}Role`])]))};}
  async function member(i){return i.guild.members.fetch({user:i.user.id,force:true});}
  function sync(createdId){
    for(const [id,t] of Object.entries(data.tickets||{})){
      const area=AREAS.includes(t.sistema)?t.sistema:null,claim=data.claims[id];
      const inserted=db.prepare(`INSERT OR IGNORE INTO ticket_management_cases(id,guildId,area,ownerId,kind,createdAt,status,assigneeId,claimedAt,confidential) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(id,t.guildId||'unknown',area,t.donoId||null,t.tipo||null,t.criadoEm||null,'open',claim?.userId||null,claim?.at||null,t.confidential?1:0);
      if(inserted.changes)audit({id,guildId:t.guildId||'unknown',area,ownerId:t.donoId||null,assigneeId:claim?.userId||null,status:'open'},createdId===id?t.donoId:null,createdId===id?'opened':'imported');
    }
  }
  function get(id,gid){sync();return db.prepare('SELECT * FROM ticket_management_cases WHERE id=? AND guildId=?').get(id,gid);}
  function audit(t,actor,action,details={},before=t.status,after=t.status){
    db.prepare('INSERT INTO ticket_management_audit(ticketId,guildId,area,actorId,ownerId,assigneeId,action,at,beforeStatus,afterStatus,details) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(t.id,t.guildId,t.area,actor,t.ownerId,t.assigneeId,action,Date.now(),before,after,JSON.stringify(details));
    const channelId=config(t.guildId)[`${t.area||'general'}Log`];
    if(channelId)void (async()=>{const ch=await client.channels.fetch(channelId);if(ch?.guildId!==t.guildId)return;const msg=await ch.send(require("../lumiya-ui/logs").card({
      category:"community",title:`${LABEL[t.area]} · ${ACTION_LABEL[action]||safeText(action)}`,
      subtitle:"Atividade registrada no atendimento",
      summary:[["Ticket",t.id],["Autor da ação",actor?`<@${actor}>`:"Sistema"]],
      details:[["Estado anterior",safeText(before||"—")],["Estado atual",safeText(after||"—")]],
      metadata:[["Servidor",t.guildId],["Canal do ticket",t.id]],
      botAvatarURL:client.user?.displayAvatarURL?.({size:128}),
      source:"Gestão de tickets",eventId:t.id
    }));registry.preserveMessage(msg);})().catch(()=>console.warn('[Tickets] Log indisponível.'));
  }
  function canOperate(g,m,t,action){const a=access(g,m),c=config(g.id);if(!AREAS.includes(t.area))return false;
    if(a.admin)return true;
    if(action==='view')return a[t.area]||canManageTicket({member:m,data,config:c,guildId:g.id,system:t.area});
    const enabled=c[`${t.area}${action[0].toUpperCase()+action.slice(1)}`]??c[action];
    // Cargos mencionados no painel do ticket, cargos de claim e equipes da área
    // podem assumir e fechar. Cargos com Administrador também, via permissão.
    if(a[t.area]||canManageTicket({member:m,data,config:c,guildId:g.id,system:t.area}))return action==='claim'||enabled!==false;
    return (c[`${t.area}Team`]||[]).some(id=>has(m,id))&&(action==='claim'||enabled!==false);
  }
  const deniedCard=i=>new ContainerBuilder().setAccentColor(0).addTextDisplayComponents(text(errorText(`**Você não possui permissão para executar esse comando.**\nRequisitado por: <@${i.user.id}>`)));
  const denied=i=>respond(i,deniedCard(i));
  const denyEphemeral=i=>i.reply(pack(deniedCard(i))).catch(()=>{});
  async function respond(i,c){
    const state=navigationContext.get(i),panel=panels.get(i.message?.id);
    const json=JSON.stringify(c.toJSON()),hasBack=json.includes('"label":"Voltar"');
    // Erros não recebem "Voltar"; antes isso era detectado pela cor vermelha,
    // que agora foi removida de todos os painéis.
    const erro=/Não foi possível|🚨|1569933923641983038/.test(json);
    if(state&&state.stack.length&&!['home','open','area'].includes(state.current.route.split(':')[1])&&!erro&&!hasBack)c.addActionRowComponents(row(button('tg:back','Voltar')));
    const payload=pack(c,!panel);
    return i.deferred?i.editReply(payload):i.reply(payload);
  }
  function card(area,title,guild=null){
    const lines=title.split('\n'),heading=lines.shift();
    if(!heading.startsWith('# '))return new ContainerBuilder().setAccentColor(ACCENT).addTextDisplayComponents(text(title));
    const subtitle=lines[0]?.startsWith('-# ')?`\n${lines.shift()}`:'';
    const c=new ContainerBuilder().setAccentColor(ACCENT),icon=guild?.iconURL?.({extension:'png',size:256});
    if(icon)c.addSectionComponents(new SectionBuilder().addTextDisplayComponents(text(heading+subtitle)).setThumbnailAccessory(new ThumbnailBuilder().setURL(icon)));
    else c.addTextDisplayComponents(text(heading+subtitle));
    if(lines.join('\n').trim())c.addSeparatorComponents(divider()).addTextDisplayComponents(text(lines.join('\n')));
    return c;
  }
  const activity=require('./activity')({client,db,config});
  const team=require('./team')({db,data,config,access,audit,card,text,row,button,denied,respond,membersDirectory,activity});
  const ranks=require('./ranks')({config,card,text,row,button,respond,denied,saveConfig(i,area,c){db.prepare('INSERT INTO ticket_management_config VALUES(?,?) ON CONFLICT(guildId) DO UPDATE SET config=excluded.config').run(i.guildId,JSON.stringify(c));audit({id:null,guildId:i.guildId,area,ownerId:null,assigneeId:null,status:'configuration'},i.user.id,'team-ranks-configured',{roles:c[`${area}Ranks`]});}});
  function stats(gid,area){sync();const rows=db.prepare('SELECT * FROM ticket_management_cases WHERE guildId=? AND area=?').all(gid,area);return {open:rows.filter(t=>t.status==='open').length,claimed:rows.filter(t=>t.status==='open'&&t.assigneeId).length,pending:rows.filter(t=>t.status==='open'&&!t.assigneeId).length,closed:rows.filter(t=>t.status==='closed').length};}
  function home(g,m,area,root=false){
    const a=access(g,m),available=MANAGEMENT_AREAS.filter(key=>a[key]);if(!area&&!root&&available.length===1)area=available[0];
    if(area&&!AREAS.includes(area))return card(area,`# Gestão de ${LABEL[area]}\n-# Atividade semanal e gestão da equipe`,g).addSeparatorComponents(divider())
      .addSectionComponents(new SectionBuilder().addTextDisplayComponents(text(`**Equipe e atividade**\n-# ${area==='movchat'?'Mensagens e @everyone no servidor inteiro.':`Mensagens no canal ${config(g.id).passtimeChannel?`<#${config(g.id).passtimeChannel}>`:'ainda não configurado'}.`}`)).setButtonAccessory(button(`tg:team:${area}:all:0`,'Gerenciar equipe')))
      .addSeparatorComponents(divider()).addActionRowComponents(row(button(`tg:history:${area}`,'Histórico'),button(`tg:area:${area}`,'Atualizar'),...(available.length>1?[button('tg:home','Voltar')]:[])));
    if(!area){const c=card(null,'# Painel de Gestão\n-# Central de gerenciamento de atendimentos',g);let total=0,claimed=0,pending=0;
      c.addSeparatorComponents(divider());
       for(const key of available){if(!AREAS.includes(key)){c.addSectionComponents(new SectionBuilder().addTextDisplayComponents(text(`**${LABEL[key]}**\n-# Atividade semanal e gestão da equipe.`)).setButtonAccessory(button(`tg:area:${key}`,'Gerenciar'))).addSeparatorComponents(divider());continue;}const s=stats(g.id,key);total+=s.open;claimed+=s.claimed;pending+=s.pending;c.addSectionComponents(new SectionBuilder().addTextDisplayComponents(text(`**${LABEL[key]}**\n-# ${key==='support'?'Gerencie os atendimentos da equipe.':'Gerencie as solicitações de migração.'}\n${counted(s.open,key==='support'?'aberto':'aberta',key==='support'?'abertos':'abertas')} · ${counted(s.pending,'pendente','pendentes')}`)).setButtonAccessory(button(`tg:area:${key}`,'Gerenciar'))).addSeparatorComponents(divider());}
       c.addTextDisplayComponents(text(available.some(key=>AREAS.includes(key))?`**Atendimentos**\n\n${total} em aberto · ${counted(pending,'pendente','pendentes')} · ${claimed} em andamento`:'-# Selecione uma equipe para acompanhar a atividade.'))
         .addActionRowComponents(row(button('tg:history-home','Histórico').setEmoji({name:'Icon_Clipboard_List',id:'1570628610132283433'}),button('tg:home','Atualizar').setEmoji('🔄'),...(a.admin?[button('tg:config','Configurações').setEmoji({name:'Icon_Settings',id:'1570628871320109117'})]:[])));
       if(a.admin){const unknown=db.prepare('SELECT COUNT(*) n FROM ticket_management_cases WHERE guildId=? AND area IS NULL').get(g.id).n;if(unknown)c.addTextDisplayComponents(text(`-# ${unknown} registro(s) sem área identificada precisam de revisão administrativa.`));}return c;
    }
    const s=stats(g.id,area),own=db.prepare("SELECT COUNT(*) n FROM ticket_management_cases WHERE guildId=? AND area=? AND status='open' AND assigneeId=?").get(g.id,area,m.id).n;
    const c=card(area,`# Gestão de ${LABEL[area]}\n-# Central de gerenciamento de ${area==='support'?'atendimentos':'solicitações'}`,g);
    c.addSeparatorComponents(divider()).addTextDisplayComponents(text(`**Visão geral**\n\n${counted(s.open,area==='support'?'aberto':'aberta',area==='support'?'abertos':'abertas')} · ${counted(s.pending,'pendente','pendentes')} · ${s.claimed} em andamento`))
      .addSeparatorComponents(divider())
      .addSectionComponents(new SectionBuilder().addTextDisplayComponents(text(`**${area==='support'?'Meus atendimentos':'Minhas migrações'}**\n-# ${counted(own,area==='support'?'ticket atribuído':'solicitação atribuída',area==='support'?'tickets atribuídos':'solicitações atribuídas')} a você.`)).setButtonAccessory(button(`tg:mine:${area}`,'Visualizar')))
      .addSeparatorComponents(divider())
      .addSectionComponents(new SectionBuilder().addTextDisplayComponents(text(`**Gerenciar ${area==='support'?'tickets':'migrações'}**\n-# Consulte e organize ${area==='support'?'os atendimentos':'as solicitações'}.`)).setButtonAccessory(button(`tg:list:${area}:all:0`,'Gerenciar')))
      .addSeparatorComponents(divider())
      .addSectionComponents(new SectionBuilder().addTextDisplayComponents(text('**Equipe e metas**\n-# Acompanhe a semana e gerencie os membros da área.')).setButtonAccessory(button(`tg:team:${area}:all:0`,'Gerenciar equipe')))
      .addSeparatorComponents(divider())
      .addActionRowComponents(row(button(`tg:history:${area}`,'Histórico').setEmoji({name:'Icon_Clipboard_List',id:'1570628610132283433'}),button(`tg:stats:${area}`,'Estatísticas'),button(`tg:area:${area}`,'Atualizar').setEmoji('🔄'),...(available.length>1?[button('tg:home','Voltar')]:[])));return c;
  }
  function list(gid,area,filter,page,query=''){
    sync();let rows=db.prepare("SELECT * FROM ticket_management_cases WHERE guildId=? AND area=? AND status='open' ORDER BY createdAt DESC,id").all(gid,area);
    rows=rows.filter(t=>(filter==='pending'?!t.assigneeId:filter==='claimed'?!!t.assigneeId:true)&&(!query||t.id.includes(query)||t.ownerId===query));
    const pages=Math.max(1,Math.ceil(rows.length/3));page=Math.min(Math.max(0,page),pages-1);const c=card(area,`# Tickets de ${LABEL[area]}\n-# Atendimentos disponíveis`).addSeparatorComponents(divider());
    for(const t of rows.slice(page*3,page*3+3))c.addSectionComponents(new SectionBuilder().addTextDisplayComponents(text(`**#${t.id} · ${safeText(KIND[t.kind]||t.kind||'Não informado',60)}**\n-# <@${t.ownerId}> · ${statusLabel(t.status,!!t.assigneeId)}\n-# ${t.assigneeId?`Responsável: <@${t.assigneeId}>`:t.createdAt?`Aberto <t:${Math.floor(t.createdAt/1000)}:R>`:'Data não registrada'}`)).setButtonAccessory(button(`tg:ticket:${t.id}`,'Visualizar'))).addSeparatorComponents(divider());
    if(!rows.length)c.addTextDisplayComponents(text('-# Nenhum ticket encontrado.'));
    c.addActionRowComponents(row(...[['all','Todos'],['pending','Pendentes'],['claimed','Em atendimento']].map(([f,l])=>button(`tg:list:${area}:${f}:0`,l)),button(`tg:search:${area}`,'Pesquisar')));
    const pageRoute=query?`tg:query-page:${area}`:`tg:list:${area}:${filter}`;
    c.addActionRowComponents(row(button(`${pageRoute}:${Math.max(0,page-1)}:prev`,'<').setDisabled(page===0),button('tg:noop',`${page+1}/${pages}`).setDisabled(true),button(`${pageRoute}:${page+1}:next`,'>').setDisabled(page+1>=pages)));
    return c;
  }
  function detail(t,g){const c=card(t.area,`# Ticket #${t.id}\n-# ${safeText(KIND[t.kind]||t.kind||LABEL[t.area],80)}`).addSeparatorComponents(divider());const info=`**Informações**\n\n**Usuário:** <@${t.ownerId}>\n**Status:** ${statusLabel(t.status,!!t.assigneeId)}\n**Responsável:** ${t.assigneeId?`<@${t.assigneeId}>`:'Nenhum'}\n**Criado em:** ${t.createdAt?`<t:${Math.floor(t.createdAt/1000)}:f>`:'Não registrado'}\n**Canal:** <#${t.id}>`;
    if(g.iconURL?.())c.addSectionComponents(new SectionBuilder().addTextDisplayComponents(text(info)).setThumbnailAccessory(new ThumbnailBuilder().setURL(g.iconURL())));else c.addTextDisplayComponents(text(info));
    if(t.status==='open')c.addSeparatorComponents(divider()).addTextDisplayComponents(text('**Gerenciamento**\n-# Selecione uma ação para este atendimento.')).addActionRowComponents(row(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Abrir canal').setURL(`https://discord.com/channels/${t.guildId}/${t.id}`),button(`tg:claim:${t.id}`,'Assumir')))
      .addActionRowComponents(row(button(`tg:users:${t.id}`,'Gerenciar usuários'),button(`tg:transfer:${t.id}`,'Transferir'),button(`tg:release:${t.id}`,'Liberar')))
      .addActionRowComponents(row(actionButton(`tg:ticket-history:${t.id}`,'Histórico','history'),actionButton(`tg:close:${t.id}`,'Fechar','close',ButtonStyle.Danger)));return c;
  }
  function configCard(gid,isOwner=false){const c=config(gid),out=card(null,'# Configurações de tickets\n-# Equipes, acessos e permissões de atendimento');
    out.addSeparatorComponents(divider())
      .addTextDisplayComponents(text('**Áreas de atendimento**\n-# Defina os cargos, canais e permissões de cada equipe.'))
      .addActionRowComponents(row(...MANAGEMENT_AREAS.map(area=>button(`tg:cfg-area:${area}`,LABEL[area]))))
      .addSeparatorComponents(divider())
      .addTextDisplayComponents(text(`**Permissões padrão**\n\n${['close','transfer','participants'].map(k=>`**${permissionLabel[k]}:** ${enabled(c[k])}`).join('\n')}\n-# As permissões podem ser ajustadas por área.`))
      .addActionRowComponents(row(...['close','transfer','participants'].map(k=>button(`tg:cfg-toggle:${k}`,`${c[k]===false?'Ativar':'Desativar'} ${permissionLabel[k].toLowerCase()}`,ButtonStyle.Secondary,painelEmojis.toggleEmoji(c[k]!==false)))))
      .addSeparatorComponents(divider())
      .addTextDisplayComponents(text(`**Administração geral**\n\n**Cargo:** ${c.adminRole?`<@&${c.adminRole}>`:'Não definido'}\n**Membros autorizados:** ${(c.adminUserIds||[]).map(id=>`<@${id}>`).join(', ')||'Nenhum'}\n-# Somente o proprietário pode alterar essas autorizações.`))
      .addActionRowComponents(row(new RoleSelectMenuBuilder().setCustomId('tg:cfg-role:adminRole').setPlaceholder('Selecionar cargo de Administração Geral').setMinValues(0).setMaxValues(1).setDisabled(!isOwner)));
    if(isOwner)out.addActionRowComponents(row(new UserSelectMenuBuilder().setCustomId('tg:cfg-admins').setPlaceholder('Escolher administradores gerais de tickets').setMinValues(0).setMaxValues(25).setDefaultUsers(...(c.adminUserIds||[]))));
    return out;}
  async function handle(i){
    try{return await dispatch(i);}
    catch(error){console.warn('[Gestão de tickets] Interação indisponível:',error.message);if(!i.replied)await respond(i,card(null,'# Não foi possível concluir\n-# Ocorreu um erro ao processar a solicitação.').setAccentColor(0)).catch(()=>{});}
  }
  async function dispatch(i){
    if(!i.inGuild?.())return;
    if(!i.customId?.startsWith('tg:')&&!legacy(i))return;
    const panel=panels.get(i.message?.id);
    if(panel&&panel.userId!==i.user.id)return denyEphemeral(i);
    if(panel)touchPanel(panel);
    try{
      const key=`${i.guildId}:${i.user.id}:${i.message?.id||i.id||'initial'}`;
      let state=navigation.get(key);if(!state||Date.now()-state.at>30*60000)state={current:{route:'tg:home',query:''},stack:[],at:Date.now()};
      let route=i.customId,query='';
      if(route==='tg:back'){const previous=state.stack.pop();route=previous?.route||'tg:home';query=previous?.query||'';state.current={route,query};}
      const parts=(route||'').split(':'),action=parts[1],id=parts[2];
      if(action==='query')query=query||i.fields?.getTextInputValue('query').trim()||state.current.query;
      if(action==='query-page')query=query||state.current.query;
      if(['home','open','area','list','query','query-page','mine','history','history-home','stats','ticket','ticket-history','config','cfg-area','users','transfer','close','team','team-goals','team-members','team-promote','cfg-ranks'].includes(action)){
        if(route!==state.current.route&&i.customId!=='tg:back')state.stack.push({...state.current});
        if(state.stack.length>20)state.stack.shift();state.current={route,query};
      }
      state.at=Date.now();navigation.set(key,state);navigationContext.set(i,state);
      while(navigation.size>500)navigation.delete(navigation.keys().next().value);
      if(action!=='search'&&action!=='team-goal-select'&&!i.deferred&&!i.replied){
        if((panel||i.message?.flags?.has?.(MessageFlags.Ephemeral))&&typeof i.deferUpdate==='function')await i.deferUpdate();
        else await i.deferReply({flags:MessageFlags.Ephemeral});
      }
      const m=await member(i),a=access(i.guild,m);sync();
      if(action?.startsWith('team'))return team.handle(i,m,action,id,parts);
      if(legacy(i)){
        const t=get(i.channelId,i.guildId);if(!t)return denied(i);
        const expected=i.customId.split(':')[1];if(expected&&expected!==t.id)return denied(i);
        if(i.customId==='ticket-close'&&t.area!=='support'||i.customId==='migration-close'&&t.area!=='migration')return denied(i);
        const act=i.customId.includes('claim')?'claim':i.customId.includes('close')?'close':'participants';
        if(!canOperate(i.guild,m,t,act))return denied(i);
        if(act==='claim')return mutate(i,m,t,'claim');
        if(act==='close')return confirm(i,t);
        return users(i,t);
      }
      if(['config','cfg-area','cfg-role','cfg-channel','cfg-toggle','cfg-access','cfg-admins','cfg-ranks','cfg-rank-save','cfg-rank-pick','cfg-rank-move'].includes(action)){
        if(!a.admin)return denied(i);const c=config(i.guildId);
        if(action.startsWith('cfg-rank'))return ranks(i,action,id,parts);
        if(action==='cfg-admins'){
          if(m.id!==i.guild.ownerId)return denied(i);
          const ids=[...new Set(i.values||[])];if(ids.length>25)return denied(i);
          for(const uid of ids){const target=await i.guild.members.fetch({user:uid,force:true});if(!target||target.user.bot)return respond(i,card(null,'# Seleção inválida\n-# Selecione apenas membros humanos deste servidor.'));}
          const before=c.adminUserIds||[];c.adminUserIds=ids;
          db.prepare('INSERT INTO ticket_management_config VALUES(?,?) ON CONFLICT(guildId) DO UPDATE SET config=excluded.config').run(i.guildId,JSON.stringify(c));
          audit({id:null,guildId:i.guildId,area:null,ownerId:i.guild.ownerId,assigneeId:null,status:'configuration'},m.id,'general-admins-updated',{added:ids.filter(uid=>!before.includes(uid)),removed:before.filter(uid=>!ids.includes(uid))});
          return respond(i,configCard(i.guildId,true));
        }
        if(action==='cfg-access'){
          if(!AREAS.includes(id))return denied(i);
          const {checked,revoked}=await reconcileAccess(i.guild,id);return respond(i,card(id,`# Acessos revisados\n-# Revisão concluída.\n**Tópicos verificados:** ${checked}\n**Acessos automáticos antigos removidos:** ${revoked}\n-# Novos tickets não adicionam a equipe automaticamente; os cargos configurados são apenas mencionados. Participantes adicionados manualmente, autor e responsável atual são preservados.`));
        }
        if(action==='config')return respond(i,configCard(i.guildId,m.id===i.guild.ownerId));
        if(action==='cfg-area'){
          if(!MANAGEMENT_AREAS.includes(id))return denied(i);const out=card(id,`# Configurações de ${LABEL[id]}\n-# Equipe, canais e permissões da área`).addSeparatorComponents(divider());
          for(const [suffix,label,max] of [['Role','Cargo de gestão',1],['Team','Cargos da equipe',25]]){
            const selected=suffix==='Role'?(c[`${id}Role`]?[c[`${id}Role`]]:[]):c[`${id}Team`]||[];
            out.addActionRowComponents(row(new RoleSelectMenuBuilder().setCustomId(`tg:cfg-role:${id}${suffix}`).setPlaceholder(label).setMinValues(0).setMaxValues(max).setDefaultRoles(...selected.filter(roleId=>i.guild.roles.cache.has(roleId)))));
          }
          if(!AREAS.includes(id)){
            if(id==='passtime')out.addTextDisplayComponents(text(`**Canal contabilizado:** ${c.passtimeChannel?`<#${c.passtimeChannel}>`:'Não definido'}`)).addActionRowComponents(row(new ChannelSelectMenuBuilder().setCustomId('tg:cfg-channel:passtimeChannel').setPlaceholder('Chat para contabilizar o Passtime').setChannelTypes(ChannelType.GuildText).setMinValues(0).setMaxValues(1)));
            else out.addTextDisplayComponents(text('-# Mov Chat contabiliza mensagens e @everyone no servidor inteiro.'));
            return respond(i,out.addActionRowComponents(row(button(`tg:cfg-ranks:${id}`,'Sequência de promoções'))));
          }
          out.addActionRowComponents(row(new ChannelSelectMenuBuilder().setCustomId(`tg:cfg-channel:${id}Category`).setPlaceholder('Categoria de referência').setChannelTypes(ChannelType.GuildCategory).setMinValues(0).setMaxValues(1)))
            .addActionRowComponents(row(new ChannelSelectMenuBuilder().setCustomId(`tg:cfg-channel:${id}Log`).setPlaceholder('Canal de logs privado').setChannelTypes(ChannelType.GuildText).setMinValues(0).setMaxValues(1)))
            .addSeparatorComponents(divider())
            .addTextDisplayComponents(text(`**Permissões da equipe**\n\n${['Close','Transfer','Participants'].map(k=>`**${permissionLabel[k.toLowerCase()]}:** ${enabled(c[`${id}${k}`]??c[k.toLowerCase()])}`).join('\n')}`))
            .addActionRowComponents(row(...['Close','Transfer','Participants'].map(k=>button(`tg:cfg-toggle:${id}${k}`,`${(c[`${id}${k}`]??c[k.toLowerCase()])===false?'Ativar':'Desativar'} ${permissionLabel[k.toLowerCase()].toLowerCase()}`,ButtonStyle.Secondary,painelEmojis.toggleEmoji((c[`${id}${k}`]??c[k.toLowerCase()])!==false)))))
            .addActionRowComponents(row(button(`tg:cfg-access:${id}`,'Revisar acessos'),button(`tg:cfg-ranks:${id}`,'Sequência de promoções')));return respond(i,out);
        }
        if(action==='cfg-toggle'){
          if(!['close','transfer','participants',...AREAS.flatMap(area=>['Close','Transfer','Participants'].map(k=>area+k))].includes(id))return denied(i);
          const fallback=id.replace(/^(support|migration)/,'').toLowerCase();c[id]=!(c[id]??c[fallback]);
        }
        if(action==='cfg-role'){
          if(!['adminRole',...MANAGEMENT_AREAS.flatMap(area=>[`${area}Role`,`${area}Team`])].includes(id))return denied(i);
          if(id==='adminRole'&&m.id!==i.guild.ownerId)return denied(i);
          for(const rid of i.values){const r=await i.guild.roles.fetch(rid);if(!r||r.managed||rid===i.guildId)return denied(i);}
          c[id]=id.endsWith('Team')?i.values:i.values[0]||null;
        }
        if(action==='cfg-channel'){
          if(!['supportCategory','migrationCategory','supportLog','migrationLog','passtimeChannel'].includes(id))return denied(i);
          const channelId=i.values[0]||null;
          if(channelId){const ch=await client.channels.fetch(channelId);if(ch?.guildId!==i.guildId||ch.type!==(id.endsWith('Log')||id==='passtimeChannel'?ChannelType.GuildText:ChannelType.GuildCategory))return denied(i);
            if(id.endsWith('Log')&&(!ch.permissionsFor(i.guild.roles.everyone)||ch.permissionsFor(i.guild.roles.everyone).has(PermissionFlagsBits.ViewChannel)))return respond(i,card(null,'# Canal de logs inválido\n-# Escolha um canal privado, sem Ver canal para @everyone.'));
          }c[id]=channelId;
        }
        db.prepare('INSERT INTO ticket_management_config VALUES(?,?) ON CONFLICT(guildId) DO UPDATE SET config=excluded.config').run(i.guildId,JSON.stringify(c));
        if(id==='supportTeam'||id==='migrationTeam'){data.ticketClaimRoles[i.guildId]??={};if(Array.isArray(data.ticketClaimRoles[i.guildId]))data.ticketClaimRoles[i.guildId]={support:data.ticketClaimRoles[i.guildId],migration:data.ticketClaimRoles[i.guildId]};data.ticketClaimRoles[i.guildId][id==='supportTeam'?'support':'migration']=c[id];save();}
        const configuredArea=MANAGEMENT_AREAS.find(area=>id?.startsWith(area));if(configuredArea)audit({id:null,guildId:i.guildId,area:configuredArea,ownerId:null,assigneeId:null,status:'configuration'},i.user.id,'area-configured',{field:id,value:c[id]});
        return respond(i,configCard(i.guildId,m.id===i.guild.ownerId));
      }
      const ticketActions=['ticket','claim','release','transfer','transfer-to','close','confirm-close','users','users-change','ticket-history'];
      if(!MANAGEMENT_AREAS.some(area=>a[area])&&!ticketActions.includes(action))return denied(i);
      if(action==='home'||action==='open')return respond(i,home(i.guild,m));
      if(action==='history-home'){
        const c=card(null,'# Histórico\n-# Selecione a área que deseja consultar').addSeparatorComponents(divider());
         for(const area of MANAGEMENT_AREAS)if(a[area])c.addSectionComponents(new SectionBuilder().addTextDisplayComponents(text(`**${LABEL[area]}**\n-# Consulte os registros da equipe.`)).setButtonAccessory(button(`tg:history:${area}`,'Visualizar')));
        return respond(i,c);
      }
      if(['area','list','mine','history','stats','search','query','query-page'].includes(action)){
        if(!MANAGEMENT_AREAS.includes(id)||!a[id]||!AREAS.includes(id)&&!['area','history'].includes(action))return denied(i);
        if(action==='area')return respond(i,home(i.guild,m,id));
        if(action==='stats'){const s=stats(i.guildId,id);return respond(i,card(id,`# Estatísticas de ${LABEL[id]}\n-# Resumo dos atendimentos registrados`).addSeparatorComponents(divider()).addTextDisplayComponents(text(`**Em aberto:** ${s.open}\n**Pendentes:** ${s.pending}\n**Em andamento:** ${s.claimed}\n**Concluídos:** ${s.closed}`)));}
        if(action==='list')return respond(i,list(i.guildId,id,parts[3],Number(parts[4])||0));
        if(action==='search')return i.showModal(new ModalBuilder().setCustomId(`tg:query:${id}`).setTitle('Pesquisar tickets').addLabelComponents(new LabelBuilder().setLabel('ID do ticket ou do autor').setTextInputComponent(new TextInputBuilder().setCustomId('query').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(30))));
        if(action==='query')return respond(i,list(i.guildId,id,'all',0,query));
        if(action==='query-page')return respond(i,list(i.guildId,id,'all',Number(parts[3])||0,query));
        if(action==='mine'){
          const rows=db.prepare('SELECT * FROM ticket_management_cases WHERE guildId=? AND area=? AND assigneeId=?').all(i.guildId,id,m.id),closed=rows.filter(t=>t.status==='closed'),times=closed.filter(t=>t.claimedAt&&t.closedAt>=t.claimedAt).map(t=>t.closedAt-t.claimedAt);
          const historical=db.prepare("SELECT DISTINCT ticketId FROM ticket_management_audit WHERE guildId=? AND area=? AND assigneeId=? AND action IN ('claim','transfer-to')").all(i.guildId,id,m.id);
          const claimed=new Set([...rows.map(t=>t.id),...historical.map(t=>t.ticketId)]).size;
          return respond(i,card(id,`# ${id==='support'?'Meus atendimentos':'Minhas migrações'}\n-# Resumo dos seus atendimentos\n**Gestor:** <@${m.id}>\n**Área:** ${LABEL[id]}\n\n**Tickets assumidos:** ${claimed}\n**Tickets concluídos:** ${closed.length}\n**Tickets em andamento:** ${rows.filter(t=>t.status==='open').length}\n**Tempo médio:** ${times.length?`${Math.round(times.reduce((a,b)=>a+b,0)/times.length/60000)} minutos`:'Não disponível'}`));
        }
        return history(i,id,null,Number(parts[3])||0);
      }
      const t=get(id,i.guildId);
      const actionPermission=['close','confirm-close'].includes(action)?'close':['users','users-change'].includes(action)?'participants':['release','transfer','transfer-to'].includes(action)?'transfer':action==='ticket-history'?'view':'claim';
      if(!t||!canOperate(i.guild,m,t,actionPermission))return denied(i);
      if(action==='ticket')return respond(i,detail(t,i.guild));
      if(action==='ticket-history')return history(i,t.area,t.id,Number(parts[3])||0);
      if(action==='close'){if(!canOperate(i.guild,m,t,'close'))return denied(i);return confirm(i,t);}
      if(action==='users'){if(!canOperate(i.guild,m,t,'participants'))return denied(i);return users(i,t);}
      if(action==='transfer'){if(!canOperate(i.guild,m,t,'transfer'))return denied(i);return respond(i,card(t.area,'# Transferir responsável\n-# Selecione o novo responsável pelo atendimento.').addActionRowComponents(row(new UserSelectMenuBuilder().setCustomId(`tg:transfer-to:${id}`).setMinValues(1).setMaxValues(1))));}
      if(['claim','release','transfer-to','confirm-close','users-change'].includes(action))return mutate(i,m,t,action);
      return denied(i);
    }catch(error){console.warn('[Gestão de tickets]',error.message);if(!i.replied)await respond(i,card(null,'# Não foi possível concluir\n-# Ocorreu um erro ao processar a solicitação.').setAccentColor(0)).catch(()=>{});}
  }
  async function history(i,area,id,page=0){
    const count=id?db.prepare('SELECT COUNT(*) n FROM ticket_management_audit WHERE guildId=? AND area=? AND ticketId=?').get(i.guildId,area,id).n:db.prepare('SELECT COUNT(*) n FROM ticket_management_audit WHERE guildId=? AND area=?').get(i.guildId,area).n;
    const pages=Math.max(1,Math.ceil(count/8));page=Math.min(Math.max(0,Math.floor(page)),pages-1);
    const rows=id?db.prepare('SELECT * FROM ticket_management_audit WHERE guildId=? AND area=? AND ticketId=? ORDER BY id DESC LIMIT 8 OFFSET ?').all(i.guildId,area,id,page*8):db.prepare('SELECT * FROM ticket_management_audit WHERE guildId=? AND area=? ORDER BY id DESC LIMIT 8 OFFSET ?').all(i.guildId,area,page*8);
    const lines=rows.map(e=>{
      const d=JSON.parse(e.details||'{}'),beforeAssigned=e.action==='claim'?false:['release','transfer-to'].includes(e.action)?!!d.from:!!e.assigneeId;
      const promotion=['team-promoted','team-promotion-role-added','team-promotion-partial'].includes(e.action);
      const transition='to' in d?`\n**${promotion?'Cargos':'Responsável'}:** ${d.from?`<@${promotion?'&':''}${d.from}>`:'Nenhum'} → ${d.to?`<@${promotion?'&':''}${d.to}>`:'Nenhum'}`:'';
      return `**${ACTION_LABEL[e.action]||safeText(e.action)}** · ${e.ticketId?`#${e.ticketId}`:'Equipe'}\n-# ${e.actorId?`<@${e.actorId}>`:'Sistema ou autor não registrado'} · <t:${Math.floor(e.at/1000)}:f>\n-# ${statusLabel(e.beforeStatus,beforeAssigned)} → ${statusLabel(e.afterStatus,!!e.assigneeId)}${d.userId?`\n**Participante:** <@${d.userId}>`:''}${d.roleId?`\n**Cargo:** <@&${d.roleId}>`:''}${Array.isArray(d.goals)?`\n**Metas semanais:** ${d.goals.slice(0,5).map(g=>`<@&${g.roleId}>: ${Number(g.goal)||0}${g.everyone?` + ${Number(g.everyone)} @everyone`:''}`).join(' · ')}`:''}${transition}`;
    });
    const base=id?`tg:ticket-history:${id}`:`tg:history:${area}`;
    return respond(i,card(area,`# Histórico de ${LABEL[area]}\n-# Registros dos atendimentos\n${lines.join('\n\n')||'-# Nenhum registro disponível.'}`).addActionRowComponents(row(button(`${base}:${Math.max(0,page-1)}:prev`,'<').setDisabled(page===0),button('tg:noop',`${page+1}/${pages}`).setDisabled(true),button(`${base}:${page+1}:next`,'>').setDisabled(page+1>=pages))));
  }
  function confirm(i,t){return respond(i,card(t.area,'# Confirmar encerramento\n-# Você deseja realmente encerrar este atendimento?').addActionRowComponents(row(button(`tg:confirm-close:${t.id}`,'Confirmar',ButtonStyle.Danger),button(`tg:ticket:${t.id}`,'Cancelar'))));}
  function success(i,t,title,body,route=`tg:ticket:${t.id}`){return respond(i,card(t.area,`# ${title}\n-# ${body}`).setAccentColor(0).addActionRowComponents(row(button(route,'Voltar'))));}
  async function users(i,t){const ch=await client.channels.fetch(t.id);const members=await ch.members.fetch();return respond(i,card(t.area,`# Participantes\n-# Selecione membros para adicionar ou remover o acesso.\n**Membros no ticket**\n\n${[...members.values()].map(m=>`<@${m.id}>`).join(', ').slice(0,2500)||'-# Nenhum participante disponível.'}\n\n-# O proprietário do servidor e o autor do ticket são protegidos.`).addActionRowComponents(row(new UserSelectMenuBuilder().setCustomId(`tg:users-change:${t.id}`).setMinValues(1).setMaxValues(10))));}
  async function mutate(i,m,t,action){
    if(locks.has(t.id))return respond(i,card(t.area,'# Operação em andamento\n-# Aguarde a conclusão da solicitação.'));locks.add(t.id);
    try{
      t=get(t.id,i.guildId);m=await member(i);const permission=action==='confirm-close'?'close':action==='users-change'?'participants':action==='claim'?'claim':'transfer';
      if(!canOperate(i.guild,m,t,permission))return denied(i);
      if(t.status!=='open'||data.pendingCloses[t.id])return respond(i,card(t.area,'# Atendimento indisponível\n-# O ticket está fechado ou em encerramento.'));
      if(action==='claim'&&t.assigneeId)return respond(i,card(t.area,`# Ticket em atendimento\n-# Este ticket já foi assumido por <@${t.assigneeId}>.`));
      if(action==='claim'||action==='release'||action==='transfer-to'){
        let uid=action==='release'?null:action==='claim'?m.id:i.values[0];
        if(uid){const target=await i.guild.members.fetch({user:uid,force:true});if(target.user.bot||!canOperate(i.guild,target,t,'claim'))return denied(i);}
        const old=t.assigneeId;db.prepare('UPDATE ticket_management_cases SET assigneeId=?,claimedAt=? WHERE id=?').run(uid,uid?Date.now():null,t.id);
        if(uid)data.claims[t.id]={userId:uid,at:Date.now()};else delete data.claims[t.id];save();audit({...t,assigneeId:uid},m.id,action,{from:old,to:uid});
        if(refreshTicket)await refreshTicket(get(t.id,i.guildId),legacy(i)?i.message:null).catch(()=>console.warn('[Tickets] Atualização da mensagem original indisponível.'));
        const title=action==='claim'?'Ticket assumido':'Ticket atualizado';
      const message=action==='claim'?'Você agora é responsável pelo atendimento.':action==='release'?'O atendimento está disponível para um novo responsável.':'Responsável atualizado com sucesso.';
        return success(i,t,title,message);
      }
      if(action==='users-change'){
        const ch=await client.channels.fetch(t.id);if(ch.guildId!==i.guildId||!ch.isThread?.())return denied(i);
        const existing=await ch.members.fetch();for(const uid of i.values){if(uid===t.ownerId||uid===i.guild.ownerId||uid===client.user.id)continue;
          const target=await i.guild.members.fetch({user:uid,force:true});if(t.confidential&&!canOperate(i.guild,target,t,'claim'))continue;
          if(existing.has(uid)){await ch.members.remove(uid);audit(t,m.id,'participant-removed',{userId:uid});}else{await ch.members.add(uid);audit(t,m.id,'participant-added',{userId:uid});}}
        return success(i,t,'Ticket atualizado','Alterações realizadas com sucesso.',`tg:users:${t.id}`);
      }
      if(action==='confirm-close'){
        const ch=await client.channels.fetch(t.id);if(ch.guildId!==i.guildId)return denied(i);
        db.prepare("UPDATE ticket_management_cases SET status='closed',closedAt=?,closedBy=? WHERE id=? AND status='open'").run(Date.now(),m.id,t.id);audit(t,m.id,'closed',{},'open','closed');
        await closeTicket(i,ch);
        return respond(i,card(t.area,'# Encerramento iniciado\n-# O ticket será excluído em 5 segundos. Histórico preservado.').setAccentColor(0));
      }
    }finally{locks.delete(t.id);}
  }
  async function open(i){try{await i.deferReply({flags:MessageFlags.Ephemeral});const m=await member(i),a=access(i.guild,m);if(!MANAGEMENT_AREAS.some(area=>a[area]))return denied(i);return respond(i,home(i.guild,m));}catch{ return denied(i);}}
  async function openPanel(message){
    try{
      const m=await message.guild.members.fetch({user:message.author.id,force:true}),a=access(message.guild,m);
      if(!MANAGEMENT_AREAS.some(area=>a[area])){
        await message.channel.send({components:[deniedCard({user:message.author})],flags:MessageFlags.IsComponentsV2,allowedMentions:{parse:[]}});return;
      }
      for(const existing of [...panels.values()])if(existing.guildId===message.guild.id&&existing.userId===message.author.id&&existing.channelId===message.channel.id)await closePanel(existing);
      const sent=await message.channel.send({components:[home(message.guild,m,null,true)],flags:MessageFlags.IsComponentsV2,allowedMentions:{parse:[]}});
      registry.preserveMessage?.(sent);
      const panel={guildId:message.guild.id,userId:message.author.id,channelId:message.channel.id,message:sent,at:Date.now(),timer:null};
      if(sent?.id)panels.set(sent.id,panel);schedulePanelExpiry(panel);
    }catch(error){
      console.warn('[Gestão de tickets] Painel indisponível:',error.message);
      await message.channel.send({components:[card(null,'# Não foi possível abrir o painel\n-# Tente novamente em instantes.').setAccentColor(0)],flags:MessageFlags.IsComponentsV2,allowedMentions:{parse:[]}}).catch(()=>{});
    }
  }
  registry.register({name:'gestaotickets',description:'Abre o Painel de Gestão de tickets por área.',category:'Suporte',public:true,
    prefix:{trigger:'!gestao',exact:true,execute:openPanel}});
  registry.register({name:'gestao-tickets',description:'Abre sua gestão privada de tickets por área.',category:'Suporte',public:true,slash:{data:new SlashCommandBuilder().setName('gestao-tickets').setDescription('Abre sua gestão privada de tickets.'),execute:open}});
  client.on('interactionCreate',handle);
  function deleted(ch){
    const t=get(ch.id,ch.guildId);if(!t||t.status==='closed')return;
    db.prepare("UPDATE ticket_management_cases SET status='closed',closedAt=? WHERE id=?").run(Date.now(),t.id);
    audit(t,null,'channel-deleted',{},t.status,'closed');
    delete data.tickets[t.id];delete data.claims[t.id];save();
  }
  client.on('threadDelete',deleted);
  client.on('channelDelete',deleted);
  client.on('threadUpdate',(_before,ch)=>{
    const t=get(ch.id,ch.guildId);if(!t||t.status==='closed')return;
    const status=ch.archived?'archived':'open';if(status!==t.status){db.prepare('UPDATE ticket_management_cases SET status=? WHERE id=?').run(status,t.id);audit(t,null,ch.archived?'archived':'unarchived',{},t.status,status);}
  });
  sync();
  async function reconcileAccess(guild,area){
    sync();const tickets=db.prepare("SELECT * FROM ticket_management_cases WHERE guildId=? AND area=? AND status='open'").all(guild.id,area);
    let checked=0,revoked=0;
    for(const t of tickets){
      const channel=await client.channels.fetch(t.id).catch(()=>null);if(channel?.guildId!==guild.id||!channel.isThread?.())continue;
      for(const {userId} of db.prepare('SELECT userId FROM ticket_management_access WHERE ticketId=?').all(t.id)){
        if(userId===t.ownerId||userId===t.assigneeId||userId===guild.ownerId||userId===client.user.id)continue;
        await channel.members.remove(userId).catch(()=>{});
        db.prepare('DELETE FROM ticket_management_access WHERE ticketId=? AND userId=?').run(t.id,userId);
        audit(t,null,'area-access-revoked',{userId});revoked++;
      }
      checked++;
    }return {checked,revoked};
  }
  return {handlesLegacy:legacy,handle,access,config,canOperate,sync,reconcileAccess,team,activity};
};
