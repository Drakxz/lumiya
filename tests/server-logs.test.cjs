const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { DatabaseSync } = require("node:sqlite");
const { ChannelType, PermissionFlagsBits } = require("discord.js");
const install = require("../server-logs");

function fixture(t, canManage = true) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec(`CREATE TABLE ticket_management_config(guildId TEXT PRIMARY KEY,config TEXT);
    INSERT INTO ticket_management_config VALUES('guild','{"supportTeam":["staff"]}');
    CREATE TABLE nickname_protection_config(guildId TEXT PRIMARY KEY,enabled INTEGER DEFAULT 0,terms TEXT DEFAULT '[]',logChannelId TEXT,warningChannelId TEXT);
    CREATE TABLE server_backup_settings(guildId TEXT PRIMARY KEY,notifyChannel TEXT);`);
  const client = new EventEmitter(), channels = new Map(), created = [], warnings = [];
  const guild = {
    id: "guild",
    members: { me: { id: "bot", permissions: { has: () => canManage } } },
    channels: {
      fetch: async () => channels,
      create: async options => {
        created.push(options);
        const channel = {
          id: `channel-${created.length}`, type: options.type, name: options.name,
          parentId: options.parent, rawPosition: 0,
          permissionOverwrites: { set: async value => { channel.overwrites = value; } },
          setPosition: async position => { channel.position = position; },
          setName: async name => { channel.name = name; },
          edit: async value => { channel.parentId = value.parent; channel.overwrites = value.permissionOverwrites; if (value.name) channel.name = value.name; }
        };
        channels.set(channel.id, channel);
        return channel;
      }
    }
  };
  const api = install({ client, db, logger: { warn: message => warnings.push(message) } });
  client.guilds={cache:new Map([[guild.id,guild]])};
  return { db, client,guild, api, channels, created, warnings };
}

test("creates private category at the bottom and connects every existing Discord log", async t => {
  const f = fixture(t);
  f.channels.set("public", { type: ChannelType.GuildCategory, rawPosition: 30 });
  const result=await f.api.enableGuild(f.guild);
  assert.equal(result.ok,true);
  assert.equal(f.warnings.length, 0);
  assert.equal(f.created.length, Object.keys(install.CHANNELS).length + 1);
  const category = f.channels.get(f.api.store.get("guild", "category"));
  assert.equal(category.name, "Logs da Lumiya");
  assert.equal(f.channels.get(f.api.store.get("guild", "boosts")).name, "logs-impulsionamentos");
  assert.equal(category.position, 31);
  for (const options of f.created) {
    assert.deepEqual(options.permissionOverwrites[0], { id: "guild", deny: [PermissionFlagsBits.ViewChannel] });
    assert.equal(options.permissionOverwrites[1].id, "bot");
    assert.equal(options.permissionOverwrites.length, 2);
  }
  const config = JSON.parse(f.db.prepare("SELECT config FROM ticket_management_config").get().config);
  assert.deepEqual(config.supportTeam, ["staff"]);
  for (const area of ["support", "migration", "movchat", "passtime", "general"]) {
    assert.equal(config[`${area}Log`], f.api.store.get("guild", area));
  }
  assert.equal(f.db.prepare("SELECT logChannelId FROM nickname_protection_config").get().logChannelId, f.api.store.get("guild", "nickname"));
  assert.equal(f.db.prepare("SELECT notifyChannel FROM server_backup_settings").get().notifyChannel, f.api.store.get("guild", "backups"));
  assert.equal(JSON.parse(f.db.prepare("SELECT settings FROM media_moderation_settings").get().settings).logChannelId, f.api.store.get("guild", "media"));
});

test("does not duplicate on repeated setup and recreates missing log channels", async t => {
  const f = fixture(t);
  await Promise.all([f.api.enableGuild(f.guild), f.api.enableGuild(f.guild)]);
  const count = f.created.length;
  await f.api.ensureGuild(f.guild);
  assert.equal(f.created.length, count);
  f.channels.delete(f.api.store.get("guild", "roles"));
  await f.api.ensureGuild(f.guild);
  assert.equal(f.created.length, count + 1);
});

test("does not attempt creation without ManageChannels", async t => {
  const f = fixture(t, false);
  const result=await f.api.enableGuild(f.guild);
  assert.equal(result.ok,false);assert.equal(f.api.store.automatic(f.guild.id),false);
  assert.equal(f.created.length, 0);
  assert.equal(f.warnings.length, 1);
});

test("reuses saved legacy categories without renaming or duplicating them", async t => {
  const f = fixture(t);
  await f.api.enableGuild(f.guild);
  const category = f.channels.get(f.api.store.get("guild", "category"));
  category.name = "Logs do bot";
  const count = f.created.length;
  await f.api.ensureGuild(f.guild);
  assert.equal(category.name, "Logs do bot");
  assert.equal(f.created.length, count);
});

test("Instagram server provisions only one private publication log, without a category or general logs", async t => {
  const f = fixture(t), id = require("../server-logs/policy").INSTAGRAM_GUILD_ID;
  f.guild.id = id;
  await Promise.all([f.api.enableGuild(f.guild), f.api.enableGuild(f.guild)]);
  await f.api.ensureGuild(f.guild);
  assert.equal(f.warnings.length, 0);
  assert.equal(f.created.length, 1);
  assert.equal(f.created[0].name, "logs-instagram");
  assert.equal(f.created[0].type, ChannelType.GuildText);
  assert.equal(f.created[0].parent, null);
  assert.equal(f.created[0].permissionOverwrites[0].id, id);
  assert.deepEqual(f.created[0].permissionOverwrites[0].deny, [PermissionFlagsBits.ViewChannel]);
  for (const kind of ["category", "support", "roles", "backups", "bans", "boosts"]) {
    assert.equal(f.api.store.get(id, kind), undefined);
  }
  assert.ok(f.api.store.get(id, "media"));
});

test("Instagram disables old log bindings but preserves channels, history and unrelated settings", async t => {
  const f = fixture(t), id = require("../server-logs/policy").INSTAGRAM_GUILD_ID;
  f.guild.id = id;
  f.api.store.set(id, "roles", "old-roles");
  f.api.store.set(id, "boosts", "old-boosts");
  f.channels.set("old-roles", { id: "old-roles", type: ChannelType.GuildText, name: "logs-cargos" });
  f.db.prepare("INSERT INTO ticket_management_config VALUES(?,?)").run(id, JSON.stringify({ supportLog: "old-support", generalLog: "old-general", supportTeam: ["staff"] }));
  f.db.prepare("INSERT INTO nickname_protection_config(guildId,logChannelId) VALUES(?,?)").run(id, "old-nickname");
  f.db.prepare("INSERT INTO server_backup_settings VALUES(?,?)").run(id, "old-backup");
  assert.equal(f.api.store.get(id, "roles"), undefined);
  await f.api.enableGuild(f.guild);
  assert.ok(f.channels.has("old-roles"));
  assert.equal(f.created.length, 1);
  const config = JSON.parse(f.db.prepare("SELECT config FROM ticket_management_config WHERE guildId=?").get(id).config);
  assert.deepEqual(config, { supportTeam: ["staff"] });
  assert.equal(f.db.prepare("SELECT logChannelId FROM nickname_protection_config WHERE guildId=?").get(id).logChannelId, null);
  assert.equal(f.db.prepare("SELECT notifyChannel FROM server_backup_settings WHERE guildId=?").get(id).notifyChannel, null);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM bot_log_channels WHERE guildId=?").get(id).n, 1);
});

test("joining, restarting and ensureGuild never create logs before explicit opt-in",async t=>{
  const f=fixture(t);
  for(const listener of f.client.listeners("guildCreate"))await listener(f.guild);
  for(const listener of f.client.listeners("clientReady"))await listener();
  await f.api.ensureGuild(f.guild);
  assert.equal(f.created.length,0);
  assert.equal(f.api.store.automatic(f.guild.id),false);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM bot_log_channels").get().n,0);
});

test("existing manual destinations are preserved but never imply consent to automatic creation",async t=>{
  const f=fixture(t);
  f.api.store.set(f.guild.id,"general","manual-channel");
  await f.api.ensureGuild(f.guild);
  assert.equal(f.created.length,0);
  assert.equal(f.api.store.get(f.guild.id,"general"),"manual-channel");
  assert.equal(f.api.store.automatic(f.guild.id),false);
});

test("explicit setup persists consent and a repeated startup does not duplicate channels",async t=>{
  const f=fixture(t);
  await f.api.enableGuild(f.guild);
  const count=f.created.length;
  assert.equal(f.api.store.automatic(f.guild.id),true);
  const afterRestart=install({client:new EventEmitter(),db:f.db,logger:{warn(){}}});
  await afterRestart.ensureGuild(f.guild);
  assert.equal(f.created.length,count);
});

test("partial creation reports exact counts and retries only missing channels",async t=>{
  const f=fixture(t),create=f.guild.channels.create;
  f.guild.channels.create=async options=>{
    if(options.name==="logs-cargos")throw new Error("No access");
    return create(options);
  };
  const partial=await f.api.enableGuild(f.guild);
  assert.equal(partial.ok,false);assert.equal(partial.configured,partial.total-1);
  assert.deepEqual(partial.failed,["roles"]);
  assert.equal(f.api.store.automatic(f.guild.id),false);
  const count=f.created.length;
  f.guild.channels.create=create;
  const retry=await f.api.enableGuild(f.guild);
  assert.equal(retry.ok,true);assert.equal(f.created.length,count+1);
  assert.equal(f.api.store.automatic(f.guild.id),true);
});
