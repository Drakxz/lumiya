const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { DatabaseSync } = require("node:sqlite");
const { ChannelType, MessageFlags } = require("discord.js");
const install = require("../instagram/ticket-panel");

test("verification ticket panel is restricted, persistent and does not duplicate", async t => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const client = new EventEmitter(), commands = new Map(), sent = [], edits = [], preserved = [];
  const panel = { id: "panel", edit: async payload => edits.push(payload) };
  const channel = {
    id: "channel", guildId: "guild", type: ChannelType.GuildText,
    send: async payload => { sent.push(payload); return panel; },
    messages: { fetch: async () => panel }
  };
  client.channels = { fetch: async () => channel };
  install({ client, db, registry: { register: c => commands.set(c.name, c), preserveMessage: p => preserved.push(p.id) } });
  const command = commands.get("instaticket");
  const message = { guild: { id: "guild" }, guildId: "guild", channel, member: { permissions: { has: () => false } } };
  await command.prefix.execute(message);
  assert.equal(sent.length, 0);
  message.member.permissions.has = () => true;
  await command.prefix.execute(message);
  assert.equal(sent[0].flags, MessageFlags.IsComponentsV2);
  assert.deepEqual(sent[0].allowedMentions, { parse: [] });
  const json = JSON.stringify(sent[0].components[0].toJSON());
  assert.equal(sent[0].components[0].toJSON().components[0].accessory.media.url, require("../instagram/art").VERIFICATION_THUMBNAIL);
  assert.match(json, /ticket-instagram/);
  assert.match(json, /Iniciar verificação/);
  assert.match(json, /equipe liberará seu acesso/);
  const gallery = sent[0].components[0].toJSON().components.find(component => component.type === 12);
  assert.equal(gallery.items[0].media.url, require("../instagram/art").VERIFICATION_BANNER);
  const components = sent[0].components[0].toJSON().components;
  assert.equal(components.findIndex(c => c.type === 12) + 1, components.findIndex(c => c.type === 1));
  await command.prefix.execute(message);
  for (const callback of client.listeners("clientReady")) await callback();
  assert.equal(sent.length, 1);
  assert.equal(edits.length, 2);
  assert.deepEqual(preserved, ["panel", "panel", "panel"]);
});
