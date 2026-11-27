const {ContainerBuilder,TextDisplayBuilder,MessageFlags,PermissionFlagsBits}=require('discord.js');
const {getSharedProfileClient}=require('./profile-client');
function createBioGate({engine,client,history,validateRole,provider=getSharedProfileClient(),now=()=>Date.now(),intervalMs=30*60000}){
  const db=engine.store.db;let running=false,stopped=false;
  db.exec(`CREATE TABLE IF NOT EXISTS up_bio_checks(guildId TEXT NOT NULL,userId TEXT NOT NULL,status TEXT NOT NULL,reason TEXT,checkedAt INTEGER NOT NULL,nextCheckAt INTEGER NOT NULL,notified INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(guildId,userId));
    CREATE TABLE IF NOT EXISTS up_bio_roles(guildId TEXT NOT NULL,userId TEXT NOT NULL,roleId TEXT NOT NULL,state TEXT NOT NULL,updatedAt INTEGER NOT NULL,PRIMARY KEY(guildId,userId,roleId));`);
  const enabled=provider.enabled;
  const status=(gid,uid)=>db.prepare('SELECT * FROM up_bio_checks WHERE guildId=? AND userId=?').get(gid,uid);
  async function inspect(guild,uid,force=false){
    if(!enabled)return {status:'disabled'};
    const previous=status(guild.id,uid);if(!force&&previous&&previous.nextCheckAt>now())return previous;
    const result=await provider.check(guild.id,uid),next=result.status==='unknown'?Math.max(now()+60000,result.retryAt||now()+300000):now()+intervalMs;
    db.prepare(`INSERT INTO up_bio_checks(guildId,userId,status,reason,checkedAt,nextCheckAt) VALUES(?,?,?,?,?,?) ON CONFLICT(guildId,userId) DO UPDATE SET status=excluded.status,reason=excluded.reason,checkedAt=excluded.checkedAt,nextCheckAt=excluded.nextCheckAt,notified=CASE WHEN excluded.status='present' THEN 0 ELSE up_bio_checks.notified END`).run(guild.id,uid,result.status,result.reason||null,now(),next);
    return status(guild.id,uid);
  }
  function explanation(result){
    if(result?.status==='missing')return 'Adicione /mds à sua bio do Discord para resgatar e manter os cargos de UP.';
    if(result?.reason==='inaccessible_or_private')return 'Perfil indisponível ou privado: não foi possível verificar a bio. O resgate não pode ser confirmado.';
    if(result?.reason==='invalid_credentials')return 'A conta de verificação está indisponível. Peça à equipe para revisar a configuração.';
    return 'A verificação da bio está temporariamente indisponível. Aguarde e tente novamente; nenhum cargo existente será removido por esta falha.';
  }
  async function restoreIfNeeded(guild,uid,r){if(r.status==='present'&&db.prepare("SELECT 1 FROM up_bio_roles WHERE guildId=? AND userId=? AND state IN ('remove_pending','removed') LIMIT 1").get(guild.id,uid))await reconcile(guild,uid,r);}
  async function allow(guild,uid,force=false){const r=await inspect(guild,uid,force);await restoreIfNeeded(guild,uid,r);return r.status==='disabled'||r.status==='present';}
  async function requireBio(guild,uid,force=false){const r=await inspect(guild,uid,force);if(r.status!=='disabled'&&r.status!=='present')throw new Error(explanation(r));await restoreIfNeeded(guild,uid,r);}
  const authorized=guild=>new Set([...engine.store.levels(guild.id).map(l=>l.roleId),...engine.store.config(guild.id).initialRoles]);
  async function change(guild,member,role,action){
    const bot=await guild.members.fetchMe({force:true});if(!bot.permissions.has(PermissionFlagsBits.ManageRoles)||role.managed||role.id===guild.id||role.position>=bot.roles.highest.position)throw new Error('UP bio: cargo não gerenciável.');
    if(action==='add')validateRole(guild,role);
    await history.alterarCargo({guild,alvo:member,cargo:role,action,autor:client.user,source:'Requisito de bio do UP',reason:action==='remove'?'Bio verificada sem /mds':'Bio /mds regularizada',executar:reason=>action==='remove'?member.roles.remove(role,reason):member.roles.add(role,reason)});
  }
  async function reconcile(guild,uid,result){
    if(!['present','missing'].includes(result.status))return;
    const member=await guild.members.fetch({user:uid,force:true});if(member.user.bot)return;
    const allowed=authorized(guild),progress=engine.store.member(guild.id,uid);if(!progress||progress.state==='absent')return;
    if(result.status==='missing'){
      const earned=db.prepare("SELECT DISTINCT roleId FROM up_operations WHERE guildId=? AND userId=? AND state IN ('granted','done')").all(guild.id,uid);
      for(const {roleId} of earned)if(allowed.has(roleId)&&member.roles.cache.has(roleId))db.prepare("INSERT INTO up_bio_roles VALUES(?,?,?,'remove_pending',?) ON CONFLICT(guildId,userId,roleId) DO UPDATE SET state='remove_pending',updatedAt=excluded.updatedAt").run(guild.id,uid,roleId,now());
    }
    let removed=false;
    for(const item of db.prepare("SELECT * FROM up_bio_roles WHERE guildId=? AND userId=? AND state IN ('remove_pending','removed')").all(guild.id,uid)){
      if(!allowed.has(item.roleId)){db.prepare("UPDATE up_bio_roles SET state='cancelled',updatedAt=? WHERE guildId=? AND userId=? AND roleId=?").run(now(),guild.id,uid,item.roleId);continue;}
      const role=await guild.roles.fetch(item.roleId);if(!role){db.prepare("UPDATE up_bio_roles SET state='cancelled',updatedAt=? WHERE guildId=? AND userId=? AND roleId=?").run(now(),guild.id,uid,item.roleId);continue;}
      if(result.status==='missing'){
        if(member.roles.cache.has(role.id))await change(guild,member,role,'remove');
        db.prepare("UPDATE up_bio_roles SET state='removed',updatedAt=? WHERE guildId=? AND userId=? AND roleId=?").run(now(),guild.id,uid,role.id);removed=true;
      }else{
        if(engine.store.config(guild.id).removePrevious&&progress.currentRoleId!==role.id){db.prepare("UPDATE up_bio_roles SET state='cancelled',updatedAt=? WHERE guildId=? AND userId=? AND roleId=?").run(now(),guild.id,uid,role.id);continue;}
        if(!member.roles.cache.has(role.id))await change(guild,member,role,'add');
        db.prepare("UPDATE up_bio_roles SET state='restored',updatedAt=? WHERE guildId=? AND userId=? AND roleId=?").run(now(),guild.id,uid,role.id);
      }
    }
    if(removed&&!status(guild.id,uid)?.notified){
      try{
        await member.send({components:[new ContainerBuilder().setAccentColor(0).addTextDisplayComponents(new TextDisplayBuilder().setContent('# Requisito da bio do UP\n-# A bio foi verificada sem /mds. Os cargos de UP concedidos pelo sistema foram removidos.\nSuas horas e seu progresso foram preservados. Ao regularizar a bio, os cargos ainda autorizados poderão ser restaurados.'))],flags:MessageFlags.IsComponentsV2,allowedMentions:{parse:[]}});
        db.prepare('UPDATE up_bio_checks SET notified=1 WHERE guildId=? AND userId=?').run(guild.id,uid);
      }catch{console.warn('[UP bio] Não foi possível entregar o aviso privado; será tentado novamente.');}
    }
  }
  async function review(gid,uid){
    if(!enabled||stopped)return;const key=`${gid}:${uid}`;if(engine.locks.has(key))return;engine.locks.add(key);
    try{const guild=client.guilds.cache.get(gid);if(!guild?.available)return;const result=await inspect(guild,uid,true);await reconcile(guild,uid,result);}
    catch(error){
      if(error.code===10007)db.prepare("UPDATE up_members SET state='absent',updatedAt=? WHERE guildId=? AND userId=?").run(now(),gid,uid);
      else{db.prepare('UPDATE up_bio_checks SET nextCheckAt=MIN(nextCheckAt,?) WHERE guildId=? AND userId=?').run(now()+300000,gid,uid);console.warn('[UP bio] Verificação ou alteração de cargo indisponível; será tentada novamente.');}
    }
    finally{engine.locks.delete(key);}
  }
  async function tick(){
    if(!enabled||stopped||running)return;running=true;
    try{
      const due=db.prepare("SELECT m.guildId,m.userId FROM up_members m LEFT JOIN up_bio_checks b ON b.guildId=m.guildId AND b.userId=m.userId WHERE m.state!='absent' AND (b.userId IS NULL OR b.nextCheckAt<=?) ORDER BY COALESCE(b.nextCheckAt,0),m.guildId,m.userId LIMIT 3").all(now());
      for(const row of due){if(stopped)break;await review(row.guildId,row.userId);}
    }
    finally{running=false;}
  }
  return {enabled,status,inspect,allow,require:requireBio,explanation,review,tick,stop(){stopped=true;}};
}
module.exports={createBioGate};
