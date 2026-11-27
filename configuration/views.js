const {ChannelSelectMenuBuilder,UserSelectMenuBuilder,RoleSelectMenuBuilder,ChannelType,ButtonStyle}=require("discord.js");
const ui=require("./ui");
const {VARIABLES}=require("./render");
const {colorHex}=require("../panel-art/colors");
const {panelsForSystem,COMMAND_LABELS}=require("./systems");
const SLOTS={top:"Banner superior",main:"Imagem principal",bottom:"Banner inferior",thumbnail:"Thumbnail lateral",
  serverAvatar:"Avatar do servidor",botAvatar:"Avatar da Lumiya",serverBanner:"Banner do servidor",icon:"Ícone personalizado"};
const MODES={default:"Padrão do sistema",none:"Não exibir",guildIcon:"Foto do servidor",guildBanner:"Banner do servidor",botAvatar:"Avatar da Lumiya",asset:"Imagem personalizada"};

module.exports=function createViews({store,panels,systems,commands,context,apis,access}){
  const channelMenu=(s,action,placeholder)=>ui.row(new ChannelSelectMenuBuilder()
    .setCustomId(ui.cid(s,action)).setChannelTypes(ChannelType.GuildText,ChannelType.GuildAnnouncement).setPlaceholder(placeholder));
  const container=(accent,parts)=>ui.container(accent,parts);
  const block=(title,lines)=>container(ui.TOKENS.lilac,[ui.text(`### ${title}`),ui.separator(),ui.text(lines)]);
  const navRow=(s,items)=>ui.row(...items);

  function breadcrumb(data,systemList,definition){
    const view=data.view||"home",system=systemList.find(item=>item.id===data.systemId);
    if(view==="system")return ["Funções",system?.label||"Sistema"];
    if(view==="functions")return ["Funções"];
    if(view==="panels")return ["Aparência","Templates"];
    if(view==="editor")return ["Aparência","Templates",definition?.label||"Painel"];
    if(["texts","appearance","images","components","variables","publish","publications","adopt","history","confirm"].includes(view))
      return ["Aparência","Templates",definition?.label||"Painel",view];
    if(view==="general")return ["Acesso"];
    if(view.startsWith("access"))return ["Acesso",view==="access"?"Visão geral":view.replace("access","").replace(/([A-Z])/g," $1").trim()||"Visão geral"];
    if(view==="welcome")return ["Comunidade","Boas-vindas"];
    if(view==="logs")return ["Segurança","Logs"];
    if(view==="appearanceRoot")return ["Aparência"];
    return ["Início"];
  }
  return async function view(s,i,notice=""){
    const ctx=context(i),guild=i.guild,data=s.data,systemList=systems(),name=ui.cleanName(guild.name);
    const isOwner=i.user.id===guild.ownerId;
    const roleIds=[...(i.member?.roles?.cache?.keys?.()||[])];
    const privileged=access?access.isPrivileged(i.member?.permissions):false;
    const can=(key,level=1)=>isOwner||privileged||!access||access.can(guild.id,i.user.id,roleIds,guild.ownerId,key,level,privileged);
    const visibleSystems=isOwner||privileged||!access?systemList:access.visibleSystems(guild.id,i.user.id,roleIds,guild.ownerId,privileged);
    const noticeText=notice?`${notice}\n\n`:"";
    const draft=data.draftId?store.getDraft(data.draftId,guild.id,i.user.id):null;
    const definition=draft?panels.get(draft.panelId):null;
    const fields=draft?await panels.fields(draft.panelId,ctx):null;
    const home=()=>navRow(s,[ui.button(s,"home","Início",ButtonStyle.Secondary)]);
    const back=()=>navRow(s,[ui.button(s,"back","Voltar",ButtonStyle.Secondary)]);
    const shell=options=>ui.page({...options,ctx,guild,bot:ctx.bot,path:breadcrumb(data,systemList,definition),ephemeral:true});
    switch(data.view||"home"){
      case "home":{
        const active=visibleSystems.filter(system=>{try{return system.status(guild);}catch{return false;}}).length;
        const published=store.publications(guild.id).filter(row=>row.status==="published").length;
        const query=(data.query||"").trim().toLocaleLowerCase("pt-BR");
        const matches=query?visibleSystems.filter(system=>`${system.label} ${system.description}`.toLocaleLowerCase("pt-BR").includes(query)):visibleSystems;
        return shell({
          title:"Central da Lumiya ♡",subtitle:`Lumiya • ${name}`,
          description:`Escolha uma função abaixo. Dentro dela você pode configurar, publicar painéis e gerenciar o que já está no servidor.${noticeText?`\n${notice}`:""}`,
          body:[block("Informações do servidor",`Servidor: ${name}\nMembros: ${guild.memberCount??0}\nSistemas ativos: ${active} de ${systemList.length}\nPainéis publicados: ${published}`)],
          rows:[
             ui.menu(s,"category",query?`Resultados para “${data.query}”`:"O que você quer configurar?",ui.categoryOptions(matches),{page:data.systemPage||0}),
             ui.row(ui.button(s,"functions","Funções",ButtonStyle.Primary),
              ui.button(s,"appearanceRoot","Aparência").setDisabled(!(isOwner||privileged||access.can(guild.id,i.user.id,roleIds,guild.ownerId,"panel.appearance",1,privileged))),
               ui.button(s,"templates","Todos os painéis").setDisabled(!can("panel.templates")),
              isOwner?ui.button(s,"access","Acesso"):null),
             navRow(s,[ui.button(s,"search","Pesquisar").setEmoji({id:"1569941293323255889",name:"1378484773118541847"}),
               ui.button(s,"refresh","Atualizar"),ui.button(s,"allPublications","Painéis publicados").setDisabled(!can("panel.publish")),
               ui.button(s,"logs","Logs (opcional)").setDisabled(!can("panel.logs"))])
          ],
          footer:systemList.length?"":ui.feedback.empty()
        });
      }
      case "access":{
        const rows=access.store.accessRows(guild.id),roles=rows.filter(row=>row.subjectType==="role"),users=rows.filter(row=>row.subjectType==="user");
        const state=container(ui.TOKENS.lilac,[
          ui.text("### Estado do acesso"),ui.separator(),
          ui.text(`**Dono** · ${guild.ownerId?`<@${guild.ownerId}>`:"—"} · acesso permanente\n**Cargos** · ${roles.length?`${roles.length} configurado(s)`:"nenhum configurado"}\n**Membros** · ${users.length?`${users.length} configurado(s)`:"nenhum configurado"}\n\n-# A equipe com permissões de administração, gestão ou moderação do Discord tem acesso automático. Somente o dono pode conceder ou revogar acessos.`)
        ]);
        const sections=container(ui.TOKENS.accent,[
          ui.section([ui.text("**Acesso por cargo**"),ui.text("-# Permita que equipes inteiras tenham acesso às configurações da Lumiya.")],null,
            ui.button(s,"accessRoleForm","Gerenciar",{emoji:"👥"})),
          ui.separator(),
          ui.section([ui.text("**Acesso individual**"),ui.text("-# Conceda permissões específicas para membros do servidor.")],null,
            ui.button(s,"accessUserForm","Gerenciar",{emoji:"➕"}))
        ]);
        return shell({
          title:"Acesso ao painel",subtitle:"Permissões privadas da Lumiya ♡",
          description:noticeText||"Escolha uma área para visualizar ou alterar os acessos.",
          body:[state,sections],
          rows:[ui.menu(s,"accessTab","Visão geral, cargos, membros, permissões ou histórico",[
            {label:"Visão geral",value:"overview",description:"Estado atual dos acessos"},
            {label:"Acesso por cargo",value:"roles",description:"Equipes autorizadas"},
            {label:"Acesso individual",value:"users",description:"Membros autorizados"},
            {label:"Permissões específicas",value:"permissions",description:"Níveis por funcionalidade"},
            {label:"Histórico de alterações",value:"history",description:"Auditoria de acessos"}
          ]),navRow(s,[ui.button(s,"home","Voltar"),ui.button(s,"refresh","Atualizar")])]
        });
      }
      case "accessRoles":
      case "accessUsers":{
        const type=data.view==="accessRoles"?"role":"user",rows=access.store.accessRows(guild.id).filter(row=>row.subjectType===type);
        const selected=data.accessRecord?rows.find(row=>row.subjectId===data.accessRecord.split(":")[1]):null;
        const label=row=>type==="role"?`Cargo <@&${row.subjectId}>`:`Membro <@${row.subjectId}>`;
        return shell({
          title:type==="role"?"Acesso por cargo":"Acesso individual",subtitle:"Registros autorizados ♡",
          description:selected?`${label(selected)} · nível ${selected.level===2?"gerenciamento":selected.level===1?"visualização":"sem acesso"}\nPermissões: ${Object.keys(JSON.parse(selected.permissions||"{}")).length}\nConcedido por: ${selected.grantedBy?`<@${selected.grantedBy}>`:"importação"}\n${selected.expiresAt?`Expira: <t:${Math.floor(selected.expiresAt/1000)}:f>`:"Permanente"}`:
            (rows.length?`${rows.length} registro(s). Selecione para editar ou revogar.`:ui.feedback.empty()),
          rows:[ui.menu(s,"accessRecord",type==="role"?"Selecione um cargo":"Selecione um membro",rows.map(row=>({
            label:type==="role"?`Cargo ${row.subjectId}`:`Membro ${row.subjectId}`,value:`${type}:${row.subjectId}`,
            description:row.level===2?"Gerenciamento":row.level===1?"Visualização":"Sem acesso"
          })),{page:data.accessPage||0}),
            ui.row(ui.button(s,"accessRoleForm","Novo acesso por cargo").setDisabled(type!=="role"),ui.button(s,"accessUserForm","Novo acesso individual").setDisabled(type!=="user")),
            ui.row(ui.button(s,"accessEdit","Editar",ButtonStyle.Primary).setDisabled(!selected),ui.button(s,"accessDetails","Detalhes").setDisabled(!selected),ui.button(s,"accessRevoke","Revogar",ButtonStyle.Danger).setDisabled(!selected)),
            ui.row(ui.button(s,"accessPrev","Anterior").setDisabled(!(data.accessPage>0)),ui.button(s,"accessNext","Próxima").setDisabled(((data.accessPage||0)+1)*20>=rows.length),ui.button(s,"access","Voltar"))]
        });
      }
      case "accessPermissions":{
        const rows=access.store.accessRows(guild.id);
        const selected=data.accessRecord?rows.find(row=>row.subjectId===data.accessRecord.split(":")[1]):null;
        const permissions=selected?JSON.parse(selected.permissions||"{}"):{};
        const lines=access.keys.map(key=>`${permissions[key.id]===2?"🟢":permissions[key.id]===1?"🔵":"⚪"} ${key.label} · ${permissions[key.id]===2?"gerenciamento":permissions[key.id]===1?"visualização":"sem acesso"}`).slice(0,12);
        return shell({
          title:"Permissões específicas",subtitle:"Três níveis por funcionalidade ♡",
          description:`${selected?`Registro selecionado: ${selected.subjectType==="role"?`<@&${selected.subjectId}>`:`<@${selected.subjectId}>`}`:"Selecione um registro para consultar os níveis."}\n\n-# ⚪ sem acesso · 🔵 visualização · 🟢 gerenciamento`,
          body:selected?[block("Níveis concedidos",lines.join("\n"))]:[],
          rows:[ui.menu(s,"accessRecord","Cargo ou membro",rows.map(row=>({label:`${row.subjectType==="role"?"Cargo":"Membro"} ${row.subjectId}`,value:`${row.subjectType}:${row.subjectId}`}))),
            ui.row(ui.button(s,"accessEdit","Editar permissões",ButtonStyle.Primary).setDisabled(!selected),ui.button(s,"access","Voltar"))]
        });
      }
      case "accessHistory":{
        const rows=access.store.accessHistory(guild.id,100),page=data.historyPage||0;
        const selected=rows.slice(page*10,page*10+10);
        return shell({
          title:"Histórico de alterações",subtitle:"Quem concedeu, alterou ou revogou ♡",
          description:selected.length?selected.map(row=>`<t:${Math.floor(row.createdAt/1000)}:f> · ${row.action} · ${row.subjectType} ${row.subjectId}\n-# ${row.actorId?`<@${row.actorId}>`:"sistema"}${row.reason?` · ${row.reason}`:""}`).join("\n"):ui.feedback.empty(),
          rows:[ui.row(ui.button(s,"historyPrev","Anterior").setDisabled(page===0),ui.button(s,"historyNext","Próxima").setDisabled((page+1)*10>=rows.length),ui.button(s,"access","Voltar"))]
        });
      }
      case "functions":{
        return shell({
          title:"Funções da Lumiya ♡",subtitle:`Lumiya • ${name}`,
          description:"Escolha a função. Configurações, publicação e personalização ficam reunidas no mesmo lugar.",
          body:[block("Sistemas encontrados",`${visibleSystems.length} categoria(s) disponível(is).\n-# Cada painel mantém as permissões do próprio módulo.`)],
          rows:[ui.menu(s,"category","Funcionalidades",ui.categoryOptions(visibleSystems),{page:data.systemPage||0}),home()]
        });
      }
      case "system":
      case "systemSettings":{
        const system=visibleSystems.find(item=>item.id===data.systemId);
        if(!system)throw new Error("Este sistema não está mais disponível.");
        let enabled;try{enabled=system.status(guild);}catch{enabled=false;}
        const options=system.commands.map(name=>commands.commands.get(name)).filter(Boolean).map(command=>({
          label:COMMAND_LABELS[command.name]||command.description.split(".")[0].slice(0,90),
          value:command.name,description:command.description.slice(0,100)
        }));
        if(system.id==="ai"&&commands.commands.has("chat"))options.push(
          {label:"Ativar chat de IA",value:"chat:on",emoji:ui.emojis.object("ativar")},
          {label:"Desativar chat de IA",value:"chat:off",emoji:ui.emojis.object("desativar")},
          {label:"Ativar participação espontânea",value:"chat:espontaneo on",emoji:ui.emojis.object("ativar")},
          {label:"Desativar participação espontânea",value:"chat:espontaneo off",emoji:ui.emojis.object("desativar")},
          {label:"Convidar a Lumiya para esta conversa",value:"chat:participar"},
          {label:"Limpar memória deste canal",value:"chat:limpar canal"},
          {label:"Limpar memória do servidor",value:"chat:limpar servidor"},
          {label:"Ver memória do chat",value:"chat:memoria"});
        const entries=(system.entries||[]).map(name=>commands.commands.get(name)).filter(Boolean)
          .map(command=>`${command.prefix?.trigger||`/${command.name}`} — ${command.description}`).join("\n").slice(0,1600);
        const available=panelsForSystem(system,panels),panelIds=new Set(available.map(p=>p.id));
        const published=store.publications(guild.id).filter(row=>panelIds.has(row.panelId)&&row.status==="published");
        let aiStats=null;
        try{aiStats=system.id==="ai"?apis.ai?.memoryStats?.(guild.id,i.channelId):null;}catch{aiStats=null;}
        if(data.view==="systemSettings")return shell({
          title:`Configurar ${system.label}`,subtitle:"Ajustes e ferramentas desta função.",
          description:noticeText||"Escolha o que deseja ajustar. Cada ferramenta continua respeitando suas permissões.",
          body:entries?[block("Outras ações",entries)]:[],
          rows:[...(options.length?[ui.menu(s,"launch","Qual configuração deseja abrir?",options)]:[]),
            ui.row(ui.button(s,"systemHome","Voltar"),ui.button(s,"home","Início"))]
        });
        return shell({
          title:`${system.label} ♡`,subtitle:`Lumiya • ${name}`,description:noticeText||`${system.description}\nEscolha o que deseja fazer abaixo.`,
          body:[
            ui.statusContainer([ui.stateLine("Sistema",enabled),ui.stateLine("Painel privado",true)]),
            ...(aiStats?[block("Memória do chat",
              `Canal atual: **${aiStats.channel.messages}** mensagem(ns)${aiStats.channel.hasSummary?" · resumo pronto":""}\n`+
              `Servidor: **${aiStats.guild.channels}** canal(is) · **${aiStats.guild.messages}** mensagem(ns)\n`+
              `Participação espontânea: **${aiStats.spontaneous?"ativada":"desativada"}**\n`+
              `Retenção: **${aiStats.channel.retentionDays}** dia(s)`)]:[]),
            ...(!options.length&&!available.length&&entries?[block("Comandos disponíveis",entries)]:[]),
            ...(available.length?[block("Painéis desta função",
              `${available.map(p=>`**${p.label}**`).join(" · ")}\n${published.length} painel(is) publicado(s) no servidor.`)]:[])
          ],
          rows:[ui.row(
            ui.button(s,"systemSettings","Configurar",ButtonStyle.Primary).setDisabled(!options.length||!can(`system:${system.id}`,2)),
            ui.button(s,"systemPublish","Publicar painel").setDisabled(!available.length||!can("panel.publish",2)),
            ui.button(s,"systemEditPanels","Personalizar").setDisabled(!available.length||!can("panel.templates",2)),
            ui.button(s,"systemPublications","Painéis publicados").setDisabled(!available.length||!can("panel.publish"))),
            ui.row(ui.button(s,"functions","Voltar"),ui.button(s,"home","Início"))]
        });
      }
      case "systemPanels":{
        const system=visibleSystems.find(item=>item.id===data.systemId);
        if(!system)throw new Error("Esta função não está disponível para você.");
        const available=panelsForSystem(system,panels);
        return shell({
          title:`${data.systemPanelMode==="edit"?"Personalizar":"Publicar painel"} • ${system.label}`,
          subtitle:"Somente os painéis desta função.",
          description:noticeText||(data.systemPanelMode==="edit"?"Escolha o painel para editar textos, imagens e botões.":
            "Escolha o painel. Na próxima tela, selecione o canal e confirme a publicação."),
          rows:[ui.menu(s,"systemPanel","Qual painel você quer usar?",available.map(p=>({
            label:p.label,value:p.id,description:data.systemPanelMode==="edit"?"Personalizar sem alterar a versão publicada":"Escolher o canal e publicar"
          }))),ui.row(ui.button(s,"systemHome","Voltar"),ui.button(s,"home","Início"))]
        });
      }
      case "appearanceRoot":
        return shell({
          title:"Aparência ♡",subtitle:`Lumiya • ${name}`,
          description:"Escolha o que deseja personalizar. Tudo fica salvo somente neste servidor.",
          body:[block("Estado atual",`Cor padrão: \`${colorHex(ui.TOKENS.accent)}\`\nPainéis personalizados: ${Object.keys(store.settings(guild.id).panelColors||{}).length}`)],
          rows:[
            ui.row(ui.button(s,"cor","Cor dos painéis"),ui.button(s,"panels","Editor de painéis",ButtonStyle.Primary)),
            ui.row(ui.button(s,"onboardEditor","Boas-vindas"),ui.button(s,"welcomeEditor","Recepção de membros")),home()
          ]
        });
      case "panels":{
        const items=panels.list(),page=data.page||0;
        const options=items.map(panel=>({label:panel.label,value:panel.id,description:panel.category||"Painel público"}));
        return shell({
          title:"Todos os painéis ♡",subtitle:"Publicação e personalização.",
          description:`${noticeText}Escolha o painel que deseja personalizar. Rascunhos não alteram os painéis publicados até você salvar e atualizar.`,
          body:[block("Painéis disponíveis",`${items.length} template(s) registrado(s).`)],
          rows:[ui.menu(s,"panel","Selecione um painel...",options,{page}),
            ui.row(ui.button(s,"panelPrev","Anterior").setDisabled(page===0),ui.button(s,"panelNext","Próxima").setDisabled((page+1)*20>=items.length),ui.button(s,"allPublications","Publicados")),home()]
        });
      }
      case "editor":{
        const saved=store.panel(guild.id,draft.panelId),c=draft.data;
        const actual=await panels.render(draft.panelId,ctx,{config:c}),nodes=ui.flat(actual.components);
        const title=ui.cleanName((nodes.find(node=>node.type===10)?.content||definition.label).split("\n")[0]);
        const accent=actual.components.find(node=>node.type===17)?.accent_color;
        const color=Number.isInteger(accent)?colorHex(accent):"Padrão do sistema";
        const icon=guild.iconURL?.({size:256})?.split("?")[0].replace(/\.(png|gif|webp|jpe?g)$/i,"");
        const media=nodes.flatMap(node=>node.type===11?[node.media?.url]:node.type===12?node.items.map(item=>item.media?.url):[]);
        const iconActive=Boolean(icon&&media.some(url=>url?.split("?")[0].replace(/\.(png|gif|webp|jpe?g)$/i,"")===icon));
        return shell({
          title:`Editando: ${definition.label} ♡`,subtitle:"Personalize cada detalhe deste painel.",
          description:noticeText||"As alterações ficam em rascunho até você salvar.",
          body:[block("Aparência do rascunho",
            `Título: ${title}\nCor: \`${color}\`\nImagem principal: ${MODES[c.images?.main?.mode||"default"]}\nThumbnail: ${nodes.some(node=>node.type===11)?MODES[c.images?.thumbnail?.mode||"default"]:"desativada"}\nFoto do servidor: ${iconActive?"ativada":"desativada"}\nÚltima alteração salva: ${saved.updatedAt?`<t:${Math.floor(saved.updatedAt/1000)}:f> · <@${saved.updatedBy}>`:"padrão original"}`)],
          rows:[
            ui.row(ui.button(s,"texts","Editar textos"),ui.button(s,"appearance","Personalizar aparência")),
            ui.row(ui.button(s,"images","Configurar imagens"),ui.button(s,"components","Configurar componentes")),
            ui.row(ui.button(s,"preview","Pré-visualizar",ButtonStyle.Primary),ui.button(s,"save","Salvar alterações")),
            ui.row(ui.button(s,"publish","Publicar"),ui.button(s,"publications","Atualizar publicados"),ui.button(s,"history","Histórico")),
             ui.row(ui.button(s,"reset","Restaurar padrão"),ui.button(s,"discard","Descartar rascunho")),
             data.systemId?ui.row(ui.button(s,"systemHome","Voltar à função"),ui.button(s,"home","Início")):home()
          ]
        });
      }
      case "texts":{
        const page=data.fieldPage||0,selected=Number(data.fieldIndex||0),entry=fields.texts[selected];
        return shell({
          title:`Textos • ${definition.label}`,subtitle:"Cada bloco mantém o contexto do painel original.",
          description:noticeText||`${entry?`**Bloco ${selected+1}:**\n${(draft.data.texts?.[selected]??entry.content).slice(0,700)}`:"Este painel não possui blocos de texto."}`,
          rows:[ui.menu(s,"textField","Escolha o texto",fields.texts.map(item=>({label:`${item.index===0?"Título":`Texto ${item.index+1}`} · ${item.content.replace(/[#*]/g,"").slice(0,60)}`,value:String(item.index)})),{page}),
            ui.row(ui.button(s,"textPrev","Anterior").setDisabled(page===0),ui.button(s,"textNext","Próxima").setDisabled((page+1)*20>=fields.texts.length)),
            ui.row(ui.button(s,"editText","Editar texto",ButtonStyle.Primary).setDisabled(!entry),ui.button(s,"resetText","Restaurar texto").setDisabled(!entry),ui.button(s,"hideText",draft.data.hideTexts?.includes(selected)?"Mostrar bloco":"Ocultar bloco").setDisabled(!entry||selected===0)),
            ui.row(ui.button(s,"extras","Subtítulo e rodapé"),ui.button(s,"variables","Variáveis dinâmicas")),back()
          ]
        });
      }
      case "appearance":
        return shell({
          title:`Aparência • ${definition.label}`,subtitle:"Cor, separadores e mensagens complementares.",
          description:noticeText||`A cor global também pode ser alterada em \`${commands.commands.get("corpainel")?.prefix?.trigger||"!cor"}\`.`,
          rows:[ui.row(ui.button(s,"editColor","Cor em HEX",ButtonStyle.Primary),ui.button(s,"resetColor","Restaurar cor")),
            ui.menu(s,"separator","Separadores",[
              {label:"Padrão do painel",value:"default"},{label:"Sem separadores",value:"none"},
              {label:"Separadores discretos",value:"small"},{label:"Separadores com mais espaço",value:"large"}]),
            ui.row(ui.button(s,"extras","Subtítulo e rodapé"),ui.button(s,"preview","Pré-visualizar")),back()]
        });
      case "images":{
        const slot=data.slot||"main";
        return shell({
          title:`Imagens • ${definition.label}`,subtitle:`Posição: ${SLOTS[slot]}`,
          description:noticeText||`Modo: ${MODES[draft.data.images?.[slot]?.mode||"default"]}\nImplantações por URL ou upload são validadas e armazenadas. Até 5 MB por arquivo e 30 MB por servidor.`,
          rows:[ui.menu(s,"imageSlot","Selecione a posição da imagem",Object.entries(SLOTS).map(([value,label])=>({label,value}))),
            ui.menu(s,"imageMode","Escolha a origem da imagem",Object.entries(MODES).filter(([key])=>key!=="asset").map(([value,label])=>({label,value}))),
            ui.row(ui.button(s,"imageURL","Adicionar por URL"),ui.button(s,"imageUpload","Enviar imagem")),
            ui.row(ui.button(s,"hideImages","Ocultar todas"),ui.button(s,"resetImages","Restaurar imagens"),ui.button(s,"preview","Pré-visualizar")),
            ui.row(ui.button(s,"pruneAssets","Limpar imagens não utilizadas")),back()]
        });
      }
      case "components":{
        const page=data.controlPage||0,control=fields.controls.find(item=>item.id===data.controlId);
        return shell({
          title:`Componentes • ${definition.label}`,subtitle:"A aparência muda; a função permanece.",
          description:noticeText||`${control?`**Selecionado:** ${control.label}`:"Selecione um botão ou menu."} IDs internos e valores das opções são preservados.`,
          rows:[ui.menu(s,"control","Selecione um componente",fields.controls.map((item,n)=>({label:`${item.type===2?"Botão":"Menu"} · ${item.label}`.slice(0,100),value:String(n)})),{page}),
            ui.row(ui.button(s,"controlPrev","Anterior").setDisabled(page===0),ui.button(s,"controlNext","Próxima").setDisabled((page+1)*20>=fields.controls.length)),
            ui.row(ui.button(s,"editControl","Editar componente",ButtonStyle.Primary).setDisabled(!control),ui.button(s,"resetControl","Restaurar componente").setDisabled(!control)),
            control?.options?ui.menu(s,"controlOption","Selecione uma opção do menu",control.options.map((option,n)=>({label:option.label,value:String(n)})),{size:25}):null,
            data.optionValue&&control?.options?ui.row(ui.button(s,"editOption","Editar opção"),ui.button(s,"resetOption","Restaurar opção")):null,back()]
        });
      }
      case "variables":
        return shell({
          title:"Variáveis dinâmicas",subtitle:"Use-as nos textos dos painéis.",
          description:`${VARIABLES.map(variable=>`\`{${variable}}\``).join(" · ")}\n\n-# O valor é resolvido no contexto da publicação e nunca vira menção automática.`,
          rows:[back()]
        });
      case "publish":
        return shell({
          title:`Publicar • ${definition.label}`,subtitle:"Escolha onde o painel deve aparecer.",
          description:noticeText||`Canal: ${data.channelId?`<#${data.channelId}>`:"não selecionado"}\nA publicação usa a versão salva, não o rascunho.`,
          rows:[channelMenu(s,"publishChannel","Escolha o canal de publicação"),
            ui.row(ui.button(s,"publishNow",data.republishId?"Republicar painel":"Publicar novo painel",ButtonStyle.Primary).setDisabled(!data.channelId)),back()]
        });
      case "publications":{
        const system=data.publicationSystem?visibleSystems.find(item=>item.id===data.publicationSystem):null;
        if(data.publicationSystem&&!system)throw new Error("Esta função não está disponível para você.");
        const allowedIds=system?new Set(panelsForSystem(system,panels).map(p=>p.id)):null;
        const page=data.pubPage||0,rows=store.publications(guild.id,data.allPublications?undefined:draft?.panelId)
          .filter(row=>!allowedIds||allowedIds.has(row.panelId));
        const selected=data.publicationId?rows.find(row=>row.id===data.publicationId):null;
        return shell({
          title:system?`Painéis publicados • ${system.label}`:"Painéis publicados",subtitle:"Gerencie as mensagens existentes da Lumiya.",
          description:noticeText||(rows.length?`${rows.length} publicação(ões) registrada(s). Escolha uma mensagem para atualizar ou gerenciar.`:
            "Nenhum painel publicado por aqui ainda. Use Publicar painel para escolher um canal."),
          body:selected?[block("Selecionada",`Painel: ${panels.get(selected.panelId).label}\nCanal: <#${selected.channelId}>\nEstado: ${selected.status}\nMensagem: \`${selected.messageId}\``)]:[],
          rows:[ui.menu(s,"publication","Selecione uma publicação",rows.map(row=>({label:`${panels.items.get(row.panelId)?.label||row.panelId} · ${guild.channels.cache?.get(row.channelId)?.name||row.channelId}`.slice(0,100),value:row.id,description:row.status})),{page}),
            ui.row(ui.button(s,"pubPrev","Anterior").setDisabled(page===0),ui.button(s,"pubNext","Próxima").setDisabled((page+1)*20>=rows.length)),
            ui.row(ui.button(s,"updatePublication","Atualizar mensagem",ButtonStyle.Primary).setDisabled(selected?.status!=="published"),ui.button(s,"deletePublication","Excluir",ButtonStyle.Danger).setDisabled(!selected||selected.status!=="published"),ui.button(s,"republish","Republicar").setDisabled(!selected||!["missing","deleted"].includes(selected.status))),
             ui.row(ui.button(s,"adopt","Vincular existente"),ui.button(s,"duplicate","Duplicar").setDisabled(!selected),ui.button(s,"updateAll","Atualizar todos").setDisabled(!draft||data.allPublications)),
             system?ui.row(ui.button(s,"systemPublish","Publicar painel",ButtonStyle.Primary).setDisabled(!can("panel.publish",2)),ui.button(s,"systemHome","Voltar")):draft?back():home()]
        });
      }
      case "adopt":
        return shell({
          title:"Vincular painel existente",subtitle:"Sem criar novas mensagens.",
          description:noticeText||"Escolha o canal e informe o ID de uma mensagem da própria Lumiya. Mensagens de membros não são alteradas.",
          rows:[channelMenu(s,"adoptChannel","Canal do painel existente"),ui.row(ui.button(s,"adoptMessage","Informar ID da mensagem",ButtonStyle.Primary).setDisabled(!data.channelId)),home()]
        });
      case "confirm":{
        if(data.confirm==="revoke"||data.confirm==="details"){
          const [type,subjectId]=String(data.accessRecord||"").split(":"),row=access.store.accessRow(guild.id,type,subjectId);
          const permissions=row?JSON.parse(row.permissions||"{}"):{};
          const lines=row?`Registro: ${type==="role"?`<@&${subjectId}>`:`<@${subjectId}>`}\nNível: ${row.level===2?"gerenciamento":row.level===1?"visualização":"sem acesso"}\nPermissões: ${Object.keys(permissions).length}\nConcedido por: ${row.grantedBy?`<@${row.grantedBy}>`:"importação"}\n${row.expiresAt?`Expira: <t:${Math.floor(row.expiresAt/1000)}:f>`:"Permanente"}\nMotivo: ${row.reason||"—"}`:ui.feedback.empty();
          return shell({
            title:data.confirm==="revoke"?"Revogar acesso ♡":"Detalhes do acesso ♡",subtitle:"Gerenciamento de permissões",
            description:data.confirm==="revoke"?`Tem certeza de que deseja revogar este acesso?\n\n${lines}`:
              `Informações do registro selecionado.\n\n${lines}`,
            rows:[...(data.confirm==="revoke"?[ui.row(ui.button(s,"accessConfirm","Revogar",ButtonStyle.Danger),ui.button(s,"cancel","Cancelar"))]:[]),
              ui.row(ui.button(s,"access","Voltar"))]
          });
        }
        return shell({
          title:"Confirmar alteração ♡",subtitle:"Uma última confirmação.",
          description:data.confirm==="delete"?"Excluir esta mensagem do Discord? O registro ficará disponível para republicação.":"Restaurar o rascunho para o padrão original? A versão publicada só muda depois de salvar.",
          rows:[ui.row(ui.button(s,"confirm","Confirmar",ButtonStyle.Danger),ui.button(s,"cancel","Cancelar")),back()]
        });
      }
      case "history":{
        const rows=store.history(guild.id,draft.panelId);
        return shell({
          title:`Histórico • ${definition.label}`,subtitle:"Últimas alterações deste painel.",
          description:rows.length?rows.map(row=>`<t:${Math.floor(row.createdAt/1000)}:f> · ${row.action} · ${row.userId?`<@${row.userId}>`:"sistema"}`).join("\n"):ui.feedback.empty(),
          rows:[back()]
        });
      }
      case "general":{
        const owner=i.user.id===guild.ownerId,settings=store.settings(guild.id);
        return shell({
          title:"Configurações gerais ♡",subtitle:`Lumiya • ${name}`,
          description:noticeText||"A central é privada. Proprietário e administradores têm acesso; o proprietário pode autorizar pessoas ou cargos adicionais.",
          body:[block("Acessos",`Usuários autorizados: ${settings.authorizedUsers?.length||0}\nCargos autorizados: ${settings.authorizedRoles?.length||0}`)],
          rows:[owner?ui.row(new UserSelectMenuBuilder().setCustomId(ui.cid(s,"authorizeUsers")).setPlaceholder("Definir usuários autorizados").setMinValues(0).setMaxValues(25).setDefaultUsers(settings.authorizedUsers||[])):null,
            owner?ui.row(new RoleSelectMenuBuilder().setCustomId(ui.cid(s,"authorizeRoles")).setPlaceholder("Definir cargos autorizados").setMinValues(0).setMaxValues(25).setDefaultRoles(settings.authorizedRoles||[])):null,
            ui.row(ui.button(s,"onboardPublish","Publicar boas-vindas da Lumiya")),home()]
        });
      }
      case "welcome":{
        const settings=store.settings(guild.id);
        return shell({
          title:"Boas-vindas de membros ♡",subtitle:"Uma chegada mais especial.",
          description:noticeText||"A recepção é opcional e não altera cargos automáticos ou verificações.",
          body:[ui.statusContainer([ui.stateLine("Recepção",Boolean(settings.welcomeEnabled)),ui.valueLine("Canal",settings.welcomeChannel?`<#${settings.welcomeChannel}>`:"não definido")])],
          rows:[channelMenu(s,"welcomeChannel","Escolha o canal de recepção"),
            ui.row(ui.button(s,"toggleWelcome",settings.welcomeEnabled?"Desativar recepção":"Ativar recepção",
              {style:ButtonStyle.Primary,emoji:ui.emojis.toggleEmoji(settings.welcomeEnabled)}).setDisabled(!settings.welcomeChannel)),
             ui.row(ui.button(s,"welcomeEditor","Personalizar recepção"),ui.button(s,"onboardEditor","Personalizar boas-vindas"),
               ui.button(s,"onboardPublish","Publicar boas-vindas").setDisabled(!can("panel.publish",2))),home()]
        });
      }
      case "logs":{
        const kinds=apis.logs?.availableKinds?.(guild.id)||apis.logs?.kinds||{};
        const kind=Object.hasOwn(kinds,data.logKind)?data.logKind:Object.keys(kinds).includes("general")?"general":Object.keys(kinds)[0];
        const id=apis.logs?.store.get(guild.id,kind),labels=apis.logs?.labels||{};
        const linked=Object.keys(kinds).filter(key=>apis.logs?.store.get(guild.id,key));
        const enabled=Boolean(apis.logs?.store.automatic?.(guild.id));
        return shell({
          title:"Logs da Lumiya ♡",subtitle:"Registros privados e organizados.",
          description:noticeText||"Os logs são opcionais. Nenhum canal é criado quando a Lumiya entra no servidor. Ative abaixo para criar canais privados e vincular cada função automaticamente.",
          body:[block("Seus registros",`Organização automática: **${enabled?"ativada por você":"não ativada"}**\nDestinos vinculados: **${linked.length} de ${Object.keys(kinds).length}**\n\n${Object.keys(kinds).map(key=>`${labels[key]||kinds[key]} · ${apis.logs.store.get(guild.id,key)?`<#${apis.logs.store.get(guild.id,key)}>`:"não configurado"}`).join("\n")||"O módulo de logs não está disponível."}`),
            ui.statusContainer([ui.valueLine(labels[kind]||kinds[kind]||"Destino",id?`<#${id}>`:"não configurado")])],
          rows:[ui.row(ui.button(s,"provisionLogs",enabled?"Verificar e vincular canais":"Ativar logs",
            {style:ButtonStyle.Primary,emoji:enabled?ui.emojis.object("ativo"):ui.emojis.object("ativar")})
            .setDisabled(!apis.logs?.enableGuild||!can("panel.logs",2))),
            ui.menu(s,"logKind","Ou configure um tipo de registro manualmente",Object.entries(kinds).map(([value,label])=>({label:labels[value]||label,value}))),
            channelMenu(s,"logChannel","Selecionar canal privado de logs"),
             home()]
        });
      }
      case "confirmLogs":{
        const kinds=apis.logs?.availableKinds?.(guild.id)||apis.logs?.kinds||{};
        return shell({
          title:"Ativar logs neste servidor?",subtitle:"Você decide o que a Lumiya cria.",
          description:`Vou preparar **${Object.keys(kinds).length} canal(is) privado(s)** e vincular cada um à função correspondente.\nSomente o bot, o dono e administradores terão acesso por padrão. Canais já vinculados serão reutilizados; nenhum histórico será apagado.\n\n${Object.values(kinds).map(label=>`\`${label}\``).join(" · ")}\n\nPreciso da permissão **Gerenciar canais**. A organização só começa depois da sua confirmação.`,
          rows:[ui.row(ui.button(s,"activateLogs","Criar e vincular logs",ButtonStyle.Primary),ui.button(s,"logs","Agora não"))]
        });
      }
      default:throw new Error("Tela indisponível. Abra /config novamente.");
    }
  };
};
module.exports.SLOTS=SLOTS;
module.exports.MODES=MODES;
