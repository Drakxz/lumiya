// Calls dinâmicas: ao entrar na última call de uma categoria, uma nova call
// continua a numeração do nome (se houver). Canais gerados são apagados quando esvaziam.
const {
  ContainerBuilder, TextDisplayBuilder, SeparatorBuilder, ActionRowBuilder,
  ButtonBuilder, ButtonStyle, ChannelSelectMenuBuilder, ChannelType,
  MessageFlags, PermissionFlagsBits
} = require("discord.js");

const V2 = MessageFlags.IsComponentsV2;
const LIMPEZA_MS = 10_000;
const DEBOUNCE_MS = 3_000;
const MAX_CATEGORIA = 49;

module.exports = function installAutoCalls({ client, registry, db, logger = console }) {
  db.exec(`CREATE TABLE IF NOT EXISTS auto_calls_config(
    guildId TEXT PRIMARY KEY,categoryId TEXT,enabled INTEGER NOT NULL DEFAULT 0,updatedAt INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS auto_calls_generated(
    guildId TEXT NOT NULL,channelId TEXT NOT NULL,sourceId TEXT,createdAt INTEGER NOT NULL,
    PRIMARY KEY(guildId,channelId));`);

  const {errorText,statusText}=require("../error-ui");
  const painelEmojis=require("../lumiya-ui/emojis");
  const text = value => new TextDisplayBuilder().setContent(statusText(value));
  const sep = () => new SeparatorBuilder().setDivider(true);
  const payload = (container, ephemeral = false) => require("../lumiya-ui/canonical").canonical({
    components: [container], flags: V2 | (ephemeral ? MessageFlags.Ephemeral : 0), allowedMentions: { parse: [] }
  });
  const admin = member => Boolean(member?.permissions?.has?.([PermissionFlagsBits.ManageGuild, PermissionFlagsBits.ManageChannels]));

  function settings(guildId) {
    const row = db.prepare("SELECT * FROM auto_calls_config WHERE guildId=?").get(guildId);
    return row ? { ...row, enabled: Boolean(row.enabled) } : { guildId, categoryId: null, enabled: false };
  }
  function save(config) {
    db.prepare(`INSERT INTO auto_calls_config VALUES(?,?,?,?)
      ON CONFLICT(guildId) DO UPDATE SET categoryId=excluded.categoryId,enabled=excluded.enabled,updatedAt=excluded.updatedAt`)
      .run(config.guildId, config.categoryId, config.enabled ? 1 : 0, Date.now());
  }
  function generated(guildId) {
    return db.prepare("SELECT channelId FROM auto_calls_generated WHERE guildId=?").all(guildId).map(r => r.channelId);
  }

  function panel(guildId) {
    const c = settings(guildId);
    const total = generated(guildId).length;
    return new ContainerBuilder()
      .addTextDisplayComponents(text(
        `# Calls automáticas\n**Status:** ${c.enabled ? "Ativado" : "Desativado"}\n` +
        `**Categoria:** ${c.categoryId ? `<#${c.categoryId}>` : "Não configurada"}\n` +
        `**Canais gerados:** ${total}\n\n` +
        "Ao entrar na última call da categoria, uma nova call é criada, continuando a numeração do nome, se houver. " +
        "Canais gerados são apagados automaticamente quando ficam vazios."
      ))
      .addSeparatorComponents(sep())
      .addActionRowComponents(new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder()
        .setCustomId("mds-autocall:category").setPlaceholder("Escolher categoria").setMinValues(1).setMaxValues(1)
        .setChannelTypes(ChannelType.GuildCategory)))
      .addActionRowComponents(new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("mds-autocall:toggle").setLabel(c.enabled ? "Desativar" : "Ativar")
          .setEmoji(painelEmojis.toggleEmoji(c.enabled))
          .setStyle(c.enabled ? ButtonStyle.Danger : ButtonStyle.Success).setDisabled(!c.categoryId),
        new ButtonBuilder().setCustomId("mds-autocall:clear").setLabel("Remover configuração")
          .setStyle(ButtonStyle.Secondary).setDisabled(!c.categoryId)
      ));
  }

  async function configure(i) {
    if (!i.customId?.startsWith("mds-autocall:") || !i.guild) return;
    try {
      const actor = i.member || await i.guild.members.fetch({ user: i.user.id, force: true });
      if (!admin(actor)) throw new Error("Você precisa de Gerenciar Servidor e Gerenciar Canais.");
      const action = i.customId.split(":")[1];
      if (!["category", "toggle", "clear"].includes(action)) return;
      await i.deferUpdate();
      const c = settings(i.guild.id);
      if (action === "category") {
        const id = i.values?.[0];
        const category = id && await i.guild.channels.fetch(id);
        if (!category || category.type !== ChannelType.GuildCategory || category.guildId !== i.guild.id)
          throw new Error("Escolha uma categoria deste servidor.");
        c.categoryId = id;
        c.enabled = false;
      } else if (action === "toggle") c.enabled = !c.enabled;
      else { c.categoryId = null; c.enabled = false; }
      save(c);
      await i.editReply(payload(panel(i.guild.id), true));
    } catch (error) {
      const p = payload(new ContainerBuilder().addTextDisplayComponents(text(`# Não foi possível\n${error.message}`)), true);
      if (i.deferred || i.replied) await i.followUp(p).catch(() => {});
      else await i.reply(p).catch(() => {});
    }
  }

  function ultimaCall(guild, categoryId) {
    const voices = [...guild.channels.cache.values()].filter(ch =>
      ch.type === ChannelType.GuildVoice && ch.parentId === categoryId);
    voices.sort((a, b) => b.position - a.position);
    return voices[0] || null;
  }

  const criacoes = new Map();
  const limpezas = new Map();
  async function criar(guild, config, entrada) {
    const categoria = await guild.channels.fetch(config.categoryId).catch(() => null);
    if (!categoria || categoria.type !== ChannelType.GuildCategory) return;
    const ultima = ultimaCall(guild, config.categoryId);
    if (!ultima || ultima.id !== entrada.id) return;
    const total = [...guild.channels.cache.values()].filter(ch => ch.parentId === config.categoryId).length;
    if (total >= MAX_CATEGORIA) {
      logger.warn?.[`[Calls automáticas] Categoria ${config.categoryId} atingiu o limite de canais.`];
      return;
    }
    const me = guild.members?.me;
    if (me && !me.permissions?.has?.(PermissionFlagsBits.ManageChannels)) return;
    const nova = await guild.channels.create({
      name: ultima.name.replace(/\d+(?![\s\S]*\d)/, numero =>
        (BigInt(numero) + 1n).toString().padStart(numero.length, "0")),
      type: ChannelType.GuildVoice, parent: config.categoryId,
      userLimit: ultima.userLimit || 0,
      bitrate: ultima.bitrate,
      reason: "Calls automáticas: nova call ao entrar na última"
    });
    db.prepare("INSERT OR REPLACE INTO auto_calls_generated VALUES(?,?,?,?)")
      .run(guild.id, nova.id, ultima.id, Date.now());
  }

  function cancelarLimpeza(channelId) {
    const timer = limpezas.get(channelId);
    if (timer) clearTimeout(timer);
    limpezas.delete(channelId);
  }
  async function limparCanal(guildId, channelId) {
    try {
      const guild = await client.guilds.fetch(guildId);
      const canal = await guild.channels.fetch(channelId).catch(() => null);
      if (!canal) {
        db.prepare("DELETE FROM auto_calls_generated WHERE guildId=? AND channelId=?").run(guildId, channelId);
        return;
      }
      if (canal.members?.size === 0) {
        await canal.delete("Calls automáticas: canal vazio");
        db.prepare("DELETE FROM auto_calls_generated WHERE guildId=? AND channelId=?").run(guildId, channelId);
      }
    } catch (error) {
      logger.warn?.("[Calls automáticas] Falha ao limpar canal vazio:", error.message);
    }
  }
  function agendarLimpeza(guildId, channelId) {
    if (limpezas.has(channelId)) return;
    const timer = setTimeout(() => {
      limpezas.delete(channelId);
      void limparCanal(guildId, channelId);
    }, LIMPEZA_MS);
    timer.unref?.();
    limpezas.set(channelId, timer);
  }

  async function onVoiceState(oldState, newState) {
    try {
      const guild = newState.guild || oldState.guild;
      if (!guild) return;
      const saiu = oldState.channelId && oldState.channelId !== newState.channelId;
      const entrou = newState.channelId && newState.channelId !== oldState.channelId;
      const gerados = new Set(generated(guild.id));
      for (const id of [oldState.channelId, newState.channelId]) {
        if (!id || !gerados.has(id)) continue;
        const canal = guild.channels.cache.get(id);
        if (canal?.members?.size) cancelarLimpeza(id);
        else agendarLimpeza(guild.id, id);
      }
      if (!entrou) return;
      const config = settings(guild.id);
      if (!config.enabled || !config.categoryId) return;
      const chave = `${guild.id}:${newState.member?.id}:${newState.channelId}`;
      const agora = Date.now();
      if (agora - (criacoes.get(chave) || 0) < DEBOUNCE_MS) return;
      criacoes.set(chave, agora);
      if (criacoes.size > 1000) criacoes.clear();
      const canal = await guild.channels.fetch(newState.channelId).catch(() => null);
      if (!canal || canal.type !== ChannelType.GuildVoice) return;
      await criar(guild, config, canal);
    } catch (error) {
      logger.warn?.("[Calls automáticas] Falha no evento de voz:", error.message);
    }
  }
  client.on("voiceStateUpdate", onVoiceState);

  async function limparAoSIniciar() {
    for (const row of db.prepare("SELECT * FROM auto_calls_generated").all()) {
      try {
        const guild = await client.guilds.fetch(row.guildId);
        const canal = await guild.channels.fetch(row.channelId).catch(() => null);
        if (!canal || canal.members?.size === 0) {
          if (canal) await canal.delete("Calls automáticas: limpeza ao iniciar").catch(() => {});
          db.prepare("DELETE FROM auto_calls_generated WHERE guildId=? AND channelId=?").run(row.guildId, row.channelId);
        }
      } catch (error) {
        logger.warn?.("[Calls automáticas] Limpeza inicial ignorada:", error.message);
      }
    }
  }
  client.once("clientReady", () => { void limparAoSIniciar(); });

  async function handleInteraction(i) {
    if (i.isButton?.() && i.customId === "mds-autocall:open") {
      if (!i.guild) return;
      const actor = i.member || await i.guild.members.fetch({ user: i.user.id, force: true }).catch(() => null);
      if (!admin(actor)) return i.reply({ content: errorText("Você precisa de Gerenciar Servidor e Gerenciar Canais."), flags: MessageFlags.Ephemeral });
      return i.reply(payload(panel(i.guild.id), true));
    }
    return configure(i);
  }
  client.on("interactionCreate", handleInteraction);

  registry.register({
    name: "autocall", description: "Configura calls automáticas na última call de uma categoria.",
    category: "Administração", permissions: ["ManageGuild", "ManageChannels"],
    result: "Escolhe a categoria, ativa/desativa e limpa os canais gerados vazios.",
    examples: ["!autocall"],
    prefix: { trigger: "!autocall", exact: true, caseInsensitive: true, async execute(message) {
      if (!message.guild || message.author?.bot) return;
      const membro = message.member || await message.guild.members.fetch({ user: message.author.id, force: true }).catch(() => null);
        if (!admin(membro)) return message.reply({ content: errorText("Você precisa de Gerenciar Servidor e Gerenciar Canais."), allowedMentions: { parse: [] } });
      return message.reply(payload(panel(message.guild.id)));
    } }
  });

  function close() {
    for (const timer of limpezas.values()) clearTimeout(timer);
    limpezas.clear();criacoes.clear();
  }
  for (const signal of ["SIGINT", "SIGTERM", "exit"]) process.once(signal, close);
  return { settings, save, panel, configure, onVoiceState, ultimaCall, generated, limparCanal, close };
};
