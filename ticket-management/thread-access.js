const { PermissionFlagsBits, ChannelType } = require("discord.js");

const REQUIRED = [
  ["ViewChannel", PermissionFlagsBits.ViewChannel],
  ["ReadMessageHistory", PermissionFlagsBits.ReadMessageHistory],
  ["SendMessagesInThreads", PermissionFlagsBits.SendMessagesInThreads]
];

module.exports = function createThreadAccess({ client, data, save = () => {}, getStaffRoleIds = () => [], logger = console }) {
  async function grantStaffRoleAccess(parent, system) {
    if (!parent?.guild || !["support", "migration"].includes(system)) return;
    const guild = parent.guild;
    const ids = [...new Set(getStaffRoleIds(guild.id, system) || [])].filter(id => id && id !== guild.id);
    for (const id of ids) {
      const role = await guild.roles.fetch(id).catch(() => null);
      if (!role || role.guild?.id !== guild.id) continue;
      const permissions = parent.permissionsFor(role);
      if (!permissions) throw new Error("Não foi possível verificar as permissões do cargo de atendimento.");
      const missing = REQUIRED.filter(([, bit]) => !permissions.has(bit));
      if (!missing.length) continue;
      const me = await guild.members.fetchMe();
      if (!parent.permissionsFor(me)?.has(PermissionFlagsBits.ManageRoles)) {
        throw new Error("O bot precisa de Gerenciar Permissões no canal do painel para liberar a fala da equipe.");
      }
      await parent.permissionOverwrites.edit(role, Object.fromEntries(missing.map(([name]) => [name, true])), {
        reason: "MDS: permitir à equipe configurada conversar nos tickets privados a que tem acesso"
      });
    }
  }
  async function grantParentAccess(parent, userId) {
    if (!parent?.guild || ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(parent.type)) {
      throw new Error("Canal do painel de tickets indisponível.");
    }
    const guild = parent.guild;
    const member = await guild.members.fetch({ user: userId, force: true });
    if (!member || member.user?.bot) throw new Error("Autor do ticket indisponível.");
    if (member.communicationDisabledUntilTimestamp > Date.now()) {
      throw new Error("Você está de castigo no servidor e não pode falar em tickets até o castigo terminar.");
    }
    const permissions = parent.permissionsFor(member);
    if (!permissions) throw new Error("Não foi possível verificar as permissões do autor.");
    const missing = REQUIRED.filter(([, bit]) => !permissions.has(bit));
    if (!missing.length) return;
    const me = await guild.members.fetchMe();
    if (!parent.permissionsFor(me)?.has(PermissionFlagsBits.ManageRoles)) {
      throw new Error("O bot precisa de Gerenciar Permissões (Gerenciar Cargos) no canal do painel para liberar a conversa no ticket.");
    }
    // Private threads have no own overwrites. Grant only the missing permissions
    // to this member on the parent. Never allow SendMessages or change @everyone.
    await parent.permissionOverwrites.edit(
      userId,
      Object.fromEntries(missing.map(([name]) => [name, true])),
      { reason: "MDS: permitir ao autor conversar no próprio ticket privado" }
    );
  }

  async function repairOpenTickets() {
    let repaired = 0;
    for (const [id, ticket] of Object.entries(data.tickets || {})) {
      if (!["support", "migration"].includes(ticket?.sistema) || !ticket.guildId || !ticket.donoId) continue;
      try {
        const guild = await client.guilds.fetch(ticket.guildId);
        const thread = await guild.channels.fetch(id);
        if (!thread || thread.guildId !== guild.id || thread.type !== ChannelType.PrivateThread ||
            thread.archived || thread.locked) continue;
        const parent = thread.parent || await guild.channels.fetch(thread.parentId);
        await grantStaffRoleAccess(parent, ticket.sistema);
        await grantParentAccess(parent, ticket.donoId);
        await thread.members.add(ticket.donoId);
        repaired++;
      } catch (error) {
        const code = Number(error.code);
        // Não repetir no próximo startup a tentativa de reparar tickets órfãos.
        // Unknown Guild = bot removido do servidor; Unknown Member/Channel = recurso inexistente.
        if ([10003, 10004, 10007].includes(code)) {
          delete data.tickets[id];
          if (data.claims) delete data.claims[id];
          if (data.pendingCloses) delete data.pendingCloses[id];
          save();
          continue;
        }
        const known = {50001:"Bot sem acesso ao canal",50013:"Bot sem permissão para alterar acesso"};
        const reason = known[code] || (typeof error.message === "string"
          ? error.message.replace(/sk-[A-Za-z0-9_-]+|Bearer\s+\S+/gi,"[oculto]").replace(/\s+/g," ").slice(0,180)
          : "Falha ao verificar permissões");
        logger.warn?.(`[Tickets] Não foi possível corrigir acesso ao ticket ${id}: ${reason}${Number.isFinite(code)?` (código ${code})`:""}.`);
      }
    }
    return repaired;
  }

  client.once("clientReady", () => {
    repairOpenTickets().catch(() => logger.warn?.("[Tickets] Falha ao revisar acesso aos tickets abertos."));
  });
  return { grantParentAccess, grantStaffRoleAccess, repairOpenTickets };
};
