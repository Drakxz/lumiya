const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { DatabaseSync } = require("node:sqlite");
const { PermissionsBitField, PermissionFlagsBits: P } = require("discord.js");
const install = require("../instagram/verification");

function fixture(t) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec("CREATE TABLE ticket_management_cases(id TEXT PRIMARY KEY,guildId TEXT,status TEXT); INSERT INTO ticket_management_cases VALUES('ticket','guild','open')");
  const client = new EventEmitter(), commands = new Map(), replies = [], additions = [], refreshes = [], histories = [];
  client.user = { id: "bot" };
  const high = { position: 100 }, low = { position: 1, comparePositionTo(other) { return this.position - other.position; } };
  const role = { id: "verified", guild: { id: "guild" }, managed: false,
    position: 10, permissions: new PermissionsBitField(), comparePositionTo(other) { return this.position - other.position; } };
  const actor = { id: "staff", user: { bot: false }, roles: { highest: high },
    permissions: new PermissionsBitField([P.ManageGuild, P.ManageRoles]) };
  const target = { id: "member", user: { bot: false }, pending: false,
    roles: { highest: low, cache: new Map(), add: async (r, reason) => { additions.push([r.id, reason]); target.roles.cache.set(r.id, r); } } };
  const bot = { permissions: new PermissionsBitField([P.ManageRoles]), roles: { highest: high } };
  const guild = { id: "guild", ownerId: "owner",
    roles: { fetch: async id => id === role.id ? role : null },
    members: { fetchMe: async () => bot, fetch: async request => {
      const id = typeof request === "string" ? request : request.user;
      return id === "member" ? target : id === "staff" ? actor : { id, user: { bot: false } };
    } } };
  const data = { tickets: { ticket: { guildId: "guild", sistema: "support", tipo: "insta", donoId: "member", messageId: "original" } }, pendingCloses: {} };
  let allowed = true;
  const api = install({
    client, db, data, registry: { register: c => commands.set(c.name, c), preserveMessage() {} },
    canReview: (_g, m) => allowed && m.id === "staff",
    refreshTicket: async id => refreshes.push(id),
    history: { alterarCargo: async options => { histories.push(options); return options.executar("audited bot role addition"); } }
  });
  const interaction = (customId, userId = "staff") => ({
    customId, guild, guildId: "guild", channelId: "ticket", channel: { id: "ticket" },
    message: { id: "original" }, user: { id: userId },
    deferReply: async () => {}, deferUpdate: async () => {},
    editReply: async p => replies.push(p), reply: async p => replies.push(p)
  });
  async function configure() {
    await api.handle({ ...interaction("instaverify:role"), values: ["verified"] });
  }
  async function confirmation() {
    await api.handle(interaction("instaverify:open:ticket"));
    const panel = replies.at(-1).components[0].toJSON();
    const id = panel.components.flatMap(c => c.components || []).find(c => c.custom_id?.startsWith("instaverify:confirm:")).custom_id;
    return interaction(id);
  }
  return { db, client, guild, api, actor, bot, target, role, data, interaction, configure, confirmation,
    replies, additions, histories, refreshes, allow: value => { allowed = value; } };
}

test("Instagram ticket has its own panel and role is delivered only after staff confirmation", async t => {
  const f = fixture(t);
  await f.configure();
  const before = JSON.stringify(f.api.render({ canalId: "ticket", donoId: "member" }).toJSON());
  assert.match(before, /Verificar membro/);
  const confirmation = await f.confirmation();
  assert.equal(f.additions.length, 0);
  await f.api.handle(confirmation);
  assert.equal(f.additions.length, 1);
  assert.equal(f.histories[0].source, "Verificação do Instagram");
  assert.equal(f.histories[0].autor.id, "staff");
  assert.equal(f.api.approved("ticket").reviewerId, "staff");
  assert.deepEqual(f.refreshes, ["ticket"]);
  const after = f.api.render({ canalId: "ticket", donoId: "member" }).toJSON();
  assert.match(JSON.stringify(after), /Membro verificado/);
  assert.equal(after.components.find(c => c.type === 1).components[0].disabled, true);
  await assert.rejects(f.api.handle(confirmation), /expirada|indisponível/);
  assert.equal(f.additions.length, 1);
});

test("members cannot self-verify and unrelated users cannot confirm or configure", async t => {
  const f = fixture(t);
  await f.configure();
  await assert.rejects(f.api.handle(f.interaction("instaverify:open:ticket", "member")), /Somente a equipe/);
  await assert.rejects(f.api.handle(f.interaction("instaverify:open:ticket", "other")), /Somente a equipe/);
  await assert.rejects(f.api.handle({ ...f.interaction("instaverify:role", "other"), values: ["verified"] }), /Gerenciar/);
  const confirmation = await f.confirmation();
  await assert.rejects(f.api.handle({ ...confirmation, user: { id: "other" } }), /indisponível/);
  assert.equal(f.additions.length, 0);
});

for (const changed of ["permission", "role", "closed", "foreign", "message", "pending-close"]) {
  test(`verification rejects ${changed} changes before approval`, async t => {
    const f = fixture(t);
    await f.configure();
    const confirmation = await f.confirmation();
    if (changed === "permission") f.allow(false);
    if (changed === "role") f.db.prepare("UPDATE instagram_verification_config SET roleId='different'").run();
    if (changed === "closed") f.db.prepare("UPDATE ticket_management_cases SET status='closed'").run();
    if (changed === "foreign") confirmation.guildId = "foreign";
    if (changed === "pending-close") f.data.pendingCloses.ticket = true;
    if (changed === "message") {
      const i = f.interaction("instaverify:open:ticket"); i.message.id = "forged";
      await assert.rejects(f.api.handle(i), /mensagem original/);
      return;
    }
    await assert.rejects(f.api.handle(confirmation));
    assert.equal(f.additions.length, 0);
    assert.equal(f.api.approved("ticket"), undefined);
  });
}

for (const invalid of ["admin", "managed", "hierarchy", "bot-permission"]) {
  test(`configuration refuses ${invalid} role conditions`, async t => {
    const f = fixture(t);
    if (invalid === "admin") f.role.permissions.add(P.Administrator);
    if (invalid === "managed") f.role.managed = true;
    if (invalid === "hierarchy") f.role.position = 100;
    if (invalid === "bot-permission") f.bot.permissions.remove(P.ManageRoles);
    await assert.rejects(f.configure());
    assert.equal(f.api.settings("guild"), undefined);
  });
}

test("role API failure keeps the ticket unverified and permits a safe retry", async t => {
  const f = fixture(t);
  await f.configure();
  const confirmation = await f.confirmation(), add = f.target.roles.add;
  f.target.roles.add = async () => { throw new Error("Missing permissions"); };
  await assert.rejects(f.api.handle(confirmation), /Missing permissions/);
  assert.equal(f.api.approved("ticket"), undefined);
  f.target.roles.add = add;
  await f.api.handle(confirmation);
  assert.equal(f.additions.length, 1);
});

test("cancel does not grant the role and ordinary support tickets cannot use verification", async t => {
  const f = fixture(t);
  await f.configure();
  const confirmation = await f.confirmation();
  await f.api.handle({ ...confirmation, customId: confirmation.customId.replace(":confirm:", ":cancel:") });
  assert.equal(f.additions.length, 0);
  f.data.tickets.ticket.tipo = "sup";
  await assert.rejects(f.api.handle(f.interaction("instaverify:open:ticket")), /indisponível/);
});

test("concurrent confirmations cannot grant or approve the same ticket twice", async t => {
  const f = fixture(t);
  await f.configure();
  const first = await f.confirmation(), second = await f.confirmation();
  const results = await Promise.allSettled([f.api.handle(first), f.api.handle(second)]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(f.additions.length, 1);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM instagram_verifications").get().n, 1);
});

test("configuration and approval persist while temporary confirmations do not survive a restart", async t => {
  const f = fixture(t);
  await f.configure();
  const confirmation = await f.confirmation();
  await f.api.handle(confirmation);
  const restarted = install({
    client: new EventEmitter(), registry: { register() {} }, db: f.db, data: f.data,
    canReview: () => true, refreshTicket: async () => {}
  });
  assert.equal(restarted.settings("guild").roleId, "verified");
  assert.equal(restarted.approved("ticket").userId, "member");
  await assert.rejects(restarted.handle(confirmation), /expirada/);
});

test("missing configuration and an ineligible member cannot be approved", async t => {
  const f = fixture(t);
  await assert.rejects(f.api.handle(f.interaction("instaverify:open:ticket")), /Configure o cargo/);
  await f.configure();
  const confirmation = await f.confirmation();
  f.target.pending = true;
  await assert.rejects(f.api.handle(confirmation), /elegível/);
  assert.equal(f.additions.length, 0);
});
