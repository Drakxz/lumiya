const test=require("node:test");
const assert=require("node:assert/strict");
const {DatabaseSync}=require("node:sqlite");
const fs=require("node:fs");
const os=require("node:os");
const path=require("node:path");
const createConfig=require("../backups/bot-config");
const resources=require("../resource-ids");

function fixture(t){
  const db=new DatabaseSync(":memory:");
  t.after(()=>db.close());
  db.exec(`
    CREATE TABLE media_moderation_settings(guildId TEXT PRIMARY KEY,enabled INTEGER,settings TEXT,updatedAt INTEGER);
    CREATE TABLE media_moderation_channels(guildId TEXT,channelId TEXT,kind TEXT,PRIMARY KEY(guildId,channelId,kind));
    CREATE TABLE ticket_management_config(guildId TEXT PRIMARY KEY,config TEXT);
    CREATE TABLE command_center_panels(id TEXT PRIMARY KEY,guildId TEXT,channelId TEXT,messageId TEXT,hash TEXT);
    CREATE TABLE historical_events(guildId TEXT,channelId TEXT,actorId TEXT);
  `);
  db.prepare("INSERT INTO media_moderation_settings VALUES(?,1,?,1)").run("g",JSON.stringify({
    logChannelId:"old-log",superficialChannelIds:["old-media"],reviewRoleIds:["old-role"],
    externalReview:{guildId:"foreign",channelId:"foreign-channel",roleId:"foreign-role"}
  }));
  db.exec(`INSERT INTO media_moderation_channels VALUES('g','old-media','channel'),('other','untouched','channel');
    INSERT INTO ticket_management_config VALUES('g','{"supportRole":"old-role","adminUserIds":["user"]}');
    INSERT INTO command_center_panels VALUES('panel','g','old-media','old-message','hash');
    INSERT INTO historical_events VALUES('g','old-log','user');`);
  const botData={ticketRoles:{g:{support:["old-role"]},other:{support:["foreign-role"]}},
    ticketGoalsByRole:{g:{"old-role":3}},
    tickets:{thread:{guildId:"g",donoId:"user",sistema:"support",parentId:"old-media"}},claims:{thread:{userId:"staff"}}};
  const manager=createConfig({db,botData});
  const guild={id:"g",channels:{cache:new Map([["new-media",{}],["new-log",{}]])},roles:{cache:new Map([["new-role",{}]])}};
  const backup={originGuildId:"g",roles:[{id:"old-role"}],channels:[{id:"old-media"},{id:"old-log"}]};
  const maps={roleMap:{"old-role":"new-role"},channelMap:{"old-media":"new-media","old-log":"new-log"}};
  return {db,botData,manager,guild,backup,maps};
}

test("snapshots capture only allowlisted configuration scoped to the server, never histories or credentials",t=>{
  const f=fixture(t),snapshot=f.manager.capture("g");
  assert.equal(snapshot.guildId,"g");
  assert.equal(snapshot.tables.historical_events,undefined);
  assert.equal(snapshot.data.tickets,undefined);
  assert.equal(snapshot.data.ticketRoles.support[0],"old-role");
  assert.equal(snapshot.tables.media_moderation_channels.length,1);
  assert.equal(snapshot.panels[0].channelId,"old-media");
});

test("restore remaps media, shallow channels, logs, review roles and ticket configuration in live memory",t=>{
  const f=fixture(t);
  f.backup.botConfiguration=f.manager.capture("g");
  const result=f.manager.apply(f.guild,f.backup,f.maps);
  assert.equal(result.errors.length,0);
  const settings=JSON.parse(f.db.prepare("SELECT settings FROM media_moderation_settings WHERE guildId='g'").get().settings);
  assert.equal(settings.logChannelId,"new-log");
  assert.deepEqual(settings.superficialChannelIds,["new-media"]);
  assert.deepEqual(settings.reviewRoleIds,["new-role"]);
  assert.equal(settings.externalReview.channelId,"foreign-channel");
  assert.equal(f.db.prepare("SELECT channelId FROM media_moderation_channels WHERE guildId='g'").get().channelId,"new-media");
  assert.equal(f.db.prepare("SELECT channelId FROM media_moderation_channels WHERE guildId='other'").get().channelId,"untouched");
  assert.deepEqual(f.botData.ticketRoles.g.support,["new-role"]);
  assert.deepEqual(f.botData.ticketGoalsByRole.g,{"new-role":3});
  assert.deepEqual(f.botData.ticketRoles.other.support,["foreign-role"]);
  assert.equal(f.botData.tickets.thread.parentId,"old-media","history/live thread references must not be fabricated");
  assert.equal(f.db.prepare("SELECT channelId FROM historical_events").get().channelId,"old-log");
  assert.equal(resources(f.db).resolve("g","old-log"),"new-log");
  assert.equal(resources(f.db).resolve("other","old-log"),"old-log");
  const panel=f.db.prepare("SELECT * FROM command_center_panels").get();
  assert.equal(panel.channelId,"new-media");
  assert.equal(panel.messageId,null);
  assert.equal(result.panels[0].channelId,"new-media");
});

test("old backup without configuration snapshot remaps current saved settings",t=>{
  const f=fixture(t);
  const result=f.manager.apply(f.guild,f.backup,f.maps);
  assert.equal(result.snapshot,false);
  assert.deepEqual(f.botData.ticketRoles.g.support,["new-role"]);
});

test("failed resource dependency preserves entire security section and reports partial result",t=>{
  const f=fixture(t);
  delete f.maps.roleMap["old-role"];
  const result=f.manager.apply(f.guild,f.backup,f.maps);
  assert.ok(result.errors.some(e=>e.includes("old-role")));
  assert.equal(JSON.parse(f.db.prepare("SELECT config FROM ticket_management_config").get().config).supportRole,"old-role");
  assert.deepEqual(f.botData.ticketRoles.g.support,["old-role"]);
  assert.equal(f.db.prepare("SELECT channelId FROM media_moderation_channels WHERE guildId='g'").get().channelId,"new-media");
});

test("foreign snapshots and nonexistent target mappings are refused",t=>{
  const f=fixture(t);
  assert.throws(()=>f.manager.apply(f.guild,{...f.backup,originGuildId:"other"},f.maps),/outro servidor/);
  const snapshot=f.manager.capture("g");snapshot.guildId="other";
  assert.throws(()=>f.manager.apply(f.guild,{...f.backup,botConfiguration:snapshot},f.maps),/inválido/);
  assert.throws(()=>f.manager.apply(f.guild,f.backup,{...f.maps,channelMap:{"old-media":"nonexistent"}}),/não pertence/);
  assert.deepEqual(f.botData.ticketRoles.g.support,["old-role"]);
});

test("writes data.json atomically and updates live object without touching other guilds",t=>{
  const f=fixture(t);
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"opencode","backup-config-"));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const dataFile=path.join(dir,"data.json");
  fs.writeFileSync(dataFile,JSON.stringify(f.botData));
  const manager=createConfig({db:f.db,botData:f.botData,dataFile});
  manager.apply(f.guild,f.backup,f.maps);
  const persisted=JSON.parse(fs.readFileSync(dataFile,"utf8"));
  assert.deepEqual(persisted.ticketRoles.g.support,["new-role"]);
  assert.deepEqual(persisted.ticketRoles.other.support,["foreign-role"]);
  assert.equal(fs.readdirSync(dir).length,1);
});

test("file persistence failure rolls back SQLite and does not mutate live configuration",t=>{
  const f=fixture(t);
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"opencode","backup-config-failure-"));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const manager=createConfig({db:f.db,botData:f.botData,dataFile:dir});
  assert.throws(()=>manager.apply(f.guild,f.backup,f.maps));
  assert.deepEqual(f.botData.ticketRoles.g.support,["old-role"]);
  assert.equal(f.db.prepare("SELECT channelId FROM media_moderation_channels WHERE guildId='g'").get().channelId,"old-media");
});

test("legacy env aliases survive another snapshot/restore with a fresh configuration store",t=>{
  const f=fixture(t);
  f.manager.apply(f.guild,f.backup,f.maps);
  const snapshot=f.manager.capture("g");
  const nextDb=new DatabaseSync(":memory:");
  t.after(()=>nextDb.close());
  const next=createConfig({db:nextDb});
  const guild={id:"g",channels:{cache:new Map([["third-media",{}],["third-log",{}]])},roles:{cache:new Map([["third-role",{}]])}};
  const backup={originGuildId:"g",roles:[{id:"new-role"}],channels:[{id:"new-media"},{id:"new-log"}],botConfiguration:snapshot};
  next.apply(guild,backup,{roleMap:{"new-role":"third-role"},channelMap:{"new-media":"third-media","new-log":"third-log"}});
  assert.equal(resources(nextDb).resolve("g","old-log"),"third-log");
});

test("JSON resource IDs are remapped once even when existing target IDs swap",t=>{
  const f=fixture(t);
  f.guild.channels.cache=new Map([["old-media",{}],["old-log",{}]]);
  const maps={roleMap:{"old-role":"new-role"},channelMap:{"old-media":"old-log","old-log":"old-media"}};
  f.manager.apply(f.guild,f.backup,maps);
  const settings=JSON.parse(f.db.prepare("SELECT settings FROM media_moderation_settings").get().settings);
  assert.equal(settings.logChannelId,"old-media");
  assert.deepEqual(settings.superficialChannelIds,["old-log"]);
  assert.equal(resources(f.db).resolve("g","old-log"),"old-media");
});

test("authorized cross-server import scopes configs to destination without copying personal administrators or whitelist grants",t=>{
  const f=fixture(t);
  f.db.exec(`CREATE TABLE role_wl_config(guildId TEXT PRIMARY KEY,data TEXT,updatedAt INTEGER,updatedBy TEXT);
    CREATE TABLE role_wl_users(guildId TEXT,userId TEXT,status TEXT,profile TEXT,PRIMARY KEY(guildId,userId));
    INSERT INTO role_wl_config VALUES('g','{"adminIds":["source-admin"],"hierarchy":["old-role"]}',1,'source-admin');
    INSERT INTO role_wl_users VALUES('g','source-admin','active','{"allowedAddRoleIds":["old-role"]}');`);
  f.backup.botConfiguration=f.manager.capture("g");
  const target={...f.guild,id:"destination"};
  const result=f.manager.apply(target,f.backup,f.maps,{allowCrossGuild:true});
  assert.deepEqual(result.errors,[]);
  const config=JSON.parse(f.db.prepare("SELECT config FROM ticket_management_config WHERE guildId='destination'").get().config);
  assert.equal(config.supportRole,"new-role");
  assert.deepEqual(config.adminUserIds,[]);
  const media=JSON.parse(f.db.prepare("SELECT settings FROM media_moderation_settings WHERE guildId='destination'").get().settings);
  assert.equal(media.externalReview,undefined,"cross-guild review needs fresh authorization in destination");
  const wl=JSON.parse(f.db.prepare("SELECT data FROM role_wl_config WHERE guildId='destination'").get().data);
  assert.deepEqual(wl.adminIds,[]);
  assert.deepEqual(wl.hierarchy,["new-role"]);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM role_wl_users WHERE guildId='destination'").get().n,0);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM role_wl_users WHERE guildId='g'").get().n,1);
  assert.deepEqual(f.botData.ticketRoles.destination.support,["new-role"]);
  assert.deepEqual(f.botData.ticketRoles.g.support,["old-role"]);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM command_center_panels").get().n,2);
  assert.equal(result.panels[0].guildId,"destination");
});

test("automatic initial role configuration follows restored role IDs",t=>{
  const f=fixture(t);
  f.db.exec(`CREATE TABLE initial_role_config(guildId TEXT PRIMARY KEY,roleId TEXT,enabled INTEGER,includeBots INTEGER,updatedAt INTEGER);
    INSERT INTO initial_role_config VALUES('g','old-role',1,1,1);`);
  f.backup.botConfiguration=f.manager.capture("g");
  f.manager.apply(f.guild,f.backup,f.maps);
  const c=f.db.prepare("SELECT * FROM initial_role_config WHERE guildId='g'").get();
  assert.equal(c.roleId,"new-role");
  assert.equal(c.enabled,1);
  assert.equal(c.includeBots,1);
});

test("automatic calls configuration follows restored category IDs",t=>{
  const f=fixture(t);
  f.db.exec(`CREATE TABLE auto_calls_config(guildId TEXT PRIMARY KEY,categoryId TEXT,enabled INTEGER,updatedAt INTEGER);
    INSERT INTO auto_calls_config VALUES('g','old-channel',1,1);`);
  f.backup.botConfiguration=f.manager.capture("g");
  f.maps.channelMap["old-channel"]="new-channel";
  f.guild.channels.cache.set("new-channel",{});
  f.backup.channels.push({id:"old-channel"});
  f.manager.apply(f.guild,f.backup,f.maps);
  const c=f.db.prepare("SELECT * FROM auto_calls_config WHERE guildId='g'").get();
  assert.equal(c.categoryId,"new-channel");
  assert.equal(c.enabled,1);
});
