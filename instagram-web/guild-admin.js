const {settingsSchema,id}=require("./config");
const {fault}=require("./access");

module.exports=function guildAdmin({app,store,cfg,access,auth,worker}){
  async function guard(req){
    auth.requireSession(req);
    if(req.method!=="GET")auth.csrf(req);
    return access.manageGuild(req.session.userId,id.parse(req.params.guildId));
  }
  app.get("/api/admin/guilds",async req=>{
    auth.requireSession(req);
    return {items:await access.manageableGuilds(req.session.userId),defaultGuildId:cfg.defaultGuildId};
  });
  app.get("/api/admin/guilds/:guildId/settings",async req=>{
    const {guild}=await guard(req);
    const [roles,channels]=await Promise.all([guild.roles.fetch(),guild.channels.fetch()]);
    return {settings:store.settings(guild.id,{allowUnconfigured:true}),
      roles:[...roles.values()].filter(Boolean).map(r=>({id:r.id,name:r.name})),
      channels:[...channels.values()].filter(c=>c?.type===0).map(c=>({id:c.id,name:c.name})),
      policy:worker.policy,moderationModel:"omni-moderation-latest"};
  });
  app.patch("/api/admin/guilds/:guildId/settings",async req=>{
    const {guild}=await guard(req),s=settingsSchema.parse(req.body);
    const channels=await guild.channels.fetch(),roles=await guild.roles.fetch();
    const channel=channels.get(s.channelId);
    if(!channel||channel.guildId!==guild.id||channel.type!==0)throw fault(400,"Escolha um canal de texto deste servidor.");
    await access.botChannel(channel);
    if(s.logChannelId){
      const logs=channels.get(s.logChannelId);
      if(!logs||logs.guildId!==guild.id||logs.type!==0||logs.permissionsFor(guild.roles.everyone)?.has(1024n))throw fault(400,"Escolha um canal de logs privado deste servidor.");
      await access.botChannel(logs);
    }
    for(const rid of [...s.allowedRoles,...s.blockedRoles,...s.moderatorRoles,...s.vipRoles]){
      if(!roles.has(rid))throw fault(400,"Escolha apenas cargos deste servidor.");
    }
    return store.transaction(()=>{
      store.db.prepare("INSERT OR REPLACE INTO instagram_settings VALUES(?,?)").run(guild.id,s.channelId);
      return store.saveSettings(s,req.session.userId,guild.id);
    });
  });
};
