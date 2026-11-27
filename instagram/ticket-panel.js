const {
  ContainerBuilder, TextDisplayBuilder, SectionBuilder, ThumbnailBuilder, SeparatorBuilder, ActionRowBuilder,
  ButtonBuilder, ButtonStyle, ChannelType, MessageFlags, PermissionFlagsBits, MediaGalleryBuilder
} = require("discord.js");
const { VERIFICATION_BANNER, VERIFICATION_THUMBNAIL } = require("./art");
const {applyPanelAppearance}=require("../panel-art/appearance");

function ticketPanel(guild) {
  const container = new ContainerBuilder().setAccentColor(0xD95B96)
    .addSectionComponents(new SectionBuilder()
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(
        "## Verificação · Instagram\nUm passo antes de compartilhar seus momentos.\n\nAbra um ticket para iniciar sua verificação com a nossa equipe. O atendimento acontece em um espaço privado, com as orientações necessárias para você continuar."
      ))
      .setThumbnailAccessory(new ThumbnailBuilder().setURL(VERIFICATION_THUMBNAIL).setDescription("Instagram")))
    .addSeparatorComponents(new SeparatorBuilder().setDivider(true))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(
      "**Como funciona**\nClique no botão abaixo e aguarde o atendimento. Se sua verificação for aprovada, a equipe liberará seu acesso ao canal de envio de fotos.\n\n-# As fotos enviadas após a liberação também passam pela análise de mídia antes da publicação."
    ))
    .addMediaGalleryComponents(new MediaGalleryBuilder().addItems(item =>
      item.setURL(VERIFICATION_BANNER).setDescription("Instagram · verificação")
    ))
    .addActionRowComponents(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("ticket-instagram").setLabel("Iniciar verificação").setStyle(ButtonStyle.Primary)
    ))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(
      "-# Não envie senhas, códigos de acesso ou documentos pessoais."
    ));
  const rendered=applyPanelAppearance(container,guild,"instagram-ticket");
  return require("../lumiya-ui/canonical").canonical({ components: [rendered],files:require("../configuration/runtime").filesFor([rendered]), flags: MessageFlags.IsComponentsV2, allowedMentions: { parse: [] } });
}

module.exports = function installTicketPanel({ client, registry, db }) {
  db.exec(`CREATE TABLE IF NOT EXISTS instagram_ticket_panels(
    guildId TEXT NOT NULL,channelId TEXT PRIMARY KEY,messageId TEXT NOT NULL)`);

  registry.register({
    name: "instaticket", description: "Publica o painel para abrir tickets de verificação do Instagram.",
    category: "Instagram", permissions: ["ManageGuild"], examples: ["!instaticket"],
    prefix: { trigger: "!instaticket", exact: true, execute: async message => {
      if (!message.guild || !message.member?.permissions?.has(PermissionFlagsBits.ManageGuild)) return;
      if (message.channel.type !== ChannelType.GuildText) {
        return message.reply({ content: "Publique este painel em um canal de texto do servidor.", allowedMentions: { parse: [] } });
      }
      const previous = db.prepare("SELECT messageId FROM instagram_ticket_panels WHERE guildId=? AND channelId=?")
        .get(message.guildId, message.channel.id);
      let panel;
      if (previous) {
        try { panel = await message.channel.messages.fetch(previous.messageId); }
        catch (error) { if (Number(error.code) !== 10008) throw error; }
      }
      if (panel) await panel.edit({...ticketPanel(message.guild),attachments:[]});
      else panel = await message.channel.send(ticketPanel(message.guild));
      registry.preserveMessage(panel);
      db.prepare("INSERT OR REPLACE INTO instagram_ticket_panels VALUES(?,?,?)")
        .run(message.guildId, message.channel.id, panel.id);
    } }
  });

  client.once("clientReady", async () => {
    for (const saved of db.prepare("SELECT * FROM instagram_ticket_panels").all()) {
      try {
        const channel = await client.channels.fetch(saved.channelId);
        if (channel.guildId !== saved.guildId) continue;
        const panel = await channel.messages.fetch(saved.messageId);
        registry.preserveMessage(panel);
        await panel.edit({...ticketPanel(saved.guildId),attachments:[]});
      } catch (error) {
        if (Number(error.code) === 10008) {
          db.prepare("DELETE FROM instagram_ticket_panels WHERE channelId=? AND messageId=?").run(saved.channelId, saved.messageId);
        } else console.warn("[Instagram] Falha ao atualizar painel de tickets:", error.message);
      }
    }
  });
};
module.exports.ticketPanel = ticketPanel;
