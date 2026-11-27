const test = require("node:test");
const assert = require("node:assert/strict");
const { serverName, FALLBACK, titulo, tituloPainel, prefereTexto, TEXTO_SLA_ID } = require("../brand");

test("panel brand comes from the guild currently hosting the panel", () => {
  assert.equal(serverName({ name: "Clube dos Jogos" }), "Clube dos Jogos");
  assert.equal(serverName({ name: "Outro Servidor" }), "Outro Servidor");
  assert.notEqual(serverName({ name: "Outro Servidor" }), serverName({ name: "Clube dos Jogos" }));
});

test("missing guilds get a neutral label instead of a hardcoded bot brand", () => {
  assert.equal(serverName(undefined), FALLBACK);
  assert.equal(serverName({}), FALLBACK);
  assert.equal(serverName({ name: "   " }), FALLBACK);
});

test("guild names cannot inject markdown or oversized titles into components", () => {
  assert.equal(serverName({ name: "  A **B** | `C`  " }), "A B C");
  assert.equal(serverName({ name: "x".repeat(500) }).length, 80);
  assert.equal(serverName({ name: "linha\nquebrada" }), "linha quebrada");
});

test("server sla replaces decorative emoji headings with plain text", () => {
  const emoji = "<:emoji_14:1570072344255533137>";
  assert.equal(prefereTexto({ id: TEXTO_SLA_ID, name: "outro" }), true);
  assert.equal(prefereTexto({ id: "outro", name: "sla" }), true);
  assert.equal(prefereTexto({ id: "outro", name: "FEZES" }), false);
  assert.equal(titulo({ id: TEXTO_SLA_ID, name: "sla" }, emoji, "Suporte"), "# Suporte");
  assert.equal(titulo({ id: "outro", name: "FEZES" }, emoji, "Suporte"), `# ${emoji}`);
  assert.equal(tituloPainel({ id: "outro" }, emoji, "# TOP 3 CALLS"), emoji);
});
