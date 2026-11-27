const { PermissionFlagsBits } = require("discord.js");

// Roles named in the ticket panel, configured claim roles and the staff role
// all authorize claiming and closing. Getters avoid stale gateway caches.
function staffRoleIds({ data = {}, config = {}, guildId, system, staffRoleId, resolve = id => id }) {
  const stored = data.ticketClaimRoles?.[guildId];
  const claimRoles = Array.isArray(stored) ? stored : stored?.[system] || [];
  const mentioned = data.ticketRoles?.[guildId]?.[system] || [];
  const area = config[`${system}Team`] || [];
  return [...new Set([
    ...mentioned,
    ...claimRoles,
    ...area,
    config[`${system}Role`],
    config.adminRole,
    ...(staffRoleId ? [resolve(guildId, staffRoleId)] : [])
  ].filter(Boolean))];
}

function canManageTicket({ member, data, config, guildId, system, staffRoleId, resolve }) {
  if (!member) return false;
  if (member.permissions?.has?.(PermissionFlagsBits.ManageChannels)) return true;
  const roles = staffRoleIds({ data, config, guildId, system, staffRoleId, resolve });
  return roles.some(id => member.roles?.cache?.has?.(id));
}

module.exports = { staffRoleIds, canManageTicket };
