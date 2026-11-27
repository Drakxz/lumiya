const test=require("node:test"),assert=require("node:assert/strict");
const fs=require("node:fs"),path=require("node:path"),vm=require("node:vm");
const source=fs.readFileSync(path.join(__dirname,"../index.js"),"utf8");
const refreshStart=source.indexOf("async function atualizarPainelCargos(");
const refreshSource=source.slice(refreshStart,source.indexOf("\n}",refreshStart)+2);
const handlerStart=source.indexOf('client.on("interactionCreate"',source.indexOf("// CONTROLES DO PAINEL DE CARGOS"));
const handlerSource=source.slice(handlerStart,source.indexOf("// INICIALIZAÇÃO",handlerStart));

test("panel renders without waiting for the full guild member count",async()=>{
  let edited=false,started=false;
  const target={id:"target"};
  const context={
    console,FLAGS_V2:0,validarAlvo:()=>null,
    garantirContagensCargos:()=>{started=true;return new Promise(()=>{});},
    contagemConfiavel:()=>false,atualizarContagensQuandoProntas:()=>{},
    montarContainerCargos:()=>({panel:true}),
  };
  vm.runInNewContext(refreshSource+"\nthis.refresh=atualizarPainelCargos;",context);
  await context.refresh({
    guild:{members:{fetch:async()=>target}},member:{},
    editReply:async()=>{edited=true;},
    followUp:async()=>assert.fail("unexpected error"),
  },{targetId:target.id});
  assert.equal(started,true);
  assert.equal(edited,true);
});

function fixture({allowed=true}={}){
  let handler,acknowledged=false,fetches=0,denied=0,edits=0,mutations=0;
  const cargo={id:"role"},updated={id:"target",roles:{cache:new Map([[cargo.id,cargo]])}};
  const target={id:"target",roles:{cache:new Map(),add:async()=>{
    mutations++;return updated;
  }}};
  const guild={id:"guild",members:{fetch:async()=>{
    assert.equal(acknowledged,true,"acknowledge before any member request");
    fetches++;return target;
  }},roles:{cache:new Map([[cargo.id,cargo]])}};
  const state={id:"panel",guildId:guild.id,staffId:"staff",targetId:target.id};
  const context={
    client:{on:(event,callback)=>{handler=callback;}},
    dados:{rolePanels:{panel:state}},paineisEmOperacao:new Set(),revisoesPainelCargos:new WeakMap(),
    roleWhitelist:{access:()=>({kind:"whitelist"}),applyRolePreset:()=>null},
    renovarPainelCargos(){},salvarDados(){},validarAlvo:()=>null,
    cargoPermitido:()=>allowed,
    responderSemPermissao:async()=>{denied++;},
    responderErro:async()=>assert.fail("unexpected panel error"),
    fichaCargos:{alterarCargo:async({executar})=>executar("audit reason")},
    atualizarContagemMembro:member=>assert.equal(member,updated),
    atualizarPainelCargos:async(interaction,estado,member)=>{
      assert.equal(member,updated);edits++;
    },
    suspenderContagens:()=>assert.fail("unexpected count failure"),console,
  };
  vm.runInNewContext(handlerSource,context);
  const interaction={
    guild,guildId:guild.id,member:{},user:{id:"staff"},
    customId:"cargos:role:panel:role",inGuild:()=>true,isModalSubmit:()=>false,
    isButton:()=>true,deferUpdate:async()=>{acknowledged=true;},
    followUp:async()=>assert.fail("unexpected error"),
  };
  return {run:()=>handler(interaction),context,stats:()=>({fetches,denied,edits,mutations})};
}
test("role action acknowledges early and reuses the API result instead of fetching again",async()=>{
  const f=fixture();await f.run();
  assert.deepEqual(f.stats(),{fetches:1,denied:0,edits:1,mutations:1});
  assert.equal(f.context.paineisEmOperacao.size,0);
});
test("early acknowledgement still checks role permissions before mutation",async()=>{
  const f=fixture({allowed:false});await f.run();
  assert.deepEqual(f.stats(),{fetches:1,denied:1,edits:0,mutations:0});
  assert.equal(f.context.paineisEmOperacao.size,0);
});

function countFixture(){
  const context={
    console,client:{options:{intents:{has:()=>true}}},
    GatewayIntentBits:{GuildMembers:1},
    cargosDoServidor:()=>[{id:"role"}],
    dados:{rolePanels:{}},paineisEmOperacao:new Set(),
    validarAlvo:()=>null,FLAGS_V2:0,
    montarContainerCargos:({alvo})=>({target:alvo.id}),
  };
  const start=source.indexOf("const contagensCargos =");
  const end=source.indexOf('client.on("guildMemberAdd"',start);
  vm.runInNewContext(source.slice(start,end)+`
    this.counts=garantirContagensCargos;
    this.text=textoContagemCargo;
    this.refreshCounts=atualizarContagensQuandoProntas;
    this.revise=estado=>revisoesPainelCargos.set(estado,(revisoesPainelCargos.get(estado)||0)+1);
  `,context);
  return context;
}
test("complete cached members provide exact role counts without another gateway request",async()=>{
  const c=countFixture();
  const guild={id:"guild",available:true,memberCount:1,shardId:0,members:{
    cache:new Map(),fetch:()=>assert.fail("complete cache must not request gateway chunks"),
  }};
  guild.members.cache.set("target",{id:"target",guild,roles:{cache:new Map([["role",{}]])}});
  await c.counts(guild);
  assert.match(c.text(guild,"role"),/1 usuário$/);
});
test("pending counts refresh the existing panel automatically when loaded",async()=>{
  const c=countFixture();let finish,edits=0;
  const guild={id:"guild",available:true,memberCount:1,shardId:0,members:{
    cache:new Map(),fetch:()=>new Promise(resolve=>{finish=resolve;}),
  }};
  const alvo={id:"target",guild,roles:{cache:new Map([["role",{}]])}};
  const estado={id:"panel",targetId:alvo.id};
  c.dados.rolePanels.panel=estado;c.revise(estado);
  c.refreshCounts({estado,guild,autor:{},alvo,editar:async()=>{edits++;}});
  assert.match(c.text(guild,"role"),/Carregando/);
  finish(new Map([[alvo.id,alvo]]));
  await c.counts(guild);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(edits,1);
  assert.match(c.text(guild,"role"),/1 usuário$/);
});
test("late count completion cannot overwrite a newer panel render",async()=>{
  const c=countFixture();let finish,edits=0;
  const guild={id:"guild",available:true,memberCount:1,members:{
    cache:new Map(),fetch:()=>new Promise(resolve=>{finish=resolve;}),
  }};
  const alvo={id:"target",guild,roles:{cache:new Map()}},estado={id:"panel",targetId:"target"};
  c.dados.rolePanels.panel=estado;c.revise(estado);
  c.refreshCounts({estado,guild,autor:{},alvo,editar:async()=>{edits++;}});
  c.revise(estado);
  finish(new Map([[alvo.id,alvo]]));
  await c.counts(guild);await new Promise(resolve=>setImmediate(resolve));
  assert.equal(edits,0);
});
