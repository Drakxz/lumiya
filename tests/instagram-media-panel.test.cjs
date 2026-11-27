const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { DatabaseSync } = require("node:sqlite");
const { ChannelType, MessageFlags } = require("discord.js");
const install = require("../instagram/media-panel");
const { VERIFICATION_THUMBNAIL } = require("../instagram/art");

test("media instructions use the shared art and explain approval and privacy without pinging", () => {
  const payload = install.mediaPanel(), panel = payload.components[0].toJSON();
  assert.equal(payload.flags, MessageFlags.IsComponentsV2);
  assert.deepEqual(payload.allowedMentions, { parse: [] });
  assert.equal(panel.accent_color, 0xC4A7E7);
  assert.equal(panel.components[0].accessory.media.url, VERIFICATION_THUMBNAIL);
  assert.equal(panel.components.some(component => component.type === 12), false);
  const text = JSON.stringify(panel);
  assert.match(text, /Somente mídias aprovadas/);
  assert.match(text, /OpenAI/);
  assert.match(text, /legenda na mesma mensagem/);
});

test("media instructions publish automatically in the configured source and update without commands or duplicates", async t => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec(`CREATE TABLE instagram_sources(guildId TEXT,sourceGuildId TEXT,sourceChannelId TEXT);
    CREATE TABLE instagram_settings(guildId TEXT,channelId TEXT);
    INSERT INTO instagram_sources VALUES('main','guild','source');
    INSERT INTO instagram_settings VALUES('main','feed');`);
  const client = new EventEmitter(), commands = new Map(), sent = [], edits = [], preserved = [];
  const panel = { id: "notice", edit: async payload => edits.push(payload) };
  const channel = {
    id: "source", guildId: "guild", type: ChannelType.GuildText,
    send: async payload => { sent.push(payload); return panel; },
    messages: { fetch: async () => panel }
  };
  client.channels = { fetch: async () => channel };
  const api = install({ client, db, registry: { register: c => commands.set(c.name, c), preserveMessage: p => preserved.push(p.id) } });
  for (const callback of client.listeners("clientReady")) await callback();
  assert.equal(commands.size, 0);
  await api.publish(channel);
  await api.publish(channel);
  assert.equal(sent.length, 1);
  assert.equal(edits.length, 2);
  assert.deepEqual(preserved, ["notice", "notice", "notice"]);
});
