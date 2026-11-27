const {
  ContainerBuilder, TextDisplayBuilder, ActionRowBuilder, ButtonBuilder,
  ButtonStyle, RoleSelectMenuBuilder, MessageFlags, PermissionFlagsBits: P
} = require("discord.js");
const { errorText } = require("../error-ui");
const painelEmojis = require("../lumiya-ui/emojis");

const DANGEROUS = [
  P.Administrator, P.ManageGuild, P.ManageRoles, P.ManageChannels,
  P.ManageWebhooks, P.BanMembers, P.KickMembers, P.ModerateMembers, P.ManageThreads,
  P.ManageMessages, P.ManageNicknames, P.MentionEveryone
];
const HOUR = 3600000;

module.exports = function installInitialRole({ client, registry, db, history, logger = console }) {
  db.exec(`CREATE TABLE IF NOT EXISTS initial_role_config(
    guildId TEXT PRIMARY KEY,roleId TEXT,enabled INTEGER NOT NULL DEFAULT 0,
    includeBots INTEGER NOT NULL DEFAULT 1,updatedAt INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS initial_role_events(
      id INTEGER PRIMARY KEY,guildId TEXT NOT NULL,userId TEXT NOT NULL,roleId TEXT,
      action TEXT NOT NULL,createdAt INTEGER NOT NULL);`);
  const pending = new Map(), recent = new Map();
  function settings(guildId) {
    const row = db.prepare("SELECT * FROM initial_role_config WHERE guildId=?").get(guildId);
    return row ? { ...row, enabled: Boolean(row.enabled), includeBots: Boolean(row.includeBots) }
      : { guildId, roleId: null, enabled: false, includeBots: true };
  }
  function save(c) {
    db.prepare(`INSERT INTO initial_role_config VALUES(?,?,?,?,?)
      ON CONFLICT(guildId) DO UPDATE SET roleId=excluded.roleId,enabled=excluded.enabled,
      includeBots=excluded.includeBots,updatedAt=excluded.updatedAt`)
      .run(c.guildId, c.roleId, c.enabled ? 1 : 0, c.includeBots ? 1 : 0, Date.now());
  }
  function record(guildId, userId, roleId, action) {
    db.prepare("INSERT INTO initial_role_events(guildId,userId,roleId,action,createdAt) VALUES(?,?,?,?,?)")
      .run(guildId, userId, roleId, action, Date.now());
  }
  async function validatedRole(guild, roleId, actor = null) {
    const role = roleId && await guild.roles.fetch(roleId, { force: true });
    if (!role || role.id === guild.id || role.guild?.id !== guild.id || role.managed) {
      throw new Error("Escolha um cargo comum deste servidor, diferente de @everyone.");
    }
    if (DANGEROUS.some(bit => role.permissions.has(bit))) {
      throw new Error("O cargo inicial não pode ter permissões administrativas ou de moderação.");
    }
    const me = await guild.members.fetchMe({ force: true });
    if (!me.permissions.has(P.ManageRoles) || role.comparePositionTo(me.roles.highest) >= 0) {
      throw new Error("O bot precisa de Gerenciar Cargos e de um cargo acima do cargo inicial.");
    }
    if (actor && actor.id !== guild.ownerId && role.comparePositionTo(actor.roles.highest) >= 0) {
      throw new Error("Escolha um cargo abaixo do seu cargo mais alto.");
    }
    return role;
  }
  const canConfigure = member => Boolean(member?.permissions?.has([P.ManageGuild, P.ManageRoles]));
  function panel(guildId) {
    const c = settings(guildId);
    return new ContainerBuilder().setAccentColor(0)
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(painelEmojis.panelText(
        `# Cargo inicial automático\n**Status:** ${c.enabled ? "Ativado" : "Desativado"}\n` +
        `**Cargo:** ${c.roleId ? `<@&${c.roleId}>` : "Não configurado"}\n` +
        `**Aplicar a bots:** ${c.includeBots ? "Sim" : "Não"}\n\n` +
        "Aplica somente a novas entradas, sem alterar os membros que já estão no servidor."
      )))
      .addActionRowComponents(new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder()
        .setCustomId("mds-initial-role:select").setPlaceholder("Escolher cargo inicial").setMinValues(1).setMaxValues(1)))
      .addActionRowComponents(new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("mds-initial-role:toggle").setLabel(c.enabled ? "Desativar" : "Ativar")
          .setEmoji(painelEmojis.toggleEmoji(c.enabled))
          .setStyle(c.enabled ? ButtonStyle.Danger : ButtonStyle.Success).setDisabled(!c.roleId),
        new ButtonBuilder().setCustomId("mds-initial-role:bots").setLabel(c.includeBots ? "Não aplicar a bots" : "Aplicar também a bots")
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("mds-initial-role:clear").setLabel("Remover configuração")
          .setStyle(ButtonStyle.Secondary).setDisabled(!c.roleId)
      ));
  }
  const payload = (component, ephemeral = false) => require("../lumiya-ui/canonical").canonical({
    components: [component], flags: MessageFlags.IsComponentsV2 | (ephemeral ? MessageFlags.Ephemeral : 0),
    allowedMentions: { parse: [] }
  });
  async function configure(i) {
    if (!i.customId?.startsWith("mds-initial-role:") || !i.guild) return;
    try {
      const actor = await i.guild.members.fetch({ user: i.user.id, force: true });
      if (!canConfigure(actor)) throw new Error("Você precisa de Gerenciar Servidor e Gerenciar Cargos.");
      const action = i.customId.split(":")[1];
      if (!["select", "toggle", "bots", "clear"].includes(action)) return;
      await i.deferUpdate();
      // Fetch current state after validation/defer, not stale panel contents.
      const c = settings(i.guild.id);
      if (action === "select") {
        const role = await validatedRole(i.guild, i.values?.[0], actor);
        // Changing the role requires explicit activation again.
        c.roleId = role.id;
        c.enabled = false;
      } else if (action === "toggle") {
        if (!c.enabled) await validatedRole(i.guild, c.roleId, actor);
        c.enabled = !c.enabled;
      } else if (action === "bots") c.includeBots = !c.includeBots;
      else { c.roleId = null; c.enabled = false; }
      save(c);
      record(i.guild.id, actor.id, c.roleId, `configured:${action}`);
      await i.editReply(payload(panel(i.guild.id)));
    } catch (error) {
      const p = payload(new ContainerBuilder().setAccentColor(0)
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(errorText(`# Não foi possível\n${error.message}`))), true);
      if (i.deferred || i.replied) await i.followUp(p).catch(() => {});
      else await i.reply(p).catch(() => {});
    }
  }
  async function assign(member) {
    const guild = member.guild, key = `${guild.id}:${member.id}`;
    const c = settings(guild.id);
    if (!c.enabled || !c.roleId || member.pending || member.user.bot && !c.includeBots) return;
    const signature = `${member.joinedTimestamp || ""}:${c.roleId}`;
    const last = recent.get(key);
    if (last?.signature === signature && Date.now() - last.at < HOUR) return;
    const role = await validatedRole(guild, c.roleId);
    const current = await guild.members.fetch({ user: member.id, force: true });
    const latest = settings(guild.id);
    if (!latest.enabled || latest.roleId !== role.id || current.pending || current.user.bot && !latest.includeBots ||
        current.joinedTimestamp !== member.joinedTimestamp) return;
    if (current.roles.cache.has(role.id)) return;
    async function add(reason) {
      const c = settings(guild.id);
      if (!c.enabled || c.roleId !== role.id || current.user.bot && !c.includeBots) {
        throw new Error("Configuração alterada antes da atribuição");
      }
      return current.roles.add(role, reason);
    }
    if (history) await history.alterarCargo({
      guild, alvo: current, cargo: role, action: "add", autor: client.user,
      source: "Cargo inicial automático", reason: "Nova entrada no servidor",
      executar: add
    });
    else await add("MDS: cargo inicial automático ao entrar no servidor");
    recent.set(key, { signature, at: Date.now() });
    if (recent.size > 10000) recent.delete(recent.keys().next().value);
    record(guild.id, member.id, role.id, "assigned");
  }
  function onJoin(member) {
    const key = `${member.guild.id}:${member.id}`;
    if (pending.has(key)) return pending.get(key);
    const job = assign(member).catch(() => {
      record(member.guild.id, member.id, settings(member.guild.id).roleId, "assignment_failed");
      logger.warn?.(`[Cargo inicial] Não foi possível adicionar o cargo em ${member.guild.id}; verifique permissões, hierarquia e configuração.`);
    }).finally(() => pending.delete(key));
    pending.set(key, job);
    return job;
  }
  client.on("guildMemberAdd", onJoin);
  client.on("guildMemberUpdate", (before, after) => {
    if (before.pending && after.pending === false) return onJoin(after);
  });
  client.on("guildMemberRemove", member => recent.delete(`${member.guild.id}:${member.id}`));
  client.on("interactionCreate", configure);
  registry.register({
    name: "cargoinicial", description: "Configura o cargo automático para novos membros.", category: "Administração",
    permissions: ["ManageGuild", "ManageRoles"], examples: ["!cargoinicial", "!autorole"],
    result: "Escolhe o cargo inicial, ativa/desativa e permite incluir ou ignorar bots.",
    prefix: { trigger: "!cargoinicial", aliases: ["!autorole"], exact: true, caseInsensitive: true,
      async execute(message) {
        if (!message.guild || message.author?.bot) return;
        const member = await message.guild.members.fetch({ user: message.author.id, force: true });
        if (!canConfigure(member)) return message.reply({
          content: errorText("Você precisa de Gerenciar Servidor e Gerenciar Cargos."), allowedMentions: { parse: [] }
        });
        return message.reply(payload(panel(message.guild.id)));
      }
    }
  });
  return { settings, onJoin, configure, panel };
};
