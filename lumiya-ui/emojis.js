// Emojis institucionais usados em todos os painéis da Lumiya.
// Centralizar aqui evita ID duplicado e garante o mesmo visual em cada módulo.
const DEFINITIONS = Object.freeze({
  // Ação de ativar usa o ícone "off" e ação de desativar usa o "on1"
  // conforme preferência do usuário (pairs invertidos).
  ativar: { id: "1575879783894622321", name: "off" },
  desativar: { id: "1575879743436492890", name: "on1" },
  ativo: { id: "1575879824642277637", name: "online" },
  desativado: { id: "1575879858448506880", name: "noincomod" },
  naoConfigurado: { id: "1575879922767888404", name: "idle" },
  carregando: { id: "1575884281748783295", name: "loadingBot", animated: true }
});

const token = kind => {
  const item = DEFINITIONS[kind];
  if (!item) return "";
  return `<${item.animated ? "a" : ""}:${item.name}:${item.id}>`;
};
const object = kind => {
  const item = DEFINITIONS[kind];
  if (!item) return undefined;
  return { id: item.id, name: item.name, ...(item.animated ? { animated: true } : {}) };
};

const TOKENS = Object.freeze({
  ativar: token("ativar"),
  desativar: token("desativar"),
  ativo: token("ativo"),
  desativado: token("desativado"),
  naoConfigurado: token("naoConfigurado"),
  carregando: token("carregando")
});

const withEmoji = (kind, text = "") => `${TOKENS[kind]}${text ? ` ${text}` : ""}`;
const ativar = (text = "Ativar") => withEmoji("ativar", text);
const desativar = (text = "Desativar") => withEmoji("desativar", text);
const ativo = (text = "Ativo") => withEmoji("ativo", text);
const desativado = (text = "Desativado") => withEmoji("desativado", text);
const naoConfigurado = (text = "Não configurado") => withEmoji("naoConfigurado", text);
const carregando = (text = "carregando") => withEmoji("carregando", text);

// Estado exibido em texto: online para ligado, noincomod para desligado.
function status(active, feminine = false) {
  return active
    ? ativo(feminine ? "Ativada" : "Ativo")
    : desativado(feminine ? "Desativada" : "Desativado");
}
// Texto de configuração mantém a palavra "Ativado/Ativada" já usada nos painéis.
function enabled(active, feminine = false) {
  return active
    ? ativo(feminine ? "Ativada" : "Ativado")
    : desativado(feminine ? "Desativada" : "Desativado");
}
// Rótulo de botão de alternância: mostra a ação possível.
function toggle(active, suffix = "") {
  const target = `${suffix ? `${suffix} ` : ""}`;
  return active ? desativar(`Desativar ${target}`.trim()) : ativar(`Ativar ${target}`.trim());
}
// Emoji do botão de alternância: ação possível (desligar quando ligado).
function toggleEmoji(active) {
  return object(active ? "desativar" : "ativar");
}
function stateEmoji(active) {
  return object(active ? "ativo" : "desativado");
}
function unset(value, fallback = "Não configurado") {
  return value ? value : naoConfigurado(fallback);
}

// Aplica os emojis a textos de painel já existentes, preservando a palavra e a
// caixa original. É idempotente: não repete o emoji se ele já estiver presente.
const STATE_WORDS = [
  { kind: "ativo", pattern: /\b(?:Ativado|ativado|Ativada|ativada|Ativo|ativo)\b/g },
  { kind: "desativado", pattern: /\b(?:Desativado|desativado|Desativada|desativada|Desativado|desativado)\b/g },
  { kind: "naoConfigurado", pattern: /\b(?:Não configurado|não configurado|Não configurada|não configurada)\b/g },
  { kind: "carregando", pattern: /\b(?:Carregando|carregando)\b/g },
  { kind: "ativar", pattern: /\b(?:Ativar|ativar)\b/g },
  { kind: "desativar", pattern: /\b(?:Desativar|desativar)\b/g }
];
function panelText(value) {
  if (typeof value !== "string" || !value) return value;
  let result = value;
  for (const { kind, pattern } of STATE_WORDS) {
    const emoji = TOKENS[kind];
    if (!emoji || result.includes(emoji)) continue;
    result = result.replace(pattern, match => `${emoji} ${match}`);
  }
  return result;
}

module.exports = {
  DEFINITIONS, TOKENS, token, object, withEmoji, panelText,
  ativar, desativar, ativo, desativado, naoConfigurado, carregando,
  status, enabled, toggle, toggleEmoji, stateEmoji, unset
};
