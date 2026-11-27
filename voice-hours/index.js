const path = require("node:path");
const { errorText } = require("../error-ui");
const {
  SlashCommandBuilder, AttachmentBuilder, EmbedBuilder, MessageFlags
} = require("discord.js");
const { VoiceHoursStore } = require("./store");
const { renderHoursCard } = require("./render");

module.exports = function instalarHoras({ client }) {
  const commands = require("../command-system/registry").getCommandRegistry(client);
  const store = new VoiceHoursStore(process.env.CALL_STATS_FILE || path.join(__dirname, "..", "database", "call-stats.sqlite"));
  const disponiveis = new Map();
  const gerando = new Set();
  let encerrado = false;
  const shutdownHooks = new Set();
  const erroPublico = mensagem => Object.assign(new Error(mensagem), { publico: true });

  function suspenderGuild(guild) {
    disponiveis.delete(guild.id);
    store.stopGuild(guild.id);
  }
  function reconciliar(guild) {
    if (!guild.available || encerrado) return;
    // Não reinicia sessões válidas em eventos duplicados de disponibilidade.
    if (disponiveis.has(guild.id)) return;
    store.reconcile(guild.id, guild.voiceStates.cache.values());
    disponiveis.set(guild.id, guild.shardId);
  }
  function seguro(fn) {
    try { if (!encerrado) fn(); }
    catch (error) { console.error("Erro no monitoramento de horas:", error); }
  }

  client.on("voiceStateUpdate", (_anterior, atual) => seguro(() => {
    if (!disponiveis.has(atual.guild.id)) return;
    store.update({ guildId: atual.guild.id, userId: atual.id, channelId: atual.channelId,
      muted: Boolean(atual.selfMute || atual.serverMute) });
  }));
  for (const event of ["guildCreate", "guildAvailable"]) {
    client.on(event, guild => seguro(() => { if (client.isReady()) reconciliar(guild); }));
  }
  for (const event of ["guildUnavailable", "guildDelete"]) client.on(event, guild => seguro(() => suspenderGuild(guild)));
  function suspenderShard(shardId) {
    for (const guild of client.guilds.cache.values()) {
      if (guild.shardId === shardId) suspenderGuild(guild);
    }
  }
  function reconciliarShard(shardId) {
    for (const guild of client.guilds.cache.values()) {
      if (guild.shardId === shardId) reconciliar(guild);
    }
  }
  client.on("shardDisconnect", (_event, id) => seguro(() => suspenderShard(id)));
  client.on("shardReconnecting", id => seguro(() => suspenderShard(id)));
  client.on("shardResume", id => seguro(() => reconciliarShard(id)));
  // shardReady é emitido antes de client.isReady() em uma identificação nova.
  // O cache desse shard já está completo nesse momento.
  client.on("shardReady", id => seguro(() => reconciliarShard(id)));
  client.on("invalidated", () => seguro(() => {
    for (const guild of client.guilds.cache.values()) suspenderGuild(guild);
  }));
  const checkpoint = setInterval(() => seguro(() => store.checkpoint()), 15_000);
  checkpoint.unref();

  const aviso = mensagem => ({
    embeds: [new EmbedBuilder().setColor(0).setTitle("Tempo em call").setDescription(errorText(mensagem))],
    allowedMentions: { parse: [] }
  });

  async function consultar(origem, userId) {
    if (!/^\d{17,20}$/.test(userId || "")) throw erroPublico("Informe um membro ou ID válido.");
    if (!disponiveis.has(origem.guild.id)) throw erroPublico("O monitoramento está reconectando. Tente novamente em instantes.");
    const key = `${origem.guild.id}:${(origem.user || origem.author).id}`;
    if (gerando.has(key)) throw erroPublico("Sua imagem anterior ainda está sendo gerada.");
    // Limite de concorrência evita consumo excessivo de memória por comandos simultâneos.
    if (gerando.size >= 4) throw erroPublico("Há muitas imagens em geração. Tente novamente em instantes.");
    gerando.add(key);
    try {
      const member = await origem.guild.members.fetch(userId).catch(() => null);
      const user = member?.user || await client.users.fetch(userId);
      const stats = store.stats(origem.guild.id, userId);
      const image = await renderHoursCard({
        name: member?.displayName || user.globalName || user.username,
        avatarURL: (member || user).displayAvatarURL({ extension: "png", size: 256 }), stats,
        maintenance: store.maintenanceForMember?.(member)||null
      });
      const filename = `tempo-${userId}.png`;
      const payload = {
        files: [new AttachmentBuilder(image, { name: filename })],
        embeds: [new EmbedBuilder().setColor(0).setImage(`attachment://${filename}`)],
        allowedMentions: { parse: [] }
      };
      return await (origem.author ? origem.channel.send(payload) : origem.editReply(payload));
    } finally { gerando.delete(key); }
  }

  async function comandoHorasPrefixo(message) {
    if (!message.guild || message.author.bot) return;
    const argumento = message.content.trim().split(/\s+/)[1];
    const id = message.mentions.users.first()?.id || (argumento ? argumento.replace(/[<@!>]/g, "") : message.author.id);
    try { await consultar(message, id); }
    catch (error) {
      console.warn("Não foi possível consultar horas:", error);
      await message.channel.send(aviso(error.publico ? error.message : "Não foi possível gerar a imagem. Verifique o usuário e tente novamente.")).catch(() => {});
    }
  }
  async function comandoHorasSlash(interaction) {
    try {
      await interaction.deferReply();
      await consultar(interaction, interaction.options.getUser("usuario")?.id || interaction.user.id);
    } catch (error) {
      console.warn("Não foi possível consultar horas:", error);
      const payload = aviso(error.publico ? error.message : "Não foi possível gerar a imagem. Verifique o usuário e tente novamente.");
      if (interaction.deferred) await interaction.editReply(payload).catch(() => {});
      else await interaction.reply({ ...payload, flags: payload.flags | MessageFlags.Ephemeral }).catch(() => {});
    }
  }
  commands.register({
    name: "tempo", description: "Consulta o tempo total e mutado em call, incluindo a sessão em andamento.", category: "Horas em Call",
    result: "Envia um embed com o cartão de tempo em call: avatar, total geral e períodos semanais. Sem alvo, consulta o próprio usuário.",
    examples: ["!tempo", "!tempo @usuário", "/tempo usuario:@usuário"],
    prefix: { trigger: "!tempo", trimLeading: false, usage: ["!tempo [@usuário ou ID]"], execute: comandoHorasPrefixo },
    slash: { data: new SlashCommandBuilder().setName("tempo").setDescription("Consultar tempo real em canais de voz")
      .addUserOption(option => option.setName("usuario").setDescription("Membro consultado (padrão: você)").setRequired(false)),
    usage: ["/tempo [usuario:@usuário]"], execute: comandoHorasSlash }
  });
  client.once("clientReady", async () => {
    seguro(() => { for (const guild of client.guilds.cache.values()) reconciliar(guild); });
  });

  function fechar() {
    if (encerrado) return;
    encerrado = true;
    clearInterval(checkpoint);
    store.close();
  }
  process.once("exit", () => { try { fechar(); } catch (error) { console.error("Erro ao salvar horas:", error); } });
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, async () => {
    try {
      await Promise.allSettled([...shutdownHooks].map(hook=>hook()));
      fechar(); client.destroy();
    } finally { process.exit(0); }
  });
  return { store, fechar, beforeShutdown: hook => shutdownHooks.add(hook) };
};
