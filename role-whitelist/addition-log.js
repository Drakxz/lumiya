const { AuditLogEvent, PermissionFlagsBits } = require("discord.js");

module.exports = function createAdditionLog({
  client, registry, db,
  channelId = process.env.ROLE_ADDITION_LOG_CHANNEL_ID || "1571711957927469096",
  logger = console
}) {
  const resources=require("../resource-ids")(db);
  const configuredChannelId=channelId;
  const logChannels=db?require("../server-logs/store")(db):null;
  const pending = new Map();
  const delivered = new Set();
  if (db) db.exec(`CREATE TABLE IF NOT EXISTS role_addition_channel_logs(
    guildId TEXT NOT NULL, auditId TEXT NOT NULL, page INTEGER NOT NULL,
    channelId TEXT NOT NULL, messageId TEXT NOT NULL,
    PRIMARY KEY(guildId,auditId,page,channelId)
  )`);
  const find = db?.prepare("SELECT 1 FROM role_addition_channel_logs WHERE guildId=? AND auditId=? AND page=? AND channelId=?");
  const save = db?.prepare("INSERT OR IGNORE INTO role_addition_channel_logs VALUES(?,?,?,?,?)");

  async function publish(entry, guild) {
    const channelId=logChannels?.get(guild.id,"roles")||resources.resolve(guild.id,configuredChannelId);
    if (entry.action !== AuditLogEvent.MemberRoleUpdate || !entry.id ||
        !Number.isFinite(entry.createdTimestamp) || Math.abs(Date.now() - entry.createdTimestamp) >= 60000) return;
    const targetId = entry.targetId || entry.target?.id;
    if (!targetId) return;
    const roles = [...new Set((entry.changes || [])
      .filter(change => change.key === "$add").flatMap(change => change.new || [])
      .map(role => role.id).filter(Boolean))];
    if (!roles.length) return;
    const pages = Array.from({ length: Math.ceil(roles.length / 15) }, (_, i) => roles.slice(i * 15, (i + 1) * 15));
    const sent = page => db
      ? Boolean(find.get(guild.id, entry.id, page, channelId))
      : delivered.has(`${guild.id}:${entry.id}:${page}`);
    if (pages.every((_, page) => sent(page))) return;

    // Fetch only in the origin guild. Never export member data to a foreign guild.
    const channel = await guild.channels.fetch(channelId).catch(() => null);
    if (!channel || (channel.guildId || channel.guild?.id) !== guild.id ||
        !channel.isTextBased?.() || typeof channel.send !== "function") return;
    const me = guild.members.me || await guild.members.fetchMe();
    const permissions = channel.permissionsFor(me);
    if (!permissions?.has([
      PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages
    ])) {
      logger.warn?.("[Histórico de cargos] Sem permissão para enviar no canal configurado.");
      return;
    }
    const executorId = entry.executorId || entry.executor?.id;
    // Only trust the MDS operation marker when Discord confirms MDS as executor.
    const request = executorId === client.user?.id
      ? /^mds ficha:[0-9a-f-]{36} por (\d{17,20})$/i.exec(entry.reason || "")
      : null;
    for (let page = 0; page < pages.length; page++) {
      if (sent(page)) continue;
      const message = await channel.send(require("../lumiya-ui/logs").card({
        category:"members",title:"Cargo adicionado",
        subtitle:"Registro da adição; a proteção pode removê-la em seguida.",
        summary:[
          ["Quem adicionou",executorId ? `<@${executorId}> (\`${executorId}\`)` : "Não identificado na auditoria"],
          ...(request ? [["Solicitado por",`<@${request[1]}> (\`${request[1]}\`)`]] : []),
          ["Membro",`<@${targetId}> (\`${targetId}\`)`],
          ["Cargo(s)",pages[page].map(id => `<@&${id}> (\`${id}\`)`).join(", ")]
        ],
        details:[["Auditoria",`\`${entry.id}\``],["Página",`${page+1}/${pages.length}`]],
        metadata:[["Servidor",guild.id],["Usuário",targetId]],
        avatarURL:client.users?.cache?.get(targetId)?.displayAvatarURL?.({size:128}),
        botAvatarURL:client.user?.displayAvatarURL?.({size:128}),
        at:entry.createdTimestamp,source:"Auditoria do Discord",eventId:entry.id
      }));
      registry?.preserveMessage?.(message);
      if (db) save.run(guild.id, entry.id, page, channelId, message.id);
      else {
        delivered.add(`${guild.id}:${entry.id}:${page}`);
        if (delivered.size > 5000) delivered.delete(delivered.values().next().value);
      }
    }
  }

  function inspect(entry, guild) {
    const key = `${guild.id}:${entry.id}`;
    if (pending.has(key)) return pending.get(key);
    const job = publish(entry, guild).catch(() => {
      logger.warn?.("[Histórico de cargos] Não foi possível enviar o registro; a proteção continua ativa.");
    }).finally(() => pending.delete(key));
    pending.set(key, job);
    return job;
  }
  return { inspect };
};
