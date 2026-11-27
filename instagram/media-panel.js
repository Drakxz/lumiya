const {
  ContainerBuilder, TextDisplayBuilder, SectionBuilder, ThumbnailBuilder,
  SeparatorBuilder, MessageFlags
} = require("discord.js");
const { VERIFICATION_THUMBNAIL } = require("./art");
const {applyPanelAppearance}=require("../panel-art/appearance");

function mediaPanel(guild) {
  const container = new ContainerBuilder().setAccentColor(0x000000)
    .addSectionComponents(new SectionBuilder()
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(
        "## Instagram · envie seu momento\nSua verificação foi aprovada? Este é o espaço para compartilhar sua foto ou vídeo com a comunidade."
      ))
      .setThumbnailAccessory(new ThumbnailBuilder().setURL(VERIFICATION_THUMBNAIL).setDescription("Instagram")))
    .addSeparatorComponents(new SeparatorBuilder().setDivider(true))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(
      "**Para publicar**\nEnvie sua foto ou vídeo como anexo neste canal. Se quiser, escreva uma legenda na mesma mensagem.\n\nO bot removerá o envio para análise. **Somente mídias aprovadas serão publicadas no Instagram do servidor principal.** Casos pendentes, bloqueados ou com falha não são publicados automaticamente."
    ))
    .addSeparatorComponents(new SeparatorBuilder().setDivider(true))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(
      "**Antes de enviar**\nRespeite as regras da comunidade e a privacidade de outras pessoas. Não compartilhe conteúdo íntimo, documentos, senhas ou dados pessoais sensíveis.\n\n-# As mídias e legendas são analisadas pela OpenAI. O envio pode ficar visível aqui brevemente antes da remoção. Em caso de dúvida, procure a equipe pelo ticket."
    ));
  const rendered=applyPanelAppearance(container,guild,"instagram-media");
  return require("../lumiya-ui/canonical").canonical({ components: [rendered],files:require("../configuration/runtime").filesFor([rendered]), flags: MessageFlags.IsComponentsV2, allowedMentions: { parse: [] } });
}

module.exports = function installMediaPanel({ client, registry, db }) {
  db.exec(`CREATE TABLE IF NOT EXISTS instagram_media_panels(
    guildId TEXT NOT NULL,channelId TEXT PRIMARY KEY,messageId TEXT NOT NULL)`);
  async function publish(channel) {
      const previous = db.prepare("SELECT messageId FROM instagram_media_panels WHERE guildId=? AND channelId=?")
        .get(channel.guildId, channel.id);
      let panel;
      if (previous) {
        try { panel = await channel.messages.fetch(previous.messageId); }
        catch (error) { if (Number(error.code) !== 10008) throw error; }
      }
      if (panel) await panel.edit({...mediaPanel(channel.guildId),attachments:[]});
      else panel = await channel.send(mediaPanel(channel.guildId));
      registry.preserveMessage(panel);
      db.prepare("INSERT OR REPLACE INTO instagram_media_panels VALUES(?,?,?)")
        .run(channel.guildId, channel.id, panel.id);
      return panel;
  }
  client.once("clientReady", async () => {
    const sources = db.prepare(`SELECT s.sourceGuildId,s.sourceChannelId FROM instagram_sources s
      JOIN instagram_settings d ON d.guildId=s.guildId`).all();
    for (const source of sources) {
      try {
        const channel = await client.channels.fetch(source.sourceChannelId);
        if (channel.guildId !== source.sourceGuildId) continue;
        await publish(channel);
      } catch (error) {
        console.warn("[Instagram] Falha ao publicar aviso de envios:", error.message);
      }
    }
  });
  return { publish };
};
module.exports.mediaPanel = mediaPanel;
