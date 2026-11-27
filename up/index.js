const { randomUUID } = require("node:crypto");
const {
  ContainerBuilder,TextDisplayBuilder,SeparatorBuilder,SeparatorSpacingSize,SectionBuilder,ThumbnailBuilder,
  ActionRowBuilder,ButtonBuilder,ButtonStyle,RoleSelectMenuBuilder,ChannelSelectMenuBuilder,
  StringSelectMenuBuilder,ModalBuilder,LabelBuilder,TextInputBuilder,TextInputStyle,
  MessageFlags,PermissionFlagsBits,ChannelType,SlashCommandBuilder
}=require("discord.js");
const {UpEngine,validateRole}=require("./engine");
const {formatDuration,weekStart,DAY_MS}=require("../voice-hours/time");
const {serverName}=require("../brand");
const {statusText}=require("../error-ui");
const painelEmojis=require("../lumiya-ui/emojis");

module.exports=function instalarUp({client,hours,history,responderSemPermissao}) {
  const commands=require("../command-system/registry").getCommandRegistry(client,{deny:responderSemPermissao});
  const V2=MessageFlags.IsComponentsV2, PRIVATE=V2|MessageFlags.Ephemeral;
  const admin=member=>Boolean(member?.permissions.has(PermissionFlagsBits.ManageGuild));
  const text=content=>new TextDisplayBuilder().setContent(statusText(content));
  const sep=()=>new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small);
  const box=(title,description,color=0)=>new ContainerBuilder().setAccentColor(color)
    .addTextDisplayComponents(text(title),...(description?[text(description)]:[]));
  const named=(guild,label)=>`# ${label} | ${serverName(guild)}`;
  const guildOf=s=>client.guilds?.cache?.get(s.guildId);
  const button=(s,action,label,style=ButtonStyle.Secondary,emoji=null)=>{
    const b=new ButtonBuilder().setCustomId(`up:${action}:${s.id}`).setLabel(label).setStyle(style);
    if(emoji)b.setEmoji(emoji);
    return b;
  };
  const row=(...components)=>new ActionRowBuilder().addComponents(...components);
  const role=(guild,id)=>id?(guild.roles.cache.has(id)?`<@&${id}>`:`Cargo indisponível (${id})`):"Não configurado";
  const goal=ms=>`${Number((ms/3600000).toFixed(6))} horas`;
  const payload=(container,privada=false)=>require("../lumiya-ui/canonical").canonical({components:[container],files:require("../configuration/runtime").filesFor([container]),flags:privada?PRIVATE:V2,allowedMentions:{parse:[]}});
  const engine=new UpEngine({client,hours,history,notify});
  const db=engine.store;
  const bioGate=require('./bio-gate').createBioGate({engine,client,history,validateRole});engine.bioGate=bioGate;
  hours.maintenanceForMember=member=>{
    if(!member||!db.config(member.guild.id).enabled)return null;
    const level=db.levels(member.guild.id).filter(l=>member.roles.cache.has(l.roleId)).at(-1);
    if(!level||level.requiredMs===0)return null;
    const rule=db.maintenance(member.guild.id,level.roleId);
    if(!rule?.requiredMs)return null;
    const cargo=member.guild.roles.cache.get(level.roleId);
    const color=cargo?.hexColor&&cargo.hexColor!=="#000000"?cargo.hexColor:"#ffffff";
    return {requiredMs:rule.requiredMs,roleName:cargo?.name||"Cargo",roleColor:color};
  };
  const busy=new Set();
  function session(guildId,userId,isAdmin=false) {
    return db.session({id:randomUUID(),guildId,userId,admin:isAdmin,view:isAdmin?"admin":"home",page:1});
  }

  function publicPanel(guild,s=null) {
    const description="Evolua dentro do servidor apenas participando das nossas calls!\n\n"+
      "Acumule horas em canais de voz, desbloqueie novos cargos e avance automaticamente na hierarquia.\n\n"+
      "**Como funciona?**\n- Resgate seu cargo inicial.\n- Participe dos canais de voz.\n"+
      "- Acumule horas e desbloqueie novos cargos.\n- Acompanhe sua evolução em tempo real.\n\n**Sua jornada começa aqui.**";
    const c=new ContainerBuilder().setAccentColor(require("../panel-art/colors").panelColor(guild));
    const title=named(guild,"Progressão de Cargos");
    const icon=guild?.iconURL?.({extension:"png",size:256});
    if(icon)c.addSectionComponents(new SectionBuilder().addTextDisplayComponents(text(title),text(description))
      .setThumbnailAccessory(new ThumbnailBuilder().setURL(icon)));
    else c.addTextDisplayComponents(text(title),text(description));
    if(bioGate.enabled)c.addTextDisplayComponents(text('-# Para resgatar e manter os cargos de UP, mantenha /mds na sua bio. Perfis indisponíveis ou privados podem impedir a verificação.'));
    const b=(action,label,style)=>s?button(s,action,label,style):new ButtonBuilder().setCustomId(`up:${action}`).setLabel(label).setStyle(style);
    return require("../panel-art/appearance").applyPanelAppearance(
      c.addSeparatorComponents(sep()).addActionRowComponents(row(
        b("claim","Resgatar Cargo Inicial",ButtonStyle.Primary),b("mine","Minha Progressão",ButtonStyle.Secondary),b("levels","Ver Cargos",ButtonStyle.Secondary))),
      guild,"up");
  }
  async function notify(guild,op,config) {
    const channel=await guild.channels.fetch(config.notificationChannel);
    if(!channel?.isTextBased() || channel.guildId!==guild.id) throw new Error("Canal de notificações indisponível.");
    const earned=new Set(db.unlocks(guild.id,op.userId).map(item=>item.levelId));
    const next=db.levels(guild.id).find(l=>!earned.has(l.id) && l.requiredMs>op.requiredMs);
    const c=box("# Novo cargo desbloqueado!",
      `Parabéns, <@${op.userId}>!\n\nSua participação nas calls desbloqueou uma nova conquista.\n\n`+
      `**Cargo anterior:** ${role(guild,op.previousRoleId)}\n**Novo cargo:** ${role(guild,op.roleId)}\n`+
      `**Horas acumuladas:** ${formatDuration(op.hoursMs)}\n**Próxima evolução:** ${next?role(guild,next.roleId):"Último nível alcançado"}\n`+
      `**Meta seguinte:** ${next?goal(next.requiredMs):"Concluída"}`)
      .addSeparatorComponents(sep()).addTextDisplayComponents(text("**Continue participando das calls para alcançar o próximo nível!**"));
    await channel.send({...payload(c),allowedMentions:{parse:[],users:[op.userId]},
      nonce:BigInt(`0x${op.id.replaceAll("-","").slice(0,16)}`).toString(),enforceNonce:true});
  }
  function adminPanel(guild,s) {
    const config=db.config(guild.id),levels=db.levels(guild.id);s.revision=config.revision;
    return box(named(guild,"Administração de UP"),"-# Configure a progressão automática de cargos.")
      .addSeparatorComponents(sep()).addTextDisplayComponents(text(
        `**Sistema:** ${config.enabled?"Ativado":"Desativado"}\n**Cargo inicial:** ${role(guild,levels[0]?.roleId)}\n`+
        `**Cargos configurados:** ${levels.length}\n**Último cargo:** ${role(guild,levels.at(-1)?.roleId)}\n`+
        `**Tempo máximo configurado:** ${levels.length?goal(levels.at(-1).requiredMs):"Não configurado"}\n`+
        `**Membros participantes:** ${db.participants(guild.id)}\n**Contar tempo mutado:** ${config.countMuted?"Sim":"Não"}\n`+
        `**Remover cargo anterior:** ${config.removePrevious?"Sim":"Não"}\n**Verificação de bio /mds:** ${bioGate.enabled?'Ativa (token configurado; consulta não oficial)':'Desativada (token não configurado)'}`))
      .addSeparatorComponents(sep()).addActionRowComponents(
        row(button(s,"add","Adicionar Cargo"),button(s,"edit","Editar Cargo")),
        row(button(s,"remove","Remover Cargo"),button(s,"settings","Configurações")),
        row(button(s,"levels","Ver Hierarquia"),button(s,"toggle",config.enabled?"Desativar":"Ativar",config.enabled?ButtonStyle.Danger:ButtonStyle.Success,painelEmojis.toggleEmoji(config.enabled))));
  }
  function settingsPanel(guild,s) {
    const config=db.config(guild.id);s.revision=config.revision;
    const extras=config.initialRoles.map(id=>role(guild,id)).join(", ")||"Nenhuma";
    return box(named(guild,"Configurações de UP"),
      `**Contar tempo mutado:** ${config.countMuted?"Sim":"Não"}\n**Remover cargo anterior:** ${config.removePrevious?"Sim":"Não"}\n`+
      `**Usar horas anteriores ao resgate:** ${config.retroactive?"Sim":"Não"}\n**Iniciais adicionais:** ${extras}\n`+
      `**Canais excluídos:** ${config.excludedChannels.map(id=>`<#${id}>`).join(", ")||"Nenhum"}\n`+
      `**AFK:** ${guild.afkChannelId?`<#${guild.afkChannelId}> (sempre excluído)`:"Não configurado"}\n`+
      `**Notificações:** ${config.notificationChannel?`<#${config.notificationChannel}>`:"Desativadas"}\n`+
      "-# Horas anteriores só incluem intervalos detalhados disponíveis. Metas alteradas não rebaixam conquistas automaticamente.")
      .addSeparatorComponents(sep()).addActionRowComponents(
        row(button(s,"muted","Tempo mutado",config.countMuted?ButtonStyle.Primary:ButtonStyle.Secondary),
          button(s,"previous","Remover anterior",config.removePrevious?ButtonStyle.Primary:ButtonStyle.Secondary),
          button(s,"retro","Horas anteriores",config.retroactive?ButtonStyle.Primary:ButtonStyle.Secondary)),
        row(new RoleSelectMenuBuilder().setCustomId(`up:initials:${s.id}`).setPlaceholder("Cargos iniciais adicionais (opcional)").setMinValues(0).setMaxValues(5)),
        row(new ChannelSelectMenuBuilder().setCustomId(`up:excluded:${s.id}`).setPlaceholder("Canais de voz excluídos (limpe para remover)")
          .setChannelTypes(ChannelType.GuildVoice,ChannelType.GuildStageVoice).setMinValues(0).setMaxValues(25)),
        row(new ChannelSelectMenuBuilder().setCustomId(`up:notification:${s.id}`).setPlaceholder("Canal de notificações (opcional)")
          .setChannelTypes(ChannelType.GuildText,ChannelType.GuildAnnouncement).setMinValues(0).setMaxValues(1)),
        row(button(s,"recalcconfirm","Recalcular participantes",ButtonStyle.Danger),button(s,"admin","Voltar")));
  }
  function hierarchy(guild,s) {
    const levels=db.levels(guild.id), config=db.config(guild.id), member=db.member(guild.id,s.userId);
    const elapsed=member?engine.eligible(guild,member,config):0;
    const earned=new Set(db.unlocks(guild.id,s.userId).map(item=>item.levelId));
    const pages=Math.max(1,Math.ceil(levels.length/6));s.page=Math.min(Math.max(1,s.page),pages);
    const c=box(named(guild,"Hierarquia de Cargos"),"-# Confira os cargos disponíveis e suas metas.").addSeparatorComponents(sep());
    const visible=levels.slice((s.page-1)*6,s.page*6);
    if(!visible.length)c.addTextDisplayComponents(text("Nenhum cargo de progressão configurado."));
    visible.forEach((level,index)=>{
      if(index)c.addSeparatorComponents(sep());
      const current=member?.currentLevelId===level.id;
      const unlocked=earned.has(level.id);
      const status=current?"🔵 Cargo atual":unlocked?"✅ Desbloqueado":member && elapsed>=level.requiredMs
        ? "⏳ Meta atingida · evolução aguardando processamento"
        : `🔒 Bloqueado${member?` · Faltam ${formatDuration(Math.max(0,level.requiredMs-elapsed))}`:""}`;
      c.addTextDisplayComponents(text(`**${role(guild,level.roleId)}**\n${goal(level.requiredMs)} necessárias\n${status}`));
    });
    return c.addSeparatorComponents(sep()).addActionRowComponents(row(
      button(s,"prev","<").setDisabled(s.page===1),button(s,"info",`${s.page}/${pages}`).setDisabled(true),
      button(s,"next",">").setDisabled(s.page===pages),button(s,s.admin?"admin":"mine","Voltar")));
  }
  async function mine(guild,s) {
    const member=db.member(guild.id,s.userId);
    if(!member)return box(named(guild,"Minha Progressão"),"Você ainda não iniciou sua jornada.")
      .addActionRowComponents(row(button(s,"claim","Resgatar Cargo Inicial",ButtonStyle.Primary),button(s,"home","Voltar")));
    if(member.state!=="active")return box(named(guild,"Minha Progressão"),
      "Seu resgate está registrado e aguarda conclusão. A equipe deve verificar se o sistema está ativo e se o bot consegue gerenciar os cargos. Suas horas não serão reiniciadas.")
      .addActionRowComponents(row(button(s,"mine","Atualizar"),button(s,"home","Voltar")));
    const levels=db.levels(guild.id),config=db.config(guild.id),elapsed=engine.eligible(guild,member,config);
    const earned=new Set(db.unlocks(guild.id,s.userId).map(item=>item.levelId));
    const next=levels.find(l=>!earned.has(l.id) && l.requiredMs>member.bestMs),base=Math.max(0,member.bestMs);
    const ratio=next?Math.max(0,Math.min(1,(elapsed-base)/(next.requiredMs-base))):1;
    const percent=Math.floor(ratio*100),filled=Math.floor(ratio*10);
    const target=await guild.members.fetch(s.userId);
    const stats=hours.stats(guild.id,s.userId),now=Date.now();
    const today=weekStart(now)+Math.floor((now-weekStart(now))/DAY_MS)*DAY_MS;
    const day=hours.eligible(guild.id,s.userId,{since:today});
    const c=box(named(guild,"Minha Progressão"),"-# Acompanhe sua evolução nos canais de voz.")
      .addSeparatorComponents(sep()).addSectionComponents(new SectionBuilder().addTextDisplayComponents(text(
        `**Usuário:** <@${s.userId}>\n**Cargo atual:** ${role(guild,member.currentRoleId)}\n`+
        `**Próximo cargo:** ${next?role(guild,next.roleId):"Último nível alcançado"}\n**Horas acumuladas:** ${formatDuration(elapsed)}\n`+
        `**Meta:** ${next?goal(next.requiredMs):"Concluída"}\n**Faltam:** ${formatDuration(next?Math.max(0,next.requiredMs-elapsed):0)}`))
        .setThumbnailAccessory(new ThumbnailBuilder().setURL(target.displayAvatarURL({extension:"png",size:256}))))
      .addSeparatorComponents(sep()).addTextDisplayComponents(text(
        `**${next?`Progresso para ${role(guild,next.roleId)}`:"Jornada concluída"}**\n`+
        `\`${"█".repeat(filled)}${"░".repeat(10-filled)}\` **${percent}%**\n`+
        `${formatDuration(elapsed)} / ${next?formatDuration(next.requiredMs):formatDuration(base)}\n`+
        (next?`${percent}% do percurso entre ${role(guild,member.currentRoleId)} (${goal(base)}) e ${role(guild,next.roleId)} (${goal(next.requiredMs)}) concluído.`:"Todos os níveis disponíveis foram alcançados.")))
      .addSeparatorComponents(sep()).addTextDisplayComponents(text(
        `**Cargos desbloqueados:** ${levels.filter(l=>earned.has(l.id)).length}/${levels.length}\n`+
        `**Início da jornada:** <t:${Math.floor(member.joinedAt/1000)}:R>\n`+
        `**Última evolução:** ${member.lastEvolution?`<t:${Math.floor(member.lastEvolution/1000)}:R>`:"Resgate em processamento"}\n`+
        `**Tempo em call hoje:** ${formatDuration(day)}\n**Tempo em call nesta semana:** ${formatDuration(stats.weekCallMs)}\n`+
        "-# Hoje/semana mostram call geral; a progressão aplica as regras de elegibilidade do servidor."));
    if(bioGate.enabled){const check=bioGate.status(guild.id,s.userId);c.addTextDisplayComponents(text(`**Bio /mds:** ${check?.status==='present'?'Confirmada':check?.status==='missing'?'Não encontrada':check?.reason==='inaccessible_or_private'?'Perfil indisponível ou privado':'Aguardando verificação ou serviço indisponível'}${check?.checkedAt?`\n-# Última consulta: <t:${Math.floor(check.checkedAt/1000)}:R>`:''}`));}
    c.addActionRowComponents(row(button(s,"levels","Ver Cargos"),button(s,"mine","Atualizar"),button(s,"home","Voltar")));
    return c;
  }
  function picker(s,kind) {
    const title=kind==="add"?"Adicionar cargo":kind==="edit"?"Editar cargo":"Remover cargo";
    return box(named(guildOf(s),title),"Selecione um cargo do servidor.")
      .addActionRowComponents(row(new RoleSelectMenuBuilder().setCustomId(`up:pick${kind}:${s.id}`).setMinValues(1).setMaxValues(1)),row(button(s,"admin","Voltar")));
  }
  function editForm(guild,s) {
    const level=db.levels(guild.id).find(l=>l.id===s.draft.levelId);
    if(!level)throw new Error("Nível não encontrado.");
    return box(named(guild,"Editar cargo"),`**Cargo selecionado:** ${role(guild,s.draft.roleId)}\n**Meta atual:** ${goal(level.requiredMs)}\nSelecione outro cargo abaixo ou altere a meta. A ordem segue as horas acumuladas.`)
      .addActionRowComponents(row(new RoleSelectMenuBuilder().setCustomId(`up:replace:${s.id}`).setMinValues(1).setMaxValues(1)),
         row(button(s,"hours","Definir horas e salvar",ButtonStyle.Primary),button(s,"maintenance","Meta semanal"),button(s,"admin","Cancelar")))
      .addTextDisplayComponents(text(`**Manutenção semanal:** ${db.maintenance(guild.id,level.roleId)?.requiredMs?goal(db.maintenance(guild.id,level.roleId).requiredMs):"Sem meta"}`));
  }
  function hoursModal(s) {
    const level=s.draft.levelId?db.levels(s.guildId).find(l=>l.id===s.draft.levelId):null;
    const input=new TextInputBuilder().setCustomId("hours").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(16)
      .setPlaceholder("Horas acumuladas: 0 para o cargo inicial");
    if(level)input.setValue(String(level.requiredMs/3600000));
    return new ModalBuilder().setCustomId(`up:save:${s.id}`).setTitle("Meta acumulada de horas")
      .addLabelComponents(new LabelBuilder().setLabel("Horas necessárias").setDescription("Aceita decimais. Não são horas adicionais após o nível anterior.").setTextInputComponent(input));
  }
  async function render(guild,s) {
    if(s.view==="admin")return adminPanel(guild,s);
    if(s.view==="settings")return settingsPanel(guild,s);
    if(s.view==="levels")return hierarchy(guild,s);
    if(s.view==="mine")return mine(guild,s);
    return publicPanel(guild,s);
  }
  async function openAdmin(origin,privateReply) {
    const s=session(origin.guild.id,(origin.user||origin.author).id,true);
    const c=adminPanel(origin.guild,s);db.session(s);
    return origin.author?origin.reply(payload(c)):origin.editReply(payload(c,privateReply));
  }
  async function fail(origin,error) {
    console.warn("[UP]",error.message);
    const p=payload(box("# Não foi possível",error.code?"O Discord recusou a operação. Verifique as permissões e a hierarquia do bot.":error.message,0),!origin.author);
    await (origin.author?origin.reply(p):(origin.deferred||origin.replied)?origin.followUp(p):origin.reply(p)).catch(()=>{});
  }
  async function claimView(i,s,selected=null) {
    const config=db.config(i.guildId),levels=db.levels(i.guildId);
    if(!config.enabled || !levels.length)throw new Error("A progressão está desativada ou não foi configurada.");
    const initials=[...new Set([levels[0].roleId,...config.initialRoles])];
    if(!selected && initials.length>1) {
      return box("# Escolha seu cargo inicial","Selecione uma das opções autorizadas.")
        .addActionRowComponents(row(new StringSelectMenuBuilder().setCustomId(`up:initial:${s.id}`).setMinValues(1).setMaxValues(1)
          .addOptions(initials.map(id=>({label:(i.guild.roles.cache.get(id)?.name||id).slice(0,100),value:id})))),row(button(s,"home","Voltar")));
    }
    const result=await engine.claim(i.guild,s.userId,selected||initials[0]);
    s.view="mine";
    return box("# Cargo resgatado",`Você recebeu o cargo ${role(i.guild,result.roleId)}!\n\n`+
      `Continue participando das calls para desbloquear seu próximo cargo.\n\n**Próxima evolução:** ${result.next?role(i.guild,result.next.roleId):"Último nível"}\n`+
      `**Necessário:** ${result.next?goal(result.next.requiredMs):"Concluído"}`,0)
      .addActionRowComponents(row(button(s,"mine","Ver minha progressão",ButtonStyle.Primary)));
  }

  const adminActions=new Set(["admin","add","edit","remove","settings","toggle","muted","previous","retro","initials","excluded","notification",
     "pickadd","pickedit","pickremove","replace","hours","save","maintenance","savemaintenance","confirmremove","recalcconfirm","recalculate"]);
  client.on("interactionCreate",async i=>{
    try {
    if(!i.inGuild())return;
    if(!i.customId?.startsWith("up:"))return;
    const [,action,id]=i.customId.split(":");
    let s=id?db.getSession(id):null;
    if(!id && ["claim","mine","levels"].includes(action))s=session(i.guildId,i.user.id);
    if(!s || s.guildId!==i.guildId || s.userId!==i.user.id || ((s.admin || adminActions.has(action)) && (!s.admin || !admin(i.member)))) {
      return responderSemPermissao(i).catch(()=>{});
    }
    if(busy.has(s.id))return fail(i,new Error("Há uma operação em andamento neste painel. Aguarde."));
    busy.add(s.id);
    try {
      if(action==="maintenance") {
        if(!s.draft?.levelId)throw new Error("Selecione um nível primeiro.");
        const level=db.levels(i.guildId).find(l=>l.id===s.draft.levelId);
        if(!level||level.requiredMs===0)throw new Error("O cargo inicial não exige manutenção.");
        const input=new TextInputBuilder().setCustomId("hours").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(16)
          .setValue(String((db.maintenance(i.guildId,level.roleId)?.requiredMs||0)/3600000));
        await i.showModal(new ModalBuilder().setCustomId(`up:savemaintenance:${s.id}`).setTitle("Manutenção semanal do cargo")
          .addLabelComponents(new LabelBuilder().setLabel("Horas por semana (0 desativa)")
            .setDescription("Segunda a domingo · Brasília. Inclui mutados. Descumprir rebaixa um nível.").setTextInputComponent(input)));
        return;
      }
      if(action==="hours" || action==="pickadd") {
        if(action==="pickadd")s.draft={levelId:null,roleId:i.values[0]};
        if(!s.draft)throw new Error("Selecione o cargo primeiro.");
        db.session(s);await i.showModal(hoursModal(s));return;
      }
      if(id)await i.deferUpdate();else await i.deferReply({flags:MessageFlags.Ephemeral});
      let container=null;
      if(action==="claim" || action==="initial")container=await claimView(i,s,action==="initial"?i.values[0]:null);
      else if(["home","mine","levels","admin","settings"].includes(action)) {
        s.view=action;if(action==="levels")s.page=1;
        if(action==="mine")await engine.advance(i.guildId,s.userId);
      } else if(action==="prev" || action==="next")s.page+=action==="next"?1:-1;
      else if(["add","edit","remove"].includes(action)) {s.revision=db.config(i.guildId).revision;container=picker(s,action);}
      else if(action==="pickedit" || action==="pickremove") {
        const level=db.levels(i.guildId).find(l=>l.roleId===i.values[0]);
        if(!level)throw new Error("Escolha um cargo que esteja configurado na progressão.");
        s.draft={levelId:level.id,roleId:level.roleId};
        container=action==="pickedit"?editForm(i.guild,s):box("# Remover nível?",`Remover ${role(i.guild,level.roleId)} da configuração não apaga os registros nem retira conquistas anteriores.`)
          .addActionRowComponents(row(button(s,"confirmremove","Confirmar remoção",ButtonStyle.Danger),button(s,"admin","Cancelar")));
      } else if(action==="replace") {s.draft.roleId=i.values[0];container=editForm(i.guild,s);}
      else if(action==="savemaintenance") {
        const input=i.fields.getTextInputValue("hours").trim().replace(",",".");
        if(!/^\d+(?:\.\d{1,6})?$/.test(input))throw new Error("Informe horas semanais não negativas.");
        const level=db.levels(i.guildId).find(l=>l.id===s.draft?.levelId);
        if(!level||!level.requiredMs)throw new Error("Selecione um cargo avançado.");
        db.saveMaintenance(i.guildId,level.roleId,Math.round(Number(input)*3600000),s.revision);
        s.draft=null;s.view="admin";engine.wakeGuild(i.guildId);
      }
      else if(action==="save") {
        const input=i.fields.getTextInputValue("hours").trim().replace(",",".");
        if(!/^\d+(?:\.\d{1,6})?$/.test(input))throw new Error("Informe um número de horas não negativo, com até seis casas decimais.");
        const requiredMs=Math.round(Number(input)*3600000);
        const selected=await i.guild.roles.fetch(s.draft.roleId);validateRole(i.guild,selected,i.member);
        db.saveLevel(i.guildId,{id:s.draft.levelId,roleId:selected.id,requiredMs},s.revision);
        s.draft=null;s.view="admin";
      } else if(action==="confirmremove") {db.removeLevel(i.guildId,s.draft.levelId,s.revision);s.draft=null;s.view="admin";}
      else if(action==="toggle") {
        const config=db.config(i.guildId),levels=db.levels(i.guildId);
        if(!config.enabled) {
          if(!levels.length || levels[0].requiredMs!==0)throw new Error("Configure um cargo inicial com 0 horas antes de ativar.");
          for(const id of new Set([...levels.map(l=>l.roleId),...config.initialRoles]))validateRole(i.guild,await i.guild.roles.fetch(id),i.member);
        }
        db.saveConfig(i.guildId,{enabled:!config.enabled},s.revision);s.view="admin";engine.scan();
      } else if(["muted","previous","retro"].includes(action)) {
        const key={muted:"countMuted",previous:"removePrevious",retro:"retroactive"}[action];
        const config=db.config(i.guildId);db.saveConfig(i.guildId,{[key]:!config[key]},s.revision);s.view="settings";
      } else if(action==="initials") {
        const levels=db.levels(i.guildId);
        for(const id of i.values) {
          validateRole(i.guild,await i.guild.roles.fetch(id),i.member);
          if(levels.some(l=>l.roleId===id && l.requiredMs>0))throw new Error("Um cargo avançado não pode ser uma opção inicial.");
        }
        db.saveConfig(i.guildId,{initialRoles:i.values},s.revision);s.view="settings";
      } else if(action==="excluded") {
        for(const id of i.values) {
          const channel=await i.guild.channels.fetch(id);
          if(!channel || channel.guildId!==i.guildId || ![ChannelType.GuildVoice,ChannelType.GuildStageVoice].includes(channel.type))throw new Error("Selecione somente canais de voz do servidor.");
        }
        db.saveConfig(i.guildId,{excludedChannels:i.values},s.revision);s.view="settings";
      } else if(action==="notification") {
        const id=i.values[0]||null;
        if(id) {
          const channel=await i.guild.channels.fetch(id);
          if(!channel?.isTextBased() || channel.guildId!==i.guildId || !channel.permissionsFor(i.guild.members.me)?.has([PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages]))throw new Error("O bot não pode enviar mensagens nesse canal.");
        }
        db.saveConfig(i.guildId,{notificationChannel:id},s.revision);s.view="settings";
      } else if(action==="recalcconfirm") {
        container=box("# Recalcular a progressão?","Esta ação aplica as regras atuais a todos os participantes. Pode rebaixar o nível e retirar cargos de progressão, sem apagar horas ou histórico.",0)
          .addActionRowComponents(row(button(s,"recalculate","Confirmar recálculo",ButtonStyle.Danger),button(s,"settings","Cancelar")));
      } else if(action==="recalculate") {
        db.saveConfig(i.guildId,{},s.revision);
        db.db.prepare("UPDATE up_members SET recalculate=1 WHERE guildId=? AND state='active'").run(i.guildId);
        engine.scan();s.view="settings";
      }
      if(["save","confirmremove","toggle","muted","previous","retro","initials","excluded","recalculate"].includes(action)) engine.wakeGuild(i.guildId);
      const result=container||await render(i.guild,s);db.session(s);
      await i.editReply(payload(result));
    } catch(error){await fail(i,error);}finally{busy.delete(s.id);}
    } catch(error) {await fail(i,error);}
  });
  async function comandoUpPrefixo(message,kind) {
    if(!message.guild || message.author.bot)return;
    const [,arg]=message.content.trim().split(/\s+/);
    if(!admin(message.member))return responderSemPermissao(message).catch(()=>{});
    try {
      if(kind==="upadmin")await openAdmin(message,false);
      else {
        const id=arg?.replace(/[<#>]/g,"");
        if(id && !/^\d{17,20}$/.test(id))throw new Error("Informe um canal válido ou use !upcargos no canal desejado.");
        const channel=id?await message.guild.channels.fetch(id):message.channel;
        if(!channel?.isTextBased() || channel.guildId!==message.guild.id || !channel.permissionsFor(message.guild.members.me)?.has([PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages]))throw new Error("O bot não pode publicar nesse canal.");
        const sent=await channel.send(payload(publicPanel(message.guild)));
        commands.preserveMessage?.(sent);
      }
    }catch(error){await fail(message,error);}
  }
  async function comandoUpAdminSlash(i) {
    if(!admin(i.member))return responderSemPermissao(i).catch(()=>{});
    try {await i.deferReply({flags:MessageFlags.Ephemeral});await openAdmin(i,true);}catch(error){await fail(i,error);}
  }
  commands.register({
    name:"upcargos",description:"Publica o painel público de resgate e progressão automática por horas em call.",category:"Progressão de Cargos",
    permissions:["ManageGuild"],result:"Publica os botões de resgate, progresso pessoal e hierarquia. A progressão é configurada em upadmin.",
    examples:["!upcargos","!upcargos #canal"],
    prefix:{trigger:"!upcargos",usage:["!upcargos [#canal ou ID]"],execute:message=>comandoUpPrefixo(message,"upcargos")}
  });
  commands.register({
    name:"upadmin",description:"Configura níveis, metas e políticas da progressão automática de cargos.",category:"Administração",
    permissions:["ManageGuild"],result:"Abre a administração de UP. A versão slash é privada; o prefixo responde no canal com controles exclusivos do solicitante.",
    examples:["!upadmin","/upadmin"],prefix:{trigger:"!upadmin",execute:message=>comandoUpPrefixo(message,"upadmin")},
    slash:{data:new SlashCommandBuilder().setName("upadmin").setDescription("Administrar progressão por horas")
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),execute:comandoUpAdminSlash}
  });
  client.on("voiceStateUpdate",(_old,state)=>{
    try{if(!engine.stopped && db.member(state.guild.id,state.id))engine.enqueue(state.guild.id,state.id);}
    catch(error){console.warn("[UP] Atualização de voz:",error.message);}
  });
  client.on("guildMemberRemove",member=>{
    try{db.db.prepare("UPDATE up_members SET state='absent',updatedAt=? WHERE guildId=? AND userId=?").run(Date.now(),member.guild.id,member.id);}
    catch(error){console.warn("[UP] Saída de membro:",error.message);}
  });
  client.on("guildMemberAdd",member=>{
    try{
      db.db.prepare("UPDATE up_members SET state=CASE WHEN currentRoleId IS NULL THEN 'enrolling' ELSE 'active' END WHERE guildId=? AND userId=? AND state='absent'")
        .run(member.guild.id,member.id);
      if(db.member(member.guild.id,member.id))engine.enqueue(member.guild.id,member.id);
    }catch(error){console.warn("[UP] Retorno de membro:",error.message);}
  });
  const timer=setInterval(()=>{try{engine.scan();}catch(error){console.error("[UP] Verificação automática:",error);}},15_000);timer.unref();
  const bioTimer=setInterval(()=>{void bioGate.tick().catch(()=>console.warn('[UP bio] Revisão periódica indisponível.'));},5000);bioTimer.unref();
  client.once("clientReady",async()=>{
    try {
      db.db.prepare("DELETE FROM up_sessions WHERE expiresAt<=?").run(Date.now());engine.scan(true);
    }catch(error){console.warn("[UP] Inicialização:",error.message);}
  });
  for(const signal of ["SIGINT","SIGTERM","exit"])process.once(signal,()=>{engine.stopped=true;bioGate.stop();clearInterval(timer);clearInterval(bioTimer);});
  return {engine,bioGate,publicPanel};
};
