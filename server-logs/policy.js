const INSTAGRAM_GUILD_ID = "1573006949895635145";
const isInstagramGuild = guildId => guildId === INSTAGRAM_GUILD_ID;
const allowsLog = (guildId, kind) => !isInstagramGuild(guildId) || kind === "media";
module.exports = { INSTAGRAM_GUILD_ID, isInstagramGuild, allowsLog };
