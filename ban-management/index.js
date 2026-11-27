const { randomUUID } = require("node:crypto");
const {
  ContainerBuilder, TextDisplayBuilder, SeparatorBuilder, SeparatorSpacingSize,
  SectionBuilder, ThumbnailBuilder, ActionRowBuilder,
  ButtonBuilder, ButtonStyle, ModalBuilder, LabelBuilder, TextInputBuilder,
  TextInputStyle, MessageFlags, PermissionFlagsBits, SlashCommandBuilder, escapeMarkdown,
  RoleSelectMenuBuilder
} = require("discord.js");
const emoji = require("./emojis");
const { errorText } = require("../error-ui");
const V2 = MessageFlags.IsComponentsV2;
const privateFlags = V2 | MessageFlags.Ephemeral;
const TTL = 5 * 60_000;
const CARD_TTL = 30_000;
const MAX_WEEKLY_LIMIT = 1000;
const WEEK_MS = 7 * 24 * 60 * 60_000;
const WEEK_ZONE = "America/Sao_Paulo";
const COLORS = { neutral: 0, success: 0x527766, denied: 0x89545d };
const snowflake = /^\d{17,20}$/;
const safe = value => escapeMarkdown(String(value)).replace(/@/g, "@\u200b");

// Semana de segunda 00:00 a domingo 23:59 no horário de Brasília. O fuso não
// tem horário de verão desde 2019, então o deslocamento é estável.
function zoneOffsetMs(at) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: WEEK_ZONE, timeZoneName: "longOffset"
  }).formatToParts(new Date(at));
  const value = parts.find(part => part.type === "timeZoneName")?.value || "";
  const match = /^GMT([+-])(\d{1,2})(?::(\d{2}))?$/.exec(value);
  if (!match) return 0;
  const sign = match[1] === "-" ? -1 : 1;
  return sign * (Number(match[2]) * 60 + Number(match[3] || 0)) * 60_000;
}
function weekWindow(at = Date.now()) {
  const offset = zoneOffsetMs(at);
  const local = new Date(at + offset);
  local.setUTCHours(0, 0, 0, 0);
  local.setUTCDate(local.getUTCDate() - ((local.getUTCDay() + 6) % 7));
  const start = local.getTime() - offset;
  return { start, end: start + WEEK_MS };
}

module.exports = function installBans({ client, registry, db, logger = console, cardTtlMs = CARD_TTL }) {
  const logs = require("../server-logs/store")(db);
  const resources = require("../resource-ids")(db);
  const store = require("./store")(db);
  const sessions = new Map(), locks = new Set(), actorLocks = new Set(), bulkLocks = new Set();
  db.exec(`CREATE TABLE IF NOT EXISTS bot_ban_notifications(
    recordId TEXT PRIMARY KEY,guildId TEXT NOT NULL,targetId TEXT NOT NULL,
    status TEXT NOT NULL,sentAt INTEGER)`);

  function iconText(guild, key) {
    const icon = emoji(guild, key);
    return icon ? `<${icon.animated ? "a" : ""}:${icon.name}:${icon.id}> ` : "";
  }
  function button(guild, id, label, key, style = ButtonStyle.Secondary) {
    const b = new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style);
    const icon = emoji(guild, key);
    if (icon) b.setEmoji(icon);
    return b;
  }
  const text = content => new TextDisplayBuilder().setContent(content);
  const divider = () => new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small);
  const pack = container => require("../lumiya-ui/canonical").canonical({ components: [container],files:require("../configuration/runtime").filesFor([container]), flags: privateFlags, allowedMentions: { parse: [] } },{path:["Moderação","Banimentos"]});
  function heading(guild, title, subtitle, withIcon = false, key = "members", state = "neutral") {
    const c = new ContainerBuilder().setAccentColor(COLORS[state]);
    const titleText = `## ${title}\n-# ${subtitle}`;
    const content = text(state === "denied" ? errorText(titleText) : `## ${iconText(guild, key)}${title}\n-# ${subtitle}`);
    const icon = withIcon ? guild.iconURL?.({ extension: "png", size: 128 }) : null;
    if (icon) c.addSectionComponents(new SectionBuilder().addTextDisplayComponents(content)
      .setThumbnailAccessory(new ThumbnailBuilder().setURL(icon)));
    else c.addTextDisplayComponents(content);
    return c;
  }
  function footer(c, content) {
    return c.addSeparatorComponents(divider()).addTextDisplayComponents(text(`-# ${content}`));
  }
  function identity(c, targetId) {
    const content = text(`**Usuário**\n<@${targetId}>\n-# ID: ${targetId}`);
    const avatar = client.users.cache?.get(targetId)?.displayAvatarURL?.({ extension: "png", size: 128 });
    if (avatar) c.addSectionComponents(new SectionBuilder().addTextDisplayComponents(content)
      .setThumbnailAccessory(new ThumbnailBuilder().setURL(avatar)));
    else c.addTextDisplayComponents(content);
    return c;
  }
  function reasonBlock(c, reason) {
    return c.addTextDisplayComponents(text(`**Motivo**\n> ${safe(reason).replace(/\r?\n/g, "\n> ")}`));
  }
  // Vale o cargo configurado mais alto que a pessoa tiver. Cargos sem
  // configuração não restringem; sem nenhum cargo configurado, não há limite.
  function quotaFor(guild, member) {
    const configured = new Map(store.limits(guild.id).map(row => [row.roleId, row.limitCount]));
    if (!configured.size) return null;
    let selected = null;
    for (const role of member?.roles?.cache?.values?.() || []) {
      const limit = configured.get(role.id);
      if (limit === undefined) continue;
      if (!selected || role.position > selected.position)
        selected = { roleId: role.id, position: role.position, limit };
    }
    if (!selected) return null;
    const { start, end } = weekWindow();
    const used = store.bansSince(guild.id, member.id, start, end);
    return { ...selected, used, remaining: Math.max(0, selected.limit - used), start, end };
  }
  function quotaText(quota) {
    const reset = `<t:${Math.floor(quota.end / 1000)}:R>`;
    const usage = quota.remaining
      ? `Já usou **${quota.used}** de **${quota.limit}** · ainda pode dar **${quota.remaining}**`
      : `Já usou **${quota.used}** de **${quota.limit}** · limite atingido`;
    return `**Limite semanal**\n${usage}\n-# Renova ${reset} · segunda-feira, 00:00 de Brasília`;
  }
  function limitReached(quota) {
    const error = new Error("Limite semanal de banimentos atingido.");
    error.banQuota = quota;
    return error;
  }
  function expire(message, delay = cardTtlMs) {
    if (!message?.delete) return;
    const timer = setTimeout(() => {
      Promise.resolve().then(() => message.delete?.()).catch(() => {});
    }, delay);
    timer?.unref?.();
  }
  function banNotice(guild, record, phase = "pending") {
    const name = safe((guild.name || "Servidor").slice(0, 100));
    const description = phase === "success"
      ? `Seu acesso ao servidor **${name}** foi removido pela equipe de moderação.`
      : phase === "failed"
        ? `A solicitação de banimento da sua conta em **${name}** não pôde ser concluída pelo bot.\nEste aviso não confirma um banimento.`
        : `A equipe de moderação aprovou uma solicitação de banimento da sua conta em **${name}**.\nA aplicação está em andamento.`;
    const c = heading(guild, phase === "failed" ? "Solicitação não concluída" : "Aviso de banimento", name, true, "reject", "denied")
      .addSeparatorComponents(divider())
      .addTextDisplayComponents(text(description));
    reasonBlock(c, record.reason);
    c.addTextDisplayComponents(text(`**Responsável pelo banimento**\n<@${record.actorId}>\n-# ID: ${record.actorId}`));
    const date = new Intl.DateTimeFormat("pt-BR", {
      timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "medium"
    }).format(record.createdAt);
    c.addTextDisplayComponents(text(`**Data e hora**\n${date} · Brasília\n\n**Registro**\n\`${record.id}\``));
    footer(c, "Notificação automática · responder a esta mensagem não abre um recurso.");
    const payload = pack(c);
    payload.flags = V2;
    return payload;
  }
  async function notifyBeforeBan(guild, record) {
    // Uma única tentativa por operação. Não repetir DMs em confirmações duplicadas.
    const claimed = db.prepare("INSERT OR IGNORE INTO bot_ban_notifications VALUES(?,?,?,'attempted',NULL)")
      .run(record.id, guild.id, record.targetId);
    if (!claimed.changes) return {
      status: db.prepare("SELECT status FROM bot_ban_notifications WHERE recordId=?").get(record.id).status
    };
    try {
      const user = await client.users.fetch(record.targetId);
      // Abrir a DM enquanto ainda há um servidor em comum com o destinatário.
      const message = await user.send(banNotice(guild, record));
      db.prepare("UPDATE bot_ban_notifications SET status='sent',sentAt=? WHERE recordId=?").run(Date.now(), record.id);
      return { status: "sent", message };
    } catch (error) {
      db.prepare("UPDATE bot_ban_notifications SET status='failed' WHERE recordId=?").run(record.id);
      logger.warn?.(`[Banimentos] Aviso privado indisponível antes do banimento${Number.isInteger(error?.code) ? ` (Discord ${error.code})` : ""}.`);
      return { status: "failed" };
    }
  }
  async function updateBanNotice(guild, record, notification, phase) {
    if (!notification?.message) return;
    try {
      await notification.message.edit(banNotice(guild, record, phase));
    } catch {
      // Não enviar outra DM nem desfazer uma ação já executada.
      logger.warn?.("[Banimentos] O aviso privado foi entregue, mas não foi possível atualizar o resultado.");
    }
  }
  async function notifyAfterUnban(guild, record) {
    const claimed = db.prepare("INSERT OR IGNORE INTO bot_ban_notifications VALUES(?,?,?,'attempted',NULL)")
      .run(record.id, guild.id, record.targetId);
    if (!claimed.changes) return db.prepare("SELECT status FROM bot_ban_notifications WHERE recordId=?").get(record.id).status;
    try {
      const name = safe((guild.name || "Servidor").slice(0, 100));
      const c = heading(guild, "Você foi desbanido", name, true, "approve", "success")
        .addSeparatorComponents(divider())
        .addTextDisplayComponents(text(
          `Seu banimento em **${name}** foi removido pela equipe de moderação.\n` +
          "Você pode voltar ao servidor com um convite válido."));
      reasonBlock(c, record.reason);
      c.addTextDisplayComponents(text(
        `**Responsável pelo desbanimento**\n<@${record.actorId}>\n\n` +
        `**Data e hora**\n<t:${Math.floor(record.createdAt / 1000)}:f>\n\n**Registro**\n\`${record.id}\``));
      footer(c, "Notificação automática · o desbanimento não adiciona sua conta ao servidor.");
      const payload = pack(c); payload.flags = V2;
      const user = await client.users.fetch(record.targetId);
      await user.send(payload);
      db.prepare("UPDATE bot_ban_notifications SET status='sent',sentAt=? WHERE recordId=?").run(Date.now(), record.id);
      return "sent";
    } catch {
      db.prepare("UPDATE bot_ban_notifications SET status='failed' WHERE recordId=?").run(record.id);
      logger.warn?.("[Banimentos] Desbanimento concluído; DM fechada ou indisponível.");
      return "failed";
    }
  }
  function resultCard(guild, record, log = false, quota = null) {
    const ban = record.action === "ban";
    const c = heading(guild, ban ? "Banimento concluído" : "Desbanimento concluído",
      log ? "Registro de moderação" : "Ação realizada com sucesso", false, "approve", "success")
      .addSeparatorComponents(divider());
    identity(c, record.targetId);
    reasonBlock(c, record.reason);
    c.addTextDisplayComponents(text(`**Responsável**\n<@${record.actorId}> · <t:${Math.floor(record.createdAt / 1000)}:f>`));
    if (log && ban) c.addTextDisplayComponents(text(`**Mensagens**\n${record.deleteSeconds
      ? `Limpeza solicitada: últimas ${record.deleteSeconds / 3600} hora(s).`
      : "Histórico de mensagens preservado."}`));
    if (record.dmStatus) c.addTextDisplayComponents(text(record.dmStatus === "sent"
      ? "-# Notificação privada entregue ao usuário."
      : errorText(`Notificação privada não entregue: DM fechada ou indisponível. O ${ban ? "banimento" : "desbanimento"} foi concluído.`)));
    if (ban && quota) c.addTextDisplayComponents(text(quotaText(quota)));
    footer(c, log ? `Registro: ${record.id}` : ban
      ? "Acesso removido · registro salvo no histórico."
      : "Acesso liberado · o usuário pode retornar com um convite.");
    return pack(c);
  }
  function historyCard(guild, rows) {
    const c = heading(guild, "Histórico de banimentos", "Atividade recente da moderação", true, "list")
      .addSeparatorComponents(divider());
    if (!rows.length) c.addTextDisplayComponents(text(
      "**Nenhuma ação registrada**\nOs banimentos e desbanimentos realizados pelo bot aparecerão aqui."));
    rows.forEach((record, index) => {
      if (index) c.addSeparatorComponents(divider());
      const status = record.status === "success" ? `${iconText(guild, "approve")}Concluído`
        : record.status === "failed" ? errorText("Falhou") : `${iconText(guild, "options")}Pendente de verificação`;
      const reason = `${safe(record.reason.slice(0, 120))}${record.reason.length > 120 ? "…" : ""}`;
      c.addTextDisplayComponents(text(
        `**${record.action === "ban" ? "Banimento" : "Desbanimento"}** · <@${record.targetId}>\n` +
        `> ${reason.replace(/\r?\n/g, "\n> ")}\n` +
        `-# ${status} · por <@${record.actorId}> · <t:${Math.floor(record.createdAt / 1000)}:R>`));
    });
    footer(c, `${rows.length ? `${rows.length} registro(s) recente(s)` : "Histórico do servidor"} · visível somente à moderação`);
    return pack(c);
  }
  function errorCard(guild, message, action = null) {
    const missingReason = message === "Informe um motivo para a ação antes de continuar.";
    const c = heading(guild, missingReason ? "Motivo obrigatório" : "Ação negada",
      missingReason ? "Complete os dados para continuar" : "Não foi possível concluir a solicitação", false, "warning", "denied")
      .addTextDisplayComponents(text(missingReason
        ? "Toda ação precisa de um motivo.\nDescreva o ocorrido para manter um registro claro para a equipe."
        : String(message).slice(0, 700)))
      .addSeparatorComponents(divider())
      .addTextDisplayComponents(text(missingReason
        ? "**Como continuar**\nInforme um motivo para a ação antes de continuar.\nPreencha o campo **Motivo** ou escreva-o após o usuário."
        : "**Próximo passo**\nRevise a informação acima e tente novamente."));
    if (missingReason && action) {
      const command = action === "unbanall" ? "!unban all" : action === "unban" ? "!desbanir ID" : "!ban @usuário";
      c.addTextDisplayComponents(text(`**Como usar**\n\`\`\`\n${command} motivo\n\`\`\``));
    }
    footer(c, missingReason ? "Nenhuma ação foi realizada." : "Verifique os dados antes de tentar novamente.");
    return pack(c);
  }
  function friendlyError(error) {
    const message = String(error?.message || "");
    if (error?.banQuota) {
      const quota = error.banQuota;
      return `Você já usou **${quota.used} de ${quota.limit}** banimentos nesta semana. ` +
        `O limite renova <t:${Math.floor(quota.end / 1000)}:R> (segunda-feira, 00:00 de Brasília).`;
    }
    if (/motivo.*no máximo 400/i.test(message)) return "O motivo pode ter até 400 caracteres. Resuma o ocorrido e tente novamente.";
    if (/motivo/i.test(message)) return "Informe um motivo para a ação antes de continuar.";
    if (/Gerenciar Servidor e Banir Membros/i.test(message))
      return "Você precisa de **Gerenciar Servidor** e **Banir Membros** para desbanir todos.";
    if (/bot precisa de Banir Membros/i.test(message)) return "O bot precisa da permissão **Banir Membros** para executar esta ação.";
    if (/Banir Membros/i.test(message)) return "Você precisa da permissão **Banir Membros** para usar esta função.";
    if (/cargo.*(acima|alto)|abaixo do seu cargo/i.test(message)) return "Não é possível banir este membro: o cargo dele é igual ou superior ao seu ou ao do bot.";
    if (/dono|proprietário|si mesmo|este bot/i.test(message)) return "Por segurança, esta ação não pode ser aplicada a esse usuário.";
    if (/ID de usuário válido/i.test(message)) return "O ID informado não parece válido. Use o ID numérico do usuário.";
    if (/não está banido/i.test(message)) return "Este usuário não está banido neste servidor.";
    if (/0 a 168 horas/i.test(message)) return "Informe um número inteiro entre 0 e 168 para apagar mensagens.";
    if ([50013, 50001].includes(error?.code)) return "O Discord recusou a ação. Verifique se o bot tem **Banir Membros** e se o cargo dele está acima do usuário.";
    if (error?.code === 10007) return "Não foi possível encontrar esse usuário. Confira o ID e tente novamente.";
    if (error?.code === 10026) return "Este usuário não está banido neste servidor.";
    if (error?.code) return "O Discord não conseguiu concluir a ação. Verifique o ID e as permissões e tente novamente.";
    return message ? safe(message) : "A operação não pôde ser concluída. Confira os dados e tente novamente.";
  }
  const reply = (i, payload) => i.deferred || i.replied ? i.editReply(payload) : i.reply(payload);
  async function sendConfirmation(channel, payload, keepWhile = () => false) {
    const message = await channel.send(payload);
    registry.preserveMessage(message);
    const timer = setTimeout(() => {
      if (keepWhile()) return;
      Promise.resolve(message.delete?.()).catch(() => {});
    }, TTL);
    timer.unref?.();
    return message;
  }

  async function actor(guild, actorId) {
    const member = await guild.members.fetch({ user: actorId, force: true });
    if (!member.permissions.has(PermissionFlagsBits.BanMembers)) throw new Error("Você precisa de Banir Membros.");
    return member;
  }
  async function bulkAccess(guild, actorId) {
    const moderator = await actor(guild, actorId);
    if (!moderator.permissions.has(PermissionFlagsBits.Administrator))
      throw new Error("Você precisa da permissão Administrador para desbanir todos.");
    if (!moderator.permissions.has(PermissionFlagsBits.ManageGuild))
      throw new Error("Você precisa de Gerenciar Servidor e Banir Membros para desbanir todos.");
    const me = await guild.members.fetchMe();
    if (!me.permissions.has(PermissionFlagsBits.BanMembers)) throw new Error("O bot precisa de Banir Membros.");
  }
  function bulkCard(guild, s, phase) {
    const done = phase === "done";
    const c = heading(guild,
      done ? (s.stopped ? "Desbanimento em massa interrompido" : "Desbanimento em massa concluído")
        : phase === "preview" ? "Confirmar desbanimento de todos" : "Desbanimento em massa em andamento",
      phase === "preview" ? "Revise o alcance antes de liberar os acessos."
        : "Operação da equipe de moderação", true, "approve",
      done && !s.failed && !s.stopped ? "success" : "neutral")
      .addSeparatorComponents(divider())
      .addTextDisplayComponents(text(`**Contas selecionadas**\n${s.targetIds.length} usuário(s) banido(s)`));
    reasonBlock(c, s.reason);
    if (phase === "preview") {
      c.addTextDisplayComponents(text(
        "**O que vai acontecer**\nTodos os banimentos selecionados serão removidos, um por vez.\n" +
        "Cada pessoa desbanida receberá uma tentativa de aviso por DM. DMs bloqueadas não impedem a ação.\n" +
        "-# A operação não pode ser desfeita automaticamente. Novos banimentos não entram neste lote."));
      footer(c, `Solicitado por <@${s.actorId}> · expira em 5 minutos`);
      c.addActionRowComponents(new ActionRowBuilder().addComponents(
        button(guild, `bm:confirmall:${s.id}`, `Desbanir ${s.targetIds.length} usuário(s)`, "approve", ButtonStyle.Danger),
        button(guild, `bm:cancelall:${s.id}`, "Cancelar", "reject")
      ));
    } else {
      c.addTextDisplayComponents(text(
        `**Resultado${done ? "" : " parcial"}**\n` +
        `Desbanidos: **${s.success}** · falhas: **${s.failed}** · já desbanidos: **${s.skipped}**\n` +
        `Não processados: **${s.targetIds.length - s.success - s.failed - s.skipped}**\n\n` +
        `**Avisos privados**\nEntregues: **${s.dmSent}** · não entregues: **${s.dmFailed}**`));
      if (s.stopped) c.addTextDisplayComponents(text(`**Por que parou**\n${s.stopped}`));
      c.addTextDisplayComponents(text(`**Responsável**\n<@${s.actorId}>`));
      footer(c, `Lote: ${s.id} · registros individuais salvos no histórico.`);
    }
    return pack(c);
  }
  async function previewAll(guild, actorId, reason) {
    reason = String(reason || "").trim();
    if (!reason) throw new Error("Informe um motivo de 1 a 400 caracteres.");
    if (reason.length > 400) throw new Error("O motivo deve ter no máximo 400 caracteres.");
    await bulkAccess(guild, actorId);
    if (bulkLocks.has(guild.id)) throw new Error("Já existe um desbanimento em massa em andamento neste servidor.");
    const targetIds = [];
    let after;
    for (;;) {
      const page = await guild.bans.fetch({ limit: 1000, after, cache: false });
      targetIds.push(...page.keys());
      if (page.size < 1000) break;
      after = [...page.keys()].reduce((a, b) => BigInt(a) > BigInt(b) ? a : b);
    }
    if (!targetIds.length) throw new Error("Não há usuários banidos neste servidor.");
    prune();
    const s = { id: randomUUID(), guildId: guild.id, actorId, action: "unbanall",
      targetIds, reason, expires: Date.now() + TTL,
      success: 0, failed: 0, skipped: 0, dmSent: 0, dmFailed: 0 };
    sessions.set(s.id, s);
    return bulkCard(guild, s, "preview");
  }
  async function confirmAll(i, id, cancel = false) {
    prune();
    const s = sessions.get(id);
    if (!s || s.action !== "unbanall" || s.guildId !== i.guildId || s.actorId !== i.user.id)
      return i.reply(errorCard(i.guild, "Confirmação expirada ou pertencente a outro moderador."));
    sessions.delete(id);
    await i.deferUpdate();
    if (cancel) {
      const c = heading(i.guild, "Ação cancelada", "Desbanimento em massa cancelado", false, "options");
      footer(c, "Nenhum banimento foi removido e nenhuma DM foi enviada.");
      expire(await i.editReply(pack(c)));
      return;
    }
    if (bulkLocks.has(s.guildId) || [...locks].some(key => key.startsWith(`${s.guildId}:`)))
      return i.editReply(errorCard(i.guild, "Já existe uma ação de moderação em andamento. Aguarde e solicite novamente."));
    bulkLocks.add(s.guildId);
    // Edições públicas não dependem do token de interação (que expira em 15 minutos).
    const update = payload => i.message?.edit && !i.message.flags?.has?.(MessageFlags.Ephemeral)
      ? i.message.edit({ ...payload, flags: V2 }).catch(() => null)
      : i.editReply(payload).catch(() => null);
    let lastUpdate = Date.now();
    try {
      await bulkAccess(i.guild, s.actorId);
      await update(bulkCard(i.guild, s, "running"));
      for (const targetId of s.targetIds) {
        try {
          await bulkAccess(i.guild, s.actorId);
        } catch (error) {
          s.stopped = friendlyError(error);
          break;
        }
        const record = { id: randomUUID(), guildId: s.guildId, actorId: s.actorId,
          targetId, action: "unban", reason: s.reason, deleteSeconds: 0, createdAt: Date.now() };
        db.prepare("INSERT INTO bot_ban_audit VALUES(?,?,?,?,?,?,?,?,?)").run(
          record.id, s.guildId, targetId, s.actorId, "unban", s.reason, 0, "pending", record.createdAt);
        try {
          await i.guild.members.unban(targetId, `Moderador ${s.actorId} | Lote ${s.id} | ${s.reason}`);
          db.prepare("UPDATE bot_ban_audit SET status='success' WHERE id=?").run(record.id);
          s.success++;
        } catch (error) {
          db.prepare("UPDATE bot_ban_audit SET status='failed' WHERE id=?").run(record.id);
          if (error.code === 10026) s.skipped++;
          else s.failed++;
          if ([50013, 50001].includes(error.code)) {
            s.stopped = friendlyError(error);
            break;
          }
          continue;
        }
        const dmStatus = await notifyAfterUnban(i.guild, record);
        if (dmStatus === "sent") s.dmSent++;
        else s.dmFailed++;
        if (Date.now() - lastUpdate >= 5000) {
          await update(bulkCard(i.guild, s, "running"));
          lastUpdate = Date.now();
        }
      }
    } catch (error) {
      s.stopped = friendlyError(error);
    } finally {
      bulkLocks.delete(s.guildId);
    }
    const summary = bulkCard(i.guild, s, "done");
    await report(i.guild, null, null, summary);
    expire(await update(summary));
  }
  async function validate(guild, actorId, targetId, action) {
    const moderator = await actor(guild, actorId);
    const me = await guild.members.fetchMe();
    if (!me.permissions.has(PermissionFlagsBits.BanMembers)) throw new Error("O bot precisa de Banir Membros.");
    if (!snowflake.test(targetId)) throw new Error("Informe um ID de usuário válido.");
    if (action === "unban") {
      await guild.bans.fetch(targetId).catch(error => {
        if (error.code === 10026) throw new Error("Esse usuário não está banido.");
        throw error;
      });
      return moderator;
    }
    if ([actorId, guild.ownerId, me.id].includes(targetId)) throw new Error("Você não pode banir a si mesmo, o dono ou este bot.");
    const target = await guild.members.fetch({ user: targetId, force: true }).catch(error => {
      if (error.code === 10007) return null;
      throw error;
    });
    if (target) {
      if (actorId !== guild.ownerId && moderator.roles.highest.comparePositionTo(target.roles.highest) <= 0)
        throw new Error("O membro precisa estar abaixo do seu cargo mais alto.");
      if (me.roles.highest.comparePositionTo(target.roles.highest) <= 0)
        throw new Error("O cargo do bot precisa estar acima do membro.");
    } else await client.users.fetch(targetId, { force: true });
    return moderator;
  }
  function home(guild) {
    const c = heading(guild, "Banimentos", safe((guild.name || "Moderação do servidor").slice(0, 100)), true)
      .addTextDisplayComponents(text("Gerencie o acesso ao servidor com segurança."))
      .addSeparatorComponents(divider())
      .addActionRowComponents(new ActionRowBuilder().addComponents(
        button(guild, "bm:open:ban", "Banir", "reject"),
        button(guild, "bm:open:unban", "Desbanir", "approve"),
        button(guild, "bm:history", "Histórico", "list"),
        button(guild, "bm:limit:panel", "Limites", "options")
      ));
    return pack(require("../configuration/runtime").decorate(c,guild,"ban-home"));
  }
  function prune() {
    for (const [id, s] of sessions) if (s.expires <= Date.now()) sessions.delete(id);
  }
  async function preview(guild, actorId, action, targetId, reason, hours = 0) {
    if (!["ban", "unban"].includes(action)) throw new Error("Ação inválida.");
    reason = String(reason || "").trim();
    if (!reason) throw new Error("Informe um motivo de 1 a 400 caracteres.");
    if (reason.length > 400) throw new Error("O motivo deve ter no máximo 400 caracteres.");
    if (!Number.isInteger(hours) || hours < 0 || hours > 168) throw new Error("A limpeza deve ser um número inteiro entre 0 e 168 horas.");
    const moderator = await validate(guild, actorId, targetId, action);
    const quota = action === "ban" ? quotaFor(guild, moderator) : null;
    if (quota && quota.remaining <= 0) throw limitReached(quota);
    prune();
    const id = randomUUID();
    sessions.set(id, { guildId: guild.id, actorId, action, targetId, reason,
      deleteSeconds: action === "ban" ? hours * 3600 : 0, expires: Date.now() + TTL });
    const c = heading(guild, action === "ban" ? "Confirmar banimento" : "Confirmar desbanimento",
      "Confira os detalhes da ação.")
      .addSeparatorComponents(divider());
    identity(c, targetId);
    reasonBlock(c, reason);
    if (action === "ban") c.addTextDisplayComponents(text(
      `**Mensagens**\n${hours ? `Serão apagadas as últimas **${hours} hora(s)**.` : "O histórico de mensagens será preservado."}`));
    c.addTextDisplayComponents(text(action === "ban"
      ? "-# O usuário perderá o acesso ao servidor até ser desbanido."
      : "-# O usuário poderá entrar novamente com um convite válido."));
    if (quota) c.addTextDisplayComponents(text(quotaText(quota)));
    footer(c, `Solicitado por <@${actorId}> · expira em 5 minutos`);
    c.addActionRowComponents(new ActionRowBuilder().addComponents(
        button(guild, `bm:confirm:${id}`, action === "ban" ? "Confirmar banimento" : "Confirmar desbanimento",
          "approve", action === "ban" ? ButtonStyle.Danger : ButtonStyle.Secondary),
        button(guild, `bm:cancel:${id}`, "Cancelar", "reject")
      ));
    return pack(c);
  }
  async function report(guild, record, quota = null, customPayload = null) {
    const id = logs.get(guild.id, "bans");
    if (!id) return;
    try {
      const channel = await guild.channels.fetch(resources.resolve(guild.id, id));
      if (!channel || channel.guildId !== guild.id || !channel.isTextBased?.() ||
          channel.permissionsFor(guild.roles.everyone)?.has(PermissionFlagsBits.ViewChannel) !== false) return;
      const payload = require("../lumiya-ui/logs").fromPayload(
        customPayload || resultCard(guild, record, true, quota),{
          category:"moderation",title:customPayload?"Desbanimento em massa":
            record.action==="ban"?"Banimento concluído":"Desbanimento concluído",
          subtitle:"Registro de moderação",at:record?.createdAt||Date.now(),
          metadata:[["Servidor",guild.id],...(record?[["Usuário",record.targetId],["Moderador",record.actorId]]:[])],
          avatarURL:client.users.cache?.get(record?.targetId)?.displayAvatarURL?.({size:128}),
          botAvatarURL:client.user?.displayAvatarURL?.({size:128}),
          source:"Banimentos",eventId:record?.id,omitHeader:true
        });
      registry.preserveMessage(await channel.send(payload));
    } catch {
      logger.warn?.("[Banimentos] Ação concluída; envio do log indisponível. Registro mantido no banco.");
    }
  }
  async function confirm(i, id, cancel = false) {
    prune();
    const s = sessions.get(id);
    if (!s || !["ban", "unban"].includes(s.action) || s.guildId !== i.guildId || s.actorId !== i.user.id)
      return i.reply(errorCard(i.guild, "Confirmação expirada ou pertencente a outro moderador."));
    sessions.delete(id);
    await i.deferUpdate();
    if (cancel) {
      const c = heading(i.guild, "Ação cancelada", "Você pode recomeçar quando quiser", false, "options")
        .addSeparatorComponents(divider());
      identity(c, s.targetId);
      c.addTextDisplayComponents(text("A solicitação foi encerrada antes da confirmação."));
      footer(c, "Nenhuma alteração foi realizada.");
      const message = await i.editReply(pack(c));
      expire(message);
      return;
    }
    const lock = `${s.guildId}:${s.targetId}`;
    if (locks.has(lock) || bulkLocks.has(s.guildId)) {
      const message = await i.editReply(errorCard(i.guild, "Já existe uma ação em andamento para esse usuário."));
      expire(message);
      return;
    }
    locks.add(lock);
    // Serializa banimentos do mesmo moderador para o limite semanal não ser
    // ultrapassado por duas confirmações simultâneas.
    const actorLock = `${s.guildId}:${s.actorId}`;
    if (s.action === "ban" && actorLocks.has(actorLock)) {
      locks.delete(lock);
      const message = await i.editReply(errorCard(i.guild,
        "Você já tem um banimento em andamento. Aguarde a conclusão para usar o limite novamente."));
      expire(message);
      return;
    }
    if (s.action === "ban") actorLocks.add(actorLock);
    let auditId, record, notification;
    try {
      const moderator = await validate(i.guild, i.user.id, s.targetId, s.action);
      if (s.action === "ban") {
        const current = quotaFor(i.guild, moderator);
        if (current && current.remaining <= 0) throw limitReached(current);
      }
      record = { ...s, id: randomUUID(), createdAt: Date.now() };
      db.prepare("INSERT INTO bot_ban_audit VALUES(?,?,?,?,?,?,?,?,?)").run(
        record.id, s.guildId, s.targetId, s.actorId, s.action, s.reason, s.deleteSeconds, "pending", record.createdAt);
      auditId = record.id;
      const reason = `Moderador ${s.actorId} | ${s.reason}`;
      if (s.action === "ban") {
        notification = await notifyBeforeBan(i.guild, record);
        record.dmStatus = notification.status;
        // As permissões e a hierarquia podem mudar durante o envio da DM.
        await validate(i.guild, i.user.id, s.targetId, s.action);
        await i.guild.members.ban(s.targetId, { reason, deleteMessageSeconds: s.deleteSeconds });
      }
      else await i.guild.members.unban(s.targetId, reason);
      db.prepare("UPDATE bot_ban_audit SET status='success' WHERE id=?").run(auditId);
      if (s.action === "ban") await updateBanNotice(i.guild, record, notification, "success");
      else record.dmStatus = await notifyAfterUnban(i.guild, record);
      const quota = s.action === "ban" ? quotaFor(i.guild, moderator) : null;
      await report(i.guild, record, quota);
      const message = await i.editReply(resultCard(i.guild, record, false, quota));
      expire(message);
    } catch (error) {
      if (auditId) db.prepare("UPDATE bot_ban_audit SET status='failed' WHERE id=? AND status='pending'").run(auditId);
      const status = auditId && db.prepare("SELECT status FROM bot_ban_audit WHERE id=?").get(auditId)?.status;
      if (status === "success") return; // Uma falha de resposta não desfaz a ação já concluída.
      if (record) await updateBanNotice(i.guild, record, notification, "failed");
      const message = await i.editReply(errorCard(i.guild, friendlyError(error))).catch(() => null);
      expire(message);
    } finally {
      locks.delete(lock);
      if (s.action === "ban") actorLocks.delete(actorLock);
    }
  }
  function modal(guild, action) {
    const input = (id, label, description, placeholder, max, style = TextInputStyle.Short) =>
      new LabelBuilder().setLabel(label).setDescription(description)
        .setTextInputComponent(new TextInputBuilder().setCustomId(id).setStyle(style)
          .setPlaceholder(placeholder).setMaxLength(max).setRequired(true));
    const m = new ModalBuilder().setCustomId(`bm:form:${action}`).setTitle(action === "ban" ? "Novo banimento" : "Remover banimento")
      .addLabelComponents(
        input("target", "Quem é o usuário?", "Cole o ID numérico da conta.", "Ex.: 123456789012345678", 20),
        input("reason", "Motivo da ação", "Este texto ficará registrado no histórico da equipe.",
          action === "ban" ? "Descreva o ocorrido de forma clara e objetiva." : "Explique por que o acesso deve ser liberado.", 400, TextInputStyle.Paragraph)
      );
    if (action === "ban") m.addLabelComponents(new LabelBuilder().setLabel("Limpeza de mensagens")
      .setDescription("Últimas horas a apagar: de 0 a 168. Use 0 para preservar tudo.")
      .setTextInputComponent(new TextInputBuilder().setCustomId("hours").setStyle(TextInputStyle.Short)
        .setPlaceholder("0 = não apagar mensagens").setValue("0").setMaxLength(3).setRequired(true)));
    return m;
  }
  function limitsContainer(guild) {
    const rows = store.limits(guild.id);
    const c = heading(guild, "Limite de banimentos", "Controle semanal por cargo", true, "options")
      .addTextDisplayComponents(text(
        "Defina quantos banimentos cada cargo pode aplicar por semana.\n" +
        "Vale o cargo configurado mais alto que a pessoa tiver; cargos sem configuração não restringem ninguém."))
      .addSeparatorComponents(divider());
    if (rows.length) {
      for (const row of rows) c.addTextDisplayComponents(text(
        `<@&${row.roleId}> · **${row.limitCount}** banimento${row.limitCount === 1 ? "" : "s"} por semana`));
    } else {
      c.addTextDisplayComponents(text(
        "**Nenhum cargo configurado**\nSem limites configurados, todos podem banir sem restrição semanal."));
    }
    c.addTextDisplayComponents(text(
      "-# A semana começa na segunda-feira, 00:00 de Brasília. " +
      "Escolha um cargo no menu para definir o limite; use 0 para remover."));
    c.addActionRowComponents(new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder()
      .setCustomId("bm:limit:role").setPlaceholder("Configurar o limite de um cargo")
      .setMinValues(1).setMaxValues(1)));
    return c;
  }
  function limitsPayload(guild, ephemeral = true) {
    return {
      components: [limitsContainer(guild)],
      flags: V2 | (ephemeral ? MessageFlags.Ephemeral : 0),
      allowedMentions: { parse: [] }
    };
  }
  function limitModal(guild, roleId) {
    const current = store.limit(guild.id, roleId);
    return new ModalBuilder().setCustomId(`bm:limit:form:${roleId}`)
      .setTitle("Limite semanal de banimentos")
      .addLabelComponents(new LabelBuilder().setLabel("Banimentos por semana")
        .setDescription("De 1 a 1000. Use 0 para remover o limite deste cargo.")
        .setTextInputComponent(new TextInputBuilder().setCustomId("limit").setStyle(TextInputStyle.Short)
          .setPlaceholder("Ex.: 5").setValue(current ? String(current) : "")
          .setMaxLength(4).setRequired(true)));
  }
  async function onInteraction(i) {
    if (!i.guild || !i.customId?.startsWith("bm:")) return;
    try {
      if (i.message && i.message.author?.id !== client.user.id) return;
      const [, route, value, extra] = i.customId.split(":");
      if (route === "confirmall" || route === "cancelall") return await confirmAll(i, value, route === "cancelall");
      if (route === "confirm" || route === "cancel") return await confirm(i, value, route === "cancel");
      if (route === "limit") {
        const moderator = await i.guild.members.fetch({ user: i.user.id, force: true });
        if (!moderator.permissions.has(PermissionFlagsBits.ManageGuild))
          throw new Error("Você precisa de Gerenciar Servidor para configurar os limites.");
        if (value === "panel") return await i.reply(limitsPayload(i.guild));
        if (value === "role" && i.isRoleSelectMenu?.()) {
          const roleId = i.values?.[0];
          if (!snowflake.test(roleId || "")) throw new Error("Selecione um cargo válido.");
          const role = await i.guild.roles.fetch(roleId).catch(() => null);
          if (!role) throw new Error("O cargo selecionado não existe mais neste servidor.");
          return await i.showModal(limitModal(i.guild, roleId));
        }
        if (value === "form" && i.isModalSubmit?.()) {
          const roleId = extra;
          if (!snowflake.test(roleId || "")) throw new Error("Selecione um cargo válido.");
          const role = await i.guild.roles.fetch(roleId).catch(() => null);
          if (!role) throw new Error("O cargo selecionado não existe mais neste servidor.");
          const raw = i.fields.getTextInputValue("limit").trim();
          if (!/^\d{1,4}$/.test(raw)) throw new Error("Informe um número inteiro de 0 a 1000.");
          const count = Number(raw);
          if (!Number.isInteger(count) || count < 0 || count > MAX_WEEKLY_LIMIT)
            throw new Error(`Informe um número inteiro de 0 a ${MAX_WEEKLY_LIMIT}.`);
          store.setLimit(i.guild.id, roleId, count);
          const payload = limitsPayload(i.guild);
          if (i.isFromMessage?.()) {
            return await i.update({ components: payload.components, flags: V2, allowedMentions: { parse: [] } });
          }
          return await i.reply(payload);
        }
        return;
      }
      await actor(i.guild, i.user.id);
      if (route === "open" && ["ban", "unban"].includes(value)) return await i.showModal(modal(i.guild, value));
      if (route === "form" && ["ban", "unban"].includes(value)) {
        await i.deferReply({ flags: MessageFlags.Ephemeral });
        const hours = value === "ban" ? i.fields.getTextInputValue("hours").trim() : "0";
        if (!/^\d{1,3}$/.test(hours)) throw new Error("Informe de 0 a 168 horas.");
        return await i.editReply(await preview(i.guild, i.user.id, value,
          i.fields.getTextInputValue("target").trim(), i.fields.getTextInputValue("reason"), Number(hours)));
      }
      if (route === "history") {
        const rows = db.prepare("SELECT * FROM bot_ban_audit WHERE guildId=? ORDER BY createdAt DESC,rowid DESC LIMIT 8").all(i.guildId);
        return await i.reply(historyCard(i.guild, rows));
      }
    } catch (error) {
      await reply(i, errorCard(i.guild, friendlyError(error))).catch(() => {});
    }
  }
  client.on("interactionCreate", onInteraction);

  async function prefixTarget(message, action) {
    const [, raw, ...words] = message.content.trim().split(/\s+/);
    const explicitId = raw?.replace(/^<@!?(\d+)>$/, "$1");
    if ((/^<@!?\d+>$/.test(raw || "") || /^\d+$/.test(raw || "")) && !snowflake.test(explicitId || ""))
      throw new Error("Informe um ID de usuário válido.");
    if (snowflake.test(explicitId || "")) return { targetId: explicitId, reason: words.join(" ") };
    if (action === "ban" && message.reference?.messageId) {
      let referenced;
      try { referenced = await message.fetchReference(); } catch {
        throw new Error("Não foi possível acessar a mensagem respondida. Mencione o usuário ou informe o ID.");
      }
      const guildId = referenced?.guildId || referenced?.guild?.id;
      const channelId = referenced?.channelId || referenced?.channel?.id;
      if (guildId !== message.guild.id || channelId !== (message.channelId || message.channel?.id) ||
          !snowflake.test(referenced?.author?.id || ""))
        throw new Error("A mensagem respondida precisa pertencer a este canal e servidor.");
      return { targetId: referenced.author.id, reason: [raw, ...words].filter(Boolean).join(" ") };
    }
    return raw ? { targetId: explicitId, reason: words.join(" ") } : null;
  }
  for (const [name, action] of [["ban", "ban"], ["desbanir", "unban"]]) {
    registry.register({
      name, description: action === "ban" ? "Banir um usuário com motivo e confirmação." : "Remover um banimento com motivo e confirmação.",
      category: "Moderação", permissions: ["BanMembers"], permissionLabel: "Banir Membros",
      examples: [`!${name} ID motivo`, ...(action === "ban" ? ["!ban motivo (respondendo à mensagem)"] : []), `/${name}`],
      prefix: { trigger: `!${name}`, ...(action === "unban" ? { aliases: ["!unban"] } : {}),
        usage: [`!${name} <@usuário ou ID> <motivo>`, ...(action === "ban" ? ["!ban <motivo> (respondendo à mensagem)"] : [])],
        async execute(message) {
          try {
            await actor(message.guild, message.author.id);
            if (action === "unban" && /^(?:all|todos)$/i.test(message.content.trim().split(/\s+/)[1] || "")) {
              const reason = message.content.trim().split(/\s+/).slice(2).join(" ");
              const payload = await previewAll(message.guild, message.author.id, reason);
              payload.flags = V2;
              return await sendConfirmation(message.channel, payload, () => bulkLocks.has(message.guild.id));
            }
            const target = await prefixTarget(message, action);
            if (!target) {
              const payload = home(message.guild); payload.flags = V2;
              return await message.channel.send(payload);
            }
            if (!target.reason.trim()) {
              const payload = errorCard(message.guild, friendlyError(new Error("Informe um motivo de 1 a 400 caracteres.")), action);
              payload.flags = V2;
              return await message.channel.send(payload);
            }
            const payload = await preview(message.guild, message.author.id, action, target.targetId, target.reason);
            payload.flags = V2;
            await sendConfirmation(message.channel, payload);
          } catch (error) {
            const payload = errorCard(message.guild, friendlyError(error));
            payload.flags = V2;
            await message.channel.send(payload);
          }
        } },
      slash: {
        data: new SlashCommandBuilder().setName(name).setDescription(action === "ban" ? "Banir um usuário com confirmação" : "Desbanir um usuário com confirmação")
          .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
          .addStringOption(o => o.setName("usuario").setDescription("ID do usuário").setRequired(true))
          .addStringOption(o => o.setName("motivo").setDescription("Motivo da ação").setMaxLength(400).setRequired(true)),
        async execute(i) {
          await i.deferReply({ flags: MessageFlags.Ephemeral });
          try { await i.editReply(await preview(i.guild, i.user.id, action, i.options.getString("usuario"), i.options.getString("motivo"))); }
          catch (error) { await i.editReply(errorCard(i.guild, friendlyError(error))); }
        }
      }
    });
  }
  registry.register({
    name: "unbanall", description: "Desbanir todos com confirmação e aviso privado para cada pessoa.",
    category: "Moderação", permissions: ["BanMembers", "ManageGuild", "Administrator"],
    permissionLabel: "Administrador, Banir Membros e Gerenciar Servidor",
    examples: ["!unban all motivo", "!unbanall motivo", "/unbanall"],
    prefix: { trigger: "!unbanall", aliases: ["!desbanirtodos"],
      usage: ["!unbanall <motivo>", "!unban all <motivo>"],
      async execute(message) {
        try {
          const reason = message.content.trim().split(/\s+/).slice(1).join(" ");
          const payload = await previewAll(message.guild, message.author.id, reason);
          payload.flags = V2;
          await sendConfirmation(message.channel, payload, () => bulkLocks.has(message.guild.id));
        } catch (error) {
          const payload = errorCard(message.guild, friendlyError(error), "unbanall");
          payload.flags = V2;
          await message.channel.send(payload);
        }
      }
    },
    slash: {
      data: new SlashCommandBuilder().setName("unbanall").setDescription("Desbanir todos com confirmação e aviso por DM")
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator | PermissionFlagsBits.BanMembers | PermissionFlagsBits.ManageGuild)
        .addStringOption(o => o.setName("motivo").setDescription("Motivo do desbanimento em massa").setMaxLength(400).setRequired(true)),
      async execute(i) {
        await i.deferReply({ flags: MessageFlags.Ephemeral });
        try { await i.editReply(await previewAll(i.guild, i.user.id, i.options.getString("motivo"))); }
        catch (error) { await i.editReply(errorCard(i.guild, friendlyError(error), "unbanall")); }
      }
    }
  });
  registry.register({
    name: "banpainel", description: "Publicar o painel permanente de banimentos.",
    category: "Moderação", permissions: ["BanMembers", "ManageGuild"], permissionLabel: "Banir Membros e Gerenciar Servidor",
    examples: ["!banpainel"], prefix: { trigger: "!banpainel", async execute(message) {
      const member = await actor(message.guild, message.author.id);
      if (!member.permissions.has(PermissionFlagsBits.ManageGuild)) return;
      const payload = home(message.guild); payload.flags = V2;
      registry.preserveMessage(await message.channel.send(payload));
    } }
  });
  registry.register({
    name: "limitebans", description: "Configura o limite semanal de banimentos por cargo.",
    category: "Moderação", permissions: ["ManageGuild"], permissionLabel: "Gerenciar Servidor",
    result: "Abre o painel de limites semanais de banimentos por cargo.",
    examples: ["!limitebans"], prefix: {
      trigger: "!limitebans", exact: true, aliases: ["!limitebanimentos", "!banslimite"],
      usage: ["!limitebans"],
      async execute(message) {
        const payload = limitsPayload(message.guild, false);
        registry.preserveMessage(await message.channel.send(payload));
      }
    }
  });
  return { preview, previewAll, validate, home, onInteraction, sessions, quotaFor, weekWindow, limitsPayload };
};
