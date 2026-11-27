const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { DatabaseSync } = require("node:sqlite");
const { PermissionsBitField, PermissionFlagsBits: P } = require("discord.js");
const install = require("../initial-role");

function fixture(t, { useHistory = true } = {}) {
  const db = new DatabaseSync(":memory:"), client = new EventEmitter(), commands = [], added = [], records = [], warnings = [];
  client.user = { id: "mds", bot: true };
  const guild = { id: "g", ownerId: "owner" };
  const actor = { id: "admin", permissions: new PermissionsBitField([P.ManageGuild, P.ManageRoles]),
    roles: { highest: { id: "admin-role" } } };
  const me = { permissions: new PermissionsBitField([P.ManageRoles]), roles: { highest: { id: "bot-role" } } };
  const role = { id: "initial", guild, managed: false, permissions: new PermissionsBitField(),
    comparePositionTo: () => -1 };
  const member = { id: "new", guild, user: { bot: false }, joinedTimestamp: 1000, pending: false,
    roles: { cache: new Map(), async add(assigned, reason) { added.push({ id: assigned.id, reason }); this.cache.set(assigned.id, assigned); } } };
  guild.roles = { async fetch(id) { return id === role.id ? role : null; } };
  guild.members = { async fetch({ user }) { return user === actor.id ? actor : member; }, async fetchMe() { return me; } };
  const history = { async alterarCargo(op) { records.push(op); await op.executar("ficha reason"); } };
  const api = install({ client, db, registry: { register: c => commands.push(c) },
    history: useHistory ? history : undefined, logger: { warn: text => warnings.push(text) } });
  t.after(() => db.close());
  const i = (action, values = ["initial"]) => ({
    guild, user: { id: actor.id }, customId: `mds-initial-role:${action}`, values, output: [],
    async deferUpdate() { this.deferred = true; }, async editReply(p) { this.output.push(p); },
    async reply(p) { this.output.push(p); }, async followUp(p) { this.output.push(p); }
  });
  const enable = async () => { await api.configure(i("select")); await api.configure(i("toggle")); };
  return { db, client, guild, actor, me, role, member, commands, api, added, records, warnings, i, enable };
}

test("initial role defaults disabled, role selection requires activation, and configuration persists", async t => {
  const f = fixture(t);
  assert.equal(f.api.settings("g").enabled, false);
  await f.api.configure(f.i("select"));
  assert.equal(f.api.settings("g").roleId, "initial");
  assert.equal(f.api.settings("g").enabled, false);
  await f.api.configure(f.i("toggle"));
  assert.equal(f.api.settings("g").enabled, true);
  assert.equal(f.db.prepare("SELECT enabled FROM initial_role_config").get().enabled, 1);
  assert.equal(f.commands[0].name, "cargoinicial");
  assert.ok(f.commands[0].prefix.aliases.includes("!autorole"));
  assert.equal(f.added.length, 0, "configuration never assigns roles retroactively");
});

test("new member receives one initial role attributed to MDS through role history", async t => {
  const f = fixture(t);
  await f.enable();
  await Promise.all([f.api.onJoin(f.member), f.api.onJoin(f.member)]);
  await f.api.onJoin(f.member);
  assert.equal(f.added.length, 1);
  assert.equal(f.added[0].id, "initial");
  assert.equal(f.records[0].autor.id, "mds");
  assert.equal(f.records[0].source, "Cargo inicial automático");
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM initial_role_events WHERE action='assigned'").get().n, 1);
});

test("bot inclusion is configurable; disabling and clearing prevent subsequent assignments", async t => {
  const f = fixture(t);
  await f.enable();
  f.member.user.bot = true;
  await f.api.configure(f.i("bots"));
  await f.api.onJoin(f.member);
  assert.equal(f.added.length, 0);
  await f.api.configure(f.i("bots"));
  await f.api.onJoin(f.member);
  assert.equal(f.added.length, 1);
  await f.api.configure(f.i("clear"));
  assert.equal(f.api.settings("g").enabled, false);
  assert.equal(f.api.settings("g").roleId, null);
});

test("fresh permission checks prevent non-admin or revoked staff from changing configuration", async t => {
  const f = fixture(t);
  f.actor.permissions.remove(P.ManageRoles);
  const i = f.i("select");
  await f.api.configure(i);
  assert.equal(f.api.settings("g").roleId, null);
  assert.match(JSON.stringify(i.output), /Gerenciar Servidor e Gerenciar Cargos/);
});

test("managed, foreign, administrative and higher roles cannot be configured", async t => {
  const f = fixture(t);
  for (const mutate of [
    () => { f.role.managed = true; },
    () => { f.role.managed = false; f.role.guild = { id: "other" }; },
    () => { f.role.guild = f.guild; f.role.permissions.add(P.Administrator); },
    () => { f.role.permissions.remove(P.Administrator); f.role.comparePositionTo = () => 0; }
  ]) {
    mutate();
    await f.api.configure(f.i("select"));
    assert.equal(f.api.settings("g").roleId, null);
  }
});

test("runtime role changes and missing ManageRoles fail safely without assigning elevated permissions", async t => {
  const f = fixture(t);
  await f.enable();
  f.role.permissions.add(P.ManageRoles);
  await f.api.onJoin(f.member);
  assert.equal(f.added.length, 0);
  assert.equal(f.warnings.length, 1);
  f.role.permissions.remove(P.ManageRoles);
  f.me.permissions.remove(P.ManageRoles);
  await f.api.onJoin(f.member);
  assert.equal(f.added.length, 0);
  assert.equal(f.warnings.length, 2);
});

test("membership screening is respected; assignment happens only after acceptance", async t => {
  const f = fixture(t);
  await f.enable();
  f.member.pending = true;
  await f.api.onJoin(f.member);
  assert.equal(f.added.length, 0);
  const before = { ...f.member };
  f.member.pending = false;
  for (const fn of f.client.listeners("guildMemberUpdate")) await fn(before, f.member);
  assert.equal(f.added.length, 1);
});

test("existing roles are never duplicated and role API failures do not escape event handler", async t => {
  const f = fixture(t, { useHistory: false });
  await f.enable();
  f.member.roles.cache.set("initial", f.role);
  await f.api.onJoin(f.member);
  assert.equal(f.added.length, 0);
  f.member.roles.cache.clear();
  f.member.roles.add = async () => { throw new Error("Discord error"); };
  await f.api.onJoin(f.member);
  assert.equal(f.warnings.length, 1);
});

test("configuration changes while assignment is pending prevent stale role grants", async t => {
  const f = fixture(t);
  await f.enable();
  const fetch = f.guild.members.fetch;
  f.guild.members.fetch = async options => {
    const member = await fetch(options);
    f.db.prepare("UPDATE initial_role_config SET enabled=0 WHERE guildId='g'").run();
    return member;
  };
  await f.api.onJoin(f.member);
  assert.equal(f.added.length, 0);
});
