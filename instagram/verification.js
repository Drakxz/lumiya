const { randomUUID } = require("node:crypto");
const {
  ContainerBuilder, TextDisplayBuilder, SectionBuilder, ThumbnailBuilder, SeparatorBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, RoleSelectMenuBuilder, MessageFlags, PermissionFlagsBits: P
} = require("discord.js");
const { VERIFICATION_THUMBNAIL } = require("./art");
const { errorText } = require("../error-ui");
const painelEmojis = require("../lumiya-ui/emojis");

const DANGEROUS = [
  P.Administrator, P.ManageGuild, P.ManageRoles, P.ManageChannels, P.ManageWebhooks,
  P.BanMembers, P.KickMembers, P.ModerateMembers, P.ManageThreads, P.ManageMessages,
  P.ManageNicknames, P.MentionEveryone
];
const text = value => new TextDisplayBuilder().setContent(painelEmojis.panelText(value));
const payload = (container, privateReply = false) => require("../lumiya-ui/canonical").canonical({
  components: [container], flags: MessageFlags.IsComponentsV2 | (privateReply ? MessageFlags.Ephemeral : 0),
  allowedMentions: { parse: [] }
});

module.exports = function installVerification({ client, registry, db, data, canReview, refreshTicket, history }) {
  db.exec(`CREATE TABLE IF NOT EXISTS instagram_verification_config(guildId TEXT PRIMARY KEY,roleId TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS instagram_verifications(
      ticketId TEXT PRIMARY KEY,guildId TEXT NOT NULL,userId TEXT NOT NULL,roleId TEXT NOT NULL,
      reviewerId TEXT NOT NULL,approvedAt INTEGER NOT NULL);`);
  const pending = new Map(), locks = new Set();
  const settings = gid => db.prepare("SELECT roleId FROM instagram_verification_config WHERE guildId=?").get(gid);
  const approved = id => db.prepare("SELECT * FROM instagram_verifications WHERE ticketId=?").get(id);
  const canConfigure = member => Boolean(member?.permissions?.has([P.ManageGuild, P.ManageRoles]));

  function configPanel(gid) {
    const roleId = settings(gid)?.roleId;
    const menu = new RoleSelectMenuBuilder().setCustomId("instaverify:role")
      .setPlaceholder("Cargo entregue após a verificação").setMinValues(0).setMaxValues(1);
    if (roleId) menu.setDefaultRoles(roleId);
    return new ContainerBuilder().setAccentColor(0)
      .addTextDisplayComponents(text(
        `## Verificação do Instagram\n**Cargo de aprovado:** ${roleId ? `<@&${roleId}>` : "Não configurado"}\n\n` +
        "A equipe de suporte autoriza a verificação dentro do ticket. Após a confirmação, o bot entrega este cargo ao autor.\n\n" +
        "Configure o canal de envio para permitir acesso a este cargo. O bot não altera permissões de canais.\n" +
        "-# Somente cargos sem permissões administrativas ou de moderação. Limpe a seleção para desativar."
      ))
      .addActionRowComponents(new ActionRowBuilder().addComponents(menu));
  }

  function render({ canalId, donoId, cargosMarcados = [], controls }) {
    const result = approved(canalId);
    const container = new ContainerBuilder().setAccentColor(0)
      .addSectionComponents(new SectionBuilder()
        .addTextDisplayComponents(text("## Verificação do Instagram\nAtendimento exclusivo para liberar seu acesso ao envio de mídias."))
        .setThumbnailAccessory(new ThumbnailBuilder().setURL(VERIFICATION_THUMBNAIL).setDescription("Instagram")))
      .addSeparatorComponents(new SeparatorBuilder().setDivider(true))
      .addTextDisplayComponents(text(
        `**Membro:** <@${donoId}>\n` +
        (cargosMarcados.length ? `**Equipe:** ${cargosMarcados.map(id => `<@&${id}>`).join(" ")}\n` : "") +
        (result
          ? `**Status:** Verificado\n**Aprovado por:** <@${result.reviewerId}>\n**Cargo concedido:** <@&${result.roleId}>\n-# <t:${Math.floor(result.approvedAt / 1000)}:f>`
          : "**Status:** Aguardando a equipe\n\nAguarde o atendimento e siga as orientações. Após a aprovação, o bot entregará o cargo de acesso configurado.")
      ))
      .addTextDisplayComponents(text("-# Não envie senhas, códigos de acesso ou documentos pessoais. A liberação não dispensa a análise das fotos antes da publicação."))
      .addActionRowComponents(new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`instaverify:open:${canalId}`)
          .setLabel(result ? "Membro verificado" : "Verificar membro").setStyle(ButtonStyle.Success).setDisabled(Boolean(result))
      ));
    if (controls) container.addActionRowComponents(controls);
    return container;
  }

  async function validRole(guild, id, actor = null) {
    const role = id && await guild.roles.fetch(id, { force: true });
    if (!role || role.id === guild.id || role.guild?.id !== guild.id || role.managed) {
      throw new Error("Selecione um cargo comum deste servidor, diferente de @everyone.");
    }
    if (DANGEROUS.some(bit => role.permissions.has(bit))) throw new Error("O cargo de verificado não pode ter permissões administrativas ou de moderação.");
    const me = await guild.members.fetchMe({ force: true });
    if (!me.permissions.has(P.ManageRoles) || role.comparePositionTo(me.roles.highest) >= 0) {
      throw new Error("O bot precisa de Gerenciar Cargos e de um cargo acima do cargo de verificado.");
    }
    if (actor && actor.id !== guild.ownerId && role.comparePositionTo(actor.roles.highest) >= 0) {
      throw new Error("Escolha um cargo abaixo do seu cargo mais alto.");
    }
    return role;
  }

  function ticket(i, id) {
    const meta = data.tickets?.[id];
    const row = db.prepare("SELECT status FROM ticket_management_cases WHERE id=? AND guildId=?").get(id, i.guildId);
    if (!meta || meta.guildId !== i.guildId || meta.sistema !== "support" || meta.tipo !== "insta" ||
        i.channelId !== id || i.channel?.archived || i.channel?.locked || row?.status !== "open" || data.pendingCloses?.[id]) {
      throw new Error("Este ticket de verificação está fechado ou indisponível.");
    }
    return meta;
  }
  async function reviewer(i, meta) {
    const member = await i.guild.members.fetch({ user: i.user.id, force: true });
    if (!member || member.user?.bot || member.id === meta.donoId || !canReview(i.guild, member)) {
      throw new Error("Somente a equipe autorizada pode verificar outro membro.");
    }
    return member;
  }

  async function handle(i) {
    if (!i.guild || !i.customId?.startsWith("instaverify:")) return;
    const [, action, id] = i.customId.split(":");
    if (action === "role") {
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      const actor = await i.guild.members.fetch({ user: i.user.id, force: true });
      if (!canConfigure(actor)) throw new Error("Você precisa de Gerenciar Servidor e Gerenciar Cargos.");
      if (i.values?.[0]) {
        const role = await validRole(i.guild, i.values[0], actor);
        db.prepare("INSERT OR REPLACE INTO instagram_verification_config VALUES(?,?)").run(i.guildId, role.id);
      } else db.prepare("DELETE FROM instagram_verification_config WHERE guildId=?").run(i.guildId);
      return i.editReply(payload(configPanel(i.guildId)));
    }
    if (action === "open") {
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      const meta = ticket(i, id);
      if (i.message?.id !== meta.messageId) throw new Error("Use o botão da mensagem original deste ticket.");
      await reviewer(i, meta);
      if (approved(id)) throw new Error("Este ticket já foi verificado.");
      const roleId = settings(i.guildId)?.roleId;
      if (!roleId) throw new Error("Configure o cargo de aprovado com !instaverificacao antes de verificar.");
      await validRole(i.guild, roleId);
      for (const [key, request] of pending) if (request.expires < Date.now()) pending.delete(key);
      const token = randomUUID();
      pending.set(token, { ticketId: id, guildId: i.guildId, actorId: i.user.id, ownerId: meta.donoId, roleId, expires: Date.now() + 300000 });
      return i.editReply(payload(new ContainerBuilder().setAccentColor(0)
        .addTextDisplayComponents(text(`## Confirmar verificação\n**Membro:** <@${meta.donoId}>\n**Cargo:** <@&${roleId}>\n\nConfirme apenas após concluir o atendimento. O cargo será atribuído automaticamente.`))
        .addActionRowComponents(new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`instaverify:confirm:${token}`).setLabel("Confirmar e entregar cargo").setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`instaverify:cancel:${token}`).setLabel("Cancelar").setStyle(ButtonStyle.Secondary)
        ))));
    }
    if (!["confirm", "cancel"].includes(action)) return;
    await i.deferUpdate();
    const request = pending.get(id);
    if (!request || request.guildId !== i.guildId || request.actorId !== i.user.id ||
        request.ticketId !== i.channelId || request.expires < Date.now()) throw new Error("Confirmação expirada ou indisponível para você.");
    if (action === "cancel") {
      pending.delete(id);
      return i.editReply(payload(new ContainerBuilder().setAccentColor(0).addTextDisplayComponents(text("Verificação cancelada. Nenhum cargo foi entregue."))));
    }
    const key = `${i.guildId}:${request.ownerId}`;
    if (locks.has(key)) throw new Error("A verificação deste membro já está em andamento.");
    locks.add(key);
    try {
      const meta = ticket(i, request.ticketId);
      await reviewer(i, meta);
      if (meta.donoId !== request.ownerId || approved(request.ticketId)) throw new Error("Este ticket já foi verificado ou foi alterado.");
      if (settings(i.guildId)?.roleId !== request.roleId) throw new Error("O cargo configurado mudou. Inicie uma nova verificação.");
      const role = await validRole(i.guild, request.roleId);
      const member = await i.guild.members.fetch({ user: request.ownerId, force: true });
      const me = await i.guild.members.fetchMe({ force: true });
      if (!member || member.user?.bot || member.pending || member.id === i.guild.ownerId ||
          member.roles.highest.comparePositionTo(me.roles.highest) >= 0) throw new Error("O membro não está elegível ou está acima do bot na hierarquia.");
      const current = ticket(i, request.ticketId);
      if (current.donoId !== request.ownerId || settings(i.guildId)?.roleId !== role.id) {
        throw new Error("O ticket ou o cargo configurado mudou. Inicie uma nova verificação.");
      }
      async function add(reason) {
        const latest = ticket(i, request.ticketId);
        if (latest.donoId !== request.ownerId) throw new Error("O autor do ticket mudou.");
        await reviewer(i, meta);
        await validRole(i.guild, role.id);
        if (settings(i.guildId)?.roleId !== role.id) throw new Error("Configuração alterada antes da atribuição.");
        return member.roles.add(role, reason);
      }
      if (!member.roles.cache.has(role.id)) {
        if (history) await history.alterarCargo({
          guild: i.guild, alvo: member, cargo: role, action: "add", autor: i.user,
          source: "Verificação do Instagram", reason: `Verificação aprovada por ${i.user.id}; ticket ${request.ticketId}`, executar: add
        });
        else await add(`Verificação do Instagram aprovada por ${i.user.id}; ticket ${request.ticketId}`);
      }
      db.prepare("INSERT INTO instagram_verifications VALUES(?,?,?,?,?,?)")
        .run(request.ticketId, i.guildId, request.ownerId, role.id, i.user.id, Date.now());
      pending.delete(id);
      let updated = true;
      try { await refreshTicket(request.ticketId); } catch { updated = false; }
      return i.editReply(payload(new ContainerBuilder().setAccentColor(0).addTextDisplayComponents(text(
        `## Membro verificado\n<@${request.ownerId}> recebeu o cargo <@&${role.id}>.` +
        (updated ? "" : "\nO cargo foi entregue, mas não foi possível atualizar o painel do ticket.")
      ))));
    } finally { locks.delete(key); }
  }
  registry.register({
    name: "instaverificacao", description: "Escolhe o cargo entregue após a aprovação no ticket do Instagram.",
    category: "Instagram", permissions: ["ManageGuild", "ManageRoles"], examples: ["!instaverificacao"],
    prefix: { trigger: "!instaverificacao", exact: true, execute: async message => {
      if (!message.guild || !canConfigure(message.member)) return;
      const sent = await message.channel.send(payload(configPanel(message.guildId)));
      registry.preserveMessage(sent);
    } }
  });
  client.on("interactionCreate", i => {
    void handle(i).catch(async error => {
      const response = { content: errorText(error.message), allowedMentions: { parse: [] } };
      if (i.deferred || i.replied) {
        await i.editReply(payload(new ContainerBuilder().setAccentColor(0).addTextDisplayComponents(text(response.content)))).catch(() => {});
      } else await i.reply({ ...response, flags: MessageFlags.Ephemeral }).catch(() => {});
    });
  });
  client.once("clientReady", async () => {
    for (const [id, meta] of Object.entries(data.tickets || {})) {
      if (meta.tipo !== "insta" || meta.sistema !== "support") continue;
      const row = db.prepare("SELECT status FROM ticket_management_cases WHERE id=?").get(id);
      if (row?.status !== "open") continue;
      try { await refreshTicket(id); }
      catch (error) { console.warn("[Instagram] Não foi possível atualizar o ticket de verificação:", error.message); }
    }
  });
  return { render, handle, settings, approved, configPanel };
};
