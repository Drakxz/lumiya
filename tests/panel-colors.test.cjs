const test=require("node:test"),assert=require("node:assert/strict");
const {EventEmitter}=require("node:events");
const {DatabaseSync}=require("node:sqlite");
const d=require("discord.js");
const {initializeColors,panelColor,parseColor}=require("../panel-art/colors");
const install=require("../panel-art/color-panel");
const {applyPanelAppearance}=require("../panel-art/appearance");

test("hex colors validate, persist per guild and reset without touching other settings",()=>{
  const db=new DatabaseSync(":memory:");
  const store=initializeColors(db);
  assert.equal(panelColor("a"),0xC4A7E7);
  for(const invalid of ["red","#fff","1234567","-12345",123456,"#gggggg"])
    assert.throws(()=>parseColor(invalid));
  store.set("a","#123AbC");
  assert.equal(panelColor("a"),0x123ABC);
  assert.equal(panelColor("b"),0xC4A7E7);
  initializeColors(db);
  assert.equal(panelColor("a"),0x123ABC);
  const source=new d.ContainerBuilder().setAccentColor(0);
  const rendered=applyPanelAppearance(source,"a").toJSON();
  assert.equal(rendered.accent_color,0x123ABC);
  assert.equal(source.toJSON().accent_color,0);
  store.reset("a");assert.equal(panelColor("a"),0xC4A7E7);
  db.close();
});

test("administrator panel previews, edits, validates, restores and rechecks live permission and ownership",async()=>{
  const db=new DatabaseSync(":memory:"),client=new EventEmitter();
  let command,allowed=true,payload,modal;
  const guild={id:"guild",members:{fetch:async()=>({
    permissions:new d.PermissionsBitField(allowed?[d.PermissionFlagsBits.Administrator]:[])
  })}};
  install({client,registry:{register(c){command=c;}},db});
  await command.prefix.execute({guild,author:{id:"admin"},reply:async p=>{payload=p;}});
  assert.equal(payload.components[0].toJSON().accent_color,0xC4A7E7);
  const editId=payload.components[0].toJSON().components[1].components[0].custom_id;
  const handle=client.listeners("interactionCreate")[0];
  const interaction=(id,extra={})=>({
    customId:id,guild,user:{id:"admin"},isButton:()=>true,isModalSubmit:()=>false,
    reply:async p=>{payload=p;},update:async p=>{payload=p;},
    showModal:async m=>{modal=m.toJSON();},...extra
  });
  await handle(interaction(editId));assert.equal(modal.title,"Alterar cor dos painéis");
  const save=hex=>interaction(modal.custom_id,{
    isButton:()=>false,isModalSubmit:()=>true,fields:{getTextInputValue:()=>hex}
  });
  await handle(save("#112233"));assert.equal(panelColor(guild),0x112233);
  assert.equal(payload.components[0].toJSON().accent_color,0x112233);
  await handle(save("#oops"));assert.match(payload.content,/hexadecimal/);
  assert.equal(panelColor(guild),0x112233);
  await handle(interaction(editId.replace(/edit$/,"reset"),{user:{id:"outsider"}}));
  assert.match(payload.content,/pertence/);assert.equal(panelColor(guild),0x112233);
  await handle(interaction(editId.replace(/edit$/,"reset"),{guild:{...guild,id:"other"}}));
  assert.match(payload.content,/pertence/);
  allowed=false;await handle(save("#FFFFFF"));
  assert.match(payload.content,/administradores/);assert.equal(panelColor(guild),0x112233);
  allowed=true;await handle(interaction(editId.replace(/edit$/,"reset")));
  assert.equal(panelColor(guild),0xC4A7E7);
  db.close();
});
