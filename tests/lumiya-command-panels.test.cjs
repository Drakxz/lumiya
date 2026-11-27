const test=require("node:test"),assert=require("node:assert/strict");
const {ContainerBuilder,TextDisplayBuilder,ActionRowBuilder,ButtonBuilder,ButtonStyle,MessageFlags}=require("discord.js");
const {canonical,normalizeText}=require("../lumiya-ui/canonical");
const {shell}=require("../lumiya-ui/shell");
const theme=require("../lumiya-ui/theme");

function fixture(accent){
  const c=new ContainerBuilder().addTextDisplayComponents(new TextDisplayBuilder().setContent("# Comandos\nComo usar com segurança."));
  if(accent!==undefined)c.setAccentColor(accent);
  c.addActionRowComponents(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("module:real:action").setLabel("Continuar").setStyle(ButtonStyle.Danger)));
  return {components:[c],flags:MessageFlags.IsComponentsV2|MessageFlags.Ephemeral,
    files:[{attachment:Buffer.from("example"),name:"example.txt"}],allowedMentions:{parse:[]}};
}

test("operational panels share compact headings and lilac without navigation clutter",()=>{
  const input=fixture(),before=input.components[0].toJSON(),output=canonical(input);
  const nodes=theme.flat(output.components);
  assert.equal(output.components[0].toJSON().accent_color,theme.TOKENS.accent);
  assert.match(nodes.find(n=>n.type===10).content,/^### 🌙 Comandos\nComo usar com segurança\.$/);
  assert.deepEqual(nodes.find(n=>n.type===2),theme.flat(input.components).find(n=>n.type===2));
  assert.deepEqual(input.components[0].toJSON(),before,"original builders remain untouched");
  assert.equal(output.flags,input.flags);
  assert.equal(output.files,input.files);
  assert.equal(canonical(output),output,"idempotent");
  theme.validatePayload(output);
});

test("semantic and customized accents including black are preserved",()=>{
  for(const accent of [0,0xFF0000,0x123456])
    assert.equal(canonical(fixture(accent)).components[0].toJSON().accent_color,accent);
});

test("Markdown examples stay verbatim and section headings use the config scale",()=>{
  assert.equal(normalizeText("# Ajuda\n## Uso\n```md\n# example\n## example\n```\n### Detalhes"),
    "### Ajuda\n### Uso\n```md\n# example\n## example\n```\n### Detalhes");
});

test("legacy breadcrumb lines are removed without changing branded titles",()=>{
  const input=fixture();
  input.components[0].components[0].setContent("-# Painel › Funções\n### 💜 Cargos");
  assert.equal(theme.flat(canonical(input).components).find(n=>n.type===10).content,"### 💜 Cargos");
});

test("decoration never consumes component slots or truncates operational text near the limit",()=>{
  const input=fixture(),content="# Ajuda\n"+"x".repeat(3987);
  input.components[0].components[0].setContent(content);
  const output=canonical(input),nodes=theme.flat(output.components);
  assert.equal(nodes.length,theme.flat(input.components).length);
  assert.ok(nodes.find(n=>n.type===10).content.endsWith("x".repeat(3987)));
  assert.doesNotMatch(nodes.find(n=>n.type===10).content,/Painel ›/);
  theme.validatePayload(output);
});

test("registered templates use the same compact headings without changing preview routing",()=>{
  const output=shell(fixture(),{label:"Comandos",path:["Painel","Comandos"],preview:true});
  const nodes=theme.flat(output.components);
  assert.equal(output.components.length,1,"no separate breadcrumb container");
  assert.doesNotMatch(JSON.stringify(output.components),/Painel ›/);
  assert.ok(nodes.some(n=>n.type===10&&n.content==="### Comandos\nComo usar com segurança."));
  assert.ok(nodes.some(n=>n.type===2&&n.disabled&&n.custom_id.startsWith("lc:preview:")));
  theme.validatePayload(output);
});

test("a full-length operational message is never pushed past Discord's text budget",()=>{
  const input=fixture(),content="# Ajuda\n"+"x".repeat(3992);
  input.components[0].components[0].setContent(content);
  const output=canonical(input);
  assert.equal(theme.flat(output.components).find(n=>n.type===10).content,content);
  theme.validatePayload(output);
});
