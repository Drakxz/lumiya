// Selecionados após inspeção visual dos 49 emojis do FEZES (1569908467324420096).
const icons = {
  members: ["members", "1569924587293122630"],
  list: ["Icon_Clipboard_List", "1570628610132283433"],
  approve: ["Icon_Access_Approve", "1569949091880902747"],
  reject: ["Icon_Access_Reject", "1569949111166439507"],
  // X de negado usado pelo bot em recusas e falhas.
  warning: ["1175261181741641789", "1569933923641983038", true],
  options: ["Icon_Options", "1569951006547116082"]
};
module.exports = function emoji(guild, key) {
  const [name, id, animated = false] = icons[key];
  const cached = guild.emojis?.cache?.get(id);
  // Em outros servidores, não tentar usar um emoji externo indisponível.
  if (guild.id !== "1569908467324420096" && !cached) return null;
  if (cached?.available === false || cached?.roles?.cache?.size) return null;
  return { id, name: cached?.name || name, animated: cached?.animated ?? animated };
};
