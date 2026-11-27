// Native-app login bridge: the Discord Social SDK authorizes inside the real
// Discord client and hands the app a code + PKCE verifier. The server exchanges
// them, creates a one-time ticket and turns it into the normal web session.
const {randomBytes}=require("node:crypto");
const {z}=require("zod");

const schema=z.object({
  code:z.string().min(1).max(2048),
  codeVerifier:z.string().regex(/^[A-Za-z0-9_-]{43,128}$/),
  redirectUri:z.string().optional()
}).strict();

module.exports=function nativeAuth({app,store,cfg,fetchImpl=fetch}){
  const db=store.db;
  const nativeRedirect=`discord-${cfg.clientId}:/authorize/callback`;
  const cookie={httpOnly:true,secure:cfg.secure,sameSite:"lax",path:"/"};
  async function request(url,options){return fetchImpl(url,{...options,signal:AbortSignal.timeout(15000)});}

  app.post("/api/auth/native/exchange",async req=>{
    const input=schema.parse(req.body);
    const redirectUri=input.redirectUri||nativeRedirect;
    const loopback=/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}\/callback$/;
    if(redirectUri!==nativeRedirect&&!loopback.test(redirectUri))throw Object.assign(new Error("Redirect inválido."),{statusCode:400});
    const tokenResponse=await request("https://discord.com/api/v10/oauth2/token",{
      method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},
      body:new URLSearchParams({client_id:cfg.clientId,client_secret:cfg.secret,grant_type:"authorization_code",
        code:input.code,redirect_uri:redirectUri,code_verifier:input.codeVerifier})
    });
    if(!tokenResponse.ok)throw Object.assign(new Error("O Discord não autorizou o login."),{statusCode:401});
    const token=await tokenResponse.json();
    if(typeof token.access_token!=="string"||token.token_type?.toLowerCase()!=="bearer")
      throw Object.assign(new Error("Resposta de autenticação inválida."),{statusCode:401});
    let profile;
    try{
      const userResponse=await request("https://discord.com/api/v10/users/@me",{headers:{authorization:`Bearer ${token.access_token}`}});
      if(!userResponse.ok)throw new Error("Perfil indisponível.");
      profile=await userResponse.json();
    }finally{
      await request("https://discord.com/api/v10/oauth2/token/revoke",{
        method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},
        body:new URLSearchParams({client_id:cfg.clientId,client_secret:cfg.secret,token:token.access_token})
      }).catch(()=>{});
    }
    if(!/^\d{17,20}$/.test(profile.id)||profile.bot)throw Object.assign(new Error("Conta inválida."),{statusCode:401});
    db.prepare("INSERT INTO iw_users(id,profile,updatedAt) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET profile=excluded.profile,updatedAt=excluded.updatedAt")
      .run(profile.id,JSON.stringify({id:profile.id,username:String(profile.username||"").slice(0,100),globalName:profile.global_name||null,avatar:profile.avatar||null}),Date.now());
    const ticket=randomBytes(32).toString("base64url");
    db.prepare("INSERT OR REPLACE INTO iw_native_tickets(hash,userId,expiresAt,usedAt) VALUES(?,?,?,NULL)")
      .run(store.hash(ticket),profile.id,Date.now()+5*60*1000);
    store.audit(profile.id,"native.login");
    return {url:`/api/auth/native/consume?ticket=${encodeURIComponent(ticket)}`};
  });

  app.get("/api/auth/native/consume",async(req,res)=>{
    const ticket=typeof req.query.ticket==="string"?req.query.ticket:"";
    if(!ticket||ticket.length>128)throw Object.assign(new Error("Link inválido."),{statusCode:400});
    const now=Date.now(),row=db.prepare("SELECT * FROM iw_native_tickets WHERE hash=? AND usedAt IS NULL AND expiresAt>?").get(store.hash(ticket),now);
    if(!row)throw Object.assign(new Error("Link expirado ou já usado."),{statusCode:404});
    const claimed=db.prepare("UPDATE iw_native_tickets SET usedAt=? WHERE hash=? AND usedAt IS NULL").run(now,row.hash);
    if(claimed.changes!==1)throw Object.assign(new Error("Link já usado."),{statusCode:404});
    const raw=randomBytes(32).toString("base64url"),csrf=randomBytes(32).toString("base64url");
    db.prepare("INSERT INTO iw_sessions VALUES(?,?,?,?,?)").run(store.hash(raw),row.userId,csrf,now,now+12*3600*1000);
    res.setCookie("iw_session",raw,{...cookie,maxAge:12*3600});
    return res.redirect("/app");
  });
};
