const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { Collection, PermissionsBitField, PermissionFlagsBits, MessageFlags, ChannelType } = require("discord.js");
const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const install = require("../nuke");
const createBotConfig = require("../backups/bot-config");
const { createStore } = require("../media-moderation/store");

function fixture(t, options = {}) {
  const client = new EventEmitter(), commands = new Map(), replies = [], events = [];
  const antigo = {
    id: "old-channel", guildId: "g", name: "geral", type: ChannelType.GuildText,
    parentId: "categoria", topic: "tópico", nsfw: true, rateLimitPerUser: 5, position: 7,
    permissionOverwrites: { cache: new Collection([["role", { id: "role", type: 0, allow: 1n, deny: 2n }]]) },
    toString: () => "<#old-channel>"
  };
  const novo = { id: "new-channel", guildId: "g", name: "geral", type: ChannelType.GuildText,
    position: 7, toString: () => "<#new-channel>", async setPosition() {},
    isTextBased: () => true,
    async send(payload) { replies.push(payload); return { id: `message-${replies.length}` }; } };
  const guild = {
    id: "g",
    members: { me: { permissions: new PermissionsBitField([PermissionFlagsBits.ManageChannels]) } },
    channels: {
      async fetch(id) { return id === "old-channel" ? antigo : id === "new-channel" ? novo : null; },
      async create(options) { events.push(["create", options]); novo.parentId = options.parent; client.guilds.cache.get("g").channels.cache.set(novo.id, novo); return novo; }
    }
  };
  guild.channels.cache = new Collection([[antigo.id, antigo]]);
  client.guilds = { cache: new Collection([["g", guild]]), async fetch(id) { return this.cache.get(id); } };
  antigo.delete = async reason => { events.push(["delete", reason]); guild.channels.cache.delete(antigo.id); };
  const botConfig = {
    capture: guildId => { events.push(["capture", guildId]); return { version: 1, guildId }; },
    apply: async (g, backup, maps) => { events.push(["apply", backup.botConfiguration.version, maps.channelMap["old-channel"]]); }
  };
  const api = install({ client, registry: { register: c => commands.set(c.name, c) }, botConfig, mediaModeration: options.mediaModeration });
  t.after(() => api.close());
  const interaction = (userId = "admin", admin = true) => ({
    inGuild: () => true, guildId: "g", guild, user: { id: userId },
    member: { permissions: new PermissionsBitField(admin ? [PermissionFlagsBits.Administrator] : []) },
    channel: antigo, options: { getChannel: () => null }, deferred: false,
    async reply(payload) { replies.push(payload); }, async deferReply() { this.deferred = true; },
    async editReply(payload) { replies.push(payload); }
  });
  const message = (conteudo = "!nuke", userId = "admin", admin = true) => ({
    guild, content: conteudo, author: { id: userId, bot: false }, channel: antigo,
    member: { permissions: new PermissionsBitField(admin ? [PermissionFlagsBits.Administrator] : []) },
    async reply(payload) { replies.push(payload); this.content = payload.content; }
  });
  return { client, commands, api, events, replies, guild, antigo, novo, botConfig, interaction, message };
}

test("nuke is immediate and admin-only: no preview, token or confirmation", async t => {
  const f = fixture(t);
  const command = f.commands.get("nuke");
  assert.equal(command.prefix.trigger, "!nuke");
  assert.deepEqual(command.prefix.usage, ["!nuke [#canal]"]);

  await command.prefix.execute(f.message("!nuke", "member", false));
  assert.match(f.replies.at(-1).content, /administradores/);
  assert.equal(f.events.length, 0);
  assert.equal(f.api.executar.length, 3, "no confirmation state is kept");

  const pedido = f.message("!nuke");
  await command.prefix.execute(pedido);
  assert.deepEqual(f.events.map(e => e[0]), ["capture", "delete", "create", "apply"]);
  const notice = JSON.stringify(f.replies.at(-1).components[0].toJSON());
  assert.match(notice, /Canal recriado/);
  assert.doesNotMatch(notice, /confirmar/i);
});

test("slash also executes immediately with an ephemeral result", async t => {
  const f = fixture(t);
  const execute = f.commands.get("nuke").slash.execute;
  await execute(f.interaction("member", false));
  assert.match(f.replies.at(-1).content, /administradores/);
  assert.equal(f.events.length, 0);

  await execute(f.interaction());
  assert.deepEqual(f.events.map(e => e[0]), ["capture", "delete", "create", "apply"]);
  const result = f.replies.at(-1);
  assert.ok(result.flags & MessageFlags.Ephemeral);
  assert.match(JSON.stringify(result.components[0].toJSON()), /Canal recriado/);
  assert.equal(f.replies.length, 3);
  assert.equal(f.replies[1].flags, MessageFlags.IsComponentsV2);
});

test("created channel preserves settings and remaps config", async t => {
  const f = fixture(t);
  await f.api.executar(f.guild, f.antigo, "admin");
  const created = f.events.find(e => e[0] === "create")[1];
  assert.equal(created.name, "geral");
  assert.equal(created.parent, "categoria");
  assert.equal(created.topic, "tópico");
  assert.equal(created.nsfw, true);
  assert.equal(created.rateLimitPerUser, 5);
  assert.equal(created.position, 7);
  assert.equal(created.permissionOverwrites[0].id, "role");
  assert.equal(f.events.find(e => e[0] === "apply")[2], "new-channel");
});

test("nuking a monitored channel rebinds media moderation ids automatically", async t => {
  const db = new DatabaseSync(":memory:");
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "opencode", "nuke-media-")), "data.json");
  const botData = {};
  const botConfig = createBotConfig({ db, botData, dataFile: file });
  const store = createStore(db);
  store.setChannel("g", "old-channel", "channel", true);
  store.setChannel("g", "categoria", "category", true);
  const settings = store.settings("g");
  settings.enabled = true;
  settings.logChannelId = "old-channel";
  settings.superficialChannelIds = ["old-channel", "outro"];
  store.saveSettings("g", settings);

  const f = fixture(t);
  f.botConfig.capture = botConfig.capture;
  f.botConfig.apply = botConfig.apply;
  await f.commands.get("nuke").prefix.execute(f.message());

  const channels = store.channels("g");
  const monitorado = channels.find(c => c.channelId === "new-channel" && c.kind === "channel");
  assert.equal(monitorado?.kind, "channel");
  assert.equal(channels.some(c => c.channelId === "old-channel"), false);
  const next = store.settings("g");
  assert.equal(next.logChannelId, "new-channel");
  assert.deepEqual(next.superficialChannelIds, ["new-channel", "outro"]);
  assert.equal(next.enabled, true);
  assert.equal(channels.some(c => c.channelId === "categoria" && c.kind === "category"), true);
  t.after(() => { db.close(); fs.rmSync(path.dirname(file), { recursive: true, force: true }); });
});

test("voice channels are refused", async t => {
  const f = fixture(t);
  const msg = f.message();
  msg.channel = { ...f.antigo, id: "voice", type: ChannelType.GuildVoice };
  await f.commands.get("nuke").prefix.execute(msg);
  assert.match(f.replies.at(-1).content, /canais de texto e anúncios/);
  assert.equal(f.events.length, 0);
});

function protectedFixture(t) {
  const bridge = {};
  const f = fixture(t, { mediaModeration: bridge });
  const db = new DatabaseSync(":memory:");
  const media = require("../media-moderation")({
    client: f.client, db, registry: { register() {}, preserveMessage() {} }
  });
  Object.assign(bridge, media);
  t.after(() => db.close());
  return { ...f, db, media, store: media.store };
}

test("prefix result goes to the recreated channel, not to the deleted command message", async t => {
  const f = fixture(t);
  const message = f.message();
  message.reply = async () => { throw new Error("Must not reply to the deleted channel"); };
  await f.api.onPrefix(message);
  const payload = f.replies.at(-1);
  const notice = payload.components[0].toJSON();
  assert.equal(payload.flags, MessageFlags.IsComponentsV2);
  assert.equal(notice.accent_color, 0x3BA55C);
  assert.deepEqual(payload.allowedMentions, { parse: [] });
  assert.match(JSON.stringify(notice), /Canal recriado/);
  assert.match(JSON.stringify(notice), /<@admin>/);
  assert.match(JSON.stringify(notice), /<#new-channel>/);
  assert.match(JSON.stringify(notice), /<t:\d+:f>/);
  assert.match(JSON.stringify(notice), /não podem ser recuperadas/);
});

test("prefix invoked from another channel still publishes the notice in the recreated channel", async t => {
  const f = fixture(t);
  const message = f.message();
  message.channelId = "command-channel";
  await f.api.onPrefix(message);
  assert.equal(f.replies.length, 2);
  assert.equal(f.replies[0].flags, MessageFlags.IsComponentsV2);
  assert.match(f.replies[1].content, /detalhes estão no novo canal/);
});

test("partial restoration is highlighted in the public notice", async t => {
  const f = fixture(t);
  f.botConfig.apply = async () => ({ errors: ["Configuração pendente"] });
  await f.api.onPrefix(f.message());
  const notice = f.replies[0].components[0].toJSON();
  assert.equal(notice.accent_color, 0xF0B232);
  assert.match(JSON.stringify(notice), /Configuração pendente/);
});

test("notice delivery failure does not report a failed nuke", async t => {
  const f = fixture(t);
  f.novo.send = async () => { throw new Error("Missing permissions"); };
  const message = f.message();
  message.channelId = "command-channel";
  await f.api.onPrefix(message);
  assert.equal(f.replies.length, 1);
  assert.match(f.replies[0].content, /Canal recriado/);
  assert.match(f.replies[0].content, /Não foi possível publicar o aviso/);
});

test("live image protection remaps the new ID even if the general configuration restore fails", async t => {
  const f = protectedFixture(t);
  f.store.setChannel("g", f.antigo.id, "channel", true);
  f.store.saveSettings("g", { ...f.store.settings("g"), enabled: true, logChannelId: f.antigo.id });
  f.botConfig.apply = async () => { throw new Error("Outra configuração indisponível"); };
  const result = await f.api.executar(f.guild, f.antigo, "admin");
  assert.equal(result.mediaResult.active, true);
  assert.equal(f.media.isMonitored({ guildId: "g", channelId: f.novo.id, channel: f.novo }), true);
  assert.equal(f.store.settings("g").logChannelId, f.novo.id);
  assert.ok(!f.store.channels("g").some(row => row.channelId === f.antigo.id));
  assert.match(result.configurationErrors.join(" "), /Outra configuração/);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM media_moderation_notices WHERE channelId=?").get(f.novo.id).n, 1);
  assert.equal(f.replies.filter(p => p.content?.startsWith("**Aviso de moderação")).length, 1);
});

for (const mode of ["category", "superficial", "excluded", "disabled", "unregistered", "instagram"]) {
  test(`nuke preserves ${mode} image protection settings without changing the intended mode`, async t => {
    const f = protectedFixture(t);
    const settings = { ...f.store.settings("g"), enabled: mode !== "disabled" && mode !== "instagram" };
    if (mode === "category" || mode === "excluded") f.store.setChannel("g", "categoria", "category", true);
    if (mode === "excluded") f.store.setChannel("g", f.antigo.id, "exclude", true);
    if (mode === "disabled") f.store.setChannel("g", f.antigo.id, "channel", true);
    if (mode === "superficial") settings.superficialChannelIds = [f.antigo.id];
    if (mode === "instagram") f.db.prepare("INSERT INTO instagram_settings VALUES(?,?)").run("g", f.antigo.id);
    f.store.saveSettings("g", settings);
    const result = await f.api.executar(f.guild, f.antigo, "admin");
    const next = { guildId: "g", channelId: f.novo.id, channel: f.novo };
    assert.equal(result.configurationErrors.length, 0);
    assert.equal(f.store.settings("g").enabled, settings.enabled);
    assert.equal(f.media.isMonitored(next), !["excluded", "unregistered"].includes(mode));
    assert.equal(result.mediaResult.active, !["excluded", "disabled", "unregistered"].includes(mode));
    if (mode === "category") assert.ok(f.store.channels("g").some(r => r.channelId === f.novo.id && r.kind === "channel"));
    if (mode === "superficial") {
      assert.equal(f.media.isSuperficial(next), true);
      assert.deepEqual(f.store.settings("g").superficialChannelIds, [f.novo.id]);
      assert.equal(f.store.channels("g").some(r => r.channelId === f.novo.id && r.kind === "channel"), false);
    }
    if (mode === "excluded") assert.ok(f.store.channels("g").some(r => r.channelId === f.novo.id && r.kind === "exclude"));
    if (mode === "instagram") assert.equal(f.db.prepare("SELECT channelId FROM instagram_settings WHERE guildId='g'").get().channelId, f.novo.id);
  });
}

test("minimal recreation preserves channel privacy and rebinds protection", async t => {
  const f = protectedFixture(t);
  f.store.setChannel("g", f.antigo.id, "channel", true);
  f.store.saveSettings("g", { ...f.store.settings("g"), enabled: true });
  const create = f.guild.channels.create;
  let attempts = 0;
  f.guild.channels.create = async options => {
    if (++attempts === 1) throw new Error("Topic rejected");
    return create(options);
  };
  const result = await f.api.executar(f.guild, f.antigo, "admin");
  const options = f.events.find(e => e[0] === "create")[1];
  assert.equal(attempts, 2);
  assert.deepEqual(options.permissionOverwrites, [{ id: "role", type: 0, allow: 1n, deny: 2n }]);
  assert.equal(result.mediaResult.active, true);
});

test("remap is guild-scoped, atomic and leaves historical media cases pointing to the original channel", async t => {
  const f = protectedFixture(t);
  f.store.setChannel("g", f.antigo.id, "channel", true);
  f.store.setChannel("other", f.antigo.id, "channel", true);
  f.store.saveSettings("g", { ...f.store.settings("g"), enabled: true, logChannelId: f.antigo.id });
  f.db.prepare(`INSERT INTO media_moderation_cases(
    id,guildId,channelId,authorId,originalMessageId,mediaType,createdAt,status,rulesVersion)
    VALUES(?,?,?,?,?,?,?,?,?)`).run("case", "g", f.antigo.id, "author", "original", "image/png", Date.now(), "blocked", "version");
  const snapshot = f.media.captureChannel(f.antigo);
  await assert.rejects(f.media.rebindChannel(snapshot, { ...f.novo, guildId: "other" }), /inválido/);
  const save = f.store.saveSettings;
  f.store.saveSettings = () => { throw new Error("Write failed"); };
  await assert.rejects(f.media.rebindChannel(snapshot, f.novo), /Write failed/);
  assert.ok(f.store.channels("g").some(r => r.channelId === f.antigo.id));
  assert.ok(!f.store.channels("g").some(r => r.channelId === f.novo.id));
  f.store.saveSettings = save;
  await f.media.rebindChannel(snapshot, f.novo);
  assert.equal(f.db.prepare("SELECT channelId FROM media_moderation_cases WHERE id='case'").get().channelId, f.antigo.id);
  assert.equal(f.store.channels("other")[0].channelId, f.antigo.id);
});

test("a new image message is captured by the actual moderation handler immediately after nuke", async t => {
  const f = protectedFixture(t);
  f.store.setChannel("g", f.antigo.id, "channel", true);
  f.store.saveSettings("g", { ...f.store.settings("g"), enabled: true });
  await f.api.executar(f.guild, f.antigo, "admin");
  const previousFetch = global.fetch, files = [];
  const bytes = Buffer.from("unsupported image: retain for review without calling AI");
  let downloads = 0, deleted = false;
  global.fetch = async url => {
    assert.match(String(url), /^https:\/\/cdn\.discordapp\.com\//);
    downloads++;
    return new Response(bytes);
  };
  t.after(() => {
    global.fetch = previousFetch;
    for (const file of files) fs.rmSync(file, { force: true });
  });
  await f.media.onMessage({
    id: "new-image", guild: f.guild, guildId: "g", channelId: f.novo.id, channel: f.novo,
    author: { id: "member", bot: false }, content: "",
    attachments: new Map([["image", {
      url: "https://cdn.discordapp.com/attachments/test/image.png",
      name: "image.png", contentType: "image/png", size: bytes.length
    }]]),
    async delete() { deleted = true; }
  });
  const rows = f.db.prepare("SELECT channelId,status,filePath FROM media_moderation_cases WHERE guildId='g'").all();
  files.push(...rows.map(r => r.filePath).filter(Boolean));
  assert.equal(downloads, 1);
  assert.equal(deleted, true);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].channelId, f.novo.id);
  assert.equal(rows[0].status, "review");
});

test("nuke serializa execuções concorrentes no mesmo canal", async t => {
  const f = fixture(t);
  const first = f.api.executar(f.guild, f.antigo, "admin");
  await assert.rejects(f.api.executar(f.guild, f.antigo, "outro"), /Já existe um nuke/);
  await first;
  assert.equal(f.events.filter(([name]) => name === "delete").length, 1);
  assert.equal(f.events.filter(([name]) => name === "create").length, 1);
});
