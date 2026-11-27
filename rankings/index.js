const {
  ContainerBuilder, TextDisplayBuilder, SeparatorBuilder, ActionRowBuilder,
  ButtonBuilder, ButtonStyle, MessageFlags, PermissionFlagsBits, SlashCommandBuilder
} = require("discord.js");
const { tituloPainel } = require("../brand");
const { errorText } = require("../error-ui");
const V2 = MessageFlags.IsComponentsV2;
const PRIVADO = V2 | MessageFlags.Ephemeral;
const ICON = { dot: "<:1569036184728895629:1570611954064695316>", full: "<:1569036173819645992:1570611052801040434>", empty: "<:1569036175128137839:1570610803554656296>" };
const duration = ms => { const s = Math.floor(ms / 1000); return `${Math.floor(s / 3600)}h ${Math.floor(s / 60) % 60}m ${s % 60}s`; };
const INTERVALO = Math.max(5000, Number(process.env.TOP_LIVE_INTERVAL_MS) || 15000);
const MAX_PAINEIS = 25;
const CLEANUPS = new Set();
let cleanupRegistrado = false;

module.exports = function installRankings({ client, registry, db }) {
  db.exec(`CREATE TABLE IF NOT EXISTS ranking_messages(guildId TEXT NOT NULL,userId TEXT NOT NULL,total INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(guildId,userId));
    CREATE TABLE IF NOT EXISTS ranking_message_seen(messageId TEXT PRIMARY KEY,createdAt INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS ranking_panels(guildId TEXT PRIMARY KEY,channelId TEXT NOT NULL,messageId TEXT NOT NULL,userId TEXT NOT NULL,paused INTEGER NOT NULL DEFAULT 0,updatedAt INTEGER NOT NULL);`);
  const savePanel = db.prepare(`INSERT INTO ranking_panels VALUES(?,?,?,?,?,?)
    ON CONFLICT(guildId) DO UPDATE SET channelId=excluded.channelId,messageId=excluded.messageId,userId=excluded.userId,paused=excluded.paused,updatedAt=excluded.updatedAt`);
  const removePanel = db.prepare("DELETE FROM ranking_panels WHERE guildId=? AND messageId=?");
  function countMessage(m) {
    if (!m.guildId || !m.id || m.author?.bot || !m.author?.id || m.webhookId) return;
    db.exec("BEGIN IMMEDIATE");
    try {
      const inserted = db.prepare("INSERT OR IGNORE INTO ranking_message_seen VALUES(?,?)").run(m.id, Date.now());
      if (inserted.changes) db.prepare("INSERT INTO ranking_messages VALUES(?,?,1) ON CONFLICT(guildId,userId) DO UPDATE SET total=total+1").run(m.guildId, m.author.id);
      db.prepare("DELETE FROM ranking_message_seen WHERE createdAt<?").run(Date.now() - 7 * 86400000);
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); console.warn("[Rankings] Falha ao contar mensagem:", error.message); }
  }
  client.on("messageCreate", countMessage);
  function calls(guildId, now = Date.now()) {
    return db.prepare(`SELECT userId,SUM(ms) AS total FROM (
      SELECT userId,callMs AS ms FROM totals WHERE guildId=?
      UNION ALL SELECT userId,MAX(0,?-lastAt) AS ms FROM active WHERE guildId=?
    ) GROUP BY userId ORDER BY total DESC,userId LIMIT 3`).all(guildId, now, guildId);
  }

  // O painel público nunca contém botões: o Discord não permite esconder
  // componentes por cargo. Os controles ficam em /topadmin, efêmero.
  async function panel(guild, { messageId = null, controles = false, privado = false, paused = false, parado = false, atualizadoEm = Date.now() } = {}) {
    const voice = calls(guild.id), messages = db.prepare("SELECT userId,total FROM ranking_messages WHERE guildId=? ORDER BY total DESC,userId LIMIT 3").all(guild.id);
    const c = new ContainerBuilder();
    const section = (title, lines, empty) => { if (c.components.length) c.addSeparatorComponents(new SeparatorBuilder().setDivider(true)); c.addTextDisplayComponents(new TextDisplayBuilder().setContent(`${title}\n${lines.join("\n") || empty}`)); };
    section(tituloPainel(guild, `<:1569036181121925131:1570610869442846770>${ICON.dot}**__TOP 3 CALLS:__**`, "# TOP 3 CALLS"), voice.map(r => `${ICON.full}⋆ <@${r.userId}> — **${duration(r.total)}**`), "_Nenhum tempo de call registrado._");
    section(tituloPainel(guild, `<:1569036179117179033:1570610837612265592>${ICON.dot}**__TOP 3 MENSAGENS:__**`, "# TOP 3 MENSAGENS"), messages.map(r => `${ICON.empty}⋆ <@${r.userId}> — **${Number(r.total).toLocaleString("pt-BR")} msgs**`), "_Nenhuma mensagem registrada._");
    if (messageId) {
      c.addSeparatorComponents(new SeparatorBuilder().setDivider(true));
      const status = parado ? "Atualização parada" : paused ? "Atualização pausada" : "Atualizando em tempo real";
      c.addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# ${status} · última atualização <t:${Math.floor(atualizadoEm / 1000)}:R>`));
    }
    if (controles && messageId) {
      const botao = (action, label, style) => new ButtonBuilder().setCustomId(`rank:${action}:${messageId}`).setLabel(label).setStyle(style);
      c.addActionRowComponents(new ActionRowBuilder().addComponents(
        botao("refresh", "Atualizar agora", ButtonStyle.Primary),
        botao("pause", paused ? "Retomar" : "Pausar", ButtonStyle.Secondary),
        botao("stop", "Parar", ButtonStyle.Danger)
      ));
    }
    const rendered=privado?c:require("../configuration/runtime").decorate(c,guild,"rankings");
    return require("../lumiya-ui/canonical").canonical({ components: [rendered],files:require("../configuration/runtime").filesFor([rendered]), flags: privado ? PRIVADO : V2, allowedMentions: { parse: [] } },{path:["Rankings"]});
  }

  const aoVivo = new Map();
  const publicos = new Map();
  const emEdicao = new Set();
  function track(message, guild, userId) {
    if (!message?.id || !message.channel?.id) return;
    aoVivo.set(message.id, { channelId: message.channel.id, guildId: guild.id, userId, paused: false, atualizadoEm: Date.now() });
    publicos.set(guild.id, { id: message.id, channelId: message.channel.id });
    savePanel.run(guild.id, message.channel.id, message.id, userId, 0, Date.now());
    while (aoVivo.size > MAX_PAINEIS) {
      const id = aoVivo.keys().next().value;
      aoVivo.delete(id);
      for (const [guildId, ref] of publicos) if (ref.id === id) publicos.delete(guildId);
    }
  }
  async function editar(id, entry, { parado = false } = {}) {
    if (!entry || emEdicao.has(id)) return;
    emEdicao.add(id);
    try {
      const channel = await client.channels?.fetch?.(entry.channelId);
      const mensagem = await channel?.messages?.fetch?.(id);
       if (!mensagem) { aoVivo.delete(id); removePanel.run(entry.guildId, id); return; }
      const guild = mensagem.guild || client.guilds?.cache?.get(entry.guildId);
      if (!guild) return;
      await mensagem.edit({...await panel(guild, { messageId: id, paused: entry.paused, parado, atualizadoEm: Date.now() }),attachments:[]});
      entry.atualizadoEm = Date.now();
    } catch (error) {
      if (error.code === 10008 || error.code === 10003) { aoVivo.delete(id); removePanel.run(entry.guildId, id); }
      else console.warn("[Rankings] Falha ao atualizar painel ao vivo:", error.message);
    } finally { emEdicao.delete(id); }
  }
  const timer = setInterval(() => {
    for (const [id, entry] of aoVivo) if (!entry.paused) void editar(id, entry);
  }, INTERVALO);
  timer.unref();

  async function restorePanels() {
    const saved=db.prepare("SELECT * FROM ranking_panels").all();
    if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='lumiya_publications'").get()){
      for(const row of db.prepare("SELECT * FROM lumiya_publications WHERE panelId='rankings' AND status='published'").all()){
        const state=JSON.parse(row.state||"{}");
        if(!state.stopped&&!saved.some(item=>item.messageId===row.messageId))saved.push({...row,userId:row.createdBy,paused:Number(Boolean(state.paused))});
      }
    }
    for (const row of saved) {
      const entry = { channelId: row.channelId, guildId: row.guildId, userId: row.userId, paused: Boolean(row.paused), atualizadoEm: row.updatedAt };
      aoVivo.set(row.messageId, entry);
      publicos.set(row.guildId, { id: row.messageId, channelId: row.channelId });
      await editar(row.messageId, entry).catch(() => {});
    }
  }
  let backfillEmAndamento = false;
  async function backfillRecentMessages() {
    if (backfillEmAndamento) return;
    backfillEmAndamento = true;
    const cutoff = Date.now() - 7 * 86400000;
    try {
      for (const guild of client.guilds?.cache?.values?.() || []) {
        for (const channel of guild.channels?.cache?.values?.() || []) {
          if (!channel.isTextBased?.() || !channel.messages?.fetch) continue;
          try {
            let before;
            while (true) {
              const batch = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
              if (!batch.size) break;
              for (const message of batch.values()) if (message.createdTimestamp >= cutoff) countMessage(message);
              const oldest = [...batch.values()].at(-1);
              if (!oldest || oldest.createdTimestamp < cutoff || batch.size < 100) break;
              before = oldest.id;
            }
          } catch (error) {
            if (error.code !== 50001 && error.code !== 50013) console.warn("[Rankings] Falha ao recuperar mensagens:", error.message);
          }
        }
      }
    } finally { backfillEmAndamento = false; }
  }
  client.once("clientReady", () => { void restorePanels(); void backfillRecentMessages(); });

  const admin = member => Boolean(member?.permissions?.has?.(PermissionFlagsBits.Administrator));
  async function comandoTopAdminSlash(i) {
    if (!admin(i.member)) return i.reply({ content: errorText("Somente administradores podem usar os controles do ranking."), flags: MessageFlags.Ephemeral });
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const guild = i.guild || client.guilds?.cache?.get(i.guildId);
      const ref = publicos.get(i.guildId);
      if (!guild || !ref) return i.editReply({ content: errorText("Execute `!top` no servidor para criar o painel antes de controlá-lo."), allowedMentions: { parse: [] } });
      const entry = aoVivo.get(ref.id);
      await i.editReply(await panel(guild, {
        messageId: ref.id, controles: Boolean(entry), privado: true,
        paused: entry?.paused || false, parado: !entry,
        atualizadoEm: entry?.atualizadoEm || Date.now()
      }));
    } catch (error) {
      console.warn("[Rankings] Falha ao abrir controles privados:", error.message);
      await i.editReply({ content: errorText("Não foi possível abrir os controles."), allowedMentions: { parse: [] } }).catch(() => {});
    }
  }

  async function onInteraction(i) {
    if (!i.isButton?.() || !i.customId?.startsWith("rank:")) return;
    const [, acao, id] = i.customId.split(":");
    const entry = aoVivo.get(id);
    if (!entry || entry.guildId !== i.guildId || !["refresh", "pause", "stop"].includes(acao)) return;
    if (!admin(i.member)) return i.reply({ content: errorText("Somente administradores podem controlar o ranking."), flags: MessageFlags.Ephemeral });
    await i.deferUpdate();
    if (acao === "refresh") await editar(id, entry);
    else if (acao === "pause") { entry.paused = !entry.paused; savePanel.run(entry.guildId, entry.channelId, id, entry.userId, Number(entry.paused), Date.now()); await editar(id, entry); }
    else { await editar(id, entry, { parado: true }); aoVivo.delete(id); removePanel.run(entry.guildId, id); }
    if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='lumiya_publications'").get())
      db.prepare("UPDATE lumiya_publications SET state=? WHERE guildId=? AND messageId=?").run(JSON.stringify({paused:entry.paused,stopped:acao==="stop"}),entry.guildId,id);
    const guild = i.guild || client.guilds?.cache?.get(entry.guildId);
    if (guild) await i.editReply(await panel(guild, {
      messageId: id, controles: aoVivo.has(id), privado: true,
      paused: entry.paused, parado: !aoVivo.has(id), atualizadoEm: entry.atualizadoEm
    }));
  }
  client.on("interactionCreate", onInteraction);

  registry.register({ name: "top", description: "Mostra o top 3 de tempo em call e mensagens.", category: "Rankings", result: "Exibe os rankings acumulados deste servidor, atualizando em tempo real.", prefix: { trigger: "!top", exact: true, execute: async message => {
    if (!message.guild || message.author.bot) return;
    const sent = await message.channel.send(await panel(message.guild));
    if (sent?.id) {
      registry.preserveMessage(sent);
      track(sent, message.guild, message.author.id);
      await sent.edit(await panel(message.guild, { messageId: sent.id, atualizadoEm: Date.now() })).catch(() => {});
    }
  } }});

  registry.register({
    name: "topadmin", description: "Abre os controles privados do ranking ao vivo.", category: "Rankings",
    result: "Abre, em uma resposta efêmera, os botões de atualizar/pausar/parar do último !top do servidor.",
    examples: ["/topadmin"], permissions: ["Administrator"],
    slash: { data: new SlashCommandBuilder().setName("topadmin").setDescription("Controles privados do ranking ao vivo")
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator), execute: comandoTopAdminSlash }
  });

  function close() { clearInterval(timer); aoVivo.clear(); CLEANUPS.delete(close); }
  CLEANUPS.add(close);
  if (!cleanupRegistrado) {
    cleanupRegistrado = true;
    for (const signal of ["SIGINT", "SIGTERM", "exit"]) {
      process.once(signal, () => { for (const callback of [...CLEANUPS]) callback(); });
    }
  }
  return { panel, calls, countMessage, aoVivo, publicos, close, track, refresh: id => editar(id, aoVivo.get(id)), INTERVALO };
};
