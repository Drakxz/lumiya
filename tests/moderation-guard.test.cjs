const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { DatabaseSync } = require("node:sqlite");
const { AuditLogEvent, PermissionFlagsBits } = require("discord.js");
const install = require("../moderation-guard");
const IDS = { guild: "200000000000000001", actor: "500000000000000001",
  target: "500000000000000002", bot: "500000000000000003", owner: "500000000000000004",
  staffRole: "600000000000000001", harmlessRole: "600000000000000002" };

function permissions(values) {
  return { bitfield: values.reduce((bits, value) => bits | BigInt(value), 0n),
    has: permission => (Array.isArray(permission) ? permission : [permission]).every(p => values.includes(p)) };
}
function role(id, values, position = 1) {
  return { id, position, managed: false, permissions: permissions(values), comparePositionTo: other => position - (other.position || 0) };
}

function fixture(t, options = {}) {
  const db = new DatabaseSync(":memory:"), client = new EventEmitter();
  client.user = { id: IDS.bot, bot: true };
  client.guilds = { cache: new Map() };
  const changes = [], calls = [], logs = [];
  const staffRole = role(IDS.staffRole, [PermissionFlagsBits.KickMembers]);
  const harmlessRole = role(IDS.harmlessRole, [], 2);
  const actor = {
    id: IDS.actor, user: { id: IDS.actor, bot: options.actorIsBot ?? false },
    permissions: permissions([PermissionFlagsBits.ManageGuild]),
    roles: { cache: new Map([[IDS.harmlessRole, harmlessRole], [IDS.staffRole, staffRole]]),
      remove: async roleOrId => { const id = typeof roleOrId === "string" ? roleOrId : roleOrId.id; actor.roles.cache.delete(id); changes.push(id); } }
  };
  const bot = { permissions: permissions(options.botPermission === false ? [] : [PermissionFlagsBits.ManageRoles]),
    roles: { highest: role("bot-highest", [], 10) } };
  const guild = {
    id: IDS.guild, ownerId: IDS.owner,
    roles: { cache: new Map([[staffRole.id, staffRole], [harmlessRole.id, harmlessRole]]) },
    members: { me: bot, fetch: async () => actor },
    permissions: permissions([]),
    async fetchAuditLogs() { return { entries: new Map() }; }
  };
  client.guilds.cache.set(guild.id, guild);
  const history = { alterarCargo: async operation => { calls.push(operation); await operation.executar("motivo da auditoria"); } };
  const api = install({ client, db, history, kickWindowMs: options.window || 60000,
    kickLimit: 3, logger: { log: m => logs.push(m), warn(message, error) { console.warn("GUARD", message, error?.stack || error); } } });
  t.after(() => { api.close(); db.close(); });
  function entry(kind, id, at = Date.now(), actorId = IDS.actor, reason = "Motivo do moderador") {
    return { id, action: kind === "kick" ? AuditLogEvent.MemberKick : AuditLogEvent.MemberBanAdd,
      targetId: IDS.target, executorId: actorId, createdTimestamp: at, reason };
  }
  return { db, client, guild, actor, api, changes, calls, logs, entry, staffRole, harmlessRole };
}

test("records kicks, bans and reasons from confirmed audit entries without punishing on the first kick", async t => {
  const f = fixture(t);
  await f.api.inspect(f.entry("kick", "audit-1"), f.guild);
  await f.api.inspect(f.entry("kick", "audit-1"), f.guild);
  await f.api.inspect(f.entry("ban", "audit-2"), f.guild);
  assert.equal(f.api.store.history(f.guild.id, IDS.target).length, 2);
  assert.equal(f.changes.length, 1);
  const recorded = f.api.store.history(f.guild.id, IDS.target);
  assert.ok(recorded.some(r => r.kind === "kick" && r.reason === "Motivo do moderador"));
  assert.ok(recorded.some(r => r.kind === "ban" && r.sanction === "role-removed"));
  assert.equal(f.calls[0].reason, "BANIMENTO EXTERNO ao MDS: Motivo do moderador; auditoria audit-2");
});

test("three kicks inside the configured window remove only the permission-granting role and record the reason", async t => {
  const f = fixture(t);
  const at = Date.now();
  await f.api.inspect(f.entry("kick", "k1", at), f.guild);
  await f.api.inspect(f.entry("kick", "k2", at + 1000), f.guild);
  assert.equal(f.changes.length, 0);
  await f.api.inspect(f.entry("kick", "k3", at + 2000), f.guild);
  assert.deepEqual(f.changes, [IDS.staffRole]);
  assert.match(f.calls[0].reason, /ABUSO DE EXPULSAO: 3 kicks em 60s/);
  assert.match(f.calls[0].reason, /Motivo do moderador/);
  const events = f.api.store.recentKicks(f.guild.id, IDS.actor, Date.now() - 60000);
  assert.equal(events.length, 3);
  assert.ok(events.every(e => ["role-removed", "cleanup"].includes(e.sanction)));
});

test("kicks outside the window and old audit entries do not trigger removal", async t => {
  const f = fixture(t, { window: 5000 });
  // Entradas antigas são registradas para auditoria, mas não disparam punição.
  await f.api.inspect(f.entry("kick", "k1", Date.now() - 10000), f.guild);
  assert.equal(f.api.store.history(f.guild.id, IDS.target).length, 1);
  await f.api.inspect(f.entry("kick", "k2", Date.now()), f.guild);
  await f.api.inspect(f.entry("kick", "k3", Date.now()), f.guild);
  assert.equal(f.changes.length, 0);
});

test("external bots, the moderation bot, owner and members without manage roles are never punished", async t => {
  const f = fixture(t, { actorIsBot: true });
  await f.api.inspect(f.entry("kick", "bot-action", Date.now(), IDS.bot), f.guild);
  await f.api.inspect(f.entry("kick", "owner-action", Date.now(), IDS.owner), f.guild);
  for (let n = 0; n < 4; n++) await f.api.inspect(f.entry("kick", `external-${n}`, Date.now(), "other-bot"), f.guild);
  assert.equal(f.api.store.byActor(f.guild.id, "other-bot").length, 4);
  assert.equal(f.changes.length, 0);
  assert.equal(f.api.store.byActor(f.guild.id, IDS.actor).length, 0);
});

test("does not act when the bot cannot manage roles or when the granting role is above it", async t => {
  const f = fixture(t, { botPermission: false });
  await f.api.inspect(f.entry("ban", "no-permission"), f.guild);
  assert.equal(f.changes.length, 0);
  f.guild.members.me.permissions.has = () => true;
  f.staffRole.position = 20;
  await f.api.inspect(f.entry("ban", "unmanageable"), f.guild);
  assert.equal(f.changes.length, 0);
});

test("startup audit backfill uses the same deduplication and checks only recent entries", async t => {
  const f = fixture(t);
  const old = f.entry("ban", "old-audit", Date.now() - 11 * 60000);
  const fresh = f.entry("ban", "fresh-audit");
  f.guild.fetchAuditLogs = async () => ({ entries: new Map([["old", old], ["fresh", fresh]]) });
  await f.api.fetchAudit(f.guild);
  await f.api.fetchAudit(f.guild);
  assert.equal(f.api.store.history(f.guild.id, IDS.target).length, 1);
  assert.equal(f.changes.length, 0);
});

test("records timeouts from MemberUpdate audit entries with duration in the reason", async t => {
  const f = fixture(t);
  const future = new Date(Date.now() + 3600_000).toISOString();
  const timeout = {
    id: "timeout-1", action: AuditLogEvent.MemberUpdate, targetId: IDS.target,
    executorId: IDS.actor, createdTimestamp: Date.now(), reason: "Castigo aplicado",
    changes: [{ key: "communication_disabled_until", old: null, new: future }]
  };
  await f.api.inspect(timeout, f.guild);
  const events = f.api.store.history(f.guild.id, IDS.target);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "timeout");
  assert.match(events[0].reason, /Castigo aplicado/);
  assert.match(events[0].reason, /1 hora/);
  assert.equal(f.changes.length, 0); // castigo não remove cargo
});

test("ignores timeout expiration and automod entries are still recorded", async t => {
  const f = fixture(t);
  const past = new Date(Date.now() - 60_000).toISOString();
  await f.api.inspect({ id: "expired", action: AuditLogEvent.MemberUpdate, targetId: IDS.target,
    executorId: IDS.actor, createdTimestamp: Date.now(), reason: "Fim do castigo",
    changes: [{ key: "communication_disabled_until", new: past }] }, f.guild);
  assert.equal(f.api.store.history(f.guild.id, IDS.target).length, 0);
  await f.api.inspect({ id: "mod", action: AuditLogEvent.AutoModerationUserCommunicationDisabled,
    targetId: IDS.target, executorId: IDS.actor, createdTimestamp: Date.now(), reason: "Automod" }, f.guild);
  assert.equal(f.api.store.history(f.guild.id, IDS.target)[0].kind, "timeout");
});

test("guard history is available for both the actor and the target", async t => {
  const f = fixture(t);
  await f.api.inspect(f.entry("ban", "audit"), f.guild);
  assert.equal(f.api.store.byActor(f.guild.id, IDS.actor).length, 1);
  assert.equal(f.api.store.history(f.guild.id, IDS.target).length, 1);
  assert.equal(f.api.store.history("other", IDS.target).length, 0);
});
