// Identidade visual única para erros, recusas e estados enviados ao Discord.
const { panelText } = require("./lumiya-ui/emojis");
const DENIED_EMOJI = "<a:1175261181741641789:1569933923641983038>";

function errorText(value) {
  if (typeof value !== "string" || !value) return value;
  // Corrige inclusive a forma estática que não renderiza o emoji animado.
  const text = value.replace(/<a?:1175261181741641789:1569933923641983038>/g, DENIED_EMOJI);
  if (text.includes(DENIED_EMOJI)) return text;
  return text.replace(/^(\s*(?:#{1,3}\s+)?(?:\*\*)?)(?:[🚨❌⛔]+\s*(?:\|\s*)?)?/u,
    `$1${DENIED_EMOJI} `);
}

// Para renderizadores compartilhados entre sucesso e erro, examinar apenas o
// título. Não marcar painéis normais por haver uma instrução/erro no corpo.
function statusText(value) {
  if (typeof value !== "string") return value;
  const title = value.split("\n", 1)[0];
  const marked = /não foi possível|não consegui|não pode|não é permitido|não permitid|sem permiss|não possui (?:permiss|autoriza)|você precisa|somente .*(?:pode|podem)|negad[ao]|erro\b|falh[ao]|recusad|inválid|indisponível|expirad|não encontrad|não concluíd|permissão (?:ausente|insuficiente)|configuração incompleta|limite .*(?:atingido|excedido)|comentário vazio|promoção parcial|consulta temporariamente limitada|operação em andamento|\bbloquead[ao]|🚨|❌|⛔/iu.test(title)
    ? errorText(value) : value;
  return panelText(marked);
}

module.exports = { DENIED_EMOJI, errorText, statusText };
