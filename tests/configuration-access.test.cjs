const test=require("node:test"),assert=require("node:assert/strict");
const {DatabaseSync}=require("node:sqlite");
const {EventEmitter}=require("node:events");
const d=require("discord.js");
const {getCommandRegistry}=require("../command-system/registry");
const {ConfigStore}=require("../configuration/store");
const {AccessService,LEVEL,DURATIONS}=require("../configuration/access");
const install=require("../configuration");
const G="100000000000000001",OWNER="100000000000000002",USER="100000000000000003",ROLE="100000000000000004",BOT="100000000000000005",C="100000000000000006";
const SYSTEMS=[{id:"tickets",label:"Tickets",description:"Atendimento",commands:[],status:()=>true},{id:"logs",label:"Logs",description:"Registros",commands:[],status:()=>true}];

function serviceFixture(t){
  const db=new DatabaseSync(":memory:"),store=new ConfigStore(db),access=new AccessService(store,()=>SYSTEMS);
  t.after(()=>db.close());
  return {db,store,access};
}
function fixture(t){
  const db=new DatabaseSync(":memory:"),client=new EventEmitter();client.setMaxListeners(32);
  client.user={id:BOT,username:"Lumiya",displayAvatarURL:()=>"https://cdn.discordapp.com/embed/avatars/0.png"};
  client.emojis={cache:new d.Collection()};client.application={commands:{create:async()=>({id:"1"})}};
  const commands=getCommandRegistry(client);
  for(const [name,category]of [["ticketconfig","Suporte"],["gestao-tickets","Suporte"],["limitebans","Moderação"]])
    commands.register({name,description:`Gerencia ${name}.`,category,public:true,prefix:{trigger:`!${name}`,execute:async()=>{}}});
  const guild={id:G,name:"mds",ownerId:OWNER,memberCount:9,available:true,
    iconURL:()=>"https://cdn.discordapp.com/embed/avatars/1.png",emojis:{cache:new d.Collection()},
    roles:{cache:new d.Collection([[ROLE,{id:ROLE,name:"Equipe"}]])}};
  const channel={id:C,guildId:G,guild,name:"geral",type:d.ChannelType.GuildText,
    permissionsFor:()=>new d.PermissionsBitField(d.PermissionsBitField.All),
    messages:{fetch:async()=>{throw Object.assign(new Error("missing"),{code:10008});}},send:async()=>({id:"msg"})};
  guild.channels={cache:new d.Collection([[C,channel]]),fetch:async()=>channel};
  client.guilds={cache:new d.Collection([[G,guild]])};client.channels={fetch:async()=>channel};
  let actorPermissions=d.PermissionsBitField.All;
  const botMember={id:BOT,permissions:new d.PermissionsBitField(d.PermissionsBitField.All)};
  guild.members={me:botMember,fetchMe:async()=>botMember,fetch:async id=>{
    const userId=typeof id==="string"?id:id.user;
    const roleIds=userId===USER?[ROLE]:[];
    return {id:userId,guild,user:{id:userId},permissions:new d.PermissionsBitField(actorPermissions),
      roles:{cache:new d.Collection(roleIds.map(roleId=>[roleId,guild.roles.cache.get(roleId)]))}};
  }};
  const hub=install({client,commands,db,definitions:[],apis:{logs:{store:{get:()=>null},kinds:{general:"logs"},configure(){},ensureGuild(){}}}});
  t.after(()=>{hub.close();db.close();});
  let seq=0;
  function interaction(userId=OWNER,extra={}){
    const values={};
    return {id:String(200000000000000000n+BigInt(seq++)),guild,guildId:G,channel,user:{id:userId},
      member:{id:userId,roles:{cache:new d.Collection(userId===USER?[[ROLE,guild.roles.cache.get(ROLE)]]:[])}},
      inGuild:()=>true,isButton:()=>true,values:[],deferred:false,replied:false,replies:[],follows:[],edits:[],modal:null,
      fields:{
        getTextInputValue:key=>extra.inputs?.[key]||"",
        getStringSelectValues:key=>values[key]||extra.selects?.[key]||[],
        getSelectedUsers:key=>new Map((extra.users?.[key]||[]).map(id=>[id,id])),
        getSelectedRoles:key=>new Map((extra.roles?.[key]||[]).map(id=>[id,id]))
      },
      async deferReply(){this.deferred=true;},async deferUpdate(){this.deferred=true;},
      async reply(p){this.replied=true;this.replies.push(p);return {edit:async()=>{}};},
      async followUp(p){this.follows.push(p);return {edit:async()=>{}};},
      async editReply(p){this.edits.push(p);return {edit:async()=>{}};},
      async showModal(m){this.modal=m.toJSON();this.replied=true;},...extra};
  }
  async function run(session,action,extra={}){
    const current=hub.store.getSession(session.id,G,session.userId);
    const i=interaction(session.userId,{customId:`lc:${action}:${session.id}:${current.revision}`,...extra});
    await hub.controller.handle(i);return i;
  }
  const session=(userId=OWNER,data={})=>hub.store.session(G,userId,data);
  return {db,client,commands,guild,channel,hub,interaction,run,session,
    setPermissions:permissions=>{actorPermissions=permissions;}};
}
const textOf=payload=>require("../configuration/ui").flat(payload.components).filter(c=>c.type===10).map(c=>c.content).join("\n");

test("read-only central access cannot configure a function, publish panels or activate logs",async t=>{
  const f=fixture(t);
  f.setPermissions([]);
  f.hub.access.grant(G,OWNER,OWNER,{subjectType:"user",subjectId:USER,level:1,permissions:{"*":1}});
  const s=f.session(USER,{view:"system",systemId:"tickets"});
  for(const action of ["systemSettings","systemPublish","systemEditPanels","provisionLogs","activateLogs"]){
    const i=await f.run(s,action);
    assert.equal(i.edits.length,0,action);
    assert.ok(i.follows.length||i.replies.length,action);
  }
  const launch=await f.run(s,"launch",{values:["ticketconfig"]});
  assert.equal(launch.edits.length,0);
});

test("forged function navigation cannot expose a system outside an individual grant",async t=>{
  const f=fixture(t);
  f.setPermissions([]);
  f.hub.access.grant(G,OWNER,OWNER,{subjectType:"user",subjectId:USER,level:1,permissions:{"system:tickets":1}});
  const s=f.session(USER,{view:"home"});
  const blocked=await f.run(s,"category",{values:["moderation"]});
  assert.equal(blocked.edits.length,0);
  const allowed=await f.run(s,"category",{values:["tickets"]});
  assert.equal(allowed.edits.length,1);
  assert.match(textOf(allowed.edits[0]),/Tickets/);
});

test("owner and native administrators/moderators can use /config but not manage access",()=>{
  const f=serviceFixture(test);
  const owner=f.access.effective(G,OWNER,[],OWNER);
  assert.equal(owner.owner,true);assert.equal(owner.levels["access.manage"],2);assert.equal(owner.levels["system:tickets"],2);
  for(const flag of ["Administrator","ManageGuild","ManageRoles","ManageMessages","BanMembers","KickMembers","ModerateMembers"]){
    const permissions=new d.PermissionsBitField([d.PermissionFlagsBits[flag]]);
    assert.equal(f.access.isPrivileged(permissions),true,flag);
    const levels=f.access.effective(G,USER,[],OWNER,true).levels;
    assert.equal(levels["system:tickets"],2,flag);
    assert.equal(levels["access.manage"],0,flag);
  }
  const regular=f.access.effective(G,USER,[],OWNER,false);
  assert.equal(regular.levels.view,undefined);
  assert.equal(f.access.can(G,USER,[],OWNER,"view"),false);
});

test("role and individual grants combine without granting access management",()=>{
  const {access}=serviceFixture(test);
  access.grant(G,OWNER,OWNER,{subjectType:"role",subjectId:ROLE,level:1,permissions:{"system:tickets":1},expiresAt:null,reason:"equipe"});
  access.grant(G,OWNER,OWNER,{subjectType:"user",subjectId:USER,level:2,permissions:{"system:logs":2},expiresAt:null,reason:"analista"});
  const levels=access.effective(G,USER,[ROLE],OWNER).levels;
  assert.equal(levels["system:tickets"],1);
  assert.equal(levels["system:logs"],2);
  assert.equal(levels.view,2);
  assert.equal(levels["access.manage"],0);
  assert.equal(access.can(G,USER,[ROLE],OWNER,"access.manage"),false);
});

test("real command gate, opening and navigation accept each native staff permission",async t=>{
  const f=fixture(t),command=f.commands.commands.get("config");
  for(const flag of [
    "Administrator","ManageGuild","ManageRoles","ManageMessages","BanMembers","KickMembers","ModerateMembers",
    "ManageChannels","ManageThreads","MuteMembers","DeafenMembers","MoveMembers"
  ]){
    f.setPermissions([d.PermissionFlagsBits[flag]]);
    const actor=await f.guild.members.fetch(USER);
    assert.equal(f.commands.canUse(command,actor),true,flag);
    const i=f.interaction(USER,{member:actor});
    await command.slash.execute(i);
    assert.equal(i.edits.length,1,flag);
    assert.match(textOf(i.edits[0]),/Funções|Sistemas|Lumiya/);
    const s=f.session(USER,{view:"home"});
    const navigation=await f.run(s,"functions",{member:actor});
    assert.equal(navigation.follows.length,0,flag);
    assert.equal(navigation.edits.length,1,flag);
    const denied=await f.run(s,"access",{member:actor});
    assert.match(textOf(denied.follows[0]),/permissão para acessar/,flag);
  }
});

test("command gate rejects ordinary members, honors role grants and reflects revoked staff permissions",async t=>{
  const f=fixture(t),command=f.commands.commands.get("config");
  f.setPermissions([]);
  let actor=await f.guild.members.fetch(USER);
  assert.equal(f.commands.canUse(command,actor),false);
  f.hub.access.grant(G,OWNER,OWNER,{subjectType:"role",subjectId:ROLE,level:1,permissions:{"system:tickets":1}});
  assert.equal(f.commands.canUse(command,actor),true);
  f.hub.access.revoke(G,OWNER,OWNER,"role",ROLE);
  assert.equal(f.commands.canUse(command,actor),false);
  f.setPermissions([d.PermissionFlagsBits.ManageMessages]);
  actor=await f.guild.members.fetch(USER);
  assert.equal(f.commands.canUse(command,actor),true);
  const session=f.session(USER,{view:"home"});
  f.setPermissions([]);
  const denied=await f.run(session,"functions",{member:actor});
  assert.match(textOf(denied.follows[0]),/permissão para acessar/);
});

test("only the owner can grant or revoke; wildcard cannot grant access management",()=>{
  const {access}=serviceFixture(test);
  assert.throws(()=>access.grant(G,USER,OWNER,{subjectType:"user",subjectId:USER,level:2,permissions:{"*":2}}),/proprietário/);
  access.grant(G,OWNER,OWNER,{subjectType:"user",subjectId:USER,level:2,permissions:{"*":2,"access.manage":2}});
  const row=access.store.accessRow(G,"user",USER),permissions=JSON.parse(row.permissions);
  assert.equal(permissions["access.manage"],undefined);
  assert.equal(permissions.view,2);
  assert.throws(()=>access.revoke(G,USER,OWNER,"user",USER),/proprietário/);
  assert.ok(access.revoke(G,OWNER,OWNER,"user",USER));
  assert.equal(access.store.accessRow(G,"user",USER),undefined);
});

test("temporary grants expire automatically and are logged only once after reopening",t=>{
  const base=serviceFixture(t),{store}=base;
  let access=base.access;
  const expiresAt=Date.now()-1000;
  access.grant(G,OWNER,OWNER,{subjectType:"user",subjectId:USER,level:1,permissions:{"*":1},expiresAt,reason:"temporário"});
  assert.equal(access.can(G,USER,[],OWNER,"view"),false);
  assert.equal(store.accessHistory(G).filter(row=>row.action==="access.expired").length,1);
  access=null;
  const reopened=new AccessService(store,()=>SYSTEMS);
  reopened.cleanup(G);
  assert.equal(store.accessHistory(G).filter(row=>row.action==="access.expired").length,1);
  assert.equal(DURATIONS.month>0,true);
});

test("revoking access invalidates previously opened central sessions",()=>{
  const f=fixture(test);
  f.hub.access.grant(G,OWNER,OWNER,{subjectType:"user",subjectId:USER,level:2,permissions:{"*":2}});
  const session=f.session(USER,{view:"home"});
  assert.equal(f.hub.store.getSession(session.id,G,USER).data.view,"home");
  f.hub.access.revoke(G,OWNER,OWNER,"user",USER);
  assert.throws(()=>f.hub.store.getSession(session.id,G,USER),/expirou/);
});

test("access panel follows /config structure and opens prefilled native forms",async()=>{
  const f=fixture(test),s=f.session(OWNER,{view:"access"});
  let payload=await f.hub.controller.view(s,f.interaction());
  let text=textOf(payload);
  assert.doesNotMatch(text,/Painel ›/);
  assert.match(text,/Estado do acesso/);
  assert.match(text,/acesso permanente/);
  assert.match(text,/permissões de administração, gestão ou moderação do Discord tem acesso automático/);
  const controls=require("../configuration/ui").flat(payload.components);
  for(const label of ["Visão geral","Acesso por cargo","Acesso individual","Permissões específicas","Histórico de alterações"])
    assert.ok(JSON.stringify(payload).includes(label),label);
  assert.ok(controls.some(c=>c.emoji?.name==="👥"));
  assert.ok(controls.some(c=>c.emoji?.name==="➕"));
  const roleModal=await f.run(s,"accessRoleForm");
  assert.equal(roleModal.modal.title,"Gerenciar acesso por cargo");
  assert.equal(roleModal.modal.components[0].component.type,6);
  assert.equal(roleModal.modal.components[1].component.options[0].value,"full");
  const userModal=await f.run(s,"accessUserForm");
  assert.equal(userModal.modal.components[0].component.type,5);
  assert.ok(userModal.modal.components.some(c=>c.component.custom_id==="duration"));
});

test("grant, edit and revoke flows save history and update the panel",async()=>{
  const f=fixture(test),s=f.session(OWNER,{view:"accessUsers"});
  await f.run(s,"submitAccessUser",{users:{members:[USER]},selects:{type:["custom"],managePerms:["system:tickets"],viewPerms:["system:logs"]},inputs:{reason:"Teste ♡"}});
  let row=f.hub.store.accessRow(G,"user",USER);
  assert.ok(row);assert.equal(row.level,2);
  assert.deepEqual(JSON.parse(row.permissions),{ "system:tickets":2,"system:logs":1,"view":2 });
  await f.run(s,"accessRecord",{values:[`user:${USER}`]});
  await f.run(s,"accessEdit");
  await f.run(s,"submitAccessEdit",{selects:{type:["view"],managePerms:[],viewPerms:["system:tickets"]},inputs:{reason:""}});
  row=f.hub.store.accessRow(G,"user",USER);assert.equal(row.level,1);
  await f.run(s,"accessRevoke");
  await f.run(s,"accessConfirm");
  assert.equal(f.hub.store.accessRow(G,"user",USER),undefined);
  assert.ok(f.hub.store.accessHistory(G).some(entry=>entry.action==="access.revoked"));
});

test("non-owner cannot open access controls even with granted view permission",async()=>{
  const f=fixture(test);
  f.hub.access.grant(G,OWNER,OWNER,{subjectType:"user",subjectId:USER,level:2,permissions:{"*":2}});
  const s=f.session(USER,{view:"home"});
  const denied=await f.run(s,"access");
  assert.match(textOf(denied.follows[0]),/permissão para acessar/);
  assert.equal(f.hub.store.accessRows(G).length,1);
});

test("central hides systems the user cannot view",()=>{
  const f=fixture(test),systemList=f.hub.systems();
  f.hub.access.grant(G,OWNER,OWNER,{subjectType:"role",subjectId:ROLE,level:1,permissions:{"system:tickets":1}});
  const visible=f.hub.access.visibleSystems(G,USER,[ROLE],OWNER);
  assert.ok(visible.some(system=>system.id==="tickets"));
  assert.ok(!visible.some(system=>system.id==="logs"));
});
