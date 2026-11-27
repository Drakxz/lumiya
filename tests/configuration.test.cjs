const test=require("node:test"),assert=require("node:assert/strict");
const {DatabaseSync}=require("node:sqlite");
const {EventEmitter}=require("node:events");
const d=require("discord.js"),sharp=require("sharp");
const {ConfigStore}=require("../configuration/store");
const {PanelRegistry}=require("../configuration/panels");
const {apply,flat,variables,validate,installRuntime}=require("../configuration/render");
const {publicIP,safeURL,sanitize}=require("../configuration/assets");
const {getCommandRegistry}=require("../command-system/registry");
const install=require("../configuration");
const G="100000000000000001",U="100000000000000002",B="100000000000000003",C="100000000000000004";
function fixture(t,options={}){
  const db=new DatabaseSync(":memory:"),client=new EventEmitter();client.setMaxListeners(32);
  client.user={id:B,username:"Lumiya",displayAvatarURL:()=>"https://cdn.discordapp.com/embed/avatars/0.png"};
  client.emojis={cache:new d.Collection()};client.application={commands:{create:async c=>({id:c.name})}};
  let allowed=true,sequence=1000n;
  const posted=[],messages=new Map();
  const guild={id:G,name:"Comunidade",ownerId:U,memberCount:42,available:true,
    iconURL:()=>"https://cdn.discordapp.com/embed/avatars/1.png",bannerURL:()=>null,emojis:{cache:new d.Collection()},
    roles:{cache:new d.Collection(),everyone:{id:G}}};
  const user={id:U,username:"Ana",displayAvatarURL:()=>"https://cdn.discordapp.com/embed/avatars/2.png"};
  const actor={id:U,guild,user,permissions:new d.PermissionsBitField(d.PermissionsBitField.All),roles:{cache:new d.Collection()}};
  const botMember={id:B,permissions:new d.PermissionsBitField(d.PermissionsBitField.All)};
  guild.members={me:botMember,fetchMe:async()=>botMember,fetch:async()=>({...actor,permissions:new d.PermissionsBitField(allowed?d.PermissionsBitField.All:[])})};
  function makeMessage(payload,id=String(100000000000000000n+sequence++)){
    const message={id,guild,guildId:G,channelId:C,channel,author:client.user,flags:new d.MessageFlagsBitField(payload.flags||0),
      components:(payload.components||[]).map(c=>c.toJSON?.()||c),edits:[],deleted:false,
      async edit(p){this.edits.push(p);this.components=p.components.map(c=>c.toJSON?.()||c);return this;},
      async delete(){this.deleted=true;messages.delete(id);}};
    messages.set(id,message);return message;
  }
  const channel={id:C,guildId:G,guild,name:"geral",type:d.ChannelType.GuildText,rawPosition:0,
    permissionsFor:()=>new d.PermissionsBitField(d.PermissionsBitField.All),
    messages:{fetch:async id=>{if(!messages.has(id))throw Object.assign(new Error("unknown message"),{code:10008});return messages.get(id);}},
    send:async payload=>{posted.push(payload);return makeMessage(payload);}};
  guild.systemChannel=channel;
  guild.channels={cache:new d.Collection([[C,channel]]),fetch:async id=>id?guild.channels.cache.get(id):guild.channels.cache};
  client.guilds={cache:new d.Collection([[G,guild]])};
  client.channels={fetch:async id=>guild.channels.cache.get(id)};
  const commands=getCommandRegistry(client);
  const sourceCalls=[];
  commands.register({name:"cargoinicial",description:"Configura cargo inicial.",category:"Cargos",permissions:["ManageGuild"],
    prefix:{trigger:"!cargoinicial",execute:async message=>{sourceCalls.push(message);await message.channel.send({components:[new d.ContainerBuilder().addTextDisplayComponents(new d.TextDisplayBuilder().setContent("Configuração real"))],flags:d.MessageFlags.IsComponentsV2});}}});
  const base=ctx=>({components:[new d.ContainerBuilder().setAccentColor(0x123456)
    .addTextDisplayComponents(new d.TextDisplayBuilder().setContent("# Suporte"),new d.TextDisplayBuilder().setContent("Descrição original"))
    .addSeparatorComponents(new d.SeparatorBuilder().setDivider(true))
    .addActionRowComponents(new d.ActionRowBuilder().addComponents(new d.ButtonBuilder().setCustomId("ticket-support").setLabel("Abrir ticket").setStyle(d.ButtonStyle.Primary)))
    .addActionRowComponents(new d.ActionRowBuilder().addComponents(new d.StringSelectMenuBuilder().setCustomId("support-options").setPlaceholder("Selecione").addOptions({label:"Ajuda",value:"help",description:"Equipe de suporte"})))]});
  const hub=install({client,commands,db,definitions:[{id:"support",label:"Suporte",category:"Tickets",render:base}],...options});
  t.after(()=>{hub.close();db.close();});
  function interaction(extra={}){
    return {id:String(200000000000000000n+sequence++),guild,guildId:G,channel,user,member:actor,
      inGuild:()=>true,isButton:()=>true,isModalSubmit:()=>false,values:[],
      replies:[],edits:[],follows:[],deferred:false,replied:false,
      fields:{getTextInputValue:key=>extra.inputs?.[key]||""},
      async deferReply(options){this.deferred=true;this.deferOptions=options;},
      async deferUpdate(){this.deferred=true;},
      async reply(payload){this.replied=true;this.replies.push(payload);return makeMessage(payload);},
      async editReply(payload){this.edits.push(payload);return makeMessage(payload);},
      async followUp(payload){this.follows.push(payload);return makeMessage(payload);},
      async showModal(modal){this.modal=modal.toJSON();this.replied=true;},...extra};
  }
  async function run(session,action,extra={}){
    const current=hub.store.getSession(session.id,G,U);
    const i=interaction({customId:`lc:${action}:${session.id}:${current.revision}`,...extra});
    await hub.controller.handle(i);return i;
  }
  const ctx={guild,user,channel,bot:client.user,client};
  return {db,client,guild,user,actor,channel,commands,hub,posted,messages,interaction,run,ctx,sourceCalls,
    session:data=>hub.store.session(G,U,data),setAllowed:value=>{allowed=value;}};
}
const contents=payload=>flat(payload.components.map(c=>c.toJSON?.()||c)).filter(c=>c.type===10).map(c=>c.content).join("\n");

test("drafts isolate guilds/users, persist, discard and detect concurrent administrator edits",()=>{
  const db=new DatabaseSync(":memory:"),store=new ConfigStore(db);
  let draft=store.draft("g","a","support"),other=store.draft("g","b","support");
  draft=store.editDraft(draft,{color:"#C4A7E7"});
  assert.equal(store.panel("g","support").version,0);
  assert.equal(new ConfigStore(db).getDraft(draft.id,"g","a").data.color,"#C4A7E7");
  assert.throws(()=>store.getDraft(draft.id,"other","a"),/indisponível/);
  store.save(draft);
  assert.equal(store.panel("g","support").data.color,"#C4A7E7");
  assert.equal(store.panel("other","support").version,0);
  assert.throws(()=>store.save(other),/Outro administrador/);
  const stale=store.getDraft(draft.id,"g","a");
  store.editDraft(stale,{});
  assert.throws(()=>store.editDraft(stale,{}),/rascunho mudou/);
  store.discard(store.getDraft(draft.id,"g","a"));
  assert.equal(store.draft("g","a","support").data.color,"#C4A7E7");
  assert.ok(store.history("g","support").length);
  db.close();
});
test("settings and session revisions reject stale writes and cross-user access",()=>{
  const db=new DatabaseSync(":memory:"),store=new ConfigStore(db);
  store.saveSettings("g",{welcomeEnabled:true},0,"a");
  assert.throws(()=>store.saveSettings("g",{},0,"b"),/mudaram/);
  const session=store.session("g","a",{view:"home"});
  assert.throws(()=>store.getSession(session.id,"g","b"),/expirou/);
  store.updateSession(session,{view:"editor"});
  assert.throws(()=>store.getSession(session.id,"g","a",0),/tela já mudou/);
  db.prepare("UPDATE lumiya_sessions SET expiresAt=0").run();
  assert.throws(()=>store.getSession(session.id,"g","a"),/expirou/);
  db.close();
});
test("native /config is private and shows real server state, with unavailable systems absent",async t=>{
  const f=fixture(t),i=f.interaction();
  await f.hub.controller.open(i);
  assert.equal(i.deferOptions.flags,d.MessageFlags.Ephemeral);
  assert.match(contents(i.edits[0]),/Comunidade/);
  assert.match(contents(i.edits[0]),/42/);
  assert.ok(f.commands.commands.has("config"));
  assert.ok(!f.hub.systems().some(s=>/raid/i.test(s.label)));
  assert.ok(!f.hub.systems().some(s=>s.id==="backups"));
  assert.equal(f.posted.length,0);
});
test("fresh permissions, session owner, original guild and stale revisions are enforced on every control",async t=>{
  const f=fixture(t),s=f.session({view:"home"});
  const foreign=f.interaction({customId:`lc:panels:${s.id}:0`,user:{...f.user,id:"other"}});
  await f.hub.controller.handle(foreign);assert.match(contents(foreign.follows[0]),/pertence/);
  f.guild.ownerId="100000000000000009";f.setAllowed(false);
  const denied=await f.run(s,"panels");assert.match(contents(denied.follows[0]),/permissão para acessar/);
  f.setAllowed(true);f.guild.ownerId=U;
  await f.run(s,"panels");
  const old=f.interaction({customId:`lc:panels:${s.id}:0`});await f.hub.controller.handle(old);
  assert.match(contents(old.follows[0]),/tela já mudou/);
});
test("editor modal, preview, save, per-field reset and discard share the production renderer",async t=>{
  const f=fixture(t),draft=f.hub.store.draft(G,U,"support");
  const session=f.session({view:"texts",draftId:draft.id,fieldIndex:0});
  const modal=await f.run(session,"editText");assert.equal(modal.modal.title,"Editar título");
  const edited=await f.run(session,"submitText",{inputs:{text:"# Olá, {server.name}!"}});
  assert.equal(edited.follows.length,0);
  assert.deepEqual(f.hub.store.panel(G,"support").data,{});
  const preview=await f.run(session,"preview");
  assert.match(contents(preview.follows[0]),/Olá, Comunidade/);
  const controls=flat(preview.follows[0].components);
  assert.ok(controls.filter(c=>[2,3].includes(c.type)).every(c=>c.disabled));
  assert.ok(!controls.some(c=>c.custom_id==="ticket-support"));
  await f.run(session,"save");
  const rendered=await f.hub.panels.render("support",f.ctx);
  assert.match(contents(rendered),/Olá, Comunidade/);
  assert.ok(flat(rendered.components).some(c=>c.custom_id==="ticket-support"&&!c.disabled));
  await f.run(session,"resetText");
  assert.match(contents(await f.hub.panels.render("support",f.ctx)),/Olá/);
  await f.run(session,"discard");
  assert.equal(f.hub.store.getDraft(f.hub.store.getSession(session.id,G,U).data.draftId,G,U).data.texts[0],"# Olá, {server.name}!");
});
test("buttons, menu labels and option descriptions change without altering IDs or values",async t=>{
  const f=fixture(t),config={components:{
    "ticket-support":{label:"Falar com a equipe",style:3,emoji:"💜"},
    "support-options":{placeholder:"Como podemos ajudar?",options:{help:{label:"Atendimento",description:"Converse com a equipe"}}}
  }};
  const result=await f.hub.panels.render("support",f.ctx,{config}),nodes=flat(result.components);
  const button=nodes.find(c=>c.custom_id==="ticket-support"),menu=nodes.find(c=>c.custom_id==="support-options");
  assert.equal(button.label,"Falar com a equipe");assert.equal(button.style,3);
  assert.equal(menu.options[0].value,"help");assert.equal(menu.options[0].description,"Converse com a equipe");
  assert.throws(()=>validate({components:{"ticket-support":{custom_id:"evil"}}}),/inválidos/);
  assert.throws(()=>apply([{type:17,components:[{type:10,content:"a".repeat(4001)}]}],{},f.ctx),/4.000/);
});
test("each image slot resolves dynamic avatars with fallback and supports durable assets",async t=>{
  const f=fixture(t);
  const image=await sanitize(await sharp({create:{width:12,height:8,channels:3,background:"#C4A7E7"}}).png().toBuffer());
  const assetId=f.hub.store.addAsset(G,U,image);
  const config={images:{top:{mode:"guildBanner"},main:{mode:"asset",assetId},thumbnail:{mode:"botAvatar"},bottom:{mode:"guildIcon"}}};
  const result=await f.hub.panels.render("support",f.ctx,{config});
  assert.equal(result.files.length,1);
  assert.ok(Buffer.isBuffer(result.files[0].attachment));
  assert.match(JSON.stringify(result.components),new RegExp(assetId));
  assert.ok(flat(result.components).some(c=>c.type===11));
  assert.ok(flat(result.components).filter(c=>c.type===12).length>=2);
  assert.throws(()=>apply([{type:17,components:[{type:10,content:"Title"}]}],config,{...f.ctx,guild:{id:"other"}}),/imagem/);
  assert.equal(f.hub.store.asset("other",assetId),undefined);
  const second=new ConfigStore(f.db);
  assert.equal(second.asset(G,assetId).hash,image.hash);
});
test("variable resolution never fabricates missing resources or enables mentions",async t=>{
  const f=fixture(t);
  const result=await f.hub.panels.render("support",f.ctx,{config:{texts:{0:"{server.name} · {server.members} · {bot.name} · {user.name} · {user.mention} · {channel.name} · {server.banner}"}}});
  assert.match(contents(result),/Comunidade · 42 · Lumiya · Ana/);
  assert.deepEqual(result.allowedMentions,{parse:[]});
  assert.equal(variables("{user.name}|{server.icon}",{}),"visitante|");
  assert.ok(!variables("{server.name}",{guild:{name:"@everyone **x**"}}).includes("@everyone"));
});
test("publication updates the same message, preserves function and supports confirmed deletion and republication",async t=>{
  const f=fixture(t);
  const first=await f.hub.publisher.publish("support",f.ctx,C);
  const second=await f.hub.publisher.publish("support",f.ctx,C);
  assert.notEqual(first.id,second.id);assert.equal(f.posted.length,2);
  const draft=f.hub.store.editDraft(f.hub.store.draft(G,U,"support"),{color:"#C4A7E7"});
  f.hub.store.save(draft);
  const message=f.messages.get(first.messageId);
  await f.hub.publisher.update(first.id,f.ctx);
  assert.equal(f.posted.length,2);assert.equal(message.edits.length,1);
  assert.equal(message.components[0].accent_color,0xC4A7E7);
  const s=f.session({view:"publications",allPublications:true,publicationId:first.id});
  await f.run(s,"deletePublication");assert.equal(message.deleted,false);
  await f.run(s,"confirm");assert.equal(message.deleted,true);
  const next=await f.hub.publisher.republish(first.id,f.ctx);
  assert.notEqual(next.messageId,first.messageId);
  assert.equal(f.hub.store.publication(G,first.id).status,"replaced");
});
test("missing messages and cross-guild publications fail safely and can be republished",async t=>{
  const f=fixture(t),row=await f.hub.publisher.publish("support",f.ctx,C);
  f.messages.delete(row.messageId);
  await assert.rejects(()=>f.hub.publisher.update(row.id,f.ctx),/excluída/);
  assert.equal(f.hub.store.publication(G,row.id).status,"missing");
  await assert.rejects(()=>f.hub.publisher.update(row.id,{...f.ctx,guild:{id:"other"}}),/outro servidor/);
  assert.ok(await f.hub.publisher.republish(row.id,f.ctx));
});
test("onboarding uses one message, no invites, current bot avatar and private quick setup",async t=>{
  const f=fixture(t);
  await Promise.all([f.hub.onboard(f.guild),f.hub.onboard(f.guild)]);
  assert.equal(f.posted.length,1);
  const text=contents(f.posted[0]);
  assert.match(text,/Oii, Comunidade/);
  assert.doesNotMatch(JSON.stringify(f.posted[0]),/discord\.gg|convite|comunidade oficial/);
  const raw=f.posted[0].components;
  assert.ok(flat(raw).some(c=>c.type===11));
  const i=f.interaction({customId:"lc:quick",values:["roles"]});await f.hub.controller.handle(i);
  assert.equal(i.deferOptions.flags,d.MessageFlags.Ephemeral);
  assert.match(contents(i.edits[0]),/Cargos/);
  await f.hub.onboard(f.guild);assert.equal(f.posted.length,1);
});
test("onboarding falls back from inaccessible system channel and never retries an uncertain send blindly",async t=>{
  const f=fixture(t);
  f.guild.systemChannel={...f.channel,id:"blocked",permissionsFor:()=>new d.PermissionsBitField([])};
  f.channel.send=async()=>{throw new Error("connection lost");};
  await f.hub.onboard(f.guild);
  assert.equal(f.db.prepare("SELECT status FROM lumiya_onboarding").get().status,"uncertain");
  f.channel.send=async()=>{throw new Error("must not retry");};
  await f.hub.onboard(f.guild);
  assert.equal(f.db.prepare("SELECT status FROM lumiya_onboarding").get().status,"uncertain");
});
test("existing configuration commands open privately without publishing or changing their permission checks",async t=>{
  const f=fixture(t),s=f.session({view:"system",systemId:"roles"});
  const i=await f.run(s,"launch",{values:["cargoinicial"]});
  assert.equal(f.sourceCalls.length,1);
  assert.equal(f.posted.length,0);
  assert.ok(i.follows.every(p=>p.flags&d.MessageFlags.Ephemeral));
  assert.match(JSON.stringify(i.follows[0]),/Voltar à função/);
  f.setAllowed(false);
  await f.run(s,"launch",{values:["cargoinicial"]});
  assert.equal(f.sourceCalls.length,1);
});
test("member welcome is opt-in, deduplicated per join and uses the panel renderer",async t=>{
  const f=fixture(t),m={id:U,guild:f.guild,user:f.user,joinedTimestamp:1234};
  await f.hub.welcome(m);assert.equal(f.posted.length,0);
  f.hub.store.saveSettings(G,{welcomeEnabled:true,welcomeChannel:C},0,U);
  await Promise.all([f.hub.welcome(m),f.hub.welcome(m)]);
  assert.equal(f.posted.length,1);assert.match(contents(f.posted[0]),/Boas-vindas, Ana/);
});
test("private and reserved URLs, dangerous formats and invalid colors/configurations are refused",async()=>{
  for(const address of ["127.0.0.1","10.0.0.1","172.20.0.1","169.254.169.254","192.168.1.1","100.64.0.1","::1","::ffff:127.0.0.1","fe80::1","fc00::1","2001:db8::1","198.51.100.1"])
    assert.equal(publicIP(address),false,address);
  for(const address of ["8.8.8.8","1.1.1.1","2606:4700:4700::1111"])assert.equal(publicIP(address),true);
  for(const url of ["http://example.com/x","file:///image.png","https://u:p@example.com/x","https://localhost/x","https://example.com:8080/x"])
    assert.throws(()=>safeURL(url));
  for(const config of [{color:"red"},{custom_id:"other"},{images:{main:{mode:"url",url:"https://example.com"}}},{components:{x:{style:5}}}])
    assert.throws(()=>validate(config));
  await assert.rejects(()=>sanitize(Buffer.from("<svg></svg>")),/PNG/);
  await assert.rejects(()=>sanitize(Buffer.alloc(6*1024*1024)),/5 MB/);
});
test("appearance, button/menu modals and per-option restoration preserve the original handlers",async t=>{
  const f=fixture(t),draft=f.hub.store.draft(G,U,"support"),s=f.session({view:"appearance",draftId:draft.id});
  const color=await f.run(s,"editColor");assert.match(JSON.stringify(color.modal),/Cor hexadecimal/);
  await f.run(s,"submitColor",{inputs:{color:"#C4A7E7"}});
  await f.run(s,"separator",{values:["none"]});
  await f.run(s,"components");
  await f.run(s,"control",{values:["0"]});
  const button=await f.run(s,"editControl");assert.match(JSON.stringify(button.modal),/Texto do botão/);
  await f.run(s,"submitControl",{inputs:{label:"Preciso de ajuda",style:"2",emoji:"💜"}});
  await f.run(s,"control",{values:["1"]});
  await f.run(s,"controlOption",{values:["0"]});
  const option=await f.run(s,"editOption");assert.match(JSON.stringify(option.modal),/Texto da opção/);
  await f.run(s,"submitOption",{inputs:{label:"Novo nome",description:"Nova descrição",emoji:"✨"}});
  let current=f.hub.store.getDraft(draft.id,G,U);
  let result=await f.hub.panels.render("support",f.ctx,{config:current.data}),nodes=flat(result.components);
  assert.equal(result.components[0].accent_color,0xC4A7E7);
  assert.equal(nodes.filter(c=>c.type===14).length,0,"nenhum separador de cabeçalho extra");
  assert.equal(nodes.find(c=>c.custom_id==="ticket-support").label,"Preciso de ajuda");
  assert.equal(nodes.find(c=>c.custom_id==="support-options").options[0].label,"Novo nome");
  await f.run(s,"resetOption");await f.run(s,"resetColor");
  current=f.hub.store.getDraft(draft.id,G,U);
  result=await f.hub.panels.render("support",f.ctx,{config:current.data});nodes=flat(result.components);
  assert.equal(nodes.find(c=>c.custom_id==="support-options").options[0].label,"Ajuda");
  assert.equal(result.components[0].accent_color,0x123456,"cor original do painel, sem um cabeçalho artificial");
});
test("HTTPS URL and native file upload store validated bytes, not expiring URLs; unused cleanup is scoped",async t=>{
  const png=await sharp({create:{width:10,height:10,channels:3,background:"#C4A7E7"}}).png().toBuffer();
  const urls=[],f=fixture(t,{imageTransport:async url=>{urls.push(url);return png;}});
  const draft=f.hub.store.draft(G,U,"support"),s=f.session({view:"images",draftId:draft.id});
  const modal=await f.run(s,"imageUpload");assert.match(JSON.stringify(modal.modal),/file_types/);
  await f.run(s,"submitUpload",{fields:{getUploadedFiles:()=>new Map([["file",{size:png.length,url:"https://cdn.discordapp.com/attachments/a/image.png"}]])}});
  let saved=f.hub.store.getDraft(draft.id,G,U);
  assert.equal(saved.data.images.main.mode,"asset");
  assert.doesNotMatch(JSON.stringify(saved.data),/cdn\.discordapp\.com/);
  assert.equal(urls.length,1);
  await f.run(s,"imageSlot",{values:["top"]});
  await f.run(s,"submitURL",{inputs:{url:"https://example.com/banner.png"}});
  assert.equal(urls.length,2);
  const invalid=await f.run(s,"submitURL",{inputs:{url:"http://localhost/private"}});
  assert.equal(urls.length,2);assert.match(contents(invalid.follows[0]),/HTTPS/);
  await f.run(s,"save");
  const rendered=await f.hub.panels.render("support",f.ctx);assert.equal(rendered.files.length,2);
  await f.run(s,"hideImages");await f.run(s,"save");
  await f.run(s,"pruneAssets");
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM lumiya_assets WHERE guildId=?").get(G).n,0);
  assert.equal((await f.hub.panels.render("support",f.ctx)).files.length,0);
});
test("root reset requires confirmation and never modifies the live panel until saved",async t=>{
  const f=fixture(t);
  let draft=f.hub.store.editDraft(f.hub.store.draft(G,U,"support"),{color:"#C4A7E7"});
  f.hub.store.save(draft);
  const s=f.session({view:"editor",draftId:draft.id});
  await f.run(s,"reset");
  assert.equal(f.hub.store.getDraft(draft.id,G,U).data.color,"#C4A7E7");
  await f.run(s,"confirm");assert.deepEqual(f.hub.store.getDraft(draft.id,G,U).data,{});
  assert.equal(f.hub.store.panel(G,"support").data.color,"#C4A7E7");
  await f.run(s,"save");assert.deepEqual(f.hub.store.panel(G,"support").data,{});
});
test("all configuration views fit native Components V2 limits and have working navigation",async t=>{
  const f=fixture(t),draft=f.hub.store.draft(G,U,"support");
  const views=["home","system","systemSettings","systemPanels","panels","editor","texts","appearance","images","components","variables","publish","publications","adopt","confirm","history","general","welcome","logs","confirmLogs"];
  for(const name of views){
    const s=f.session({view:name,draftId:draft.id,systemId:"roles",confirm:"reset"});
    const payload=await f.hub.controller.view(s,f.interaction()),raw=payload.components.map(c=>c.toJSON?.()||c);
    assert.ok(flat(raw).length<=40,name);
    assert.ok(payload.flags&d.MessageFlags.Ephemeral,name);
    assert.ok(payload.flags&d.MessageFlags.IsComponentsV2,name);
    assert.equal(payload.embeds,undefined);
    assert.ok(flat(raw).filter(c=>c.custom_id).every(c=>c.custom_id.startsWith("lc:")),name);
  }
});
test("granted users may use the central but only the owner can delegate access",async t=>{
  const f=fixture(t);
  f.hub.access.grant(G,U,U,{subjectType:"user",subjectId:U,level:1,permissions:{"*":1},expiresAt:null,reason:"teste"});
  f.guild.ownerId="100000000000000009";
  const i=f.interaction();await f.hub.controller.open(i);assert.ok(i.edits.length);
  const s=f.session({view:"home"});
  const denied=await f.run(s,"access");assert.match(contents(denied.follows[0]),/permissão para acessar/);
  f.guild.ownerId=U;
  assert.equal(f.hub.access.store.accessRows(G).length,1);
});
test("adoption rejects member messages and safely links recognized legacy bot panels",async t=>{
  const f=fixture(t),s=f.session({view:"adopt",channelId:C});
  const row=await f.hub.publisher.publish("support",f.ctx,C);
  const adopted=await f.run(s,"submitAdopt",{inputs:{messageId:row.messageId}});
  assert.match(contents(adopted.edits[0]),/vinculado sem modificar/);
  assert.equal(f.posted.length,1);
  f.messages.get(row.messageId).author={id:"someone"};
  const second=f.session({view:"adopt",channelId:C});
  const denied=await f.run(second,"submitAdopt",{inputs:{messageId:row.messageId}});
  assert.match(contents(denied.follows[0]),/pertencer/);
});
test("legacy render hooks use request context and never recurse when producing a baseline",async t=>{
  const f=fixture(t),runtime=require("../configuration/runtime");
  const draft=f.hub.store.editDraft(f.hub.store.draft(G,U,"support"),{texts:{0:"# {user.name} · {channel.name}"}});
  f.hub.store.save(draft);
  const original=new d.ContainerBuilder().addTextDisplayComponents(new d.TextDisplayBuilder().setContent("Original"));
  const changed=runtime.withContext(f.ctx,()=>runtime.decorate(original,f.guild,"support"));
  assert.match(changed.toJSON().components[0].content,/Ana · geral/);
  assert.equal(runtime.defaults(()=>runtime.decorate(original,f.guild,"support")),original);
});
test("session-bearing component IDs keep stable presentation keys; links keep their original destinations",()=>{
  const {controlKey}=require("../configuration/render");
  const first={type:2,custom_id:"cc:all:cc990b4e-5a30-4d81-a9a3-9970f74d6386",label:"Ver tudo",style:2};
  const second={...first,custom_id:"cc:all:8b82ee44-c378-45ae-ae5f-e9fe9bfd88c9"};
  assert.equal(controlKey(first),controlKey(second));
  const link={type:2,label:"Termos",style:5,url:"https://discord.com/terms"};
  const raw=[{type:17,components:[{type:10,content:"Título"},{type:1,components:[second,link]}]}];
  const out=apply(raw,{components:{[controlKey(first)]:{label:"Explorar"},[controlKey(link)]:{label:"Ler termos"}}},{});
  const buttons=flat(out.components).filter(c=>c.type===2);
  assert.equal(buttons[0].custom_id,second.custom_id);
  assert.equal(buttons[0].label,"Explorar");assert.equal(buttons[1].url,link.url);assert.equal(buttons[1].style,5);
});
test("optional text cannot remove an essential section button and empty option descriptions are removed",()=>{
  const raw=[{type:17,components:[{type:10,content:"Título"},{type:9,components:[{type:10,content:"Campo essencial"}],accessory:{type:2,custom_id:"essential",label:"Ação",style:2}}]}];
  assert.throws(()=>apply(raw,{hideTexts:[1]},{}),/necessário/);
  const menu=[{type:17,components:[{type:10,content:"Menu"},{type:1,components:[{type:3,custom_id:"menu",options:[{label:"Opção",value:"same",description:"Original"}]}]}]}];
  const output=apply(menu,{components:{menu:{options:{same:{description:""}}}}},{});
  assert.equal(flat(output.components).find(c=>c.type===3).options[0].description,undefined);
});
test("the same administrator cannot silently overwrite a draft from a second stale session",async t=>{
  const f=fixture(t),draft=f.hub.store.draft(G,U,"support");
  const a=f.session({view:"texts",draftId:draft.id,draftRevision:0,fieldIndex:0});
  const b=f.session({view:"texts",draftId:draft.id,draftRevision:0,fieldIndex:0});
  await f.run(a,"submitText",{inputs:{text:"# Primeira alteração"}});
  const stale=await f.run(b,"submitText",{inputs:{text:"# Alteração antiga"}});
  assert.match(contents(stale.follows[0]),/outra sessão/);
  assert.equal(f.hub.store.getDraft(draft.id,G,U).data.texts[0],"# Primeira alteração");
  await f.run(b,"editor");
  await f.run(b,"submitText",{inputs:{text:"# Alteração revisada"}});
  assert.equal(f.hub.store.getDraft(draft.id,G,U).data.texts[0],"# Alteração revisada");
});
test("drafts, image bytes, settings and publication metadata survive closing and reopening SQLite",async()=>{
  const fs=require("node:fs"),os=require("node:os"),path=require("node:path");
  const base=path.join(os.tmpdir(),"opencode");fs.mkdirSync(base,{recursive:true});
  const dir=fs.mkdtempSync(path.join(base,"lumiya-persistence-")),file=path.join(dir,"state.sqlite");
  try{
    let db=new DatabaseSync(file),store=new ConfigStore(db);
    const image=await sanitize(await sharp({create:{width:3,height:3,channels:3,background:"#C4A7E7"}}).png().toBuffer());
    const assetId=store.addAsset(G,U,image);
    const draft=store.editDraft(store.draft(G,U,"support"),{images:{main:{mode:"asset",assetId}}});
    const session=store.session(G,U,{view:"editor",draftId:draft.id});
    store.save(draft);store.saveSettings(G,{welcomeEnabled:true,welcomeChannel:C},0,U);
    const publicationId=store.record(G,"support",C,"100000000000000005",U);
    db.close();
    db=new DatabaseSync(file);store=new ConfigStore(db);
    assert.equal(store.asset(G,assetId).hash,image.hash);
    assert.equal(store.panel(G,"support").data.images.main.assetId,assetId);
    assert.equal(store.getSession(session.id,G,U).data.draftId,draft.id);
    assert.equal(store.getDraft(draft.id,G,U).baseVersion,1);
    assert.equal(store.settings(G).welcomeEnabled,true);
    assert.equal(store.publication(G,publicationId).messageId,"100000000000000005");
    db.close();
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test("log configuration writes through the existing log module and refuses public destinations",async t=>{
  const apis={},f=fixture(t,{apis});
  f.db.exec("CREATE TABLE ticket_management_config(guildId TEXT PRIMARY KEY,config TEXT NOT NULL)");
  apis.logs=require("../server-logs")({client:f.client,registry:f.commands,db:f.db,logger:{warn(){}}});
  f.channel.permissionsFor=target=>new d.PermissionsBitField(target?.id===G?[]:d.PermissionsBitField.All);
  const s=f.session({view:"logs",logKind:"general"});
  await f.run(s,"logChannel",{values:[C]});
  assert.equal(apis.logs.store.get(G,"general"),C);
  assert.equal(JSON.parse(f.db.prepare("SELECT config FROM ticket_management_config WHERE guildId=?").get(G).config).generalLog,C);
  const before=f.db.prepare("SELECT COUNT(*) n FROM lumiya_audit").get().n;
  f.channel.permissionsFor=()=>new d.PermissionsBitField(d.PermissionsBitField.All);
  const denied=await f.run(s,"logChannel",{values:[C]});
  assert.match(contents(denied.follows[0]),/canal privado/);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM lumiya_audit").get().n,before);
});
test("owner grants and member-welcome controls persist using settings revisions",async t=>{
  const f=fixture(t);f.guild.ownerId=U;
  const s=f.session({view:"general",settingsVersion:0});
  await f.run(s,"authorizeUsers",{values:["100000000000000006"]});
  assert.deepEqual(f.hub.store.settings(G).authorizedUsers,["100000000000000006"]);
  const payload=await f.hub.controller.view(f.hub.store.getSession(s.id,G,U),f.interaction());
  assert.match(JSON.stringify(payload),/default_values/);
  await f.run(s,"category",{values:["welcome"]});
  await f.run(s,"welcomeChannel",{values:[C]});
  await f.run(s,"toggleWelcome");
  assert.equal(f.hub.store.settings(G).welcomeEnabled,true);
  assert.equal(f.hub.store.settings(G).welcomeChannel,C);
});
test("unknown categories are discovered from real commands without automatically executing operational actions",async t=>{
  const f=fixture(t);let executed=0;
  f.commands.register({name:"economia",description:"Consulta moedas.",category:"Economia",prefix:{trigger:"!moedas",execute:async()=>{executed++;}}});
  const system=f.hub.systems().find(s=>s.label==="Economia");
  assert.ok(system);assert.equal(system.commands.length,0);assert.deepEqual(system.entries,["economia"]);
  const s=f.session({view:"system",systemId:system.id}),payload=await f.hub.controller.view(s,f.interaction());
  assert.match(contents(payload),/!moedas/);assert.equal(executed,0);
});

test("home exposes themed navigation and search without breadcrumb clutter",async t=>{
  const f=fixture(t),s=f.session({view:"home"}),payload=await f.hub.controller.view(s,f.interaction());
  const text=contents(payload),controls=require("../configuration/ui").flat(payload.components).filter(c=>[2,3,5,6].includes(c.type));
  assert.doesNotMatch(text,/Painel ›/);
  assert.match(text,/Central da Lumiya ♡/);
  for(const label of ["Funções","Aparência","Todos os painéis","Acesso","Pesquisar","Atualizar"])
    assert.ok(controls.some(c=>c.label===label),label);
  await f.run(s,"functions");
  await f.run(s,"appearanceRoot");
  await f.run(s,"templates");
  await f.run(s,"access");
  assert.equal(f.hub.store.getSession(s.id,G,U).data.view,"access");
  const modal=await f.run(s,"search");assert.match(JSON.stringify(modal.modal),/O que você procura/);
  await f.run(s,"submitSearch",{inputs:{query:"instagram"}});
  assert.equal(f.hub.store.getSession(s.id,G,U).data.query,"instagram");
});

test("system panels show real status containers and navigating back restores the previous screen",async t=>{
  const f=fixture(t),s=f.session({view:"home"});
  await f.run(s,"category",{values:["roles"]});
  let payload=await f.hub.controller.view(f.hub.store.getSession(s.id,G,U),f.interaction());
  assert.doesNotMatch(contents(payload),/Painel ›/);
  assert.match(contents(payload),/Estado do sistema/);
  assert.match(contents(payload),/Sistema · ativo|Sistema · desativado/);
  await f.run(s,"back");
  assert.equal(f.hub.store.getSession(s.id,G,U).data.view,"home");
});

test("duplicating a publication creates a second message without removing the original",async t=>{
  const f=fixture(t),first=await f.hub.publisher.publish("support",f.ctx,C);
  const s=f.session({view:"publications",allPublications:true,publicationId:first.id});
  await f.run(s,"duplicate");
  assert.equal(f.hub.store.getSession(s.id,G,U).data.view,"publish");
  await f.run(s,"publishNow");
  assert.equal(f.posted.length,2);
  assert.equal(f.messages.has(first.messageId),true);
  assert.equal(f.hub.store.publications(G,"support").length,2);
});
test("registered templates retain their content without an extra navigation container",async t=>{
  const f=fixture(t),ui=require("../configuration/ui");
  for(const definition of f.hub.panels.list()){
    const payload=await f.hub.panels.render(definition.id,f.ctx),nodes=ui.flat(payload.components);
    assert.doesNotMatch(contents(payload),/^-# Painel › /m,definition.id);
    assert.equal(payload.components.length,(await f.hub.panels.baseline(definition.id,f.ctx)).components.length,definition.id);
    const baseline=await f.hub.panels.baseline(definition.id,f.ctx);
    assert.equal(payload.components[0].accent_color,baseline.components[0].accent_color??0xC4A7E7,definition.id);
    assert.ok(nodes.filter(node=>node.type===14).every(node=>node.divider===true&&node.spacing===1),definition.id);
    assert.ok(nodes.filter(node=>[2,3,5,6,7,8].includes(node.type)).every(node=>node.custom_id),definition.id);
    assert.equal(payload.embeds,undefined,definition.id);
    assert.ok(payload.flags&d.MessageFlags.IsComponentsV2,definition.id);
  }
});

function ticketFixture(t){
  const f=fixture(t);
  f.commands.register({name:"ticketconfig",description:"Configura os tickets.",category:"Suporte",permissions:["ManageGuild"],
    prefix:{trigger:"!ticketconfig",execute:async message=>{f.sourceCalls.push(message);await message.reply("Configuração real dos tickets");}}});
  f.commands.register({name:"gestao-tickets",description:"Gerencia os tickets.",category:"Suporte",
    prefix:{trigger:"!gestao",execute:async()=>{}}});
  for(const [id,label]of [["migration","Migração"],["unmute","Desmutar"]])
    f.hub.panels.register({id,label,category:id==="migration"?"Tickets":"Moderação",
      render:()=>({components:[new d.ContainerBuilder().addTextDisplayComponents(new d.TextDisplayBuilder().setContent(`### ${label}`))]})});
  return f;
}
const panelNodes=payload=>require("../configuration/ui").flat(payload.components);

test("Tickets groups configuration, publication and customization without executing any command",async t=>{
  const f=ticketFixture(t),s=f.session({view:"home"});
  const i=await f.run(s,"category",{values:["tickets"]});
  const nodes=panelNodes(i.edits[0]);
  for(const label of ["Configurar","Publicar painel","Personalizar","Painéis publicados"])
    assert.ok(nodes.some(node=>node.type===2&&node.label===label&&!node.disabled),label);
  assert.match(contents(i.edits[0]),/Suporte/);assert.match(contents(i.edits[0]),/Migração/);
  assert.equal(f.sourceCalls.length,0);assert.equal(f.posted.length,0);
  const settings=await f.run(s,"systemSettings");
  assert.ok(panelNodes(settings.edits[0]).some(node=>node.options?.some(option=>option.value==="ticketconfig"&&option.label==="Configurar tickets e permissões")));
  const open=await f.run(s,"launch",{values:["ticketconfig"]});
  assert.equal(f.sourceCalls.length,1);assert.equal(f.posted.length,0);
  assert.match(JSON.stringify(open.follows[0]),/Voltar à função/);
});

test("Tickets publishes directly in a selected channel and never offers another function's panel",async t=>{
  const f=ticketFixture(t),s=f.session({view:"system",systemId:"tickets"});
  const choose=await f.run(s,"systemPublish");
  const options=panelNodes(choose.edits[0]).find(node=>node.type===3).options;
  assert.deepEqual(options.map(option=>option.value),["support","migration"]);
  const forged=await f.run(s,"systemPanel",{values:["unmute"]});
  assert.equal(forged.edits.length,0);assert.equal(f.posted.length,0);
  const selected=await f.run(s,"systemPanel",{values:["support"]});
  assert.match(contents(selected.edits[0]),/Publicar • Suporte/);
  assert.equal(f.posted.length,0);
  await f.run(s,"publishChannel",{values:[C]});
  await f.run(s,"publishNow");
  assert.equal(f.posted.length,1);
  const current=f.hub.store.getSession(s.id,G,U);
  assert.equal(current.data.view,"publications");assert.equal(current.data.publicationSystem,"tickets");
  assert.ok(panelNodes(f.posted[0]).some(node=>node.custom_id==="ticket-support"));
});

test("published panels stay scoped to the chosen function and reject forged publication IDs",async t=>{
  const f=ticketFixture(t),support=f.hub.store.record(G,"support",C,"100000000000088881",U),
    foreign=f.hub.store.record(G,"unmute",C,"100000000000088882",U);
  const s=f.session({view:"system",systemId:"tickets"});
  const i=await f.run(s,"systemPublications");
  const options=panelNodes(i.edits[0]).find(node=>node.type===3).options;
  assert.equal(options.length,1);assert.equal(options[0].value,support);
  const attempt=await f.run(s,"publication",{values:[foreign]});
  assert.equal(attempt.edits.length,0);
  assert.equal(f.hub.store.getSession(s.id,G,U).data.publicationId,undefined);
  await f.run(s,"publication",{values:[support]});
  assert.equal(f.hub.store.getSession(s.id,G,U).data.publicationId,support);
});

test("function navigation returns naturally and Home clears filters from the previous function",async t=>{
  const f=ticketFixture(t),s=f.session({view:"system",systemId:"tickets"});
  await f.run(s,"systemEditPanels");
  await f.run(s,"systemPanel",{values:["migration"]});
  await f.run(s,"texts");await f.run(s,"back");
  assert.equal(f.hub.store.getSession(s.id,G,U).data.view,"editor");
  await f.run(s,"systemHome");
  assert.equal(f.hub.store.getSession(s.id,G,U).data.view,"system");
  await f.run(s,"systemPublications");await f.run(s,"home");
  const data=f.hub.store.getSession(s.id,G,U).data;
  assert.equal(data.view,"home");assert.equal(data.systemId,undefined);assert.equal(data.publicationSystem,undefined);
});

test("home's published-panels shortcut opens publications rather than the template editor",async t=>{
  const f=fixture(t),s=f.session({view:"home"});
  const payload=await f.hub.controller.view(s,f.interaction()),button=panelNodes(payload).find(node=>node.label==="Painéis publicados");
  assert.match(button.custom_id,/^lc:allPublications:/);
  await f.run(s,"allPublications");
  assert.equal(f.hub.store.getSession(s.id,G,U).data.view,"publications");
  assert.equal(f.hub.store.getSession(s.id,G,U).data.draftId,undefined);
});

test("log setup requires explicit confirmation, supports cancellation and reports partial failures honestly",async t=>{
  let activated=0;
  const logs={store:{get:()=>null,automatic:()=>false},kinds:{general:"logs-gestao",roles:"logs-cargos"},
    labels:{general:"Gestão",roles:"Cargos"},
    enableGuild:async()=>{activated++;return {ok:false,configured:1,total:2,failed:["roles"]};}};
  const f=fixture(t,{apis:{logs}}),s=f.session({view:"logs"});
  let i=await f.run(s,"activateLogs");assert.equal(activated,0);assert.equal(i.edits.length,0);
  i=await f.run(s,"provisionLogs");assert.equal(activated,0);
  assert.match(contents(i.edits[0]),/Ativar logs neste servidor/);
  await f.run(s,"logs");assert.equal(activated,0);
  await f.run(s,"provisionLogs");
  i=await f.run(s,"activateLogs");assert.equal(activated,1);
  assert.match(contents(i.edits[0]),/Ops! Preparei 1 de 2 canais/);
  assert.doesNotMatch(contents(i.edits[0]),/Prontinho/);
});

test("log activation rechecks current channel permissions and rejects duplicate confirmation",async t=>{
  let activated=0;
  const logs={store:{get:()=>null,automatic:()=>false},kinds:{general:"logs-gestao"},
    enableGuild:async()=>{activated++;return {ok:true,configured:1,total:1};}};
  const f=fixture(t,{apis:{logs}}),s=f.session({view:"logs"});
  await f.run(s,"provisionLogs");f.setAllowed(false);
  await f.run(s,"activateLogs");assert.equal(activated,0);
  f.setAllowed(true);await f.run(s,"activateLogs");assert.equal(activated,1);
  await f.run(s,"activateLogs");assert.equal(activated,1);
});
