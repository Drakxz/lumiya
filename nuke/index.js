// Nuke de canal: apaga e recria um canal de texto com as mesmas configurações.
// Execução imediata, restrita a administradores.
const {
  ContainerBuilder, TextDisplayBuilder, SeparatorBuilder, MessageFlags,
  PermissionFlagsBits, SlashCommandBuilder, ChannelType
} = require("discord.js");
const { errorText, statusText } = require("../error-ui");

const V2 = MessageFlags.IsComponentsV2;
const EFEMERO = V2 | MessageFlags.Ephemeral;
const TIPOS = [ChannelType.GuildText, ChannelType.GuildAnnouncement];

module.exports = function installNuke({ client, registry, botConfig, mediaModeration, logger = console }) {
  const text = value => new TextDisplayBuilder().setContent(statusText(value));
  const sep = () => new SeparatorBuilder().setDivider(true);

  function card(titulo, corpo) {
    return require("../lumiya-ui/canonical").canonical({
      components: [new ContainerBuilder().addTextDisplayComponents(text(`# ${titulo}\n${corpo}`)).addSeparatorComponents(sep())],
      flags: EFEMERO, allowedMentions: { parse: [] }
    },{path:["Moderação","Nuke"]});
  }

  function validar(guild, membro, canal) {
    if (!membro?.permissions?.has?.(PermissionFlagsBits.Administrator)) return "Somente administradores podem usar o nuke.";
    if (!canal || canal.guildId !== guild.id) return "Canal inválido neste servidor.";
    if (!TIPOS.includes(canal.type)) return "Somente canais de texto e anúncios podem ser recriados.";
    const bot = guild.members?.me;
    if (bot && !bot.permissions?.has?.(PermissionFlagsBits.ManageChannels)) return "A MDS precisa de Gerenciar Canais.";
    return null;
  }

  async function executar(guild, canal, autorId) {
    const antigo = await guild.channels.fetch(canal.id);
    if (!antigo || antigo.guildId !== guild.id) throw new Error("O canal não existe mais.");
    const estado = {
      name: antigo.name, type: antigo.type, topic: antigo.topic ?? null,
      parent: antigo.parentId ?? null, nsfw: Boolean(antigo.nsfw),
      rateLimitPerUser: antigo.rateLimitPerUser ?? 0,
      position: antigo.position ?? 0,
      permissionOverwrites: antigo.permissionOverwrites?.cache?.map(o => ({
        id: o.id, type: o.type, allow: o.allow, deny: o.deny
      })) || []
    };
    const snapshot = botConfig?.capture ? botConfig.capture(guild.id) : null;
    const mediaSnapshot = mediaModeration?.captureChannel(antigo);
    await antigo.delete(`Nuke solicitado por ${autorId}`);
    let novo;
    try {
      novo = await guild.channels.create({
        ...estado,
        permissionOverwrites: estado.permissionOverwrites,
        reason: `Nuke: recriação de ${estado.name}`
      });
    } catch (error) {
      logger.warn?.("[Nuke] Recriação completa falhou, tentando o mínimo:", error.message);
      novo = await guild.channels.create({ name: estado.name, type: estado.type, parent: estado.parent,
        permissionOverwrites: estado.permissionOverwrites, nsfw: estado.nsfw,
        reason: `Nuke: recriação mínima de ${estado.name}` });
    }
    if (novo.position !== estado.position) await novo.setPosition?.(estado.position).catch(() => {});
    await guild.channels.fetch(novo.id).catch(() => {});
    const configurationErrors = [];
    let mediaResult, mediaError;
    async function restoreMedia() {
      if (!mediaSnapshot) return;
      try {
        mediaResult = await mediaModeration.rebindChannel(mediaSnapshot, novo);
        mediaError = null;
      } catch (error) { mediaError = error; }
    }
    // Reativa a proteção assim que o canal existe, sem depender do backup geral.
    await restoreMedia();
    if (snapshot && botConfig?.apply) {
      try {
        const result = await botConfig.apply(guild, {
          originGuildId: guild.id, botConfiguration: snapshot, channels: [{ id: antigo.id }], roles: []
        }, { channelMap: { [antigo.id]: novo.id } });
        configurationErrors.push(...(result?.errors || []));
      } catch (error) {
        configurationErrors.push(error.message);
      }
    }
    // Garante o vínculo mesmo se outra seção do backup falhar ou for parcial.
    await restoreMedia();
    if (mediaError) configurationErrors.push(`Proteção de imagens: ${mediaError.message}`);
    return { antigo, novo, mediaResult, mediaSnapshot, configurationErrors };
  }

  function restorationSummary(result) {
    const media = result.mediaSnapshot?.monitored
      ? result.mediaResult?.active
        ? "Proteção de imagens ativa no novo canal."
        : result.mediaResult?.monitored
          ? "Novo ID registrado na proteção de imagens; o sistema está desativado nas configurações."
          : "Não foi possível confirmar a proteção de imagens no novo canal."
      : "";
    const warnings = result.configurationErrors.length
      ? errorText(`Algumas configurações precisam de revisão: ${[...new Set(result.configurationErrors)].join("; ").slice(0, 700)}`)
      : "Configurações do bot remapeadas automaticamente.";
    return [media, warnings].filter(Boolean).join("\n");
  }

  function recreationNotice(result, autorId) {
    const timestamp = Math.floor(Date.now() / 1000);
    const container = new ContainerBuilder()
      .setAccentColor(result.configurationErrors.length ? 0xF0B232 : 0x3BA55C)
      .addTextDisplayComponents(text("## Canal recriado"))
      .addTextDisplayComponents(text(
        `**Canal:** ${result.novo}\n**Responsável:** <@${autorId}>`
      ))
      .addSeparatorComponents(sep())
      .addTextDisplayComponents(text(
        "As mensagens anteriores foram apagadas e não podem ser recuperadas."
      ))
      .addTextDisplayComponents(text(`-# <t:${timestamp}:f>`));
    if (result.configurationErrors.length) {
      container.addTextDisplayComponents(text(restorationSummary(result)));
    }
    return require("../lumiya-ui/canonical").canonical({ components: [container], flags: V2, allowedMentions: { parse: [] } },{path:["Moderação","Nuke"]});
  }

  async function publishNotice(result, autorId) {
    try {
      await result.novo.send(recreationNotice(result, autorId));
      return true;
    } catch (error) {
      logger.warn?.("[Nuke] Canal recriado, mas não foi possível publicar o aviso:", error.message);
      return false;
    }
  }

  async function onPrefix(message) {
    if (!message.guild || message.author?.bot) return;
    const mencao = String(message.content || "").trim().split(/\s+/)[1]?.match(/^<#(\d{17,20})>$/);
    const canal = mencao ? await message.guild.channels.fetch(mencao[1]).catch(() => null) : message.channel;
    const erro = validar(message.guild, message.member, canal);
    if (erro) return message.reply({ content: errorText(erro), allowedMentions: { parse: [] } }).catch(() => {});
    try {
      const result = await executar(message.guild, canal, message.author.id);
      const { antigo, novo } = result;
      const published = await publishNotice(result, message.author.id);
      // A mensagem do comando foi apagada junto com o canal. Não responder nela.
      if ((message.channelId || message.channel?.id) === antigo.id) return;
      const payload = {
        content: `Canal recriado: ${novo}.` +
          (published ? " Os detalhes estão no novo canal." : " Não foi possível publicar o aviso no novo canal."),
        allowedMentions: { parse: [] }
      };
      return await message.reply(payload);
    } catch (error) {
      logger.warn?.("[Nuke] Falha ao executar:", error.message);
      return message.reply({ content: errorText(`Nuke não concluído: ${String(error.message).slice(0, 400)}`), allowedMentions: { parse: [] } }).catch(() => {});
    }
  }

  async function onSlash(i) {
    if (!i.inGuild?.()) return i.reply({ content: errorText("Use este comando dentro de um servidor."), flags: MessageFlags.Ephemeral });
    const escolhido = i.options?.getChannel?.("canal");
    const canal = escolhido || i.channel;
    const erro = validar(i.guild, i.member, canal);
    if (erro) return i.reply({ content: errorText(erro), flags: MessageFlags.Ephemeral });
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const result = await executar(i.guild, canal, i.user.id);
      const { antigo, novo } = result;
      const published = await publishNotice(result, i.user.id);
      await i.editReply(card("Canal recriado",
        `**Antigo:** \`${antigo.id}\`\n**Novo:** ${novo}\nMensagens antigas não podem ser recuperadas. ` +
        restorationSummary(result) +
        (published ? "" : "\nNão foi possível publicar o aviso no novo canal.")));
    } catch (error) {
      logger.warn?.("[Nuke] Falha ao executar:", error.message);
      await i.editReply(card("Nuke não concluído", `-# ${String(error.message).slice(0, 400)}`)).catch(() => {});
    }
  }

  registry.register({
    name: "nuke", description: "Apaga e recria um canal de texto imediatamente.",
    category: "Administração", permissions: ["Administrator"],
    result: "Recria o canal com o mesmo nome e permissões, remapeando as configurações do bot.",
    examples: ["!nuke", "!nuke #canal", "/nuke"],
    prefix: { trigger: "!nuke", usage: ["!nuke [#canal]"], execute: onPrefix },
    slash: {
      data: new SlashCommandBuilder().setName("nuke").setDescription("Apagar e recriar um canal de texto")
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addChannelOption(op => op.setName("canal").setDescription("Canal a recriar (padrão: o atual)")
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(false)),
      execute: onSlash
    }
  });

  function close() {}
  return { onSlash, onPrefix, close, executar };
};
