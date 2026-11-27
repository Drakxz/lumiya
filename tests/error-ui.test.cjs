const test = require("node:test");
const assert = require("node:assert/strict");
const { DENIED_EMOJI, errorText, statusText } = require("../error-ui");

test("all errors use the exact animated denial emoji and retain heading formatting", () => {
  for (const text of ["Erro", "# Erro", "### Ação negada", "**Sem permissão**", "# 🚨 | Acesso negado", "❌ Falha"]) {
    const formatted = errorText(text);
    assert.ok(formatted.includes(DENIED_EMOJI));
    assert.equal(formatted.split(DENIED_EMOJI).length, 2);
    assert.equal(errorText(formatted), formatted);
  }
  assert.equal(errorText("<:1175261181741641789:1569933923641983038> Negado"), `${DENIED_EMOJI} Negado`);
});

test("shared renderers mark failure and denial titles across systems", () => {
  for (const title of [
    "# Não foi possível", "# Ação negada", "# Acesso ao painel de cargos negado",
    "# Canal inválido", "# Seleção expirada", "# Permissão ausente",
    "# Configuração incompleta", "# Mídia bloqueada", "# Nuke não concluído",
    "# Promoção parcial", "Você precisa de Gerenciar Servidor.",
    "# 🚨 | Você não possui permissão para executar esse comando."
  ]) assert.ok(statusText(title).includes(DENIED_EMOJI), title);
});

test("success, cancellation, configuration and neutral review are not marked as failures", () => {
  for (const text of [
    "# Banimentos", "# Banimento concluído", "# Confirmar banimento",
    "# Cancelado", "# Configuração de tickets", "# Estado de voz atualizado",
    "# Backups Salvos", "# Mídia retida para revisão", "**Cargos desbloqueados:** 2/3",
    "# Painel\nNão foi possível é uma instrução no corpo, não um estado de erro.",
    "# Sucesso\nSomente administradores podem alterar a configuração."
  ]) assert.equal(statusText(text), text);
});
