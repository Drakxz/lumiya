const {ContainerBuilder,TextDisplayBuilder,ActionRowBuilder,ButtonBuilder,ButtonStyle,ChannelSelectMenuBuilder,UserSelectMenuBuilder,ChannelType,ModalBuilder,LabelBuilder,TextInputBuilder,TextInputStyle,MessageFlags,PermissionFlagsBits}=require('discord.js');
const {memberDirectory}=require('../ticket-management/members');
const {safeText,divider}=require('../ticket-management/appearance');
const DAY=86400000,V2=MessageFlags.IsComponentsV2;
const normalize=value=>String(value||'').normalize('NFKD').replace(/\p{M}/gu,'').replace(/[\u200b-\u200f\u2060\ufeff]/g,'').toLocaleLowerCase('pt-BR');
const {statusText}=require("../error-ui");
const painelEmojis=require("../lumiya-ui/emojis");
const {SALES_MATCH}=require("./ai");
const rulesSignature=c=>JSON.stringify([c.terms,Boolean(c.salesEnabled)]);
const {memberNames,nameSignature}=require("./names");
const text=value=>new TextDisplayBuilder().setContent(statusText(value));
const row=(...items)=>new ActionRowBuilder().addComponents(...items);
const button=(id,label,style=ButtonStyle.Secondary,emoji=null)=>{const b=new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style);if(emoji)b.setEmoji(emoji);return b;};
const card=(title,body,color=0)=>new ContainerBuilder().setAccentColor(color).addTextDisplayComponents(text(`# ${title}\n${body}`));
const payload=(c,ephemeral=true)=>require("../lumiya-ui/canonical").canonical({components:[c],files:require("../configuration/runtime").filesFor([c]),flags:V2|(ephemeral?MessageFlags.Ephemeral:0),allowedMentions:{parse:[]}});
module.exports=function installNicknameProtection({client,registry,db,now=()=>Date.now(),nicknameAI=require('./ai').createNicknameAI()}){
  db.exec(`CREATE TABLE IF NOT EXISTS nickname_protection_config(guildId TEXT PRIMARY KEY,enabled INTEGER NOT NULL DEFAULT 0,terms TEXT NOT NULL DEFAULT '[]',logChannelId TEXT,warningChannelId TEXT);
    CREATE TABLE IF NOT EXISTS nickname_protection_users(guildId TEXT NOT NULL,userId TEXT NOT NULL,warnings INTEGER NOT NULL DEFAULT 0,lastWarningAt INTEGER,nextCheckAt INTEGER NOT NULL DEFAULT 0,active INTEGER NOT NULL DEFAULT 0,bannedAt INTEGER,lastBanAttemptAt INTEGER,PRIMARY KEY(guildId,userId));
    CREATE INDEX IF NOT EXISTS nickname_protection_due ON nickname_protection_users(active,nextCheckAt);
    CREATE TABLE IF NOT EXISTS nickname_protection_audit(id INTEGER PRIMARY KEY,guildId TEXT NOT NULL,userId TEXT,actorId TEXT,action TEXT NOT NULL,warnings INTEGER,createdAt INTEGER NOT NULL,details TEXT NOT NULL);`);
  // Preserva os campos e registros de banimento antigos, sem reutilizá-los para kicks.
  const columns=new Set(db.prepare('PRAGMA table_info(nickname_protection_users)').all().map(c=>c.name));
  for(const name of ['kickedAt','lastKickAttemptAt'])if(!columns.has(name))db.exec(`ALTER TABLE nickname_protection_users ADD COLUMN ${name} INTEGER`);
  if(!db.prepare('PRAGMA table_info(nickname_protection_config)').all().some(c=>c.name==='salesEnabled'))
    db.exec('ALTER TABLE nickname_protection_config ADD COLUMN salesEnabled INTEGER NOT NULL DEFAULT 0');
  const locks=new Set(),scans=new Map(),nextScans=new Map(),directory=memberDirectory(client);let closed=false,maintaining=null;
  const diagnostics=new Map();
  function reportFailure(error){
    const labels={ai_busy:'IA ocupada: limite de duas análises simultâneas',ai_daily_limit:'Limite diário local de IA atingido',
      ai_rate_limit:'IA: cota ou limite de requisições excedido (429)',ai_credentials:'IA: chave sem acesso ou inválida',
      ai_model:'IA: modelo indisponível (404)',ai_timeout:'IA: tempo de resposta excedido',
      ai_connection:'IA: falha de conexão',ai_http:'IA: erro HTTP do provedor',
      ai_unavailable:'IA: serviço do provedor temporariamente indisponível ou sobrecarregado',
      ai_request:'IA: requisição recusada pelo provedor (400)',ai_invalid_response:'IA: resposta fora do formato esperado',
      ai_filtered:'IA: resposta retida pelos filtros do provedor',ai_truncated:'IA: resposta interrompida pelo limite de saída',
      ai_empty:'IA: provedor não retornou uma resposta de texto'};
    const code=Number(error?.code)||null,status=Number(error?.status)||null;
    const reason=labels[error?.kind]||(code===50013?'Discord: permissões insuficientes':code===50001?'Discord: acesso ausente':
      error?.kind==='member_fetch_rate_limit'?'Discord: limite de consulta de membros':'Falha de consulta ou processamento');
    const provider=['gemini','openai','groq','bedrock'].includes(error?.provider)?` · ${error.provider}`:'';
    const key=`${reason}:${code}:${status}`;
    if(diagnostics.has(key)&&now()-diagnostics.get(key)<60000)return;
    diagnostics.set(key,now());
    while(diagnostics.size>30)diagnostics.delete(diagnostics.keys().next().value);
    console.warn(`[Proteção de apelidos] ${reason}${provider}${code?` · código ${code}`:''}${status?` · HTTP ${status}`:''}. Nenhuma punição presumida; nova tentativa posterior.`);
  }
  const settings=gid=>{const c=db.prepare('SELECT * FROM nickname_protection_config WHERE guildId=?').get(gid);return c?{...c,enabled:Boolean(c.enabled),salesEnabled:Boolean(c.salesEnabled),terms:JSON.parse(c.terms)}:{guildId:gid,enabled:false,salesEnabled:false,terms:[],logChannelId:null,warningChannelId:null};};
  const state=(gid,uid)=>db.prepare('SELECT * FROM nickname_protection_users WHERE guildId=? AND userId=?').get(gid,uid);
  function save(c){db.prepare('INSERT INTO nickname_protection_config(guildId,enabled,terms,logChannelId,warningChannelId,salesEnabled) VALUES(?,?,?,?,?,?) ON CONFLICT(guildId) DO UPDATE SET enabled=excluded.enabled,terms=excluded.terms,logChannelId=excluded.logChannelId,warningChannelId=excluded.warningChannelId,salesEnabled=excluded.salesEnabled').run(c.guildId,c.enabled?1:0,JSON.stringify(c.terms),c.logChannelId,c.warningChannelId,c.salesEnabled?1:0);}
  function match(nickname,c){if(!nickname)return null;const n=normalize(nickname);return c.terms.find(term=>n.includes(normalize(term)))||null;}
  async function detect(nickname,c){return match(nickname,c)||await nicknameAI.detect(nickname,c.terms,{sales:c.salesEnabled});}
  async function detectMember(member,c){
    const names=memberNames(member);
    // Correspondências literais claras não dependem da disponibilidade da IA.
    for(const entry of names){const term=match(entry.value,c);if(term)return {...entry,term};}
    let failure;
    for(const entry of names){
      try{const term=await detect(entry.value,c);if(term)return {...entry,term};}
      catch(error){if(!error.kind?.startsWith("ai_"))throw error;failure=error;}
    }
    if(failure)throw failure;
    return null;
  }
  function audit(gid,uid,action,warnings=null,details={},actorId=null){
    db.prepare('INSERT INTO nickname_protection_audit(guildId,userId,actorId,action,warnings,createdAt,details) VALUES(?,?,?,?,?,?,?)').run(gid,uid,actorId,action,warnings,now(),JSON.stringify(details));
    const channelId=settings(gid).logChannelId;
    if(channelId)void (async()=>{const ch=await client.channels.fetch(channelId);if(ch?.guildId!==gid)return;const msg=await ch.send(require("../lumiya-ui/logs").card({
      category:"security",title:"Proteção de nomes",subtitle:action,
      summary:[["Ação",safeText(action)],["Membro",uid?`<@${uid}>`:"Não se aplica"],
        ["Responsável",actorId?`<@${actorId}>`:"Sistema"],...(warnings!==null?[["Avisos",`${warnings}/3`]]:[])],
      metadata:[["Servidor",gid],...(uid?[["Usuário",uid]]:[])],
      botAvatarURL:client.user?.displayAvatarURL?.({size:128}),
      at:now(),source:"Proteção de apelidos"
    }));registry.preserveMessage(msg);})().catch(()=>console.warn('[Proteção de apelidos] Canal de logs indisponível.'));
  }
  function ensure(gid,uid){db.prepare('INSERT OR IGNORE INTO nickname_protection_users(guildId,userId) VALUES(?,?)').run(gid,uid);}
  async function warn(member,count,finding,forced=false){
    const instruction=finding.term===SALES_MATCH
      ?`Altere seu **${finding.label}** para remover o anúncio de vendas que direciona à bio ou ao perfil.`
      :`Altere seu **${finding.label}** para remover o trecho proibido.`;
    const note=forced
      ?'-# Reenvio solicitado manualmente pela equipe. Não aumenta a contagem nem antecipa o intervalo automático de 24 horas.'
      :`-# No máximo um aviso automático por pessoa a cada 24 horas. Os avisos são acumulados, mesmo após corrigir o nome. ${count===3?'O terceiro aviso resulta em tentativa de expulsão (kick) se algum nome continuar proibido.':'O terceiro aviso resulta em tentativa de expulsão automática (kick).'}`;
    const c=settings(member.guild.id),p=payload(card(forced?'Aviso reenviado':'Aviso de nome proibido',`**Servidor:** ${safeText(member.guild.name||member.guild.id)}\n**Aviso:** ${count}/3\n\n${instruction}\n${note}`,0),false);
    try{await member.send(p);return true;}catch{}
    if(c.warningChannelId)try{
      const ch=await client.channels.fetch(c.warningChannelId);
      if(ch?.guildId===member.guild.id&&ch.permissionsFor(member)?.has(PermissionFlagsBits.ViewChannel)){
        p.components[0].addTextDisplayComponents(text(`**Destinatário:** <@${member.id}>`));p.allowedMentions={parse:[],users:[member.id]};const msg=await ch.send(p);registry.preserveMessage(msg);return true;
      }
    }catch{}
    return false;
  }
  async function kick(member){
    if(closed)return;
    const gid=member.guild.id,uid=member.id,s=state(gid,uid),c=settings(gid);
    if(!c.enabled||!s||s.warnings<3||s.kickedAt||!await detectMember(member,c))return;
    db.prepare('UPDATE nickname_protection_users SET lastKickAttemptAt=?,nextCheckAt=? WHERE guildId=? AND userId=?').run(now(),now()+DAY,gid,uid);
    const bot=await member.guild.members.fetchMe({force:true}).catch(()=>null);
    const latest=await member.guild.members.fetch({user:uid,force:true}),latestConfig=settings(gid);
    const signature=nameSignature(latest);
    if(!latestConfig.enabled||!await detectMember(latest,latestConfig)){db.prepare('UPDATE nickname_protection_users SET active=0 WHERE guildId=? AND userId=?').run(gid,uid);return;}
    if(nameSignature(latest)!==signature)return;
    if(closed||!settings(gid).enabled||rulesSignature(settings(gid))!==rulesSignature(latestConfig))return;
    if(uid===member.guild.ownerId||!bot?.permissions.has(PermissionFlagsBits.KickMembers)||latest.kickable!==true){audit(gid,uid,'Expulsão impedida por permissões ou hierarquia',s.warnings);return;}
    try{await latest.kick('Proteção de nomes: três avisos acumulados e nome ainda proibido.');db.prepare('UPDATE nickname_protection_users SET kickedAt=?,active=0 WHERE guildId=? AND userId=?').run(now(),gid,uid);audit(gid,uid,'Expulsão automática confirmada',s.warnings);}
    catch(error){audit(gid,uid,'Falha na tentativa de expulsão',s.warnings,{code:Number(error.code)||null});}
  }
  async function check(guild,userId,{forceWarn=false}={}){
    if(closed)return;
    if(!settings(guild.id).enabled)return;
    const key=`${guild.id}:${userId}`;if(locks.has(key))return;locks.add(key);
    try{
      const member=await guild.members.fetch({user:userId,force:true});if(!member||member.user.bot){db.prepare('UPDATE nickname_protection_users SET active=0 WHERE guildId=? AND userId=?').run(guild.id,userId);return;}
      const c=settings(guild.id);if(!c.enabled)return;
      const signature=nameSignature(member),finding=await detectMember(member,c),s=state(guild.id,userId);
      if(closed||!settings(guild.id).enabled||nameSignature(member)!==signature||rulesSignature(settings(guild.id))!==rulesSignature(c))return;
      if(s?.kickedAt){db.prepare('UPDATE nickname_protection_users SET kickedAt=NULL WHERE guildId=? AND userId=?').run(guild.id,userId);audit(guild.id,userId,'Membro retornou; avisos preservados',s.warnings);}
      if(!finding){if(s){db.prepare('UPDATE nickname_protection_users SET active=0 WHERE guildId=? AND userId=?').run(guild.id,userId);if(s.active)audit(guild.id,userId,'Nome corrigido; contagem preservada',s.warnings);}return;}
      ensure(guild.id,userId);db.prepare('UPDATE nickname_protection_users SET active=1 WHERE guildId=? AND userId=?').run(guild.id,userId);
      const current=state(guild.id,userId);if(current.kickedAt)return;
      if(!forceWarn&&current.nextCheckAt>now())return;
      if(!forceWarn&&current.warnings>=3){await kick(member);return;}
      if(forceWarn){
        const resent=await warn(member,Math.max(1,current.warnings),finding,true);
        audit(guild.id,userId,resent?'Aviso reenviado manualmente':'Reenvio manual não entregue',current.warnings,{term:finding.term,field:finding.field},'manual');
        return {resent:resent?1:0};
      }
      // Reserva persistente antes da rede: eventos repetidos/reinícios não criam rajadas.
      db.prepare('UPDATE nickname_protection_users SET nextCheckAt=? WHERE guildId=? AND userId=?').run(now()+DAY,guild.id,userId);
      const count=current.warnings+1,delivered=await warn(member,count,finding);
      if(!delivered){audit(guild.id,userId,'Aviso não entregue; contagem não aumentou',current.warnings);return;}
      db.prepare('UPDATE nickname_protection_users SET warnings=?,lastWarningAt=?,nextCheckAt=? WHERE guildId=? AND userId=?').run(count,now(),now()+DAY,guild.id,userId);
      audit(guild.id,userId,'Aviso entregue',count,{term:finding.term,field:finding.field});
      if(count===3){const fresh=await guild.members.fetch({user:userId,force:true});await kick(fresh);}
    }catch(error){
      const s=state(guild.id,userId);
      if(Number(error.code)===10007){if(s)db.prepare('UPDATE nickname_protection_users SET active=0 WHERE guildId=? AND userId=?').run(guild.id,userId);}
      else{if(s)db.prepare('UPDATE nickname_protection_users SET nextCheckAt=MAX(nextCheckAt,?) WHERE guildId=? AND userId=?').run(now()+300000,guild.id,userId);reportFailure(error);}
    }finally{locks.delete(key);}
  }
  async function tick(gid=null,{forceWarn=false,ids=null}={}){
    if(closed)return;
    let rows;
    if(ids)rows=[...ids].map(userId=>({guildId:gid,userId}));
    else if(gid)rows=db.prepare(`SELECT guildId,userId FROM nickname_protection_users WHERE guildId=? AND active=1 AND kickedAt IS NULL ${forceWarn?'':'AND nextCheckAt<=? '}ORDER BY nextCheckAt LIMIT ${forceWarn?'1000':'10'}`).all(...(forceWarn?[gid]:[gid,now()]));
    else rows=db.prepare(`SELECT u.guildId,u.userId FROM nickname_protection_users u JOIN nickname_protection_config c ON c.guildId=u.guildId WHERE c.enabled=1 AND u.active=1 AND u.kickedAt IS NULL ${forceWarn?'':'AND u.nextCheckAt<=? '}ORDER BY u.nextCheckAt LIMIT ${forceWarn?'1000':'10'}`).all(...(forceWarn?[]:[now()]));
    const result={processed:0,warnings:0,resent:0,kicked:0};
    for(const r of rows){
      const guild=client.guilds?.cache?.get(r.guildId);if(!guild)continue;
      const before=state(r.guildId,r.userId);
      const outcome=await check(guild,r.userId,{forceWarn});
      const after=state(r.guildId,r.userId);
      result.processed++;
      result.warnings+=Math.max(0,(after?.warnings||0)-(before?.warnings||0));
      result.resent+=outcome?.resent||0;
      if(after?.kickedAt&&!before?.kickedAt)result.kicked++;
    }
    return result;
  }
  async function scan(guild,{forceWarn=false}={}){
    if(closed)return;
    if(!settings(guild.id).enabled)return;
    if(scans.has(guild.id))return scans.get(guild.id);
    const pending=Promise.resolve().then(async()=>{const members=await directory.get(guild),c=settings(guild.id);if(!c.enabled)return;
      const result={checked:0,matched:0,failed:0,withoutName:0},matchedIds=new Set();
      for(const m of members.values()){
        if(closed||!settings(guild.id).enabled||rulesSignature(settings(guild.id))!==rulesSignature(c))return {...result,interrupted:true};
        if(m.user.bot)continue;
        if(!memberNames(m).length){
          result.withoutName++;
          db.prepare('UPDATE nickname_protection_users SET active=0 WHERE guildId=? AND userId=?').run(guild.id,m.id);
          continue;
        }
        const signature=nameSignature(m);
        let finding;
        try{finding=await detectMember(m,c);}
        catch(error){
          if(!error.kind?.startsWith("ai_"))throw error;
          reportFailure(error);result.failed++;continue;
        }
        // Uma alteração durante a chamada da IA invalida o resultado.
        if(closed||!settings(guild.id).enabled||rulesSignature(settings(guild.id))!==rulesSignature(c))return {...result,interrupted:true};
        if(nameSignature(m)!==signature){result.failed++;continue;}
        result.checked++;
        if(finding){
          result.matched++;matchedIds.add(m.id);
          ensure(guild.id,m.id);
          db.prepare('UPDATE nickname_protection_users SET active=1 WHERE guildId=? AND userId=?').run(guild.id,m.id);
        }else db.prepare('UPDATE nickname_protection_users SET active=0 WHERE guildId=? AND userId=?').run(guild.id,m.id);
      }
      Object.assign(result,forceWarn
        ?await tick(guild.id,{forceWarn:true,ids:matchedIds})
        :await tick(guild.id));
      result.waiting=db.prepare('SELECT COUNT(*) n FROM nickname_protection_users WHERE guildId=? AND active=1 AND kickedAt IS NULL AND nextCheckAt>?').get(guild.id,now()).n;
      result.queued=db.prepare('SELECT COUNT(*) n FROM nickname_protection_users WHERE guildId=? AND active=1 AND kickedAt IS NULL AND nextCheckAt<=?').get(guild.id,now()).n;
      return result;
    }).then(result=>{nextScans.set(guild.id,now()+(result?.failed||result?.interrupted?300000:6*3600000));return result;}).catch(error=>{nextScans.set(guild.id,now()+300000);reportFailure(error);throw error;}).finally(()=>scans.delete(guild.id));scans.set(guild.id,pending);return pending;
  }
  async function maintain(){
    if(closed)return;if(maintaining)return maintaining;
    maintaining=Promise.resolve().then(async()=>{
      await tick();let scanned=0;
      for(const c of db.prepare('SELECT guildId FROM nickname_protection_config WHERE enabled=1').all()){
        if(closed||scanned>=2)break;const guild=client.guilds?.cache?.get(c.guildId);
        if(guild&&(nextScans.get(c.guildId)||0)<=now()){scanned++;await scan(guild).catch(()=>console.warn('[Proteção de apelidos] Varredura reagendada.'));}
      }
    }).finally(()=>{maintaining=null;});return maintaining;
  }
  async function authorized(i){const m=await i.guild.members.fetch({user:i.user.id,force:true}).catch(()=>null);return Boolean(m?.permissions.has(PermissionFlagsBits.ManageGuild));}
  async function reply(i,c){const p=payload(c);return i.deferred||i.replied?i.editReply(p):i.reply(p);}
  const deny=i=>reply(i,card('Acesso negado',`-# Você precisa de Gerenciar Servidor.\n**Requisitado por:** <@${i.user.id}>`,0));
  function panel(gid){const c=settings(gid);return card('Proteção de nomes',`-# Somente o apelido do servidor\n\n**Sistema:** ${c.enabled?'Ativado':'Desativado'}\n**IA de variações:** ${nicknameAI.configured?`Ativada (${nicknameAI.provider}) · confiança mínima 98%`:'Indisponível — somente correspondência literal'}\n-# A IA recebe o apelido e os termos cadastrados. Pode gerar custos. Falhas e ambiguidades não geram punição por IA.\n**Intervalo:** 24 horas por pessoa\n**Limite:** três avisos entregues\n**Ação no terceiro aviso:** expulsão (kick)\n**Avisos anteriores:** mantidos após corrigir\n\n**Trechos proibidos:** ${c.terms.length?c.terms.slice(0,12).map(t=>safeText(t,60)).join(' · '):'Nenhum'}${c.terms.length>12?` (+${c.terms.length-12})`:''}\n**Logs:** ${c.logChannelId?`<#${c.logChannelId}>`:'Somente histórico SQLite'}\n**Avisos se a DM estiver fechada:** ${c.warningChannelId?`<#${c.warningChannelId}>`:'Aguardar entrega por DM'}`)
    .addTextDisplayComponents(text(`**Vendas na bio/perfil:** ${c.salesEnabled?'Ativada':'Desativada'}\n-# Detecta anúncios como “nitrada na bio” e “nitrada barata na bio” somente no apelido do servidor, sem abrir perfis ou ler a bio.`))
    .addSeparatorComponents(divider()).addActionRowComponents(row(button('np:terms','Editar trechos'),button('np:toggle',c.enabled?'Desativar':'Ativar',c.enabled?ButtonStyle.Danger:ButtonStyle.Success,painelEmojis.toggleEmoji(c.enabled)),button('np:scan','Verificar agora')))
    .addActionRowComponents(row(button('np:sales',c.salesEnabled?'Desativar vendas':'Ativar vendas',c.salesEnabled?ButtonStyle.Danger:ButtonStyle.Secondary,painelEmojis.toggleEmoji(c.salesEnabled))))
    .addActionRowComponents(row(button('np:users','Consultar avisos'),button('np:reset-users','Zerar avisos')))
    .addActionRowComponents(row(new ChannelSelectMenuBuilder().setCustomId('np:logs').setPlaceholder('Canal privado de logs').setChannelTypes(ChannelType.GuildText).setMinValues(0).setMaxValues(1)))
    .addActionRowComponents(row(new ChannelSelectMenuBuilder().setCustomId('np:warning-channel').setPlaceholder('Canal de avisos quando a DM estiver fechada').setChannelTypes(ChannelType.GuildText).setMinValues(0).setMaxValues(1)));
  }
  async function handle(i){
    if(closed)return;
    if(!i.inGuild?.()||!i.customId?.startsWith('np:'))return;
    try{
      const action=i.customId.split(':')[1];
      if(action!=='terms')await i.deferReply({flags:MessageFlags.Ephemeral});
      if(!await authorized(i))return deny(i);
      const c=settings(i.guildId);
      if(action==='open')return reply(i,panel(i.guildId));
      if(action==='terms')return i.showModal(new ModalBuilder().setCustomId('np:save-terms').setTitle('Trechos proibidos no apelido').addLabelComponents(new LabelBuilder().setLabel('Um trecho por linha').setDescription('Até 50 trechos de 2 a 60 caracteres. Valem somente para o apelido do servidor.').setTextInputComponent(new TextInputBuilder().setCustomId('terms').setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(3100).setValue(c.terms.join('\n')||' '))));
      if(action==='save-terms'){
        const terms=[...new Set(i.fields.getTextInputValue('terms').split(/\r?\n/).map(t=>normalize(t.trim())).filter(Boolean))];
        if(terms.length>50||terms.some(t=>t.length<2||t.length>60))return reply(i,card('Trechos inválidos','-# Use até 50 trechos de 2 a 60 caracteres.',0));
        c.terms=terms;if(!terms.length&&!c.salesEnabled)c.enabled=false;save(c);audit(i.guildId,null,'Trechos proibidos atualizados',null,{count:terms.length},i.user.id);await reply(i,panel(i.guildId));if(c.enabled)await scan(i.guild);return;
      }
      if(action==='sales'){
        if(!c.salesEnabled&&!nicknameAI.configured)return reply(i,card('Configuração incompleta','-# A opção de vendas precisa da IA configurada. Adicione a chave do provedor e reinicie o bot.'));
        c.salesEnabled=!c.salesEnabled;
        if(!c.salesEnabled&&!c.terms.length)c.enabled=false;
        save(c);nextScans.delete(i.guildId);
        audit(i.guildId,null,c.salesEnabled?'Detecção de vendas ativada':'Detecção de vendas desativada',null,{},i.user.id);
        await reply(i,panel(i.guildId));
        if(c.enabled)await scan(i.guild);
        return;
      }
      if(action==='toggle'){
        if(!c.enabled){if(!c.terms.length&&!c.salesEnabled)return reply(i,card('Configuração incompleta','-# Cadastre os trechos proibidos ou ative a opção de vendas antes de ativar.',0));if(!c.terms.length&&c.salesEnabled&&!nicknameAI.configured)return reply(i,card('Configuração incompleta','-# A opção de vendas precisa da IA configurada.'));const bot=await i.guild.members.fetchMe({force:true});if(!bot.permissions.has(PermissionFlagsBits.KickMembers))return reply(i,card('Permissão ausente','-# O bot precisa de Expulsar membros para ativar esta proteção.',0));}
        c.enabled=!c.enabled;save(c);audit(i.guildId,null,c.enabled?'Proteção ativada':'Proteção desativada',null,{},i.user.id);await reply(i,panel(i.guildId));if(c.enabled)await scan(i.guild);return;
      }
      if(action==='logs'||action==='warning-channel'){
        const id=i.values[0]||null;
        if(id){const ch=await client.channels.fetch(id),bot=await i.guild.members.fetchMe({force:true});if(ch?.guildId!==i.guildId||ch.type!==ChannelType.GuildText||!ch.permissionsFor(bot)?.has([PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages]))return reply(i,card('Canal inválido','-# Escolha um canal acessível ao bot neste servidor.',0));if(action==='logs'&&(!ch.permissionsFor(i.guild.roles.everyone)||ch.permissionsFor(i.guild.roles.everyone).has(PermissionFlagsBits.ViewChannel)))return reply(i,card('Canal de logs inválido','-# Os logs precisam de um canal privado.',0));}
        c[action==='logs'?'logChannelId':'warningChannelId']=id;save(c);audit(i.guildId,null,'Canal da proteção atualizado',null,{kind:action,channelId:id},i.user.id);return reply(i,panel(i.guildId));
      }
      if(action==='scan'){
        if(!c.enabled)return reply(i,card('Sistema desativado','-# Ative a proteção antes de verificar.'));
        await reply(i,card('Verificação em andamento','-# Consultando os apelidos do servidor. Aguarde o resultado.'));
        const result=await scan(i.guild,{forceWarn:true});
        if(!result||result.interrupted)return reply(i,card('Verificação interrompida','-# A proteção foi desativada ou as regras mudaram durante a análise. Abra o painel e tente novamente.'));
        const ai=nicknameAI.configured
          ?`${safeText(nicknameAI.model||nicknameAI.provider||'Configurada',100)}`
          :'Indisponível — somente comparação literal; configure a chave do provedor.';
        const details=[
          `**Pessoas verificadas:** ${result.checked}`,
          `**Sem nome disponível:** ${result.withoutName}`,
          `**Ocorrências identificadas:** ${result.matched}`,
          `**Avisos entregues neste lote:** ${result.warnings||0}`,
          `**Avisos reenviados neste lote:** ${result.resent||0}`,
          `**Expulsões confirmadas neste lote:** ${result.kicked||0}`,
          `**Aguardando intervalo ou nova tentativa:** ${result.waiting||0}`,
          `**Na fila para os próximos lotes:** ${result.queued||0}`,
          `**IA:** ${ai}`
        ];
        if(result.failed)details.push(`**Sem conclusão por falha da IA:** ${result.failed}`,
          '-# Esses membros não foram presumidos infratores nem tiveram seus avisos zerados. Uma nova tentativa foi programada.');
        else details.push(result.matched
          ?'-# O clique reenviou o aviso a todos os membros com nome proibido, mesmo antes das 24 horas, sem aumentar a contagem. Falhas de entrega ou análise não contam como aviso entregue.'
          :`-# Nenhum nome analisado correspondeu aos termos cadastrados${c.salesEnabled?' ou à regra de vendas':''}. Somente o apelido do servidor é verificado.`);
        return reply(i,card(result.failed?'Verificação parcial':'Verificação concluída',details.join('\n')));
      }
      if(action==='users'||action==='reset-users')return reply(i,card(action==='users'?'Consultar avisos':'Zerar avisos','-# Selecione o membro.').addActionRowComponents(row(new UserSelectMenuBuilder().setCustomId(action==='users'?'np:user':'np:reset-preview').setMinValues(1).setMaxValues(1))));
      if(action==='user'){const uid=i.values[0],s=state(i.guildId,uid);return reply(i,card('Avisos do membro',`**Membro:** <@${uid}>\n**Avisos acumulados:** ${s?.warnings||0}/3\n**Último aviso:** ${s?.lastWarningAt?`<t:${Math.floor(s.lastWarningAt/1000)}:f>`:'Nenhum'}\n**Expulsão confirmada:** ${s?.kickedAt?'Sim':'Não'}`));}
      if(action==='reset-preview')return reply(i,card('Confirmar limpeza de avisos',`**Membro:** <@${i.values[0]}>\n-# A contagem será zerada. Isso não devolve acesso ao servidor.`).addActionRowComponents(row(button(`np:reset:${i.values[0]}`,'Confirmar',ButtonStyle.Danger),button('np:open','Cancelar'))));
      if(action==='reset'){
        const uid=i.customId.split(':')[2];if(!/^\d{17,20}$/.test(uid))return deny(i);const key=`${i.guildId}:${uid}`;if(locks.has(key))return reply(i,card('Operação em andamento','-# Aguarde a verificação atual.'));
        ensure(i.guildId,uid);db.prepare('UPDATE nickname_protection_users SET warnings=0,lastWarningAt=NULL,nextCheckAt=?,active=0 WHERE guildId=? AND userId=?').run(now()+DAY,i.guildId,uid);audit(i.guildId,uid,'Avisos zerados por administrador',0,{},i.user.id);return reply(i,card('Avisos zerados','-# Nova cobrança de aviso só poderá ocorrer após 24 horas. O acesso ao servidor não é alterado.',0));
      }
      return deny(i);
    }catch(error){
      const code=Number(error.code)||null,status=Number(error.status)||null;
      console.warn(`[Proteção de apelidos] Falha na interação do painel${code?` · código ${code}`:''}${status?` · HTTP ${status}`:''}.`);
      if(error.kind?.startsWith('ai_'))reportFailure(error);
      const detail=error.kind==='member_fetch_rate_limit'?`-# Aguarde ${error.retrySeconds} segundos para consultar os membros.`:
        error.kind?.startsWith('ai_')?'-# A IA não conseguiu concluir a análise. Isso não indica falta de permissão no Discord.':
        [10062,40060].includes(code)?'-# Esta interação expirou ou já foi respondida. Abra o painel novamente.':
        '-# Não foi possível concluir a operação. Verifique o acesso do bot e tente novamente.';
      await reply(i,card('Não foi possível concluir',detail,0)).catch(()=>{});
    }
  }
  function entryPanel(guild){
    return require("../configuration/runtime").decorate(card('Proteção de nomes','-# Abra o painel privado para configurar.').addActionRowComponents(row(button('np:open','Configurar proteção'))),guild,"nickname-entry");
  }
  registry.register({name:'protecaouser',description:'Configura proteção de nomes, vendas e avisos acumulados.',category:'Moderação',permissions:['ManageGuild'],result:'Abre a configuração privada da proteção de nomes.',prefix:{trigger:'!protecaouser',exact:true,execute:async message=>{
    const m=await message.guild.members.fetch({user:message.author.id,force:true});if(!m.permissions.has(PermissionFlagsBits.ManageGuild))return registry.deny(message);
    const msg=await message.channel.send(payload(entryPanel(message.guild),false));registry.preserveMessage(msg);
  }}});
  client.on('interactionCreate',i=>{void handle(i).catch(()=>console.warn('[Proteção de apelidos] Falha contida na interação.'));});
  client.on('guildMemberAdd',m=>{void check(m.guild,m.id).catch(()=>console.warn('[Proteção de apelidos] Verificação de entrada indisponível.'));});
  client.on('guildMemberUpdate',(old,m)=>{if(nameSignature(old)!==nameSignature(m))void check(m.guild,m.id).catch(()=>console.warn('[Proteção de nomes] Verificação de membro indisponível.'));});
  client.once('clientReady',()=>maintain().catch(()=>console.warn('[Proteção de apelidos] Verificação inicial indisponível.')));
  const timer=setInterval(()=>{void maintain().catch(()=>console.warn('[Proteção de apelidos] Verificação periódica indisponível.'));},60000);timer.unref();
  return {settings,save,state,match,check,tick,scan,handle,maintain,entryPanel,close(){closed=true;clearInterval(timer);}};
};
