const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PermissionsBitField, PermissionFlagsBits: P, ChannelType } = require("discord.js");
const createAccess = require("../ticket-management/thread-access");

function fixture(getStaffRoleIds = () => []) {
  const client = new EventEmitter();
  const changes = [], joined = [], warnings = [];
  const member = { id: "owner", user: { bot: false }, communicationDisabledUntilTimestamp: 0 };
  const me = { id: "bot" };
  const memberPermissions = new PermissionsBitField([P.ViewChannel, P.ReadMessageHistory]);
  const botPermissions = new PermissionsBitField([P.ManageRoles]);
  const guild = { id: "guild", members: {
    async fetch({ user, force }) { assert.equal(user, "owner"); assert.equal(force, true); return member; },
    async fetchMe() { return me; }
  }};
  const roles = new Map([
    ["support", { id: "support", guild }],
    ["migration", { id: "migration", guild }],
    ["guild", { id: "guild", guild }],
    ["foreign", { id: "foreign", guild: { id: "other" } }]
  ]);
  guild.roles = { async fetch(id) { return roles.get(id) || null; } };
  const parent = {
    id: "parent", guild, type: ChannelType.GuildText,
    permissionsFor(who) { return who === me ? botPermissions : memberPermissions; },
    permissionOverwrites: { async edit(id, values, options) { changes.push({ id, values, options }); } }
  };
  const thread = { id: "ticket", guildId: "guild", parent, type: ChannelType.PrivateThread,
    archived: false, locked: false, members: { async add(id) { joined.push(id); } } };
  guild.channels = { async fetch() { return thread; } };
  client.guilds = { async fetch() { return guild; } };
  const data = { tickets: { ticket: { sistema: "support", guildId: "guild", donoId: "owner" } } };
  const saved = [];
  const api = createAccess({ client, data, save() { saved.push(JSON.stringify(data)); }, getStaffRoleIds, logger: { warn(message) { warnings.push(message); } } });
  return { api, member, parent, thread, data, roles, memberPermissions, botPermissions, changes, joined, warnings, saved };
}

test("grants only missing thread send permission to the owner, never parent chat or everyone", async () => {
  const f = fixture();
  await f.api.grantParentAccess(f.parent, "owner");
  assert.deepEqual(f.changes[0].values, { SendMessagesInThreads: true });
  assert.equal(f.changes[0].id, "owner");
  assert.match(f.changes[0].options.reason, /ticket privado/);
  assert.equal(f.changes[0].values.SendMessages, undefined);
});

test("missing view and history permissions are granted individually without replacing other overwrites", async () => {
  const f = fixture();
  f.memberPermissions.remove([P.ViewChannel, P.ReadMessageHistory]);
  await f.api.grantParentAccess(f.parent, "owner");
  assert.deepEqual(f.changes[0].values, {
    ViewChannel: true, ReadMessageHistory: true, SendMessagesInThreads: true
  });
  assert.equal(f.changes.length, 1);
});

test("already permitted owners need no changes or extra bot permissions", async () => {
  const f = fixture();
  f.memberPermissions.add(P.SendMessagesInThreads);
  f.botPermissions.remove(P.ManageRoles);
  await f.api.grantParentAccess(f.parent, "owner");
  assert.equal(f.changes.length, 0);
});

test("active timeout is respected and missing bot permission reports a clear failure", async () => {
  const f = fixture();
  f.member.communicationDisabledUntilTimestamp = Date.now() + 3600000;
  await assert.rejects(f.api.grantParentAccess(f.parent, "owner"), /castigo/);
  f.member.communicationDisabledUntilTimestamp = 0;
  f.botPermissions.remove(P.ManageRoles);
  await assert.rejects(f.api.grantParentAccess(f.parent, "owner"), /Gerenciar Permissões/);
  assert.equal(f.changes.length, 0);
});

test("startup repair fixes existing open ticket owner without adding staff or other participants", async () => {
  const f = fixture();
  assert.equal(await f.api.repairOpenTickets(), 1);
  assert.deepEqual(f.joined, ["owner"]);
  assert.deepEqual(f.changes.map(c => c.id), ["owner"]);
});

test("archived, locked and foreign tickets are not reopened or modified", async () => {
  const f = fixture();
  for (const update of [{ archived: true }, { archived: false, locked: true }, { locked: false, guildId: "foreign" }]) {
    Object.assign(f.thread, update);
    assert.equal(await f.api.repairOpenTickets(), 0);
  }
  assert.equal(f.changes.length, 0);
  assert.equal(f.joined.length, 0);
});

test("repair failure is contained and never silently reports success", async () => {
  const f = fixture();
  f.parent.permissionOverwrites.edit = async () => { throw new Error("Missing permissions"); };
  assert.equal(await f.api.repairOpenTickets(), 0);
  assert.equal(f.warnings.length, 1);
  assert.equal(f.joined.length, 0);
});

test("orphaned tickets are removed from local data without repeated warnings", async () => {
  for (const code of [10003, 10004, 10007]) {
    const f = fixture();
    f.data.tickets.missing = { sistema: "support", guildId: "guild", donoId: "owner" };
    f.data.claims = { missing: { userId: "staff" } };
    f.data.pendingCloses = { missing: true };
    if (code === 10004) {
      // Swap the guild fetch to reproduce Discord's Unknown Guild response.
      const client = new EventEmitter();
      client.guilds = { async fetch() { throw Object.assign(new Error("Unknown Guild"), { code }); } };
      const api = createAccess({ client, data: f.data, save: () => f.saved.push("saved"), logger: { warn: m => f.warnings.push(m) } });
      await api.repairOpenTickets();
    } else {
      const client = new EventEmitter();
      const guild = { id: "guild", members: f.thread.parent.guild.members, roles: f.thread.parent.guild.roles,
        channels: { async fetch(id) {
          if (code === 10003) throw Object.assign(new Error("Unknown Channel"), { code });
          return f.thread;
        } } };
      client.guilds = { async fetch() { return guild; } };
      const api = createAccess({ client, data: f.data, save: () => f.saved.push("saved"), logger: { warn: m => f.warnings.push(m) } });
      if (code === 10007) guild.members.fetch = async () => { throw Object.assign(new Error("Unknown Member"), { code }); };
      await api.repairOpenTickets();
    }
    assert.equal(f.data.tickets.missing, undefined);
    assert.equal(f.data.claims.missing, undefined);
    assert.equal(f.data.pendingCloses.missing, undefined);
    assert.ok(f.saved.length > 0);
    assert.equal(f.warnings.length, 0);
  }
});

test("configured area roles gain thread speech only, without ManageThreads, parent chat or membership", async () => {
  const f = fixture((guildId, system) => {
    assert.equal(guildId, "guild");
    return system === "support" ? ["support", "support", "guild", "missing", "foreign"] : ["migration"];
  });
  await f.api.grantStaffRoleAccess(f.parent, "support");
  assert.equal(f.changes.length, 1);
  assert.equal(f.changes[0].id.id, "support");
  assert.deepEqual(f.changes[0].values, { SendMessagesInThreads: true });
  assert.equal(f.changes[0].values.ManageThreads, undefined);
  assert.equal(f.changes[0].values.SendMessages, undefined);
  assert.deepEqual(f.joined, []);
  await f.api.grantStaffRoleAccess(f.parent, "migration");
  assert.equal(f.changes[1].id.id, "migration");
});

test("startup repair also fixes configured staff roles without adding staff to private threads", async () => {
  const f = fixture(() => ["support"]);
  await f.api.repairOpenTickets();
  assert.deepEqual(f.changes.map(c => typeof c.id === "string" ? c.id : c.id.id), ["support", "owner"]);
  assert.deepEqual(f.joined, ["owner"]);
});

test("staff with full existing permissions need no overwrite edits", async () => {
  const f = fixture(() => ["support"]);
  f.memberPermissions.add(P.SendMessagesInThreads);
  f.botPermissions.remove(P.ManageRoles);
  await f.api.grantStaffRoleAccess(f.parent, "support");
  assert.equal(f.changes.length, 0);
});

test("staff permissions can be repaired even when owner is timed out", async () => {
  const f = fixture(() => ["support"]);
  f.member.communicationDisabledUntilTimestamp = Date.now() + 3600000;
  await f.api.repairOpenTickets();
  assert.equal(f.changes[0].id.id, "support");
  assert.deepEqual(f.joined, []);
  assert.equal(f.warnings.length, 1);
});
