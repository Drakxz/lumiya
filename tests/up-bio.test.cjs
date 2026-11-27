const test=require('node:test'),assert=require('node:assert/strict');
const {Collection,PermissionsBitField,PermissionFlagsBits}=require('discord.js');
const {VoiceHoursStore}=require('../voice-hours/store');
const {UpStore}=require('../up/store');
const {createProfileClient,hasMarker}=require('../up/profile-client');
const {createBioGate}=require('../up/bio-gate');
const {validateRole}=require('../up/engine');
const G='100000000000000001',U='100000000000000002',B='100000000000000003';
const R='100000000000000010',R2='100000000000000011',R3='100000000000000012';

const response=(status,data,headers={})=>({status,ok:status>=200&&status<300,headers:{get:name=>headers[String(name).toLowerCase()]??null},json:async()=>data});

test('bio marker must be the literal /mds token, not a substring',()=>{
  for(const bio of ['/mds','tenho /mds na bio','linha\n/MDS','/mds.','use (/mds)'])assert.equal(hasMarker(bio),true,bio);
  for(const bio of ['mds','/mdsx','x/mds','/m ds','','/mds_extra'])assert.equal(hasMarker(bio),false,bio);
});

test('profile client stays disabled without a token and never calls Discord',async()=>{
  let calls=0;const client=createProfileClient({token:'',fetchImpl:async()=>{calls++;throw new Error('must not run');}});
  assert.equal(client.enabled,false);assert.deepEqual(await client.check(G,U),{status:'disabled'});assert.equal(calls,0);
});

test('profile client reports eligibility without persisting or returning the bio text',async()=>{
  const seen=[];const client=createProfileClient({token:'user-token',wait:async()=>{},fetchImpl:async(url,options)=>{
    seen.push({url,options});return response(200,{user:{id:U},user_profile:{bio:'meu perfil /mds\nsegredo'}});
  }});
  const result=await client.check(G,U);
  assert.deepEqual(result,{status:'present',reason:null,retryAt:null});
  assert.equal(seen[0].url,`https://discord.com/api/v9/users/${U}/profile?guild_id=${G}`);
  assert.equal(seen[0].options.headers.Authorization,'user-token');assert.equal(JSON.stringify(result).includes('segredo'),false);
});

test('visual badge projection is sanitized, cached and never exposes the raw profile',async()=>{
  let calls=0,clock=1000;const icon='a'.repeat(32);
  const client=createProfileClient({token:'user-token',now:()=>clock,wait:async()=>{},fetchImpl:async()=>{
    calls++;return response(200,{user:{id:U},user_profile:{bio:'/mds'},mutual_friends:[U],badges:[
      {id:'nitro',description:'Discord Nitro',icon},
      {id:'nitro',description:'Duplicado',icon},
      {id:'bad id',description:'Inválido',icon},
      {id:'early_supporter',description:'Early Supporter\u0000',icon},
      {id:'no_icon',description:'Sem ícone',icon:'not-a-hash'},
      {id:'no_desc',icon}
    ]});
  }});
  const first=await client.visuals(G,U);
  assert.equal(first.status,'available');
  assert.deepEqual(first.badges.map(b=>b.id),['native:nitro','native:early_supporter']);
  assert.equal(first.badges[0].kind,'discord');assert.equal(first.badges[0].label,'Discord Nitro');
  assert.equal(first.badges[0].icon,`https://cdn.discordapp.com/badge-icons/${icon}.png`);
  assert.equal(first.badges[1].label,'Early Supporter');
  const serialized=JSON.stringify(first);
  for(const forbidden of ['user-token','/mds','mutual_friends',`"${U}"`])assert.equal(serialized.includes(forbidden),false,forbidden);
  await client.visuals(G,U);assert.equal(calls,1);
  clock+=300001;await client.visuals(G,U);assert.equal(calls,2);
});

test('visual badges fail closed, cache failures briefly and do not alter bio eligibility',async()=>{
  let calls=0,clock=0;
  const client=createProfileClient({token:'user-token',now:()=>clock,wait:async()=>{},fetchImpl:async()=>{calls++;return response(403,{})}});
  const first=await client.visuals(G,U);
  assert.equal(first.status,'unknown');assert.equal(first.reason,'inaccessible_or_private');
  await client.visuals(G,U);assert.equal(calls,1);
  clock+=60001;await client.visuals(G,U);assert.equal(calls,2);
  const ok=createProfileClient({token:'user-token',now:()=>clock,wait:async()=>{},fetchImpl:async()=>response(200,{user:{id:U},user_profile:{bio:'/mds'},badges:[{id:'nitro',description:'Nitro',icon:'b'.repeat(32)}]})});
  assert.equal((await ok.check(G,U)).status,'present');
  assert.equal((await ok.visuals(G,U)).badges[0].id,'native:nitro');
});

test('profile client distinguishes missing bio, private profile and provider failures',async()=>{
  let result;
  const client=createProfileClient({token:'user-token',wait:async()=>{},fetchImpl:async()=>result});
  result=response(200,{user:{id:U},user_profile:{bio:'sem marcador'}});
  assert.equal((await client.check(G,U)).status,'missing');
  result=response(200,{user:{id:U},user_profile:null});
  const privateProfile=await client.check(G,U);assert.equal(privateProfile.status,'unknown');assert.equal(privateProfile.reason,'inaccessible_or_private');
  result=response(200,{user:{id:U},user_profile:{}});
  assert.equal((await client.check(G,U)).reason,'inaccessible_or_private');
  result=response(403,{message:'Forbidden'});
  assert.equal((await client.check(G,U)).reason,'inaccessible_or_private');
  result=response(500,{message:'error'});
  assert.equal((await client.check(G,U)).reason,'provider_error');
  result=response(200,{user:{id:U},user_profile:{bio:'/mds'},unexpected:true});
  assert.equal((await client.check(G,U)).status,'present');
});

test('invalid credentials pause the provider and malformed tokens are rejected locally',async()=>{
  let calls=0,clock=1000;
  const client=createProfileClient({token:'user-token',now:()=>clock,fetchImpl:async()=>{calls++;return response(401,{});}});
  assert.equal((await client.check(G,U)).reason,'invalid_credentials');assert.equal(calls,1);
  clock+=1000;
  assert.equal((await client.check(G,R2)).reason,'invalid_credentials');assert.equal(calls,1);
  let malformedCalls=0;
  const bot=createProfileClient({token:'Bot abc',fetchImpl:async()=>{malformedCalls++;return response(200,{});}});
  assert.equal((await bot.check(G,U)).reason,'invalid_credentials');assert.equal(malformedCalls,0);
});

test('rate limits pause all checks and concurrent requests share one fetch',async()=>{
  let calls=0,clock=5000;
  const client=createProfileClient({token:'user-token',now:()=>clock,wait:async ms=>{clock+=ms;},fetchImpl:async()=>{
    calls++;return response(429,{retry_after:2});
  }});
  const first=await client.check(G,U);assert.equal(first.reason,'rate_limited');assert.equal(calls,1);
  clock+=500;assert.equal((await client.check(G,R2)).reason,'rate_limited');assert.equal(calls,1);
  clock+=1500;
  const ok=createProfileClient({token:'user-token',now:()=>clock,wait:async()=>{},fetchImpl:async()=>{calls++;return response(200,{user:{id:U},user_profile:{bio:'/mds'}});}});
  const [a,b]=await Promise.all([ok.check(G,U),ok.check(G,U)]);
  assert.equal(a.status,'present');assert.equal(b,a);assert.equal(calls,2);
});

test('checks are serialized to respect the per-account interval',async()=>{
  const starts=[],waits=[];let clock=0;
  const client=createProfileClient({token:'user-token',now:()=>clock,wait:async ms=>{waits.push(ms);clock+=ms;},fetchImpl:async url=>{
    starts.push(clock);return response(200,{user:{id:url.includes(U)?U:R2},user_profile:{bio:'/mds'}});
  }});
  assert.equal((await client.check(G,U)).status,'present');
  assert.equal((await client.check(G,R2)).status,'present');
  assert.deepEqual(starts,[0,2000]);assert.ok(waits.includes(2000));
});

function fixture(t,{initial='missing'}={}){
  let clock=1000;const hours=new VoiceHoursStore(':memory:'),store=new UpStore(hours);
  const dms=[],changes=[],owned=new Set([R]);
  const role=id=>({id,name:`Cargo ${id}`,position:1,managed:false,permissions:new PermissionsBitField()});
  const roles=new Map([R,R2,R3].map(id=>[id,role(id)]));
  const member={id:U,user:{id:U,bot:false},send:async payload=>{dms.push(payload);},roles:{
    cache:{has:id=>owned.has(id)},
    add:async r=>{owned.add(r.id);return member;},
    remove:async r=>{owned.delete(r.id);return member;}
  }};
  const bot={id:B,permissions:new PermissionsBitField([PermissionFlagsBits.ManageRoles]),roles:{highest:{position:100}}};
  const guild={id:G,ownerId:'owner',available:true,roles:{cache:new Collection([...roles]),fetch:async id=>roles.get(id)||null},
    members:{me:bot,fetchMe:async()=>bot,fetch:async()=>member}};
  const client={user:{id:B},guilds:{cache:new Map([[G,guild]])}};
  const history={async alterarCargo(request){changes.push(request);return request.executar('motivo de teste');}};
  let result={status:initial,reason:initial==='missing'?null:'inaccessible_or_private',retryAt:null};
  let checks=0;
  const provider={enabled:true,check:async()=>{checks++;return {...result};}};
  const engine={store,locks:new Set()};
  const gate=createBioGate({engine,client,history,validateRole,provider,now:()=>clock});
  store.db.prepare('INSERT INTO up_levels(id,guildId,roleId,requiredMs) VALUES(?,?,?,?)').run('lvl',G,R,0);
  store.join(G,U,0,clock);
  store.db.prepare("UPDATE up_members SET state='active',currentLevelId='lvl',currentRoleId=?,bestMs=0 WHERE guildId=? AND userId=?").run(R,G,U);
  store.db.prepare(`INSERT INTO up_operations(id,guildId,userId,levelId,roleId,requiredMs,previousRoleId,hoursMs,removePrevious,recalculate,state,createdAt)
    VALUES('op',?,?,'lvl',?,0,NULL,0,1,0,'done',?)`).run(G,U,R,clock);
  t.after(()=>{gate.stop();hours.db.close();});
  return {gate,store,client,guild,member,bot,owned,roles,dms,changes,history,
    setResult:next=>{result=next;},get checks(){return checks;},advance:ms=>{clock+=ms;},now:()=>clock};
}

test('a verified missing bio removes only earned UP roles and sends one private warning',async t=>{
  const f=fixture(t,{initial:'missing'});
  f.owned.add(R2); // não é recompensa configurada
  f.store.db.prepare(`INSERT INTO up_operations(id,guildId,userId,levelId,roleId,requiredMs,previousRoleId,hoursMs,removePrevious,recalculate,state,createdAt)
    VALUES('extra',?,?,'lvl',?,0,NULL,0,1,0,'done',?)`).run(G,U,R2,f.now());
  await f.gate.review(G,U);
  assert.equal(f.owned.has(R),false);assert.equal(f.owned.has(R2),true);
  assert.equal(f.dms.length,1);assert.match(JSON.stringify(f.dms[0]),/sem \/mds/);
  assert.equal(f.gate.status(G,U).status,'missing');
  const removed=f.store.db.prepare("SELECT state FROM up_bio_roles WHERE guildId=? AND userId=? AND roleId=?").get(G,U,R);
  assert.equal(removed.state,'removed');
  f.owned.add(R);await f.gate.review(G,U);
  assert.equal(f.owned.has(R),false);assert.equal(f.dms.length,1);
});

test('private profiles and provider failures never remove roles or increment state',async t=>{
  for(const result of [{status:'unknown',reason:'inaccessible_or_private',retryAt:null},{status:'unknown',reason:'provider_error',retryAt:null}]){
    const f=fixture(t,{initial:'missing'});f.setResult(result);
    await f.gate.review(G,U);
    assert.equal(f.owned.has(R),true);assert.equal(f.dms.length,0);assert.equal(f.changes.length,0);
    assert.equal(f.gate.status(G,U).status,'unknown');
    assert.equal(f.gate.explanation(result).includes('privado'),result.reason==='inaccessible_or_private');
  }
});

test('restoring /mds restores a removed role only while the configuration still authorizes it',async t=>{
  const f=fixture(t,{initial:'missing'});await f.gate.review(G,U);assert.equal(f.owned.has(R),false);
  f.setResult({status:'present',reason:null,retryAt:null});
  await f.gate.review(G,U);
  assert.equal(f.owned.has(R),true);
  assert.equal(f.store.db.prepare("SELECT state FROM up_bio_roles WHERE guildId=? AND userId=? AND roleId=?").get(G,U,R).state,'restored');
  f.setResult({status:'missing',reason:null,retryAt:null});await f.gate.review(G,U);
  f.store.db.prepare("DELETE FROM up_levels WHERE guildId=?").run(G);
  f.setResult({status:'present',reason:null,retryAt:null});await f.gate.review(G,U);
  assert.equal(f.owned.has(R),false);
});

test('the gate blocks claims and progression when the bio is missing but allows verified members',async t=>{
  const f=fixture(t,{initial:'missing'});
  await assert.rejects(f.gate.require(f.guild,U),/\/mds/);
  assert.equal(await f.gate.allow(f.guild,U),false);
  f.setResult({status:'present',reason:null,retryAt:null});
  await f.gate.require(f.guild,U,true);
  assert.equal(await f.gate.allow(f.guild,U),true);
  assert.match(f.gate.explanation({status:'unknown',reason:'inaccessible_or_private'}),/privado/);
});

test('checks are cached for the review interval and force rechecks refresh the profile',async t=>{
  const f=fixture(t,{initial:'present'});
  assert.equal(await f.gate.allow(f.guild,U),true);assert.equal(f.checks,1);
  assert.equal(await f.gate.allow(f.guild,U),true);assert.equal(f.checks,1);
  await f.gate.inspect(f.guild,U,true);assert.equal(f.checks,2);
  f.setResult({status:'missing',reason:null,retryAt:null});f.advance(30*60000);
  assert.equal(await f.gate.allow(f.guild,U),false);assert.equal(f.checks,3);
});

test('a failed private warning is retried later without duplicating the role change',async t=>{
  const f=fixture(t,{initial:'missing'});
  let closed=true;f.member.send=async payload=>{if(closed)throw new Error('DM closed');f.dms.push(payload);};
  await f.gate.review(G,U);
  assert.equal(f.owned.has(R),false);assert.equal(f.gate.status(G,U).notified,0);assert.equal(f.changes.length,1);
  closed=false;f.advance(60000);await f.gate.review(G,U);
  assert.equal(f.dms.length,1);assert.equal(f.gate.status(G,U).notified,1);assert.equal(f.changes.length,1);
});

test('disabled verification is explicit and does not impose bio requirements',async t=>{
  const f=fixture(t,{initial:'missing'});const server=new VoiceHoursStore(':memory:'),store=new UpStore(server);
  const gate=createBioGate({engine:{store,locks:new Set()},client:f.client,history:f.history,validateRole,
    provider:{enabled:false,check:async()=>{throw new Error('must not run');}},now:f.now});
  t.after(()=>server.db.close());
  assert.equal(gate.enabled,false);assert.equal(await gate.allow(f.guild,U),true);await gate.require(f.guild,U);
  assert.deepEqual(await gate.inspect(f.guild,U),{status:'disabled'});
});