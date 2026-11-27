const {randomBytes,createHash,createCipheriv,createDecipheriv,timingSafeEqual}=require("node:crypto");
const {fault}=require("./access");
const random=()=>randomBytes(32).toString("base64url");
module.exports=function auth({app,store,cfg,fetchImpl=fetch}){
  const key=createHash("sha256").update(cfg.sessionSecret).digest();
  const options={httpOnly:true,secure:cfg.secure,sameSite:"lax",path:"/"};
  const hash=x=>createHash("sha256").update(x).digest("hex");
  function seal(obj){const iv=randomBytes(12),c=createCipheriv("aes-256-gcm",key,iv);const data=Buffer.concat([c.update(JSON.stringify(obj)),c.final()]);return Buffer.concat([iv,c.getAuthTag(),data]).toString("base64url");}
  function open(value){try{const b=Buffer.from(value,"base64url"),c=createDecipheriv("aes-256-gcm",key,b.subarray(0,12));c.setAuthTag(b.subarray(12,28));return JSON.parse(Buffer.concat([c.update(b.subarray(28)),c.final()]));}catch{return null;}}
  function session(req){
    const token=req.cookies.iw_session;
    if(!token||token.length>128)return null;
    const row=store.db.prepare("SELECT * FROM iw_sessions WHERE hash=? AND expiresAt>?").get(hash(token),Date.now());
    if(!row||Date.now()-row.createdAt>7*86400000)return null;
    return row;
  }
  function requireSession(req){const s=session(req);if(!s)throw fault(401,"Entre com Discord para continuar.");req.session=s;return s;}
  function csrf(req){
    const origin=req.headers.origin;
    const token=req.headers["x-csrf-token"];
    const expected=req.session?.csrf;
    if(origin!==cfg.origin||typeof token!=="string"||!expected||Buffer.byteLength(token)!==Buffer.byteLength(expected)||
      !timingSafeEqual(Buffer.from(token),Buffer.from(expected)))throw fault(403,"Solicitação inválida. Atualize a página.");
  }
  app.get("/api/auth/discord",async(req,res)=>{
    const state=random(),verifier=random();
    res.setCookie("iw_oauth",seal({state,verifier,at:Date.now()}),{...options,maxAge:600});
    const url=new URL("https://discord.com/oauth2/authorize");
    for(const [k,v] of Object.entries({client_id:cfg.clientId,redirect_uri:cfg.redirect,response_type:"code",scope:cfg.identifyPremium?"identify identify.premium":"identify",
      state,code_challenge:hashBase64(verifier),code_challenge_method:"S256"}))url.searchParams.set(k,v);
    return res.redirect(url.href);
  });
  app.get("/api/auth/discord/callback",async(req,res)=>{
    const flow=open(req.cookies.iw_oauth||"");res.clearCookie("iw_oauth",options);
    if(!flow||Date.now()-flow.at>600000||typeof req.query.code!=="string"||req.query.code.length>2048||
      req.query.state!==flow.state)throw fault(400,"Autenticação inválida ou expirada.");
    // Consume the state cookie before any network operation. No access/refresh token is stored.
    const response=await fetchImpl("https://discord.com/api/v10/oauth2/token",{
      method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},
      body:new URLSearchParams({client_id:cfg.clientId,client_secret:cfg.secret,grant_type:"authorization_code",
        redirect_uri:cfg.redirect,code:req.query.code,code_verifier:flow.verifier}),signal:AbortSignal.timeout(15000)});
    if(!response.ok)throw fault(401,"O Discord não autorizou o login.");
    const token=await response.json();
    if(typeof token.access_token!=="string"||token.token_type?.toLowerCase()!=="bearer")throw fault(401,"Resposta de autenticação inválida.");
    const profileResponse=await fetchImpl("https://discord.com/api/v10/users/@me",{
      headers:{authorization:`Bearer ${token.access_token}`},signal:AbortSignal.timeout(15000)});
    if(!profileResponse.ok)throw fault(401,"Não foi possível obter sua conta Discord.");
    const u=await profileResponse.json();
    if(!/^\d{17,20}$/.test(u.id)||u.bot)throw fault(401,"Conta inválida.");
    // Revoke provider token immediately: all membership checks use the existing bot.
    await fetchImpl("https://discord.com/api/v10/oauth2/token/revoke",{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},
      body:new URLSearchParams({client_id:cfg.clientId,client_secret:cfg.secret,token:token.access_token}),signal:AbortSignal.timeout(10000)}).catch(()=>{});
    const profile={id:u.id,username:String(u.username).slice(0,100),globalName:u.global_name||null,avatar:u.avatar||null};
    // Only the explicitly granted partner scope may supply a Nitro snapshot.
    // No provider token is retained and no subscription is inferred from cosmetics.
    if(cfg.identifyPremium&&typeof token.scope==="string"&&token.scope.split(/\s+/).includes("identify.premium")&&Number.isInteger(u.premium_type)&&u.premium_type>=0&&u.premium_type<=3){
      profile.nitro={type:u.premium_type,checkedAt:Date.now()};
    }
    store.db.prepare("INSERT INTO iw_users(id,profile,updatedAt) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET profile=excluded.profile,updatedAt=excluded.updatedAt").run(u.id,JSON.stringify(profile),Date.now());
    const old=session(req);if(old)store.db.prepare("DELETE FROM iw_sessions WHERE hash=?").run(old.hash);
    const raw=random(),now=Date.now();
    store.db.prepare("INSERT INTO iw_sessions VALUES(?,?,?,?,?)").run(hash(raw),u.id,random(),now,now+12*3600000);
    res.setCookie("iw_session",raw,{...options,maxAge:12*3600});
    store.audit(u.id,"login");return res.redirect("/app");
  });
  app.post("/api/auth/logout",async(req,res)=>{
    requireSession(req);csrf(req);
    store.db.prepare("DELETE FROM iw_sessions WHERE hash=?").run(req.session.hash);
    res.clearCookie("iw_session",options);store.audit(req.session.userId,"logout");return {ok:true};
  });
  app.post("/api/auth/revoke",async(req,res)=>{
    requireSession(req);csrf(req);
    store.db.prepare("DELETE FROM iw_sessions WHERE userId=?").run(req.session.userId);
    res.clearCookie("iw_session",options);store.audit(req.session.userId,"sessions.revoked");return {ok:true};
  });
  app.post("/api/auth/renew",async(req,res)=>{
    requireSession(req);csrf(req);const raw=random();
    store.db.prepare("UPDATE iw_sessions SET hash=?,csrf=?,expiresAt=? WHERE hash=?").run(hash(raw),random(),Math.min(Date.now()+12*3600000,req.session.createdAt+7*86400000),req.session.hash);
    res.setCookie("iw_session",raw,{...options,maxAge:12*3600});return {ok:true};
  });
  return {session,requireSession,csrf};
};
function hashBase64(x){return createHash("sha256").update(x).digest("base64url");}
