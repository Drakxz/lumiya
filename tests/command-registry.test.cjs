const test=require("node:test");
const assert=require("node:assert/strict");
const {EventEmitter}=require("node:events");
const fs=require("node:fs");
const os=require("node:os");
const path=require("node:path");
const {PermissionsBitField,PermissionFlagsBits,SlashCommandBuilder}=require("discord.js");
const {getCommandRegistry}=require("../command-system/registry");

function fixture() {
  const client=new EventEmitter(),calls={executed:[],created:[],deleted:[],denied:[]};client.user={id:"bot"};
  client.application={commands:{async create(data){calls.created.push(data);return {id:String(100000000000000000n+BigInt(calls.created.length))};},async delete(id){calls.deleted.push(id);}}};
  const registry=getCommandRegistry(client,{deny:async origin=>{calls.denied.push(origin);}});
  const member=admin=>({permissions:new PermissionsBitField(admin?[PermissionFlagsBits.ManageGuild]:[])});
  const emit=async(event,...args)=>{for(const fn of client.listeners(event))await fn(...args);};
  function definition(name="real",category="Geral") {
    return {name,category,description:`Descrição de ${name}`,prefix:{trigger:`!${name}`,execute:async()=>{calls.executed.push(name);}}};
  }
  return {client,calls,registry,member,emit,definition};
}
test("private central messages do not create cleanup timers or permanent-preservation entries",async t=>{
  t.mock.timers.enable({apis:["setTimeout"]});
  const f=fixture(),message={id:"private",guildId:"guild",channelId:"channel",author:{id:"bot"},flags:{bitfield:64}};
  f.registry.preserveMessage(message);
  await f.emit("messageCreate",message);
  assert.equal(f.registry.preservedBotMessages.has(message.id),false);
  assert.equal(f.registry.botMessageTimers.size,0);
});

test("bot messages expire after 30 seconds idle, interactions reset the timer and pinned messages survive",async t=>{
  t.mock.timers.enable({apis:["setTimeout"]});
  const f=fixture();let deleted=0;
  const message={id:"panel",guildId:"guild",channelId:"channel",author:{id:"bot"},pinned:false,
    channel:{messages:{cache:new Map(),async fetch(){return message;}}},async delete(){deleted++;}};
  await f.emit("messageCreate",message);
  t.mock.timers.tick(29000);assert.equal(deleted,0);
  await f.emit("interactionCreate",{message,inGuild:()=>false});
  t.mock.timers.tick(29000);assert.equal(deleted,0);
  message.pinned=true;t.mock.timers.tick(1000);assert.equal(deleted,0);
  message.pinned=false;await f.emit("messageCreate",message);t.mock.timers.tick(30000);assert.equal(deleted,1);
});

test("explicitly preserved bot panels never receive an inactivity deletion timer",async t=>{
  t.mock.timers.enable({apis:["setTimeout"]});
  const f=fixture();let deleted=0;
  const message={id:"persistent-panel",guildId:"guild",channelId:"channel",author:{id:"bot"},pinned:false,
    channel:{messages:{cache:new Map(),async fetch(){return message;}}},async delete(){deleted++;}};
  f.registry.preserveMessage(message);
  await f.emit("messageCreate",message);t.mock.timers.tick(60000);
  assert.equal(deleted,0);
});

for(const [type,custom_id] of [[3,"ticket-support"],[2,"ticket-migration"],[2,"ticket-instagram"],[2,"up:claim"],[2,"up:mine"],[2,"up:levels"]]){
  test(`public entry ${custom_id} survives interactions after a restart without prior preservation`,async t=>{
    t.mock.timers.enable({apis:["setTimeout"]});
    const f=fixture();let deleted=0;
    const message={id:"old-entry",guildId:"guild",channelId:"support",author:{id:"bot"},pinned:false,
      components:[{type:17,components:[{type:1,components:[{type,custom_id}]}]}],
      channel:{messages:{cache:new Map(),async fetch(){return message;}}},async delete(){deleted++;}};
    await f.emit("interactionCreate",{message,inGuild:()=>false});
    t.mock.timers.tick(60000);
    assert.equal(deleted,0);
    assert.equal(f.registry.botMessageTimers.size,0);
    assert.ok(f.registry.preservedBotMessages.has(message.id));
  });
}

for(const custom_id of ["ticket-support","up:claim"]){
test(`a partial message resolved as ${custom_id} entry panel is not deleted`,async t=>{
  t.mock.timers.enable({apis:["setTimeout"]});
  const f=fixture();let deleted=0;
  const current={id:"entry",channelId:"support",pinned:false,
    components:[{type:1,components:[{type:custom_id==="ticket-support"?3:2,custom_id}]}],async delete(){deleted++;}};
  await f.emit("messageCreate",{id:"entry",guildId:"guild",channelId:"support",author:{id:"bot"},pinned:false,
    channel:{messages:{cache:new Map(),async fetch(){return current;}}}});
  t.mock.timers.tick(30000);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(deleted,0);
  assert.ok(f.registry.preservedBotMessages.has("entry"));
});
}

test("temporary UP session controls still expire",async t=>{
  t.mock.timers.enable({apis:["setTimeout"]});
  const f=fixture();let deleted=0;
  const message={id:"up-session",guildId:"guild",channelId:"channel",author:{id:"bot"},pinned:false,
    components:[{type:1,components:[{type:2,custom_id:"up:mine:session-id"}]}],
    channel:{messages:{cache:new Map(),async fetch(){return message;}}},async delete(){deleted++;}};
  await f.emit("messageCreate",message);
  t.mock.timers.tick(30000);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(deleted,1);
});

test("ticket close controls are not mistaken for the permanent opening panel",async t=>{
  t.mock.timers.enable({apis:["setTimeout"]});
  const f=fixture();let deleted=0;
  const message={id:"closing-ticket",guildId:"guild",channelId:"thread",author:{id:"bot"},pinned:false,
    components:[{type:1,components:[{type:2,custom_id:"ticket-close"}]}],
    channel:{messages:{cache:new Map(),async fetch(){return message;}}},async delete(){deleted++;}};
  await f.emit("messageCreate",message);
  t.mock.timers.tick(30000);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(deleted,1);
});
test("manual announcement preservation is checked again before deletion",async t=>{
  t.mock.timers.enable({apis:["setTimeout"]});
  const original=fs.readFileSync;let saved=[];
  t.mock.method(fs,"readFileSync",function(file,...args){
    if(String(file).endsWith("preserved-messages.json"))return JSON.stringify(saved);
    return original.call(this,file,...args);
  });
  const f=fixture();let deleted=0;
  const message={id:"manual",guildId:"guild",channelId:"channel",author:{id:"bot"},pinned:false,
    channel:{messages:{cache:new Map(),async fetch(){return message;}}},async delete(){deleted++;}};
  await f.emit("messageCreate",message);
  saved=["manual"];
  t.mock.timers.tick(30000);
  assert.equal(deleted,0);
  await f.emit("messageCreate",message);
  assert.equal(f.registry.botMessageTimers.size,0);
});

test("bot messages in preserved ticket channels never receive an inactivity deletion timer",async t=>{
  t.mock.timers.enable({apis:["setTimeout"]});const f=fixture();let deleted=0;
  f.registry.preserveChannel("support-thread");
  const message={id:"ticket-message",guildId:"guild",channelId:"support-thread",author:{id:"bot"},pinned:false,
    channel:{messages:{cache:new Map(),async fetch(){return message;}}},async delete(){deleted++;}};
  await f.emit("messageCreate",message);t.mock.timers.tick(60000);assert.equal(deleted,0);assert.equal(f.registry.botMessageTimers.size,0);
});

test("registered command is the same source for execution, metadata, aliases and categories",async()=>{
  const f=fixture();const command=f.definition();command.prefix.aliases=["!alias"];
  f.registry.register(command);
  const invocation={guild:{},author:{bot:false},content:"!alias",member:f.member(false),deleted:0,async delete(){this.deleted++;}};
  await f.emit("messageCreate",invocation);
  assert.equal(invocation.deleted,1,"prefix command invocation should be deleted");
  assert.deepEqual(f.calls.executed,["real"]);assert.equal(f.registry.catalog().length,1);
  assert.equal(f.registry.catalog()[0].category,"Geral");
  await f.emit("messageCreate",{guild:{},author:{bot:false},content:"!real extra",member:f.member(false)});
  assert.equal(f.calls.executed.length,2);
  assert.throws(()=>f.registry.register({...f.definition("collision"),prefix:{trigger:"!alias",execute:async()=>{}}}),/registrado/);
});

test("a prefix command may preserve its invocation message",async()=>{
  const f=fixture(),command=f.definition("preserved");command.prefix.deleteMessage=false;f.registry.register(command);
  const invocation={guild:{},author:{bot:false},content:"!preserved",member:f.member(false),deleted:0,async delete(){this.deleted++;}};
  await f.emit("messageCreate",invocation);
  assert.equal(invocation.deleted,0);
  assert.deepEqual(f.calls.executed,["preserved"]);
});

test("permissions govern both catalog visibility and actual command dispatch",async()=>{
  const f=fixture();f.registry.register({...f.definition("admin"),permissions:["ManageGuild"]});
  assert.equal(f.registry.catalog({member:f.member(false)}).length,0);
  assert.equal(f.registry.catalog({member:f.member(true)}).length,1);
  assert.equal(f.registry.catalog({member:f.member(false),includeRestricted:true}).length,1);
  await f.emit("messageCreate",{guild:{},author:{bot:false},content:"!admin",member:f.member(false)});
  assert.equal(f.calls.denied.length,1);assert.equal(f.calls.executed.length,0);
  await f.emit("messageCreate",{guild:{},author:{bot:false},content:"!admin",member:f.member(true)});
  assert.equal(f.calls.executed.length,1);
});

test("prefix and slash count once; unavailable slash forms are not advertised",async()=>{
  const f=fixture();f.registry.register({...f.definition("both"),slash:{data:new SlashCommandBuilder().setName("both").setDescription("Consulta real"),execute:async()=>{f.calls.executed.push("slash");}}});
  f.registry.register({name:"slashonly",category:"Geral",description:"Somente slash",slash:{data:new SlashCommandBuilder().setName("slashonly").setDescription("Slash real"),execute:async()=>{}}});
  assert.equal(f.registry.catalog().length,1);assert.equal(f.registry.forms(f.registry.commands.get("both")).length,1);
  await f.emit("clientReady");
  assert.equal(f.registry.catalog().length,2);assert.equal(f.registry.forms(f.registry.commands.get("both")).length,2);
  await f.emit("interactionCreate",{inGuild:()=>true,isChatInputCommand:()=>true,commandName:"both",member:f.member(false)});
  assert.ok(f.calls.executed.includes("slash"));
});

test("failed slash registration is excluded without hiding a working prefix",async t=>{
  t.mock.method(console,"warn",()=>{});const f=fixture();
  f.client.application.commands.create=async()=>{throw new Error("Unavailable");};
  const slash={data:new SlashCommandBuilder().setName("real").setDescription("Real"),execute:async()=>{}};
  f.registry.register({...f.definition(),slash});await f.emit("clientReady");
  assert.equal(f.registry.catalog().length,1);assert.equal(f.registry.forms(f.registry.commands.get("real")).length,1);
});

test("internal definitions are never exposed, even to admins or permanent panels",()=>{
  const f=fixture();f.registry.register({...f.definition("internal"),public:false});
  assert.equal(f.registry.catalog({all:true}).length,0);
  assert.equal(f.registry.catalog({member:f.member(true),includeRestricted:true}).length,0);
});

test("all executable public commands remain discoverable with restricted entries marked",()=>{
  const f=fixture();f.registry.register({...f.definition("admin"),permissions:["ManageGuild"]});
  const normal=f.registry.catalog({member:f.member(false)});
  const authorized=f.registry.catalog({member:f.member(true)});
  assert.equal(normal.some(c=>c.name==="admin"),false);
  assert.equal(authorized.some(c=>c.name==="admin"),true);
  assert.equal(f.registry.catalog({member:f.member(false),includeRestricted:true}).some(c=>c.name==="admin"),true);
});

test("register/update/unregister changes hashes and immediately changes execution",async()=>{
  const f=fixture();f.registry.register(f.definition());const first=f.registry.hash();
  f.registry.register({...f.definition(),description:"Descrição modificada",category:"Nova categoria"});
  assert.notEqual(first,f.registry.hash());assert.equal(f.registry.catalog()[0].category,"Nova categoria");
  f.registry.unregister("real");
  await f.emit("messageCreate",{guild:{},author:{bot:false},content:"!real",member:f.member(false)});
  assert.equal(f.calls.executed.length,0);assert.equal(f.registry.catalog().length,0);
});

test("runtime additions synchronize slash and owned removals do not delete unrelated application commands",async()=>{
  const f=fixture();await f.emit("clientReady");
  f.registry.register({...f.definition("runtime"),slash:{data:new SlashCommandBuilder().setName("runtime").setDescription("Runtime"),execute:async()=>{}}});
  await f.registry.syncSlash();
  assert.equal(f.registry.commands.get("runtime").slash.status,"registered");
  const id=f.registry.remote.get("runtime");f.registry.unregister("runtime");await f.registry.syncSlash();
  assert.deepEqual(f.calls.deleted,[id]);
});

test("directory discovery/reload adds, modifies and removes commands without touching the center",async t=>{
  const base=process.platform==="win32"?path.join(os.tmpdir(),"opencode"):os.tmpdir();fs.mkdirSync(base,{recursive:true});
  const dir=fs.mkdtempSync(path.join(base,"command-loader-"));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const f=fixture();f.registry.register(f.definition("builtin"));
  const file=path.join(dir,"loaded.cjs");
  const write=category=>fs.writeFileSync(file,`module.exports={name:'loaded',description:'Comando carregado',category:'${category}',prefix:{trigger:'!loaded',execute:async message=>message.marker.push('ok')}};`);
  write("Categoria nova");f.registry.loadDirectory(dir);
  const marker=[];await f.emit("messageCreate",{guild:{},author:{bot:false},content:"!loaded",member:f.member(false),marker});
  assert.deepEqual(marker,["ok"]);assert.equal(f.registry.catalog().length,2);
  write("Categoria alterada");f.registry.loadDirectory(dir);
  assert.equal(f.registry.commands.get("loaded").category,"Categoria alterada");
  fs.writeFileSync(file,"module.exports={name:'broken'}");
  assert.throws(()=>f.registry.loadDirectory(dir));assert.ok(f.registry.commands.has("loaded"));
  fs.unlinkSync(file);f.registry.loadDirectory(dir);
  assert.equal(f.registry.commands.has("loaded"),false);assert.equal(f.registry.commands.has("builtin"),true);
});

test("exact and case-sensitive modes preserve original command matching",async()=>{
  const f=fixture();f.registry.register({...f.definition("cl"),prefix:{trigger:"cl",exact:true,caseInsensitive:true,execute:async()=>{f.calls.executed.push("cl");}}});
  for(const content of [" cl ","CL","Cl"])await f.emit("messageCreate",{guild:{},author:{bot:false},content,member:f.member(false)});
  for(const content of ["clear","cl teste","meu cl"])await f.emit("messageCreate",{guild:{},author:{bot:false},content,member:f.member(false)});
  assert.equal(f.calls.executed.length,3);
});
