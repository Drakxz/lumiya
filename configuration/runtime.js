// Ponte leve para os sistemas existentes. Validação, imagens e editor só são
// carregados quando usados; enviar um painel sem override não carrega Sharp.
const {AsyncLocalStorage}=require("node:async_hooks");
const scope=new AsyncLocalStorage(),files=new WeakMap();
let runtime=null;
function installRuntime(value){runtime=value;}
function decorate(container,guild,panelId,context={}){
  if(!runtime||!panelId||scope.getStore()?.defaults)return container;
  const g=typeof guild==="string"?runtime.client.guilds?.cache?.get(guild)||{id:guild}:guild;
  if(!g?.id)return container;
  const config=runtime.store.panel(g.id,panelId).data;
  if(!Object.keys(config).length)return container;
  const output=require("./render").apply([container.toJSON()],config,
    {...scope.getStore()?.context,guild:g,bot:runtime.client.user,client:runtime.client,...context},
    {asset:id=>runtime.store.asset(g.id,id)});
  const builder=new (require("discord.js").ContainerBuilder)(output.components[0]);
  files.set(builder,output.files);return builder;
}
const filesFor=components=>(components||[]).flatMap(c=>files.get(c)||[]);
const defaults=fn=>scope.run({...scope.getStore(),defaults:true},fn);
const withContext=(context,fn)=>scope.run({...scope.getStore(),context:{...scope.getStore()?.context,...context}},fn);
module.exports={installRuntime,decorate,filesFor,defaults,withContext};
