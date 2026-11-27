// Nome do servidor usado nos títulos dos painéis. Nunca usar a marca do bot
// como padrão silencioso: se o servidor não estiver disponível, usar um rótulo
// neutro em vez de atribuir uma identidade errada.
const FALLBACK = "Servidor";
// Servidor que prefere títulos em texto comum em vez de emojis decorativos.
const TEXTO_SLA_ID = "1571755216519438347";
const panelSettings = require("./panel-art/settings.json");

function serverName(guild) {
  const raw = typeof guild === "string" ? guild : guild?.name;
  const cleaned = String(raw ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/[*_`~|>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.slice(0, 80) || FALLBACK;
}

function prefereTexto(guild) {
  const id = typeof guild === "string" ? guild : guild?.id;
  return panelSettings[id]?.plainTitles === true ||
    id === TEXTO_SLA_ID || serverName(guild).toLocaleLowerCase("pt-BR") === "sla";
}

// Títulos de painéis: emoji no padrão, texto simples no servidor configurado.
function tituloPainel(guild, emoji, texto) {
  return prefereTexto(guild) ? texto : emoji;
}

function titulo(guild, emoji, texto) {
  return `# ${tituloPainel(guild, emoji, texto)}`;
}

module.exports = { serverName, FALLBACK, prefereTexto, tituloPainel, titulo, TEXTO_SLA_ID };
