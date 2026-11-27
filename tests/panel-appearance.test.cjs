const test=require("node:test"),assert=require("node:assert/strict");
const {ContainerBuilder,MediaGalleryBuilder,SeparatorBuilder,TextDisplayBuilder,ActionRowBuilder,ButtonBuilder,ButtonStyle}=require("discord.js");
const {panelImagesEnabled,removePanelImages,applyPanelAppearance}=require("../panel-art/appearance");
const target="1331871489368260619";
test("image preference affects only the configured guild",()=>{
  assert.equal(panelImagesEnabled(target),false);
  assert.equal(panelImagesEnabled({id:target}),false);
  for(const guild of [undefined,{},target+"1","1571755216519438347"])assert.equal(panelImagesEnabled(guild),true);
});
test("general panel drops artwork without changing text or controls or mutating the original",()=>{
  const original=new ContainerBuilder()
    .addTextDisplayComponents(new TextDisplayBuilder().setContent("## Suporte"))
    .addSeparatorComponents(new SeparatorBuilder())
    .addMediaGalleryComponents(new MediaGalleryBuilder().addItems(i=>i.setURL("https://example.com/art.png")))
    .addSeparatorComponents(new SeparatorBuilder())
    .addActionRowComponents(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("ticket-support").setLabel("Entrar").setStyle(ButtonStyle.Secondary)));
  const before=original.toJSON(),after=applyPanelAppearance(original,target).toJSON();
  assert.deepEqual(after.components.map(c=>c.type),[10,14,1]);
  assert.deepEqual(after.components.at(-1),before.components.at(-1));
  assert.deepEqual(original.toJSON(),before);
   assert.equal(applyPanelAppearance(original,"other").toJSON().accent_color,0xC4A7E7);
});
test("Instagram panels lose gallery and thumbnail but keep instructions and actions",()=>{
  const {ticketPanel}=require("../instagram/ticket-panel");
  const {mediaPanel}=require("../instagram/media-panel");
  for(const render of [ticketPanel,mediaPanel]){
    const original=render("other").components[0].toJSON();
    const clean=render(target).components[0].toJSON();
    assert.doesNotMatch(JSON.stringify(clean),/"type":(?:9|11|12)(?:,|})/);
    assert.equal(clean.components[0].content,original.components[0].components[0].content);
    assert.ok(JSON.stringify(clean).includes("equipe"));
  }
});
test("nested stripping does not remove button accessories or leave adjacent separators",()=>{
  const section={type:9,components:[{type:10,content:"Ação"}],accessory:{type:2,style:2,label:"Abrir",custom_id:"x"}};
  const source=[{type:14},section,{type:14},{type:12,items:[]},{type:14}];
  assert.deepEqual(removePanelImages(source),[section]);
});
test("mds uses principal's plain titles, while unrelated servers retain their titles",()=>{
  const {titulo}=require("../brand");
  assert.equal(titulo({id:target,name:"mds"},"<:title:123>","Suporte"),"# Suporte");
  assert.equal(titulo({id:"1571755216519438347",name:"sla"},"<:title:123>","Suporte"),"# Suporte");
  assert.equal(titulo({id:"other",name:"Outro"},"<:title:123>","Suporte"),"# <:title:123>");
});
