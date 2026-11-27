const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { DatabaseSync } = require("node:sqlite");
const { PermissionsBitField, PermissionFlagsBits, MessageFlags } = require("discord.js");
const install = require("../ban-management");
const ids = { actor: "100000000000000001", target: "100000000000000002", bot: "100000000000000003", owner: "100000000000000004" };

function fixture(t) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const client = new EventEmitter();
  client.user = { id: ids.bot };
  const dms = [], dmEdits = [];
  client.users = { fetch: async id => ({ id, send: async payload => {
    dms.push({ id, payload });
    return { id: "dm", edit: async updated => { dmEdits.push({ id, payload: updated }); } };
  } }) };
  const commands = new Map(), calls = [], messages = [], preserved = [];
  const registry = {
    register: command => commands.set(command.name, command),
    preserveMessage: message => preserved.push(message)
  };
  const member = (id, rank, permissions = [PermissionFlagsBits.BanMembers], roleIds = []) => ({
    id, rank, permissions: new PermissionsBitField(permissions),
    roles: {
      cache: new Map(roleIds.map((roleId, index) => [roleId, { id: roleId, position: rank - index }])),
      highest: { comparePositionTo: other => rank - other.rank, rank }
    }
  });
  const moderator = member(ids.actor, 10, [PermissionFlagsBits.BanMembers, PermissionFlagsBits.ManageGuild], ["100000000000000010"]);
  const target = member(ids.target, 1);
  const bot = member(ids.bot, 20);
  const guild = {
    id: "1569908467324420096", ownerId: ids.owner,
    roles: {
      everyone: { id: "everyone" },
      cache: new Map(),
      fetch: async id => ({ id, position: 5 })
    },
    members: {
      fetch: async ({ user }) => user === ids.actor ? moderator : target,
      fetchMe: async () => bot,
      ban: async (id, options) => calls.push({ action: "ban", id, options }),
      unban: async (id, reason) => calls.push({ action: "unban", id, reason })
    },
    bans: { fetch: async id => ({ user: { id } }) },
    channels: { fetch: async () => ({
      guildId: guild.id, isTextBased: () => true,
      permissionsFor: () => new PermissionsBitField([]),
      send: async payload => { messages.push(payload); return { id: "log" }; }
    }) }
  };
  const api = install({ client, registry, db, logger: { warn() {} } });
  function interaction(customId, userId = ids.actor) {
    const replies = [], edits = [];
    return {
      guild, guildId: guild.id, customId, user: { id: userId },
      message: { author: { id: ids.bot } }, replies, edits,
      reply: async payload => replies.push(payload),
      deferUpdate: async () => {}, editReply: async payload => edits.push(payload),
      showModal: async modal => replies.push(modal.toJSON())
    };
  }
  return { db, client, commands, calls, messages, preserved, moderator, target, bot, guild, api, interaction, dms, dmEdits };
}

function confirmationId(payload, route = "confirm") {
  return payload.components[0].toJSON().components.flatMap(c => c.components || [])
    .find(c => c.custom_id?.startsWith(`bm:${route}:`)).custom_id;
}

test("clean V2 panel uses inspected FEZES emojis and registered permission-protected commands", t => {
  const f = fixture(t);
  assert.deepEqual([...f.commands.keys()], ["ban", "desbanir", "unbanall", "banpainel", "limitebans"]);
  for (const name of ["ban", "desbanir", "banpainel"])
    assert.ok(f.commands.get(name).permissions.includes("BanMembers"));
  assert.deepEqual(f.commands.get("limitebans").permissions, ["ManageGuild"]);
  const payload = f.api.home(f.guild);
  const json = payload.components[0].toJSON();
  assert.equal(json.accent_color, 0);
  assert.match(json.components[0].content, /<:members:1569924587293122630>/);
  assert.equal(json.components.at(-1).components[0].emoji.id, "1569949111166439507");
  assert.deepEqual(payload.allowedMentions, { parse: [] });
  assert.ok(payload.flags & MessageFlags.Ephemeral);
  const foreign = f.api.home({ id: "other" }).components[0].toJSON();
  assert.ok(!JSON.stringify(foreign).includes('"emoji"'));
});

test("main panel uses a compact server thumbnail when available, without adding banners", t => {
  const f = fixture(t);
  f.guild.name = "FEZES";
  f.guild.iconURL = () => "https://cdn.discordapp.com/embed/avatars/0.png";
  const json = f.api.home(f.guild).components[0].toJSON();
  const header = json.components[0];
  assert.equal(header.type, 9);
  assert.equal(header.accessory.type, 11);
  assert.match(header.components[0].content, /FEZES/);
  assert.equal(json.components.filter(c => c.type === 9 && c.accessory.type === 2).length, 0);
  const controls = json.components.at(-1);
  assert.equal(controls.type, 1);
  assert.deepEqual(controls.components.map(c => c.label), ["Banir", "Desbanir", "Histórico", "Limites"]);
  assert.equal(json.components.length, 4);
  assert.ok(!json.components.some(c => c.type === 12));
});

test("confirmation separates target, reason and cleanup; retains explicit destructive confirmation", async t => {
  const f = fixture(t);
  const p = await f.api.preview(f.guild, ids.actor, "ban", ids.target, "Spam", 24);
  const json = p.components[0].toJSON();
  const texts = json.components.filter(c => c.type === 10).map(c => c.content);
  assert.ok(texts.some(s => s.startsWith("**Usuário**\n")));
  assert.ok(texts.includes("**Motivo**\n> Spam"));
  assert.ok(texts.some(s => s.startsWith("**Mensagens**\n") && s.includes("24")));
  assert.ok(texts.some(s => s.includes("expira em 5 minutos")));
  assert.doesNotMatch(JSON.stringify(json), /1569933923641983038/);
  const buttons = json.components.find(c => c.type === 1).components;
  assert.equal(buttons[0].label, "Confirmar banimento");
  assert.equal(buttons[0].style, 4);
  assert.equal(buttons[1].style, 2);
  assert.equal(f.calls.length, 0);
});

test("confirmation uses the selected user's avatar and keeps multiline reasons in the quote", async t => {
  const f = fixture(t);
  f.client.users.cache = new Map([[ids.target, {
    displayAvatarURL: () => "https://cdn.discordapp.com/embed/avatars/1.png"
  }]]);
  const p = await f.api.preview(f.guild, ids.actor, "ban", ids.target, "Primeira linha\nSegunda linha");
  const json = p.components[0].toJSON();
  const identity = json.components.find(c => c.type === 9 && c.accessory.type === 11);
  assert.ok(identity.components[0].content.includes(ids.target));
  assert.match(identity.accessory.media.url, /avatars\/1\.png/);
  assert.ok(json.components.some(c => c.content === "**Motivo**\n> Primeira linha\n> Segunda linha"));
  assert.equal(f.calls.length, 0);
});

test("preview never bans; confirmation logs once, attributes moderator and defaults to no message deletion", async t => {
  const f = fixture(t);
  require("../server-logs/store")(f.db).set(f.guild.id, "bans", "logs");
  const p = await f.api.preview(f.guild, ids.actor, "ban", ids.target, "Spam @everyone");
  assert.equal(f.calls.length, 0);
  const i = f.interaction(confirmationId(p));
  await f.api.onInteraction(i);
  await f.api.onInteraction(i);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].options.deleteMessageSeconds, 0);
  assert.match(f.calls[0].options.reason, new RegExp(ids.actor));
  assert.equal(f.db.prepare("SELECT status FROM bot_ban_audit").get().status, "success");
  assert.equal(f.messages.length, 1);
  assert.equal(f.messages[0].flags, undefined);
  assert.equal(f.messages[0].components, undefined);
  assert.equal(f.messages[0].embeds.length, 1);
  assert.equal(f.preserved.length, 1);
});

test("success and private log share a polished receipt with target, quoted reason and moderator", async t => {
  const f = fixture(t);
  require("../server-logs/store")(f.db).set(f.guild.id, "bans", "logs");
  const preview = await f.api.preview(f.guild, ids.actor, "ban", ids.target, "Spam", 12);
  const i = f.interaction(confirmationId(preview));
  await f.api.onInteraction(i);
  for (const payload of [i.edits[0], f.messages[0]]) {
    const log=payload===f.messages[0];
    const json = (log?payload.embeds:payload.components)[0].toJSON();
    assert.equal(log?json.color:json.accent_color, log?0xb294d6:0x527766);
    const body = JSON.stringify(json);
    assert.match(body, /Banimento concluído/);
    assert.match(body, payload===f.messages[0]?/🛡️/:/Icon_Access_Approve/);
    assert.match(body, /Responsável/);
    assert.match(body, /\*\*Motivo\*\*\\n> Spam/);
    assert.doesNotMatch(body, /1569933923641983038/);
    assert.deepEqual(payload.allowedMentions, { parse: [] });
  }
  assert.match(JSON.stringify(f.messages[0].embeds.map(c=>c.toJSON())), /12 hora/);
});

test("cancellation stays neutral and never uses the denial X or success state", async t => {
  const f = fixture(t);
  const p = await f.api.preview(f.guild, ids.actor, "ban", ids.target, "Motivo");
  const i = f.interaction(confirmationId(p, "cancel"));
  await f.api.onInteraction(i);
  const json = i.edits[0].components[0].toJSON();
  assert.equal(json.accent_color, 0);
  assert.match(JSON.stringify(json), /Ação cancelada/);
  assert.match(JSON.stringify(json), /Nenhuma alteração foi realizada/);
  assert.doesNotMatch(JSON.stringify(json), /1569933923641983038/);
});

test("history presents eight separated records with honest success, failure and pending states", async t => {
  const f = fixture(t);
  const insert = f.db.prepare("INSERT INTO bot_ban_audit VALUES(?,?,?,?,?,?,?,?,?)");
  for (let n = 0; n < 10; n++) insert.run(`audit-${n}`, f.guild.id, ids.target, ids.actor,
    n % 2 ? "unban" : "ban", "Motivo\nObjetivo", 0,
    ["success", "failed", "pending"][n % 3], Date.now() + n);
  insert.run("foreign-audit", "other", ids.target, ids.actor, "ban", "FOREIGN-REASON", 0, "success", Date.now() + 100);
  const i = f.interaction("bm:history");
  await f.api.onInteraction(i);
  const payload = i.replies[0], json = payload.components[0].toJSON();
  assert.equal(json.components.filter(c => c.content?.startsWith("**Banimento**") || c.content?.startsWith("**Desbanimento**")).length, 8);
  const body = JSON.stringify(json);
  assert.match(body, /<a:1175261181741641789:1569933923641983038> Falhou/);
  assert.match(body, /Pendente de verificação/);
  assert.match(body, /Icon_Access_Approve/);
  assert.doesNotMatch(body, /FOREIGN-REASON/);
  assert.ok(payload.flags & MessageFlags.Ephemeral);
});

test("empty history and forms have meaningful guidance, labels and placeholders", async t => {
  const f = fixture(t);
  const history = f.interaction("bm:history");
  await f.api.onInteraction(history);
  assert.match(JSON.stringify(history.replies), /Nenhuma ação registrada/);
  for (const action of ["ban", "unban"]) {
    const i = f.interaction(`bm:open:${action}`);
    await f.api.onInteraction(i);
    const modal = i.replies[0];
    const reason = modal.components.find(c => c.component?.custom_id === "reason");
    assert.match(reason.description, /histórico/);
    assert.ok(reason.component.placeholder);
    assert.equal(reason.component.required, true);
    assert.equal(modal.components.length, action === "ban" ? 3 : 2);
  }
});

test("only the requesting moderator in the original guild can confirm; cancel never mutates", async t => {
  const f = fixture(t);
  const p = await f.api.preview(f.guild, ids.actor, "ban", ids.target, "Motivo");
  const id = confirmationId(p);
  await f.api.onInteraction(f.interaction(id, "100000000000000099"));
  const wrongGuild = f.interaction(id); wrongGuild.guildId = "other";
  await f.api.onInteraction(wrongGuild);
  assert.equal(f.calls.length, 0);
  assert.equal(f.api.sessions.size, 1);
  await f.api.onInteraction(f.interaction(confirmationId(p, "cancel")));
  assert.equal(f.calls.length, 0);
  assert.equal(f.api.sessions.size, 0);
});

test("revalidates revoked permission and hierarchy at confirmation", async t => {
  const f = fixture(t);
  let p = await f.api.preview(f.guild, ids.actor, "ban", ids.target, "Motivo");
  f.moderator.permissions = new PermissionsBitField([]);
  await f.api.onInteraction(f.interaction(confirmationId(p)));
  assert.equal(f.calls.length, 0);
  f.moderator.permissions = new PermissionsBitField([PermissionFlagsBits.BanMembers]);
  p = await f.api.preview(f.guild, ids.actor, "ban", ids.target, "Motivo");
  f.target.roles.highest.rank = 30;
  await f.api.onInteraction(f.interaction(confirmationId(p)));
  assert.equal(f.calls.length, 0);
});

test("protects owner, self, bot, equal roles and rejects invalid IDs, reasons and deletion ranges", async t => {
  const f = fixture(t);
  for (const id of [ids.owner, ids.actor, ids.bot, "invalid"])
    await assert.rejects(f.api.preview(f.guild, ids.actor, "ban", id, "Motivo"));
  for (const hours of [-1, 169, 0.5, NaN])
    await assert.rejects(f.api.preview(f.guild, ids.actor, "ban", ids.target, "Motivo", hours));
  await assert.rejects(f.api.preview(f.guild, ids.actor, "ban", ids.target, ""));
  await assert.rejects(f.api.preview(f.guild, ids.actor, "ban", ids.target, "x".repeat(401)));
  f.target.roles.highest.rank = 10;
  await assert.rejects(f.api.preview(f.guild, ids.actor, "ban", ids.target, "Motivo"), /abaixo/);
  assert.equal(f.calls.length, 0);
});

test("missing reason uses the denial X and explicitly labels the error as required reason", async t => {
  const f = fixture(t);
  const sent = [];
  await f.commands.get("ban").prefix.execute({
    guild: f.guild, author: { id: ids.actor }, content: `!ban ${ids.target}`,
    channel: { send: async payload => { sent.push(payload); return { id: "error" }; } }
  });
  const json = sent[0].components[0].toJSON();
  const content = json.components.map(c => c.content || "").join("\n");
  assert.match(content, /<a:1175261181741641789:1569933923641983038> Motivo obrigatório/);
  assert.match(content, /Informe um motivo para a ação antes de continuar/);
  assert.match(content, /Como usar/);
  assert.match(content, /!ban @usuário motivo/);
  assert.match(content, /Nenhuma ação foi realizada/);
  assert.equal(f.calls.length, 0);
});

test("unban missing-reason panel shows the correct usage without ban confirmation controls", async t => {
  const f = fixture(t);
  const sent = [];
  await f.commands.get("desbanir").prefix.execute({
    guild: f.guild, author: { id: ids.actor }, content: `!desbanir ${ids.target}`,
    channel: { send: async p => { sent.push(p); return { id: "error" }; } }
  });
  const json = sent[0].components[0].toJSON();
  assert.match(JSON.stringify(json), /!desbanir ID motivo/);
  assert.equal(JSON.stringify(json).split("1569933923641983038").length - 1, 1);
  assert.ok(!json.components.some(c => c.type === 1));
  assert.equal(f.api.sessions.size, 0);
});

test("oversized reason shows the styled error without incorrectly claiming the reason is missing", async t => {
  const f = fixture(t);
  const sent = [];
  await f.commands.get("ban").prefix.execute({
    guild: f.guild, author: { id: ids.actor }, content: `!ban ${ids.target} ${"x".repeat(401)}`,
    channel: { send: async p => { sent.push(p); return { id: "error" }; } }
  });
  const json = sent[0].components[0].toJSON(), body = JSON.stringify(json);
  assert.equal(json.accent_color, 0x89545d);
  assert.match(body, /<a:1175261181741641789:1569933923641983038> Ação negada/);
  assert.match(body, /400 caracteres/);
  assert.doesNotMatch(body, /Motivo obrigatório/);
  assert.equal(f.calls.length, 0);
});

test("expired confirmation and foreign message cannot mutate", async t => {
  const f = fixture(t);
  const p = await f.api.preview(f.guild, ids.actor, "ban", ids.target, "Motivo");
  const id = confirmationId(p);
  const forged = f.interaction(id); forged.message.author.id = "external";
  await f.api.onInteraction(forged);
  assert.equal(f.calls.length, 0);
  [...f.api.sessions.values()][0].expires = 0;
  await f.api.onInteraction(f.interaction(id));
  assert.equal(f.calls.length, 0);
});

test("unban is confirmed separately and records API errors without a success log", async t => {
  const f = fixture(t);
  const p = await f.api.preview(f.guild, ids.actor, "unban", ids.target, "Recurso aceito");
  await f.api.onInteraction(f.interaction(confirmationId(p)));
  assert.equal(f.calls[0].action, "unban");
  f.guild.members.ban = async () => { throw Object.assign(new Error("Missing Permissions"), { code: 50013 }); };
  const ban = await f.api.preview(f.guild, ids.actor, "ban", ids.target, "Motivo");
  await f.api.onInteraction(f.interaction(confirmationId(ban)));
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM bot_ban_audit WHERE status='failed'").get().n, 1);
  assert.equal(f.messages.length, 0);
});

test("public log destination is refused while durable audit still succeeds", async t => {
  const f = fixture(t);
  require("../server-logs/store")(f.db).set(f.guild.id, "bans", "public");
  const fetch = f.guild.channels.fetch;
  f.guild.channels.fetch = async () => ({ ...await fetch(), permissionsFor: () => new PermissionsBitField([PermissionFlagsBits.ViewChannel]) });
  const p = await f.api.preview(f.guild, ids.actor, "ban", ids.target, "Motivo", 168);
  await f.api.onInteraction(f.interaction(confirmationId(p)));
  assert.equal(f.calls[0].options.deleteMessageSeconds, 604800);
  assert.equal(f.messages.length, 0);
  assert.equal(f.db.prepare("SELECT status FROM bot_ban_audit").get().status, "success");
});

test("modal and history routes require current BanMembers permission", async t => {
  const f = fixture(t);
  await f.api.onInteraction(f.interaction("bm:open:ban"));
  f.moderator.permissions = new PermissionsBitField([]);
  const history = f.interaction("bm:history");
  await f.api.onInteraction(history);
  assert.match(JSON.stringify(history.replies), /:1175261181741641789:1569933923641983038>/);
  assert.match(JSON.stringify(history.replies), /Banir Membros/);
  assert.equal(f.calls.length, 0);
});

test("prefix confirmation survives the bot's 30-second automatic cleanup", async t => {
  const f = fixture(t);
  const sent = [];
  await f.commands.get("ban").prefix.execute({
    guild: f.guild, author: { id: ids.actor },
    content: `!ban <@${ids.target}> Spam`,
    channel: { send: async payload => { sent.push(payload); return { id: "confirmation", delete: async () => {} }; } }
  });
  assert.equal(sent.length, 1);
  assert.equal(f.preserved[0].id, "confirmation");
  assert.equal(f.calls.length, 0);
});

test("missing bot permission, absent ban and Discord outages fail closed", async t => {
  const f = fixture(t);
  f.bot.permissions = new PermissionsBitField([]);
  await assert.rejects(f.api.preview(f.guild, ids.actor, "ban", ids.target, "Motivo"), /bot precisa/);
  f.bot.permissions = new PermissionsBitField([PermissionFlagsBits.BanMembers]);
  f.guild.bans.fetch = async () => { throw Object.assign(new Error("Unknown Ban"), { code: 10026 }); };
  await assert.rejects(f.api.preview(f.guild, ids.actor, "unban", ids.target, "Motivo"), /não está banido/);
  f.guild.members.fetch = async () => { throw new Error("Network error"); };
  await assert.rejects(f.api.preview(f.guild, ids.actor, "ban", ids.target, "Motivo"));
  assert.equal(f.calls.length, 0);
});

test("successful ban sends a styled private notice only after confirmation, without moderator controls or pings", async t => {
  const f = fixture(t);
  f.guild.name = "FEZES";
  f.guild.iconURL = () => "https://cdn.discordapp.com/embed/avatars/0.png";
  const preview = await f.api.preview(f.guild, ids.actor, "ban", ids.target, "Spam @everyone\nReincidência");
  assert.equal(f.dms.length, 0);
  const i = f.interaction(confirmationId(preview));
  await f.api.onInteraction(i);
  await f.api.onInteraction(i);
  assert.equal(f.dms.length, 1);
  const { id, payload } = f.dms[0];
  assert.equal(id, ids.target);
  assert.equal(payload.flags, MessageFlags.IsComponentsV2);
  assert.deepEqual(payload.allowedMentions, { parse: [] });
  const json = payload.components[0].toJSON(), body = JSON.stringify(json);
  assert.equal(json.accent_color, 0x89545d);
  assert.match(body, /Aviso de banimento/);
  assert.match(body, /FEZES/);
  assert.match(body, /Reincidência/);
  assert.match(body, /Responsável pelo banimento/);
  assert.match(body, new RegExp(`<@${ids.actor}>`));
  assert.match(body, /Brasília/);
  assert.match(body, /1569933923641983038/);
  assert.equal(json.components[0].accessory.type, 11);
  assert.doesNotMatch(body, /custom_id|bm:|@everyone/);
  assert.match(body, /aplicação está em andamento/);
  assert.doesNotMatch(body, /foi removido/);
  assert.equal(f.dmEdits.length, 1);
  assert.match(JSON.stringify(f.dmEdits[0].payload.components[0].toJSON()), /foi removido/);
  assert.equal(f.db.prepare("SELECT status FROM bot_ban_notifications").get().status, "sent");
});

test("closed DMs do not undo the ban or mark a completed audit as failed", async t => {
  const f = fixture(t);
  f.client.users.fetch = async () => ({ send: async () => { throw Object.assign(new Error("Cannot send"), { code: 50007 }); } });
  const p = await f.api.preview(f.guild, ids.actor, "ban", ids.target, "Motivo");
  const i = f.interaction(confirmationId(p));
  await f.api.onInteraction(i);
  assert.equal(f.calls.length, 1);
  assert.equal(f.db.prepare("SELECT status FROM bot_ban_audit").get().status, "success");
  assert.equal(f.db.prepare("SELECT status FROM bot_ban_notifications").get().status, "failed");
  assert.match(JSON.stringify(i.edits[0].components[0].toJSON()), /DM fechada ou indisponível/);
});

test("private notice is sent before the shared guild is lost, then the same message is updated after ban", async t => {
  const f = fixture(t);
  let banned = false;
  const order = [], fetchUser = f.client.users.fetch, ban = f.guild.members.ban;
  f.client.users.fetch = async id => {
    const user = await fetchUser(id), send = user.send;
    user.send = async payload => {
      // Reproduz o bloqueio do Discord ao tentar abrir DM depois do ban.
      if (banned) throw Object.assign(new Error("No mutual guild"), { code: 50007 });
      order.push("dm");
      const message = await send(payload), edit = message.edit;
      message.edit = async updated => {
        assert.equal(banned, true);
        order.push("edit");
        return edit(updated);
      };
      return message;
    };
    return user;
  };
  f.guild.members.ban = async (...args) => {
    assert.equal(f.dms.length, 1);
    order.push("ban");
    await ban(...args);
    banned = true;
  };
  const p = await f.api.preview(f.guild, ids.actor, "ban", ids.target, "Motivo");
  await f.api.onInteraction(f.interaction(confirmationId(p)));
  assert.deepEqual(order, ["dm", "ban", "edit"]);
  assert.equal(f.dms.length, 1);
  assert.equal(f.db.prepare("SELECT status FROM bot_ban_audit").get().status, "success");
});

test("lost permission during DM delivery prevents the ban and corrects the notice", async t => {
  const f = fixture(t), fetchUser = f.client.users.fetch;
  f.client.users.fetch = async id => {
    const user = await fetchUser(id), send = user.send;
    user.send = async payload => {
      const message = await send(payload);
      f.moderator.permissions = new PermissionsBitField([]);
      return message;
    };
    return user;
  };
  const p = await f.api.preview(f.guild, ids.actor, "ban", ids.target, "Motivo");
  await f.api.onInteraction(f.interaction(confirmationId(p)));
  assert.equal(f.calls.length, 0);
  assert.equal(f.dmEdits.length, 1);
  assert.match(JSON.stringify(f.dmEdits[0].payload.components[0].toJSON()), /não confirma um banimento/);
});

test("failure to edit a delivered DM does not resend the notice or undo a successful ban", async t => {
  const f = fixture(t), fetchUser = f.client.users.fetch;
  f.client.users.fetch = async id => {
    const user = await fetchUser(id), send = user.send;
    user.send = async payload => {
      const message = await send(payload);
      message.edit = async () => { throw new Error("Cannot edit DM"); };
      return message;
    };
    return user;
  };
  const p = await f.api.preview(f.guild, ids.actor, "ban", ids.target, "Motivo");
  await f.api.onInteraction(f.interaction(confirmationId(p)));
  assert.equal(f.calls.length, 1);
  assert.equal(f.dms.length, 1);
  assert.equal(f.db.prepare("SELECT status FROM bot_ban_notifications").get().status, "sent");
  assert.equal(f.db.prepare("SELECT status FROM bot_ban_audit").get().status, "success");
});

test("cancellation never notifies; unban sends a success notice and a failed ban corrects its own notice", async t => {
  const f = fixture(t);
  let p = await f.api.preview(f.guild, ids.actor, "ban", ids.target, "Motivo");
  await f.api.onInteraction(f.interaction(confirmationId(p, "cancel")));
  assert.equal(f.dms.length, 0);
  p = await f.api.preview(f.guild, ids.actor, "unban", ids.target, "Recurso");
  await f.api.onInteraction(f.interaction(confirmationId(p)));
  assert.equal(f.dms.length, 1);
  assert.match(JSON.stringify(f.dms[0].payload.components[0].toJSON()), /Você foi desbanido/);
  f.guild.members.ban = async () => { throw Object.assign(new Error("Missing permissions"), { code: 50013 }); };
  p = await f.api.preview(f.guild, ids.actor, "ban", ids.target, "Motivo");
  await f.api.onInteraction(f.interaction(confirmationId(p)));
  assert.equal(f.dms.length, 2);
  assert.equal(f.dmEdits.length, 1);
  const body = JSON.stringify(f.dmEdits[0].payload.components[0].toJSON());
  assert.match(body, /Solicitação não concluída/);
  assert.match(body, /não confirma um banimento/);
  assert.doesNotMatch(body, /foi removido/);
  assert.equal(f.db.prepare("SELECT status FROM bot_ban_audit WHERE action='ban'").get().status, "failed");
});

function replyCommand(f, content, reference = {}) {
  const sent = [];
  return {
    guild: f.guild, guildId: f.guild.id, author: { id: ids.actor }, content,
    channelId: "channel", reference: { messageId: "original" }, sent,
    fetchReference: async () => ({ guildId: f.guild.id, channelId: "channel", author: { id: ids.target }, ...reference }),
    channel: { id: "channel", send: async payload => { sent.push(payload); return { id: "confirmation", delete: async () => {} }; } }
  };
}

test("replying with !ban motivo selects the original message author and retains the entire reason", async t => {
  const f = fixture(t);
  const message = replyCommand(f, "!ban divulgação de links e spam");
  await f.commands.get("ban").prefix.execute(message);
  const session = [...f.api.sessions.values()][0];
  assert.equal(session.targetId, ids.target);
  assert.equal(session.reason, "divulgação de links e spam");
  assert.equal(f.calls.length, 0);
  assert.equal(f.dms.length, 0);
  await f.api.onInteraction(f.interaction(confirmationId(message.sent[0])));
  assert.equal(f.calls[0].id, ids.target);
  assert.equal(f.dms[0].id, ids.target);
});

test("reply without reason, deleted reference and cross-server/channel messages cannot ban anyone", async t => {
  const f = fixture(t);
  const messages = [
    replyCommand(f, "!ban"),
    replyCommand(f, "!ban spam", { guildId: "other" }),
    replyCommand(f, "!ban spam", { channelId: "other" })
  ];
  const deleted = replyCommand(f, "!ban spam");
  deleted.fetchReference = async () => { throw Object.assign(new Error("Unknown message"), { code: 10008 }); };
  messages.push(deleted);
  for (const message of messages) {
    await f.commands.get("ban").prefix.execute(message);
    assert.match(JSON.stringify(message.sent[0].components[0].toJSON()), /1569933923641983038/);
  }
  assert.equal(f.api.sessions.size, 0);
  assert.equal(f.calls.length, 0);
});

test("explicit target wins over the reply author and replies keep all existing permission checks", async t => {
  const f = fixture(t);
  const explicit = "100000000000000005";
  const message = replyCommand(f, `!ban <@${explicit}> Motivo explícito`);
  message.fetchReference = async () => { throw new Error("Must not fetch"); };
  await f.commands.get("ban").prefix.execute(message);
  assert.equal([...f.api.sessions.values()][0].targetId, explicit);
  f.moderator.permissions = new PermissionsBitField([]);
  await f.commands.get("ban").prefix.execute(replyCommand(f, "!ban spam"));
  assert.equal(f.api.sessions.size, 1);
  assert.equal(f.calls.length, 0);
});

test("weekly quota counts only this week's successful bans and is shown in the preview", async t => {
  const f = fixture(t);
  const limit = f.db.prepare("INSERT INTO bot_ban_limits VALUES(?,?,?,?)");
  const audit = f.db.prepare("INSERT INTO bot_ban_audit VALUES(?,?,?,?,?,?,?,?,?)");
  limit.run(f.guild.id, "100000000000000010", 3, Date.now());
  audit.run("ok-1", f.guild.id, ids.target, ids.actor, "ban", "Motivo", 0, "success", Date.now());
  audit.run("failed", f.guild.id, ids.target, ids.actor, "ban", "Motivo", 0, "failed", Date.now());
  audit.run("old", f.guild.id, ids.target, ids.actor, "ban", "Motivo", 0, "success", Date.now() - 8 * 86400000);
  audit.run("other-actor", f.guild.id, ids.target, ids.target, "ban", "Motivo", 0, "success", Date.now());
  const preview = await f.api.preview(f.guild, ids.actor, "ban", ids.target, "Motivo");
  const body = JSON.stringify(preview.components[0].toJSON());
  assert.match(body, /Limite semanal/);
  assert.match(body, /Já usou \*\*1\*\* de \*\*3\*\*/);
  assert.match(body, /ainda pode dar \*\*2\*\*/);
  assert.match(body, /Renova <t:\d+:R> · segunda-feira, 00:00 de Brasília/);
});

test("the highest configured role wins and an exhausted quota blocks the ban before any action", async t => {
  const f = fixture(t);
  f.db.prepare("INSERT INTO bot_ban_limits VALUES(?,?,?,?)").run(f.guild.id, "100000000000000010", 2, Date.now());
  f.db.prepare("INSERT INTO bot_ban_limits VALUES(?,?,?,?)").run(f.guild.id, "100000000000000011", 10, Date.now());
  f.moderator.roles.cache.set("100000000000000011", { id: "100000000000000011", position: 12 });
  const preview = await f.api.preview(f.guild, ids.actor, "ban", ids.target, "Motivo");
  assert.match(JSON.stringify(preview.components[0].toJSON()), /Já usou \*\*0\*\* de \*\*10\*\*/);
  const audit = f.db.prepare("INSERT INTO bot_ban_audit VALUES(?,?,?,?,?,?,?,?,?)");
  for (let n = 0; n < 10; n++)
    audit.run(`used-${n}`, f.guild.id, ids.target, ids.actor, "ban", "Motivo", 0, "success", Date.now() + n);
  await assert.rejects(f.api.preview(f.guild, ids.actor, "ban", ids.target, "Motivo"), /limite/i);
  const sent = [];
  await f.commands.get("ban").prefix.execute({
    guild: f.guild, author: { id: ids.actor }, content: `!ban ${ids.target} Motivo`,
    channel: { send: async payload => { sent.push(payload); return { id: "error" }; } }
  });
  const errorBody = JSON.stringify(sent[0].components[0].toJSON());
  assert.match(errorBody, /já usou \*\*10 de 10\*\* banimentos nesta semana/);
  assert.match(errorBody, /O limite renova/);
  assert.equal(f.calls.length, 0);
  assert.equal(f.dms.length, 0);
});

test("the result receipt shows how many bans were used and how many remain", async t => {
  const f = fixture(t);
  f.db.prepare("INSERT INTO bot_ban_limits VALUES(?,?,?,?)").run(f.guild.id, "100000000000000010", 4, Date.now());
  const preview = await f.api.preview(f.guild, ids.actor, "ban", ids.target, "Motivo");
  const i = f.interaction(confirmationId(preview));
  await f.api.onInteraction(i);
  const body = JSON.stringify(i.edits[0].components[0].toJSON());
  assert.match(body, /Banimento concluído/);
  assert.match(body, /Já usou \*\*1\*\* de \*\*4\*\*/);
  assert.match(body, /ainda pode dar \*\*3\*\*/);
  assert.equal(f.calls.length, 1);
});

test("the limit panel lists roles and saves or removes a weekly limit through the role menu", async t => {
  const f = fixture(t);
  const sent = [];
  await f.commands.get("limitebans").prefix.execute({
    guild: f.guild, author: { id: ids.actor },
    channel: { send: async payload => { sent.push(payload); return { id: "limit-panel" }; } }
  });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].flags, MessageFlags.IsComponentsV2);
  assert.match(JSON.stringify(sent[0].components[0].toJSON()), /Nenhum cargo configurado/);
  assert.equal(f.preserved[0].id, "limit-panel");

  const fromButton = f.interaction("bm:limit:panel");
  await f.api.onInteraction(fromButton);
  assert.ok(fromButton.replies[0].flags & MessageFlags.Ephemeral);
  assert.match(JSON.stringify(fromButton.replies[0].components[0].toJSON()), /Controle semanal por cargo/);

  const select = f.interaction("bm:limit:role");
  select.values = ["100000000000000010"];
  select.isRoleSelectMenu = () => true;
  await f.api.onInteraction(select);
  assert.equal(select.replies[0].custom_id, "bm:limit:form:100000000000000010");

  const submit = f.interaction("bm:limit:form:100000000000000010");
  submit.isModalSubmit = () => true;
  submit.isFromMessage = () => true;
  submit.fields = { getTextInputValue: () => "4" };
  submit.update = async payload => { submit.edits.push(payload); };
  await f.api.onInteraction(submit);
  assert.equal(f.db.prepare("SELECT limitCount FROM bot_ban_limits WHERE roleId='100000000000000010'").get().limitCount, 4);
  const updated = JSON.stringify(submit.edits[0].components[0].toJSON());
  assert.match(updated, /<@&100000000000000010>/);
  assert.match(updated, /4\*\* banimentos por semana/);

  submit.fields = { getTextInputValue: () => "0" };
  await f.api.onInteraction(submit);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM bot_ban_limits").get().n, 0);
  assert.match(JSON.stringify(submit.edits[1].components[0].toJSON()), /Nenhum cargo configurado/);
});

test("limit configuration requires ManageGuild and rejects invalid values and missing roles", async t => {
  const f = fixture(t);
  const denied = f.interaction("bm:limit:role", ids.target);
  denied.values = ["100000000000000010"];
  denied.isRoleSelectMenu = () => true;
  await f.api.onInteraction(denied);
  assert.match(JSON.stringify(denied.replies), /Gerenciar Servidor/);

  const invalid = f.interaction("bm:limit:form:100000000000000010");
  invalid.isModalSubmit = () => true;
  invalid.fields = { getTextInputValue: () => "1001" };
  await f.api.onInteraction(invalid);
  assert.match(JSON.stringify(invalid.replies), /0 a 1000/);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM bot_ban_limits").get().n, 0);

  f.guild.roles.fetch = async () => null;
  const missing = f.interaction("bm:limit:form:100000000000000010");
  missing.isModalSubmit = () => true;
  missing.fields = { getTextInputValue: () => "5" };
  await f.api.onInteraction(missing);
  assert.match(JSON.stringify(missing.replies), /não existe mais/);
});

test("result cards disappear after 30 seconds while logs and DMs stay", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(t);
  require("../server-logs/store")(f.db).set(f.guild.id, "bans", "logs");
  const deleted = [];
  const preview = await f.api.preview(f.guild, ids.actor, "ban", ids.target, "Motivo");
  const i = f.interaction(confirmationId(preview));
  i.editReply = async payload => {
    i.edits.push(payload);
    return { delete: async () => { deleted.push("card"); } };
  };
  await f.api.onInteraction(i);
  assert.equal(deleted.length, 0);
  assert.equal(f.messages.length, 1);
  assert.equal(f.dms.length, 1);
  t.mock.timers.tick(29_999);
  assert.equal(deleted.length, 0);
  t.mock.timers.tick(1);
  await Promise.resolve();
  assert.deepEqual(deleted, ["card"]);
});

function bulkBans(f, count = 3) {
  f.moderator.permissions.add(PermissionFlagsBits.Administrator);
  const targets = Array.from({ length: count }, (_, n) => String(200000000000000000n + BigInt(n)));
  const pages = [];
  f.guild.bans.fetch = async options => {
    pages.push(options);
    const remaining = targets.filter(id => !options.after || BigInt(id) > BigInt(options.after)).slice(0, options.limit);
    return new Map(remaining.map(id => [id, { user: { id } }]));
  };
  return { targets, pages };
}

function bulkConfirmation(payload, cancel = false) {
  return confirmationId(payload, cancel ? "cancelall" : "confirmall");
}

test("bulk preview paginates all bans and changes nothing before personal confirmation", async t => {
  const f = fixture(t);
  const { pages } = bulkBans(f, 1001);
  const payload = await f.api.previewAll(f.guild, ids.actor, "Nova oportunidade");
  assert.equal(pages.length, 2);
  assert.equal(pages[0].limit, 1000);
  assert.equal(pages[0].cache, false);
  assert.equal(pages[1].after, "200000000000000999");
  assert.equal([...f.api.sessions.values()][0].targetIds.length, 1001);
  const json = payload.components[0].toJSON();
  assert.equal(json.accent_color, 0);
  assert.match(JSON.stringify(json), /Confirmar desbanimento de todos/);
  assert.match(JSON.stringify(json), /1001 usuário/);
  assert.match(JSON.stringify(json), /Novos banimentos não entram/);
  assert.equal(f.calls.length, 0);
  assert.equal(f.dms.length, 0);
  assert.deepEqual(payload.allowedMentions, { parse: [] });
});

test("bulk unban records each user, sends DMs only after success, and reports honest totals", async t => {
  const f = fixture(t);
  require("../server-logs/store")(f.db).set(f.guild.id, "bans", "logs");
  const { targets } = bulkBans(f);
  const fetchUser = f.client.users.fetch;
  f.client.users.fetch = async id => {
    assert.ok(f.calls.some(call => call.id === id), "DM must follow the completed unban");
    assert.equal(f.db.prepare("SELECT status FROM bot_ban_audit WHERE targetId=?").get(id).status, "success");
    return fetchUser(id);
  };
  const preview = await f.api.previewAll(f.guild, ids.actor, "Nova oportunidade @everyone");
  const i = f.interaction(bulkConfirmation(preview));
  await f.api.onInteraction(i);
  await f.api.onInteraction(i);
  assert.deepEqual(f.calls.map(c => c.id), targets);
  assert.ok(f.calls.every(c => c.action === "unban" && c.reason.includes(ids.actor)));
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM bot_ban_audit WHERE status='success' AND action='unban'").get().n, 3);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM bot_ban_notifications WHERE status='sent'").get().n, 3);
  assert.equal(f.dms.length, 3);
  assert.equal(f.messages.length, 1, "one aggregate log, not a flood of per-user messages");
  const result = i.edits.at(-1).components[0].toJSON();
  assert.equal(result.accent_color, 0x527766);
  assert.match(JSON.stringify(result), /Desbanidos: \*\*3\*\*/);
  assert.match(JSON.stringify(result), /Entregues: \*\*3\*\*/);
  assert.equal(f.messages[0].flags, undefined);
  assert.equal(f.messages[0].components, undefined);
  assert.equal(f.messages[0].embeds.length, 1);
  for (const dm of f.dms) {
    const body = JSON.stringify(dm.payload.components[0].toJSON());
    assert.match(body, /Você foi desbanido/);
    assert.match(body, /convite válido/);
    assert.doesNotMatch(body, /bm:|custom_id|@everyone/);
    assert.equal(dm.payload.flags, MessageFlags.IsComponentsV2);
    assert.deepEqual(dm.payload.allowedMentions, { parse: [] });
  }
});

test("bulk handles closed DMs, already removed bans and per-user failures without notifying failed targets", async t => {
  const f = fixture(t);
  const { targets } = bulkBans(f, 4);
  f.guild.members.unban = async id => {
    if (id === targets[1]) throw Object.assign(new Error("Unknown Ban"), { code: 10026 });
    if (id === targets[2]) throw Object.assign(new Error("Network failure"), { code: "ECONNRESET" });
    f.calls.push({ action: "unban", id });
  };
  const fetchUser = f.client.users.fetch;
  f.client.users.fetch = async id => {
    if (id === targets[0]) return { send: async () => { throw new Error("DM closed"); } };
    return fetchUser(id);
  };
  const p = await f.api.previewAll(f.guild, ids.actor, "Revisão");
  const i = f.interaction(bulkConfirmation(p));
  await f.api.onInteraction(i);
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.dms.map(dm => dm.id), [targets[3]]);
  const body = JSON.stringify(i.edits.at(-1).components[0].toJSON());
  assert.match(body, /Desbanidos: \*\*2\*\* · falhas: \*\*1\*\* · já desbanidos: \*\*1\*\*/);
  assert.match(body, /Entregues: \*\*1\*\* · não entregues: \*\*1\*\*/);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM bot_ban_audit WHERE status='success'").get().n, 2);
});

test("bulk cancellation, foreign moderator, wrong guild and forged single-confirmation route cannot mutate", async t => {
  const f = fixture(t);
  bulkBans(f);
  const p = await f.api.previewAll(f.guild, ids.actor, "Revisão");
  const id = bulkConfirmation(p);
  await f.api.onInteraction(f.interaction(id, ids.target));
  const foreign = f.interaction(id); foreign.guildId = "other";
  await f.api.onInteraction(foreign);
  await f.api.onInteraction(f.interaction(id.replace("confirmall", "confirm")));
  assert.equal(f.api.sessions.size, 1);
  await f.api.onInteraction(f.interaction(bulkConfirmation(p, true)));
  assert.equal(f.calls.length, 0);
  assert.equal(f.dms.length, 0);
  assert.equal(f.api.sessions.size, 0);
});

test("bulk requires Administrator as well as moderation permissions, bot permissions, a reason and at least one ban", async t => {
  const f = fixture(t);
  bulkBans(f, 0);
  await assert.rejects(f.api.previewAll(f.guild, ids.actor, ""), /motivo/i);
  await assert.rejects(f.api.previewAll(f.guild, ids.actor, "x".repeat(401)), /400/);
  await assert.rejects(f.api.previewAll(f.guild, ids.actor, "Revisão"), /Não há usuários/);
  bulkBans(f);
  f.moderator.permissions = new PermissionsBitField([PermissionFlagsBits.BanMembers]);
  await assert.rejects(f.api.previewAll(f.guild, ids.actor, "Revisão"), /Administrador/);
  f.moderator.permissions = new PermissionsBitField([PermissionFlagsBits.ManageGuild]);
  await assert.rejects(f.api.previewAll(f.guild, ids.actor, "Revisão"), /Banir Membros/);
  f.moderator.permissions = new PermissionsBitField([PermissionFlagsBits.ManageGuild, PermissionFlagsBits.BanMembers]);
  await assert.rejects(f.api.previewAll(f.guild, ids.actor, "Revisão"), /Administrador/);
  f.moderator.permissions.add(PermissionFlagsBits.Administrator);
  f.bot.permissions = new PermissionsBitField([]);
  await assert.rejects(f.api.previewAll(f.guild, ids.actor, "Revisão"), /bot precisa/);
  assert.equal(f.calls.length, 0);
});

test("bulk revalidates permissions on confirmation and stops if access is revoked during the batch", async t => {
  const f = fixture(t);
  bulkBans(f);
  let p = await f.api.previewAll(f.guild, ids.actor, "Revisão");
  f.moderator.permissions = new PermissionsBitField([]);
  let i = f.interaction(bulkConfirmation(p));
  await f.api.onInteraction(i);
  assert.equal(f.calls.length, 0);
  assert.match(JSON.stringify(i.edits.at(-1).components[0].toJSON()), /interrompido/);
  f.moderator.permissions = new PermissionsBitField([PermissionFlagsBits.ManageGuild, PermissionFlagsBits.BanMembers]);
  f.moderator.permissions.add(PermissionFlagsBits.Administrator);
  p = await f.api.previewAll(f.guild, ids.actor, "Revisão");
  const fetchUser = f.client.users.fetch;
  f.client.users.fetch = async id => {
    f.moderator.permissions = new PermissionsBitField([PermissionFlagsBits.BanMembers]);
    return fetchUser(id);
  };
  i = f.interaction(bulkConfirmation(p));
  await f.api.onInteraction(i);
  assert.equal(f.calls.length, 1);
  assert.match(JSON.stringify(i.edits.at(-1).components[0].toJSON()), /Não processados: \*\*2\*\*/);
  assert.match(JSON.stringify(i.edits.at(-1).components[0].toJSON()), /Administrador/);
});

test("bulk permission failures stop the batch and never claim success or send a DM", async t => {
  const f = fixture(t);
  bulkBans(f);
  f.guild.members.unban = async () => { throw Object.assign(new Error("Missing Permissions"), { code: 50013 }); };
  const p = await f.api.previewAll(f.guild, ids.actor, "Revisão");
  const i = f.interaction(bulkConfirmation(p));
  await f.api.onInteraction(i);
  assert.equal(f.dms.length, 0);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM bot_ban_audit WHERE status='failed'").get().n, 1);
  assert.match(JSON.stringify(i.edits.at(-1).components[0].toJSON()), /interrompido/);
});

test("bulk snapshot excludes bans added later and expired confirmations cannot execute", async t => {
  const f = fixture(t);
  const { targets } = bulkBans(f, 1);
  let p = await f.api.previewAll(f.guild, ids.actor, "Revisão");
  bulkBans(f, 3);
  await f.api.onInteraction(f.interaction(bulkConfirmation(p)));
  assert.deepEqual(f.calls.map(c => c.id), targets);
  p = await f.api.previewAll(f.guild, ids.actor, "Revisão");
  [...f.api.sessions.values()][0].expires = 0;
  await f.api.onInteraction(f.interaction(bulkConfirmation(p)));
  assert.equal(f.calls.length, 1);
});

test("bulk serializes guild-wide actions and ignores a second confirmation while running", async t => {
  const f = fixture(t);
  bulkBans(f, 1);
  const p = await f.api.previewAll(f.guild, ids.actor, "Revisão");
  const second = await f.api.previewAll(f.guild, ids.actor, "Revisão");
  const single = await f.api.preview(f.guild, ids.actor, "ban", ids.target, "Motivo");
  let release, started;
  const ready = new Promise(resolve => { started = resolve; });
  f.guild.members.unban = async id => {
    f.calls.push({ action: "unban", id });
    started();
    await new Promise(resolve => { release = resolve; });
  };
  const running = f.api.onInteraction(f.interaction(bulkConfirmation(p)));
  await ready;
  try {
    await f.api.onInteraction(f.interaction(bulkConfirmation(second)));
    await f.api.onInteraction(f.interaction(confirmationId(single)));
    await assert.rejects(f.api.previewAll(f.guild, ids.actor, "Revisão"), /andamento/);
    assert.equal(f.calls.length, 1);
  } finally {
    release();
    await running;
  }
});

test("both !unban all and !unbanall open the styled confirmation, and slash registers the same safeguards", async t => {
  const f = fixture(t);
  bulkBans(f, 2);
  for (const [command, content] of [["desbanir", "!unban all Nova oportunidade"], ["unbanall", "!unbanall Nova oportunidade"]]) {
    const sent = [];
    await f.commands.get(command).prefix.execute({
      guild: f.guild, author: { id: ids.actor }, content,
      channel: { send: async p => { sent.push(p); return { id: "confirmation" }; } }
    });
    assert.equal(sent[0].flags, MessageFlags.IsComponentsV2);
    assert.match(JSON.stringify(sent[0].components[0].toJSON()), /Confirmar desbanimento de todos/);
    assert.equal(f.calls.length, 0);
  }
  const command = f.commands.get("unbanall");
  assert.deepEqual(command.permissions, ["BanMembers", "ManageGuild", "Administrator"]);
  assert.equal(command.slash.data.toJSON().default_member_permissions,
    String(PermissionFlagsBits.Administrator | PermissionFlagsBits.BanMembers | PermissionFlagsBits.ManageGuild));
});

test("single unban also sends its DM after completion, while an API failure never notifies", async t => {
  const f = fixture(t);
  const fetchUser = f.client.users.fetch;
  f.client.users.fetch = async id => {
    assert.ok(f.calls.some(call => call.action === "unban" && call.id === id));
    return fetchUser(id);
  };
  let p = await f.api.preview(f.guild, ids.actor, "unban", ids.target, "Recurso aceito");
  await f.api.onInteraction(f.interaction(confirmationId(p)));
  assert.equal(f.dms.length, 1);
  f.guild.members.unban = async () => { throw new Error("Discord unavailable"); };
  p = await f.api.preview(f.guild, ids.actor, "unban", ids.target, "Recurso aceito");
  await f.api.onInteraction(f.interaction(confirmationId(p)));
  assert.equal(f.dms.length, 1);
});
