const test=require("node:test");
const assert=require("node:assert/strict");
const {Collection,PermissionsBitField,PermissionFlagsBits}=require("discord.js");
const {VoiceHoursStore}=require("../voice-hours/store");
const {UpEngine,validateRole}=require("../up/engine");
const G="100000000000000001",U="100000000000000002",B="100000000000000003";
const R=["100000000000000010","100000000000000011","100000000000000012","100000000000000013"];
const {weekStart,WEEK_MS}=require("../voice-hours/time");

test("weekly maintenance validates configuration and persists per role",t=>{
  const f=fixture(t);
  const revision=f.db.config(G).revision;
  assert.throws(()=>f.db.saveMaintenance(G,R[1],-1,revision),/válidas/);
  f.db.saveMaintenance(G,R[1],3600000,revision);
  assert.equal(f.db.maintenance(G,R[1]).requiredMs,3600000);
  assert.throws(()=>f.db.saveMaintenance(G,R[1],0,revision),/mudou/);
  f.db.saveMaintenance(G,R[1],0,f.db.config(G).revision);
  assert.equal(f.db.maintenance(G,R[1]).requiredMs,0);
});

async function maintainedFixture(t) {
  const f=fixture(t);f.voice();await f.engine.claim(f.guild,U,R[0]);
  f.tick(30000);await f.engine.advance(G,U);f.voice(null);
  f.db.saveMaintenance(G,R[2],3600000,f.db.config(G).revision);
  const first=weekStart(f.now())+WEEK_MS;
  f.tick(first-f.now());
  f.first=first;return f;
}

test("first partial week is exempt; missed full week demotes once without immediate promotion",async t=>{
  const f=await maintainedFixture(t);
  await f.engine.advance(G,U);assert.ok(f.owned.has(R[2]));
  f.tick(WEEK_MS);await f.engine.advance(G,U);
  assert.deepEqual([...f.owned],[R[1]]);
  assert.match(f.calls.changes.at(-1).reason,/Meta semanal/);
  const count=f.calls.changes.length;
  await f.engine.advance(G,U);assert.equal(f.calls.changes.length,count);
  assert.equal(f.hours.stats(G,U).totalCallMs,30000);
  f.tick(WEEK_MS);await f.engine.advance(G,U);
  assert.deepEqual([...f.owned],[R[1]]);
});

test("maintenance includes muted hours and accepts an exactly met weekly goal",async t=>{
  const f=await maintainedFixture(t);
  f.voice("voice",true);f.tick(3600000);f.voice(null);
  f.tick(f.first+WEEK_MS-f.now());await f.engine.advance(G,U);
  assert.ok(f.owned.has(R[2]));
  assert.equal(f.db.maintenanceState(G,U).checkedUntil,f.first+WEEK_MS);
});

test("weekly downgrade survives a Discord removal failure and retries with its audit reason",async t=>{
  const f=await maintainedFixture(t);f.tick(WEEK_MS);f.failRemove=true;
  await assert.rejects(f.engine.advance(G,U),/Simulated/);
  assert.ok(f.db.pending(G,U));
  f.failRemove=false;
  const restarted=new UpEngine({client:f.client,hours:f.hours,history:f.history,notify:async()=>{}});
  await restarted.advance(G,U);
  assert.deepEqual([...f.owned],[R[1]]);
  assert.equal(f.db.pending(G,U),undefined);
  assert.match(f.calls.changes.at(-1).reason,/Meta semanal/);
});

function fixture(t) {
  let now=Date.parse("2026-11-11T15:00:00Z");
  t.mock.method(Date,"now",()=>now);
  const hours=new VoiceHoursStore(":memory:");
  const calls={changes:[],notifications:[],fetches:0};
  const owned=new Set();
  const guild={id:G,ownerId:"owner",available:true,afkChannelId:"afk",roles:{cache:new Collection()},members:{}};
  R.forEach((id,n)=>guild.roles.cache.set(id,{id,name:`Level ${n}`,position:n+1,managed:false,permissions:new PermissionsBitField()}));
  guild.roles.fetch=async id=>guild.roles.cache.get(id)||null;
  guild.members.me={permissions:new PermissionsBitField([PermissionFlagsBits.ManageRoles]),roles:{highest:{position:100}}};
  const f={now:()=>now,tick:ms=>{now+=ms;},hours,guild,owned,calls,failAdd:false,failRemove:false,failNotify:false};
  function member() {
    return {id:U,user:{id:U,bot:false},roles:{cache:new Collection([...owned].map(id=>[id,guild.roles.cache.get(id)])),
      async add(role){if(f.failAdd)throw new Error("Simulated add failure");owned.add(role.id);return member();},
      async remove(role){if(f.failRemove)throw new Error("Simulated remove failure");owned.delete(role.id);return member();}}};
  }
  guild.members.fetch=async()=>{calls.fetches++;return member();};
  const history={async alterarCargo(request){
    const has=owned.has(request.cargo.id);
    if(has===(request.action==="add"))return member();
    calls.changes.push(request);
    return request.executar("test reason");
  }};
  const client={user:{id:B},guilds:{cache:new Map([[G,guild]])}};
  const engine=new UpEngine({client,hours,history,notify:async(g,op)=>{calls.notifications.push(op);if(f.failNotify)throw new Error("Timeout");}});
  engine.enqueue=()=>{};
  t.after(()=>{engine.stopped=true;hours.db.close();});
  const db=engine.store;
  const add=(roleId,requiredMs)=>db.saveLevel(G,{roleId,requiredMs},db.config(G).revision);
  const l0=add(R[0],0),l1=add(R[1],10000),l2=add(R[2],30000);
  db.saveConfig(G,{enabled:true});
  const voice=(channel="voice",muted=false)=>hours.update({guildId:G,userId:U,channelId:channel,muted},now);
  return Object.assign(f,{engine,db,client,history,member,add,l0,l1,l2,voice});
}

test("rescue records a baseline, awards only initial and cannot reset the journey",async t=>{
  const f=fixture(t);f.tick(-60000);f.voice();f.tick(60000);
  await f.engine.claim(f.guild,U,R[0]);
  const first=f.db.member(G,U);
  assert.equal(first.baselineTotal,60000);assert.equal(first.bestMs,0);assert.equal(first.state,"active");
  assert.deepEqual([...f.owned],[R[0]]);
  await assert.rejects(f.engine.claim(f.guild,U,R[0]),/já iniciou/);
  assert.equal(f.db.member(G,U).joinedAt,first.joinedAt);
  assert.equal(f.engine.eligible(f.guild,first),0);
});

test("the bio requirement blocks the initial claim and automatic upgrades",async t=>{
  const f=fixture(t);let allowed=false;
  f.engine.bioGate={require:async()=>{if(!allowed)throw new Error("Adicione /mds à sua bio do Discord.");},allow:async()=>allowed};
  f.voice();
  await assert.rejects(f.engine.claim(f.guild,U,R[0]),/\/mds/);
  assert.equal(f.db.member(G,U),undefined);
  allowed=true;await f.engine.claim(f.guild,U,R[0]);
  assert.deepEqual([...f.owned],[R[0]]);
  allowed=false;f.tick(10000);const changes=f.calls.changes.length;
  await f.engine.advance(G,U);
  assert.equal(f.calls.changes.length,changes);assert.deepEqual([...f.owned],[R[0]]);
});

test("automatic cumulative milestones advance while connected, without requiring extra hours per level",async t=>{
  const f=fixture(t);f.voice();await f.engine.claim(f.guild,U,R[0]);
  f.tick(10000);await f.engine.advance(G,U);
  assert.deepEqual([...f.owned],[R[1]]);assert.equal(f.db.member(G,U).bestMs,10000);
  f.tick(20000);await f.engine.advance(G,U);
  assert.deepEqual([...f.owned],[R[2]]);assert.equal(f.db.member(G,U).bestMs,30000);
  assert.equal(f.hours.stats(G,U).totalCallMs,30000);
  const count=f.calls.changes.length;await f.engine.advance(G,U);assert.equal(f.calls.changes.length,count);
});

test("muted, AFK and excluded channels are filtered only for UP, preserving !horas",async t=>{
  const f=fixture(t);f.db.saveConfig(G,{countMuted:false,excludedChannels:["excluded"]});
  await f.engine.claim(f.guild,U,R[0]);
  f.voice("afk");f.tick(10000);f.voice("excluded");f.tick(10000);f.voice("voice",true);f.tick(10000);
  await f.engine.advance(G,U);
  assert.equal(f.db.member(G,U).bestMs,0);assert.equal(f.hours.stats(G,U).totalCallMs,30000);
  assert.equal(f.hours.stats(G,U).totalMutedMs,10000);
  f.voice("voice",false);f.tick(10000);await f.engine.advance(G,U);
  assert.equal(f.db.member(G,U).bestMs,10000);
  assert.equal(f.engine.eligible(f.guild,f.db.member(G,U)),10000);
});

test("retroactive mode uses available eligible intervals, never AFK or invented legacy totals",async t=>{
  const f=fixture(t);f.tick(-40000);f.voice();f.tick(30000);f.voice("afk");f.tick(10000);
  await f.engine.claim(f.guild,U,R[0]);
  await f.engine.advance(G,U);assert.equal(f.db.member(G,U).bestMs,0);
  f.db.saveConfig(G,{retroactive:true});await f.engine.advance(G,U);
  assert.equal(f.db.member(G,U).bestMs,30000);assert.deepEqual([...f.owned],[R[2]]);
});

test("an add failure leaves a durable pending operation and retry is idempotent",async t=>{
  const f=fixture(t);f.voice();await f.engine.claim(f.guild,U,R[0]);
  f.tick(10000);f.failAdd=true;
  await assert.rejects(f.engine.advance(G,U),/Simulated/);
  assert.equal(f.db.member(G,U).bestMs,0);assert.ok(f.db.pending(G,U));
  f.failAdd=false;await f.engine.advance(G,U);
  assert.equal(f.db.member(G,U).bestMs,10000);assert.equal(f.db.pending(G,U),undefined);
});

test("a remove failure keeps both roles temporarily; recovery never grants twice",async t=>{
  const f=fixture(t);f.voice();await f.engine.claim(f.guild,U,R[0]);f.tick(10000);f.failRemove=true;
  await assert.rejects(f.engine.advance(G,U),/Simulated/);
  assert.equal(f.owned.has(R[0]),true);assert.equal(f.owned.has(R[1]),true);
  assert.equal(f.db.pending(G,U).state,"granted");
  const added=f.calls.changes.filter(c=>c.action==="add").length;
  f.failRemove=false;
  // Simula o novo engine após reinício, usando a mesma conexão/banco restaurados.
  const restarted=new UpEngine({client:f.client,hours:f.hours,history:f.history,notify:async()=>{}});
  await restarted.advance(G,U);
  assert.deepEqual([...f.owned],[R[1]]);
  assert.equal(f.calls.changes.filter(c=>c.action==="add").length,added);
});

test("edited thresholds replace ungranted pending rewards, without demoting earned roles",async t=>{
  const f=fixture(t);f.voice();await f.engine.claim(f.guild,U,R[0]);f.tick(10000);f.failAdd=true;
  await assert.rejects(f.engine.advance(G,U));
  f.db.saveLevel(G,{id:f.l1,roleId:R[1],requiredMs:20000},f.db.config(G).revision);
  f.failAdd=false;await f.engine.advance(G,U);
  assert.equal(f.db.member(G,U).bestMs,0);assert.equal(f.owned.has(R[1]),false);
  assert.equal(f.db.pending(G,U),undefined);
  f.tick(10000);await f.engine.advance(G,U);
  assert.equal(f.db.member(G,U).bestMs,20000);assert.equal(f.owned.has(R[1]),true);
});

test("a transient error fetching the previous role does not finalize incomplete cleanup",async t=>{
  const f=fixture(t);f.voice();await f.engine.claim(f.guild,U,R[0]);f.tick(10000);
  const fetch=f.guild.roles.fetch;
  f.guild.roles.fetch=async id=>{if(id===R[0])throw new Error("Temporary network failure");return fetch(id);};
  await assert.rejects(f.engine.advance(G,U),/Temporary/);
  assert.equal(f.db.pending(G,U).state,"granted");
  assert.equal(f.db.member(G,U).bestMs,0);
  f.guild.roles.fetch=fetch;await f.engine.advance(G,U);
  assert.equal(f.db.member(G,U).bestMs,10000);assert.deepEqual([...f.owned],[R[1]]);
});

test("removePrevious=false retains earned roles and skipped checks reconcile all milestones",async t=>{
  const f=fixture(t);f.db.saveConfig(G,{removePrevious:false});f.voice();await f.engine.claim(f.guild,U,R[0]);
  f.tick(31000);await f.engine.advance(G,U);
  assert.deepEqual([...f.owned].sort(),R.slice(0,3).sort());
  assert.equal(f.db.unlocks(G,U).length,3);assert.equal(f.db.member(G,U).currentRoleId,R[2]);
});

test("increasing an earned level's threshold never demotes or rewards that level twice",async t=>{
  const f=fixture(t);f.voice();await f.engine.claim(f.guild,U,R[0]);f.tick(10000);await f.engine.advance(G,U);
  f.db.saveLevel(G,{id:f.l1,roleId:R[1],requiredMs:20000},f.db.config(G).revision);
  const count=f.calls.changes.length;await f.engine.advance(G,U);
  assert.equal(f.db.member(G,U).currentRoleId,R[1]);assert.equal(f.calls.changes.length,count);
  f.tick(10000);await f.engine.advance(G,U);assert.equal(f.calls.changes.length,count);
  f.tick(10000);await f.engine.advance(G,U);assert.equal(f.db.member(G,U).currentRoleId,R[2]);
});

test("explicit recalculation can demote, without clearing voice totals or audit history",async t=>{
  const f=fixture(t);f.voice();await f.engine.claim(f.guild,U,R[0]);f.tick(10000);await f.engine.advance(G,U);
  f.db.saveLevel(G,{id:f.l1,roleId:R[1],requiredMs:20000},f.db.config(G).revision);
  f.db.db.prepare("UPDATE up_members SET recalculate=1 WHERE guildId=? AND userId=?").run(G,U);
  await f.engine.advance(G,U);
  assert.equal(f.db.member(G,U).bestMs,0);assert.deepEqual([...f.owned],[R[0]]);
  assert.equal(f.hours.stats(G,U).totalCallMs,10000);assert.equal(f.db.unlocks(G,U).length,2);
});

test("notifications are attempted once, even if the transport fails ambiguously",async t=>{
  t.mock.method(console,"warn",()=>{});
  const f=fixture(t);f.db.saveConfig(G,{notificationChannel:"channel"});f.voice();await f.engine.claim(f.guild,U,R[0]);
  f.failNotify=true;f.tick(10000);await f.engine.advance(G,U);await f.engine.advance(G,U);
  assert.equal(f.calls.notifications.length,1);assert.equal(f.db.member(G,U).bestMs,10000);
});

test("auto audit attributes the bot, origin and actual qualified hours, not an administrator",async t=>{
  const f=fixture(t);f.voice();await f.engine.claim(f.guild,U,R[0]);f.tick(10000);await f.engine.advance(G,U);
  for(const change of f.calls.changes) {
    assert.equal(change.autor.id,B);assert.equal(change.source,"Progressão automática mds");
    assert.equal(change.reason,"Progressão automática por horas em call");
  }
  assert.equal(f.calls.changes.at(-1).hoursMs,10000);
});

test("level configuration rejects duplicate roles/hours, negatives and stale administrator panels",t=>{
  const f=fixture(t);
  assert.throws(()=>f.add(R[0],50000),/Cargo ou requisito/);
  assert.throws(()=>f.add(R[3],10000),/Cargo ou requisito/);
  assert.throws(()=>f.add(R[3],-1),/não negativas/);
  assert.throws(()=>f.db.saveLevel(G,{roleId:R[3],requiredMs:50000},0),/configuração mudou/);
  const forbidden={...f.guild.roles.cache.get(R[3]),permissions:new PermissionsBitField([PermissionFlagsBits.BanMembers])};
  assert.throws(()=>validateRole(f.guild,forbidden,{id:"manager",permissions:new PermissionsBitField()}),/administrativas/);
  assert.throws(()=>validateRole(f.guild,{...forbidden,managed:true}),/integração/);
});

test("Administrator rewards require an administrator or owner and preserve role hierarchy",t=>{
  const f=fixture(t),role={...f.guild.roles.cache.get(R[3]),permissions:new PermissionsBitField([PermissionFlagsBits.Administrator])};
  const manager={id:"manager",permissions:new PermissionsBitField([PermissionFlagsBits.ManageGuild,PermissionFlagsBits.ManageRoles]),
    roles:{highest:{position:80}}};
  const administrator={...manager,permissions:new PermissionsBitField([PermissionFlagsBits.Administrator])};
  assert.throws(()=>validateRole(f.guild,role,manager),/Somente o dono/);
  assert.doesNotThrow(()=>validateRole(f.guild,role,administrator));
  assert.doesNotThrow(()=>validateRole(f.guild,role,{id:f.guild.ownerId}));
  assert.throws(()=>validateRole(f.guild,{...role,position:100},administrator),/abaixo do bot/);
  assert.throws(()=>validateRole(f.guild,{...role,position:80},administrator),/abaixo do seu/);
  assert.throws(()=>validateRole(f.guild,{...role,managed:true},administrator),/integração/);
  assert.throws(()=>validateRole(f.guild,{...role,id:G},administrator),/cargo deve existir/);
  f.guild.members.me.permissions=new PermissionsBitField();
  assert.throws(()=>validateRole(f.guild,role,administrator),/Gerenciar Cargos/);
});

test("other management permissions are accepted for administrators and rejected for managers",t=>{
  const f=fixture(t);
  const manager={id:"manager",permissions:new PermissionsBitField([PermissionFlagsBits.ManageGuild]),
    roles:{highest:{position:80}}};
  const administrator={...manager,permissions:new PermissionsBitField([PermissionFlagsBits.Administrator])};
  for(const flag of [PermissionFlagsBits.ManageRoles,PermissionFlagsBits.BanMembers,PermissionFlagsBits.ManageChannels,PermissionFlagsBits.ModerateMembers]){
    const role={...f.guild.roles.cache.get(R[3]),permissions:new PermissionsBitField([flag])};
    assert.doesNotThrow(()=>validateRole(f.guild,role,administrator));
    assert.doesNotThrow(()=>validateRole(f.guild,role,{id:f.guild.ownerId}));
    assert.doesNotThrow(()=>validateRole(f.guild,role));
    assert.throws(()=>validateRole(f.guild,role,manager),/Somente o dono/);
  }
});

test("configured Administrator roles can be claimed and automatically earned without bypassing goals",async t=>{
  const f=fixture(t);
  for(const id of [R[0],R[1]])f.guild.roles.cache.get(id).permissions=new PermissionsBitField([PermissionFlagsBits.Administrator]);
  f.voice();
  await f.engine.claim(f.guild,U,R[0]);
  assert.deepEqual([...f.owned],[R[0]]);
  await f.engine.advance(G,U);
  assert.deepEqual([...f.owned],[R[0]]);
  f.tick(10000);
  await f.engine.advance(G,U);
  assert.deepEqual([...f.owned],[R[1]]);
  assert.equal(f.db.member(G,U).bestMs,10000);
  const count=f.calls.changes.length;
  await f.engine.advance(G,U);
  assert.equal(f.calls.changes.length,count);
});

test("initial alternatives cannot grant advanced roles and concurrent claims cannot reset time",async t=>{
  const f=fixture(t);f.db.saveConfig(G,{initialRoles:[R[3]]});
  await assert.rejects(f.engine.claim(f.guild,U,R[2]),/autorizada/);
  const first=f.engine.claim(f.guild,U,R[3]);
  await assert.rejects(f.engine.claim(f.guild,U,R[3]),/processada/);
  await first;assert.equal(f.db.member(G,U).currentRoleId,R[3]);
  assert.equal(f.db.db.prepare("SELECT COUNT(*) AS n FROM up_members").get().n,1);
});

test("coalesced shared segments still split eligibility precisely at enrollment",t=>{
  const f=fixture(t);f.voice();f.tick(10000);f.hours.checkpoint();const since=f.now();
  f.tick(10000);f.hours.checkpoint();
  assert.equal(f.hours.db.prepare("SELECT COUNT(*) AS n FROM voice_segments").get().n,1);
  assert.equal(f.hours.eligible(G,U,{since}),10000);
  assert.equal(f.hours.stats(G,U).totalCallMs,20000);
});
