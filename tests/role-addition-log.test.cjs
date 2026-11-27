const test = require("node:test");
const assert = require("node:assert/strict");
const { DatabaseSync } = require("node:sqlite");
const { AuditLogEvent } = require("discord.js");
const createLog = require("../role-whitelist/addition-log");
const textOf=payload=>JSON.stringify(payload.embeds.map(c=>c.toJSON()));

function fixture(db) {
  const messages = [], preserved = [], warnings = [];
  const channel = {
    guildId: "guild", isTextBased: () => true,
    permissionsFor: () => ({ has: () => true }),
    async send(payload) { messages.push(payload); return { id: `msg-${messages.length}` }; }
  };
  const guild = {
    id: "guild", members: { me: {} },
    channels: { async fetch(id) { assert.equal(id, "1571711957927469096"); return channel; } }
  };
  const options = {
    client: { user: { id: "mds" } }, db,
    registry: { preserveMessage(message) { preserved.push(message); } },
    logger: { warn(message) { warnings.push(message); } }
  };
  const api = createLog(options);
  const entry = {
    id: "audit", action: AuditLogEvent.MemberRoleUpdate,
    targetId: "member", executorId: "external-bot", createdTimestamp: Date.now(),
    changes: [{ key: "$add", new: [{ id: "role" }] }]
  };
  return { api, options, entry, guild, channel, messages, preserved, warnings };
}

test("logs role, member, executor and timestamp without pings; preserves and deduplicates", async () => {
  const f = fixture();
  await Promise.all([f.api.inspect(f.entry, f.guild), f.api.inspect(f.entry, f.guild)]);
  await f.api.inspect(f.entry, f.guild);
  assert.equal(f.messages.length, 1);
  const payload = f.messages[0];
  assert.match(textOf(payload), /external-bot/);
  assert.match(textOf(payload), /<@member>/);
  assert.match(textOf(payload), /<@&role>/);
  assert.match(textOf(payload), /Lumiya.*Brasília/);
  assert.deepEqual(payload.allowedMentions, { parse: [] });
  assert.equal(f.preserved.length, 1);
});

test("persistent delivery deduplication survives reinstall", async t => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const f = fixture(db);
  await f.api.inspect(f.entry, f.guild);
  await createLog(f.options).inspect(f.entry, f.guild);
  assert.equal(f.messages.length, 1);
});

test("automatically provisioned role log takes precedence over the legacy channel",async t=>{
  const db=new DatabaseSync(":memory:");
  t.after(()=>db.close());
  const f=fixture(db);
  require("../server-logs/store")(db).set("guild","roles","private-roles");
  f.guild.channels.fetch=async id=>{assert.equal(id,"private-roles");return f.channel;};
  await f.api.inspect(f.entry,f.guild);
  assert.equal(f.messages.length,1);
});

test("restored channel mapping takes effect immediately without restarting logger",async t=>{
  const db=new DatabaseSync(":memory:");
  t.after(()=>db.close());
  const f=fixture(db);
  db.prepare("INSERT INTO bot_resource_remaps VALUES(?,?,?)").run("guild","1571711957927469096","restored-log");
  f.guild.channels.fetch=async id=>{assert.equal(id,"restored-log");return f.channel;};
  await f.api.inspect(f.entry,f.guild);
  assert.equal(f.messages.length,1);
  assert.equal(db.prepare("SELECT channelId FROM role_addition_channel_logs").get().channelId,"restored-log");
});

test("logs MDS operations with requester but ignores spoofed markers from external bots", async () => {
  const f = fixture();
  const reason = "mds ficha:12345678-1234-1234-1234-123456789abc por 123456789012345678";
  await f.api.inspect({ ...f.entry, executorId: "mds", reason }, f.guild);
  assert.match(textOf(f.messages[0]), /Solicitado por[\s\S]*123456789012345678/);
  await f.api.inspect({ ...f.entry, id: "other", reason }, f.guild);
  assert.doesNotMatch(textOf(f.messages[1]), /Solicitado por/);
});

test("no logs for removals, old audits, absent destination, foreign guild or missing permissions", async () => {
  const f = fixture();
  await f.api.inspect({ ...f.entry, changes: [{ key: "$remove", new: [{ id: "role" }] }] }, f.guild);
  await f.api.inspect({ ...f.entry, createdTimestamp: Date.now() - 120000 }, f.guild);
  f.channel.guildId = "foreign";
  await f.api.inspect(f.entry, f.guild);
  f.channel.guildId = "guild";
  f.channel.permissionsFor = () => ({ has: () => false });
  await f.api.inspect(f.entry, f.guild);
  f.guild.channels.fetch = async () => null;
  await f.api.inspect(f.entry, f.guild);
  assert.equal(f.messages.length, 0);
});

test("send failure can be retried without losing role protection or marking as delivered", async () => {
  const f = fixture();
  const send = f.channel.send;
  f.channel.send = async () => { throw new Error("no access"); };
  await f.api.inspect(f.entry, f.guild);
  assert.equal(f.warnings.length, 1);
  f.channel.send = send;
  await f.api.inspect(f.entry, f.guild);
  assert.equal(f.messages.length, 1);
});

test("many roles are paginated into messages within Discord limits", async () => {
  const f = fixture();
  await f.api.inspect({
    ...f.entry,
    changes: [{ key: "$add", new: Array.from({ length: 40 }, (_, i) => ({ id: `1234567890123456${String(i).padStart(2, "0")}` })) }]
  }, f.guild);
  assert.equal(f.messages.length, 3);
  assert.ok(f.messages.every(message => message.embeds[0].length <= 6000));
  assert.ok(f.messages.every(message => !message.components&&!message.flags));
});
