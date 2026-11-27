const test=require("node:test");
const assert=require("node:assert/strict");
const {roleTabs,isSeparator}=require("../role-whitelist/tabs");
const role=(id,name=id)=>({id,name});

test("separator roles define tabs before permission and search filtering",()=>{
  const roles=[role("top"),role("sep","-----------------------------"),role("a"),role("b"),role("sep2","────────────"),role("c")];
  const tabs=roleTabs(roles,new Set(["a","c"]));
  assert.deepEqual(tabs.map(t=>[t.label,t.roles.map(r=>r.id)]),[["Aba 2",["a"]],["Aba 3",["c"]]]);
  assert.ok(isSeparator(roles[1]));
  assert.ok(!isSeparator(role("regular","Cargo - Suporte")));
});

test("large groups get seven-role subpages and never mix with the next tab",()=>{
  const roles=[role("leading","-----------"),...Array.from({length:16},(_,n)=>role(String(n))),role("sep","-----------"),role("last"),role("trailing","-----------")];
  const tabs=roleTabs(roles,new Set(roles.map(r=>r.id)),7);
  assert.deepEqual(tabs.map(t=>t.roles.length),[7,7,2,1]);
  assert.deepEqual(tabs.map(t=>t.label),["Aba 1 · 1/3","Aba 1 · 2/3","Aba 1 · 3/3","Aba 2"]);
  assert.equal(tabs.at(-1).roles[0].id,"last");
  assert.deepEqual(roleTabs(roles,new Set()),[]);
});
