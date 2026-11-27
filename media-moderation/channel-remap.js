// Reassocia somente configurações, nunca casos antigos nem seus anexos.
module.exports = function channelRemapper({ store, isMonitored, isSuperficial, instagram, announce }) {
  function captureChannel(channel) {
    const guildId = channel.guildId || channel.guild?.id;
    const message = { guildId, channelId: channel.id, channel };
    return {
      guildId, channelId: channel.id,
      monitored: isMonitored(message),
      superficial: isSuperficial(message),
      instagram: Boolean(instagram?.isChannel(guildId, channel.id)),
      instagramIntake: Boolean(instagram?.isIntake(guildId, channel.id)),
      links: store.channels(guildId).filter(row => row.channelId === channel.id)
    };
  }

  async function rebindChannel(snapshot, channel) {
    const guildId = channel.guildId || channel.guild?.id;
    if (snapshot.guildId !== guildId || !channel.id || snapshot.channelId === channel.id)
      throw new Error("Remapeamento de mídia inválido para este servidor.");
    const oldId = snapshot.channelId, newId = channel.id;
    const replace = id => id === oldId ? newId : id;
    const db = store.db;
    db.exec("SAVEPOINT media_channel_rebind");
    try {
      const links = [...snapshot.links, ...store.channels(guildId).filter(row => row.channelId === oldId)];
      for (const { kind } of links) {
        store.setChannel(guildId, newId, kind, true);
        store.setChannel(guildId, oldId, kind, false);
      }
      const excluded = links.some(row => row.kind === "exclude");
      // Se a proteção era herdada da categoria, registra também o novo ID.
      // Canais superficiais continuam superficiais; não viram análise completa.
      if (snapshot.monitored && !snapshot.superficial && !snapshot.instagram && !snapshot.instagramIntake && !excluded)
        store.setChannel(guildId, newId, "channel", true);
      const settings = store.settings(guildId);
      const previousSettings = JSON.stringify(settings);
      if (settings.logChannelId === oldId) settings.logChannelId = newId;
      settings.superficialChannelIds = [...new Set(settings.superficialChannelIds.map(replace))];
      if (snapshot.superficial && !settings.superficialChannelIds.includes(newId))
        settings.superficialChannelIds.push(newId);
      for (const key of ["channels", "excluded"]) {
        if (Array.isArray(settings[key])) settings[key] = settings[key].map(replace);
      }
      if (settings.externalReview?.guildId === guildId && settings.externalReview.channelId === oldId)
        settings.externalReview = { ...settings.externalReview, channelId: newId };
      if (JSON.stringify(settings) !== previousSettings) store.saveSettings(guildId, settings);
      if (snapshot.instagram) db.prepare(
        "UPDATE instagram_settings SET channelId=? WHERE guildId=? AND channelId=?").run(newId, guildId, oldId);
      db.prepare("UPDATE instagram_sources SET sourceChannelId=? WHERE sourceGuildId=? AND sourceChannelId=?").run(newId, guildId, oldId);
      db.prepare("DELETE FROM media_moderation_notices WHERE channelId=?").run(oldId);
      db.exec("RELEASE media_channel_rebind");
    } catch (error) {
      db.exec("ROLLBACK TO media_channel_rebind");
      db.exec("RELEASE media_channel_rebind");
      throw error;
    }
    const monitored = isMonitored({ guildId, channelId: newId, channel });
    const enabled = store.settings(guildId).enabled || Boolean(instagram?.isIntake(guildId, newId));
    // A publicação do aviso não pode desfazer a configuração já persistida.
    if (monitored && enabled) await announce(channel).catch(() => {});
    return { monitored, active: monitored && enabled };
  }
  return { captureChannel, rebindChannel };
};
