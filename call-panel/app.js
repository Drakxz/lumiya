(()=>{
  const $=id=>document.getElementById(id);
  const incoming=new URLSearchParams(location.hash.slice(1)).get("key");
  if(incoming){sessionStorage.setItem("call-panel-key",incoming);history.replaceState(null,"",location.pathname);}
  const key=sessionStorage.getItem("call-panel-key")||"";
  const pages={
    overview:["Visão geral","Seu workspace, sob controle.","Uma visão clara das contas, conexões e atividades."],
    all:["Contas e calls","Todas as suas contas.","Conexões organizadas. Controles sempre à mão."],
    favorites:["Favoritas","Suas contas favoritas.","Acesso rápido ao que você mais usa."],
    connected:["Conectadas","Sessões ativas.","Calls e contas em modo somente presença."],
    presence:["Status e atividades","Sua presença, do seu jeito.","Configure como cada conta aparece no Discord."],
    history:["Histórico de ações","Cada ação, em contexto.","Consulte as últimas 150 ações do painel. Nenhum token é registrado."],
    settings:["Configurações","Um workspace que combina com você.","Preferências locais, privacidade e diagnóstico."]
  };
  const states={waiting:"Aguardando bot",connecting:"Conectando",connected:"Em call",online:"Somente presença",reconnecting:"Reconectando",disconnected:"Desconectada",error:"Falha de autenticação",disabled:"Sem token"};
  const statuses={online:"Online",idle:"Ausente",dnd:"Não perturbe",invisible:"Invisível"};
  const activityNames={0:"Jogando",1:"Transmitindo",2:"Ouvindo",3:"Assistindo",4:"Status",5:"Competindo"};
  const modes={open:{selfMute:false,selfDeaf:false},muted:{selfMute:true,selfDeaf:false},deafened:{selfMute:true,selfDeaf:true}};
  const modeOf=a=>a.selfDeaf?"deafened":a.selfMute?"muted":"open",active=a=>["connected","online"].includes(a.state);
  let accounts=[],events=[],system={},editing=null,presenceId=null,busy=false,version=0,nav=sessionStorage.getItem("sla-view")||"overview";
  if(!Object.hasOwn(pages,nav))nav="overview";
  let refreshInterval=Number(localStorage.getItem("sla-refresh"))||5000,lastPoll=0;
  if(![5000,10000,30000].includes(refreshInterval))refreshInterval=5000;
  function el(tag,text,className){
    const node=document.createElement(tag);if(text!==undefined&&text!==null)node.textContent=text;if(className)node.className=className;return node;
  }
  function button(label,handler,className,title){
    const node=el("button",label,className);node.type="button";node.disabled=busy;
    if(title){node.title=title;node.setAttribute("aria-label",title);}
    node.addEventListener("click",handler);return node;
  }
  function feedback(message,ok=false){$("feedback").textContent=message;$("feedback").dataset.ok=String(ok);}
  async function api(route,data){
    const response=await fetch(route,{
      method:data?"POST":"GET",headers:{"X-Panel-Key":key,...(data?{"Content-Type":"application/json"}:{})},
      ...(data?{body:JSON.stringify(data)}:{})
    });
    const body=await response.json();if(!response.ok)throw new Error(body.error||"Falha ao acessar o painel.");
    return body;
  }
  async function request(route="/api/accounts",data){
    const current=++version,body=await api(route,data);
    if(current!==version)return;
    accounts=body.accounts;events=body.events||[];system=body.system||{};render();
    lastPoll=Date.now();$("sync-status").textContent=`Atualizado às ${new Date().toLocaleTimeString("pt-BR")}`;
  }
  function avatar(a){
    const initials=a.name.split(/\s+/).slice(0,2).map(s=>Array.from(s)[0]).join("").toLocaleUpperCase("pt-BR");
    const node=el("div",initials,"avatar");
    if(a.profile?.avatarURL&&/^https:\/\/cdn\.discordapp\.com\/(?:avatars|embed\/avatars)\//.test(a.profile.avatarURL)){
      const img=document.createElement("img");img.alt=`Avatar de ${a.profile.username||a.name}`;img.loading="lazy";img.referrerPolicy="no-referrer";
      img.addEventListener("error",()=>{node.textContent=initials;});img.src=a.profile.avatarURL;node.replaceChildren(img);
    }
    return node;
  }
  function empty(container,title,description){
    const node=el("div",null,"empty");node.append(el("h3",title),el("p",description));container.append(node);return node;
  }
  function navigate(view){
    if(!Object.hasOwn(pages,view))return;
    nav=view;sessionStorage.setItem("sla-view",nav);render();window.scrollTo({top:0,behavior:"instant"});
  }
  function eventList(container,rows){
    container.replaceChildren();
    if(!rows.length)return empty(container,"Sem ações por enquanto.","As operações realizadas neste painel aparecerão aqui.");
    for(const e of rows){
      const node=el("div",null,"event"),body=el("div",null,"event-text"),date=new Date(e.at);
      body.append(el("b",e.action),el("p",e.accountName));
      const time=el("time",date.toLocaleString("pt-BR",{day:"2-digit",month:"2-digit",hour:"2-digit",minute:"2-digit"}));time.dateTime=date.toISOString();
      node.append(el("span","↳","event-mark"),body,time);container.append(node);
    }
  }
  function diagnostic(container){
    container.replaceChildren();
    const minutes=system.startedAt?Math.max(0,Math.floor((Date.now()-system.startedAt)/60000)):null;
    for(const [label,value]of [["Bot principal",system.botReady?"Conectado":"Aguardando conexão"],["Tempo do painel",minutes===null?"—":`${Math.floor(minutes/60)} h ${minutes%60} min`],
      ["Node.js",system.nodeVersion||"—"],["Plataforma",system.platform==="win32"?"Windows":system.platform||"—"],["Cofre",system.vault||"—"]]){
      const row=el("div",null,"diagnostic");row.append(el("span",label),el("strong",value));container.append(row);
    }
  }
  function overview(){
    eventList($("recent-events"),events.slice(0,4));diagnostic($("overview-system"));diagnostic($("settings-system"));
    const online=accounts.filter(active).length,pending=accounts.filter(a=>["connecting","reconnecting","waiting"].includes(a.state)).length;
    const groups=[["Sessões ativas",online,"#9e8bdf"],["Conectando",pending,"#d1b174"],["Desconectadas / falhas",accounts.length-online-pending,"#434957"]];
    const distribution=$("distribution");distribution.replaceChildren();
    const bar=el("div",null,"distribution");
    for(const [,count,color]of groups){const segment=el("span");segment.style.width=`${accounts.length?count/accounts.length*100:0}%`;segment.style.background=color;bar.append(segment);}
    distribution.append(el("p",`${online} de ${accounts.length} contas com sessão ativa`),bar);
    for(const [name,count,color]of groups){
      const row=el("div",null,"legend"),label=el("span"),dot=el("span",null,"dot");dot.style.background=color;
      label.append(dot,document.createTextNode(name));row.append(label,el("b",count));distribution.append(row);
    }
    const favorites=$("favorite-accounts");favorites.replaceChildren();
    const pinned=accounts.filter(a=>a.favorite).slice(0,4);
    if(!pinned.length)empty(favorites,"Seu atalho começa com uma estrela.","Marque uma conta como favorita para acessá-la aqui.");
    for(const a of pinned){
      const row=el("div",null,"mini-account"),body=el("div",null,"identity");
      body.append(el("b",a.name),el("p",states[a.state]||a.state));
      row.append(avatar(a),body,button("Abrir",()=>edit(a),"small quiet"));favorites.append(row);
    }
  }
  function act(a,action,extra={},message="Preferência salva."){
    return perform(()=>request("/api/action",{id:a.id,action,...extra}),message);
  }
  function accountCard(a,presenceOnly=false){
    const card=el("article",null,"account"),head=el("div",null,"account-head"),identity=el("div",null,"identity");
    identity.append(el("h3",a.name));const status=el("span",states[a.state]||"Indisponível","status");status.dataset.state=a.state;identity.append(status);
    head.append(avatar(a),identity);
    const b=(label,handler,style,title)=>{const n=button(label,handler,style,title);n.dataset.focusKey=`${a.id}:${title||label}:${presenceOnly}`;return n;};
    const favorite=b(a.favorite?"★":"☆",()=>act(a,"favorite"),"favorite",a.favorite?"Remover favorito":"Favoritar");
    favorite.dataset.active=String(a.favorite);head.append(favorite);card.append(head);
    if(presenceOnly){
      const p=a.presence||{status:"online",name:"",type:0},preview=el("div",null,"presence-preview");
      preview.append(el("small",statuses[p.status]||"Online"),el("b",p.name?`${activityNames[p.type]} ${p.name}`:"Nenhuma atividade configurada"));
      card.append(preview,el("p",a.joinCall?"Presença com conexão de voz.":"Modo somente presença · sem entrar em call.","account-note"));
      const delivery={pending:"Salvo · aguardando a conexão da conta",sending:"Sincronizando com o Discord…",sent:"Enviado ao Discord · outros clientes podem sobrescrever",error:a.presenceError||"Falha ao enviar ao Discord"};
      card.append(el("p",delivery[a.presenceDelivery]||delivery.pending,"account-note"));
      const footer=el("div",null,"card-footer");footer.append(b("Configurar presença",()=>editPresence(a),"connect primary"),b("Editar",()=>edit(a)));card.append(footer);return card;
    }
    const channel=el("div",null,"channel"),desc=el("div");
    desc.append(el("label",a.joinCall?"CANAL DE VOZ":"MODO DE CONEXÃO"),el("code",a.joinCall?a.channelId:"Somente presença"));
    channel.append(desc);
    if(a.joinCall)channel.append(b("Copiar",async()=>{try{await navigator.clipboard.writeText(a.channelId);feedback("ID copiado.",true);}catch{feedback("Não foi possível copiar.");}},null,"Copiar ID da call"));
    card.append(channel);
    if(a.joinCall){
      card.append(el("div","Preferência de áudio","audio-label"));
      const segments=el("div",null,"segments");
      for(const [mode,label]of [["open","Desmutado"],["muted","Só microfone"],["deafened","Mic + deafen"]]){
        const control=b(label,()=>act(a,"audio",{mode}),modeOf(a)===mode?"selected":"");control.setAttribute("aria-pressed",String(modeOf(a)===mode));segments.append(control);
      }
      const quick=el("div",null,"quick-controls");
      quick.append(b(a.selfMute?"Desmutar mic":"Mutar mic",()=>act(a,"audio",{mode:a.selfMute?"open":"muted"})),
        b(a.selfDeaf?"Desligar deafen":"Ativar deafen",()=>act(a,"audio",{mode:a.selfDeaf?"muted":"deafened"})));card.append(segments,quick);
    }else{
      const preview=el("div",null,"presence-preview"),p=a.presence||{status:"online",name:""};
      preview.append(el("small",statuses[p.status]),el("b",p.name?`${activityNames[p.type]} ${p.name}`:"Sem atividade"));
      card.append(preview);
    }
    if(a.notes)card.append(el("p",a.notes,"account-note"));
    const meta=el("div",null,"meta"),minutes=a.connectedAt?Math.max(0,Math.floor((Date.now()-a.connectedAt)/60000)):null;
    meta.append(el("span",a.autoReconnect?"↻ Reconexão automática":"Reconexão manual"),el("span",minutes===null?"Token protegido":`Ativa há ${minutes} min`));card.append(meta);
    const footer=el("div",null,"card-footer");
    footer.append(b(a.enabled?"Desconectar":"Conectar",()=>act(a,a.enabled?"disconnect":"connect",{},"Configuração aplicada."),a.enabled?"connect":"connect primary"),
      b("↻",()=>act(a,"reconnect",{},"Nova tentativa iniciada."),"icon-button","Reconectar"),b("Status",()=>editPresence(a)),b("Editar",()=>edit(a)),
      b("×",async()=>{if(await confirmAction("Excluir conta",`Excluir “${a.name}” e encerrar sua conexão? O token será removido do cofre.`))act(a,"delete",{},"Conta excluída.");},"danger icon-button","Excluir conta"));
    card.append(footer);return card;
  }
  function render(){
    const focused=document.activeElement?.dataset.focusKey;
    $("breadcrumb").textContent=pages[nav][0];$("page-title").textContent=pages[nav][1];$("page-description").textContent=pages[nav][2];
    for(const node of document.querySelectorAll("[data-nav]"))node.classList.toggle("active",node.dataset.nav===nav);
    $("overview-view").hidden=nav!=="overview";$("accounts-view").hidden=!["all","favorites","connected"].includes(nav);
    for(const view of ["presence","history","settings"])$(`${view}-view`).hidden=nav!==view;
    $("stat-total").textContent=accounts.length;$("nav-total").textContent=accounts.length;
    $("stat-connected").textContent=accounts.filter(active).length;$("stat-calls").textContent=accounts.filter(a=>a.state==="connected").length;$("stat-errors").textContent=accounts.filter(a=>a.state==="error").length;
    for(const id of ["connect-all","disconnect-all","refresh","add","export-settings"])$(id).disabled=busy;
    const query=$("search").value.trim().toLocaleLowerCase("pt-BR"),filter=$("filter").value;
    const sorted=[...accounts].sort((a,b)=>Number(b.favorite)-Number(a.favorite)||a.name.localeCompare(b.name,"pt-BR"));
    const filtered=sorted.filter(a=>(nav!=="favorites"||a.favorite)&&(nav!=="connected"||active(a))&&
      (filter==="all"||a.state===filter)&&`${a.name} ${a.channelId} ${a.notes}`.toLocaleLowerCase("pt-BR").includes(query));
    $("result-count").textContent=`${filtered.length} de ${accounts.length}`;$("accounts").replaceChildren();
    if(!filtered.length){
      const node=empty($("accounts"),accounts.length?"Nenhuma conta encontrada":"Seu workspace está pronto.",accounts.length?"Experimente outro filtro ou termo de busca.":"Adicione uma conta para começar.");
      if(!accounts.length)node.append(button("+ Adicionar conta",()=>edit(),"primary"));
    }else for(const a of filtered)$("accounts").append(accountCard(a));
    $("presence-accounts").replaceChildren();
    if(!accounts.length)empty($("presence-accounts"),"Nenhuma conta cadastrada.","Adicione uma conta para gerenciar seu status.");
    else for(const a of sorted)$("presence-accounts").append(accountCard(a,true));
    const eventQuery=$("history-search").value.toLocaleLowerCase("pt-BR");
    eventList($("history-list"),events.filter(e=>`${e.accountName} ${e.action}`.toLocaleLowerCase("pt-BR").includes(eventQuery)));overview();
    if(focused)document.querySelector(`[data-focus-key="${CSS.escape(focused)}"]`)?.focus({preventScroll:true});
  }
  function updateCallFields(){
    $("call-fields").hidden=!$("join-call").checked;$("channel").required=$("join-call").checked;
    $("channel").disabled=!$("join-call").checked;
  }
  function edit(a){
    $("account-form").reset();editing=a?.id||null;$("form-title").textContent=a?"Editar conta":"Nova conta";
    $("name").value=a?.name||"";$("channel").value=a?.channelId||"";$("token").value="";$("token").required=!a;
    $("token").placeholder=a?"Vazio para manter o token salvo":"Cole o token aqui";$("token-hint").textContent=a?"Preencha apenas para substituir o token atual.":"Protegido por criptografia. Nunca aparece na lista.";
    $("join-call").checked=a?.joinCall??true;$("audio-mode").value=a?modeOf(a):"deafened";
    $("auto-reconnect").checked=a?.autoReconnect??true;$("notes").value=a?.notes||"";updateCallFields();
    $("form-error").textContent="";$("editor").showModal();$("name").focus();
  }
  function closeEditor(){$("token").value="";$("editor").close();editing=null;}
  function updatePresencePreview(){
    const type=Number($("presence-type").value),name=$("presence-name").value.trim();
    $("stream-field").hidden=type!==1;$("presence-url").disabled=type!==1;$("presence-url").required=type===1&&Boolean(name);
    $("presence-preview-text").textContent=`${statuses[$("presence-status").value]}${name?` · ${activityNames[type]} ${name}`:" · Sem atividade"}`;
  }
  function editPresence(a){
    presenceId=a.id;const p=a.presence||{status:"online",name:"",type:0,url:""};
    $("presence-account-name").textContent=a.name;$("presence-status").value=p.status;$("presence-type").value=String(p.type);
    $("presence-name").value=p.name;$("presence-url").value=p.url||"";$("presence-error").textContent="";updatePresencePreview();$("presence-editor").showModal();
  }
  function closePresence(){$("presence-editor").close();presenceId=null;}
  async function perform(work,message,errorTarget){
    if(busy)return false;busy=true;$("save").disabled=true;$("presence-save").disabled=true;render();
    try{await work();feedback(message,true);return true;}catch(error){
      if(errorTarget)$(errorTarget).textContent=error.message;else feedback(error.message);return false;
    }finally{busy=false;$("save").disabled=false;$("presence-save").disabled=false;render();}
  }
  $("account-form").addEventListener("submit",async event=>{
    event.preventDefault();if(busy)return;
    const channelId=$("channel").value;
    const data={...(editing?{id:editing}:{}),name:$("name").value,channelId:$("join-call").checked||/^\d{17,20}$/.test(channelId)?channelId:"",token:$("token").value,joinCall:$("join-call").checked,
      ...modes[$("audio-mode").value],autoReconnect:$("auto-reconnect").checked,notes:$("notes").value};
    $("token").value="";if(await perform(()=>request("/api/accounts",data),"Conta salva.","form-error"))closeEditor();
  });
  $("presence-form").addEventListener("submit",async event=>{
    event.preventDefault();if(busy||!presenceId)return;
    const presence={status:$("presence-status").value,type:Number($("presence-type").value),name:$("presence-name").value,url:$("presence-url").value};
    const id=presenceId;
    if(await perform(async()=>{
      await request("/api/action",{id,action:"presence",presence});
      const updated=accounts.find(a=>a.id===id);
      if(updated?.presenceDelivery==="error")throw new Error(`Preferência salva, mas o envio falhou: ${updated.presenceError}`);
    },"Preferência de status salva. Consulte o estado de envio no cartão.","presence-error"))closePresence();
  });
  for(const id of ["presence-status","presence-type","presence-name","presence-url"])$(id).addEventListener("input",updatePresencePreview);
  $("join-call").addEventListener("change",updateCallFields);
  for(const id of ["cancel","close-editor"])$(id).addEventListener("click",closeEditor);
  $("editor").addEventListener("cancel",()=>{$("token").value="";editing=null;});
  for(const id of ["presence-close","presence-cancel"])$(id).addEventListener("click",closePresence);
  $("presence-editor").addEventListener("cancel",()=>{presenceId=null;});
  let confirmResolve;
  function confirmAction(title,description){
    if($("confirm-dialog").open)return Promise.resolve(false);
    $("confirm-title").textContent=title;$("confirm-description").textContent=description;$("confirm-dialog").showModal();$("confirm-cancel").focus();
    return new Promise(resolve=>{confirmResolve=resolve;});
  }
  function finishConfirm(result){$("confirm-dialog").close();confirmResolve?.(result);confirmResolve=null;}
  $("confirm-ok").addEventListener("click",()=>finishConfirm(true));$("confirm-cancel").addEventListener("click",()=>finishConfirm(false));
  $("confirm-dialog").addEventListener("cancel",()=>{confirmResolve?.(false);confirmResolve=null;});
  $("add").addEventListener("click",()=>edit());$("refresh").addEventListener("click",()=>perform(()=>request(),"Lista atualizada."));
  for(const id of ["search","history-search"])$(id).addEventListener("input",render);$("filter").addEventListener("change",render);
  for(const node of document.querySelectorAll("[data-nav]"))node.addEventListener("click",()=>navigate(node.dataset.nav));
  $("explore-presence").addEventListener("click",()=>navigate("presence"));$("view-history").addEventListener("click",()=>navigate("history"));$("view-favorites").addEventListener("click",()=>navigate("favorites"));
  async function bulk(action){
    const targets=accounts.filter(a=>action==="connect"?!a.enabled:a.enabled);
    if(!targets.length)return feedback("Nenhuma conta precisa desta ação.",true);
    if(!await confirmAction(action==="connect"?"Conectar todas":"Desconectar todas",`Aplicar esta ação a ${targets.length} conta(s)?`))return;
    await perform(async()=>{for(const a of targets)await request("/api/action",{id:a.id,action});},"Ação aplicada às contas.");
  }
  $("connect-all").addEventListener("click",()=>bulk("connect"));$("disconnect-all").addEventListener("click",()=>bulk("disconnect"));
  async function exportSettings(){
    await perform(async()=>{
      const body=await api("/api/export"),url=URL.createObjectURL(new Blob([JSON.stringify(body,null,2)],{type:"application/json"}));
      const link=el("a");link.href=url;link.download=`sla-configuracoes-${new Date().toISOString().slice(0,10)}.json`;document.body.append(link);link.click();link.remove();
      setTimeout(()=>URL.revokeObjectURL(url),1000);
    },"Configurações exportadas sem tokens.");
  }
  $("export-settings").addEventListener("click",exportSettings);
  $("density").value=localStorage.getItem("sla-density")==="compact"?"compact":"comfortable";
  document.body.classList.toggle("compact",$("density").value==="compact");$("refresh-rate").value=String(refreshInterval);
  $("density").addEventListener("change",()=>{localStorage.setItem("sla-density",$("density").value);document.body.classList.toggle("compact",$("density").value==="compact");});
  $("refresh-rate").addEventListener("change",()=>{refreshInterval=Number($("refresh-rate").value);localStorage.setItem("sla-refresh",String(refreshInterval));});
  let commandIndex=0,commandItems=[];
  function commands(){
    const query=$("command-search").value.toLocaleLowerCase("pt-BR");
    const items=Object.entries(pages).map(([id,[label]])=>({label,run:()=>navigate(id)}));
    items.push({label:"Adicionar nova conta",run:()=>edit()},{label:"Atualizar dados",run:()=>perform(()=>request(),"Lista atualizada.")},{label:"Exportar configurações sem tokens",run:exportSettings});
    for(const a of accounts)items.push({label:`Editar conta · ${a.name}`,run:()=>edit(a)},{label:`Configurar status · ${a.name}`,run:()=>editPresence(a)});
    commandItems=items.filter(item=>item.label.toLocaleLowerCase("pt-BR").includes(query));commandIndex=Math.min(commandIndex,Math.max(0,commandItems.length-1));
    const results=$("command-results");results.replaceChildren();
    commandItems.forEach((item,index)=>{
      const control=button(item.label,()=>runCommand(index));control.id=`command-${index}`;control.setAttribute("role","option");
      control.setAttribute("aria-selected",String(index===commandIndex));control.classList.toggle("selected",index===commandIndex);control.tabIndex=-1;results.append(control);
    });
    if(commandItems.length)$("command-search").setAttribute("aria-activedescendant",`command-${commandIndex}`);else{$("command-search").removeAttribute("aria-activedescendant");results.append(el("p","Nenhum comando encontrado.","empty"));}
  }
  function runCommand(index){if(busy)return;const command=commandItems[index];if(command){$("command-dialog").close();command.run();}}
  function openCommands(){if(document.querySelector("dialog[open]"))return;commandIndex=0;$("command-search").value="";commands();$("command-dialog").showModal();$("command-search").focus();}
  $("command-open").addEventListener("click",openCommands);
  document.addEventListener("keydown",event=>{if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==="k"){event.preventDefault();openCommands();}});
  $("command-search").addEventListener("input",()=>{commandIndex=0;commands();});
  $("command-search").addEventListener("keydown",event=>{
    if(event.key==="ArrowDown"||event.key==="ArrowUp"){
      event.preventDefault();if(commandItems.length){commandIndex=(commandIndex+(event.key==="ArrowDown"?1:-1)+commandItems.length)%commandItems.length;commands();$(`command-${commandIndex}`)?.scrollIntoView({block:"nearest"});}
    }else if(event.key==="Enter"){event.preventDefault();runCommand(commandIndex);}
  });
  render();request().catch(error=>{feedback(error.message);$("sync-status").textContent="Sem conexão com o painel";});
  setInterval(()=>{if(!busy&&!document.hidden&&Date.now()-lastPoll>=refreshInterval)request().catch(()=>{$("sync-status").textContent="Sem conexão · tentando novamente";lastPoll=Date.now();});},1000);
})();
