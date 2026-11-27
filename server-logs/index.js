const { ChannelType, PermissionFlagsBits } = require("discord.js");
const { AREAS } = require("../ticket-management/areas");
const { isInstagramGuild } = require("./policy");

const CHANNELS = {
  support: "logs-suporte",
  migration: "logs-migracao",
  movchat: "logs-mov-chat",
  passtime: "logs-passtime",
  general: "logs-gestao",
  roles: "logs-cargos",
  media: "logs-moderacao-midia",
  nickname: "logs-apelidos",
  backups: "logs-backups",
  bans: "logs-banimentos",
  boosts: "logs-impulsionamentos"
};
const LABELS={support:"Atendimento de suporte",migration:"Migração",movchat:"Movimentação de chat",
  passtime:"Passtime",general:"Gestão e configurações",roles:"Alterações de cargos",
  media:"Moderação de mídias",nickname:"Proteção de apelidos",backups:"Backups",
  bans:"Banimentos",boosts:"Impulsionamentos"};

module.exports = function installServerLogs({ client, db, registry, logger = console }) {
  const store = require("./store")(db);
  const media = require("../media-moderation/store").createStore(db);
  const pending = new Map();
  const reason = "Logs privados ativados pela configuração do servidor";

  function configure(guildId, kind, channelId) {
    if (AREAS.includes(kind) || kind === "general") {
      const saved = JSON.parse(db.prepare("SELECT config FROM ticket_management_config WHERE guildId=?").get(guildId)?.config || "{}");
      saved[`${kind}Log`] = channelId;
      db.prepare(`INSERT INTO ticket_management_config VALUES(?,?)
        ON CONFLICT(guildId) DO UPDATE SET config=excluded.config`).run(guildId, JSON.stringify(saved));
    } else if (kind === "media") {
      media.saveSettings(guildId, { ...media.settings(guildId), logChannelId: channelId });
    } else if (kind === "nickname") {
      db.prepare("INSERT OR IGNORE INTO nickname_protection_config(guildId) VALUES(?)").run(guildId);
      db.prepare("UPDATE nickname_protection_config SET logChannelId=? WHERE guildId=?").run(channelId, guildId);
    } else if (kind === "backups") {
      db.prepare("INSERT OR IGNORE INTO server_backup_settings(guildId) VALUES(?)").run(guildId);
      db.prepare("UPDATE server_backup_settings SET notifyChannel=? WHERE guildId=?").run(channelId, guildId);
    }
  }

  async function provision(guild) {
    const instagramOnly = isInstagramGuild(guild.id);
    const selectedChannels = instagramOnly ? { media: "logs-instagram" } : CHANNELS;
    const result={ok:false,configured:0,total:Object.keys(selectedChannels).length,failed:[]};
    const me = guild.members.me || await guild.members.fetchMe();
    if (!me.permissions.has(PermissionFlagsBits.ManageChannels)) {
      logger.warn?.(`[Logs] Sem Gerenciar Canais em ${guild.id}; categoria não criada.`);
      return {...result,reason:"A Lumiya precisa da permissão Gerenciar canais."};
    }
    if (instagramOnly) {
      // Desliga os vínculos antigos sem excluir canais nem histórico.
      db.prepare("DELETE FROM bot_log_channels WHERE guildId=? AND kind!='media'").run(guild.id);
      const saved = db.prepare("SELECT config FROM ticket_management_config WHERE guildId=?").get(guild.id);
      if (saved) {
        const config = JSON.parse(saved.config);
        for (const area of [...AREAS, "general"]) delete config[`${area}Log`];
        db.prepare("UPDATE ticket_management_config SET config=? WHERE guildId=?").run(JSON.stringify(config), guild.id);
      }
      db.prepare("UPDATE nickname_protection_config SET logChannelId=NULL WHERE guildId=?").run(guild.id);
      db.prepare("UPDATE server_backup_settings SET notifyChannel=NULL WHERE guildId=?").run(guild.id);
    }
    const channels = await guild.channels.fetch();
    const overwrites = [
      { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
      { id: me.id, allow: [
        PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.EmbedLinks,
        PermissionFlagsBits.AttachFiles, PermissionFlagsBits.ManageChannels
      ] }
    ];
    // Somente o bot, o dono e administradores; não conceder acesso a cargos
    // genéricos de equipe, pois os registros podem conter dados sensíveis.
    let category = instagramOnly ? null : channels.get(store.get(guild.id, "category"));
    if (!instagramOnly) {
      if (category?.type !== ChannelType.GuildCategory) category = null;
      if (!category) category = [...channels.values()].find(ch =>
        ch?.type === ChannelType.GuildCategory && ["Logs da Lumiya", "amex", "Logs do bot"].includes(ch.name) &&
        ch.permissionOverwrites.cache.get(guild.id)?.deny.has(PermissionFlagsBits.ViewChannel));
      if (!category) category = await guild.channels.create({
        name: "Logs da Lumiya", type: ChannelType.GuildCategory,
        permissionOverwrites: overwrites, reason
      });
      else {
        await category.permissionOverwrites.set(overwrites, reason);
      }
      store.set(guild.id, "category", category.id);
      const lastPosition = Math.max(0, ...[...channels.values()].filter(Boolean).map(ch => ch.rawPosition || 0));
      await category.setPosition(lastPosition + 1, { reason });
    }

    for (const [kind, name] of Object.entries(selectedChannels)) {
      try {
        let channel = channels.get(store.get(guild.id, kind));
        if (channel?.type !== ChannelType.GuildText) channel = null;
        if (!channel) channel = [...channels.values()].find(ch =>
          ch?.type === ChannelType.GuildText && (instagramOnly || ch.parentId === category.id) && ch.name === name);
        if (!channel) channel = await guild.channels.create({
          name, type: ChannelType.GuildText, parent: category?.id ?? null,
          permissionOverwrites: overwrites, reason
        });
        else await channel.edit({ ...(instagramOnly ? { name } : {}), parent: category?.id ?? null, permissionOverwrites: overwrites, reason });
        store.set(guild.id, kind, channel.id);
        configure(guild.id, kind, channel.id);
        registry?.preserveChannel?.(channel.id);
        result.configured++;
      } catch (error) {
        result.failed.push(kind);
        logger.warn?.(`[Logs] Não foi possível configurar ${name} em ${guild.id}: ${error.message}`);
      }
    }
    return {...result,ok:result.configured===result.total};
  }

  function prepare(guild) {
    if (pending.has(guild.id)) return pending.get(guild.id);
    const job = provision(guild).catch(error => {
      logger.warn?.(`[Logs] Falha ao preparar categoria em ${guild.id}: ${error.message}`);
      return {ok:false,configured:0,total:isInstagramGuild(guild.id)?1:Object.keys(CHANNELS).length,
        failed:[],reason:"Não foi possível preparar os canais. Verifique as permissões da Lumiya e tente novamente."};
    }).finally(() => pending.delete(guild.id));
    pending.set(guild.id, job);
    return job;
  }
  function ensureGuild(guild){
    if(!store.automatic(guild.id))return Promise.resolve({ok:false,skipped:true,reason:"opt-in"});
    return prepare(guild);
  }
  async function enableGuild(guild){
    const result=await prepare(guild);
    if(result.ok)store.setAutomatic(guild.id,true);
    return result;
  }
  client.once("clientReady", async () => {
    for (const guild of client.guilds.cache.values()) await ensureGuild(guild);
  });
  client.on("guildCreate", ensureGuild);
  return { ensureGuild,enableGuild,store,configure,kinds:CHANNELS,labels:LABELS,
    availableKinds:guildId=>isInstagramGuild(guildId)?{media:"logs-instagram"}:CHANNELS };
};

module.exports.CHANNELS = CHANNELS;
