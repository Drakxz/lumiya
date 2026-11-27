const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const d = require("discord.js");

function harness() {
  const calls = { update: [], reconcile: [], stats: [], stop: [], checkpoints: 0, render: [], sent: [] };
  class Store {
    update(s) { calls.update.push(s); }
    reconcile(id, states) { calls.reconcile.push([id, [...states]]); }
    stopGuild(id) { calls.stop.push(id); }
    checkpoint() { calls.checkpoints++; }
    stats(g, u) { calls.stats.push([g, u]); return { guildId: g, userId: u, totalCallMs: u === "100000000000000002" ? 65000 : 0 }; }
    close() { calls.closed = true; }
  }
  const client = new EventEmitter();
  const gid = "100000000000000001", uid = "100000000000000002", target = "100000000000000003";
  const avatar = () => "https://cdn.discordapp.com/embed/avatars/0.png";
  const user = id => ({ id, username: `User ${id}`, displayAvatarURL: avatar });
  const guild = { id: gid, shardId: 0, available: true,
    voiceStates: { cache: new Map([[uid, { id: uid, channelId: "voice", selfMute: false, serverMute: false }]]) },
    members: { async fetch(id) { return { id, user: user(id), displayName: `Membro ${id}`, displayAvatarURL: avatar }; } }
  };
  client.isReady = () => true;
  client.guilds = { cache: new Map([[gid, guild]]) };
  client.users = { async fetch(id) { return user(id); } };
  client.application = { commands: { async create(command) { calls.command = command; } } };
  client.destroy = () => {};
  const context = {
    module: { exports: {} }, __dirname: path.join(__dirname, "../voice-hours"),
    console: { warn() {}, error() {} }, process: { env: {}, once() {}, exit() {} },
    setInterval(fn) { calls.tick = fn; return { unref() {} }; }, clearInterval() {},
    require(name) {
      if (name === "discord.js") return d;
      if (name === "./store") return { VoiceHoursStore: Store };
      if (name === "./render") return { async renderHoursCard(input) { calls.render.push(input); return Buffer.from("png"); } };
      return require(name);
    }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../voice-hours/index.js"), "utf8"), context);
  const api = context.module.exports({ client });
  const emit = async (event, ...args) => { for (const fn of client.listeners(event)) await fn(...args); };
  function message(content, mentioned = false) {
    return { guild, content, author: { id: uid, bot: false }, replies: [],channel:{async send(p){calls.sent.push(p);}},
      mentions: { users: { first: () => mentioned ? { id: target } : undefined } },
      async reply(p) { this.replies.push(p); }
    };
  }
  function interaction(selected = null) {
    return { guild, user: { id: uid }, commandName: "tempo", replies: [],
      inGuild: () => true, isChatInputCommand: () => true,
      options: { getUser: () => selected ? { id: selected } : null },
      async deferReply() { this.deferred = true; },
      async editReply(p) { assert.equal(this.deferred, true); this.replies.push(p); },
      async reply(p) { this.replies.push(p); }
    };
  }
  return { calls, client, guild, gid, uid, target, emit, message, interaction, api };
}

test("startup reconciles actual voice states and registers /tempo without replacing slash commands", async () => {
  const h = harness(); await h.emit("clientReady");
  assert.equal(h.calls.reconcile.length, 1);
  assert.equal(h.calls.reconcile[0][0], h.gid);
  assert.equal(h.calls.reconcile[0][1][0].channelId, "voice");
  assert.equal(h.calls.command.name, "tempo");
  assert.equal(h.calls.command.options[0].required, false);
  h.calls.tick(); assert.equal(h.calls.checkpoints, 1);
});

test("voice event routing counts both self mute and server mute", async () => {
  const h = harness(); await h.emit("clientReady");
  for (const [selfMute, serverMute, expected] of [[true, false, true], [false, true, true], [false, false, false]]) {
    await h.emit("voiceStateUpdate", {}, { guild: h.guild, id: h.uid, channelId: "voice", selfMute, serverMute });
    assert.equal(h.calls.update.at(-1).muted, expected);
  }
  await h.emit("voiceStateUpdate", {}, { guild: h.guild, id: h.uid, channelId: null, selfMute: true });
  assert.equal(h.calls.update.at(-1).channelId, null);
});

test("old !horas prefix no longer dispatches after rename", async () => {
  const h=harness();await h.emit("clientReady");
  await h.emit("messageCreate",h.message("!horas"));
  assert.equal(h.calls.stats.length,0);assert.equal(h.calls.sent.length,0);
});

test("disconnected shards pause event accounting and resume from reconciled cache", async () => {
  const h = harness(); await h.emit("clientReady");
  await h.emit("shardDisconnect", {}, 0);
  assert.deepEqual(h.calls.stop, [h.gid]);
  await h.emit("voiceStateUpdate", {}, { guild: h.guild, id: h.uid, channelId: "voice" });
  assert.equal(h.calls.update.length, 0);
  await h.emit("shardResume", 0);
  assert.equal(h.calls.reconcile.length, 2);
  await h.emit("voiceStateUpdate", {}, { guild: h.guild, id: h.uid, channelId: "voice" });
  assert.equal(h.calls.update.length, 1);
});

test("a fresh shard session reconciles even before the global client becomes ready", async () => {
  const h = harness();
  h.client.isReady = () => false;
  await h.emit("shardReady", 0);
  assert.equal(h.calls.reconcile.length, 1);
  await h.emit("clientReady");
  assert.equal(h.calls.reconcile.length, 1);
});

test("prefix and slash resolve self/target and send fresh cards in standard embeds", async () => {
  const h = harness(); await h.emit("clientReady");
  for (const [content, mentioned, expected] of [["!tempo", false, h.uid], [`!tempo <@${h.target}>`, true, h.target]]) {
    const msg = h.message(content, mentioned);
    await h.emit("messageCreate", msg);
    assert.equal(h.calls.stats.at(-1)[1], expected);
    const payload = h.calls.sent.at(-1);
    assert.equal(msg.replies.length,0,"!tempo posts to the channel instead of replying to its deleted invocation");
    assert.equal(payload.flags, undefined);
    assert.equal(payload.content, undefined); assert.equal(payload.components, undefined);
    assert.equal(payload.files.length, 1);
    assert.equal(payload.embeds.length,1);
    const embed = payload.embeds[0].toJSON();
    assert.equal(embed.color,0);
    assert.equal(embed.image.url, `attachment://tempo-${expected}.png`);
  }
  for (const selected of [null, h.target]) {
    const i = h.interaction(selected); await h.emit("interactionCreate", i);
    assert.equal(i.deferred, true); assert.equal(i.replies.length, 1);
    assert.equal(h.calls.stats.at(-1)[1], selected || h.uid);
  }
  assert.equal(h.calls.render.length, 4);
  assert.equal(h.calls.render[0].stats.totalCallMs, 65000);
  assert.equal(h.calls.render[1].stats.totalCallMs, 0);
});

test("invalid user and reconnect errors return embeds without querying somebody else", async () => {
  const h = harness(); await h.emit("clientReady");
  const invalid = h.message("!tempo inválido"); await h.emit("messageCreate", invalid);
  assert.equal(h.calls.stats.length, 0);
  assert.equal(h.calls.sent.at(-1).embeds[0].toJSON().color, 0);
  await h.emit("guildUnavailable", h.guild);
  const unavailable = h.message("!tempo"); await h.emit("messageCreate", unavailable);
  assert.equal(h.calls.render.length, 0); assert.equal(h.calls.sent.length, 2);
});
