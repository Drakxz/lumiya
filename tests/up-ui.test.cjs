const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const vm=require("node:vm");
const {EventEmitter}=require("node:events");
const d=require("discord.js");
const {VoiceHoursStore}=require("../voice-hours/store");
const {UpEngine}=require("../up/engine");
const {getCommandRegistry}=require("../command-system/registry");
const G="100000000000000001",ADMIN="100000000000000002",USER="100000000000000003",BOT="100000000000000004";
const ROLES=["100000000000000010","100000000000000011","100000000000000012"];
const CHANNEL="100000000000000020";
function fixture(t) {
  const hours=new VoiceHoursStore(":memory:");
  const client=new EventEmitter();client.user={id:BOT};
  const owned=new Map([[USER,new Set()],[ADMIN,new Set()]]);
  const guild={id:G,name:"Servidor UP",ownerId:"owner",available:true,afkChannelId:null,roles:{cache:new d.Collection()},members:{},channels:{}};
  ROLES.forEach((id,n)=>guild.roles.cache.set(id,{id,name:`Cargo ${n}`,managed:false,position:10+n,permissions:new d.PermissionsBitField()}));
  guild.roles.fetch=async id=>guild.roles.cache.get(id)||null;
  const member=id=>({id,user:{id,bot:false},permissions:new d.PermissionsBitField(id===ADMIN?[d.PermissionFlagsBits.ManageGuild,d.PermissionFlagsBits.ManageRoles]:[]),
    roles:{highest:{position:id===ADMIN?80:1},cache:new d.Collection([...owned.get(id)||[]].map(roleId=>[roleId,guild.roles.cache.get(roleId)])),
      async add(role){owned.get(id).add(role.id);return member(id);},async remove(role){owned.get(id).delete(role.id);return member(id);}},
    displayAvatarURL:()=>"https://cdn.discordapp.com/embed/avatars/0.png"});
  guild.members.me={id:BOT,roles:{highest:{position:100}},permissions:new d.PermissionsBitField([d.PermissionFlagsBits.ManageRoles])};
  guild.members.fetch=async query=>member(query.user||query);
  const channel={id:CHANNEL,guildId:G,type:d.ChannelType.GuildText,sent:[],isTextBased:()=>true,
    permissionsFor:()=>new d.PermissionsBitField([d.PermissionFlagsBits.ViewChannel,d.PermissionFlagsBits.SendMessages]),
    async send(p){this.sent.push(p);return {id:"message"};}};
  guild.channels.fetch=async()=>channel;
  client.guilds={cache:new Map([[G,guild]])};
  client.application={commands:{async create(command){client.command=command;}}};
  const denied=[];
  const context={module:{exports:{}},__dirname:path.join(__dirname,"../up"),console,process:{once(){}},
    setInterval(fn){client.tick=fn;return {unref(){}};},clearInterval(){},
    require(name){if(name==="discord.js")return d;if(name==="./engine")return {UpEngine,validateRole:require("../up/engine").validateRole};
      if(name==="./bio-gate")return require("../up/bio-gate");
      if(name==="../voice-hours/time")return require("../voice-hours/time");return require(name);}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,"../up/index.js"),"utf8"),context);
  const api=context.module.exports({client,hours,history:{async alterarCargo(req){
    const actual=await guild.members.fetch(req.alvo.id);
    if(actual.roles.cache.has(req.cargo.id)===(req.action==="add"))return actual;
    return req.executar("test");}},responderSemPermissao(i){denied.push(i);return Promise.resolve();}});
  api.engine.enqueue=()=>{};
  t.after(()=>{api.engine.stopped=true;hours.db.close();});
  const emit=async(event,...args)=>{for(const fn of client.listeners(event))await fn(...args);};
  function interaction(customId,userId=ADMIN,{values=[],fields={},slash=false}={}) {
    return {customId,user:{id:userId},guild,guildId:G,member:member(userId),values,
      inGuild:()=>true,isChatInputCommand:()=>slash,commandName:slash?"upadmin":null,
      fields:{getTextInputValue:key=>fields[key]},edits:[],follows:[],replies:[],
      async deferUpdate(){this.deferred=true;},async deferReply(p){this.deferred=true;this.deferFlags=p;},
      async showModal(modal){this.modal=modal;this.replied=true;},
      async editReply(p){assert.equal(this.deferred,true);this.edits.push(p);},
      async followUp(p){this.follows.push(p);},async reply(p){this.replies.push(p);this.replied=true;}};
  }
  function message(content,userId=ADMIN) {
    return {content,guild,channel,author:{id:userId,bot:false},member:member(userId),replies:[],async reply(p){this.replies.push(p);}};
  }
  const latest=()=>api.engine.store.db.prepare("SELECT data FROM up_sessions ORDER BY rowid DESC LIMIT 1").get();
  return {client,guild,channel,hours,owned,denied,api,db:api.engine.store,interaction,message,emit,latest};
}
function tree(node){return [node,...(node.components||[]).flatMap(tree),...(node.accessory?tree(node.accessory):[])];}
function check(payload) {
  assert.ok(payload.flags & d.MessageFlags.IsComponentsV2);assert.equal(payload.content,undefined);assert.equal(payload.embeds,undefined);
  const json=payload.components[0].toJSON();assert.ok(tree(json).length<=40);
  assert.ok(tree(json).filter(c=>c.type===10).map(c=>c.content).join("").length<=4000);
  for(const component of tree(json))if(component.custom_id)assert.ok(component.custom_id.length<=100);
  return json;
}
test("mds public UP panel keeps current controls and text but removes its thumbnail",async t=>{
  const f=fixture(t);
  f.guild.id="1331871489368260619";f.guild.name="mds";
  f.channel.guildId=f.guild.id;
  f.guild.iconURL=()=>"https://cdn.discordapp.com/embed/avatars/0.png";
  await f.emit("messageCreate",f.message("!up"));
  const panel=check(f.channel.sent.at(-1)),nodes=tree(panel);
  assert.ok(!nodes.some(c=>[11,12].includes(c.type)));
  assert.match(nodes.filter(c=>c.type===10).map(c=>c.content).join("\n"),/Progressão de Cargos/);
  assert.deepEqual(nodes.filter(c=>c.custom_id).map(c=>c.custom_id),["up:claim","up:mine","up:levels"]);
});
async function adminPanel(h) {
  const message=h.message("!upadmin");await h.emit("messageCreate",message);check(message.replies[0]);
  return JSON.parse(h.latest().data);
}
async function add(h,s,roleId,hours) {
  const start=h.interaction(`up:add:${s.id}`);await h.emit("interactionCreate",start);check(start.edits[0]);
  const select=h.interaction(`up:pickadd:${s.id}`,ADMIN,{values:[roleId]});await h.emit("interactionCreate",select);
  assert.ok(select.modal);assert.equal(select.modal.toJSON().components[0].type,d.ComponentType.Label);
  const modal=h.interaction(`up:save:${s.id}`,ADMIN,{fields:{hours}});await h.emit("interactionCreate",modal);
  assert.equal(modal.follows.length,0);check(modal.edits[0]);
}

test("saving an Administrator reward checks the actor's live permission, not just ManageGuild",async t=>{
  const h=fixture(t),s=await adminPanel(h);
  h.guild.roles.cache.get(ROLES[0]).permissions.add(d.PermissionFlagsBits.Administrator);
  await h.emit("interactionCreate",h.interaction(`up:add:${s.id}`));
  await h.emit("interactionCreate",h.interaction(`up:pickadd:${s.id}`,ADMIN,{values:[ROLES[0]]}));
  const denied=h.interaction(`up:save:${s.id}`,ADMIN,{fields:{hours:"0"}});
  await h.emit("interactionCreate",denied);
  assert.equal(h.db.levels(G).length,0);
  assert.match(JSON.stringify(denied.follows),/Somente o dono/);
  const allowed=h.interaction(`up:save:${s.id}`,ADMIN,{fields:{hours:"0"}});
  allowed.member.permissions.add(d.PermissionFlagsBits.Administrator);
  await h.emit("interactionCreate",allowed);
  assert.equal(allowed.follows.length,0);
  assert.equal(h.db.levels(G)[0].roleId,ROLES[0]);
});

test("weekly maintenance is configured in the admin panel and exposed to hours cards",async t=>{
  const h=fixture(t),s=await adminPanel(h);
  await add(h,s,ROLES[0],"0");await add(h,s,ROLES[1],"10");
  await h.emit("interactionCreate",h.interaction(`up:edit:${s.id}`));
  await h.emit("interactionCreate",h.interaction(`up:pickedit:${s.id}`,ADMIN,{values:[ROLES[1]]}));
  const open=h.interaction(`up:maintenance:${s.id}`);await h.emit("interactionCreate",open);
  assert.ok(open.modal);
  const save=h.interaction(`up:savemaintenance:${s.id}`,ADMIN,{fields:{hours:"2,5"}});
  await h.emit("interactionCreate",save);
  assert.equal(save.follows.length,0);check(save.edits[0]);
  assert.equal(h.db.maintenance(G,ROLES[1]).requiredMs,9000000);
  h.db.saveConfig(G,{enabled:true});
  const member={guild:h.guild,roles:{cache:new d.Collection([[ROLES[1],h.guild.roles.cache.get(ROLES[1])]])}};
  assert.equal(h.hours.maintenanceForMember(member).requiredMs,9000000);
  h.db.saveMaintenance(G,ROLES[1],0,h.db.config(G).revision);
  assert.equal(h.hours.maintenanceForMember(member),null);
  const denied=h.interaction(`up:maintenance:${s.id}`,USER);await h.emit("interactionCreate",denied);
  assert.equal(h.denied.length,1);
});

test("public and administrative commands are protected, with one row of public controls",async t=>{
  const h=fixture(t);
  for(const command of ["!upcargos","!upadmin"]){await h.emit("messageCreate",h.message(command,USER));}
  assert.equal(h.denied.length,2);assert.equal(h.channel.sent.length,0);
  await h.emit("messageCreate",h.message("!upcargos"));
  const json=check(h.channel.sent[0]);
  assert.deepEqual(json.components.at(-1).components.map(c=>c.label),["Resgatar Cargo Inicial","Minha Progressão","Ver Cargos"]);
  const title=tree(json).filter(c=>c.type===10).map(c=>c.content).join("\n");
  assert.ok(title.includes("### 🌙 Progressão de Cargos | Servidor UP"));
  assert.ok(!title.includes("# Progressão de Cargos\n"));
  assert.ok(getCommandRegistry(h.client).preservedBotMessages.has("message"));
});

test("admin adds initial and advanced roles through RoleSelect + modal, without code edits",async t=>{
  const h=fixture(t);const s=await adminPanel(h);
  await add(h,s,ROLES[0],"0");await add(h,s,ROLES[1],"5");await add(h,s,ROLES[2],"15");
  assert.deepEqual(h.db.levels(G).map(l=>l.requiredMs),[0,18000000,54000000]);
  const toggle=h.interaction(`up:toggle:${s.id}`);await h.emit("interactionCreate",toggle);
  assert.equal(h.db.config(G).enabled,true);check(toggle.edits[0]);
});

test("third parties cannot use administrative buttons, selects or modals",async t=>{
  const h=fixture(t);const s=await adminPanel(h);
  for(const action of ["add","pickadd","save","toggle","excluded","notification","initials"]){
    const i=h.interaction(`up:${action}:${s.id}`,USER,{values:[ROLES[0]],fields:{hours:"0"}});
    await h.emit("interactionCreate",i);assert.equal(i.edits.length,0);
  }
  assert.equal(h.denied.length,7);assert.equal(h.db.levels(G).length,0);
});

test("public redemption is private and personal progression survives refreshed sessions",async t=>{
  const h=fixture(t);const admin=await adminPanel(h);await add(h,admin,ROLES[0],"0");await add(h,admin,ROLES[1],"5");
  h.db.saveConfig(G,{enabled:true});
  const claim=h.interaction("up:claim",USER);await h.emit("interactionCreate",claim);
  assert.equal(claim.deferFlags.flags,d.MessageFlags.Ephemeral);
  const json=check(claim.edits[0]);assert.equal(json.accent_color,0);
  assert.equal(h.owned.get(USER).has(ROLES[0]),true);
  const s=JSON.parse(h.latest().data);
  const mine=h.interaction(`up:mine:${s.id}`,USER);await h.emit("interactionCreate",mine);check(mine.edits[0]);
  const texts=tree(mine.edits[0].components[0].toJSON()).filter(x=>x.type===10).map(x=>x.content).join("\n");
  assert.ok(texts.includes("### 🌙 Minha Progressão | Servidor UP"));assert.ok(texts.includes("**0%**"));
  assert.ok(texts.includes("**Cargos desbloqueados:** 1/2"));
  const stranger=h.interaction(`up:mine:${s.id}`,ADMIN);await h.emit("interactionCreate",stranger);
  assert.equal(h.denied.length,1);
});

test("multiple initial options never include advanced roles",async t=>{
  const h=fixture(t);const s=await adminPanel(h);await add(h,s,ROLES[0],"0");await add(h,s,ROLES[1],"5");
  h.db.saveConfig(G,{enabled:true,initialRoles:[ROLES[2]]});
  const claim=h.interaction("up:claim",USER);await h.emit("interactionCreate",claim);
  const json=check(claim.edits[0]);
  const select=tree(json).find(c=>c.type===d.ComponentType.StringSelect);
  assert.deepEqual(select.options.map(option=>option.value),[ROLES[0],ROLES[2]]);
  const session=JSON.parse(h.latest().data);
  const selectI=h.interaction(`up:initial:${session.id}`,USER,{values:[ROLES[1]]});await h.emit("interactionCreate",selectI);
  assert.equal(selectI.follows.length,1);assert.equal(h.db.member(G,USER),undefined);
});

test("settings toggle policies, choose channels and support empty selections",async t=>{
  const h=fixture(t);const s=await adminPanel(h);await add(h,s,ROLES[0],"0");
  const open=h.interaction(`up:settings:${s.id}`);await h.emit("interactionCreate",open);check(open.edits[0]);
  for(const action of ["muted","previous","retro"]){const i=h.interaction(`up:${action}:${s.id}`);await h.emit("interactionCreate",i);check(i.edits[0]);}
  const cfg=h.db.config(G);assert.equal(cfg.countMuted,false);assert.equal(cfg.removePrevious,false);assert.equal(cfg.retroactive,true);
  const notify=h.interaction(`up:notification:${s.id}`,ADMIN,{values:[CHANNEL]});await h.emit("interactionCreate",notify);
  assert.equal(h.db.config(G).notificationChannel,CHANNEL);check(notify.edits[0]);
  const clear=h.interaction(`up:notification:${s.id}`,ADMIN,{values:[]});await h.emit("interactionCreate",clear);
  assert.equal(h.db.config(G).notificationChannel,null);
});

test("edit changes role and accumulated milestone; removal requires confirmation",async t=>{
  const h=fixture(t);const s=await adminPanel(h);await add(h,s,ROLES[0],"0");await add(h,s,ROLES[1],"5");
  const edit=h.interaction(`up:edit:${s.id}`);await h.emit("interactionCreate",edit);
  const pick=h.interaction(`up:pickedit:${s.id}`,ADMIN,{values:[ROLES[1]]});await h.emit("interactionCreate",pick);check(pick.edits[0]);
  const replace=h.interaction(`up:replace:${s.id}`,ADMIN,{values:[ROLES[2]]});await h.emit("interactionCreate",replace);
  const hours=h.interaction(`up:hours:${s.id}`);await h.emit("interactionCreate",hours);assert.ok(hours.modal);
  const save=h.interaction(`up:save:${s.id}`,ADMIN,{fields:{hours:"10"}});await h.emit("interactionCreate",save);
  assert.equal(h.db.levels(G)[1].roleId,ROLES[2]);assert.equal(h.db.levels(G)[1].requiredMs,36000000);
  const remove=h.interaction(`up:remove:${s.id}`);await h.emit("interactionCreate",remove);
  const selected=h.interaction(`up:pickremove:${s.id}`,ADMIN,{values:[ROLES[2]]});await h.emit("interactionCreate",selected);check(selected.edits[0]);
  assert.equal(h.db.levels(G).length,2);
  const confirm=h.interaction(`up:confirmremove:${s.id}`);await h.emit("interactionCreate",confirm);assert.equal(h.db.levels(G).length,1);
});

test("hierarchy uses bounded pages and private administrative slash registration preserves commands",async t=>{
  const h=fixture(t);const s=await adminPanel(h);await add(h,s,ROLES[0],"0");
  for(let n=1;n<15;n++)h.db.saveLevel(G,{roleId:`1000000000000001${String(n).padStart(2,"0")}`,requiredMs:n*3600000},h.db.config(G).revision);
  const levels=h.interaction(`up:levels:${s.id}`);await h.emit("interactionCreate",levels);const json=check(levels.edits[0]);
  assert.ok(tree(json).some(c=>c.label==="1/3"));
  const next=h.interaction(`up:next:${s.id}`);await h.emit("interactionCreate",next);assert.ok(tree(check(next.edits[0])).some(c=>c.label==="2/3"));
  await h.emit("clientReady");assert.equal(h.client.command.name,"upadmin");
  const slash=h.interaction(null,ADMIN,{slash:true});await h.emit("interactionCreate",slash);
  assert.equal(slash.deferFlags.flags,d.MessageFlags.Ephemeral);check(slash.edits[0]);
});

test("progress bar measures the interval between the earned milestone and the next one",async t=>{
  let now=Date.parse("2026-11-11T15:00:00Z");t.mock.method(Date,"now",()=>now);
  const h=fixture(t);const admin=await adminPanel(h);
  await add(h,admin,ROLES[0],"0");await add(h,admin,ROLES[1],"15");await add(h,admin,ROLES[2],"30");
  h.db.saveConfig(G,{enabled:true});
  const claim=h.interaction("up:claim",USER);await h.emit("interactionCreate",claim);
  const s=JSON.parse(h.latest().data);
  h.hours.update({guildId:G,userId:USER,channelId:"voice",muted:false},now);
  now+=(21*60+35)*60000;
  const mine=h.interaction(`up:mine:${s.id}`,USER);await h.emit("interactionCreate",mine);
  const texts=tree(check(mine.edits[0])).filter(x=>x.type===10).map(x=>x.content).join("\n");
  assert.ok(texts.includes("**43%**"));
  assert.ok(texts.includes("**Cargos desbloqueados:** 2/3"));
  assert.equal(h.db.member(G,USER).currentRoleId,ROLES[1]);
});
