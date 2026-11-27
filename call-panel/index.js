const http=require("node:http");
const fs=require("node:fs/promises");
const path=require("node:path");
const {randomBytes,randomUUID,timingSafeEqual}=require("node:crypto");
const {createStore}=require("./store");
const installSecondary=require("../voice-presence/secondary");

const DEFAULT_PRESENCE={status:"online",name:"",type:0,url:""};
function validPresence(input){
  if(!input||typeof input!=="object"||!["online","idle","dnd","invisible"].includes(input.status)||
    ![0,1,2,3,4,5].includes(input.type)||typeof input.name!=="string"||input.name.length>100)
    throw new Error("Dados inválidos: confira o status e a atividade.");
  let url="";
  if(input.type===1&&input.name.trim()){
    let parsed;try{parsed=new URL(input.url);}catch{throw new Error("Informe um link HTTPS da Twitch ou YouTube para transmitir.");}
    if(parsed.protocol!=="https:"||!["twitch.tv","www.twitch.tv","youtube.com","www.youtube.com","youtu.be"].includes(parsed.hostname)||parsed.username||parsed.password)
      throw new Error("Informe um link HTTPS da Twitch ou YouTube para transmitir.");
    url=parsed.toString();
  }
  return {status:input.status,type:input.type,name:input.name.trim(),url};
}
function createManager({client,store,auditStore,env=process.env,install=installSecondary}){
  let accounts=[],closed=false,tail=Promise.resolve();
  let events=[];
  const startedAt=Date.now();
  async function record(account,action){
    const event={id:randomUUID(),at:Date.now(),accountId:account.id,accountName:account.name,action};
    events=[event,...events].slice(0,150);
    if(auditStore)try{await auditStore.save(events);}catch{console.warn("[Painel de calls] Não foi possível salvar o histórico de ações.");}
  }
  const connections=new Map();
  function saveProfile(account,profile){
    return mutate(async()=>{
      const current=accounts.find(a=>a.id===account.id&&!a.deleted&&a.token===account.token);
      if(!current||JSON.stringify(current.profile)===JSON.stringify(profile))return;
      const next=accounts.map(a=>a.id===account.id?{...a,profile}:a);
      await store.save(next);accounts=next;
    });
  }
  function start(account){
    connections.get(account.id)?.close();connections.delete(account.id);
    if(!closed&&account.enabled&&!account.deleted)connections.set(account.id,install({client,token:account.token,channelId:account.channelId,
      selfMute:account.selfMute??true,selfDeaf:account.selfDeaf??true,autoReconnect:account.autoReconnect??true,
      joinCall:account.joinCall??true,presence:account.presence||DEFAULT_PRESENCE,
      group:`panel-${account.id}`,manageSignals:false,onProfile:profile=>saveProfile(account,profile)}));
  }
  const ready=(async()=>{
    accounts=await store.load();
    if(auditStore)events=(await auditStore.load()).slice(0,150);
    const legacy=[
      {id:"bio-account",name:"Conta da verificação de bio",token:env.DISCORD_BIO_CHECK_USER_TOKEN,channelId:"1571977809633615942"},
      {id:"extra-account",name:"Conta adicional do .env",token:env.DISCORD_EXTRA_CALL_TOKEN,channelId:env.DISCORD_EXTRA_CALL_CHANNEL_ID||"1571977809633615942"}
    ];
    let changed=false;
    for(const a of legacy)if(a.token?.trim()&&!accounts.some(saved=>saved.id===a.id||saved.token===a.token.trim())){
      accounts.push({...a,token:a.token.trim(),enabled:true});changed=true;
    }
    if(changed)await store.save(accounts);
    if(!closed)for(const a of accounts)start(a);
  })();
  function list(){return accounts.filter(a=>!a.deleted).map(a=>({
    id:a.id,name:a.name,channelId:a.channelId,enabled:a.enabled,
    hasToken:Boolean(a.token),state:connections.get(a.id)?.getStatus?.().state||(a.enabled?"waiting":"disconnected"),
    connectedAt:connections.get(a.id)?.getStatus?.().connectedAt||null,
    selfMute:a.selfMute??true,selfDeaf:a.selfDeaf??true,autoReconnect:a.autoReconnect??true,favorite:Boolean(a.favorite),notes:a.notes||"",
    profile:a.profile||null,joinCall:a.joinCall??true,presence:a.presence||{...DEFAULT_PRESENCE},
    presenceDelivery:connections.get(a.id)?.getStatus?.().presenceDelivery||"pending",
    presenceError:connections.get(a.id)?.getStatus?.().presenceError||null
  }));}
  function mutate(operation){
    const work=tail.catch(()=>{}).then(async()=>{await ready;if(closed)throw new Error("Painel encerrado.");return operation();});
    tail=work;return work;
  }
  async function save(input){
    return mutate(async()=>{
      if(!input||typeof input!=="object")throw new Error("Dados inválidos.");
      const existing=accounts.find(a=>a.id===input.id&&!a.deleted);
      if(input.id&&!existing)throw new Error("Conta não encontrada.");
      if(!existing&&accounts.filter(a=>!a.deleted).length>=20)throw new Error("Limite de 20 contas atingido.");
      const name=String(input.name||"").trim(),channelId=String(input.channelId||"").trim();
      const token=typeof input.token==="string"?input.token.trim():"";
      if(!name||name.length>60)throw new Error("Nome deve ter de 1 a 60 caracteres.");
      const joinCall=input.joinCall??existing?.joinCall??true;
      if((joinCall||channelId)&&!/^\d{17,20}$/.test(channelId))throw new Error("Informe um ID de canal válido.");
      if((!token&&!existing?.token)||token.length>512||/\s/.test(token))throw new Error("Informe um token válido, sem espaços.");
      const chosen=token||existing.token;
      if(accounts.some(a=>a.id!==existing?.id&&a.token===chosen))throw new Error("Este token já está cadastrado.");
      for(const key of ["selfMute","selfDeaf","autoReconnect","joinCall"])if(input[key]!==undefined&&typeof input[key]!=="boolean")throw new Error("Dados inválidos.");
      const selfDeaf=input.selfDeaf??existing?.selfDeaf??true;
      const notes=String(input.notes??existing?.notes??"").trim();
      if(notes.length>200)throw new Error("Dados inválidos: anotação deve ter até 200 caracteres.");
      const account={id:existing?.id||randomUUID(),name,channelId,token:chosen,enabled:existing?.enabled??false,
        selfMute:selfDeaf||Boolean(input.selfMute??existing?.selfMute??true),selfDeaf,
        autoReconnect:input.autoReconnect??existing?.autoReconnect??true,favorite:existing?.favorite??false,notes,
        profile:chosen===existing?.token?existing.profile||null:null,joinCall,
        presence:input.presence?validPresence(input.presence):existing?.presence||{...DEFAULT_PRESENCE}};
      const next=existing?accounts.map(a=>a.id===existing.id?account:a):[...accounts,account];
      await store.save(next);accounts=next;start(account);
      await record(account,existing?"Conta atualizada":"Conta cadastrada");
      return list();
    });
  }
  async function action(id,action,input={}){
    return mutate(async()=>{
      const a=accounts.find(a=>a.id===id&&!a.deleted);
      if(!a)throw new Error("Conta não encontrada.");
      if(!["connect","disconnect","delete","reconnect","audio","favorite","presence"].includes(action))throw new Error("Ação inválida.");
      if(action==="audio"||action==="favorite"||action==="presence"){
        let update;
        if(action==="favorite")update={favorite:!a.favorite};
        else if(action==="presence")update={presence:validPresence(input.presence)};
        else{
          const modes={open:{selfMute:false,selfDeaf:false},muted:{selfMute:true,selfDeaf:false},deafened:{selfMute:true,selfDeaf:true}};
          if(!Object.hasOwn(modes,input.mode))throw new Error("Ação inválida: escolha um modo de áudio.");
          update=modes[input.mode];
        }
        const next=accounts.map(item=>item.id===id?{...item,...update}:item);
        await store.save(next);accounts=next;
        if(action==="audio")connections.get(id)?.setAudio?.(update.selfMute,update.selfDeaf);
        if(action==="presence")await connections.get(id)?.setPresence?.(update.presence);
        await record(a,action==="audio"?"Preferência de áudio alterada":action==="presence"?"Status e atividade atualizados":update.favorite?"Conta favoritada":"Favorito removido");
        return list();
      }
      const next=action==="delete"
        ?accounts.flatMap(item=>item.id!==id?[item]:["bio-account","extra-account"].includes(id)?[{...item,deleted:true,enabled:false,token:""}]:[])
        :accounts.map(item=>item.id===id?{...item,enabled:action==="connect"||action==="reconnect"}:item);
      await store.save(next);accounts=next;
      connections.get(id)?.close();connections.delete(id);
      const updated=accounts.find(item=>item.id===id);if(updated)start(updated);
      await record(a,{connect:"Conexão solicitada",disconnect:"Conta desconectada",delete:"Conta excluída",reconnect:"Reconexão solicitada"}[action]);
      return list();
    });
  }
  return {ready,list,save,action,events:()=>events.map(e=>({...e})),
    system:()=>({startedAt,nodeVersion:process.version,platform:process.platform,botReady:Boolean(client.isReady?.()),vault:process.platform==="win32"?"Windows DPAPI":"AES-256-GCM",localOnly:true}),
    close(){closed=true;for(const c of connections.values())c.close();connections.clear();}};
}

function createPanelServer({manager,html,accessKey=randomBytes(32).toString("hex")}){
  let origin;
  const server=http.createServer(async(req,res)=>{
    const headers={
      "Cache-Control":"no-store","X-Content-Type-Options":"nosniff","Referrer-Policy":"no-referrer",
      "Content-Security-Policy":"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https://cdn.discordapp.com; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
    };
    function respond(status,data,type="application/json"){
      res.writeHead(status,{...headers,"Content-Type":`${type}; charset=utf-8`});res.end(type==="application/json"?JSON.stringify(data):data);
    }
    if(req.headers.host!==new URL(origin).host||req.headers.origin&&req.headers.origin!==origin)return respond(403,{error:"Origem não permitida."});
    if(req.method==="GET"&&req.url==="/")return respond(200,html,"text/html");
    if(req.method==="GET"&&req.url==="/app.js"){
      try{return respond(200,await fs.readFile(path.join(__dirname,"app.js"),"utf8"),"text/javascript");}
      catch{return respond(500,{error:"Interface indisponível."});}
    }
    const provided=req.headers["x-panel-key"];
    if(typeof provided!=="string"||Buffer.byteLength(provided)!==Buffer.byteLength(accessKey)||!timingSafeEqual(Buffer.from(provided),Buffer.from(accessKey)))
      return respond(401,{error:"Abra o link de acesso exibido no terminal do bot."});
    try{
      await manager.ready;
      if(req.method==="GET"&&req.url==="/api/accounts")return respond(200,{accounts:manager.list(),events:manager.events(),system:manager.system()});
      if(req.method==="GET"&&req.url==="/api/export")return respond(200,{version:1,exportedAt:new Date().toISOString(),
        accounts:manager.list().map(({name,channelId,selfMute,selfDeaf,autoReconnect,joinCall,presence,notes,favorite})=>({name,channelId,selfMute,selfDeaf,autoReconnect,joinCall,presence,notes,favorite}))});
      if(req.method!=="POST"||!["/api/accounts","/api/action"].includes(req.url))return respond(404,{error:"Não encontrado."});
      if(!req.headers["content-type"]?.startsWith("application/json"))return respond(415,{error:"Envie JSON."});
      let raw="",size=0;
      for await(const chunk of req){size+=chunk.length;if(size>16384)return respond(413,{error:"Dados acima do limite."});raw+=chunk;}
      let input;try{input=JSON.parse(raw);}catch{return respond(400,{error:"JSON inválido."});}
      const accounts=req.url==="/api/accounts"?await manager.save(input):await manager.action(input?.id,input?.action,input);
      respond(200,{accounts,events:manager.events(),system:manager.system()});
    }catch(error){
      // Só expõe erros conhecidos de validação; nunca erros de rede ou tokens.
      const message=String(error.message||"");
      const safe=/^(Dados inválidos|Conta não encontrada|Limite de 20 contas|Nome deve ter|Informe um |Este token já|Ação inválida)/.test(message);
      respond(safe?400:500,{error:safe?message:"Não foi possível concluir. Verifique o acesso ao cofre de credenciais e tente novamente."});
    }
  });
  return {server,listen(port=3210){
    return new Promise((resolve,reject)=>{
      server.once("error",reject);
      server.listen(port,"127.0.0.1",()=>{server.removeListener("error",reject);origin=`http://127.0.0.1:${server.address().port}`;resolve(`${origin}/#key=${accessKey}`);});
    });
  }};
}

module.exports=function installCallPanel({client,env=process.env}){
  const store=createStore(env.CALL_PANEL_STORE_FILE||path.join(__dirname,"../database/call-accounts.enc"));
  const auditStore=createStore(`${env.CALL_PANEL_STORE_FILE||path.join(__dirname,"../database/call-accounts.enc")}.events`);
  const manager=createManager({client,store,auditStore,env});
  let server,closed=false;
  const ready=(async()=>{
    await manager.ready;
    if(closed||env.CALL_PANEL_ENABLED==="false")return;
    const html=await fs.readFile(path.join(__dirname,"index.html"),"utf8");
    if(closed)return;
    const panel=createPanelServer({manager,html});server=panel.server;
    const url=await panel.listen(Number(env.CALL_PANEL_PORT)||3210);
    if(closed){server.close();return;}
    console.log("[Painel de calls] Acesso local (não compartilhe este link):",url);
  })().catch(()=>console.warn("[Painel de calls] Não foi possível iniciar. Verifique o cofre de credenciais ou se a porta 3210 está ocupada."));
  function close(){
    closed=true;
    manager.close();server?.close();
    for(const signal of ["SIGINT","SIGTERM","exit"])process.removeListener(signal,close);
  }
  for(const signal of ["SIGINT","SIGTERM","exit"])process.once(signal,close);
  return {manager,ready,close};
};
module.exports.createManager=createManager;
module.exports.createPanelServer=createPanelServer;
