const test=require("node:test"),assert=require("node:assert/strict");
const d=require("discord.js");
const theme=require("../lumiya-ui/theme");
const ctx={guild:{name:"mds",emojis:{cache:new d.Collection()}},bot:{username:"Lumiya",displayAvatarURL:()=>"https://cdn.discordapp.com/embed/avatars/0.png"},client:{emojis:{cache:new d.Collection()}}};

test("theme tokens and personality copy stay consistent",()=>{
  assert.equal(theme.TOKENS.accent,0xC4A7E7);
  assert.match(theme.feedback.saved(),/♡ Prontinho/);
  assert.match(theme.feedback.error("x"),/Ops!/);
  assert.match(theme.feedback.denied(),/pessoas autorizadas/);
  assert.match(theme.feedback.empty(),/Ainda não temos nada/);
  assert.match(theme.feedback.enabled(),/cuidando disso/);
  assert.match(theme.breadcrumb("Painel","Funções","Instagram").toJSON().content,/# Painel › Funções › Instagram/);
  assert.match(theme.stateLine("Sistema",true),/<:online:1575879824642277637> Sistema · ativo/);
  assert.match(theme.stateLine("Sistema",false),/<:noincomod:1575879858448506880> Sistema · desativado/);
});

test("institutional emojis are applied to state words once",()=>{
  const emojis=require("../lumiya-ui/emojis");
  const text="**Status:** Ativado · Desativado · Não configurado · Carregando";
  const marked=emojis.panelText(text);
  assert.match(marked,/<:online:1575879824642277637> Ativado/);
  assert.match(marked,/<:noincomod:1575879858448506880> Desativado/);
  assert.match(marked,/<:idle:1575879922767888404> Não configurado/);
  assert.match(marked,/<a:loadingBot:1575884281748783295> Carregando/);
  assert.equal(emojis.panelText(marked),marked);
  assert.equal(emojis.toggleEmoji(true).id,"1575879743436492890");
  assert.equal(emojis.toggleEmoji(false).id,"1575879783894622321");
  assert.match(theme.text("Sistema Ativado").toJSON().content,/<:online:1575879824642277637> Ativado/);
});

test("onboarding uses two independent containers without invitations",()=>{
  const payload=require("../configuration/ui").onboarding(ctx,[{id:"roles",label:"Cargos",description:"Gerencie cargos"}]);
  assert.equal(payload.components.length,2);
  assert.equal(payload.flags,d.MessageFlags.IsComponentsV2);
  const nodes=theme.flat(payload.components);
  assert.match(nodes.find(c=>c.type===10).content,/Oii, mds! Eu sou a Lumiya! ♡/);
  assert.ok(nodes.some(c=>c.type===11),"avatar da Lumiya é usado como thumbnail");
  assert.ok(nodes.some(c=>c.custom_id==="lc:quick"));
  assert.ok(nodes.some(c=>c.custom_id==="lc:open"));
  assert.doesNotMatch(JSON.stringify(payload),/discord\.gg|convite|oficial/i);
  theme.validatePayload(payload);
});

test("modal helper supports prefilled text and native selects with correct label bindings",()=>{
  const modal=theme.modal({id:"s",revision:3},"settings","Preferências da Lumiya",[
    {id:"title",label:"Título",value:"Central ♡",max:80},
    {id:"separator",label:"Separadores",type:"select",options:[{label:"Discretos",value:"small"}]}
  ]).toJSON();
  assert.equal(modal.custom_id,"lc:settings:s:3");
  assert.equal(modal.components.length,2);
  assert.equal(modal.components[0].component.value,"Central ♡");
  assert.equal(modal.components[1].component.type,3);
  assert.equal(modal.components[1].component.options[0].value,"small");
});

test("page keeps a natural title, thumbnail, body and navigation without breadcrumbs",()=>{
  const payload=theme.validatePayload(theme.page({
    path:["Funções","Comunidade","Instagram"],title:"Instagram ♡",subtitle:"Lumiya • mds",ctx,guild:ctx.guild,bot:ctx.bot,
    body:[theme.statusContainer([theme.stateLine("Feed",true),theme.valueLine("Canal","#geral")])],
    rows:[theme.row(theme.button("lc:home:s:0","Início"))]
  }));
  assert.equal(payload.components.length,3);
  assert.ok(theme.flat(payload.components).some(c=>c.type===10&&c.content==="### Instagram ♡"));
  assert.ok(!theme.flat(payload.components).some(c=>c.type===10&&c.content.includes("Painel ›")));
  assert.ok(theme.flat(payload.components).some(c=>c.type===11));
  assert.ok(theme.flat(payload.components).some(c=>c.custom_id==="lc:home:s:0"));
});
