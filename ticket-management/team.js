const {StringSelectMenuBuilder,UserSelectMenuBuilder,ModalBuilder,LabelBuilder,TextInputBuilder,TextInputStyle,PermissionFlagsBits,ButtonStyle}=require('discord.js');
const {randomUUID}=require('node:crypto');
const {weekStart,weekLabel,WEEK_MS}=require('../voice-hours/time');
const {divider,safeText,shorten}=require('./appearance');
const {AREAS,LABEL,TICKET_AREAS}=require('./areas');
const painelEmojis=require('../lumiya-ui/emojis');
module.exports=function createTeam({db,data,config,access,audit,card,text,row,button,denied,respond,membersDirectory,activity}){
  db.exec('CREATE TABLE IF NOT EXISTS ticket_management_weekly_goals(guildId TEXT NOT NULL,area TEXT NOT NULL,roleId TEXT NOT NULL,goal INTEGER NOT NULL,PRIMARY KEY(guildId,area,roleId))');
  db.exec('CREATE TABLE IF NOT EXISTS management_everyone_goals(guildId TEXT NOT NULL,area TEXT NOT NULL,roleId TEXT NOT NULL,goal INTEGER NOT NULL,PRIMARY KEY(guildId,area,roleId))');
  const sessions=new Map(),locks=new Set();
  function remember(i,area,details){
    for(const [key,value] of sessions)if(Date.now()-value.at>600000)sessions.delete(key);
    const token=randomUUID();sessions.set(token,{guildId:i.guildId,userId:i.user.id,area,at:Date.now(),...details});
    while(sessions.size>500)sessions.delete(sessions.keys().next().value);return token;
  }
  function take(i,area,token,type){const s=sessions.get(token);if(!s||s.guildId!==i.guildId||s.userId!==i.user.id||s.area!==area||s.type!==type||Date.now()-s.at>600000)return null;sessions.delete(token);return s;}
  const roleIds=(guildId,area)=>[...new Set(config(guildId)[`${area}Team`]||[])];
  function goal(guildId,area,roleId){const saved=db.prepare('SELECT goal FROM ticket_management_weekly_goals WHERE guildId=? AND area=? AND roleId=?').get(guildId,area,roleId);return saved?Number(saved.goal):TICKET_AREAS.includes(area)?Number(data.ticketGoalsByRole?.[guildId]?.[roleId])||Number(data.ticketGoals?.[guildId])||0:0;}
  const everyoneGoal=(gid,area,rid)=>area==='movchat'?Number(db.prepare('SELECT goal FROM management_everyone_goals WHERE guildId=? AND area=? AND roleId=?').get(gid,area,rid)?.goal)||0:0;
  function goalRole(guild,area,m){return roleIds(guild.id,area).filter(id=>m.roles.cache.has(id)&&(goal(guild.id,area,id)>0||everyoneGoal(guild.id,area,id)>0)).map(id=>guild.roles.cache.get(id)).filter(Boolean).sort((a,b)=>b.comparePositionTo(a))[0];}
  function memberGoal(guild,area,m){const role=goalRole(guild,area,m);return role?goal(guild.id,area,role.id):0;}
  function counts(gid,area,now=Date.now()){
    return new Map(db.prepare("SELECT assigneeId AS userId,COUNT(*) AS total FROM ticket_management_cases WHERE guildId=? AND area=? AND status='closed' AND assigneeId IS NOT NULL AND closedAt>=? AND closedAt<? AND closedAt<=? GROUP BY assigneeId").all(gid,area,weekStart(now),weekStart(now)+WEEK_MS,now).map(r=>[r.userId,Number(r.total)]));
  }
  async function dashboard(i,area,filter='all',page=0){
    const members=await membersDirectory.get(i.guild);
    const isActivity=!TICKET_AREAS.includes(area),ids=roleIds(i.guildId,area),totals=isActivity?activity.totals(i.guildId,area):counts(i.guildId,area),start=weekStart(Date.now());
    const entries=[...members.values()].filter(m=>!m.user.bot&&ids.some(id=>m.roles.cache.has(id))).map(m=>{const role=goalRole(i.guild,area,m),entry={m,goal:role?goal(i.guildId,area,role.id):0,total:isActivity?totals.get(m.id)?.messages||0:totals.get(m.id)||0,everyone:isActivity?totals.get(m.id)?.everyone||0:0,everyoneGoal:role?everyoneGoal(i.guildId,area,role.id):0};entry.hasGoal=entry.goal>0||entry.everyoneGoal>0;entry.met=entry.hasGoal&&entry.total>=entry.goal&&entry.everyone>=entry.everyoneGoal;return entry;});
    const met=entries.filter(e=>e.met).length,pending=entries.filter(e=>e.hasGoal&&!e.met).length,unset=entries.filter(e=>!e.hasGoal).length;
    const visible=entries.filter(e=>filter==='met'?e.met:filter==='pending'?e.hasGoal&&!e.met:filter==='active'?e.total>0:filter==='inactive'?e.total===0:true).sort((a,b)=>b.total-a.total||a.m.id.localeCompare(b.m.id));
    const pages=Math.max(1,Math.ceil(visible.length/6));page=Math.min(Math.max(0,Math.floor(page)),pages-1);
    const c=card(area,`# Equipe de ${LABEL[area]}\n-# Metas semanais · horário de Brasília`).addSeparatorComponents(divider())
      .addTextDisplayComponents(text(`**Semana atual**\n${weekLabel(start)} · Brasília\n\n**Membros:** ${entries.length}${isActivity?`\n**Ativos:** ${entries.filter(e=>e.total>0).length}\n**Sem atividade:** ${entries.filter(e=>!e.total).length}`:''}\n**Meta atingida:** ${met}\n**Meta pendente:** ${pending}\n**Sem meta:** ${unset}`)).addSeparatorComponents(divider());
    for(const e of visible.slice(page*6,page*6+6))c.addTextDisplayComponents(text(`**Membro:** <@${e.m.id}>\n**${isActivity?'Mensagens':'Concluídos'}:** ${e.total}${e.goal?` / ${e.goal}`:''}${area==='movchat'?`\n**@everyone:** ${e.everyone}${e.everyoneGoal?` / ${e.everyoneGoal}`:''}`:''}\n-# ${e.hasGoal?(e.met?'Meta atingida':'Meta pendente'):(isActivity?(e.total?'Ativo nesta semana':'Sem atividade registrada nesta semana'):'Sem meta configurada')}`));
    if(!visible.length)c.addTextDisplayComponents(text('-# Nenhum membro encontrado neste filtro.'));
    c.addSeparatorComponents(divider()).addActionRowComponents(row(button(`tg:team:${area}:all:0`,'Todos'),...(isActivity?[button(`tg:team:${area}:active:0`,'Ativos',ButtonStyle.Secondary,painelEmojis.object('ativo')),button(`tg:team:${area}:inactive:0`,'Inativos',ButtonStyle.Secondary,painelEmojis.object('desativado'))]:[]),button(`tg:team:${area}:met:0`,'Meta atingida'),button(`tg:team:${area}:pending:0`,'Meta pendente')))
      .addActionRowComponents(row(button(`tg:team:${area}:${filter}:${Math.max(0,page-1)}:prev`,'<').setDisabled(page===0),button('tg:team-page',`${page+1}/${pages}`).setDisabled(true),button(`tg:team:${area}:${filter}:${page+1}:next`,'>').setDisabled(page+1>=pages)))
      .addActionRowComponents(row(button(`tg:team-goals:${area}`,'Editar metas'),button(`tg:team-members:${area}:add`,'Adicionar membro'),button(`tg:team-members:${area}:remove`,'Remover membro'),button(`tg:team-promote:${area}`,'Upar membro')))
      .addTextDisplayComponents(text(isActivity?`-# ${area==='movchat'?'Mensagens humanas em todo o servidor; @everyone real, no máximo uma marcação por mensagem.':`Canal contabilizado: ${config(i.guildId).passtimeChannel?`<#${config(i.guildId).passtimeChannel}>`:'não configurado'}.`} Sem meta, ativo significa ao menos uma mensagem na semana.`:'-# Conta tickets concluídos com data e responsável registrados. Se houver várias metas, vale a do cargo mais alto da área.'));
    return c;
  }
  async function rolesPicker(i,area,action){
    await i.guild.roles.fetch();const roles=roleIds(i.guildId,area).map(id=>i.guild.roles.cache.get(id)).filter(Boolean);
    if(!roles.length)return card(area,'# Equipe não configurada\n-# Peça à Administração Geral para definir os cargos de atendimento desta área.');
    const goals=action==='goals',c=card(area,goals?`# Metas por cargo\n-# Selecione até ${area==='movchat'?'dois':'cinco'} cargos para editar metas individuais.`:`# ${action==='add'?'Adicionar':'Remover'} membro\n-# Selecione o cargo da equipe.`);
    const menu=new StringSelectMenuBuilder().setCustomId(goals?`tg:team-goal-select:${area}`:`tg:team-role:${area}:${action}`).setPlaceholder('Cargos da equipe').setMinValues(1).setMaxValues(goals?Math.min(area==='movchat'?2:5,roles.length):1)
      .addOptions(roles.slice(0,25).map(r=>({label:shorten(r.name,100),value:r.id,description:goals?`Meta semanal: ${goal(i.guildId,area,r.id)}`:undefined})));
    return c.addActionRowComponents(row(menu));
  }
  async function validateRole(i,m,area,roleId,target){
    const a=access(i.guild,m),role=await i.guild.roles.fetch(roleId),bot=await i.guild.members.fetchMe({force:true});
    if(!roleIds(i.guildId,area).includes(roleId)||!role||role.managed||roleId===i.guildId)throw new Error('Cargo de atendimento inválido.');
    if(!a.admin&&AREAS.some(other=>other!==area&&roleIds(i.guildId,other).includes(roleId)))throw new Error('Este cargo atende às duas áreas. Solicite a alteração à Administração Geral.');
    if(!bot.permissions.has(PermissionFlagsBits.ManageRoles)||role.comparePositionTo(bot.roles.highest)>=0)throw new Error('O bot precisa de Gerenciar cargos e de um cargo acima do cargo selecionado.');
    if(m.id!==i.guild.ownerId&&role.comparePositionTo(m.roles.highest)>=0)throw new Error('Você só pode alterar cargos abaixo do seu cargo mais alto.');
    if(target){
      if(target.user.bot||target.id===i.guild.ownerId||access(i.guild,target).admin||target.id===m.id)throw new Error('Não é permitido alterar você mesmo, bots, o proprietário ou administradores gerais.');
      if(target.roles.highest.comparePositionTo(bot.roles.highest)>=0||m.id!==i.guild.ownerId&&target.roles.highest.comparePositionTo(m.roles.highest)>=0)throw new Error('A hierarquia do membro impede esta alteração.');
    }return role;
  }
  function record(i,area,action,details){audit({id:null,guildId:i.guildId,area,ownerId:null,assigneeId:null,status:'configuration'},i.user.id,action,details);}
  async function handle(i,m,action,area,parts){
    // Defesa adicional à autorização do dispatcher: nunca confiar no customId.
    m=await i.guild.members.fetch({user:i.user.id,force:true});
    if(!LABEL[area]||!access(i.guild,m)[area])return denied(i);
    try{
      if(action==='team')return respond(i,await dashboard(i,area,parts[3],Number(parts[4])||0));
      if(action==='team-goals'||action==='team-members'){
        if(action==='team-members'&&!['add','remove'].includes(parts[3]))return denied(i);
        return respond(i,await rolesPicker(i,area,action==='team-goals'?'goals':parts[3]));
      }
      if(action==='team-goal-select'){
        const ids=[...new Set(i.values||[])];if(!ids.length||ids.length>(area==='movchat'?2:5)||ids.some(id=>!roleIds(i.guildId,area).includes(id)))return denied(i);
        if(!access(i.guild,m).admin&&ids.some(id=>AREAS.some(other=>other!==area&&roleIds(i.guildId,other).includes(id))))return respond(i,card(area,'# Cargo compartilhado\n-# Metas de cargos compartilhados devem ser configuradas pela Administração Geral.'));
        const token=remember(i,area,{type:'goals',roleIds:ids}),modal=new ModalBuilder().setCustomId(`tg:team-goal-save:${area}:${token}`).setTitle('Metas semanais por cargo');
        for(let n=0;n<ids.length;n++){
          const role=await i.guild.roles.fetch(ids[n]);if(!role)return denied(i);
          modal.addLabelComponents(new LabelBuilder().setLabel(shorten(`${TICKET_AREAS.includes(area)?'Tickets':'Mensagens'} · ${role.name}`,45)).setDescription('Meta semanal opcional. Use 0 para desativar.').setTextInputComponent(new TextInputBuilder().setCustomId(`goal-${n}`).setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(5).setValue(String(goal(i.guildId,area,role.id)))));
          if(area==='movchat')modal.addLabelComponents(new LabelBuilder().setLabel(shorten(`@everyone · ${role.name}`,45)).setDescription('Marcações reais por semana. Use 0 para desativar.').setTextInputComponent(new TextInputBuilder().setCustomId(`everyone-${n}`).setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(5).setValue(String(everyoneGoal(i.guildId,area,role.id)))));
        }return i.showModal(modal);
      }
      if(action==='team-goal-save'){
        const s=take(i,area,parts[3],'goals');if(!s)return respond(i,card(area,'# Seleção expirada\n-# Selecione novamente os cargos da equipe.'));
        const updates=s.roleIds.map((id,n)=>({id,raw:i.fields.getTextInputValue(`goal-${n}`).trim(),everyone:area==='movchat'?i.fields.getTextInputValue(`everyone-${n}`).trim():'0'}));
        if(updates.some(u=>!roleIds(i.guildId,area).includes(u.id)||[u.raw,u.everyone].some(value=>!/^\d{1,5}$/.test(value)||Number(value)>10000)))return respond(i,card(area,'# Meta inválida\n-# Informe números inteiros entre 0 e 10000 para os cargos atuais da equipe.'));
        for(const u of updates)if(!await i.guild.roles.fetch(u.id))return respond(i,card(area,'# Cargo indisponível\n-# Selecione novamente os cargos atuais da equipe.'));
        if(!access(i.guild,m).admin&&updates.some(u=>AREAS.some(other=>other!==area&&roleIds(i.guildId,other).includes(u.id))))return denied(i);
        db.exec('BEGIN IMMEDIATE');try{for(const u of updates){db.prepare('INSERT INTO ticket_management_weekly_goals VALUES(?,?,?,?) ON CONFLICT(guildId,area,roleId) DO UPDATE SET goal=excluded.goal').run(i.guildId,area,u.id,Number(u.raw));if(area==='movchat')db.prepare('INSERT INTO management_everyone_goals VALUES(?,?,?,?) ON CONFLICT(guildId,area,roleId) DO UPDATE SET goal=excluded.goal').run(i.guildId,area,u.id,Number(u.everyone));}record(i,area,'team-goals-updated',{goals:updates.map(u=>({roleId:u.id,goal:Number(u.raw),everyone:Number(u.everyone)}))});db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error;}
        return respond(i,card(area,'# Metas atualizadas\n-# As metas semanais dos cargos selecionados foram salvas.').setAccentColor(0));
      }
      if(action==='team-promote')return respond(i,card(area,'# Upar membro\n-# Selecione um membro para promover ao próximo cargo da sequência.').addActionRowComponents(row(new UserSelectMenuBuilder().setCustomId(`tg:team-promotion-target:${area}`).setMinValues(1).setMaxValues(1))));
      if(action==='team-promotion-target'){
        const target=await i.guild.members.fetch({user:i.values[0],force:true}),ladder=config(i.guildId)[`${area}Ranks`]||[];
        const current=ladder.reduce((last,id,index)=>target.roles.cache.has(id)?index:last,-1);
        if(current<0||current+1>=ladder.length)return respond(i,card(area,'# Promoção indisponível\n-# O membro precisa estar na sequência configurada e ter um próximo cargo disponível.'));
        const from=ladder[current],to=ladder[current+1];await validateRole(i,m,area,from,target);const next=await validateRole(i,m,area,to,target);
        const token=remember(i,area,{type:'promotion',targetId:target.id,from,to});
        return respond(i,card(area,`# Confirmar promoção\n**Membro:** <@${target.id}>\n**Próximo cargo:** ${safeText(next.name)}\n-# A promoção troca somente o cargo atual pelo próximo da sequência.`).addActionRowComponents(row(button(`tg:team-promotion-confirm:${area}:${token}`,'Confirmar',ButtonStyle.Success),button(`tg:team:${area}:all:0`,'Cancelar'))));
      }
      if(action==='team-promotion-confirm'){
        const s=take(i,area,parts[3],'promotion');if(!s)return respond(i,card(area,'# Confirmação expirada\n-# Selecione novamente o membro.'));
        const key=`${i.guildId}:${s.targetId}`;if(locks.has(key))return respond(i,card(area,'# Operação em andamento\n-# Aguarde a promoção atual.'));locks.add(key);
        try{
          const target=await i.guild.members.fetch({user:s.targetId,force:true}),ladder=config(i.guildId)[`${area}Ranks`]||[],current=ladder.reduce((last,id,index)=>target.roles.cache.has(id)?index:last,-1);
          m=await i.guild.members.fetch({user:i.user.id,force:true});if(!access(i.guild,m)[area])return denied(i);
          if(current<0||ladder[current]!==s.from||ladder[current+1]!==s.to)return respond(i,card(area,'# Sequência alterada\n-# Confira o cargo atual e solicite a promoção novamente.'));
          await validateRole(i,m,area,s.from,target);await validateRole(i,m,area,s.to,target);
          // Adiciona antes de remover: uma falha não deixa o membro sem cargo.
          await target.roles.add(s.to,`Promoção ${area}: ${m.id}`);record(i,area,'team-promotion-role-added',{userId:target.id,from:s.from,to:s.to});
          try{await target.roles.remove(s.from,`Promoção ${area}: ${m.id}`);}catch(error){record(i,area,'team-promotion-partial',{userId:target.id,from:s.from,to:s.to});return respond(i,card(area,'# Promoção parcial\n-# O novo cargo foi adicionado, mas o anterior não pôde ser removido. Solicite revisão à Administração Geral.').setAccentColor(0));}
          record(i,area,'team-promoted',{userId:target.id,from:s.from,to:s.to});return respond(i,card(area,'# Membro promovido\n-# O membro avançou um nível na sequência da área.').setAccentColor(0));
        }finally{locks.delete(key);}
      }
      if(action==='team-role'){
        const operation=parts[3],id=i.values?.[0];if(!['add','remove'].includes(operation)||!roleIds(i.guildId,area).includes(id))return denied(i);
        await validateRole(i,m,area,id);
        return respond(i,card(area,`# ${operation==='add'?'Adicionar':'Remover'} membro\n-# Selecione o membro da equipe.`).addActionRowComponents(row(new UserSelectMenuBuilder().setCustomId(`tg:team-target:${area}:${operation}:${id}`).setMinValues(1).setMaxValues(1))));
      }
      if(action==='team-target'){
        const operation=parts[3],roleId=parts[4];if(!['add','remove'].includes(operation))return denied(i);
        const target=await i.guild.members.fetch({user:i.values[0],force:true}),role=await validateRole(i,m,area,roleId,target);
        const token=remember(i,area,{type:'member',operation,roleId,targetId:target.id});
        return respond(i,card(area,`# Confirmar alteração\n**Membro:** <@${target.id}>\n**Cargo:** ${safeText(role.name)}\n**Ação:** ${operation==='add'?'Adicionar':'Remover'}`).addActionRowComponents(row(button(`tg:team-confirm:${area}:${token}`,'Confirmar',operation==='remove'?ButtonStyle.Danger:ButtonStyle.Success),button(`tg:team:${area}:all:0`,'Cancelar'))));
      }
      if(action==='team-confirm'){
        const s=take(i,area,parts[3],'member');if(!s)return respond(i,card(area,'# Confirmação expirada\n-# Selecione novamente o membro da equipe.'));
        const key=`${i.guildId}:${s.targetId}`;if(locks.has(key))return respond(i,card(area,'# Operação em andamento\n-# Aguarde a alteração atual.'));locks.add(key);
        try{
          const target=await i.guild.members.fetch({user:s.targetId,force:true});m=await i.guild.members.fetch({user:i.user.id,force:true});if(!access(i.guild,m)[area])return denied(i);await validateRole(i,m,area,s.roleId,target);
          const hasRole=target.roles.cache.has(s.roleId);if(s.operation==='add'?!hasRole:hasRole){
            if(s.operation==='add')await target.roles.add(s.roleId,`Gestão ${area}: ${m.id}`);else await target.roles.remove(s.roleId,`Gestão ${area}: ${m.id}`);
            record(i,area,s.operation==='add'?'team-member-added':'team-member-removed',{userId:target.id,roleId:s.roleId});
          }
          return respond(i,card(area,'# Equipe atualizada\n-# Alteração de cargo concluída.').setAccentColor(0));
        }finally{locks.delete(key);}
      }return denied(i);
    }catch(error){
      if(error.kind==='member_fetch_rate_limit')return respond(i,card(area,`# Consulta temporariamente limitada\n-# Aguarde ${error.retrySeconds} segundos e tente novamente.`));
      console.warn('[Equipe de tickets]',error.message);
      // Só mensagens de validação conhecidas são exibidas; erros da API ficam internos.
      const known=['Cargo de atendimento inválido.','Este cargo atende às duas áreas. Solicite a alteração à Administração Geral.','O bot precisa de Gerenciar cargos e de um cargo acima do cargo selecionado.','Você só pode alterar cargos abaixo do seu cargo mais alto.','Não é permitido alterar você mesmo, bots, o proprietário ou administradores gerais.','A hierarquia do membro impede esta alteração.'];
      return respond(i,card(area,`# Não foi possível concluir\n-# ${known.includes(error.message)?error.message:'Verifique os cargos e as permissões do bot e tente novamente.'}`).setAccentColor(0));
    }
  }
  return {handle,counts,goal,memberGoal};
};
