const {MessageFlags,ContainerBuilder,TextDisplayBuilder,ActionRowBuilder,ButtonBuilder,ButtonStyle}=require("discord.js");
const {shortCommandText}=require("../command-system/shortcuts");
const SYSTEM_PANELS={
  tickets:["support","migration"],security:["nickname-entry"],
  moderation:["ban-home","unmute","media-review-entry"],roles:["games"],
  rankings:["rankings","up"],ai:["media-review-entry"],
  instagram:["instagram-ticket","instagram-media","instagram-entry"]
};
const COMMAND_LABELS={
  "gestao-tickets":"Gerenciar atendimentos e equipe",ticketconfig:"Configurar tickets e permissões",
  protecaouser:"Configurar proteção de apelidos",wlcargos:"Configurar whitelist de cargos",
  limitebans:"Definir limites de banimentos",banpainel:"Abrir central de banimentos",
  cargoinicial:"Definir cargo inicial",cargosgames:"Configurar cargos de jogos",
  topadmin:"Gerenciar rankings",upadmin:"Configurar progressão de cargos",
  midiaadmin:"Configurar análise de mídias",chat:"Configurar chat de IA",
  instagram:"Configurar Instagram",instaverificacao:"Configurar verificação",
  backuppainel:"Gerenciar backups",autocall:"Configurar calls automáticas"
};
function panelsForSystem(system,panels){
  const ids=SYSTEM_PANELS[system?.id];
  return ids?ids.filter(id=>panels.items.has(id)).map(id=>panels.get(id)):
    panels.list().filter(panel=>panel.category===system?.label);
}
function discoverSystems(commands,apis){
  const defs=[
    ["security","Segurança","Proteção de nomes e controle de cargos.",["protecaouser","wlcargos"]],
    ["moderation","Moderação","Limites e ações moderativas existentes.",["limitebans","banpainel"]],
    ["tickets","Tickets","Áreas, atendimento e permissões de tickets.",["gestao-tickets","ticketconfig"]],
    ["roles","Cargos","Whitelist, cargo inicial e cargos de jogos.",["wlcargos","cargoinicial","cargosgames"]],
    ["rankings","Rankings e progressão","Atividade, horas e progressão de cargos.",["topadmin","upadmin"]],
    ["ai","Inteligência artificial","Análise de mídia, nomes e chat de IA.",["midiaadmin","protecaouser","chat"]],
    ["instagram","Instagram e verificação","Publicações, verificação e origem dos envios.",["instagram","instaverificacao"]],
    ["backups","Backups","Rotinas privadas de backup e restauração.",["backuppainel"]],
    ["voice","Calls automáticas","Canais de voz criados sob demanda.",["autocall"]]
  ];
  const systems=defs.map(([id,label,description,names])=>({
    id,label,description,commands:names.filter(name=>commands.commands.has(name)),
    status:guild=>{
      if(id==="security")return Boolean(apis.nickname?.settings(guild.id)?.enabled);
      if(id==="voice")return Boolean(apis.autoCalls?.settings(guild.id)?.enabled);
      if(id==="ai")return Boolean(apis.media?.store.settings(guild.id)?.enabled||apis.ai?.enabledFor?.(guild.id));
      if(id==="instagram")return Boolean(apis.instagram?.isConfigured?.(guild.id));
      if(id==="roles")return Boolean(apis.initialRole?.settings(guild.id)?.enabled||apis.whitelist?.store.config(guild.id)?.adminIds?.length);
      if(id==="rankings")return Boolean(apis.up?.engine.store.config(guild.id)?.enabled||apis.rankings?.publicos.has(guild.id));
      if(id==="backups")return Boolean(apis.backups?.store.settings(guild.id)?.automatic);
      if(id==="tickets")return Boolean(apis.tickets?.config(guild.id));
      return true;
    }
  })).filter(s=>s.commands.length);
  const included=new Set(systems.flatMap(s=>s.commands));
  // Novos módulos podem declarar configuration:true para entrar automaticamente
  // no catálogo; sem essa declaração, nenhuma ação destrutiva é executada.
  for(const command of commands.commands.values()){
    if(!command.configuration||included.has(command.name))continue;
    systems.push({id:`cmd-${command.name}`,label:command.configuration.label||command.name,
      description:command.description,commands:[command.name],status:()=>true});
    included.add(command.name);
  }
  const categoryMap={"Moderação":"moderation","Suporte":"tickets","Gerenciamento de Cargos":"roles","Rankings":"rankings","Progressão de Cargos":"rankings","Instagram":"instagram"};
  for(const command of commands.commands.values()){
    if(command.public===false||included.has(command.name)||["config","corpainel"].includes(command.name))continue;
    let system=systems.find(item=>item.id===categoryMap[command.category]);
    if(!system){
      const id=`other-${require("node:crypto").createHash("sha256").update(command.category).digest("hex").slice(0,12)}`;
      system=systems.find(item=>item.id===id);
      if(!system){system={id,label:command.category,description:"Recursos e comandos existentes nesta categoria.",commands:[],status:()=>true};systems.push(system);}
    }
    system.entries??=[];system.entries.push(command.name);
  }
  return systems;
}
async function privateCommand({interaction,command,commands,session,member,args="",apis}){
  if(!commands.canUse(command,member))throw new Error("Sua autorização na central não substitui as permissões exigidas por este sistema.");
  const nav=new ActionRowBuilder().addComponents(new ButtonBuilder()
    .setCustomId(`lc:${session.data?.systemId?"systemHome":"home"}:${session.id}:${session.revision}`)
    .setLabel(session.data?.systemId?"Voltar à função":"Voltar à central").setStyle(ButtonStyle.Secondary));
  async function send(input){
    let payload=typeof input==="string"?{content:input}: {...input};
    if(payload.components?.length){
      const items=payload.components.map(c=>c.toJSON?.()||c);
      const count=require("./render").flat(items).length;
      if(count+2<=40)items.push(nav.toJSON());
      payload.components=items;
    }else if(payload.content&&!payload.embeds?.length){
      payload.components=[new ContainerBuilder().setAccentColor(0xC4A7E7).addTextDisplayComponents(new TextDisplayBuilder().setContent(payload.content.slice(0,3900))).addActionRowComponents(nav)];
      delete payload.content;payload.flags=MessageFlags.IsComponentsV2;
    }
    payload.flags=Number(payload.flags||0)|MessageFlags.Ephemeral;
    payload.allowedMentions={parse:[]};
    return interaction.followUp({...payload,fetchReply:true});
  }
  if(command.name==="protecaouser"&&apis.nickname){
    const proxy=new Proxy(interaction,{get(target,key){
      if(key==="customId")return "np:open";
      if(key==="deferred"||key==="replied")return false;
      if(key==="reply")return send;
      if(key==="deferReply")return async()=>{};
      if(key==="editReply")return send;
      const value=target[key];return typeof value==="function"?value.bind(target):value;
    }});
    return apis.nickname.handle(proxy);
  }
  if(command.slash){
    let response;
    const proxy=new Proxy(interaction,{get(target,key){
      if(key==="deferReply")return async()=>{};
      if(key==="reply"||key==="followUp")return send;
      if(key==="editReply")return async payload=>{if(!response)response=await send(payload);else await response.edit(payload);return response;};
      const value=target[key];return typeof value==="function"?value.bind(target):value;
    }});
    return command.slash.execute(proxy);
  }
  const realChannel=interaction.channel;
  const channel=new Proxy(realChannel,{get(target,key){
    if(key==="send")return send;
    const value=target[key];return typeof value==="function"?value.bind(target):value;
  }});
  const author=new Proxy(interaction.user,{get(target,key){
    if(key==="send")return send;
    const value=target[key];return typeof value==="function"?value.bind(target):value;
  }});
  const message={id:interaction.id,guild:interaction.guild,guildId:interaction.guildId,channel,channelId:realChannel.id,
    author,member,content:`${command.prefix.trigger}${args?` ${args}`:""}`,reply:send,delete:async()=>{},
    mentions:{users:new Map(),members:new Map(),channels:new Map()},react:async()=>{}};
  return command.prefix.execute(message);
}
module.exports={discoverSystems,privateCommand,shortCommandText,panelsForSystem,COMMAND_LABELS};
