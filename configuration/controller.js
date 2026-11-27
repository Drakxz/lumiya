const {
  ModalBuilder,LabelBuilder,FileUploadBuilder,
  MessageFlags,PermissionFlagsBits
}=require("discord.js");
const {privateCommand,panelsForSystem}=require("./systems");
const {validate,emoji}=require("./render");
const {safeURL,download,sanitize}=require("./assets");
const {safeMessage}=require("../error-ui");
const ui=require("./ui");
module.exports=function createController(deps){
  const {client,commands,store,panels,publisher,systems,apis,member,audit,context,access}=deps;
  const imageDownload=deps.imageTransport||download;
  const view=require("./views")(deps),busy=new Set();
  const modalActions=["editText","editColor","extras","imageURL","imageUpload","editControl","editOption","adoptMessage","search","accessRoleForm","accessUserForm","accessEdit"];
  const destination={
    home:"home",refresh:"home",panels:"panels",editor:"editor",texts:"texts",appearance:"appearance",
    images:"images",components:"components",variables:"variables",publish:"publish",publications:"publications",
    history:"history",adopt:"adopt",functions:"functions",appearanceRoot:"appearanceRoot",
    templates:"panels",access:"access",accessRoles:"accessRoles",accessUsers:"accessUsers",
    accessPermissions:"accessPermissions",accessHistory:"accessHistory",logs:"logs"
  };
  const errorCard=message=>ui.page({
    title:"Ops! Não foi possível concluir",subtitle:"Lumiya ♡",description:ui.feedback.error(message),
    body:[],rows:[],ephemeral:true
  });
  const REQUIRED={
    home:"view",refresh:"view",functions:"view",system:"view",category:"view",search:"view",submitSearch:"view",
    appearanceRoot:"panel.appearance",templates:"panel.templates",panels:"panel.templates",editor:"panel.templates",
    texts:"panel.templates",appearance:"panel.appearance",images:"panel.appearance",components:"panel.templates",
    variables:"panel.templates",publish:"panel.publish",publications:"panel.publish",adopt:"panel.publish",
    history:"panel.templates",logs:"panel.logs",welcome:"system:welcome",
    systemPublish:"panel.publish",systemPublications:"panel.publish",systemEditPanels:"panel.templates",
    systemPanel:"view",systemHome:"view",systemSettings:"view",
    allPublications:"panel.publish",publication:"panel.publish",publishChannel:"panel.publish",
    publishNow:"panel.publish",updatePublication:"panel.publish",deletePublication:"panel.publish",
    duplicate:"panel.publish",republish:"panel.publish",updateAll:"panel.publish",
    onboardPublish:"panel.publish",
    provisionLogs:"panel.logs",activateLogs:"panel.logs",logKind:"panel.logs",logChannel:"panel.logs"
  };
  const MANAGE_ACTIONS=new Set(["systemPublish","systemEditPanels","publishChannel","publishNow","updatePublication",
    "deletePublication","duplicate","republish","updateAll","provisionLogs","activateLogs","logChannel","onboardPublish"]);
  const requireOwner=(actor,guild)=>{
    if(actor.id!==guild.ownerId)throw new Error("Você ainda não possui permissão para acessar esta configuração.");
  };
  const accessFields=(options={})=>[
    {id:"type",label:"Tipo de acesso",type:"select",options:[
      {label:"Acesso completo às configurações",value:"full"},
      {label:"Acesso personalizado",value:"custom"},
      {label:"Somente visualização",value:"view"}
    ],defaults:[options.type||"custom"]},
    {id:"managePerms",label:"Gerenciamento",description:"Funcionalidades que podem ser alteradas",type:"select",
      minValues:0,maxValues:25,required:false,options:access.keys.map(key=>({label:key.label,value:key.id})),
      defaults:options.managePerms||[]},
    {id:"viewPerms",label:"Visualização",description:"Funcionalidades que podem ser consultadas",type:"select",
      minValues:0,maxValues:25,required:false,options:access.keys.map(key=>({label:key.label,value:key.id})),
      defaults:options.viewPerms||[]}
  ];
  async function respondError(i,error){
    console.warn("[Central Lumiya] Interação não concluída:",error.code||error.name);
    const payload=errorCard(safeMessage(error));
    if(i.deferred||i.replied)await i.followUp(payload).catch(()=>{});
    else await i.reply(payload).catch(()=>{});
  }
  async function open(i){
    try{
      await i.deferReply({flags:MessageFlags.Ephemeral});
      await member(i);
      const session=store.session(i.guild.id,i.user.id,{view:"home",settingsVersion:store.settings(i.guild.id).version});
      await i.editReply(await view(session,i));
    }catch(error){await respondError(i,error);}
  }
  function form(s,action,title,fields){
    return ui.modal(s,action,title,fields.map(field=>({...field,type:field.type||"text"})));
  }
  async function showModal(action,s,i){
    const draft=s.data.draftId?store.getDraft(s.data.draftId,i.guild.id,i.user.id):null;
    if(draft&&s.data.draftRevision!==undefined&&s.data.draftRevision!==draft.revision)
      throw new Error("O rascunho foi alterado em outra sessão. Volte ao editor para recarregar a versão atual.");
    let modal;
    if(action==="accessRoleForm"||action==="accessUserForm"||action==="accessEdit"){
      requireOwner(await member(i),i.guild);
      let record=null;
      if(action==="accessEdit"){
        const key=s.data.accessRecord,parts=String(key||"").split(":"),row=access.store.accessRow(i.guild.id,parts[0],parts[1]);
        if(!row)throw new Error("Selecione um acesso existente.");
        record=access.public(row);
      }
      const current=record?JSON.parse(JSON.stringify(record.permissions||{})):{};
      const managePerms=Object.keys(current).filter(key=>current[key]>=2);
      const viewPerms=Object.keys(current).filter(key=>current[key]===1);
      const base=accessFields({type:record?.level===2?"custom":"view",managePerms,viewPerms});
      if(action==="accessRoleForm")base.unshift({id:"roles",label:"Cargos autorizados",type:"role",minValues:1,maxValues:25});
      if(action==="accessUserForm")base.unshift({id:"members",label:"Membros autorizados",type:"user",minValues:1,maxValues:25});
      if(action==="accessUserForm")base.push({id:"duration",label:"Duração do acesso",type:"select",
        options:[{label:"Permanente",value:"permanent"},{label:"1 hora",value:"hour"},{label:"24 horas",value:"day"},
          {label:"7 dias",value:"week"},{label:"30 dias",value:"month"}],defaults:[record?.durationKey||"permanent"]});
      const fields=[...base,{id:"reason",label:"Motivo (opcional)",max:400,required:false,value:record?.reason||""}];
      modal=form(s,action==="accessEdit"?"submitAccessEdit":action==="accessRoleForm"?"submitAccessRole":"submitAccessUser",
        action==="accessEdit"?'Editar acesso':action==="accessRoleForm"?"Gerenciar acesso por cargo":"Gerenciar acesso individual",fields);
    }else if(action==="search"){
      modal=form(s,"submitSearch","O que você procura?",[
        {id:"query",label:"Nome da função ou painel",max:100,value:s.data.query||"",placeholder:"Ex.: instagram, tickets, aparência"}
      ]);
    }else if(action==="adoptMessage"){
      modal=form(s,"submitAdopt","Vincular painel existente",[{id:"messageId",label:"ID da mensagem",max:20}]);
    }else if(action==="imageUpload"){
      const upload=new FileUploadBuilder().setCustomId("image").setMinValues(1).setMaxValues(1).setRequired(true).setFileTypes([".png",".jpg",".jpeg",".webp",".gif"]);
      modal=new ModalBuilder().setCustomId(ui.cid(s,"submitUpload")).setTitle("Enviar imagem do painel")
        .addLabelComponents(new LabelBuilder().setLabel("Imagem de até 5 MB").setFileUploadComponent(upload));
    }else if(action==="imageURL"){
      modal=form(s,"submitURL","Imagem por URL",[{id:"url",label:"URL HTTPS pública",max:2000,placeholder:"https://exemplo.com/banner.png"}]);
    }else if(action==="editColor"){
      modal=form(s,"submitColor","Cor de destaque",[{id:"color",label:"Cor hexadecimal",max:7,value:draft.data.color||"",placeholder:"#C4A7E7"}]);
    }else if(action==="extras"){
      modal=form(s,"submitExtras","Subtítulo e rodapé",[
        {id:"subtitle",label:"Subtítulo (vazio restaura o padrão)",value:draft.data.subtitle||"",max:500,required:false,paragraph:true},
        {id:"footer",label:"Rodapé (vazio restaura o padrão)",value:draft.data.footer||"",max:500,required:false,paragraph:true}
      ]);
    }else{
      const fields=await panels.fields(draft.panelId,context(i));
      if(action==="editText"){
        const n=Number(s.data.fieldIndex||0),entry=fields.texts[n];
        if(!entry)throw new Error("Selecione um bloco de texto.");
        modal=form(s,"submitText",`Editar ${n===0?"título":`texto ${n+1}`}`,[
          {id:"text",label:"Texto e variáveis dinâmicas",paragraph:true,value:draft.data.texts?.[n]??entry.content}
        ]);
      }
      if(action==="editControl"){
        const control=fields.controls.find(c=>c.id===s.data.controlId);
        if(!control)throw new Error("Selecione um componente.");
        const saved=draft.data.components?.[control.id]||{};
        modal=form(s,"submitControl","Apresentação do componente",[
          {id:"label",label:control.type===2?"Texto do botão":"Placeholder do menu",value:saved.label||saved.placeholder||control.label,max:control.type===2?80:150},
          ...(control.type===2?[...(control.style!==5?[{id:"style",label:"Estilo: 1 principal, 2 neutro, 3 verde, 4 vermelho",value:String(saved.style||control.style||2),max:1}]:[]),
            {id:"emoji",label:"Emoji (opcional)",value:saved.emoji||"",required:false,max:100}]:[])
        ]);
      }
      if(action==="editOption"){
        const control=fields.controls.find(c=>c.id===s.data.controlId),option=control?.options?.find(o=>o.value===s.data.optionValue);
        if(!option)throw new Error("Selecione uma opção do menu.");
        const saved=draft.data.components?.[control.id]?.options?.[option.value]||{};
        modal=form(s,"submitOption","Texto da opção do menu",[
          {id:"label",label:"Texto da opção",value:saved.label||option.label,max:100},
          {id:"description",label:"Descrição (opcional)",value:saved.description??option.description,max:100,required:false},
          {id:"emoji",label:"Emoji (opcional)",value:saved.emoji||"",max:100,required:false}
        ]);
      }
    }
    if(!modal)throw new Error("Formulário indisponível.");
    return i.showModal(modal);
  }
  function getText(i,key){return i.fields.getTextInputValue(key).trim();}
  function getValues(i,key){
    const fields=i.fields;
    if(typeof fields.getStringSelectValues==="function")return fields.getStringSelectValues(key);
    return fields.getSelectValues?.(key)||[];
  }
  function getUsers(i,key){return [...(i.fields.getSelectedUsers?.(key)?.values?.()||[])];}
  function getRoles(i,key){return [...(i.fields.getSelectedRoles?.(key)?.values?.()||[])];}
  function accessPayload(i){
    const type=getValues(i,"type")[0]||"custom",manage=getValues(i,"managePerms"),view=getValues(i,"viewPerms");
    if(!["full","custom","view"].includes(type))throw new Error("Tipo de acesso inválido.");
    const permissions={};
    if(type==="full")permissions["*"]=2;
    else if(type==="view")permissions["*"]=1;
    else{
      for(const key of manage)permissions[key]=2;
      for(const key of view)if(!permissions[key])permissions[key]=1;
      if(!Object.keys(permissions).length)throw new Error("Selecione ao menos uma funcionalidade.");
    }
    return {level:type==="view"?1:2,permissions,reason:getText(i,"reason")};
  }
  function durationValue(key){
    if(!Object.hasOwn({permanent:1,hour:1,day:1,week:1,month:1},key))throw new Error("Duração inválida.");
    return require("./access").DURATIONS[key]?Date.now()+require("./access").DURATIONS[key]:null;
  }
  async function handle(i){
    if(!i.customId?.startsWith("lc:"))return;
    if(/^lc:preview:\d+$/.test(i.customId)){
      return i.reply(errorCard("Esta é apenas uma prévia. Use o painel publicado para executar ações.")).catch(()=>{});
    }
    const [,action,id,revision]=i.customId.split(":");
    if(action==="open"||action==="quick"){
      try{
        await i.deferReply({flags:MessageFlags.Ephemeral});
        await member(i);
        const selected=action==="quick"?i.values?.[0]:null;
        const initial=categoryData(selected,{view:"home"});
        const session=store.session(i.guild.id,i.user.id,{...initial,settingsVersion:store.settings(i.guild.id).version});
        await i.editReply(await view(session,i));
      }catch(error){await respondError(i,error);}
      return;
    }
    if(busy.has(id))return i.reply(errorCard("Há uma alteração em andamento. Aguarde e use a tela atual.")).catch(()=>{});
    busy.add(id);
    try{
      if(!modalActions.includes(action))await i.deferUpdate();
      const actor=await member(i);
      let session=store.getSession(id,i.guild.id,i.user.id,revision);
      if(action==="access"||action.startsWith("access")||["submitAccessRole","submitAccessUser","submitAccessEdit","accessConfirm"].includes(action))
        requireOwner(actor,i.guild);
      else{
        const key=REQUIRED[action]||REQUIRED[destination[action]];
        if(key&&actor.id!==i.guild.ownerId&&!access.isPrivileged(actor.permissions)&&
          !access.can(i.guild.id,actor.id,[...actor.roles.cache.keys()],i.guild.ownerId,key,MANAGE_ACTIONS.has(action)?2:1,access.isPrivileged(actor.permissions)))
          throw new Error("Você ainda não possui permissão para acessar esta configuração.");
      }
      if(modalActions.includes(action))return await showModal(action,session,i);
      let data={...session.data},notice="";
      const can=(key,minimum=1)=>actor.id===i.guild.ownerId||access.isPrivileged(actor.permissions)||
        access.can(i.guild.id,actor.id,[...actor.roles.cache.keys()],i.guild.ownerId,key,minimum,false);
      const currentSystem=(minimum=1)=>{
        const system=systems().find(item=>item.id===data.systemId);
        if(!system||!can(`system:${system.id}`,minimum))throw new Error("Esta função não está disponível para você.");
        return system;
      };
      const publication=id=>{
        const row=store.publication(i.guild.id,id);
        if(data.publicationSystem){
          const system=currentSystem();
          if(system.id!==data.publicationSystem||!panelsForSystem(system,panels).some(p=>p.id===row.panelId))
            throw new Error("Escolha uma publicação desta função.");
        }
        return row;
      };
      if(data.systemId&&data.draftId){
        const system=currentSystem(),selected=store.getDraft(data.draftId,i.guild.id,i.user.id);
        if(!panelsForSystem(system,panels).some(panel=>panel.id===selected.panelId))
          throw new Error("Este painel não pertence à função selecionada.");
      }
      const draft=()=>store.getDraft(data.draftId,i.guild.id,i.user.id);
      const mutationDraft=()=>{
        const d=draft();
        if(data.draftRevision!==undefined&&data.draftRevision!==d.revision)
          throw new Error("O rascunho foi alterado em outra sessão. Volte ao editor para recarregar a versão atual.");
        return d;
      };
      const edit=async mutate=>{
        const d=mutationDraft(),next=structuredClone(d.data);await mutate(next);
        validate(next);
        await panels.render(d.panelId,context(i),{config:next,preview:true});
        data.draftRevision=store.editDraft(d,next).revision;
      };
      const field=()=>Number(data.fieldIndex||0);
      const slot=()=>data.slot||"main";
      if(action==="back"){
        const parents={systemSettings:"system",systemPanels:"system",texts:"editor",appearance:"editor",
          images:"editor",components:"editor",variables:"texts",history:"editor",publish:data.systemId?"systemPanels":"editor"};
        data.view=parents[data.view]||data.previous||(data.draftId?"editor":"home");
        delete data.previous;
      }
      else if(destination[action]){
        if(action!=="home"&&data.view&&data.view!==destination[action])data.previous=data.view;
        data.view=destination[action];
        if(action==="publish")delete data.republishId;
        if(action==="home")data={view:"home",settingsVersion:store.settings(i.guild.id).version};
      }
      else if(action==="systemHome"){
        currentSystem();data={view:"system",systemId:data.systemId};
      }else if(action==="systemSettings"){
        currentSystem(2);data.view="systemSettings";
      }else if(action==="systemPublish"||action==="systemEditPanels"){
        const system=currentSystem(),available=panelsForSystem(system,panels);
        if(!available.length)throw new Error("Esta função não possui painéis para publicar.");
        data={view:"systemPanels",systemId:system.id,systemPanelMode:action==="systemEditPanels"?"edit":"publish"};
      }else if(action==="systemPanel"){
        const system=currentSystem(),id=i.values?.[0],editing=data.systemPanelMode==="edit";
        if(!can(editing?"panel.templates":"panel.publish",2))throw new Error("Você não tem permissão para esta ação.");
        if(!panelsForSystem(system,panels).some(panel=>panel.id===id))throw new Error("Escolha um painel desta função.");
        const selected=store.draft(i.guild.id,i.user.id,id);
        data={view:editing?"editor":"publish",systemId:system.id,systemPanelMode:editing?"edit":"publish",
          draftId:selected.id,previous:"systemPanels"};
      }else if(action==="systemPublications"){
        const system=currentSystem();
        data={view:"publications",systemId:system.id,publicationSystem:system.id,allPublications:true,pubPage:0};
      }
      else if(action==="accessTab"){
        const tab=i.values?.[0];
        if(!["overview","roles","users","permissions","history"].includes(tab))throw new Error("Área de acesso inválida.");
        data.view=tab==="roles"?"accessRoles":tab==="users"?"accessUsers":tab==="permissions"?"accessPermissions":tab==="history"?"accessHistory":"access";
        data.accessPage=0;delete data.accessRecord;
      }else if(action==="accessRecord"){
        const key=i.values?.[0],[type,subjectId]=String(key||"").split(":");
        if(!["role","user"].includes(type)||!/^\d{17,20}$/.test(subjectId)||!access.store.accessRow(i.guild.id,type,subjectId))
          throw new Error("Registro de acesso inválido.");
        data.accessRecord=key;
      }else if(action==="historyPrev"||action==="historyNext"){
        data.historyPage=Math.max(0,(data.historyPage||0)+(action==="historyNext"?1:-1));
      }else if(action==="accessPrev"||action==="accessNext"){
        data.accessPage=Math.max(0,(data.accessPage||0)+(action==="accessNext"?1:-1));
      }else if(action==="submitAccessRole"||action==="submitAccessUser"||action==="submitAccessEdit"){
        const type=action==="submitAccessRole"?"role":action==="submitAccessUser"?"user":String(data.accessRecord||"").split(":")[0];
        const subjectIds=action==="submitAccessEdit"?[String(data.accessRecord||"").split(":")[1]]:
          type==="role"?getRoles(i,"roles"):getUsers(i,"members");
        if(!subjectIds.length)throw new Error("Selecione ao menos um cargo ou membro.");
        const input=accessPayload(i),duration=getValues(i,"duration")[0]||"permanent",expiresAt=
          type==="user"&&action!=="submitAccessEdit"&&duration!=="permanent"?durationValue(duration):null;
        for(const subjectId of subjectIds.slice(0,25))access.grant(i.guild.id,actor.id,i.guild.ownerId,{
          subjectType:type,subjectId,...input,expiresAt
        });
        await audit(i.guild,actor.id,action==="submitAccessEdit"?"access.updated":"access.granted",null,{type,count:subjectIds.length});
        data.view=type==="role"?"accessRoles":"accessUsers";
        notice=action==="submitAccessEdit"?"♡ Prontinho! Suas alterações foram salvas.":"♡ Prontinho! As permissões foram atualizadas com sucesso.";
      }else if(action==="accessRevoke"){
        if(!data.accessRecord)throw new Error("Selecione um acesso.");
        data.confirm="revoke";data.view="confirm";
      }else if(action==="accessConfirm"&&data.confirm==="revoke"){
        const [type,subjectId]=String(data.accessRecord||"").split(":");
        requireOwner(actor,i.guild);
        access.revoke(i.guild.id,actor.id,i.guild.ownerId,type,subjectId);
        await audit(i.guild,actor.id,"access.revoked",null,{type,subjectId});
        data.view=type==="role"?"accessRoles":"accessUsers";delete data.accessRecord;delete data.confirm;
        notice="♡ O acesso foi removido com sucesso.";
      }else if(action==="accessDetails"){
        const [type,subjectId]=String(data.accessRecord||"").split(":"),row=access.store.accessRow(i.guild.id,type,subjectId);
        if(!row)throw new Error("Este acesso não existe mais.");
        data.view="confirm";data.confirm="details";
      }else if(action==="category"){
        const value=i.values?.[0];
        if(!systems().some(s=>s.id===value))throw new Error("Categoria indisponível.");
        if(!can(`system:${value}`))throw new Error("Esta função não está disponível para você.");
        data=categoryData(value,{view:"home"});
        data.settingsVersion=store.settings(i.guild.id).version;
      }else if(action==="panel"){
        panels.get(i.values?.[0]);
        const selected=store.draft(i.guild.id,i.user.id,i.values[0]);
        data={view:"editor",draftId:selected.id,previous:"panels"};
      }else if(action==="submitSearch"){
        const query=getText(i,"query").slice(0,100);
        data.query=query;data.view="home";data.systemPage=0;
        notice=query?`Encontrei o que corresponde a “${query}”.`:"Pesquisa limpa.";
      }else if(action==="cor"){
        const command=commands.commands.get("corpainel");
        if(!command)throw new Error("O painel de cores não está disponível.");
        session=store.updateSession(session,data);
        await i.editReply(await view(session,i));
        await privateCommand({interaction:i,command,commands,session,member:actor,args:"",apis});
        return;
      }else if(action==="launch"){
        const system=currentSystem(2);
        const [commandName,...rest]=String(i.values?.[0]||"").split(":");
        const arg=rest.join(":");
        if(!system?.commands.includes(commandName))throw new Error("Configuração não disponível nesta categoria.");
        const command=commands.commands.get(commandName);
        if(!command)throw new Error("Este comando não está mais disponível.");
        if(commandName==="chat"){
          if(arg&&!/^(?:on|off|status|participar|memoria|retencao \d{1,3}|espontaneo (?:on|off)|limpar (?:canal|servidor))$/.test(arg))
            throw new Error("Ação inválida.");
        }else if(arg)throw new Error("Ação inválida.");
        session=store.updateSession(session,data);
        await i.editReply(await view(session,i));
        await privateCommand({interaction:i,command,commands,session,member:actor,args:commandName==="chat"?(arg||"status"):"",apis});
        return;
      }else if(action==="textField"){
        const fields=await panels.fields(draft().panelId,context(i)),index=Number(i.values[0]);
        if(!Number.isInteger(index)||!fields.texts[index])throw new Error("Selecione um bloco de texto válido.");
        data.fieldIndex=index;
      }
      else if(action==="imageSlot"){if(!Object.hasOwn(require("./views").SLOTS,i.values[0]))throw new Error("Posição inválida.");data.slot=i.values[0];}
      else if(action==="imageMode"){
        const mode=i.values[0];
        if(!Object.hasOwn(require("./views").MODES,mode)||mode==="asset")throw new Error("Modo de imagem inválido.");
        await edit(next=>{next.images??={};next.images[slot()]={mode};});
      }else if(action==="submitText"){
        const content=getText(i,"text");if(!content)throw new Error("O texto não pode ficar vazio.");
        await edit(next=>{next.texts??={};next.texts[field()]=content;});
        data.view="texts";notice="Texto atualizado no rascunho.";
      }else if(action==="resetText"){
        await edit(next=>{if(next.texts)delete next.texts[field()];next.hideTexts=next.hideTexts?.filter(n=>n!==field());});
      }else if(action==="hideText"){
        if(field()===0)throw new Error("O título é essencial e não pode ser ocultado.");
        await edit(next=>{const hidden=new Set(next.hideTexts||[]);if(hidden.has(field()))hidden.delete(field());else hidden.add(field());next.hideTexts=[...hidden];});
      }else if(action==="submitExtras"){
        await edit(next=>{for(const key of ["subtitle","footer"]){const value=getText(i,key);if(value)next[key]=value;else delete next[key];}});
        data.view="texts";
      }else if(action==="submitColor"){
        const value=getText(i,"color");
        if(!/^#[a-f\d]{6}$/i.test(value))throw new Error("Digite # seguido de seis caracteres hexadecimais, como #C4A7E7.");
        await edit(next=>{next.color=value.toUpperCase();});data.view="appearance";
      }else if(action==="resetColor")await edit(next=>{delete next.color;});
      else if(action==="separator")await edit(next=>{next.separators=i.values[0];});
      else if(action==="submitURL"||action==="submitUpload"){
        let url;
        if(action==="submitURL")url=safeURL(getText(i,"url")).href;
        else{
          const uploaded=i.fields.getUploadedFiles("image"),file=uploaded?.first?.()||[...uploaded?.values?.()||[]][0];
          if(!file||file.size>5*1024*1024)throw new Error("Envie uma imagem de até 5 MB.");
          url=file.url;
        }
        const image=await sanitize(await imageDownload(url));
        const assetId=store.addAsset(i.guild.id,i.user.id,image);
        await edit(next=>{next.images??={};next.images[slot()]={mode:"asset",assetId};});
        data.view="images";notice="Imagem validada e armazenada no rascunho.";
      }else if(action==="resetImages")await edit(next=>{delete next.images;});
      else if(action==="pruneAssets"){const deleted=store.pruneAssets(i.guild.id,i.user.id);notice=`${deleted} imagem(ns) sem uso removida(s). Imagens de versões salvas e rascunhos foram preservadas.`;}
      else if(action==="hideImages")await edit(next=>{next.images=Object.fromEntries(Object.keys(require("./views").SLOTS).map(key=>[key,{mode:"none"}]));});
      else if(action==="control"){
        const fields=await panels.fields(draft().panelId,context(i)),control=fields.controls[Number(i.values[0])];
        if(!control)throw new Error("Componente inválido.");
        data.controlId=control.id;delete data.optionValue;
      }else if(action==="controlOption"){
        const fields=await panels.fields(draft().panelId,context(i)),control=fields.controls.find(c=>c.id===data.controlId);
        const option=control?.options?.[Number(i.values[0])];
        if(!option)throw new Error("Opção inválida.");
        data.optionValue=option.value;
      }else if(action==="submitControl"){
        const fields=await panels.fields(draft().panelId,context(i)),control=fields.controls.find(c=>c.id===data.controlId);
        if(!control)throw new Error("Componente indisponível.");
        await edit(next=>{
          next.components??={};const target=next.components[control.id]??={};
          if(control.type===2){
            const style=control.style===5?undefined:Number(getText(i,"style"));if(control.style!==5&&![1,2,3,4].includes(style))throw new Error("Escolha um estilo de 1 a 4.");
            const icon=getText(i,"emoji");emoji(icon);
            Object.assign(target,{label:getText(i,"label"),emoji:icon});
            if(style!==undefined)target.style=style;
          }else target.placeholder=getText(i,"label");
        });data.view="components";
      }else if(action==="submitOption"){
        const icon=getText(i,"emoji");emoji(icon);
        await edit(next=>{
          next.components??={};const control=next.components[data.controlId]??={};control.options??={};
          control.options[data.optionValue]={label:getText(i,"label"),description:getText(i,"description"),emoji:icon};
        });data.view="components";
      }else if(action==="resetControl")await edit(next=>{if(next.components)delete next.components[data.controlId];});
      else if(action==="resetOption")await edit(next=>{const control=next.components?.[data.controlId];if(control?.options)delete control.options[data.optionValue];});
      else if(action==="preview"){
        const current=mutationDraft();
        const payload=await panels.render(current.panelId,context(i),{config:current.data,preview:true});
        await i.followUp({...payload,flags:MessageFlags.IsComponentsV2|MessageFlags.Ephemeral});
        // A prévia é uma mensagem separada; o editor permanece navegável.
        return;
      }else if(action==="save"){
        const d=mutationDraft();await panels.render(d.panelId,context(i),{config:d.data});
        data.draftRevision=store.save(d).revision;notice="Personalização salva. Use Atualizar publicados para aplicar às mensagens existentes.";
        await audit(i.guild,i.user.id,"panel.saved",d.panelId,{draftId:d.id});
      }else if(action==="discard"){
        const d=mutationDraft();store.discard(d);
        data={...data,view:"editor",draftId:store.draft(i.guild.id,i.user.id,d.panelId).id};notice="Rascunho descartado. A versão salva foi mantida.";
      }else if(action==="reset"){data.view="confirm";data.confirm="reset";}
      else if(action==="deletePublication"){publication(data.publicationId);data.view="confirm";data.confirm="delete";}
      else if(action==="confirm"){
        if(data.confirm==="reset"){
          await edit(next=>{for(const key of Object.keys(next))delete next[key];});
          data.view="editor";notice="Padrão restaurado no rascunho. Salve para confirmar.";
        }else if(data.confirm==="delete"){
          if(!can("panel.publish",2))throw new Error("Você não tem permissão para excluir publicações.");
          publication(data.publicationId);
          await publisher.remove(data.publicationId,context(i));data.view="publications";notice="Mensagem excluída. O registro permite republicação.";
          await audit(i.guild,i.user.id,"panel.deleted",store.publication(i.guild.id,data.publicationId).panelId,{});
        }else throw new Error("Confirmação inválida.");
        delete data.confirm;
      }else if(action==="cancel"){
        data.view=data.confirm==="delete"?"publications":data.confirm==="revoke"||data.confirm==="details"?
          (String(data.accessRecord||"").startsWith("role:")?"accessRoles":"accessUsers"):"editor";
        delete data.confirm;
      }
      else if(action==="publishChannel"||action==="adoptChannel"){
        await publisher.channel(i.guild,i.values[0],i.user);data.channelId=i.values[0];
      }else if(action==="publishNow"){
        const d=draft(),result=data.republishId?await publisher.republish(data.republishId,context(i),data.channelId):
          await publisher.publish(d.panelId,context(i),data.channelId);
        data={...data,view:"publications",publicationId:result.id,allPublications:false};
        if(data.systemId){
          data.publicationSystem=data.systemId;data.allPublications=true;
        }
        delete data.republishId;
        notice="Painel publicado.";
        await audit(i.guild,i.user.id,"panel.published",d.panelId,{messageId:result.messageId});
      }else if(action==="publication"){publication(i.values[0]);data.publicationId=i.values[0];}
      else if(action==="allPublications"){data={view:"publications",allPublications:true,pubPage:0};}
      else if(action==="updatePublication"){
        publication(data.publicationId);
        const result=await publisher.update(data.publicationId,context(i));notice="Mensagem atualizada sem criar outra publicação.";
        await audit(i.guild,i.user.id,"panel.updated",result.panelId,{messageId:result.messageId});
      }else if(action==="duplicate"){
        const row=publication(data.publicationId),copied=store.draft(i.guild.id,i.user.id,row.panelId);
        data={...data,view:"publish",draftId:copied.id,channelId:row.channelId,previous:"publications"};
        notice="Escolha o canal da cópia.";
      }else if(action==="republish"){
        const row=publication(data.publicationId);
        if(row.status==="published"||row.status==="replaced")throw new Error("Este painel ainda existe ou já foi republicado.");
        const selected=store.draft(i.guild.id,i.user.id,row.panelId);
        data={...data,view:"publish",draftId:selected.id,republishId:row.id,channelId:row.channelId};
        notice="Escolha o canal e confirme a republicação. A mensagem antiga não será recriada automaticamente.";
      }else if(action==="updateAll"){
        const d=draft(),rows=store.publications(i.guild.id,d.panelId).filter(row=>row.status==="published");
        const results=[];
        for(const row of rows.slice(0,25)){
          try{await publisher.update(row.id,context(i));results.push({ok:true});}
          catch(error){results.push({ok:false,channelId:row.channelId,message:error.message});}
        }
        notice=`${results.filter(r=>r.ok).length} de ${Math.min(rows.length,25)} mensagem(ns) atualizada(s).${rows.length>25?" Atualize as demais individualmente.":""}`;
        if(results.some(r=>!r.ok))notice+="\n"+results.filter(r=>!r.ok).slice(0,3).map(r=>`<#${r.channelId}>: ${r.message}`).join("\n");
        await audit(i.guild,i.user.id,"panels.updated",d.panelId,{updated:results.filter(r=>r.ok).length});
      }else if(action==="submitAdopt"){
        const id=getText(i,"messageId");
        if(!/^\d{17,20}$/.test(id))throw new Error("Informe um ID de mensagem válido.");
        const channel=await publisher.channel(i.guild,data.channelId,i.user),message=await channel.messages.fetch(id);
        if(message.author.id!==client.user.id)throw new Error("A mensagem deve pertencer à Lumiya.");
        const panelId=deps.identify?.(message);
        if(!panelId)throw new Error("Este painel não foi reconhecido. Use Publicar para criar um painel suportado.");
        const publicationId=store.record(i.guild.id,panelId,channel.id,id,i.user.id);
        commands.preserveMessage(message);
        data={view:"publications",allPublications:true,publicationId};notice="Painel existente vinculado sem modificar sua mensagem.";
      }else if(action==="authorizeUsers"||action==="authorizeRoles"){
        if(i.user.id!==i.guild.ownerId)throw new Error("Somente o proprietário pode autorizar acessos à central.");
        const saved=store.settings(i.guild.id),key=action==="authorizeUsers"?"authorizedUsers":"authorizedRoles";
        if(i.values.length>25||i.values.some(id=>!/^\d{17,20}$/.test(id)))throw new Error("Seleção de acesso inválida.");
        if(key==="authorizedRoles"&&i.values.includes(i.guild.id))throw new Error("O cargo @everyone não pode receber acesso à central.");
        const result=store.saveSettings(i.guild.id,{...saved,[key]:i.values},data.settingsVersion,i.user.id);
        data.settingsVersion=result.version;notice="Acessos atualizados.";
        await audit(i.guild,i.user.id,"access.updated",null,{kind:key,count:i.values.length});
      }else if(action==="welcomeChannel"||action==="toggleWelcome"){
        const saved=store.settings(i.guild.id);
        if(action==="welcomeChannel"){await publisher.channel(i.guild,i.values[0],i.user);saved.welcomeChannel=i.values[0];}
        else{if(!saved.welcomeChannel)throw new Error("Selecione o canal antes de ativar.");saved.welcomeEnabled=!saved.welcomeEnabled;}
        const result=store.saveSettings(i.guild.id,saved,data.settingsVersion,i.user.id);data.settingsVersion=result.version;
        notice="Recepção de membros atualizada.";await audit(i.guild,i.user.id,"welcome.updated",null,{enabled:result.welcomeEnabled});
      }else if(["welcomeEditor","onboardEditor","onboardPublish"].includes(action)){
        const selected=store.draft(i.guild.id,i.user.id,action==="welcomeEditor"?"member-welcome":"onboarding");
        data={view:action==="onboardPublish"?"publish":"editor",draftId:selected.id};
      }else if(action==="logKind"){
        const kinds=apis.logs?.availableKinds?.(i.guild.id)||apis.logs?.kinds||{};
        if(!Object.hasOwn(kinds,i.values[0]))throw new Error("Tipo de log inválido.");
        data.logKind=i.values[0];
      }else if(action==="logChannel"){
        const kinds=apis.logs?.availableKinds?.(i.guild.id)||apis.logs?.kinds||{};
        const kind=data.logKind||(Object.hasOwn(kinds,"general")?"general":Object.keys(kinds)[0]);
        if(!Object.hasOwn(kinds,kind))throw new Error("Tipo de log indisponível.");
        const channel=await publisher.channel(i.guild,i.values[0],i.user);
        if(channel.permissionsFor(i.guild.roles.everyone)?.has(PermissionFlagsBits.ViewChannel))throw new Error("Escolha um canal privado: logs podem conter dados sensíveis.");
        apis.logs.configure(i.guild.id,kind,channel.id);apis.logs.store.set(i.guild.id,kind,channel.id);
        notice="Destino dos logs atualizado.";await audit(i.guild,i.user.id,"logs.updated",null,{kind,channelId:channel.id});
      }else if(action==="provisionLogs"){
        if(!actor.permissions.has(PermissionFlagsBits.ManageChannels))throw new Error("Gerenciar canais é necessário para organizar os logs.");
        if(!apis.logs?.enableGuild)throw new Error("O módulo de logs não está disponível.");
        data.view="confirmLogs";
      }else if(action==="activateLogs"){
        if(data.view!=="confirmLogs")throw new Error("Abra a confirmação de ativação dos logs primeiro.");
        if(!actor.permissions.has(PermissionFlagsBits.ManageChannels))throw new Error("Gerenciar canais é necessário para organizar os logs.");
        if(!apis.logs?.enableGuild)throw new Error("O módulo de logs não está disponível.");
        const result=await apis.logs.enableGuild(i.guild);
        data.view="logs";
        notice=result?.ok?`${result.configured} canal(is) privado(s) preparado(s) e vinculado(s). Os logs já estão prontos para as respectivas funções.`:
          `Ops! Preparei ${result?.configured||0} de ${result?.total||0} canais. ${result?.reason||"Alguns destinos não puderam ser vinculados. Verifique as permissões e tente novamente; os canais criados serão reutilizados."}`;
        await audit(i.guild,i.user.id,"logs.setup",null,{updated:result?.configured||0,enabled:Boolean(result?.ok)});
      }else{
        const pages={sysPrev:["systemPage",-1],sysNext:["systemPage",1],panelPrev:["page",-1],panelNext:["page",1],textPrev:["fieldPage",-1],textNext:["fieldPage",1],
          controlPrev:["controlPage",-1],controlNext:["controlPage",1],pubPrev:["pubPage",-1],pubNext:["pubPage",1]};
        const page=pages[action];if(!page)throw new Error("Ação indisponível.");
        data[page[0]]=Math.max(0,(data[page[0]]||0)+page[1]);
      }
      // Ao entrar em telas de configuração, usa a revisão efetivamente exibida.
      if(action==="home"||action==="refresh")data.settingsVersion=store.settings(i.guild.id).version;
      if(data.draftId)data.draftRevision=draft().revision;
      session=store.updateSession(session,data);
      const friendly=notice&&!/^[♡]|^Ops!/.test(notice)?ui.feedback.success(notice):notice;
      await i.editReply(ui.validatePayload({...await view(session,i,friendly),attachments:[]}));
    }catch(error){await respondError(i,error);}
    finally{busy.delete(id);}
  }
  function categoryData(id,data){
    if(["appearance","general","welcome","logs"].includes(id))return {...data,view:id==="appearance"?"panels":id};
    if(id)return {...data,view:"system",systemId:id};
    return {...data,view:"home"};
  }
  return {open,handle,view,busy};
};
