const { MessageType, PermissionFlagsBits } = require("discord.js");
const { serverName } = require("../brand");
const BOOST_TYPES = new Map([
  [MessageType.GuildBoost, null],
  [MessageType.GuildBoostTier1, 1],
  [MessageType.GuildBoostTier2, 2],
  [MessageType.GuildBoostTier3, 3]
]);
const since = member => member.premiumSinceTimestamp ?? member.premiumSince?.getTime?.() ?? null;

module.exports = function installBoostLogs({ client, db, registry, ensureLogs, logger = console }) {
  const channels = require("../server-logs/store")(db);
  const resources = require("../resource-ids")(db);
  const deliveries = new Map(), timers = new Map();
  db.exec(`CREATE TABLE IF NOT EXISTS server_boost_events(
    guildId TEXT NOT NULL,eventKey TEXT NOT NULL,userId TEXT NOT NULL,at INTEGER NOT NULL,
    source TEXT NOT NULL,messageId TEXT,level INTEGER,total INTEGER,logMessageId TEXT,
    PRIMARY KEY(guildId,eventKey),UNIQUE(guildId,messageId));
    CREATE INDEX IF NOT EXISTS server_boost_user ON server_boost_events(guildId,userId,at);`);
  const read = (guildId, eventKey) => db.prepare(
    "SELECT * FROM server_boost_events WHERE guildId=? AND eventKey=?").get(guildId, eventKey);
  const total = guild => Number.isInteger(guild.premiumSubscriptionCount) ? guild.premiumSubscriptionCount : null;
  const level = guild => Number.isInteger(guild.premiumTier) ? guild.premiumTier : null;

  function card(guild, row) {
    const user = client.users?.cache?.get(row.userId) || guild.members.cache?.get(row.userId)?.user;
    const avatar = user?.displayAvatarURL?.({ extension: "png", size: 128 });
    return require("../lumiya-ui/logs").card({
      category:"community",title:"Servidor impulsionado",subtitle:serverName(guild),
      summary:[["Quem impulsionou",`<@${row.userId}>\n-# ID: ${row.userId}`],
        ["Nível do servidor",row.level??"Não informado"],
        ["Total de impulsionamentos do servidor",row.total??"Não informado"]],
      details:["Evento confirmado pelo Discord · obrigado pelo apoio ao servidor!"],
      metadata:[["Servidor",guild.id],["Usuário",row.userId],...(row.messageId?[["Mensagem",row.messageId]]:[])],
      avatarURL:avatar,botAvatarURL:client.user?.displayAvatarURL?.({size:128}),
      at:row.at,source:row.source,eventId:row.eventKey
    });
  }

  async function publish(guild, eventKey) {
    const row = read(guild.id, eventKey);
    if (!row || row.logMessageId) return;
    if (!channels.get(guild.id, "boosts") && ensureLogs) await ensureLogs(guild);
    const id = channels.get(guild.id, "boosts");
    if (!id) return; // Preserva o evento até o canal de logs estar disponível.
    const channel = await guild.channels.fetch(resources.resolve(guild.id, id));
    const everyone = channel?.permissionsFor?.(guild.roles.everyone);
    const me = guild.members.me || await guild.members.fetchMe();
    if (!channel || (channel.guildId || channel.guild?.id) !== guild.id || !channel.isTextBased?.() ||
        !everyone || everyone.has(PermissionFlagsBits.ViewChannel) ||
        !channel.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])) return;
    const message = await channel.send(card(guild, row));
    db.prepare("UPDATE server_boost_events SET logMessageId=? WHERE guildId=? AND eventKey=?")
      .run(message.id, guild.id, eventKey);
    registry?.preserveMessage?.(message);
  }
  function deliver(guild, eventKey) {
    const key = `${guild.id}:${eventKey}`;
    if (deliveries.has(key)) return deliveries.get(key);
    const job = publish(guild, eventKey).catch(() => {
      logger.warn?.("[Impulsionamentos] Log indisponível; evento preservado no banco.");
    }).finally(() => deliveries.delete(key));
    deliveries.set(key, job);
    return job;
  }
  function save(guild, eventKey, userId, at, source, messageId = null, tier = level(guild)) {
    db.prepare("INSERT OR IGNORE INTO server_boost_events VALUES(?,?,?,?,?,?,?,?,NULL)")
      .run(guild.id, eventKey, userId, at, source, messageId, tier, total(guild));
  }

  async function onMessage(message) {
    if (!message.guild || !message.system || !BOOST_TYPES.has(message.type) ||
        !message.id || !message.author?.id || !Number.isFinite(message.createdTimestamp)) return;
    const guild = message.guild, userId = message.author.id, at = message.createdTimestamp;
    const existing = db.prepare("SELECT eventKey FROM server_boost_events WHERE guildId=? AND messageId=?")
      .get(guild.id, message.id);
    if (existing) return deliver(guild, existing.eventKey);
    // O aviso e premiumSince podem representar o mesmo primeiro boost.
    // Cada aviso adicional continua sendo um evento independente.
    const seed = db.prepare(`SELECT eventKey FROM server_boost_events
      WHERE guildId=? AND userId=? AND messageId IS NULL AND source='member'
      AND ABS(at-?)<=15000 ORDER BY ABS(at-?) LIMIT 1`).get(guild.id, userId, at, at);
    const tier = BOOST_TYPES.get(message.type) ?? level(guild);
    const eventKey = seed?.eventKey || `message-${message.id}`;
    if (seed) db.prepare(`UPDATE server_boost_events SET source='message',messageId=?,at=?,level=?,total=?
      WHERE guildId=? AND eventKey=?`).run(message.id, at, tier, total(guild), guild.id, eventKey);
    else save(guild, eventKey, userId, at, "message", message.id, tier);
    return deliver(guild, eventKey);
  }

  function onMemberUpdate(before, after) {
    if (!after.guild || before.partial || after.partial || before.id !== after.id || before.guild?.id !== after.guild.id) return;
    const at = since(after);
    if (since(before) || !Number.isFinite(at) || at <= 0 || Math.abs(Date.now() - at) > 120_000) return;
    const existing = db.prepare(`SELECT 1 FROM server_boost_events
      WHERE guildId=? AND userId=? AND messageId IS NOT NULL AND ABS(at-?)<=15000`)
      .get(after.guild.id, after.id, at);
    if (existing) return;
    const eventKey = `member-${after.id}-${at}`, key = `${after.guild.id}:${eventKey}`;
    save(after.guild, eventKey, after.id, at, "member");
    if (timers.has(key)) return;
    // Dá preferência ao aviso do Discord, que também identifica boosts extras.
    const timer = setTimeout(() => {
      timers.delete(key);
      void deliver(after.guild, eventKey);
    }, 5000);
    timer.unref?.();
    timers.set(key, timer);
  }
  async function flush(guild) {
    const rows = db.prepare(`SELECT eventKey FROM server_boost_events
      WHERE guildId=? AND logMessageId IS NULL ORDER BY at LIMIT 100`).all(guild.id);
    for (const row of rows) await deliver(guild, row.eventKey);
  }
  const ready = async () => {
    for (const guild of client.guilds.cache.values()) {
      if (ensureLogs) await ensureLogs(guild);
      await flush(guild);
    }
  };
  const warn = () => logger.warn?.("[Impulsionamentos] Não foi possível processar o evento.");
  const onMessageEvent = message => onMessage(message).catch(warn);
  const onMemberEvent = (before, after) => { try { onMemberUpdate(before, after); } catch { warn(); } };
  const onReady = () => ready().catch(warn);
  client.on("messageCreate", onMessageEvent);
  client.on("guildMemberUpdate", onMemberEvent);
  client.once("clientReady", onReady);
  return { onMessage, onMemberUpdate, flush, close() {
    client.off("messageCreate", onMessageEvent);
    client.off("guildMemberUpdate", onMemberEvent);
    client.off("clientReady", onReady);
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
  } };
};
