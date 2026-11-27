const test=require("node:test");
const assert=require("node:assert/strict");
const {DatabaseSync}=require("node:sqlite");
const {EventEmitter}=require("node:events");
const {RoleWhitelistStore}=require("../role-whitelist/store");
const installWhitelist=require("../role-whitelist");

const profile={maxRoleId:"role-2",add:true,remove:false,viewHistory:true,manageOthers:true,
  targetPolicy:"below",targetMaxRoleId:"role-1",allowedAddRoleIds:["role-3"],allowedRemoveRoleIds:[],
  blockedRoleIds:["role-1"],protectedTargetRoleIds:[],blockAdministrators:true};

test("role whitelist persists scoped profiles and audit events in SQLite",()=>{
  const db=new DatabaseSync(":memory:"),store=new RoleWhitelistStore(db,["role-1","role-2","role-3"]);
  store.saveUser("guild","user",profile,"active","owner",0,"initial");
  const loaded=store.active("guild","user");
  assert.deepEqual(loaded.profile,profile);
  assert.equal(loaded.authorizedBy,"owner");
  assert.equal(store.list("guild","active").total,1);
  assert.equal(store.history("guild","user")[0].action,"authorized");
  store.setStatus("guild","user","suspended","owner","review");
  assert.equal(store.active("guild","user"),null);
  assert.equal(store.row("guild","user").status,"suspended");
  assert.equal(store.historyCount("guild","user"),2);
  db.close();
});

test("temporary authorizations expire after restart checks and are audited once",()=>{
  const db=new DatabaseSync(":memory:"),store=new RoleWhitelistStore(db,["role-1"]);
  store.saveUser("guild","user",{...profile,maxRoleId:"role-1"},"active","owner",10_000);
  const now=Date.now()+10_001;
  assert.equal(store.expire("guild","user",now),true);
  assert.equal(store.expire("guild","user",now+5),false);
  assert.equal(store.row("guild","user").status,"expired");
  assert.equal(store.historyCount("guild","user"),2);
  assert.equal(store.history("guild","user",0,5)[0].action,"expired");
  db.close();
});

test("presets are scoped per guild, unique by name and auditable",()=>{
  const db=new DatabaseSync(":memory:"),store=new RoleWhitelistStore(db,["role-1"]);
  const first=store.savePreset("guild",null,"Equipe",profile,"owner");
  assert.equal(first.name,"Equipe");assert.equal(first.updatedBy,"owner");
  assert.deepEqual(first.profile,profile);
  assert.equal(store.presets("guild").length,1);
  assert.equal(store.presets("other").length,0);
  assert.equal(store.preset("guild",first.id).id,first.id);
  assert.throws(()=>store.savePreset("guild",null,"Equipe",profile,"owner"),/Já existe/);
  const updated=store.savePreset("guild",first.id,"Equipe",{...profile,viewHistory:false},"admin");
  assert.equal(updated.id,first.id);assert.equal(updated.name,"Equipe");
  assert.equal(updated.profile.viewHistory,false);
  assert.equal(store.presets("guild").length,1);
  assert.ok(store.history("guild","__preset__").some(e=>e.action==="preset-created"));
  assert.ok(store.history("guild","__preset__").some(e=>e.action==="preset-updated"));
  assert.equal(store.deletePreset("guild",first.id,"owner"),true);
  assert.equal(store.presets("guild").length,0);
  assert.equal(store.deletePreset("guild",first.id,"owner"),false);
  db.close();
});

test("preset drafts carry the saved profile and applying seeds a user draft",()=>{
  const db=new DatabaseSync(":memory:"),store=new RoleWhitelistStore(db,["role-1"]);
  const preset=store.savePreset("guild",null,"Equipe",profile,"owner");
  const edit=store.createPresetDraft("guild","admin",preset.id);
  assert.equal(edit.userId,`__preset__:${preset.id}`);
  assert.equal(edit.reason,"Equipe");
  assert.equal(edit.profile.maxRoleId,profile.maxRoleId);
  assert.equal(edit.profile.viewHistory,true);
  const fresh=store.createPresetDraft("guild","admin","new");
  assert.equal(fresh.userId,"__preset__:new");
  assert.equal(fresh.reason,"Novo preset");
  const applied=store.createUserDraftFromPreset("guild","admin","user",preset.id);
  assert.equal(applied.userId,"user");
  assert.equal(applied.profile.maxRoleId,profile.maxRoleId);
  assert.equal(applied.reason,`Preset: ${preset.name}`);
  assert.equal(store.createUserDraftFromPreset("guild","admin","user","missing"),null);
  db.close();
});

test("draft editing is bound to its guild, author and expiration",()=>{
  const db=new DatabaseSync(":memory:"),store=new RoleWhitelistStore(db,["role-1"]);
  const draft=store.createDraft("guild","admin","user");
  assert.ok(store.draft(draft.id,"guild","admin"));
  assert.equal(store.draft(draft.id,"guild","other"),null);
  assert.equal(store.draft(draft.id,"different-guild","admin"),null);
  assert.equal(store.draft(draft.id,"guild","admin",Date.now()+31*60*1000),null);
  db.close();
});

test("single-page authorized list has unique Discord component IDs",async()=>{
  const db=new DatabaseSync(":memory:"),client=new EventEmitter();client.user={id:"bot"};
  const definitions=new Map(),registry={register(def){definitions.set(def.name,def);}};
  const api=installWhitelist({client,registry,db,managedRoleIds:["role-1"]});
  const owner={id:"owner"},guild={id:"guild",ownerId:"owner",roles:{cache:new Map()},members:{cache:new Map()}};
  api.store.saveUser(guild.id,"user",profile,"active",owner.id,0);
  const message={guild,member:{...owner,guild},author:owner,mentions:{users:{first:()=>null}},content:"!wllista",async reply(payload){this.payload=payload;return payload;}};
  assert.deepEqual([...definitions.keys()],["wlcargos"]);
  const interaction={guild,guildId:guild.id,member:message.member,user:owner,customId:"rw:list:active:0",inGuild:()=>true,isButton:()=>true,
    async reply(payload){message.payload=payload;return payload;}};
  for(const listener of client.listeners("interactionCreate"))await listener(interaction);
  const ids=[];
  const visit=component=>{if(component.custom_id)ids.push(component.custom_id);for(const child of component.components||[])visit(child);if(component.accessory)visit(component.accessory);};
  for(const component of message.payload.components[0].toJSON().components)visit(component);
  assert.equal(ids.length,new Set(ids).size);
  api.close();db.close();
});

test("linked role presets override stale individual limits and follow saved edits immediately",()=>{
  const db=new DatabaseSync(":memory:"),client=new EventEmitter();client.user={id:"bot"};
  const api=installWhitelist({client,registry:{register(){}},db,managedRoleIds:[]});
  try{
    const role=(id,position)=>({id,position,managed:false,comparePositionTo(other){return this.position-other.position;}});
    const roles=new Map([["linked",role("linked",8)],["max",role("max",6)],["lower",role("lower",3)],["bot",role("bot",20)]]);
    const guild={id:"guild",ownerId:"owner",roles:{cache:roles,everyone:role("guild",0)},
      members:{me:{permissions:{has:()=>true},roles:{highest:roles.get("bot")}}}};
    const member={id:"user",roles:{cache:new Map([["linked",roles.get("linked")]])}};
    const target={id:"target",roles:{highest:roles.get("lower")}};
    api.store.saveUser("guild","user",{...profile,maxRoleId:"deleted"},"active","owner",0);
    const preset=api.store.savePreset("guild",null,"Equipe",{...profile,maxRoleId:"max"},"owner");
    api.store.linkRolePreset("guild","linked",preset.id,"owner");
    let auth=api.access(guild,member);
    assert.equal(auth.profile.maxRoleId,"max");
    assert.equal(api.canRole(guild,member,target,roles.get("lower"),"add",auth),true);
    api.store.savePreset("guild",preset.id,"Equipe",{...profile,maxRoleId:"lower"},"owner");
    assert.equal(api.access(guild,member).profile.maxRoleId,"lower");
    assert.equal(JSON.parse(api.store.row("guild","user").profile).maxRoleId,"deleted");
    // Previously held roles also authorize members with no individual row.
    assert.equal(api.access(guild,{...member,id:"new-user"}).profile.maxRoleId,"lower");
    api.store.setStatus("guild","user","suspended","owner");
    assert.equal(api.access(guild,member).kind,"blocked");
    assert.equal(api.access({...guild,id:"other"},member),null);
    member.roles.cache.clear();
    assert.equal(api.access(guild,{...member,id:"new-user"}),null);
  }finally{api.close();db.close();}
});

test("multiple linked presets use the highest member role deterministically",()=>{
  const db=new DatabaseSync(":memory:"),client=new EventEmitter();client.user={id:"bot"};
  const api=installWhitelist({client,registry:{register(){}},db,managedRoleIds:[]});
  try{
    const guild={id:"g",roles:{cache:new Map([["low",{position:2}],["high",{position:8}]])}};
    const member={id:"u",roles:{cache:new Map([["low",{}],["high",{}]])}};
    for(const id of ["low","high"]){
      const p=api.store.savePreset("g",null,id,{...profile,maxRoleId:id},"owner");
      api.store.linkRolePreset("g",id,p.id,"owner");
    }
    assert.equal(api.access(guild,member).profile.maxRoleId,"high");
  }finally{api.close();db.close();}
});

test("preset flow creates, applies and edits a reusable authorization without selecting roles twice",async()=>{
  const db=new DatabaseSync(":memory:"),client=new EventEmitter();client.user={id:"bot"};
  const definitions=new Map(),api=installWhitelist({client,registry:{register(def){definitions.set(def.name,def);}},db,managedRoleIds:[]});
  const roles=new Map([["role-2",{id:"role-2",name:"Equipe",managed:false,position:2}]]);
  const members=new Map();
  const guild={id:"guild",ownerId:"owner",roles:{cache:roles,everyone:{id:"guild"}},
    members:{cache:members,me:{id:"bot",permissions:{has:()=>true},roles:{highest:{position:100}}}},
    channels:{fetch:async()=>{throw new Error("unused");}}};
  const owner={id:"owner",guild};
  const message={id:"panel",guild,member:{...owner,guild},author:owner};
  const dispatch=async(customId,{values=[],fields={}}={})=>{
    const out=[];
    const i={customId,guild,guildId:guild.id,member:{...owner,guild,permissions:{has:()=>true}},user:owner,values,message,
      inGuild:()=>true,
      isButton:()=>!customId.startsWith("rw:pick-")&&!customId.startsWith("rw:preset-pick:")&&!customId.startsWith("rw:roles:")&&!customId.startsWith("rw:preset-role:")&&!customId.startsWith("rw:duration:")&&!customId.startsWith("rw:preset-name")&&!customId.startsWith("rw:custom-duration")&&!customId.startsWith("rw:search"),
      isUserSelectMenu:()=>customId.startsWith("rw:pick-")||customId.startsWith("rw:preset-pick:"),
      isRoleSelectMenu:()=>customId.startsWith("rw:roles:")||customId.startsWith("rw:preset-role:"),
      isStringSelectMenu:()=>customId.startsWith("rw:duration:"),
      isModalSubmit:()=>customId.startsWith("rw:preset-name")||customId.startsWith("rw:custom-duration")||customId.startsWith("rw:search"),
      fields:{getTextInputValue:key=>fields[key]},
      async update(p){if(p)out.push(p);},async deferReply(){},async reply(p){out.push(p);},async editReply(p){out.push(p);},async showModal(p){out.push(p.toJSON());}};
    for(const listener of client.listeners("interactionCreate"))await listener(i);
    return out;
  };
  const text=out=>JSON.stringify(out);
  await dispatch("rw:presets");
  await dispatch("rw:preset-new");
  const draft=db.prepare("SELECT id FROM role_wl_drafts").get();
  await dispatch(`rw:roles:${draft.id}:max`,{values:["role-2"]});
  const options=await dispatch(`rw:d:${draft.id}:perms`);
  assert.match(text(options),/Cargos permitidos/);
  assert.match(text(options),/Cargos bloqueados/);
  assert.match(text(options),/Cargos protegidos/);
  await dispatch(`rw:d:${draft.id}:allowedAdd`);
  await dispatch(`rw:roles:${draft.id}:allowedAdd`,{values:["role-2"]});
  assert.deepEqual(api.store.draft(draft.id,guild.id,"owner").profile.allowedAddRoleIds,["role-2"]);
  const named=await dispatch(`rw:preset-name:${draft.id}`,{fields:{name:"Equipe"}});
  assert.match(text(named),/Presets de whitelist/);
  assert.match(text(named),/Equipe/);
  const presets=api.store.presets(guild.id);
  assert.equal(presets.length,1);
  assert.equal(presets[0].profile.maxRoleId,"role-2");
  assert.deepEqual(presets[0].profile.allowedAddRoleIds,["role-2"]);
  assert.match(text(named),/Permitidos: 1/);
  const applied=await dispatch(`rw:preset-pick:${presets[0].id}`,{values:["100000000000000009"]});
  assert.match(text(applied),/Configurar autorização/);
  assert.equal(db.prepare("SELECT userId FROM role_wl_drafts").get().userId,"100000000000000009");
  const userDraft=db.prepare("SELECT id FROM role_wl_drafts").get();
  await dispatch(`rw:d:${userDraft.id}:save`);
  const granted=api.store.active(guild.id,"100000000000000009");
  assert.equal(granted.profile.maxRoleId,"role-2");
  await dispatch(`rw:preset-edit:${presets[0].id}`);
  const editDraft=db.prepare("SELECT id FROM role_wl_drafts").get();
  await dispatch(`rw:d:${editDraft.id}:toggle:viewHistory`);
  await dispatch(`rw:d:${editDraft.id}:save`);
  assert.equal(api.store.presets(guild.id)[0].profile.viewHistory,true);
  assert.equal(api.store.presets(guild.id).length,1);
  const presetId=api.store.presets(guild.id)[0].id;
  await dispatch(`rw:preset-link:${presetId}`);
  await dispatch(`rw:preset-role:${presetId}`,{values:["role-2"]});
  assert.equal(api.store.rolePreset(guild.id,"role-2").id,presetId);
  assert.equal(api.applyRolePreset(guild,"100000000000000009","role-2","owner"),false);
  members.set("100000000000000009",{id:"100000000000000009",roles:{cache:new Map([["role-2",roles.get("role-2")]])}});
  assert.equal(api.applyRolePreset(guild,"100000000000000009","role-2","owner"),true);
  assert.equal(api.store.active(guild.id,"100000000000000009").profile.viewHistory,true);
  assert.equal(api.applyRolePreset(guild,"100000000000000009","role-2","owner"),false);
  await dispatch(`rw:preset-unlink:${presetId}:role-2`);
  assert.equal(api.store.rolePreset(guild.id,"role-2"),null);
  await dispatch(`rw:preset-del:${presetId}`);
  await dispatch(`rw:preset-del-yes:${presetId}`);
  assert.equal(api.store.presets(guild.id).length,0);
  assert.equal(api.store.active(guild.id,"100000000000000009").profile.maxRoleId,"role-2");
  api.close();db.close();
});

test("whitelist max uses detected server roles without requiring executor ManageRoles",()=>{
  const db=new DatabaseSync(":memory:"),client=new EventEmitter();client.user={id:"bot"};
  const registry={register(){}},api=installWhitelist({client,registry,db,managedRoleIds:[]});
  const mkRole=(id,position,admin=false)=>({id,position,managed:false,permissions:{has:()=>admin},comparePositionTo(other){return this.position-other.position;}});
  const low=mkRole("role-low",1,true),max=mkRole("role-max",2),tooHigh=mkRole("role-high",3),botRole=mkRole("bot-role",10);
  const roles=new Map([[low.id,low],[max.id,max],[tooHigh.id,tooHigh],[botRole.id,botRole]]);
  const guild={id:"guild",ownerId:"owner",roles:{cache:roles,everyone:{position:0}},members:{me:{permissions:{has:()=>true},roles:{highest:botRole}}}};
  const cache=new Map();cache.has=id=>Map.prototype.has.call(cache,id);
  const staff={id:"staff",guild,permissions:{has:()=>false},roles:{highest:mkRole("staff-role",2),cache}};
  const targetCache=new Map();targetCache.has=id=>Map.prototype.has.call(targetCache,id);
  const target={id:"target",permissions:{has:()=>false},roles:{cache:targetCache,highest:mkRole("target-role",1)}};
  api.store.saveUser(guild.id,staff.id,{...profile,maxRoleId:max.id,add:false,remove:false},"active","owner",0);
  const auth=api.access(guild,staff);
  assert.equal(api.canRole(guild,staff,target,low,"add",auth),true);
  assert.equal(api.canRole(guild,staff,target,tooHigh,"add",auth),false);
  api.close();db.close();
});

test("WL shows guild icon and updates the same message through buttons, selects and modals",async()=>{
  const db=new DatabaseSync(":memory:"),client=new EventEmitter();client.user={id:"bot"};
  const definitions=new Map(),api=installWhitelist({client,registry:{register(def){definitions.set(def.name,def);}},db,managedRoleIds:[]});
  const guild={id:"guild",ownerId:"owner",iconURL:()=>"https://cdn.discordapp.com/icons/123/test.png",members:{cache:new Map()},roles:{cache:new Map()}};
  const user={id:"owner"},member={...user,guild},updates=[];
  const home=api.adminPanel(guild).toJSON();
  assert.equal(home.components[0].accessory.media.url,guild.iconURL());
  const message={id:"same-panel"};
  const dispatch=async(customId,type,extra={})=>{
    const i={guild,guildId:guild.id,user,member,message,customId,inGuild:()=>true,
      isButton:()=>type==="button",isUserSelectMenu:()=>type==="user",isStringSelectMenu:()=>type==="string",isRoleSelectMenu:()=>false,isModalSubmit:()=>type==="modal",
      async update(p){updates.push(p);},async reply(){assert.fail("navigation must not create a reply");},...extra};
    for(const listener of client.listeners("interactionCreate"))await listener(i);
  };
  await dispatch("rw:add","button");
  await dispatch("rw:pick-add","user",{values:["target"]});
  const draft=db.prepare("SELECT id FROM role_wl_drafts").get();
  await dispatch(`rw:d:${draft.id}:duration`,"button");
  await dispatch(`rw:duration:${draft.id}`,"string",{values:["3600000"]});
  await dispatch(`rw:custom-duration:${draft.id}`,"modal",{fields:{getTextInputValue:()=>"12"}});
  await dispatch("rw:home","button");
  assert.equal(updates.length,6);
  assert.ok(updates.every(p=>p.flags===undefined));
  api.close();db.close();
});

test("WL deletes only its own panel after 30 seconds idle and resets on clicks",async t=>{
  t.mock.timers.enable({apis:["setTimeout"]});
  const db=new DatabaseSync(":memory:"),client=new EventEmitter(),definitions=new Map();
  client.user={id:"bot"};
  const api=installWhitelist({client,registry:{register(def){definitions.set(def.name,def);}},db,managedRoleIds:[]});
  t.after(()=>{api.close();db.close();});
  const guild={id:"guild",ownerId:"owner"},user={id:"owner"},member={...user,guild};
  let deleted=0,userDeleted=0;
  const panelMessage={id:"panel",channelId:"channel",async delete(){deleted++;}};
  await definitions.get("wlcargos").prefix.execute({guild,member,author:user,channel:{async send(){return panelMessage;}},async delete(){userDeleted++;}});
  t.mock.timers.tick(29000);assert.equal(deleted,0);
  const i={guild,guildId:guild.id,member,user,message:panelMessage,customId:"rw:home",inGuild:()=>true,isButton:()=>true,async update(){}};
  for(const listener of client.listeners("interactionCreate"))await listener(i);
  t.mock.timers.tick(29000);assert.equal(deleted,0);
  t.mock.timers.tick(1000);assert.equal(deleted,1);
  assert.equal(userDeleted,0);
});
