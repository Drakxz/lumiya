const {EventEmitter}=require("node:events");
const {createHash}=require("node:crypto");
const fs=require("node:fs");
const path=require("node:path");
const {PermissionFlagsBits,ContainerBuilder,TextDisplayBuilder,MessageFlags}=require("discord.js");
const {errorText}=require("../error-ui");
const {simplifyCommand}=require("./shortcuts");

const instances=new WeakMap();
const labels={ManageGuild:"Gerenciar Servidor",ManageRoles:"Gerenciar Cargos",ManageChannels:"Gerenciar Canais",
  ManageMessages:"Gerenciar Mensagens",ViewAuditLog:"Ver Registro de Auditoria",Administrator:"Administrador"};
function isPermanentEntryPanel(message){
  function contains(items){
    return (items||[]).some(item=>{
      const c=item.toJSON?.()||item;
      return (c.type===3&&c.custom_id==="ticket-support")||
        (c.type===2&&["ticket-migration","ticket-instagram","up:claim","up:mine","up:levels"].includes(c.custom_id))||
        contains(c.components);
    });
  }
  return contains(message?.components);
}
function defaultDeny(origin) {
  const user=origin.user||origin.author;
  const p={components:[new ContainerBuilder().setAccentColor(0).addTextDisplayComponents(new TextDisplayBuilder().setContent(
    `**<a:1175261181741641789:1569933923641983038> | Você não possui permissão para executar esse comando.**\n\nRequisitado por: <@${user.id}>`))],
  flags:MessageFlags.IsComponentsV2|(origin.author?0:MessageFlags.Ephemeral),allowedMentions:{parse:[]}};
  return !origin.author&&(origin.deferred||origin.replied)?origin.followUp(p):origin.reply(p);
}
function bounded(value,label,max,required=true) {
  if(typeof value!=="string" || (required&&!value.trim()) || value.length>max)throw new Error(`Metadado inválido: ${label}`);
  return value.trim();
}
const listText=(values,label)=>{
  if(!Array.isArray(values)||values.length>5)throw new Error(`Metadado inválido: ${label}`);
  return values.map(value=>bounded(value,label,160));
};

class CommandRegistry extends EventEmitter {
  constructor(client) {
    super();this.client=client;this.commands=new Map();this.started=false;this.synced=false;this.deny=defaultDeny;
    this.remote=new Map();this.remoteStore=null;this.syncing=null;this.dirty=false;this.sources=new Map();this.slashHashes=new Map();
    this.ready=new Promise(resolve=>{this.resolveReady=resolve;});
    this.botMessageTimers=new Map();this.preservedBotMessages=new Set();this.preservedBotChannels=new Set();
    this.isPreservedBotMessage=id=>{
      if(this.preservedBotMessages.has(id))return true;
      try{
        const saved=JSON.parse(fs.readFileSync(path.join(__dirname,"preserved-messages.json"),"utf8"));
        return Array.isArray(saved)&&saved.includes(id);
      }catch{return false;}
    };
    this.preserveChannel=channelId=>{if(channelId)this.preservedBotChannels.add(channelId);return channelId;};
    this.preserveMessage=message=>{
      if(message?.ephemeral||Number(message?.flags?.bitfield||0)&MessageFlags.Ephemeral)return message;
      if(message?.id){this.preservedBotMessages.add(message.id);const key=`${message.channelId}:${message.id}`;
        clearTimeout(this.botMessageTimers.get(key));this.botMessageTimers.delete(key);}
      return message;
    };
    this.trackBotMessage=message=>{
      if(message?.ephemeral||Number(message?.flags?.bitfield||0)&MessageFlags.Ephemeral)return;
      if(!message?.guildId||message.author?.id!==client.user?.id||message.pinned||this.isPreservedBotMessage(message.id)||this.preservedBotChannels.has(message.channelId))return;
      // Public entry panels survive restarts without depending on an in-memory
      // preserveMessage call from the process that originally published them.
      if(isPermanentEntryPanel(message)){this.preserveMessage(message);return;}
      const key=`${message.channelId}:${message.id}`;
      clearTimeout(this.botMessageTimers.get(key));
      const timer=setTimeout(async()=>{
        this.botMessageTimers.delete(key);
        if(this.isPreservedBotMessage(message.id))return;
        try {
          const current=message.channel?.messages?.cache?.get(message.id)||await message.channel?.messages?.fetch(message.id);
          if(isPermanentEntryPanel(current)){this.preserveMessage(current);return;}
          if(current&&!current.pinned)await current.delete();
        } catch(error) {if(error.code!==10008&&error.code!==10003&&error.code!==50001)console.warn("[Mensagens automáticas] Não foi possível apagar após inatividade:",error.message);}
      },30_000);
      timer.unref();this.botMessageTimers.set(key,timer);
    };
    client.on("messageCreate",this.trackBotMessage);
    client.on("interactionCreate",interaction=>{
      if(interaction.message?.author?.id===client.user?.id)this.trackBotMessage(interaction.message);
    });
    client.on("messageCreate",async message=>{
      if(!message.guild||message.author?.bot||typeof message.content!=="string")return;
      for(const command of this.commands.values()) {
        if(!command.prefix || !this.matches(command,message.content))continue;
        try {
          if(!this.canUse(command,message.member))await this.deny(message);
           else await require("../configuration/runtime").withContext({guild:message.guild,user:message.author,channel:message.channel,bot:client.user,client},()=>command.prefix.execute(message));
        }catch(error){console.error(`[Comandos] Falha em ${command.name}:`,error);}
        // Executa primeiro para que respostas via message.reply ainda possam referenciar
        // a invocação; depois apaga o comando sem bloquear o despacho em caso de falha.
        if(command.prefix.deleteMessage!==false&&typeof message.delete==="function")await message.delete().catch(()=>{});
        return;
      }
    });
    client.on("interactionCreate",async interaction=>{
      if(!interaction.inGuild()||!interaction.isChatInputCommand?.())return;
      const command=this.commands.get(interaction.commandName);
      if(!command?.slash)return;
      try {
        if(!this.canUse(command,interaction.member))await this.deny(interaction);
         else await require("../configuration/runtime").withContext({guild:interaction.guild,user:interaction.user,channel:interaction.channel,bot:client.user,client},()=>command.slash.execute(interaction));
      }catch(error){
        console.error(`[Comandos] Falha em /${command.name}:`,error);
        const p={components:[new ContainerBuilder().setAccentColor(0)
          .addTextDisplayComponents(new TextDisplayBuilder().setContent(errorText("# Não foi possível\nTente novamente em instantes.")))],
        flags:MessageFlags.IsComponentsV2|MessageFlags.Ephemeral,allowedMentions:{parse:[]}};
        await (interaction.deferred||interaction.replied?interaction.followUp(p):interaction.reply(p)).catch(()=>{});
      }
    });
    client.once("clientReady",async()=>{
      this.started=true;
      try{await this.syncSlash();}finally{this.synced=true;this.resolveReady();this.emit("changed");}
    });
  }
  matches(command,content) {
    const f=command.prefix;
    let input=f.trimLeading===false?content.trimEnd():content.trim();
    const triggers=[f.trigger,...(f.aliases||[])];
    if(f.caseInsensitive)input=input.toLowerCase();
    return triggers.some(trigger=>{
      const target=f.caseInsensitive?trigger.toLowerCase():trigger;
      return f.exact?input===target:input.split(/\s+/,1)[0]===target;
    });
  }
  register(definition,{prepare=false}={}) {
    definition=simplifyCommand(definition);
    const name=bounded(definition.name,"name",32);
    if(!/^[a-z0-9_-]+$/.test(name))throw new Error("Nome lógico de comando inválido.");
    const command={...definition,name,description:bounded(definition.description,"description",350),
      category:bounded(definition.category,"category",80),public:definition.public!==false,
      permissions:[...new Set(definition.permissions||[])],result:bounded(definition.result||"","result",350,false),
      examples:listText(definition.examples||[],"examples"),
      permissionLabel:bounded(definition.permissionLabel||"","permissionLabel",160,false)};
    if(command.authorize!==undefined&&typeof command.authorize!=="function")throw new Error("A autorização personalizada precisa ser uma função.");
    if(command.permissions.some(permission=>typeof PermissionFlagsBits[permission]!=="bigint"))throw new Error("Permissão de comando inválida.");
    if(command.permissions.length>8)throw new Error("Use no máximo oito permissões por comando.");
    if(!command.prefix&&!command.slash)throw new Error("Um comando precisa de um executor de prefixo ou slash.");
    if(command.prefix) {
      command.prefix={...command.prefix,trigger:bounded(command.prefix.trigger,"trigger",40),
        usage:listText(command.prefix.usage||[command.prefix.trigger],"usage"),aliases:[...(command.prefix.aliases||[])]};
      if(typeof command.prefix.execute!=="function")throw new Error("Executor de prefixo ausente.");
      if(command.prefix.aliases.length>10)throw new Error("Use no máximo dez aliases por comando.");
      command.prefix.aliases.forEach(alias=>bounded(alias,"alias",40));
      if([command.prefix.trigger,...command.prefix.aliases].some(trigger=>/\s/.test(trigger)))throw new Error("O nome de ativação não pode conter espaços.");
      for(const existing of this.commands.values())if(existing.name!==name&&existing.prefix) {
        const a=[existing.prefix.trigger,...existing.prefix.aliases],b=[command.prefix.trigger,...command.prefix.aliases];
        if(a.some(x=>b.some(y=>(existing.prefix.caseInsensitive||command.prefix.caseInsensitive)?x.toLowerCase()===y.toLowerCase():x===y)))throw new Error("Prefixo/alias já registrado.");
      }
    }
    if(command.slash) {
      const data=typeof command.slash.data?.toJSON==="function"?command.slash.data.toJSON():command.slash.data;
      if(!data||data.name!==name||typeof command.slash.execute!=="function")throw new Error("Definição slash inválida.");
      const previous=this.commands.get(name)?.slash;
      command.slash={...command.slash,data,usage:listText(command.slash.usage||[`/${name}`],"slash usage"),
        status:previous&&JSON.stringify(previous.data)===JSON.stringify(data)?previous.status:"pending"};
    }
    const detailSize=command.description.length+command.result.length+command.category.length+
      command.examples.join(" ").length+(command.prefix?.usage.join(" ").length||0)+(command.slash?.usage.join(" ").length||0)+
      (command.prefix?.aliases.join(" ").length||0)+this.permissionText(command).length;
    if(detailSize>3000)throw new Error("Metadados excedem o limite seguro de texto para a Central.");
    if(prepare)return command;
    this.commands.set(name,command);this.emit("changed");
    if(this.started)this.syncSlash().catch(error=>console.warn("[Comandos] Sincronização:",error.message));
    return command;
  }
  unregister(name) {
    const removed=this.commands.delete(name);
    if(removed){this.emit("changed");if(this.started)this.syncSlash().catch(error=>console.warn("[Comandos] Sincronização:",error.message));}
    return removed;
  }
  canUse(command,member) {
    try {
      if(command.authorize)return Boolean(command.authorize(member));
      return command.permissions.every(name=>Boolean(member?.permissions?.has(PermissionFlagsBits[name])));
    }catch{return false;}
  }
  permissionText(command) {
    if(command.permissionLabel)return command.permissionLabel;
    return command.permissions.length?command.permissions.map(name=>labels[name]||name).join(", "):"Todos os membros";
  }
  catalog({member=null,includeRestricted=false,all=false}={}) {
    return [...this.commands.values()].filter(command=>
      command.public && (command.prefix||command.slash?.status==="registered") && (all||includeRestricted||this.canUse(command,member)))
      .sort((a,b)=>a.category.localeCompare(b.category,"pt-BR")||a.name.localeCompare(b.name));
  }
  forms(command) {
    return [...(command.prefix?[{type:"prefix",usage:command.prefix.usage}]:[]),
      ...(command.slash?.status==="registered"?[{type:"slash",usage:command.slash.usage}]:[])];
  }
  snapshot() {
    return this.catalog({all:true}).map(c=>({name:c.name,description:c.description,category:c.category,permissions:c.permissions,public:c.public,
      permissionLabel:c.permissionLabel,
      result:c.result,examples:c.examples,forms:this.forms(c),aliases:c.prefix?.aliases||[],
      slashData:c.slash?.status==="registered"?c.slash.data:null}));
  }
  hash() {return createHash("sha256").update(JSON.stringify(this.snapshot())).digest("hex");}
  attachRemoteStore(adapter) {this.remoteStore=adapter;for(const item of adapter.list())this.remote.set(item.name,item.id);}
  async syncSlash() {
    this.dirty=true;
    if(this.syncing)return this.syncing;
    this.syncing=(async()=>{
      while(this.dirty) {
        this.dirty=false;
        for(const [name,id] of [...this.remote])if(!this.commands.get(name)?.slash) {
          try{await this.client.application.commands.delete(id);}
          catch(error){if(error.code!==10063){console.warn(`[Comandos] Não foi possível remover /${name}:`,error.message);continue;}}
          this.remote.delete(name);this.slashHashes.delete(name);this.remoteStore?.remove(name);
        }
        for(const command of [...this.commands.values()])if(command.slash) {
          const hash=JSON.stringify(command.slash.data);
          if(command.slash.status==="registered"&&this.slashHashes.get(command.name)===hash)continue;
          try {
            const remote=await this.client.application.commands.create(command.slash.data);
            command.slash.status="registered";
            this.slashHashes.set(command.name,hash);
            if(remote?.id){this.remote.set(command.name,remote.id);this.remoteStore?.set(command.name,remote.id);}
          }catch(error){command.slash.status="error";console.warn(`[Comandos] /${command.name} não registrado:`,error.message);}
        }
      }
    })();
    try{await this.syncing;}finally{
      this.syncing=null;this.emit("changed");
      if(this.dirty)queueMicrotask(()=>this.syncSlash().catch(error=>console.warn("[Comandos] Sincronização:",error.message)));
    }
  }
  loadDirectory(directory,context={}) {
    const root=path.resolve(directory);
    const previous=this.sources.get(root)||new Set();
    // Carrega/valida exports antes de retirar comandos da versão anterior.
    const definitions=[];
    if(fs.existsSync(root))for(const filename of fs.readdirSync(root).filter(file=>/\.(?:c?js)$/.test(file)).sort()) {
      const full=path.join(root,filename);delete require.cache[require.resolve(full)];
      let exported=require(full);
      if(typeof exported==="function")exported=exported({client:this.client,registry:this,...context});
      definitions.push(...(Array.isArray(exported)?exported:[exported]));
    }
    const original=this.commands,staging=new Map([...original].filter(([name])=>!previous.has(name)));
    const next=new Set();
    try {
      this.commands=staging;
      for(const definition of definitions) {
        if(!definition||staging.has(definition.name))throw new Error(`Comando de extensão duplicado ou em conflito: ${definition?.name}`);
        const command=this.register(definition,{prepare:true});staging.set(command.name,command);next.add(command.name);
      }
    }finally{this.commands=original;}
    this.commands=staging;this.sources.set(root,next);this.emit("changed");
    if(this.started)this.syncSlash().catch(error=>console.warn("[Comandos] Recarga:",error.message));
  }
}

function getCommandRegistry(client,options={}) {
  let registry=instances.get(client);
  if(!registry){registry=new CommandRegistry(client);instances.set(client,registry);}
  if(options.deny)registry.deny=options.deny;
  return registry;
}
module.exports={getCommandRegistry,CommandRegistry};
