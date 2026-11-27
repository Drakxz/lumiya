const { AuditLogEvent, PermissionFlagsBits } = require("discord.js");
const createStore = require("./store");

const PUNISH_PERMISSIONS = [
  PermissionFlagsBits.Administrator, PermissionFlagsBits.KickMembers,
  PermissionFlagsBits.BanMembers, PermissionFlagsBits.ModerateMembers
];

module.exports = function installModerationGuard({ client, db, history, resolveRoleId = (_g, id) => id,
  kickWindowMs = 60_000, kickLimit = 3, logger = console }) {
  const store = createStore(db);
  const handled = new Set(), pending = new Set();
  // A auditoria do Discord é imutável; eventos passados recentes ainda podem
  // reconstruir a janela de abuso após uma reinicialização.
  const recent = at => Number.isFinite(at) && at <= Date.now() + 2_000 && Date.now() - at < 10 * 60_000;

  // Castigos (timeout) aparecem na auditoria como MemberUpdate com a mudança
  // `communication_disabled_until`, ou como ação automática de moderação.
  function isTimeoutEntry(entry) {
    if (entry.action === AuditLogEvent.AutoModerationUserCommunicationDisabled) {
      entry._timeoutSeconds = null;
      return true;
    }
    if (entry.action !== AuditLogEvent.MemberUpdate) return false;
    const change = (entry.changes || []).find(c =>
      c.key === "communication_disabled_until");
    if (!change) return false;
    const until = new Date(change.new || 0).getTime();
    if (!Number.isFinite(until) || until <= Date.now()) return false; // expiração não é castigo novo
    entry._timeoutSeconds = Math.max(1, Math.round((until - (entry.createdTimestamp || Date.now())) / 1000));
    return true;
  }

  function formatarDuracao(segundos) {
    if (segundos % 86400 === 0) return `${segundos / 86400} dia(s)`;
    if (segundos % 3600 === 0) return `${segundos / 3600} hora(s)`;
    if (segundos % 60 === 0) return `${segundos / 60} minuto(s)`;
    return `${segundos} segundo(s)`;
  }

  const grant = bit => value => Boolean(value & bit);
  const rawPermissions = value => (typeof value === "bigint" || typeof value === "number")
    ? value : value?.bitfield ?? value?.allow ?? 0n;
  function privilegedRoles(guild) {
    return [...guild.roles.cache.values()].filter(role =>
      role.id !== guild.id && !role.managed &&
      PUNISH_PERMISSIONS.some(permission => role.permissions?.has?.(permission) ||
        grant(permission)(BigInt(rawPermissions(role.permissions)))));
  }

  async function sanction(guild, actorId, kind, event, entryId, reason) {
    // Castigos são apenas registrados; não removem cargo por si só.
    if (kind === "timeout") return;
    const actor = await guild.members.fetch({ user: actorId, force: true }).catch(() => null);
    if (!actor || actor.id === guild.ownerId || actor.user?.bot ||
        grant(PermissionFlagsBits.Administrator)(BigInt(rawPermissions(actor.permissions)))) return;
    const bot = guild.members.me || await guild.members.fetchMe();
    if (!bot.permissions?.has?.(PermissionFlagsBits.ManageRoles) &&
        !grant(PermissionFlagsBits.ManageRoles)(BigInt(rawPermissions(bot.permissions)))) return;
    const botRole = bot.roles?.highest || [...guild.roles.cache.values()]
      .filter(role => role.id !== guild.id && !role.managed && guild.members.me?.roles?.cache?.has(role.id))
      .sort((a, b) => (b.position || 0) - (a.position || 0))[0];
    let kicks = [];
    if (kind === "kick") kicks = store.recentKicks(guild.id, actorId, Date.now() - kickWindowMs);
    if (kind === "kick" && kicks.length < kickLimit) return;
    const roles = privilegedRoles(guild).filter(role => actor.roles.cache.has(role.id) &&
      (botRole?.position === undefined || role.position === undefined || role.position < botRole.position));
    let removed = 0, reasonText = "";
    for (const role of roles) {
      reasonText = kind === "ban"
        ? `BANIMENTO EXTERNO ao MDS: ${reason}; auditoria ${entryId}`
        : `ABUSO DE EXPULSAO: ${kickLimit} kicks em ${kickWindowMs / 1000}s; ${reason}; auditoria ${entryId}`;
      await history.alterarCargo({ guild, alvo: actor, cargo: role, action: "remove", autor: client.user,
        source: "Guardião de moderação", reason: reasonText,
        executar: auditReason => actor.roles.remove(role, auditReason) });
      removed++;
    }
    if (removed) {
      store.sanction(event.id, "role-removed", roles[0].id, null, Date.now());
      // A janela inteira é marcada como consumida para não punir o mesmo abuso
      // uma segunda vez se outro kick acontecer antes dela expirar.
      for (const kick of kicks) {
        if (kick.id !== event.id) store.sanction(kick.id, "cleanup", roles[0].id, null, Date.now());
      }
    }
    logger.log?.(`[Guardião] ${actorId}: ${kind} externo confirmado; ${removed} cargo(s) removido(s).`);
  }

  async function inspect(entry, guild) {
    if (!recent(entry.createdTimestamp)) return;
    const actorId = entry.executorId || entry.executor?.id;
    const targetId = entry.targetId || entry.target?.id;
    if (!actorId || !targetId || !client.user?.id || actorId === client.user.id) return;
    let kind = null, timeoutSeconds = null;
    if (entry.action === AuditLogEvent.MemberKick) kind = "kick";
    else if (entry.action === AuditLogEvent.MemberBanAdd) kind = "ban";
    else if (isTimeoutEntry(entry)) { kind = "timeout"; timeoutSeconds = entry._timeoutSeconds; }
    if (!kind) return;
    const key = `${guild.id}:${entry.id}:${kind}:${targetId}`;
    if (handled.has(key) || pending.has(key) || store.hasAuditId(guild.id, entry.id, targetId)) return;
    pending.add(key);
    try {
      const reason = String(entry.reason || "").replace(/\s+/g, " ").trim().slice(0, 500) || "Motivo não informado na auditoria";
      const event = store.add({ id: `audit:${guild.id}:${entry.id}:${targetId}`, guildId: guild.id, actorId, targetId, kind,
        reason: timeoutSeconds ? `${reason} (castigo de ${formatarDuracao(timeoutSeconds)})` : reason,
        auditId: entry.id, createdAt: entry.createdTimestamp || Date.now(), sanction: "none" });
      if (!event) return;
      handled.add(key);
      if (handled.size > 5000) handled.delete(handled.values().next().value);
      // Sanções exigem evidência confirmada pelo gateway em tempo real; a
      // consulta na inicialização apenas reconstrói o histórico recente.
      if (!entry._backfill) await sanction(guild, actorId, kind, event, entry.id, reason);
    } catch (error) {
      logger.warn?.("[Guardião] Falha ao processar auditoria:", error);
    } finally { pending.delete(key); }
  }

  async function fetchAudit(guild) {
    try {
      const logs = await guild.fetchAuditLogs({ limit: 100 });
      for (const entry of logs.entries.values()) {
        if (!recent(entry.createdTimestamp)) continue;
        const entryCopy = { ...entry, _backfill: true };
        if ([AuditLogEvent.MemberKick, AuditLogEvent.MemberBanAdd].includes(entry.action) || isTimeoutEntry(entryCopy))
          await inspect(entryCopy, guild);
      }
    } catch (error) { logger.warn?.("[Guardião] Auditoria indisponível:", error.message); }
  }
  const onAudit = (entry, guild) => inspect(entry, guild).catch(error => logger.warn?.("[Guardião]", error.message));
  const onReady = () => {
    for (const guild of client.guilds.cache.values()) {
      const perm = guild.members.me?.permissions;
      if (perm?.has?.(PermissionFlagsBits.ViewAuditLog) ||
          grant(PermissionFlagsBits.ViewAuditLog)(BigInt(rawPermissions(perm)))) void fetchAudit(guild);
    }
  };
  client.on("guildAuditLogEntryCreate", onAudit);
  client.once("clientReady", onReady);
  return {
    inspect, store, sanction, fetchAudit,
    configureHistory(value) { history = value; },
    close() { client.off("guildAuditLogEntryCreate", onAudit); client.off("clientReady", onReady); }
  };
};
