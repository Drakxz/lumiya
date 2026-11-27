const test=require("node:test");
const assert=require("node:assert/strict");
const {EventEmitter}=require("node:events");
const {AuditLogEvent}=require("discord.js");
const install=require("../role-whitelist/guard");

function fixture(additionLog){
  const client=new EventEmitter();client.user={id:"mds",bot:true};
  const removals=[],role={id:"role",managed:false,comparePositionTo:()=>-1};
  const target={id:"target",roles:{cache:new Map([[role.id,role]]),async remove(cargo,reason){removals.push({cargo,reason});}}};
  const actor={id:"human",user:{bot:false},roles:{highest:{comparePositionTo:()=>-1}}};
  const guild={id:"guild",roles:{async fetch(){return role;}},members:{async fetchMe(){return {permissions:{has:()=>true},roles:{highest:{id:"bot-role"}}};},async fetch(query){return query.user===target.id?target:actor;}}};
  const records=[],history={async alterarCargo(operation){records.push(operation);await operation.executar("guard audit reason");}};
  const api=install({client,history,additionLog});
  const entry={id:"audit",action:AuditLogEvent.MemberRoleUpdate,targetId:target.id,createdTimestamp:Date.now(),executor:{id:"human",bot:false},changes:[{key:"$add",new:[{id:role.id}]}]};
  return {api,entry,guild,records,removals,role,actor};
}

test("manual additions are reverted and recorded once, even for duplicate audit events",async()=>{
  const f=fixture();
  await f.api.inspect(f.entry,f.guild);
  await f.api.inspect(f.entry,f.guild);
  assert.equal(f.removals.length,1);
  assert.equal(f.records[0].action,"remove");
  assert.match(f.records[0].reason,/human/);
  assert.match(f.records[0].source,/Proteção/);
  f.api.close();
});

test("human above the bot may add manually and the addition remains logged",async()=>{
  const logs=[],f=fixture({async inspect(entry){logs.push(entry.id);}});
  f.actor.roles.highest.comparePositionTo=()=>1;
  await f.api.inspect(f.entry,f.guild);
  assert.equal(f.removals.length,0);
  assert.deepEqual(logs,["audit"]);
  f.api.close();
});

test("same hierarchy is not enough to bypass protection",async()=>{
  const f=fixture();
  f.actor.roles.highest.comparePositionTo=()=>0;
  await f.api.inspect(f.entry,f.guild);
  assert.equal(f.removals.length,1);
  f.api.close();
});

test("Administrator is not an exemption below the bot",async()=>{
  const f=fixture();
  f.actor.permissions={has:()=>true};
  await f.api.inspect(f.entry,f.guild);
  assert.equal(f.removals.length,1);
  f.api.close();
});

test("uncached human above bot is resolved by executorId",async()=>{
  const f=fixture();
  f.actor.roles.highest.comparePositionTo=()=>1;
  await f.api.inspect({...f.entry,executor:null,executorId:"human"},f.guild);
  assert.equal(f.removals.length,0);
  f.api.close();
});

test("unauthorized bot above hierarchy is not exempt",async()=>{
  const f=fixture();
  f.actor.roles.highest.comparePositionTo=()=>1;
  f.actor.user.bot=true;
  await f.api.inspect({...f.entry,executor:null,executorId:"human"},f.guild);
  assert.equal(f.removals.length,1);
  f.api.close();
});

test("guild owner manual additions are preserved",async()=>{
  const f=fixture();f.guild.ownerId="human";
  await f.api.inspect(f.entry,f.guild);
  assert.equal(f.removals.length,0);
  f.api.close();
});

test("authority lookup failure does not cause a mistaken removal",async t=>{
  t.mock.method(console,"warn",()=>{});
  const f=fixture();
  f.guild.members.fetch=async()=>{throw new Error("Network failure");};
  await f.api.inspect(f.entry,f.guild);
  assert.equal(f.removals.length,0);
  f.api.close();
});

test("only MDS additions are preserved, including UP and its panels",async()=>{
  const f=fixture();
  await f.api.inspect({...f.entry,executor:{id:"mds",bot:true}},f.guild);
  await f.api.inspect({...f.entry,executor:null,executorId:"mds"},f.guild);
  assert.equal(f.removals.length,0);f.api.close();
});

test("additions from other bots are reverted once and audited",async()=>{
  const f=fixture();
  const entry={...f.entry,executor:{id:"other-bot",bot:true}};
  await f.api.inspect(entry,f.guild);
  await f.api.inspect(entry,f.guild);
  assert.equal(f.removals.length,1);
  assert.equal(f.records[0].action,"remove");
  assert.match(f.records[0].reason,/other-bot/);
  f.api.close();
});

test("explicitly allowed role is preserved for humans and other bots and still logged",async()=>{
  const logs=[],f=fixture({async inspect(entry){logs.push(entry.id);}});
  for(const roleId of ["1560458283117191188"]){
    for(const [index,executor] of [{id:"human",bot:false},{id:"external-bot",bot:true}].entries()){
      await f.api.inspect({...f.entry,id:`allowed-${roleId}-${index}`,executor,changes:[{key:"$add",new:[{id:roleId}]}]},f.guild);
    }
  }
  assert.equal(f.removals.length,0);
  assert.equal(f.records.length,0);
  assert.equal(logs.length,2);
  f.api.close();
});

test("authorized external bot can add any role and its additions remain logged",async()=>{
  const logs=[],f=fixture({async inspect(entry){logs.push(entry.id);}});
  await f.api.inspect({...f.entry,executor:{id:"1568767491713409125",bot:true}},f.guild);
  await f.api.inspect({...f.entry,id:"uncached",executor:null,executorId:"1568767491713409125"},f.guild);
  assert.equal(f.removals.length,0);
  assert.equal(logs.length,2);
  f.api.close();
});

test("authorized bot ID is not treated as an allowed role ID",async()=>{
  const f=fixture();
  f.role.id="1568767491713409125";
  f.guild.members.fetch=async()=>({roles:{cache:new Map([[f.role.id,f.role]]),async remove(){f.removals.push(true);}}});
  await f.api.inspect({...f.entry,changes:[{key:"$add",new:[{id:f.role.id}]}]},f.guild);
  assert.equal(f.removals.length,1);
  f.api.close();
});

test("allowed role does not exempt other roles added in the same audit entry",async()=>{
  const f=fixture();
  await f.api.inspect({...f.entry,executor:{id:"external-bot",bot:true},
    changes:[{key:"$add",new:[{id:"1560458283117191188"},{id:"role"}]}]},f.guild);
  assert.equal(f.removals.length,1);
  assert.equal(f.records[0].cargo.id,"role");
  f.api.close();
});

test("uncached external executors are identified by audit executorId",async()=>{
  const f=fixture();
  await f.api.inspect({...f.entry,executor:null,executorId:"external-bot"},f.guild);
  assert.equal(f.removals.length,1);
  assert.match(f.records[0].reason,/external-bot/);
  f.api.close();
});

test("missing executor or mismatched member and roles never causes removal",async()=>{
  const f=fixture();
  await f.api.inspect({...f.entry,executor:null},f.guild);
  await f.api.inspect(f.entry,f.guild,{userId:"someone-else",roleIds:new Set(["role"])});
  await f.api.inspect(f.entry,f.guild,{userId:"target",roleIds:new Set(["different-role"])});
  assert.equal(f.removals.length,0);
  f.api.close();
});

test("unmanageable roles and missing ManageRoles are not removed",async()=>{
  const f=fixture();
  f.role.comparePositionTo=()=>0;
  await f.api.inspect(f.entry,f.guild);
  assert.equal(f.removals.length,0);
  f.role.comparePositionTo=()=>-1;
  f.guild.members.fetchMe=async()=>({permissions:{has:()=>false}});
  await f.api.inspect(f.entry,f.guild);
  assert.equal(f.removals.length,0);
  f.api.close();
});

test("old logs, manual removals and Discord-managed roles are not reverted",async()=>{
  const f=fixture();
  await f.api.inspect({...f.entry,createdTimestamp:Date.now()-120000},f.guild);
  await f.api.inspect({...f.entry,changes:[{key:"$remove",new:[{id:"role"}]}]},f.guild);
  f.role.managed=true;
  await f.api.inspect(f.entry,f.guild);
  assert.equal(f.removals.length,0);f.api.close();
});
