const test=require("node:test");
const assert=require("node:assert/strict");
const {DatabaseSync}=require("node:sqlite");
const {EventEmitter}=require("node:events");
const {PermissionsBitField,PermissionFlagsBits,MessageFlags}=require("discord.js");
const {getCommandRegistry}=require("../command-system/registry");
const install=require("../command-center");
const G="100000000000000001",C="100000000000000002",USER="100000000000000003",ADMIN="100000000000000004",BOT="100000000000000005";
function fixture(t,{showRestricted=false,db=new DatabaseSync(":memory:"),closeDb=true}={}) {
  const client=new EventEmitter();client.user={id:BOT};
  const calls={denied:[],sent:[],edits:[],create:[],deleted:[]};
  const messages=new Map();
  const f={editError:null,fetchError:null};
  const channel={id:C,guildId:G,isTextBased:()=>true,
    permissionsFor:()=>new PermissionsBitField([PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages]),
    messages:{async fetch(id){if(f.fetchError)throw f.fetchError;const message=messages.get(id);if(!message)throw Object.assign(new Error("Unknown Message"),{code:10008});return message;}},
    async send(p){calls.sent.push(p);const id=String(100000000000001000n+BigInt(calls.sent.length));
      const message={id,author:{id:BOT},async edit(payload){if(f.editError)throw f.editError;calls.edits.push(payload);return message;}};
      messages.set(id,message);return message;}};
  const member=id=>({id,permissions:new PermissionsBitField(id===ADMIN?[PermissionFlagsBits.ManageGuild]:[])});
  const guild={id:G,name:"Servidor Alpha",members:{me:member(ADMIN)},channels:{async fetch(){return channel;}}};
  client.channels={async fetch(){return channel;}};
  client.application={commands:{async create(data){calls.create.push(data);return {id:String(100000000000002000n+BigInt(calls.create.length))};},async delete(id){calls.deleted.push(id);}}};
  const deny=async i=>{calls.denied.push(i);};
  const registry=getCommandRegistry(client,{deny});
  const center=install({client,registry,db,responderSemPermissao:deny,showRestricted});
  t.after(()=>{center.close();if(closeDb)db.close();});
  const emit=async(event,...args)=>{for(const fn of client.listeners(event))await fn(...args);};
  const def=(name="real",category="Geral",extra={})=>({name,category,description:`Descrição real de ${name}`,
    result:`Resultado real de ${name}`,examples:[`!${name}`],prefix:{trigger:`!${name}`,usage:[`!${name} [argumento]`],execute:async()=>{}},...extra});
  function message(content="!comandos",userId=USER) {
    return {guild,channel,content,author:{id:userId,bot:false},member:member(userId),replies:[],async reply(p){this.replies.push(p);}};
  }
  function i(customId,userId=USER,{values=[],query="",slash=false}={}) {
    return {guild,guildId:G,user:{id:userId},member:member(userId),customId,values,replies:[],edits:[],follows:[],
      inGuild:()=>true,isChatInputCommand:()=>slash,commandName:slash?"comandos":null,
      fields:{getTextInputValue:()=>query},async deferReply(flags){this.deferred=true;this.deferFlags=flags;},async deferUpdate(){this.deferred=true;this.updated=true;},
      async reply(p){this.replies.push(p);this.replied=true;},async editReply(p){assert.equal(this.deferred,true);this.edits.push(p);},
      async followUp(p){this.follows.push(p);},async showModal(modal){this.modal=modal;this.replied=true;}};
  }
  const latest=()=>JSON.parse(db.prepare("SELECT data FROM command_center_sessions ORDER BY rowid DESC LIMIT 1").get().data);
  return {client,registry,center,db,calls,messages,channel,member,guild,emit,def,message,i,latest,f};
}
function tree(node){return [node,...(node.components||[]).flatMap(tree),...(node.accessory?tree(node.accessory):[])];}
function check(p){assert.ok(p.flags&MessageFlags.IsComponentsV2);assert.equal(p.content,undefined);assert.equal(p.embeds,undefined);
  const json=p.components[0].toJSON();assert.ok(tree(json).length<=40);
  assert.ok(tree(json).filter(x=>x.type===10).map(x=>x.content).join("").length<=4000);
  for(const x of tree(json))if(x.custom_id)assert.ok(x.custom_id.length<=100);
  return json;}
const text=p=>tree(check(p)).filter(x=>x.type===10).map(x=>x.content).join("\n");

test("restore republishes missing central panels only in recreated channels, without duplicates",async t=>{
  const h=fixture(t);
  h.center.store.preparePanel(G,C);
  assert.deepEqual(await h.center.republishRestoredPanels(h.guild,[]),[]);
  assert.equal(h.calls.sent.length,0);
  assert.deepEqual(await h.center.republishRestoredPanels(h.guild,[C]),[]);
  assert.equal(h.calls.sent.length,1);
  assert.ok(h.center.store.panel(G,C).messageId);
  await h.center.republishRestoredPanels(h.guild,[C]);
  assert.equal(h.calls.sent.length,1);
});

test("command center titles use the current guild name instead of a fixed brand",async t=>{
  const h=fixture(t);await h.emit("clientReady");
  const message=h.message();await h.emit("messageCreate",message);
  const content=text(message.replies[0]);
  assert.ok(content.includes("Central de Comandos | Servidor Alpha"));
  assert.ok(content.includes("Central de Comandos de Servidor Alpha"));
  assert.ok(!content.includes("Central de Comandos da mds"));
});

test("central command counts and category menu come from live executable definitions",async t=>{
  const h=fixture(t);h.registry.register(h.def("live","Categoria nova"));await h.emit("clientReady");
  const m=h.message();await h.emit("messageCreate",m);
  const json=check(m.replies[0]);assert.ok(text(m.replies[0]).includes("**Comandos disponíveis:** 2"));
  assert.ok(tree(json).some(x=>x.options?.some(o=>o.label==="Categoria nova")));
  const own=h.latest();const all=h.i(`cc:all:${own.id}`);await h.emit("interactionCreate",all);
  const detail=tree(check(all.edits[0])).find(x=>x.custom_id?.startsWith("cc:detail:live:"));assert.ok(detail);
  const open=h.i(detail.custom_id);await h.emit("interactionCreate",open);
  const details=text(open.edits[0]);assert.ok(details.includes("Descrição real de live"));assert.ok(details.includes("Resultado real de live"));
  assert.ok(details.includes("!live [argumento]"));
});

test("slash central acknowledges privately and third parties cannot alter a personal consultation",async t=>{
  const h=fixture(t);await h.emit("clientReady");
  const slash=h.i(null,USER,{slash:true});await h.emit("interactionCreate",slash);
  assert.equal(slash.deferFlags.flags,MessageFlags.Ephemeral);check(slash.edits[0]);
  const s=h.latest();const intruder=h.i(`cc:all:${s.id}`,ADMIN);await h.emit("interactionCreate",intruder);
  assert.equal(h.calls.denied.length,1);assert.equal(intruder.edits.length,0);
});

test("permission-filtered help hides internal commands and optionally shows restricted public definitions",async t=>{
  const h=fixture(t,{showRestricted:true});h.registry.register(h.def("secret","Oculta",{public:false}));
  h.registry.register(h.def("adminonly","Administração",{permissions:["ManageGuild"]}));await h.emit("clientReady");
  const m=h.message();await h.emit("messageCreate",m);const s=h.latest();
  const all=h.i(`cc:all:${s.id}`);await h.emit("interactionCreate",all);
  assert.equal(text(all.edits[0]).includes("secret"),false);
  const button=tree(check(all.edits[0])).find(x=>x.custom_id?.startsWith("cc:detail:adminonly:"));assert.ok(button);
  const info=h.i(button.custom_id);await h.emit("interactionCreate",info);
  assert.ok(text(info.edits[0]).includes("Você não tem a permissão exigida"));
  await h.emit("messageCreate",h.message("!adminonly"));assert.equal(h.calls.denied.length,1);
});

test("category grouping stays within 25 options and command pagination edits one message",async t=>{
  const h=fixture(t);for(let n=0;n<33;n++)h.registry.register(h.def(`real${n}`,`Categoria ${String(n).padStart(2,"0")}`));
  await h.emit("clientReady");const m=h.message();await h.emit("messageCreate",m);const s=h.latest();
  const menu=tree(check(m.replies[0])).find(x=>x.type===3);assert.equal(menu.options.length,25);
  const groups=h.i(`cc:groupnext:${s.id}`);await h.emit("interactionCreate",groups);
  assert.ok(tree(check(groups.edits[0])).find(x=>x.type===3).options.length<=25);
  const all=h.i(`cc:all:${s.id}`);await h.emit("interactionCreate",all);check(all.edits[0]);
  assert.ok(tree(check(all.edits[0])).some(x=>x.label==="1/9"));
  const next=h.i(`cc:next:${s.id}`);await h.emit("interactionCreate",next);
  assert.ok(tree(check(next.edits[0])).some(x=>x.label==="2/9"));assert.equal(next.replies.length+next.follows.length,0);
});

test("search combines with category; details back preserves query, category and page",async t=>{
  const h=fixture(t);for(let n=0;n<7;n++)h.registry.register(h.def(`found${n}`,"Busca"));
  h.registry.register(h.def("other","Outra"));await h.emit("clientReady");
  const m=h.message();await h.emit("messageCreate",m);const s=h.latest();
  const menu=tree(check(m.replies[0])).find(x=>x.type===3);
  const category=h.i(`cc:category:${s.id}`,USER,{values:[menu.options.find(o=>o.label==="Busca").value]});await h.emit("interactionCreate",category);
  const search=h.i(`cc:search:${s.id}`);await h.emit("interactionCreate",search);assert.ok(search.modal);
  const modal=h.i(`cc:modal:${s.id}`,USER,{query:"found"});await h.emit("interactionCreate",modal);
  assert.equal(modal.updated,true);assert.equal(text(modal.edits[0]).includes("other"),false);
  const next=h.i(`cc:next:${s.id}`);await h.emit("interactionCreate",next);
  const button=tree(check(next.edits[0])).find(x=>x.custom_id?.startsWith("cc:detail:"));
  const detail=h.i(button.custom_id);await h.emit("interactionCreate",detail);
  const back=h.i(`cc:back:${s.id}`);await h.emit("interactionCreate",back);
  assert.ok(text(back.edits[0]).includes("Pesquisa: found"));assert.ok(tree(check(back.edits[0])).some(x=>x.label==="2/2"));
});

test("permanent publication is admin-only and repeated publication edits instead of duplicating",async t=>{
  const h=fixture(t);await h.emit("clientReady");
  await h.emit("messageCreate",h.message("!painelcomandos"));assert.equal(h.calls.denied.length,1);assert.equal(h.calls.sent.length,0);
  await h.emit("messageCreate",h.message("!painelcomandos",ADMIN));
  await h.emit("messageCreate",h.message("!painelcomandos",ADMIN));
  assert.equal(h.calls.sent.length,1);assert.equal(h.calls.edits.length,1);assert.equal(h.center.store.panels().length,1);
});

test("permanent controls open a private personalized view without editing the shared panel",async t=>{
  const h=fixture(t);await h.emit("clientReady");await h.emit("messageCreate",h.message("!painelcomandos",ADMIN));
  const p=h.center.store.panels()[0];const click=h.i(`cc:all:${p.id}`);await h.emit("interactionCreate",click);
  assert.equal(click.deferFlags.flags,MessageFlags.Ephemeral);assert.equal(h.calls.edits.length,0);check(click.edits[0]);
  const search=h.i(`cc:search:${p.id}`);await h.emit("interactionCreate",search);assert.ok(search.modal);
  const id=search.modal.toJSON().custom_id.split(":")[2];
  const modal=h.i(`cc:modal:${id}`,USER,{query:"comandos"});await h.emit("interactionCreate",modal);
  assert.equal(modal.deferFlags.flags,MessageFlags.Ephemeral);assert.equal(h.calls.edits.length,0);
});

test("published messages refresh for additions, edits and removals, with no extra messages",async t=>{
  const h=fixture(t);await h.emit("clientReady");await h.emit("messageCreate",h.message("!painelcomandos",ADMIN));
  const original=h.center.store.panels()[0];
  h.registry.register(h.def("added","Categoria adicionada"));await h.center.refreshPanels();
  assert.equal(h.calls.sent.length,1);assert.equal(h.calls.edits.length,1);
  assert.notEqual(h.center.store.panels()[0].hash,original.hash);
  h.registry.register(h.def("added","Categoria modificada"));await h.center.refreshPanels();
  assert.equal(h.calls.edits.length,2);assert.ok(text(h.calls.edits[1]).includes("Comandos disponíveis"));
  h.registry.unregister("added");await h.center.refreshPanels();assert.equal(h.calls.edits.length,3);
  await h.center.refreshPanels();assert.equal(h.calls.edits.length,3);
  assert.equal(h.center.store.panels()[0].messageId,original.messageId);
});

test("registry change automatically refreshes existing panels after the debounce",async t=>{
  t.mock.timers.enable({apis:["setTimeout"]});
  const h=fixture(t);await h.emit("clientReady");await h.emit("messageCreate",h.message("!painelcomandos",ADMIN));
  h.registry.register(h.def("automatic","Automática"));
  t.mock.timers.tick(301);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(h.calls.edits.length,1);assert.equal(h.calls.sent.length,1);
   assert.equal(h.center.store.panels()[0].hash,h.center.publicationHash());
});

test("failed refresh logs without duplicating; a deleted message may be explicitly republished",async t=>{
  t.mock.method(console,"warn",()=>{});const h=fixture(t);await h.emit("clientReady");
  await h.emit("messageCreate",h.message("!painelcomandos",ADMIN));h.registry.register(h.def("new"));
  h.f.editError=new Error("No permission");await h.center.refreshPanels();assert.equal(h.calls.sent.length,1);
  h.f.editError=null;h.messages.clear();await h.center.refreshPanels();assert.equal(h.calls.sent.length,1);
  await h.emit("messageCreate",h.message("!painelcomandos",ADMIN));assert.equal(h.calls.sent.length,2);
  assert.equal(h.center.store.panels().length,1);
});

test("restart reads persisted publication IDs, hashes and slash ownership",async t=>{
  const db=new DatabaseSync(":memory:");t.after(()=>db.close());
  const first=fixture(t,{db,closeDb:false});await first.emit("clientReady");
  await first.emit("messageCreate",first.message("!painelcomandos",ADMIN));first.center.close();
  const panel=first.center.store.panels()[0];
  const second=fixture(t,{db,closeDb:false});
  let updated=0;second.client.channels.fetch=async()=>({guildId:G,isTextBased:()=>true,messages:{async fetch(id){assert.equal(id,panel.messageId);return {id,author:{id:BOT},async edit(p){check(p);updated++;}};}}});
  second.registry.register(second.def("restartnew","Nova"));await second.emit("clientReady");
  assert.equal(updated,1);assert.equal(second.center.store.panels()[0].messageId,panel.messageId);
  assert.equal(second.calls.sent.length,0);
});

test("startup removes only stale slash IDs previously owned by this registry",async t=>{
  const h=fixture(t);
  const retired="100000000000009999";
  h.db.prepare("INSERT INTO command_center_remote VALUES(?,?)").run("retired",retired);
  h.registry.attachRemoteStore(h.center.store.remoteAdapter());
  await h.emit("clientReady");
  assert.deepEqual(h.calls.deleted,[retired]);
  assert.equal(h.db.prepare("SELECT * FROM command_center_remote WHERE name='retired'").get(),undefined);
});

test("central matches config hierarchy and clears search without losing the category",async t=>{
  const h=fixture(t);h.registry.register(h.def("flor","Jardim"));await h.emit("clientReady");
  const m=h.message();await h.emit("messageCreate",m);const s=h.latest();
  assert.match(text(m.replies[0]),/^### 🌙 Central/);
  assert.doesNotMatch(text(m.replies[0]),/Painel ›/);
  const searchButton=tree(check(m.replies[0])).find(n=>n.label==="Pesquisar");
  assert.equal(searchButton.emoji.id,"1569941293323255889");
  assert.equal(searchButton.emoji.name,"1378484773118541847");
  const menu=tree(check(m.replies[0])).find(n=>n.type===3);
  await h.emit("interactionCreate",h.i(`cc:category:${s.id}`,USER,{values:[menu.options.find(o=>o.label==="Jardim").value]}));
  const search=h.i(`cc:modal:${s.id}`,USER,{query:"ausente"});await h.emit("interactionCreate",search);
  assert.match(text(search.edits[0]),/Tente outro termo/);
  const clear=tree(check(search.edits[0])).find(n=>n.label==="Limpar pesquisa");assert.ok(clear);
  const click=h.i(clear.custom_id);await h.emit("interactionCreate",click);
  assert.equal(h.latest().category,"Jardim");assert.equal(h.latest().query,"");
  assert.match(text(click.edits[0]),/Descrição real de flor/);
});

test("startup refreshes a published panel from the previous visual version in place",async t=>{
  const h=fixture(t);await h.emit("clientReady");
  await h.emit("messageCreate",h.message("!painelcomandos",ADMIN));
  const panel=h.center.store.panels()[0];
  h.center.store.savePanel(panel.id,panel.messageId,h.registry.hash());
  await h.center.refreshPanels();
  assert.equal(h.calls.sent.length,1);assert.equal(h.calls.edits.length,1);
  assert.match(text(h.calls.edits[0]),/Seu cantinho/);
  assert.equal(h.center.store.panels()[0].hash,h.center.publicationHash());
});
