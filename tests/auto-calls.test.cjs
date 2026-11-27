const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { DatabaseSync } = require("node:sqlite");
const { Collection, ChannelType, PermissionsBitField, PermissionFlagsBits, MessageFlags } = require("discord.js");
const install = require("../auto-calls");

function fixture(t) {
  const db = new DatabaseSync(":memory:"), client = new EventEmitter(), commands = new Map(), created = [], deleted = [];
  const voice = (id, name, position) => ({
    id, name, type: ChannelType.GuildVoice, parentId: "cat", position, userLimit: 5, bitrate: 64000,
    guildId: "g", members: new Collection(), async delete(reason) { deleted.push([id, reason]); guild.channels.cache.delete(id); }
  });
  const primeira = voice("v1", "Call", 1);
  const ultima = voice("v2", "Call", 2);
  const categoria = { id: "cat", type: ChannelType.GuildCategory, guildId: "g", name: "Calls" };
  const guild = {
    id: "g",
    members: { me: { permissions: new PermissionsBitField([PermissionFlagsBits.ManageChannels]) } },
    channels: {
      cache: new Collection([["cat", categoria], ["v1", primeira], ["v2", ultima]]),
      async fetch(id) { return this.cache.get(id) || null; },
      async create(options) {
        created.push(options);
        const canal = voice(`v${created.length + 2}`, options.name, 3);
        this.cache.set(canal.id, canal);
        return canal;
      }
    }
  };
  client.guilds = { cache: new Collection([["g", guild]]), async fetch(id) { return this.cache.get(id); } };
  const api = install({ client, registry: { register: c => commands.set(c.name, c) }, db });
  t.after(() => {
    api.close();
    for (const signal of ["SIGINT", "SIGTERM", "exit"]) process.removeListener(signal, api.close);
    db.close();
  });
  const admin = { permissions: new PermissionsBitField([PermissionFlagsBits.ManageGuild, PermissionFlagsBits.ManageChannels]) };
  const i = (action, values = [], member = admin) => ({
    guild, guildId: "g", customId: `mds-autocall:${action}`, values, member, user: { id: "admin" },
    output: [], async deferUpdate() { this.deferred = true; },
    async editReply(p) { this.output.push(p); }, async reply(p) { this.output.push(p); }, async followUp(p) { this.output.push(p); }
  });
  const entrada = (channelId, userId = "user") => ({
    guild, member: { id: userId }, oldChannelId: null, channelId,
    oldState: { channelId: null }, newState: { channelId, guild, member: { id: userId } }
  });
  const emitir = canal => api.onVoiceState({ channelId: null, guild }, { channelId: canal, guild, member: { id: "user" } });
  return { db, client, commands, created, deleted, guild, api, i, entrada, emitir, primeira, ultima };
}

test("category selection requires admin and activation is explicit", async t => {
  const f = fixture(t);
  assert.equal(f.api.settings("g").enabled, false);
  const negado = { ...f.i("category", ["cat"], { permissions: new PermissionsBitField() }), user: { id: "member" } };
  await f.api.configure(negado);
  assert.equal(f.api.settings("g").categoryId, null);
  await f.api.configure(f.i("category", ["cat"]));
  assert.equal(f.api.settings("g").categoryId, "cat");
  assert.equal(f.api.settings("g").enabled, false);
  await f.api.configure(f.i("toggle"));
  assert.equal(f.api.settings("g").enabled, true);
  assert.equal(f.db.prepare("SELECT enabled FROM auto_calls_config").get().enabled, 1);
  assert.equal(f.commands.get("autocall").prefix.trigger, "!autocall");
});

test("joining the last call creates another with the same name; other calls are ignored", async t => {
  const f = fixture(t);
  await f.api.configure(f.i("category", ["cat"]));
  await f.api.configure(f.i("toggle"));
  assert.equal(f.api.ultimaCall(f.guild, "cat").id, "v2");

  await f.emitir("v1");
  assert.equal(f.created.length, 0);
  await f.emitir("v2");
  assert.equal(f.created.length, 1);
  assert.equal(f.created[0].name, "Call");
  assert.equal(f.created[0].type, ChannelType.GuildVoice);
  assert.equal(f.created[0].parent, "cat");
  assert.equal(f.created[0].userLimit, 5);
  assert.deepEqual(f.api.generated("g"), ["v3"]);

  await f.emitir("v2");
  assert.equal(f.created.length, 1, "same user/channel is debounced");
});

test("numbered calls continue the sequence across successive creations", async t => {
  const f = fixture(t);
  f.ultima.name = "Call 1";
  f.api.save({ guildId: "g", categoryId: "cat", enabled: true });
  await f.emitir("v2");
  await f.emitir("v3");
  assert.deepEqual(f.created.map(channel => channel.name), ["Call 2", "Call 3"]);
});

for (const [name, expected] of [
  ["Call 009", "Call 010"],
  ["Call 099", "Call 100"],
  ["Call 999", "Call 1000"],
  ["🎮 Squad 2 | Call 03 🔊", "🎮 Squad 2 | Call 04 🔊"],
  ["Sala 7 • Geral", "Sala 8 • Geral"],
  ["Call 0", "Call 1"],
  ["Call 9007199254740992", "Call 9007199254740993"]
]) {
  test(`call name sequence: ${name} -> ${expected}`, async t => {
    const f = fixture(t);
    f.ultima.name = name;
    f.api.save({ guildId: "g", categoryId: "cat", enabled: true });
    await f.emitir("v2");
    assert.equal(f.created[0].name, expected);
  });
}

test("nothing is created when the system is disabled or last channel changed", async t => {
  const f = fixture(t);
  await f.emitir("v2");
  assert.equal(f.created.length, 0);
  await f.api.configure(f.i("category", ["cat"]));
  await f.emitir("v2");
  assert.equal(f.created.length, 0, "selection alone does not activate");
  await f.api.configure(f.i("toggle"));
  await f.emitir("v2");
  const nova = f.created.length;
  f.guild.channels.cache.get("v2").position = 9;
  await f.emitir("v1");
  assert.equal(f.created.length, nova);
});

test("generated channels are removed when empty and unregistered", async t => {
  const f = fixture(t);
  await f.api.configure(f.i("category", ["cat"]));
  await f.api.configure(f.i("toggle"));
  await f.emitir("v2");
  assert.deepEqual(f.api.generated("g"), ["v3"]);
  await f.api.limparCanal("g", "v3");
  assert.equal(f.deleted.length, 1);
  assert.equal(f.deleted[0][1], "Calls automáticas: canal vazio");
  assert.deepEqual(f.api.generated("g"), []);

  const ocupado = f.guild.channels.cache.get("v3");
  f.guild.channels.cache.set("v3", { ...ocupado, members: new Collection([["user", {}]]) });
  f.db.prepare("INSERT OR REPLACE INTO auto_calls_generated VALUES(?,?,?,?)").run("g", "v3", "v2", Date.now());
  await f.api.limparCanal("g", "v3");
  assert.equal(f.deleted.length, 1, "channels with members are preserved");
  assert.equal(f.api.generated("g").length, 1);
});
