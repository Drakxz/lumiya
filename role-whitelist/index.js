const {
  ContainerBuilder,SectionBuilder,ThumbnailBuilder,TextDisplayBuilder,SeparatorBuilder,SeparatorSpacingSize,
  ActionRowBuilder,ButtonBuilder,ButtonStyle,UserSelectMenuBuilder,RoleSelectMenuBuilder,StringSelectMenuBuilder,
  ModalBuilder,LabelBuilder,TextInputBuilder,TextInputStyle,MessageFlags,PermissionFlagsBits,SlashCommandBuilder
}=require("discord.js");
const {RoleWhitelistStore}=require("./store");
const {serverName}=require("../brand");

const BLUE=0,RED=0,OK=0,V2=MessageFlags.IsComponentsV2,PRIVATE=V2|MessageFlags.Ephemeral;
const sep=()=>new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small);
const {statusText}=require("../error-ui");
const txt=s=>new TextDisplayBuilder().setContent(statusText(s));
const btn=(id,label,style=ButtonStyle.Secondary)=>new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style);
const payload=(container,ephemeral=true)=>require("../lumiya-ui/canonical").canonical({components:[container],flags:V2|(ephemeral?MessageFlags.Ephemeral:0),allowedMentions:{parse:[]}});
const stamp=n=>Math.floor(n/1000),mentionRole=id=>id?`<@&${id}>`:"Não definido";
const effectiveProfile=profile=>({...profile,add:true,remove:true,manageOthers:true,targetPolicy:"all",blockedRoleIds:[],protectedTargetRoleIds:[],allowedAddRoleIds:[],allowedRemoveRoleIds:[]});

module.exports=function installRoleWhitelist({client,registry,db,history,managedRoleIds,responderSemPermissao}){
  const store=new RoleWhitelistStore(db,managedRoleIds);
  const inactivityTimers=new Map();
  function renewPanel(message){
    if(!message?.id||typeof message.delete!=="function")return;
    const key=`${message.channelId||message.channel?.id||""}:${message.id}`;
    clearTimeout(inactivityTimers.get(key));
    const timer=setTimeout(async()=>{
      if(inactivityTimers.get(key)!==timer)return;
      inactivityTimers.delete(key);
      try{await message.delete();}
      catch(error){if(error.code!==10008&&error.code!==10003)console.warn("[Whitelist de cargos] Exclusão por inatividade:",error.message);}
    },30_000);
    timer.unref();inactivityTimers.set(key,timer);
  }
  const roleCatalog=guild=>[...guild.roles.cache.values()].filter(role=>role.id!==guild.id&&!role.managed);
  // A WL decide o acesso; o Discord ainda impede @everyone, cargos gerenciados
  // e operações acima da posição/permissões reais do bot.
  const assignable=role=>Boolean(role&&!role.managed);
  function admin(member,guild){return store.isAdmin(guild,member);}
  function access(guild,member){
    const row=store.row(guild.id,member.id);
    if(row&&row.status!=="active")return {kind:"blocked",status:row.status,profile:JSON.parse(row.profile)};
    // Resolve linked presets on every access, including roles granted directly
    // in Discord and members who already had the role before it was linked.
    // The highest linked member role wins; unrelated guilds never participate.
    const linked=store.roleLinks(guild.id)
      .filter(link=>member.roles?.cache?.has(link.roleId)&&guild.roles.cache.has(link.roleId));
    linked.sort((a,b)=>{
      const left=guild.roles.cache.get(a.roleId),right=guild.roles.cache.get(b.roleId);
      return typeof right.comparePositionTo==="function"?right.comparePositionTo(left):
        (right.position||0)-(left.position||0)||a.roleId.localeCompare(b.roleId);
    });
    if(linked.length)return {kind:"whitelist",profile:effectiveProfile(linked[0].preset.profile),
      presetId:linked[0].preset.id,sourceRoleId:linked[0].roleId};
    return row?{kind:"whitelist",profile:effectiveProfile(JSON.parse(row.profile))}:null;
  }
  function targetDenial(guild,member,target,auth){
    if(!auth||auth.kind==="blocked")return "Sua autorização não está ativa.";
    if(!target)return "O membro-alvo não foi encontrado no servidor.";
    if(target.id===client.user.id)return "O bot não pode ser alvo do painel.";
    const botHighest=guild.members.me?.roles.highest;
    if(botHighest&&target.roles.highest.comparePositionTo(botHighest)>=0)return "O bot não consegue gerenciar membros no mesmo nível ou acima do seu cargo mais alto.";
    return null;
  }
  function canTarget(guild,member,target,auth){return targetDenial(guild,member,target,auth)===null;}
  function canRole(guild,member,target,role,action,auth=access(guild,member)){
    if(!auth||auth.kind==="blocked"||!role||role.id===guild.id||role.managed||!canTarget(guild,member,target,auth))return false;
    if(!guild.members.me?.permissions?.has(PermissionFlagsBits.ManageRoles))return false;
    if(!guild.members.me?.permissions?.has(PermissionFlagsBits.ManageRoles))return false;
    const p=auth.profile;if(!assignable(role)||!guild.roles.cache.has(p.maxRoleId))return false;
    if(action==="add"&&!p.add||action==="remove"&&!p.remove)return false;
    const maxRole=guild.roles.cache.get(p.maxRoleId);if(!maxRole)return false;
    if(role.comparePositionTo(maxRole)>0)return false;
    return role.comparePositionTo(guild.members.me?.roles.highest||guild.roles.everyone)<0;
  }
  function panel(guild){
    store.expireAll(guild.id);const all=store.count(guild.id,"active"),temp=db.prepare("SELECT COUNT(*) n FROM role_wl_users WHERE guildId=? AND status='active' AND expiresAt IS NOT NULL").get(guild.id).n;
    const permanent=all-temp,latest=db.prepare("SELECT MAX(updatedAt) at FROM role_wl_users WHERE guildId=?").get(guild.id).at;
    const container=new ContainerBuilder().setAccentColor(BLUE);
    const icon=guild.iconURL?.({extension:"png",size:256});
    const heading=[txt(`# Whitelist de Cargos | ${serverName(guild)}`),txt("-# Escolha quem pode gerenciar cargos e defina o limite de cada pessoa.")];
    if(icon)container.addSectionComponents(new SectionBuilder().addTextDisplayComponents(...heading).setThumbnailAccessory(new ThumbnailBuilder().setURL(icon)));
    else container.addTextDisplayComponents(...heading);
    return container.addSeparatorComponents(sep())
      .addTextDisplayComponents(txt(`**${all} ativos** · ${permanent} permanentes · ${temp} temporários\n-# Última alteração: ${latest?`<t:${stamp(latest)}:R>`:"nenhuma"}`))
      .addActionRowComponents(new ActionRowBuilder().addComponents(btn("rw:add","Autorizar usuário",ButtonStyle.Primary),btn("rw:manage","Consultar usuário"),btn("rw:list:active:0","Autorizações")))
      .addActionRowComponents(new ActionRowBuilder().addComponents(btn("rw:presets","Presets"),btn("rw:history","Histórico"),btn("rw:settings","Administradores")));
  }
  function denied(i,reason="Você não possui autorização para utilizar este controle."){
    if(i.author&&responderSemPermissao)return responderSemPermissao(i);
    const u=i.user||i.author,p=payload(new ContainerBuilder().setAccentColor(RED).addTextDisplayComponents(txt(`# 🚨 | Você não possui permissão para executar esse comando.\n${reason}\nRequisitado por: <@${u.id}>`)));
    return i.deferred||i.replied?i.followUp(p):i.reply(p);
  }
  function managerCard(guild,r){
    const p=effectiveProfile(typeof r.profile==="string"?JSON.parse(r.profile):r.profile),member=guild.members.cache.get(r.userId);
    const exp=r.expiresAt?`<t:${stamp(r.expiresAt)}:R>`:"Permanente";
    const status={active:"Ativa",suspended:"Suspensa",revoked:"Revogada",expired:"Expirada"}[r.status]||r.status;
    const c=new ContainerBuilder().setAccentColor(BLUE).addTextDisplayComponents(txt(`# Autorização | ${serverName(guild)}`))
      .addSectionComponents(new SectionBuilder().addTextDisplayComponents(txt(`**<@${r.userId}>** · ${status}\n**Cargo máximo:** ${mentionRole(p.maxRoleId)}\n**Validade:** ${exp}\n**Histórico de cargos:** ${p.viewHistory?"Permitido":"Desativado"}`)).setThumbnailAccessory(new ThumbnailBuilder().setURL(member?.displayAvatarURL({extension:"png",size:256})||"https://cdn.discordapp.com/embed/avatars/0.png")))
      .addTextDisplayComponents(txt(`-# Autorizado por <@${r.authorizedBy}> · <t:${stamp(r.createdAt)}:d>`))
      .addSeparatorComponents(sep()).addActionRowComponents(new ActionRowBuilder().addComponents(btn(`rw:edit:${r.userId}`,"Editar",ButtonStyle.Primary),btn(`rw:perms:${r.userId}`,"Opções")))
      .addActionRowComponents(new ActionRowBuilder().addComponents(btn(`rw:suspend:${r.userId}`,r.status==="suspended"?"Reativar":"Suspender",r.status==="suspended"?ButtonStyle.Success:ButtonStyle.Secondary),btn(`rw:revoke:${r.userId}`,"Revogar Whitelist",ButtonStyle.Danger)))
      .addActionRowComponents(new ActionRowBuilder().addComponents(btn(`rw:history-user:${r.userId}:0`,"Histórico"),btn("rw:home","Voltar")));
    return c;
  }
  function draftCard(guild,d){
    const p=d.profile,presetMode=presetSentinel(d.userId),duration=d.durationMs?`${d.durationMs/3600000} h`:"Permanente";
    const title=presetMode?(presetDraftId(d.userId)==="new"?"Criar preset":"Editar preset"):"Configurar autorização";
    const subject=presetMode?`**Preset:** ${safe(d.reason||"Sem nome")}`:`**Usuário:** <@${d.userId}>`;
    const card=new ContainerBuilder().setAccentColor(BLUE)
      .addTextDisplayComponents(txt(`# ${title}`),txt(`${subject}\n**Cargo máximo:** ${mentionRole(p.maxRoleId)}${presetMode?"":`\n**Validade:** ${duration}`}`),txt(`-# ${roleSummary(p)} · Permite adicionar e remover até o limite escolhido.`))
      .addSeparatorComponents(sep())
      .addActionRowComponents(new ActionRowBuilder().addComponents(
        btn(`rw:d:${d.id}:max`,"Cargo máximo",ButtonStyle.Primary),
        ...(presetMode?[]:[btn(`rw:d:${d.id}:duration`,"Duração")]),
        btn(`rw:d:${d.id}:perms`,"Opções")));
    return card.addActionRowComponents(new ActionRowBuilder().addComponents(
      btn(`rw:d:${d.id}:save`,presetMode?"Salvar preset":"Salvar Whitelist",ButtonStyle.Success),
      btn(`rw:d:${d.id}:cancel`,"Cancelar",ButtonStyle.Danger)));
  }
  const presetSentinel=id=>String(id||"").startsWith("__preset__:");
  const presetDraftId=id=>String(id).slice("__preset__:".length);
  function presetCard(guild){
    const rows=store.presets(guild.id),c=new ContainerBuilder().setAccentColor(BLUE)
      .addTextDisplayComponents(txt("# Presets de whitelist"),txt("Salve um modelo de permissões e aplique a novos usuários sem selecionar os cargos novamente. A duração é escolhida ao aplicar."));
    if(!rows.length)c.addTextDisplayComponents(txt("Nenhum preset salvo. Crie o primeiro para reutilizar a configuração."));
    for(const p of rows){
      const max=guild.roles.cache.get(p.profile?.maxRoleId);
      const links=store.roleLinks(guild.id,p.id);
      c.addSectionComponents(new SectionBuilder().addTextDisplayComponents(
        txt(`**${safe(p.name)}**\nCargo máximo: ${mentionRole(p.profile?.maxRoleId)}${max?"":" (cargo indisponível)"}\n-${"-"}# ${roleSummary(p.profile||{})}\nCargos vinculados: ${links.length?links.map(l=>mentionRole(l.roleId)).join(" "):"nenhum"}\n<t:${stamp(p.updatedAt)}:R> · <@${p.updatedBy}>`)
      ).setButtonAccessory(btn(`rw:preset-apply:${p.id}`,"Aplicar",ButtonStyle.Primary)));
      c.addActionRowComponents(new ActionRowBuilder().addComponents(
        btn(`rw:preset-edit:${p.id}`,"Editar preset"),btn(`rw:preset-link:${p.id}`,"Vincular cargo"),btn(`rw:preset-del:${p.id}`,"Excluir",ButtonStyle.Danger)));
      if(links.length)c.addActionRowComponents(new ActionRowBuilder().addComponents(
        ...links.slice(0,5).map(l=>btn(`rw:preset-unlink:${p.id}:${l.roleId}`,`Desvincular ${guild.roles.cache.get(l.roleId)?.name||l.roleId}`.slice(0,80)))));
    }
    c.addSeparatorComponents(sep()).addActionRowComponents(new ActionRowBuilder().addComponents(
      btn("rw:preset-new","Criar preset",ButtonStyle.Success),btn("rw:home","Voltar")));
    return c;
  }
  function safe(value){return String(value||"").replace(/[<@>`]/g,"").slice(0,80)||"Sem nome";}
  async function render(i,p){
    const update={components:p.components,allowedMentions:{parse:[]}};
    if(i.deferred||i.replied){const message=await i.editReply(update);renewPanel(message);return message;}
    if(i.message&&typeof i.update==="function"){const result=await i.update(update);renewPanel(i.message);return result;}
    return i.reply({...p,allowedMentions:{parse:[]}});
  }
  async function reply(i,c){return render(i,payload(c));}
  const namedRoles=(ids=[],limit=8)=>{
    const valid=ids.filter(id=>/^\d{17,20}$/.test(String(id)));
    const shown=valid.slice(0,limit).map(id=>`<@&${id}>`).join(" ")||"nenhum";
    return `${shown}${valid.length>limit?` (+${valid.length-limit})`:""}`;
  };
  const roleSummary=p=>[
    `Permitidos: ${p.allowedAddRoleIds?.length||0}`,
    `Bloqueados: ${p.blockedRoleIds?.length||0}`,
    `Protegidos: ${p.protectedTargetRoleIds?.length||0}`
  ].join(" · ");
  function draftModal(i,d){const p=d.profile,c=new ContainerBuilder().setAccentColor(BLUE).addTextDisplayComponents(txt("## Opções da whitelist"));
    c.addTextDisplayComponents(txt("Salve os cargos diretamente no preset ou na autorização. O bot respeita sua própria hierarquia do Discord."),txt(`-${"-"}# ${roleSummary(p)}`),
      txt(`Permitidos: ${namedRoles(p.allowedAddRoleIds)}\nBloqueados: ${namedRoles(p.blockedRoleIds)}\nProtegidos: ${namedRoles(p.protectedTargetRoleIds)}`))
      .addActionRowComponents(new ActionRowBuilder().addComponents(
        btn(`rw:d:${d.id}:allowedAdd`,"Cargos permitidos"),btn(`rw:d:${d.id}:blocked`,"Cargos bloqueados")))
      .addActionRowComponents(new ActionRowBuilder().addComponents(
        btn(`rw:d:${d.id}:protected`,"Cargos protegidos"),btn(`rw:d:${d.id}:targetRole`,"Alvo máximo")))
      .addActionRowComponents(new ActionRowBuilder().addComponents(btn(`rw:d:${d.id}:toggle:viewHistory`,`${p.viewHistory?"✅":"⬜"} Ver histórico`),btn(`rw:d:${d.id}:back`,"Voltar à ficha")));
    return reply(i,c);
  }
  function listCard(guild,status="active",page=0){const data=store.list(guild.id,status,page,5),pages=Math.max(1,Math.ceil(data.total/5)),c=new ContainerBuilder().setAccentColor(BLUE).addTextDisplayComponents(txt("# Usuários Autorizados"),txt(`Filtro: ${status} · Total: ${data.total}`)).addSeparatorComponents(sep());
    if(!data.rows.length)c.addTextDisplayComponents(txt("Nenhuma autorização encontrada."));
    for(const r of data.rows){const p=effectiveProfile(r.profile);c.addSectionComponents(new SectionBuilder().addTextDisplayComponents(txt(`**<@${r.userId}>** · ${r.status}\nLimite: ${mentionRole(p.maxRoleId)}\nPermissões: Adicionar e remover\nAlvos: Todos os membros elegíveis\nDuração: ${r.expiresAt?`<t:${stamp(r.expiresAt)}:R>`:"Permanente"}`)).setButtonAccessory(btn(`rw:profile:${r.userId}`,"Gerenciar")));}
    c.addSeparatorComponents(sep()).addActionRowComponents(new ActionRowBuilder().addComponents(btn(`rw:list:active:${page}`,"Ativos",status==="active"?ButtonStyle.Primary:ButtonStyle.Secondary),btn(`rw:list:suspended:${page}`,"Suspensos",status==="suspended"?ButtonStyle.Primary:ButtonStyle.Secondary),btn(`rw:list:all:${page}`,"Todos",status==="all"?ButtonStyle.Primary:ButtonStyle.Secondary),btn("rw:search","Pesquisar").setEmoji({id:"1569941293323255889",name:"1378484773118541847"})))
        .addActionRowComponents(new ActionRowBuilder().addComponents(btn(`rw:list-prev:${status}:${page}`,"<").setDisabled(page===0),btn("rw:listinfo",`${page+1}/${pages}`).setDisabled(true),btn(`rw:list-next:${status}:${page}`,">").setDisabled(page>=pages-1)));
    c.addActionRowComponents(new ActionRowBuilder().addComponents(btn("rw:home","Voltar")));
    return c;}
  function hierarchyCard(guild,selected){const h=store.config(guild.id).hierarchy,c=new ContainerBuilder().setAccentColor(BLUE).addTextDisplayComponents(txt("# Hierarquia de Cargos Gerenciáveis"),txt("O bot detecta os cargos do servidor. Para a whitelist, somente cargos incluídos nesta ordem explícita podem ser gerenciados; cargos administrativos são sempre bloqueados."));
    c.addTextDisplayComponents(txt(h.length?h.map((id,n)=>`${n+1}. ${mentionRole(id)}`).join("\n").slice(0,4000):"Nenhum cargo classificado ainda. Selecione os cargos abaixo; a ordem selecionada será a ordem da progressão."));
    if(h.length)c.addActionRowComponents(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId("rw:hierarchy:select").setPlaceholder("Selecione o cargo para reordenar").setMinValues(1).setMaxValues(1).addOptions(h.slice(0,25).map((id,n)=>({label:`${n+1}. ${guild.roles.cache.get(id)?.name||id}`.slice(0,100),value:id})))));
    c.addActionRowComponents(new ActionRowBuilder().addComponents(btn("rw:hierarchy-add","Selecionar cargos"),btn("rw:home","Voltar")));
    return c;}
  const allowed=member=>Boolean(member?.guild&&admin(member,member.guild));
  registry.register({name:"wlcargos",description:"Gerencia usuários, limites e histórico da whitelist de cargos.",category:"Gerenciamento de Cargos",public:true,authorize:allowed,
    permissionLabel:"Proprietário ou administrador autorizado da whitelist",examples:["!wlcargos"],
    prefix:{trigger:"!wlcargos",exact:true,execute:async m=>{
      if(!admin(m.member,m.guild))return denied(m);
      const message=await m.channel.send(payload(panel(m.guild),false));
      renewPanel(message);return message;
    }}});

  const expiryTimer=setInterval(()=>{try{store.expireAll();}catch(e){console.warn("[Whitelist de cargos] Expiração:",e.message);}},60_000);expiryTimer.unref();
  client.on("clientReady",()=>store.expireAll());
  client.on("interactionCreate",async i=>{
    if(!i.inGuild?.()||!i.isButton?.()||!i.customId?.startsWith("rw:"))return;
    try{
      const parts=i.customId.split(":"),action=parts[1],id=parts[2],extra=parts[3];
      if(action==="admin-add"){
        if(i.user.id!==i.guild.ownerId)return denied(i,"Somente o proprietário pode autorizar administradores da whitelist.");
        const ids=store.config(i.guildId).adminIds,uid=i.values[0];if(uid===i.guild.ownerId)return reply(i,panel(i.guild));
        if(!ids.includes(uid))ids.push(uid);const cfg=store.config(i.guildId);cfg.adminIds=ids;store.saveConfig(i.guildId,cfg,i.user.id);store.event(i.guildId,uid,i.user.id,"whitelist-admin-added",null,{admin:true});return reply(i,panel(i.guild));
      }
      if(!admin(i.member,i.guild))return denied(i,"Somente o proprietário ou um administrador explicitamente autorizado pode alterar estas regras.");
      renewPanel(i.message);
      if(action==="home")return reply(i,panel(i.guild));
      if(action==="presets")return reply(i,presetCard(i.guild));
      if(action==="preset-new"){
        const d=store.createPresetDraft(i.guildId,i.user.id,"new");
        return reply(i,draftCard(i.guild,d));
      }
      if(action==="preset-edit"){
        const preset=store.preset(i.guildId,id);if(!preset)return denied(i,"Preset não encontrado.");
        const d=store.createPresetDraft(i.guildId,i.user.id,id);
        return reply(i,draftCard(i.guild,d));
      }
      if(action==="preset-apply"){
        const preset=store.preset(i.guildId,id);if(!preset)return denied(i,"Preset não encontrado.");
        return render(i,{components:[new ContainerBuilder().setAccentColor(BLUE)
          .addTextDisplayComponents(txt("# Aplicar preset"),txt(`**Preset:** ${safe(preset.name)}\nSelecione o usuário que receberá esta configuração.`))
          .addActionRowComponents(new ActionRowBuilder().addComponents(new UserSelectMenuBuilder().setCustomId(`rw:preset-pick:${id}`).setMinValues(1).setMaxValues(1)))],flags:PRIVATE});
      }
      if(action==="preset-link"){
        const preset=store.preset(i.guildId,id);if(!preset)return denied(i,"Preset não encontrado.");
        return render(i,{components:[new ContainerBuilder().setAccentColor(BLUE)
          .addTextDisplayComponents(txt("# Vincular cargo"),txt(`**Preset:** ${safe(preset.name)}\nQuem receber um destes cargos receberá automaticamente a whitelist deste preset. Um cargo pode ter apenas um preset.`))
          .addActionRowComponents(new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder()
            .setCustomId(`rw:preset-role:${id}`).setMinValues(1).setMaxValues(25)))],flags:PRIVATE});
      }
      if(action==="preset-unlink"){
        const preset=store.preset(i.guildId,id),roleId=extra;
        if(!preset||!store.unlinkRolePreset(i.guildId,roleId,i.user.id))return denied(i,"Vínculo não encontrado.");
        return reply(i,presetCard(i.guild));
      }
      if(action==="preset-del"){
        const preset=store.preset(i.guildId,id);if(!preset)return denied(i,"Preset não encontrado.");
        return reply(i,new ContainerBuilder().setAccentColor(RED).addTextDisplayComponents(txt(`# Excluir preset?\n**${safe(preset.name)}**\nAs autorizações já concedidas com este preset não são alteradas.`))
          .addActionRowComponents(new ActionRowBuilder().addComponents(btn(`rw:preset-del-yes:${id}`,"Confirmar",ButtonStyle.Danger),btn("rw:presets","Cancelar"))));
      }
      if(action==="preset-del-yes"){
        if(!store.deletePreset(i.guildId,id,i.user.id))return denied(i,"Preset não encontrado.");
        return reply(i,presetCard(i.guild));
      }
      if(action==="add")return render(i,{components:[new ContainerBuilder().setAccentColor(BLUE).addTextDisplayComponents(txt("Selecione o usuário que receberá uma autorização." )).addActionRowComponents(new ActionRowBuilder().addComponents(new UserSelectMenuBuilder().setCustomId("rw:pick-add").setMinValues(1).setMaxValues(1)))],flags:PRIVATE});
      if(action==="manage")return render(i,{components:[new ContainerBuilder().setAccentColor(BLUE).addTextDisplayComponents(txt("Selecione um usuário para editar sua autorização." )).addActionRowComponents(new ActionRowBuilder().addComponents(new UserSelectMenuBuilder().setCustomId("rw:pick-manage").setMinValues(1).setMaxValues(1)))],flags:PRIVATE});
      if(action==="profile"){const r=store.row(i.guildId,id);return r?reply(i,managerCard(i.guild,{...r,profile:JSON.parse(r.profile)})):reply(i,new ContainerBuilder().setAccentColor(BLUE).addTextDisplayComponents(txt("Nenhuma autorização cadastrada.")));}
      if(action==="d"||action==="toggle"){
        const d=store.draft(id,i.guildId,i.user.id);if(!d)return denied(i,"Esta ficha expirou. Abra novamente a whitelist.");
        if(extra==="cancel"){
          const back=presetSentinel(d.userId)?"rw:presets":"rw:home";
          store.deleteDraft(id);return reply(i,back==="rw:presets"?presetCard(i.guild):panel(i.guild));
        }
        if(extra==="save"){
           const p=d.profile,maxRole=i.guild.roles.cache.get(p.maxRoleId);
           if(!maxRole)return denied(i,"Selecione um cargo existente do servidor como limite máximo.");
           if(presetSentinel(d.userId)){
             const presetId=presetDraftId(d.userId);
             if(presetId==="new")return i.showModal(new ModalBuilder().setCustomId(`rw:preset-name:${id}`).setTitle("Nome do preset")
               .addLabelComponents(new LabelBuilder().setLabel("Nome").setDescription("Até 40 caracteres.")
                 .setTextInputComponent(new TextInputBuilder().setCustomId("name").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(40))));
             const current=store.preset(i.guildId,presetId);if(!current)return denied(i,"Preset não encontrado.");
             store.savePreset(i.guildId,presetId,current.name,p,i.user.id);store.deleteDraft(id);return reply(i,presetCard(i.guild));
           }
          const r=store.saveUser(i.guildId,d.userId,p,"active",i.user.id,d.durationMs,d.reason);store.deleteDraft(id);return reply(i,managerCard(i.guild,{...r,profile:JSON.parse(r.profile)}));
        }
        if(extra==="back")return reply(i,draftCard(i.guild,d));
        if(extra==="perms")return draftModal(i,d);
        if(extra==="duration")return render(i,{components:[new ContainerBuilder().setAccentColor(BLUE).addTextDisplayComponents(txt("Selecione a duração da autorização." )).addActionRowComponents(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`rw:duration:${id}`).addOptions([{label:"1 hora",value:"3600000"},{label:"6 horas",value:"21600000"},{label:"12 horas",value:"43200000"},{label:"24 horas",value:"86400000"},{label:"7 dias",value:"604800000"},{label:"Permanente",value:"0"},{label:"Personalizada",value:"custom"}])) )],flags:PRIVATE});
        if(["max","targetRole","allowedAdd","allowedRemove","allowAdd","allowRemove","blocked","protected"].includes(extra)){
          const multi=["allowedAdd","allowedRemove","allowAdd","allowRemove","blocked","protected"].includes(extra),selector=new RoleSelectMenuBuilder().setCustomId(`rw:roles:${id}:${extra}`).setMinValues(multi?0:1).setMaxValues(multi?25:1);
          return render(i,{components:[new ContainerBuilder().setAccentColor(BLUE).addTextDisplayComponents(txt(extra==="max"?"Selecione o cargo máximo da progressão":`Selecione os cargos para ${extra}`)).addActionRowComponents(new ActionRowBuilder().addComponents(selector))],flags:PRIVATE});
        }
        if(extra==="target")return reply(i,draftCard(i.guild,d));
        if(extra==="toggle"){
          const field=parts[4];if(field!=="viewHistory")return denied(i,"Permissão inválida.");d.profile[field]=!d.profile[field];store.updateDraft(id,i.guildId,i.user.id,d.profile,d.durationMs);return draftModal(i,store.draft(id,i.guildId,i.user.id));
        }
        if(extra==="suspend"||extra==="revoke")return reply(i,new ContainerBuilder().setAccentColor(RED).addTextDisplayComponents(txt(`# Confirmar ${extra==="suspend"?"suspensão":"revogação"}\nA operação será registrada no histórico administrativo.`)).addActionRowComponents(new ActionRowBuilder().addComponents(btn(`rw:d:${id}:${extra}-confirm`,"Confirmar",ButtonStyle.Danger),btn(`rw:profile:${id}`,"Cancelar"))));
      }
      if(action==="list")return reply(i,listCard(i.guild,id,Number(extra)||0));
      if(action==="list-prev"||action==="list-next"){
        const status=id,current=Number(extra)||0,next=action==="list-prev"?Math.max(0,current-1):current+1;
        return reply(i,listCard(i.guild,status,next));
      }
      if(action==="history-user"){
          const userId=id,page=Number(extra)||0,rows=store.history(i.guildId,userId,page),total=store.historyCount(i.guildId,userId),c=new ContainerBuilder().setAccentColor(BLUE).addTextDisplayComponents(txt("# Histórico da Whitelist"),txt(`**Usuário:** <@${userId}> · **Registros:** ${total}`)).addSeparatorComponents(sep());
          if(!rows.length)c.addTextDisplayComponents(txt("Nenhuma alteração registrada."));for(const e of rows)c.addTextDisplayComponents(txt(`**${e.action}** · <@${e.actorId}>\n<t:${stamp(e.createdAt)}:F>${e.reason?`\nMotivo: ${e.reason}`:""}`)).addSeparatorComponents(sep());
          c.addActionRowComponents(new ActionRowBuilder().addComponents(btn(`rw:history-user:${userId}:${Math.max(0,page-1)}`,"<").setDisabled(page===0),btn("rw:historyinfo","Histórico").setDisabled(true),btn(`rw:history-user:${userId}:${page+1}`,">").setDisabled((page+1)*5>=total),btn(`rw:profile:${userId}`,"Voltar")));return reply(i,c);
      }
      if(action==="history"){
        const rows=db.prepare("SELECT userId,MAX(createdAt) at FROM role_wl_events WHERE guildId=? GROUP BY userId ORDER BY at DESC LIMIT 20").all(i.guildId),c=new ContainerBuilder().setAccentColor(BLUE).addTextDisplayComponents(txt("# Histórico administrativo de whitelist"));
        rows.forEach(r=>c.addSectionComponents(new SectionBuilder().addTextDisplayComponents(txt(`<@${r.userId}> · última alteração <t:${stamp(r.at)}:R>`)).setButtonAccessory(btn(`rw:history-user:${r.userId}:0`,"Ver"))));return reply(i,c);
      }
      if(action==="settings"){
        if(i.user.id!==i.guild.ownerId)return denied(i,"Somente o proprietário configura administradores da whitelist.");
        const cfg=store.config(i.guildId),c=new ContainerBuilder().setAccentColor(BLUE).addTextDisplayComponents(txt("# Configurações administrativas"),txt("Somente o proprietário pode conceder ou revogar acesso administrativo à whitelist."),txt(`**Administradores autorizados:** ${cfg.adminIds.map(x=>`<@${x}>`).join(", ")||"Nenhum"}`))
          .addActionRowComponents(new ActionRowBuilder().addComponents(new UserSelectMenuBuilder().setCustomId("rw:pick-admin").setMinValues(1).setMaxValues(1)));
        return reply(i,c);
      }
      if(action==="hierarchy")return reply(i,hierarchyCard(i.guild));
      if(action==="hierarchy-add")return reply(i,panel(i.guild));
      if(action==="hierarchy-move"){
        const cfg=store.config(i.guildId),idx=cfg.hierarchy.indexOf(id),step=extra==="up"?-1:1,next=idx+step;
        if(idx<0||next<0||next>=cfg.hierarchy.length)return denied(i,"Não há posição para mover.");
        [cfg.hierarchy[idx],cfg.hierarchy[next]]=[cfg.hierarchy[next],cfg.hierarchy[idx]];store.saveConfig(i.guildId,cfg,i.user.id);return reply(i,hierarchyCard(i.guild));
      }
      if(action==="hierarchy-select"){
        const cfg=store.config(i.guildId),roleId=cfg.selectedHierarchyRole,idx=cfg.hierarchy.indexOf(roleId),step=id==="up"?-1:1,next=idx+step;
        if(idx<0||next<0||next>=cfg.hierarchy.length)return denied(i,"Selecione um cargo e uma posição válida.");
        [cfg.hierarchy[idx],cfg.hierarchy[next]]=[cfg.hierarchy[next],cfg.hierarchy[idx]];store.saveConfig(i.guildId,cfg,i.user.id);return reply(i,hierarchyCard(i.guild));
      }
      if(action==="search")return i.showModal(new ModalBuilder().setCustomId("rw:search").setTitle("Buscar usuário autorizado").addLabelComponents(new LabelBuilder().setLabel("ID do membro").setTextInputComponent(new TextInputBuilder().setCustomId("userId").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(25))));
      if(action==="admin-remove"){
        const cfg=store.config(i.guildId);if(i.user.id!==i.guild.ownerId)return denied(i,"Somente o proprietário pode alterar administradores.");cfg.adminIds=cfg.adminIds.filter(x=>x!==id);store.saveConfig(i.guildId,cfg,i.user.id);store.event(i.guildId,id,i.user.id,"whitelist-admin-removed",{admin:true},null);return reply(i,panel(i.guild));
      }
      if(action==="suspend"||action==="revoke"){
        const r=store.row(i.guildId,id);if(!r)return denied(i,"Autorização não encontrada.");
        if(action==="suspend"&&r.status==="suspended"){
          store.setStatus(i.guildId,id,"active",i.user.id,"Reativação administrativa");const updated=store.row(i.guildId,id);return reply(i,managerCard(i.guild,{...updated,profile:JSON.parse(updated.profile)}));
        }
        return reply(i,new ContainerBuilder().setAccentColor(RED).addTextDisplayComponents(txt(`# Confirmar ${action==="suspend"?"suspensão":"revogação"}\nA operação será registrada no histórico.`)).addActionRowComponents(new ActionRowBuilder().addComponents(btn(`rw:confirm-${action}:${id}`,"Confirmar",ButtonStyle.Danger),btn(`rw:profile:${id}`,"Cancelar"))));
      }
      if(action==="confirm-suspend"||action==="confirm-revoke"){
        const status=action==="confirm-suspend"?"suspended":"revoked",row=store.setStatus(i.guildId,id,status,i.user.id,`Ação administrativa: ${status}`);return reply(i,managerCard(i.guild,{...row,profile:JSON.parse(row.profile)}));
      }
      if(action==="edit"||action==="perms"){
        const r=store.row(i.guildId,id);if(!r)return denied(i,"Autorização não encontrada.");const d=store.createDraft(i.guildId,i.user.id,id);return action==="edit"?reply(i,draftCard(i.guild,d)):draftModal(i,d);
      }
    }catch(error){console.error("[Whitelist de cargos] Interação:",error);if(!i.replied&&!i.deferred)await denied(i,"Ocorreu um erro ao processar a configuração.").catch(()=>{});}
  });

  client.on("interactionCreate",async i=>{
    if(!i.inGuild?.()||!i.customId?.startsWith("rw:")||i.isButton?.())return;
    try{
      if(!admin(i.member,i.guild))return denied(i);
      renewPanel(i.message);
      if(i.isUserSelectMenu?.()&&i.customId.startsWith("rw:pick-")){
        const type=i.customId.slice("rw:pick-".length),userId=i.values[0];
        if(type==="admin"){
          if(i.user.id!==i.guild.ownerId)return denied(i,"Somente o proprietário pode autorizar administradores.");
          const cfg=store.config(i.guildId);if(!cfg.adminIds.includes(userId))cfg.adminIds.push(userId);store.saveConfig(i.guildId,cfg,i.user.id);store.event(i.guildId,userId,i.user.id,"whitelist-admin-added",null,{admin:true});return reply(i,panel(i.guild));
        }
        if(type==="manage"){
          const existing=store.row(i.guildId,userId);
          return existing?reply(i,managerCard(i.guild,existing)):reply(i,new ContainerBuilder().setAccentColor(BLUE).addTextDisplayComponents(txt("Este usuário ainda não possui autorização.")).addActionRowComponents(new ActionRowBuilder().addComponents(btn("rw:add","Autorizar usuário",ButtonStyle.Primary),btn("rw:home","Voltar"))));
        }
        const d=store.createDraft(i.guildId,i.user.id,userId);return reply(i,draftCard(i.guild,d));
      }
      if(i.isUserSelectMenu?.()&&i.customId.startsWith("rw:preset-pick:")){
        const presetId=i.customId.slice("rw:preset-pick:".length),userId=i.values[0];
        const d=store.createUserDraftFromPreset(i.guildId,i.user.id,userId,presetId);
        if(!d)return denied(i,"Preset não encontrado.");
        return reply(i,draftCard(i.guild,d));
      }
      if(i.isRoleSelectMenu?.()&&i.customId.startsWith("rw:hierarchy:roles")){
        if(!admin(i.member,i.guild))return denied(i);const valid=new Set(roleCatalog(i.guild).map(role=>role.id)),cfg=store.config(i.guildId),ids=i.values.filter(x=>valid.has(x));if(!ids.length)return denied(i,"Selecione cargos existentes do servidor.");cfg.hierarchy=[...new Set([...cfg.hierarchy,...ids])];store.saveConfig(i.guildId,cfg,i.user.id);return reply(i,hierarchyCard(i.guild));
      }
      if(i.isRoleSelectMenu?.()&&i.customId.startsWith("rw:preset-role:")){
        const presetId=i.customId.slice("rw:preset-role:".length);
        const preset=store.preset(i.guildId,presetId);if(!preset)return denied(i,"Preset não encontrado.");
        const valid=new Set(roleCatalog(i.guild).map(role=>role.id));
        const roleIds=i.values.filter(roleId=>valid.has(roleId));
        if(!roleIds.length)return denied(i,"Selecione cargos existentes do servidor.");
        const bot=i.guild.members.me;
        for(const roleId of roleIds){
          const role=i.guild.roles.cache.get(roleId);
          if(!bot?.permissions?.has(PermissionFlagsBits.ManageRoles)||role.managed||
            role.id===i.guild.id||role.position>=bot.roles.highest.position)return denied(i,`O bot não pode gerenciar <@&${roleId}>. Ajuste a hierarquia.`);
        }
        for(const roleId of roleIds)store.linkRolePreset(i.guildId,roleId,presetId,i.user.id);
        return reply(i,presetCard(i.guild));
      }
      if(i.isRoleSelectMenu?.()&&i.customId.startsWith("rw:roles:")){
        const [, ,draftId,field]=i.customId.split(":"),d=store.draft(draftId,i.guildId,i.user.id);if(!d)return denied(i,"Esta ficha expirou.");
         const roleIds=field==="max"
           ?i.values.filter(roleId=>i.guild.roles.cache.has(roleId))
           :i.values.filter(roleId=>roleCatalog(i.guild).some(role=>role.id===roleId));
        if(field==="max"||field==="targetRole"){
          const roleId=roleIds[0];if(!roleId)return denied(i,"Selecione um cargo existente do servidor.");d.profile[field==="max"?"maxRoleId":"targetMaxRoleId"]=roleId;
        }else {const key={allowedAdd:"allowedAddRoleIds",allowedRemove:"allowedRemoveRoleIds",allowAdd:"allowedAddRoleIds",allowRemove:"allowedRemoveRoleIds",blocked:"blockedRoleIds",protected:"protectedTargetRoleIds"}[field];if(!key)return denied(i,"Campo de cargo inválido.");d.profile[key]=roleIds;}
        store.updateDraft(draftId,i.guildId,i.user.id,d.profile,d.durationMs);
        const updated=store.draft(draftId,i.guildId,i.user.id);
        return reply(i,field==="max"?draftCard(i.guild,updated):draftModal(i,updated));
      }
      if(i.isStringSelectMenu?.()){
        if(i.customId.startsWith("rw:duration:")){const d=store.draft(i.customId.split(":")[2],i.guildId,i.user.id);if(!d)return denied(i,"Esta ficha expirou.");if(i.values[0]==="custom")return i.showModal(new ModalBuilder().setCustomId(`rw:custom-duration:${d.id}`).setTitle("Duração personalizada").addLabelComponents(new LabelBuilder().setLabel("Duração em horas (1–8760)").setTextInputComponent(new TextInputBuilder().setCustomId("hours").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(4))));d.durationMs=Number(i.values[0]);store.updateDraft(d.id,i.guildId,i.user.id,d.profile,d.durationMs);return reply(i,draftCard(i.guild,d));}
        if(i.customId.startsWith("rw:target:")){const d=store.draft(i.customId.split(":")[2],i.guildId,i.user.id);if(!d)return denied(i,"Esta ficha expirou.");return reply(i,draftCard(i.guild,d));}
        if(i.customId==="rw:hierarchy:select"){const cfg=store.config(i.guildId);cfg.selectedHierarchyRole=i.values[0];store.saveConfig(i.guildId,cfg,i.user.id);const role=i.values[0];return reply(i,new ContainerBuilder().setAccentColor(BLUE).addTextDisplayComponents(txt(`Cargo selecionado: ${mentionRole(role)}`)).addActionRowComponents(new ActionRowBuilder().addComponents(btn("rw:hierarchy-select:up","Mover para cima"),btn("rw:hierarchy-select:down","Mover para baixo"),btn("rw:hierarchy","Voltar"))));}
      }
      if(i.isModalSubmit?.()&&i.customId.startsWith("rw:custom-duration:")){const id=i.customId.split(":")[2],d=store.draft(id,i.guildId,i.user.id),hours=Number(i.fields.getTextInputValue("hours"));if(!d)return denied(i,"Esta ficha expirou.");if(!Number.isInteger(hours)||hours<1||hours>8760)return denied(i,"Informe de 1 a 8760 horas.");d.durationMs=hours*3600000;store.updateDraft(id,i.guildId,i.user.id,d.profile,d.durationMs);return reply(i,draftCard(i.guild,d));}
      if(i.isModalSubmit?.()&&i.customId.startsWith("rw:preset-name:")){
        const draftId=i.customId.split(":")[2],d=store.draft(draftId,i.guildId,i.user.id);
        if(!d||!presetSentinel(d.userId)||presetDraftId(d.userId)!=="new")return denied(i,"Esta ficha expirou.");
        const name=safe(i.fields.getTextInputValue("name"));
        if(name.length<2)return denied(i,"Informe um nome com pelo menos 2 caracteres.");
        try{store.savePreset(i.guildId,null,name,d.profile,i.user.id);}
        catch(error){return denied(i,error.message);}
        store.deleteDraft(draftId);return reply(i,presetCard(i.guild));
      }
      if(i.isModalSubmit?.()&&i.customId==="rw:search"){const id=i.fields.getTextInputValue("userId").replace(/[<@!>]/g,"");const r=store.row(i.guildId,id);return r?reply(i,managerCard(i.guild,{...r,profile:JSON.parse(r.profile)})):reply(i,new ContainerBuilder().setAccentColor(BLUE).addTextDisplayComponents(txt("Nenhuma autorização encontrada.")));}
    }catch(error){console.error("[Whitelist de cargos] Seletor:",error);if(!i.replied&&!i.deferred)await denied(i,"Não foi possível atualizar a autorização.").catch(()=>{});}
  });

  function close(){clearInterval(expiryTimer);for(const timer of inactivityTimers.values())clearTimeout(timer);inactivityTimers.clear();}
  function applyRolePreset(guild,userId,roleId,actorId){
    if(!guild?.id||!userId||!roleId)return false;
    const preset=store.rolePreset(guild.id,roleId);
    if(!preset)return false;
    const member=guild.members?.cache?.get(userId);
    if(!member?.roles?.cache?.has(roleId))return false;
    const existing=store.active(guild.id,userId);
    if(existing&&JSON.stringify(existing.profile)===JSON.stringify(preset.profile))return false;
    store.saveUser(guild.id,userId,preset.profile,"active",actorId||guild.ownerId,0,
      `Cargo <@&${roleId}> · preset ${preset.name}`);
    return true;
  }
  return {store,access,canTarget,targetDenial,canRole,applyRolePreset,
    close,adminPanel:panel,admin,permissionLabel(auth){return auth?.kind==="whitelist"?"Whitelist individual":"Gerenciar Cargos do Discord";}};
};
