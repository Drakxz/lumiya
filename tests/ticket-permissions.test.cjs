const test=require("node:test"),assert=require("node:assert/strict");
const {Collection,PermissionsBitField,PermissionFlagsBits}=require("discord.js");
const {staffRoleIds,canManageTicket}=require("../ticket-management/permissions");

const data={ticketRoles:{g:{support:["mencionado"],migration:["mig-mencionado"]}},
  ticketClaimRoles:{g:{support:["claim"],migration:[]}}};
const config={"supportTeam":["area"],migrationRole:"mig-lider",adminRole:"admin"};
function member(ids=[],permissions=[]){return {permissions:new PermissionsBitField(permissions),
  roles:{cache:new Collection(ids.map(id=>[id,{id}]))}};}
const base={data,config,guildId:"g",staffRoleId:"staff",resolve:(_g,id)=>id};

test("ticket panel roles, claim roles and area roles are all accepted",()=>{
  assert.deepEqual(staffRoleIds({...base,system:"support"}),
    ["mencionado","claim","area","admin","staff"]);
  assert.deepEqual(staffRoleIds({...base,system:"migration"}),
    ["mig-mencionado","mig-lider","admin","staff"]);
  for(const role of ["mencionado","claim","area","admin","staff"])
    assert.equal(canManageTicket({...base,system:"support",member:member([role])}),true,role);
  for(const role of ["mig-mencionado","mig-lider","admin","staff"])
    assert.equal(canManageTicket({...base,system:"migration",member:member([role])}),true,role);
  assert.equal(canManageTicket({...base,system:"support",member:member(["mig-mencionado","mig-lider"])}),false);
});

test("ManageChannels still authorizes and unrelated members are refused",()=>{
  assert.equal(canManageTicket({...base,system:"support",member:member([],[PermissionFlagsBits.ManageChannels])}),true);
  assert.equal(canManageTicket({...base,system:"support",member:member(["outro"])}),false);
  assert.equal(canManageTicket({...base,system:"support",member:null}),false);
});

test("legacy array claim configuration and missing staff role stay safe",()=>{
  const legacy={ticketRoles:{g:{support:[]}},ticketClaimRoles:{g:["legado"]}};
  assert.deepEqual(staffRoleIds({...base,data:legacy,system:"support",staffRoleId:null}),["legado","area","admin"]);
  assert.equal(canManageTicket({...base,data:legacy,system:"support",staffRoleId:null,member:member(["legado"])}),true);
  assert.equal(canManageTicket({...base,data:legacy,system:"support",staffRoleId:null,member:member(["staff"])}),false);
});
