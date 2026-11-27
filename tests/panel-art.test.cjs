const test = require("node:test");
const assert = require("node:assert/strict");
const sharp = require("sharp");
const { renderPanelArt, replaceBrand, BRAND } = require("../panel-art");

test("brand detection replaces only the mds token with the guild name", () => {
  assert.equal(replaceBrand("mds", { name: "SLA" }), "SLA");
  assert.equal(replaceBrand("MDS oficial", { name: "FEZES" }), "FEZES oficial");
  assert.equal(replaceBrand("suporte", { name: "SLA" }), "suporte");
  assert.equal(replaceBrand("mds", {}), "Servidor");
  assert.ok(BRAND.test("mds"));
  assert.ok(!BRAND.test("suporte"));
});

test("panel art is a real PNG, sized like the source and unique per server", async () => {
  const um = await renderPanelArt("support", { id: "um", name: "Servidor Um" });
  const dois = await renderPanelArt("support", { id: "dois", name: "Servidor Dois" });
  assert.equal(um.subarray(1, 4).toString(), "PNG");
  const meta = await sharp(um).metadata();
  assert.equal(meta.width, 1974);
  assert.equal(meta.height, 797);
  assert.notDeepEqual(um, dois);
  assert.equal(await renderPanelArt("support", { id: "um", name: "Servidor Um" }), um, "render is cached per guild");
});

test("both panel kinds render and unknown kinds are rejected", async () => {
  const migration = await renderPanelArt("migration", { id: "g", name: "Servidor Teste" });
  assert.equal((await sharp(migration).metadata()).height, 724);
  await assert.rejects(() => renderPanelArt("inexistente", { id: "g" }), /Arte desconhecida/);
});

