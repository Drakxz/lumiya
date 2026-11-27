const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { DatabaseSync } = require("node:sqlite");
const { MessageType, MessageFlags, PermissionFlagsBits, PermissionsBitField } = require("discord.js");
const install = require("../boost-logs");

function fixture(t) {
  const db = new DatabaseSync(":memory:"), client = new EventEmitter();
  const sent = [], preserved = [], warnings = [];
  const me = { id: "bot" }, everyone = { id: "everyone" };
  const guild = {
    id: "1569908467324420096", name: "FEZES", premiumTier: 2, premiumSubscriptionCount: 7,
    roles: { everyone }, members: { me, cache: new Map() },
    channels: { fetch: async () => channel }
  };
  const channel = {
    id: "logs", guildId: guild.id, isTextBased: () => true,
    permissionsFor: member => new PermissionsBitField(member === everyone ? [] : [
      PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages
    ]),
    async send(payload) { sent.push(payload); return { id: `log-${sent.length}` }; }
  };
  client.guilds = { cache: new Map([[guild.id, guild]]) };
  client.users = { cache: new Map([["booster", {
    displayAvatarURL: () => "https://cdn.discordapp.com/embed/avatars/0.png"
  }]]) };
  const channels = require("../server-logs/store")(db);
  channels.set(guild.id, "boosts", channel.id);
  const api = install({ client, db, registry: { preserveMessage: m => preserved.push(m.id) },
    logger: { warn: m => warnings.push(m) } });
  t.after(() => { api.close(); db.close(); });
  const message = (id = "boost", userId = "booster", type = MessageType.GuildBoost) => ({
    id, guild, guildId: guild.id, author: { id: userId }, type, system: true, createdTimestamp: Date.now()
  });
  const member = (at, extra = {}) => ({
    id: "booster", guild, partial: false, premiumSinceTimestamp: at, ...extra
  });
  const rows = () => db.prepare("SELECT * FROM server_boost_events").all();
  return { db, client, guild, channel, channels, api, message, member, rows, sent, preserved, warnings };
}

test("boost log is a styled private-channel card identifying booster, time, server level and totals without pings", async t => {
  const f = fixture(t);
  const message = f.message();
  await f.api.onMessage(message);
  assert.equal(f.sent.length, 1);
  const payload = f.sent[0], json = payload.embeds[0].toJSON();
  const body=JSON.stringify(json);
  assert.equal(payload.flags, undefined);
  assert.equal(payload.components, undefined);
  assert.deepEqual(payload.allowedMentions, { parse: [] });
  assert.match(JSON.stringify(json), /Servidor impulsionado/);
  assert.match(body, /<@booster>/);
  assert.match(body, /Brasília/);
  assert.match(JSON.stringify(json), /FEZES/);
  assert.match(json.thumbnail.url,/cdn.discordapp.com/);
  assert.equal(f.rows()[0].level, 2);
  assert.equal(f.rows()[0].total, 7);
  assert.deepEqual(f.preserved, ["log-1"]);
});

test("duplicate gateway events and reinstallation do not repost delivered boosts", async t => {
  const f = fixture(t), message = f.message();
  await Promise.all([f.api.onMessage(message), f.api.onMessage(message)]);
  f.api.close();
  const second = install({ client: f.client, db: f.db });
  t.after(() => second.close());
  await second.onMessage(message);
  await second.flush(f.guild);
  assert.equal(f.sent.length, 1);
  assert.equal(f.rows().length, 1);
});

test("member transition and the first boost message are correlated while extra boosts from the same person stay distinct", async t => {
  const f = fixture(t);
  const at = Date.now();
  f.api.onMemberUpdate(f.member(null), f.member(at));
  await f.api.onMessage({ ...f.message("first"), createdTimestamp: at });
  await f.api.onMessage({ ...f.message("second"), createdTimestamp: at + 1000 });
  await f.api.flush(f.guild);
  assert.equal(f.rows().length, 2);
  assert.equal(f.sent.length, 2);
});

test("first message arriving before premiumSince does not create a duplicate member fallback", async t => {
  const f = fixture(t), message = f.message();
  await f.api.onMessage(message);
  f.api.onMemberUpdate(f.member(null), f.member(message.createdTimestamp));
  await f.api.flush(f.guild);
  assert.equal(f.rows().length, 1);
  assert.equal(f.sent.length, 1);
});

test("fallback works with disabled Discord boost announcements, and late announcements do not duplicate it", async t => {
  const f = fixture(t), at = Date.now();
  f.api.onMemberUpdate(f.member(null), f.member(at));
  await f.api.flush(f.guild);
  assert.equal(f.sent.length, 1);
  await f.api.onMessage({ ...f.message("late"), createdTimestamp: at });
  assert.equal(f.rows().length, 1);
  assert.equal(f.sent.length, 1);
  assert.equal(f.rows()[0].messageId, "late");
});

test("ordinary messages, unrelated member changes, partial cache and old boosters do not invent boost logs", async t => {
  const f = fixture(t);
  await f.api.onMessage({ ...f.message(), system: false });
  await f.api.onMessage(f.message("ordinary", "booster", MessageType.Default));
  f.api.onMemberUpdate(f.member(Date.now() - 10000), f.member(Date.now() - 10000));
  f.api.onMemberUpdate(f.member(null, { partial: true }), f.member(Date.now()));
  f.api.onMemberUpdate(f.member(null), f.member(Date.now() - 86400000));
  f.api.onMemberUpdate(f.member(Date.now()), f.member(null));
  assert.equal(f.rows().length, 0);
  assert.equal(f.sent.length, 0);
});

test("tier messages record the reported tier and each distinct message is logged", async t => {
  const f = fixture(t);
  for (const [n, type] of [
    MessageType.GuildBoostTier1, MessageType.GuildBoostTier2, MessageType.GuildBoostTier3
  ].entries()) await f.api.onMessage(f.message(`tier-${n}`, "booster", type));
  assert.deepEqual(f.rows().map(r => r.level), [1, 2, 3]);
  assert.equal(f.sent.length, 3);
});

test("public or foreign log destinations are refused and failures can be recovered from the persisted event", async t => {
  const f = fixture(t), originalPermissions = f.channel.permissionsFor;
  f.channel.permissionsFor = () => new PermissionsBitField([PermissionFlagsBits.ViewChannel]);
  await f.api.onMessage(f.message());
  assert.equal(f.sent.length, 0);
  f.channel.permissionsFor = originalPermissions;
  f.channel.guildId = "other";
  await f.api.flush(f.guild);
  assert.equal(f.sent.length, 0);
  f.channel.guildId = f.guild.id;
  const send = f.channel.send;
  f.channel.send = async () => { throw new Error("Missing access"); };
  await f.api.flush(f.guild);
  assert.equal(f.rows()[0].logMessageId, null);
  assert.equal(f.warnings.length, 1);
  f.channel.send = send;
  await f.api.flush(f.guild);
  assert.equal(f.sent.length, 1);
});

test("channel recreation aliases are resolved before publishing a boost", async t => {
  const f = fixture(t);
  f.db.prepare("INSERT INTO bot_resource_remaps VALUES(?,?,?)").run(f.guild.id, "logs", "recreated");
  f.guild.channels.fetch = async id => { assert.equal(id, "recreated"); return f.channel; };
  await f.api.onMessage(f.message());
  assert.equal(f.sent.length, 1);
});

test("missing boost log configuration is provisioned before sending and listeners are disposable", async t => {
  const f = fixture(t);
  f.api.close();
  f.db.prepare("DELETE FROM bot_log_channels WHERE guildId=? AND kind='boosts'").run(f.guild.id);
  let provisions = 0;
  const api = install({
    client: f.client, db: f.db,
    ensureLogs: async guild => { provisions++; f.channels.set(guild.id, "boosts", f.channel.id); }
  });
  t.after(() => api.close());
  await api.onMessage(f.message());
  assert.equal(provisions, 1);
  assert.equal(f.sent.length, 1);
  api.close();
  assert.equal(f.client.listenerCount("messageCreate"), 0);
  assert.equal(f.client.listenerCount("guildMemberUpdate"), 0);
});
