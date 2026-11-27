const {AsyncLocalStorage}=require("node:async_hooks");
const {id}=require("./config");

// Immutable per-request/job context: concurrent requests never change a shared guild ID.
module.exports=function createScope(config){
  const context=new AsyncLocalStorage();
  const cfg={...config,defaultGuildId:config.guildId};
  Object.defineProperty(cfg,"guildId",{enumerable:true,get:()=>context.getStore()||config.guildId});
  const run=(guildId,fn)=>context.run(id.parse(guildId),fn);
  function routes(app){
    return Object.fromEntries(["get","post","patch","delete"].map(method=>[method,(url,handler)=>
      app[method](url,(req,res)=>run(req.query.guildId===undefined?config.guildId:id.parse(req.query.guildId),()=>handler(req,res)))]));
  }
  return {cfg,run,routes};
};
