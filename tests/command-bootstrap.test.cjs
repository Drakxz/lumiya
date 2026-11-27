const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const os=require("node:os");
const vm=require("node:vm");
const {createRequire}=require("node:module");
const {EventEmitter}=require("node:events");
const d=require("discord.js");
const { SLA_SUPPORT_ART, SLA_MIGRATION_ART }=require("../panel-art");

test("actual bot modules share one dispatcher and advertise only registered public commands",async t=>{
  const root=path.join(__dirname,"..");
  const base=process.platform==="win32"?path.join(os.tmpdir(),"opencode"):os.tmpdir();fs.mkdirSync(base,{recursive:true});
  const temp=fs.mkdtempSync(path.join(base,"catalog-bootstrap-"));
  const keys={ROLE_HISTORY_FILE:path.join(temp,"history.json"),CALL_STATS_FILE:":memory:",HISTORY_PERMISSION:"ManageRoles",COMMAND_CENTER_SHOW_RESTRICTED:"false"};
  const previous=new Map(Object.keys(keys).map(key=>[key,process.env[key]]));
  for(const [key,value]of Object.entries(keys))process.env[key]=value;
  const hooks=new Map(["exit","SIGINT","SIGTERM"].map(event=>[event,new Set(process.listeners(event))]));
  let clients=0,logins=0,slashId=0;
  const resources=[];
  class Client extends EventEmitter {
    constructor(options){super();clients++;this.options={...options,intents:new d.IntentsBitField(options.intents)};
       this.user={id:"100000000000000001",tag:"test#0001",setPresence:presence=>{this.presence=presence;}};
       this.members={me:{permissions:new d.PermissionsBitField(d.PermissionsBitField.All)}};
       this.guilds={cache:new d.Collection([["g1",{members:{me:{permissions:new d.PermissionsBitField()}}}],
         ["g2",{members:{me:{permissions:new d.PermissionsBitField()}}}]])};this.channels={};
      this.application={commands:{async create(data){return {id:String(100000000000010000n+BigInt(++slashId)),name:data.name};},async delete(){}}};}
    login(){logins++;return Promise.resolve();}isReady(){return true;}destroy(){}
  }
  const realRequire=createRequire(path.join(root,"index.js"));
  const context={module:{exports:{}},__dirname:root,console:{log(){},error:console.error,warn:console.warn},setTimeout,clearTimeout,
    process:{env:{DATA_FILE:path.join(temp,"tickets.json"),DISCORD_TOKEN:"test",MANAGED_ROLE_IDS:""}},
    require(name){
      if(name==="dotenv")return {config(){}};
      if(name==="discord.js")return {...d,Client};
      if(name==="./up")return options=>{const api=realRequire(name)(options);resources.push(api);return api;};
      if(name==="./call-panel")return options=>{const api=realRequire(name)({...options,env:{CALL_PANEL_ENABLED:"false",CALL_PANEL_STORE_FILE:path.join(temp,"call-accounts.enc")}});resources.push(api);return api;};
      return realRequire(name);
    }};
  let api;
  t.after(()=>{
    api?.anticrash.dispose();
    api?.centralComandos.close();api?.horasCall.fechar();
    for(const callback of process.listeners("exit"))if(!hooks.get("exit").has(callback))callback();
    for(const [event,before]of hooks)for(const callback of process.listeners(event))if(!before.has(callback))process.removeListener(event,callback);
    for(const [key,value]of previous)if(value===undefined)delete process.env[key];else process.env[key]=value;
    fs.rmSync(temp,{recursive:true,force:true});
  });
  const source=fs.readFileSync(path.join(root,"index.js"),"utf8");
  vm.runInNewContext(source+"\nmodule.exports={client,commands,horasCall,centralComandos,configuracaoLumiya,anticrash,gestaoTickets,dados,comandoTicketStats,montarContainerCargos,roleWhitelist,abrirTicketSuporte};",context,{filename:"index.js"});
  api=context.module.exports;
  for(const callback of api.client.listeners("clientReady"))await callback();
  assert.equal(clients,1);assert.equal(logins,1);assert.equal(api.client.listenerCount("messageCreate"),6);
  assert.equal(api.client.getMaxListeners(),32);
  for(const [oldTrigger,shortTrigger] of Object.entries(require("../command-system/shortcuts").SHORTCUTS)){
    const command=[...api.commands.commands.values()].find(c=>c.prefix?.trigger===shortTrigger);
    assert.ok(command,`Comando curto registrado: ${shortTrigger}`);
    assert.ok(command.prefix.aliases.includes(oldTrigger),`Alias antigo preservado: ${oldTrigger}`);
    assert.ok(api.commands.matches(command,shortTrigger));
    assert.ok(api.commands.matches(command,oldTrigger));
    assert.ok(command.prefix.usage.every(usage=>usage.startsWith(shortTrigger)));
  }
   assert.equal(api.client.options.presence.activities[0].type,d.ActivityType.Custom);
   assert.match(api.client.options.presence.activities[0].name,/💜 Online \| 0 servidores/);
    assert.equal(api.client.presence.status,"idle");
    assert.equal(api.client.presence.activities.length,0);
   assert.deepEqual(api.commands.catalog({all:true}).filter(c=>c.name!=="config").map(c=>c.name).sort(),
       ["corpainel","ban","desbanir","banpainel","autocall","backup","backuppainel","backups","cargos","cargoinicial","cargosgames","cl","comandos","ficha","hall","instagram","instapainel","instaticket","instaverificacao","tempo","limitebans","migracao","midiaadmin","nuke","midiarevisao","painel","painelcomandos","restaurar","ticketconfig","ticketstats","top","topadmin","gestaotickets","gestao-tickets","protecaouser","unbanall","unmutepainel","upadmin","upcargos","wlcargos"].sort());
  assert.equal(api.commands.catalog({member:{id:"ordinary-user",guild:{ownerId:"owner"},permissions:new d.PermissionsBitField([])}}).some(c=>c.name==="backup"),false);
  assert.equal(api.commands.catalog({member:{id:"owner",guild:{ownerId:"owner"},permissions:new d.PermissionsBitField([])}}).some(c=>c.name==="backup"),true);
   assert.equal(api.commands.commands.get("config").slash.status,"registered");
   assert.equal(api.commands.catalog({all:true}).filter(c=>api.commands.forms(c).some(f=>f.type==="slash")).length,11);
   await t.test("every registered public panel renders a valid isolated Components V2 preview",async()=>{
     const guild={id:"1331871489368260619",name:"mds",ownerId:"owner",memberCount:27,
       roles:{cache:new d.Collection()},channels:{cache:new d.Collection()},emojis:{cache:new d.Collection()},
       iconURL:()=>null,bannerURL:()=>null};
     for(const definition of api.configuracaoLumiya.panels.list()){
       const payload=await api.configuracaoLumiya.panels.render(definition.id,{guild,user:{id:"admin",username:"Admin"},bot:api.client.user,channel:{name:"config"}},{preview:true});
       assert.ok(payload.flags&d.MessageFlags.IsComponentsV2,definition.id);
       assert.equal(payload.embeds,undefined,definition.id);
       require("../configuration/render").validateComponents(payload.components);
       const nodes=require("../configuration/render").flat(payload.components);
       assert.ok(nodes.filter(c=>[2,3,5,6,7,8].includes(c.type)).every(c=>c.disabled),definition.id);
     }
   });
  await t.test("Instagram verification button opens one private support ticket with the existing staff controls",async()=>{
    const replies=[],initial=[],creates=[],added=[];
    const thread={id:"insta-thread",archived:false,members:{add:async id=>added.push(id)},
      send:async payload=>{initial.push(payload);return {id:"ticket-message"};},toString:()=>"<#insta-thread>"};
    const guild={id:"verification-guild",name:"Verificação",members:{fetch:async()=>({user:{bot:false}})},
      roles:{fetch:async()=>null},channels:{fetch:async()=>thread}};
    const parent={id:"ticket-parent",guild,type:d.ChannelType.GuildText,
      permissionsFor:()=>new d.PermissionsBitField(d.PermissionsBitField.All),
      threads:{create:async options=>{creates.push(options);return thread;}}};
    const interaction={guild,guildId:guild.id,channel:parent,user:{id:"insta-user",username:"usuario",tag:"usuario"},
      customId:"ticket-instagram",inGuild:()=>true,isButton:()=>true,isStringSelectMenu:()=>false,
      deferReply:async()=>{},editReply:async payload=>replies.push(payload)};
    api.dados.tickets["ordinary-support"]={guildId:guild.id,sistema:"support",tipo:"sup",donoId:"insta-user"};
    await api.abrirTicketSuporte(interaction);
    assert.equal(creates.length,1);
    assert.equal(creates[0].type,d.ChannelType.PrivateThread);
    assert.equal(creates[0].invitable,false);
    assert.deepEqual(added,["insta-user"]);
    assert.equal(api.dados.tickets[thread.id].tipo,"insta");
    assert.equal(api.dados.tickets[thread.id].sistema,"support");
    assert.match(JSON.stringify(initial[0].components[0].toJSON()),/Verificação do Instagram/);
    assert.match(JSON.stringify(initial[0].components[0].toJSON()),/Verificar membro/);
    assert.match(JSON.stringify(initial[0].components[0].toJSON()),/ticket-close/);
    await api.abrirTicketSuporte(interaction);
    assert.equal(creates.length,1);
    assert.match(JSON.stringify(replies.at(-1).components[0].toJSON()),/Ticket já aberto/);
  });
  const cargos=api.commands.commands.get("cargos");
  assert.notEqual(cargos.prefix.deleteMessage,false,"!cargos invocation is deleted after the command runs");
  for(const input of ["!cargo","!cargo <@100000000000000002>","!cargo 100000000000000002","!cargos"]){
    assert.equal(api.commands.matches(cargos,input),true);
    assert.equal(api.commands.matches(api.commands.commands.get("ficha"),input),false);
  }
  assert.equal(api.commands.matches(cargos,"!cargoinicial"),false);
  const member={permissions:new d.PermissionsBitField([d.PermissionFlagsBits.ManageGuild])};
  const sent=[];
  const message={guild:{},author:{id:"100000000000000002",bot:false},member,content:"!painel",
    channel:{async send(p){sent.push(p);}},async delete(){}};
  for(const callback of api.client.listeners("messageCreate"))await callback(message);
  assert.equal(sent.length,1);assert.equal(sent[0].components[0].toJSON().components[0].content,
    "### <:emoji_14:1570072344255533137><:emoji_13:1570072317873233942><:emoji_12:1570072282003542106>");
  assert.ok(Buffer.isBuffer(sent[0].files[0].attachment));
  const denied={...message,member:{permissions:new d.PermissionsBitField()},replies:[],async reply(p){this.replies.push(p);}};
  for(const callback of api.client.listeners("messageCreate"))await callback(denied);
  assert.equal(sent.length,1);assert.equal(denied.replies.length,1);
  assert.equal(denied.replies[0].components[0].toJSON().accent_color,0);
  const painel=api.commands.commands.get("painel");
  api.commands.register({...painel,prefix:{...painel.prefix,aliases:["!atendimento"]}});
  const alias={...message,content:"!atendimento"};
  for(const callback of api.client.listeners("messageCreate"))await callback(alias);
  assert.equal(sent.length,2);
  const sla={...message,guild:{id:"1571755216519438347",name:"sla"},content:"!painel"};
  for(const callback of api.client.listeners("messageCreate"))await callback(sla);
  const payload=sent[sent.length-1];
  assert.equal(payload.files.length,0,"sla panel sends no generated image");
  const galeria=payload.components[0].toJSON().components.find(c=>c.type===12);
  assert.equal(galeria.items[0].media.url,SLA_SUPPORT_ART);
  const slaMigration={...message,guild:{id:"1571755216519438347",name:"sla"},content:"!migracao",
    channel:{id:"test-channel",async send(p){const sentMessage={...p,id:"migration-panel",async pin(){},async delete(){}};sent.push(sentMessage);return sentMessage;}},
    async delete(){}};
  for(const callback of api.client.listeners("messageCreate"))await callback(slaMigration);
  const migrationPayload=sent.findLast(p=>p.components?.[0]?.toJSON?.().components?.some(c=>c.type===12&&c.items?.[0]?.media?.url===SLA_MIGRATION_ART));
  assert.ok(migrationPayload,"sla migration panel was sent");
  assert.equal(migrationPayload.files.length,0,"sla migration panel sends no generated image");
  const migrationGallery=migrationPayload.components[0].toJSON().components.find(c=>c.type===12);
  assert.equal(migrationGallery.items[0].media.url,SLA_MIGRATION_ART);
  const hall={...message,guild:{id:"hall-guild",name:"Servidor Hall"},content:"!hall"};
  for(const callback of api.client.listeners("messageCreate"))await callback(hall);
  const hallPayload=sent[sent.length-1];
  assert.equal(hallPayload.files,undefined,"hall panel uses the external image, not a generated attachment");
  const hallComponents=hallPayload.components[0].toJSON().components;
  assert.ok(hallComponents.some(c=>c.type===12&&c.items[0].media.url==="https://cdn.discordapp.com/attachments/1570868736926425190/1572062628103192617/file_000000003d04820e99d03c51b25ecc0d.png"));
  assert.equal(hallComponents.filter(c=>c.type===10).length,0,"hall panel has no text");
  const termsButton=hallComponents.flatMap(c=>c.components||[]).find(c=>c.type===2&&c.style===5);
  assert.equal(termsButton.url,"https://discord.com/terms");

  await t.test("sla role tabs render native dividers between roles and preserve tab navigation",async st=>{
    const roles=new d.Collection();
    const add=(id,name,position)=>roles.set(id,{id,name,position,comparePositionTo(other){return this.position-other.position;}});
    for(let n=0;n<9;n++)add(`upper-${n}`,`Cargo ${n}`,100-n);
    add("divider","-----------------------------",50);
    add("lower","Outro grupo",20);
    const guild={id:"1571755216519438347",roles:{cache:roles},members:{},available:false};
    const member={id:"viewer",roles:{cache:new d.Collection()},displayAvatarURL:()=>"https://cdn.discordapp.com/embed/avatars/0.png"};
    const state={id:"tabs-test",filtro:"todos",page:1};
    const render=()=>api.montarContainerCargos({estado:state,guild,autor:member,alvo:member}).toJSON();
    const walk=x=>[x,...(x.components||[]).flatMap(walk),...(x.accessory?walk(x.accessory):[])];
    const first=render(),nodes=walk(first);
    assert.ok(nodes.length<=40,`component count: ${nodes.length}`);
    assert.equal(nodes.filter(x=>x.custom_id?.startsWith("cargos:role:")).length,6);
    assert.ok(nodes.filter(x=>x.custom_id?.startsWith("cargos:role:")).every(x=>x.disabled));
    const dividers=first.components.filter(x=>x.type===14);
    assert.equal(dividers.length,5,"native dividers between each of the six roles");
    assert.ok(dividers.every(x=>x.divider===true));
    assert.equal(nodes.some(x=>x.custom_id==="cargos:rolepick:tabs-test"),false);
    const menu=nodes.find(x=>x.custom_id==="cargos:aba:tabs-test");
    assert.equal(menu.options.length,3);
    assert.equal(menu.options[0].label,"Aba 1 · 1/2");
    assert.doesNotMatch(JSON.stringify(first),/cargos:role:tabs-test:divider|<@&lower>/);
    state.page=3;
    assert.match(JSON.stringify(render()),/<@&lower>/);
    assert.doesNotMatch(JSON.stringify(render()),/<@&upper-/);
    st.mock.method(api.roleWhitelist,"access",()=>({kind:"whitelist",profile:{maxRoleId:"upper-0",add:true,remove:true}}));
    st.mock.method(api.roleWhitelist,"canRole",()=>true);
    st.mock.method(api.roleWhitelist,"targetDenial",()=>null);
    state.page=1;
    const current=walk(render());
    assert.equal(current.filter(x=>x.custom_id?.startsWith("cargos:role:")).length,6);
    assert.ok(current.filter(x=>x.custom_id?.startsWith("cargos:role:")).every(x=>!x.disabled));
    assert.ok(current.length<=40);
    Object.assign(state,{staffId:member.id,targetId:member.id,guildId:guild.id});
    api.dados.rolePanels[state.id]=state;
    guild.members.fetch=async()=>member;
    const handler=api.client.listeners("interactionCreate").find(fn=>fn.toString().includes("const modalAuth="));
    assert.ok(handler);
    const replies=[];
    const i={guild,guildId:guild.id,member,user:{id:member.id},customId:"cargos:aba:tabs-test",values:["3"],
      inGuild:()=>true,isModalSubmit:()=>false,isButton:()=>false,isStringSelectMenu:()=>true,
      async deferUpdate(){},async editReply(p){replies.push(p);},async followUp(p){replies.push(p);}};
    await handler(i);
    assert.equal(state.page,3,"select-menu interaction changes the actual tab");
    assert.match(JSON.stringify(replies[0].components[0].toJSON()),/<@&lower>/);
    st.mock.method(api.roleWhitelist,"canRole",()=>false);
    const denied=[];
    await handler({...i,customId:"cargos:role:tabs-test:upper-0",isButton:()=>true,isStringSelectMenu:()=>false,
      async reply(p){denied.push(p);}});
    assert.equal(denied.length,1,"role selection rechecks permissions before changing roles");
    assert.equal(member.roles.cache.size,0);
  });

  await t.test("ticketstats immediately reflects management goals and weekly counts, scoped by area",async()=>{
    const db=api.horasCall.store.db,gid="stats-guild",roles=new d.Collection(),members=new d.Collection();
    for(const [id,position]of [["support-role",10],["senior-role",20],["migration-role",30],["leader-role",50]]){
      roles.set(id,{id,name:id,position,comparePositionTo(other){return this.position-other.position;}});
    }
    const guild={id:gid,ownerId:"owner",roles:{cache:roles,fetch:async id=>id?roles.get(id):roles},
      members:{fetch:async query=>query===undefined?members:members.get(typeof query==="object"?query.user:query)}};
    for(const [id,ids]of [["leader",["leader-role"]],["worker",["support-role","senior-role"]],["migrant",["migration-role"]]]){
      members.set(id,{id,guild,user:{id,bot:false},permissions:new d.PermissionsBitField(),
        roles:{cache:new d.Collection(ids.map(id=>[id,roles.get(id)]))}});
    }
    db.prepare("INSERT INTO ticket_management_config VALUES(?,?)").run(gid,JSON.stringify({
      supportRole:"leader-role",supportTeam:["support-role","senior-role"],migrationTeam:["migration-role"]
    }));
    api.dados.ticketGoalsByRole[gid]={"support-role":2,"senior-role":3,"migration-role":77};
    api.dados.ticketStatsBySystem[gid]={support:{worker:999}};
    const {weekStart,WEEK_MS}=require("../voice-hours/time"),now=Date.now(),start=weekStart(now);
    const insert=db.prepare("INSERT INTO ticket_management_cases(id,guildId,area,status,assigneeId,closedAt) VALUES(?,?,?,?,?,?)");
    for(const [id,area,status,at]of [
      ["current","support","closed",now-1],["previous","support","closed",start-1],
      ["next","support","closed",start+WEEK_MS],["future","support","closed",now+60000],
      ["open","support","open",now-1],["migration","migration","closed",now-1]
    ])insert.run(id,gid,area,status,"worker",at);
    const interaction=(customId,extra={})=>({
      customId,user:{id:"leader"},guild,guildId:gid,channelId:"stats-channel",out:[],inGuild:()=>true,isButton:()=>true,
      async reply(p){this.out.push(p);},async editReply(p){this.out.push(p);},
      async deferReply(){this.deferred=true;},async showModal(p){this.out.push(p.toJSON());},...extra
    });
    const saveGoal=async(roleId,value)=>{
      const select=interaction("tg:team-goal-select:support",{values:[roleId]});
      await api.gestaoTickets.handle(select);
      const save=interaction(select.out[0].custom_id,{fields:{getTextInputValue:()=>String(value)}});
      await api.gestaoTickets.handle(save);
      assert.equal(api.gestaoTickets.team.goal(gid,"support",roleId),value);
    };
    const stats=async(mention=false)=>{
      const replies=[];
      await api.comandoTicketStats({guild,author:{id:"leader",bot:false},
        mentions:{users:{first:()=>mention?{id:"worker"}:undefined}},
        async reply(p){replies.push(p);return {id:"stats-reply",guildId:gid};}});
      return replies[0].components[0].toJSON().components[0].content;
    };
    await saveGoal("support-role",12);
    await saveGoal("senior-role",8);
    for(const mention of [false,true]){
      const body=await stats(mention);
      assert.match(body,/Semana atual/);
      assert.match(body,mention?/Suporte:\*\* 1 \/ 8 \(faltam 7\)/:/\*\*1\*\* \/ \*\*8\*\* \(faltam 7\)/);
      assert.doesNotMatch(body,/MIGRAÇÃO|Migração|migrant|999/);
    }
    await saveGoal("senior-role",0);
    assert.match(await stats(true),/1 \/ 12 \(faltam 11\)/,"next eligible role uses its own goal");
    await saveGoal("support-role",0);
    assert.match(await stats(true),/1 atendidos; sem meta configurada/);
    assert.match(await stats(),/\*\*1\*\* atendidos; sem meta/);
    assert.equal(api.dados.ticketGoalsByRole[gid]["support-role"],2,"disabled override does not rewrite legacy data");
    members.get("leader").roles.cache.clear();
    assert.doesNotMatch(await stats(),/worker|migrant/,"revoked area permission denies access");
  });
});
