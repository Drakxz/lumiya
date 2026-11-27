const test=require("node:test"),assert=require("node:assert/strict");
const {PermissionFlagsBits,MessageFlags}=require("discord.js");
const {EventEmitter}=require("node:events");
const {VoiceHoursStore}=require("../voice-hours/store");
const install=require("../rankings");
test("rankings isolate guilds, count humans once and include live voice time",async t=>{
  const hours=new VoiceHoursStore(":memory:");t.after(()=>hours.db.close());
  const client=new EventEmitter(),commands=new Map();
  const api=install({client,db:hours.db,registry:{register(c){commands.set(c.name,c);},preserveMessage(){}}});
  const m={id:"message",guildId:"guild",author:{id:"user"}};
  api.countMessage(m);api.countMessage(m);api.countMessage({...m,id:"bot-message",author:{id:"bot",bot:true}});
  api.countMessage({...m,id:"other",guildId:"other-guild"});
  assert.equal(hours.db.prepare("SELECT total FROM ranking_messages WHERE guildId='guild'").get().total,1);
  hours.db.prepare("INSERT INTO totals VALUES('guild','user',3600000,0)").run();
  hours.db.prepare("INSERT INTO active VALUES('guild','user','voice',0,1000,NULL,1000)").run();
  assert.equal(api.calls("guild",2000)[0].total,3601000);
  const members=new Map([["user",{user:{bot:false},roles:{cache:new Map([["family",{}]])}}]]);
  const p=await api.panel({id:"guild",roles:{cache:new Map([["family",{}]])},members:{fetch:async()=>members}});
  const json=JSON.stringify(p.components[0].toJSON());
  assert.match(json,/TOP 3 CALLS/);assert.match(json,/TOP 3 MENSAGENS/);assert.doesNotMatch(json,/FAMÍLIAS/);
  assert.deepEqual(p.allowedMentions,{parse:[]});assert.equal(commands.has("topconfig"),false);
});

test("restores saved live panel after restart and backfills offline messages",async t=>{
  const hours=new VoiceHoursStore(":memory:");t.after(()=>{api.close();hours.db.close();});
  hours.db.exec("CREATE TABLE ranking_messages(guildId TEXT NOT NULL,userId TEXT NOT NULL,total INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(guildId,userId)); CREATE TABLE ranking_message_seen(messageId TEXT PRIMARY KEY,createdAt INTEGER NOT NULL); CREATE TABLE ranking_panels(guildId TEXT PRIMARY KEY,channelId TEXT NOT NULL,messageId TEXT NOT NULL,userId TEXT NOT NULL,paused INTEGER NOT NULL DEFAULT 0,updatedAt INTEGER NOT NULL);");
  hours.db.prepare("INSERT INTO ranking_panels VALUES('g','channel','saved-panel','owner',0,?)").run(Date.now());
  const client=new EventEmitter(),commands=new Map(),edited=[];
  const guild={id:"g",channels:{cache:new Map()},roles:{cache:new Map()}};
  const panelMessage={id:"saved-panel",guild,async edit(payload){edited.push(payload);}};
  const ch={id:"channel",isTextBased:()=>true,messages:{async fetch(arg){if(arg?.limit===100)return new Map([["offline",{id:"offline",guildId:"g",createdTimestamp:Date.now(),author:{id:"human"},channelId:"channel"}]]);return {id:"channel",messages:{fetch:async()=>panelMessage}};}}};
  guild.channels.cache.set(ch.id,ch);
  client.guilds={cache:new Map([["g",guild]])};
  client.channels={async fetch(){return {messages:{fetch:async()=>panelMessage}};}};
  const api=install({client,db:hours.db,registry:{register(c){commands.set(c.name,c);},preserveMessage(){}}});
  for(const fn of client.listeners("clientReady"))await fn();
  assert.equal(api.aoVivo.has("saved-panel"),true);
  assert.equal(hours.db.prepare("SELECT total FROM ranking_messages WHERE guildId='g' AND userId='human'").get().total,1);
  assert.equal(api.publicos.get("g").id,"saved-panel");
});

test("!top stays live without buttons; /topadmin exposes private admin controls",async t=>{
  const hours=new VoiceHoursStore(":memory:");t.after(()=>{api.close();hours.db.close();});
  const client=new EventEmitter(),commands=new Map(),edited=[],replies=[];
  const guild={id:"g",name:"Servidor",roles:{cache:new Map()},members:{fetch:async()=>new Map()}};
  client.guilds={cache:new Map([["g",guild]])};
  const message={id:"top-message",channel:{id:"channel"},guildId:"g",author:{id:"author",bot:false},
    async edit(payload){edited.push(payload);return this;}};
  const discordMessage={id:"top-message",guild,async edit(payload){edited.push(payload);return this;}};
  client.channels={async fetch(id){assert.equal(id,"channel");return {messages:{async fetch(messageId){assert.equal(messageId,"top-message");return discordMessage;}}};}};
  const api=install({client,db:hours.db,registry:{register(c){commands.set(c.name,c);},preserveMessage(){}}});
  hours.db.prepare("INSERT INTO totals VALUES('g','user',3600000,0)").run();
  hours.db.prepare("INSERT INTO ranking_messages VALUES('g','user',1)").run();
  const sent=[];
  const command=commands.get("top").prefix;
  await command.execute({guild,author:{id:"author",bot:false},channel:{id:"channel",async send(payload){sent.push(payload);return message;}}});
  assert.equal(sent.length,1);assert.equal(edited.length,1);
  assert.equal(api.aoVivo.size,1);
  assert.equal(api.publicos.get("g").id,"top-message");
  const publicJson=JSON.stringify(edited[0].components[0].toJSON());
  assert.match(publicJson,/Atualizando em tempo real/);
  assert.doesNotMatch(publicJson,/rank:pause/);

  hours.db.prepare("UPDATE ranking_messages SET total=7 WHERE guildId='g'").run();
  await api.refresh("top-message");
  assert.equal(edited.length,2);
  assert.match(JSON.stringify(edited[1].components[0].toJSON()),/7 msgs/);

  const admin={permissions:{has:bit=>bit===PermissionFlagsBits.Administrator}};
  const slash=commands.get("topadmin").slash;
  const slashInteraction={guildId:"g",guild,member:admin,
    async deferReply(options){this.defer=options;},async editReply(payload){replies.push(payload);},async reply(payload){replies.push(payload);}};
  await slash.execute(slashInteraction);
  assert.ok(replies.at(-1).flags&MessageFlags.Ephemeral);
  const controls=JSON.stringify(replies.at(-1).components[0].toJSON());
  assert.match(controls,/rank:pause:top-message/);assert.match(controls,/rank:stop:top-message/);

  const interaction=(acao,administrador=true)=>({isButton:()=>true,customId:`rank:${acao}:top-message`,guildId:"g",guild,
    user:{id:"qualquer"},member:{permissions:{has:bit=>administrador&&bit===PermissionFlagsBits.Administrator}},
    async deferUpdate(){this.deferred=true;},async editReply(payload){replies.push(payload);},async reply(payload){replies.push(payload);}});
  const outsider=interaction("pause",false);
  for(const fn of client.listeners("interactionCreate"))await fn(outsider);
  assert.match(replies.at(-1).content,/Somente administradores/);
  assert.equal(api.aoVivo.get("top-message").paused,false);

  const pause=interaction("pause");
  for(const fn of client.listeners("interactionCreate"))await fn(pause);
  assert.equal(api.aoVivo.get("top-message").paused,true);
  assert.match(JSON.stringify(replies.at(-1).components[0].toJSON()),/Atualização pausada/);

  const stop=interaction("stop");
  for(const fn of client.listeners("interactionCreate"))await fn(stop);
  assert.equal(api.aoVivo.size,0);
  assert.doesNotMatch(JSON.stringify(replies.at(-1).components[0].toJSON()),/rank:pause/);
});
