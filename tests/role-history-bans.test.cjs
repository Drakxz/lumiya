const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { EventEmitter } = require("node:events");
const { DatabaseSync } = require("node:sqlite");
const d = require("discord.js");
const install = require("../role-history");
const ids = { guild: "200000000000000001", actor: "100000000000000001",
  target: "100000000000000002", other: "100000000000000003", role: "300000000000000001" };
const timestamp = Date.UTC(2026, 10, 17, 17, 34, 56);

function fixture(t, permissions = [d.PermissionFlagsBits.ManageRoles, d.PermissionFlagsBits.BanMembers], mutateRecords = null) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "opencode", "ficha-bans-"));
  const filename = path.join(directory, "roles.json"), previous = process.env.ROLE_HISTORY_FILE;
  process.env.ROLE_HISTORY_FILE = filename;
  const records = Array.from({ length: 8 }, (_, n) => ({
    id: `role-${n}`, guildId: ids.guild, userId: ids.target, roleId: ids.role,
    roleName: "Equipe", action: n % 2 ? "remove" : "add",
    actorId: ids.actor, executorId: "bot", identification: "panel_confirmed",
    source: "Painel", timestamp: timestamp + n, timeSource: "request_confirmed"
  }));
  if (mutateRecords) mutateRecords(records);
  fs.writeFileSync(filename, JSON.stringify({ records, sessions: {} }));
  const db = new DatabaseSync(":memory:"), client = new EventEmitter(), denied = [];
  client.user = { id: "bot" };
  const avatar = () => "https://cdn.discordapp.com/embed/avatars/0.png";
  const staff = { id: ids.actor, permissions: new d.PermissionsBitField(permissions) };
  const target = { id: ids.target, user: { id: ids.target, displayAvatarURL: avatar }, joinedTimestamp: timestamp };
  const guild = {
    id: ids.guild, name: "FEZES", roles: { cache: new Map([[ids.role, { id: ids.role }]]) },
    members: { me: { permissions: new d.PermissionsBitField([]) },
      fetch: async value => (typeof value === "string" ? value : value.user) === ids.actor ? staff : target }
  };
  client.users = { fetch: async id => ({ id, displayAvatarURL: avatar }) };
  const moderation = require("../moderation-guard")({ client, db, history: null });
  const api = install({ client, db, moderation, responderSemPermissao: async i => { denied.push(i); } });
  t.after(() => {
    api.close(); moderation.close(); db.close();
    if (previous === undefined) delete process.env.ROLE_HISTORY_FILE; else process.env.ROLE_HISTORY_FILE = previous;
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const saved = () => JSON.parse(fs.readFileSync(filename, "utf8"));
  const insert = db.prepare("INSERT INTO bot_ban_audit VALUES(?,?,?,?,?,?,?,?,?)");
  function add(id, extras = {}) {
    const r = { guildId: ids.guild, targetId: ids.target, actorId: ids.actor, action: "ban",
      reason: "Spam de convites", deleteSeconds: 3600, status: "success", createdAt: timestamp, ...extras };
    insert.run(id, r.guildId, r.targetId, r.actorId, r.action, r.reason, r.deleteSeconds, r.status, r.createdAt);
  }
  let messageId = 0;
  function origin(customId = null, options = {}) {
    const replies = [], edits = [], defers = [], modals = [];
    const i = {
      guild, guildId: guild.id, member: staff, user: { id: ids.actor }, customId,
      replies, edits, defers, modals, webhook: { deleteMessage: async () => {} },
      inGuild: () => true, isButton: () => !options.modal, isModalSubmit: () => Boolean(options.modal),
      isChatInputCommand: () => false,
      fields: { getTextInputValue: () => options.search || "" },
      async reply(p) { replies.push(p); return { id: `message-${++messageId}`, delete: async () => {} }; },
      async editReply(p) { edits.push(p); return { id: `message-${++messageId}` }; },
      async followUp(p) { replies.push(p); },
      async deferReply(p) { this.deferred = true; defers.push(p); },
      async deferUpdate() { this.deferred = true; defers.push("update"); },
      async showModal(p) { modals.push(p.toJSON()); }
    };
    if (options.public) { i.author = i.user; delete i.user; }
    return i;
  }
  async function click(customId, options) {
    const i = origin(customId, options);
    for (const callback of client.listeners("interactionCreate")) await callback(i);
    return i;
  }
  async function open(options = {}) {
    const i = origin(null, options);
    await api.abrir(i, ids.target, !options.public, options.managementId || null);
    return { origin: i, session: Object.values(saved().sessions).at(-1) };
  }
  const registry = require("../command-system/registry").getCommandRegistry(client);
  return { db, client, guild, staff, api, denied, saved, add, click, open, origin, filename, registry };
}

const json = i => (i.edits.at(-1) || i.replies.at(-1)).components[0].toJSON();
const output = i => JSON.stringify(json(i));
function componentCount(c) {
  return 1 + (c.components || []).reduce((total, item) => total + componentCount(item), 0)
    + (c.accessory ? componentCount(c.accessory) : 0);
}

test("ficha tabs show persisted ban and unban history with date, time, moderator and full details", async t => {
  const f = fixture(t);
  f.add("ban-success");
  f.add("unban-success", { action: "unban", reason: "Recurso aceito", createdAt: timestamp + 1 });
  const { origin, session } = await f.open();
  assert.match(output(origin), /Cargos/);
  assert.match(output(origin), /Banimentos/);
  assert.doesNotMatch(output(origin), /Spam de convites/);
  const bans = await f.click(`ficha:tab:${session.id}:bans`);
  assert.match(output(bans), /Spam de convites/);
  assert.match(output(bans), /Recurso aceito/);
  assert.match(output(bans), /17\/11\/2026/);
  assert.match(output(bans), /14:34:56/);
  assert.match(output(bans), /Brasília/);
  const detail = await f.click(`ficha:detail:${session.id}:ban-success`);
  assert.match(output(detail), /Responsável/);
  assert.match(output(detail), /1 hora/);
  assert.match(output(detail), /ban-success/);
  const back = await f.click(`ficha:back:${session.id}`);
  assert.match(output(back), /Banimentos concluídos/);
});

test("ban filters and pages stay independent from the original role filters", async t => {
  const f = fixture(t);
  for (let n = 0; n < 10; n++) f.add(`ban-${n}`, { reason: `Motivo ${n}`, action: n % 2 ? "unban" : "ban", createdAt: timestamp + n });
  const { session } = await f.open();
  await f.click(`ficha:filter:${session.id}:add`);
  await f.click(`ficha:tab:${session.id}:bans`);
  await f.click(`ficha:filter:${session.id}:unban`);
  const second = await f.click(`ficha:page:${session.id}:2`);
  assert.match(output(second), /2\/2/);
  assert.equal(f.saved().sessions[session.id].filter, "unban");
  await f.click(`ficha:tab:${session.id}:roles`);
  assert.equal(f.saved().sessions[session.id].filter, "add");
  await f.click(`ficha:tab:${session.id}:bans`);
  assert.equal(f.saved().sessions[session.id].filter, "unban");
  assert.equal(f.saved().sessions[session.id].page, 2);
  const search = await f.click(`ficha:modal:${session.id}:bans`, { modal: true, search: "Motivo 1" });
  assert.match(output(search), /Motivo 1/);
  assert.doesNotMatch(output(search), /Motivo 3/);
});

test("cross-user and cross-server ban details are refused; failures and pending are not counted as confirmed bans", async t => {
  const f = fixture(t);
  f.add("failed", { status: "failed" });
  f.add("pending", { status: "pending" });
  f.add("foreign-user", { targetId: ids.other, reason: "FOREIGN-USER-SECRET" });
  f.add("foreign-guild", { guildId: "other", reason: "FOREIGN-GUILD-SECRET" });
  const { session } = await f.open();
  const bans = await f.click(`ficha:tab:${session.id}:bans`);
  assert.match(output(bans), /Banimentos concluídos:\*\* 0/);
  assert.match(output(bans), /Falhou/);
  assert.match(output(bans), /Pendente de verificação/);
  for (const id of ["foreign-user", "foreign-guild"]) {
    const i = await f.click(`ficha:detail:${session.id}:${id}`);
    assert.doesNotMatch(output(i), /FOREIGN-.*-SECRET/);
  }
});

test("users with ficha access can navigate all ban records without BanMembers", async t => {
  const f = fixture(t, [d.PermissionFlagsBits.ManageRoles]);
  f.add("secret", { reason: "PRIVATE-REASON" });
  const { session } = await f.open();
  await f.click(`ficha:tab:${session.id}:bans`);
  assert.equal(f.denied.length, 0);
  assert.equal(f.saved().sessions[session.id].tab, "bans");
  const attemptedDetail = await f.click(`ficha:detail:${session.id}:secret`);
  assert.match(output(attemptedDetail), /PRIVATE-REASON/);
  await f.click(`ficha:back:${session.id}`);
  const attemptedFilter = await f.click(`ficha:filter:${session.id}:ban`);
  assert.match(output(attemptedFilter), /PRIVATE-REASON/);
  const page = await f.click(`ficha:page:${session.id}:1`);
  assert.match(output(page), /PRIVATE-REASON/);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM bot_ban_audit").get().n, 1);
});

test("permissions are re-fetched before every action and sessions remain bound to guild and author", async t => {
  const f = fixture(t);
  f.add("ban", { reason: "PRIVATE-REASON" });
  const { session } = await f.open();
  await f.click(`ficha:tab:${session.id}:bans`);
  f.staff.permissions = new d.PermissionsBitField([]);
  await f.click(`ficha:detail:${session.id}:ban`);
  assert.equal(f.denied.length, 1);
  const fake = f.origin(`ficha:tab:${session.id}:bans`); fake.user.id = ids.other;
  for (const cb of f.client.listeners("interactionCreate")) await cb(fake);
  assert.equal(f.denied.length, 2);
  const foreign = f.origin(`ficha:tab:${session.id}:bans`); foreign.guildId = "other";
  for (const cb of f.client.listeners("interactionCreate")) await cb(foreign);
  assert.equal(f.denied.length, 3);
});

test("switching a public ficha to bans edits the same panel and does not create another response", async t => {
  const f = fixture(t);
  f.add("ban", { reason: "PRIVATE-REASON" });
  const { origin, session } = await f.open({ public: true });
  assert.doesNotMatch(output(origin), /PRIVATE-REASON/);
  const i = await f.click(`ficha:tab:${session.id}:bans`);
  assert.equal(i.defers[0], "update");
  assert.match(output(i), /PRIVATE-REASON/);
  assert.equal(i.replies.length, 0);
  assert.equal(i.edits.length, 1);
  assert.equal(f.saved().sessions[session.id].tab, "bans");
  assert.equal(Object.values(f.saved().sessions).length, 1);
  const roles = await f.click(`ficha:tab:${session.id}:roles`);
  assert.equal(roles.defers[0], "update");
  assert.doesNotMatch(output(roles), /PRIVATE-REASON/);
});

test("ficha still requires its own access permission; BanMembers alone does not grant access", async t => {
  const f = fixture(t, [d.PermissionFlagsBits.BanMembers]);
  f.add("ban");
  await f.open();
  assert.equal(f.denied.length, 1);
  assert.equal(Object.values(f.saved().sessions).length, 0);
});

test("tabs and management navigation never exceed Discord's 40-component limit", async t => {
  const f = fixture(t);
  for (let n = 0; n < 8; n++) f.add(`ban-${n}`);
  for (const managementId of [null, "management-panel"]) {
    const { origin, session } = await f.open({ managementId });
    assert.ok(componentCount(json(origin)) <= 40);
    const bans = await f.click(`ficha:tab:${session.id}:bans`);
    assert.ok(componentCount(json(bans)) <= 40);
  }
});

test("!ficha opens the member history without intercepting the !cargo management alias", async t => {
  const f = fixture(t);
  const command = f.registry.commands.get("ficha");
  assert.equal(f.registry.matches(command, "!cargo"), false);
  for (const content of ["!ficha"]) {
    const sent = [];
    const message = {
      guild: f.guild, content: `${content} <@${ids.target}>`, author: { id: ids.actor, bot: false },
      member: f.staff, mentions: { users: { first: () => ({ id: ids.target }) } },
      async reply(payload) { sent.push(payload); return { id: `m-${sent.length}`, delete: async () => {} }; }
    };
    assert.ok(f.registry.matches(command, message.content));
    await command.prefix.execute(message);
    assert.equal(sent.length, 1);
    assert.match(JSON.stringify(sent[0].components[0].toJSON()), /Ficha do Usuário/);
  }
  assert.equal(Object.values(f.saved().sessions).length, 1);
});

test("moderation tab lists registered punishments with moderator, target, time and reason", async t => {
  const f = fixture(t);
  const store = require("../moderation-guard/store")(f.db);
  const now = Date.now();
  store.add({ id: "k1", guildId: ids.guild, actorId: ids.actor, targetId: ids.target, kind: "kick",
    reason: "Spam no chat", auditId: "audit-k", createdAt: now, sanction: "none" });
  store.add({ id: "t1", guildId: ids.guild, actorId: ids.actor, targetId: ids.target, kind: "timeout",
    reason: "Castigo de 1 hora", auditId: "audit-t", createdAt: now + 1000, sanction: "none" });
  const { session } = await f.open();
  const mod = await f.click(`ficha:tab:${session.id}:moderation`);
  const text = output(mod);
  assert.match(text, /Ações sofridas:\*\* 2/);
  assert.match(text, /Expulsão/);
  assert.match(text, /Castigo/);
  assert.match(text, /Spam no chat/);
  assert.match(text, /Castigo de 1 hora/);
  assert.match(text, /Responsável/);
  assert.match(text, /Alvo/);
  assert.match(text, /Brasília/);
  assert.match(text, /Auditoria: audit-k/);
});

test("ficha displays the bot name instead of MDS without changing stored data or the /mds token", async t => {
  const f = fixture(t, undefined, records => {
    records[0].source = "Progressão automática mds";
    records[0].reason = "Ação da MDS com /mds na bio";
  });
  const { origin, session } = await f.open();
  const list = output(origin);
  assert.match(list, /registradas pelo bot/);
  assert.doesNotMatch(list, /\bMDS\b/i);
  const detail = await f.click(`ficha:detail:${session.id}:role-0`);
  const text = output(detail);
  assert.match(text, /Origem:\*\* Progressão automática bot/);
  assert.match(text, /Ação da bot com \/mds na bio/);
  assert.doesNotMatch(text, /\bMDS\b/);
  // O dado gravado permanece intacto.
  const stored = JSON.parse(fs.readFileSync(f.filename, "utf8"));
  assert.equal(stored.records[0].source, "Progressão automática mds");
  assert.equal(stored.records[0].reason, "Ação da MDS com /mds na bio");
});

test("legacy records with null or missing reason render without crashing", async t => {
  const f = fixture(t);
  const raw = JSON.parse(fs.readFileSync(f.filename, "utf8"));
  raw.records[0].reason = null;
  delete raw.records[1].reason;
  fs.writeFileSync(f.filename, JSON.stringify(raw));
  const { origin, session } = await f.open();
  assert.match(output(origin), /Cargo adicionado|Cargo removido/);
  const detail = await f.click(`ficha:detail:${session.id}:${raw.records[0].id}`);
  assert.match(output(detail), /Motivo|Não informado/);
  assert.equal(f.denied.length, 0);
});

test("all tabs share the same aligned layout: identity, labeled stats, quoted reasons and dividers", async t => {
  const f = fixture(t);
  f.add("ban", { reason: " Motivo\ncom\nquebra " });
  const { origin, session } = await f.open();
  const seen = [];
  for (const tab of ["roles", "bans", "moderation"]) {
    const i = await f.click(`ficha:tab:${session.id}:${tab}`);
    const text = output(i);
    seen.push(text);
    assert.match(text, /ID: 100000000000000002/, `${tab}: identidade`);
    assert.match(text, /\*\*[A-Za-zÀ-ÿ ]+:\*\*/, `${tab}: rótulos alinhados`);
    assert.ok(i.edits[0].components[0].toJSON().components.some(c => c.type === 10), `${tab}: texto`);
    const tabs = i.edits[0].components[0].toJSON().components.find(c => c.type === 1);
    assert.deepEqual(tabs.components.map(c => c.label), ["Cargos", "Banimentos", "Moderação"]);
    assert.equal(tabs.components[tab === "roles" ? 0 : tab === "bans" ? 1 : 2].style, d.ButtonStyle.Primary);
  }
  // Motivos com multilinha permanecem dentro de uma única citação alinhada.
  assert.match(seen[1], /\*\*Motivo\*\*\\n> /);
  assert.match(seen[1], /> com\\n> quebra/);
  // A aba de cargos sem alterações ainda exibe estatísticas e identidade.
  assert.match(seen[0], /Total de alterações:\*\* 8/);
  assert.match(seen[0], /Histórico de alterações/);
  // Emojis oficiais: aprovação para adicionado, rejeição para removido.
  assert.match(seen[0], /<:Icon_Access_Approve:1569949091880902747> \*\*Cargo adicionado\*\*/);
  assert.match(seen[0], /<:Icon_Access_Reject:1569949111166439507> \*\*Cargo removido\*\*/);
});

test("existing ban records and tab selection survive reopening the ficha module without copying histories", async t => {
  const f = fixture(t);
  f.add("existing-operation", { reason: "Registro já existente" });
  const { session } = await f.open();
  await f.click(`ficha:tab:${session.id}:bans`);
  f.api.close();
  const client = new EventEmitter();
  client.user = f.client.user; client.users = f.client.users;
  const api = install({ client, db: f.db, responderSemPermissao: async () => {} });
  t.after(() => api.close());
  const i = f.origin(`ficha:page:${session.id}:1`);
  for (const callback of client.listeners("interactionCreate")) await callback(i);
  assert.match(output(i), /Registro já existente/);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM bot_ban_audit").get().n, 1);
  assert.ok(!f.saved().records.some(r => r.id === "existing-operation"));
});
