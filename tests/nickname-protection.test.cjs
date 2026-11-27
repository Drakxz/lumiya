const test=require('node:test'),assert=require('node:assert/strict');
const {EventEmitter}=require('node:events'),{DatabaseSync}=require('node:sqlite');
const {PermissionsBitField,PermissionFlagsBits,MessageFlags}=require('discord.js');
const install=require('../nickname-protection');
const DAY=86400000,USER='100000000000000001',ADMIN='100000000000000002',OWNER='100000000000000009';
const {SALES_MATCH}=require('../nickname-protection/ai');
function fixture(t,nicknameAI={configured:false,detect:async()=>null}){
 const db=new DatabaseSync(':memory:'),client=new EventEmitter(),members=new Map(),commands=new Map(),dms=[],kicks=[],notices=[];let clock=Date.parse('2026-11-13T12:00:00Z');
 const guild={id:'guild',name:'MDS',ownerId:OWNER,roles:{everyone:{id:'guild'}},members:{fetch:async input=>{if(!input)return members;const m=members.get(typeof input==='object'?input.user:input);if(!m)throw Object.assign(new Error('Unknown member'),{code:10007});return m;},fetchMe:async()=>bot}};
 const bot={id:'bot',permissions:new PermissionsBitField([PermissionFlagsBits.KickMembers])};
 const m={id:USER,guild,nickname:'PROIBIDO',user:{id:USER,username:'normal',bot:false},kickable:true,permissions:new PermissionsBitField(),async send(p){dms.push(p);},async kick(reason){kicks.push(reason);members.delete(USER);},async ban(){assert.fail('Nickname protection must never ban');}};
 members.set(USER,m);members.set(ADMIN,{id:ADMIN,guild,user:{id:ADMIN,bot:false},permissions:new PermissionsBitField([PermissionFlagsBits.ManageGuild])});
 client.guilds={cache:new Map([[guild.id,guild]])};const channels=new Map();client.channels={fetch:async id=>channels.get(id)};
  const api=install({client,db,registry:{register:c=>commands.set(c.name,c),preserveMessage(){},deny(){}},now:()=>clock,nicknameAI});
 const enable=()=>api.save({...api.settings(guild.id),enabled:true,terms:['proibido']});
 function i(customId,user=ADMIN,extra={}){const out=[];return {customId,user:{id:user},guild,guildId:guild.id,values:[],out,inGuild:()=>true,async deferReply(){this.deferred=true;},async reply(p){out.push(p);},async editReply(p){out.push(p);},async showModal(p){out.push(p.toJSON());},...extra};}
 t.after(()=>{api.close();db.close();});return {api,client,db,m,guild,bot,members,dms,kicks,notices,channels,commands,enable,i,advance:ms=>{clock+=ms;},now:()=>clock};
}
const content=i=>JSON.stringify(i.out);
test('AI-detected disguises use existing warning schedule and recheck before kick',async t=>{
  const f=fixture(t,{configured:true,provider:'mock',detect:async nick=>nick==='pr0!b1d0'?'proibido':null});
  f.enable();f.m.nickname='pr0!b1d0';
  await f.api.check(f.guild,USER);assert.equal(f.api.state('guild',USER).warnings,1);
  await f.api.check(f.guild,USER);assert.equal(f.dms.length,1);
  f.advance(DAY);await f.api.check(f.guild,USER);
  f.advance(DAY);f.m.send=async p=>{f.dms.push(p);f.m.nickname='normal';};
  await f.api.check(f.guild,USER);assert.equal(f.kicks.length,0);
});
test('AI failures and configuration changes do not warn or kick',async t=>{
  let f;
  f=fixture(t,{configured:true,detect:async()=>{throw new Error('API unavailable');}});
  f.enable();f.m.nickname='pr0ibido';await f.api.check(f.guild,USER);
  assert.equal(f.dms.length,0);assert.equal(f.kicks.length,0);
});
test('AI failures during a scan show a partial result instead of a broken panel and preserve warnings',async t=>{
  const f=fixture(t,{configured:true,provider:'gemini',detect:async nickname=>{
    if(!nickname)return null;
    throw Object.assign(new Error('invalid response'),{kind:'ai_invalid_response',provider:'gemini'});
  }});
  f.enable();
  await f.api.check(f.guild,USER);
  assert.equal(f.api.state('guild',USER).warnings,1);
  f.m.nickname='pr0ibido';
  const i=f.i('np:scan');
  await f.api.handle(i);
  assert.match(content(i),/Verificação parcial/);
  assert.doesNotMatch(content(i),/Verifique as permissões|Não foi possível concluir/);
  assert.equal(f.api.state('guild',USER).warnings,1);
  assert.equal(f.api.state('guild',USER).active,1);
  assert.equal(f.dms.length,1);
  assert.equal(f.kicks.length,0);
});
test('manual verification reports completion, real warning delivery and cooldown instead of only scheduled',async t=>{
  const f=fixture(t);f.enable();
  const first=f.i('np:scan');
  await f.api.handle(first);
  const result=JSON.stringify(first.out.at(-1));
  assert.match(result,/Verificação concluída/);
  assert.match(result,/Pessoas verificadas:\*\* 1/);
  assert.match(result,/Ocorrências identificadas:\*\* 1/);
  assert.match(result,/Avisos reenviados neste lote:\*\* 1/);
  assert.match(result,/somente comparação literal/);
  assert.doesNotMatch(result,/Verificação agendada/);
  const second=f.i('np:scan');
  await f.api.handle(second);
  assert.match(JSON.stringify(second.out.at(-1)),/Avisos reenviados neste lote:\*\* 1/);
  assert.equal(f.dms.length,2);
});
test('manual verification explains when no nickname matched and skips missing nicknames',async t=>{
  const f=fixture(t);f.enable();f.m.nickname='permitido';
  const i=f.i('np:scan');await f.api.handle(i);
  const result=JSON.stringify(i.out.at(-1));
  assert.match(result,/Verificação concluída/);
  assert.match(result,/Ocorrências identificadas:\*\* 0/);
  assert.match(result,/Sem nome disponível:\*\* 1/);
  assert.match(result,/Nenhum nome analisado correspondeu/);
  assert.equal(f.dms.length,0);
});
test('manual verification resends to everyone while automatic maintenance keeps its batch limit',async t=>{
  const f=fixture(t);f.enable();
  const extras=[];
  for(let n=0;n<11;n++){
    const id=String(BigInt(USER)+100n+BigInt(n));
    const member={...f.m,id,user:{id,bot:false},async send(p){f.dms.push(p);}};
    f.members.set(id,member);extras.push(id);
  }
  for(const id of extras.slice(0,10))await f.api.check(f.guild,id);
  assert.equal(f.dms.length,10);
  const i=f.i('np:scan');await f.api.handle(i);
  const result=JSON.stringify(i.out.at(-1));
  assert.match(result,/Ocorrências identificadas:\*\* 12/);
  assert.match(result,/Avisos reenviados neste lote:\*\* 12/);
  assert.equal(f.dms.length,22);
  const before=f.dms.length;
  await f.api.tick('guild');
  assert.equal(f.dms.length-before,2,"periodic tick only delivers to the two members without a prior warning");
});
test('sales setting is opt-in, permission protected and persists independently from custom terms',async t=>{
  const f=fixture(t,{configured:true,provider:'groq',detect:async()=>null});
  assert.equal(f.api.settings('guild').salesEnabled,false);
  const denied=f.i('np:sales',USER);await f.api.handle(denied);
  assert.match(content(denied),/Acesso negado/);
  const on=f.i('np:sales');await f.api.handle(on);
  assert.equal(f.api.settings('guild').salesEnabled,true);
  assert.equal(f.api.settings('guild').enabled,false);
  assert.match(content(on),/Desativar vendas/);
  assert.match(content(on),/Vendas na bio\/perfil/);
  await f.api.handle(f.i('np:toggle'));
  assert.equal(f.api.settings('guild').enabled,true);
  await f.api.handle(f.i('np:sales'));
  assert.equal(f.api.settings('guild').salesEnabled,false);
  assert.equal(f.api.settings('guild').enabled,false);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM nickname_protection_audit WHERE action LIKE ?').get('Detecção de vendas%').n,2);
});
test('sales option cannot be enabled without a configured AI',async t=>{
  const f=fixture(t),i=f.i('np:sales');
  await f.api.handle(i);
  assert.match(content(i),/precisa da IA configurada/);
  assert.equal(f.api.settings('guild').salesEnabled,false);
});
test('sales detections use the normal warning schedule without needing custom terms',async t=>{
  const f=fixture(t,{configured:true,provider:'groq',detect:async(nick,_terms,options)=>
    options.sales&&nick.includes('nitrada')?SALES_MATCH:null});
  f.api.save({...f.api.settings('guild'),enabled:true,salesEnabled:true});
  f.m.nickname='nitrada barata na bio';
  await f.api.check(f.guild,USER);
  await f.api.check(f.guild,USER);
  assert.equal(f.dms.length,1);
  assert.match(JSON.stringify(f.dms[0]),/anúncio de vendas/);
  assert.equal(f.api.state('guild',USER).warnings,1);
  f.advance(DAY);await f.api.check(f.guild,USER);
  assert.equal(f.api.state('guild',USER).warnings,2);
  // Desativar somente vendas invalida os resultados sem apagar os avisos.
  f.api.save({...f.api.settings('guild'),salesEnabled:false});
  f.advance(DAY);await f.api.check(f.guild,USER);
  assert.equal(f.kicks.length,0);
  assert.equal(f.api.state('guild',USER).warnings,2);
  assert.equal(f.api.state('guild',USER).active,0);
});
test('turning off sales while the AI is running prevents stale warnings',async t=>{
  let f;
  f=fixture(t,{configured:true,provider:'groq',detect:async()=>{
    f.api.save({...f.api.settings('guild'),salesEnabled:false});
    return SALES_MATCH;
  }});
  f.api.save({...f.api.settings('guild'),enabled:true,salesEnabled:true});
  f.m.nickname='nitrada na bio';
  await f.api.check(f.guild,USER);
  assert.equal(f.dms.length,0);
  assert.equal(f.kicks.length,0);
});
test('clearing custom terms keeps sales protection enabled when sales is selected',async t=>{
  const f=fixture(t,{configured:true,provider:'groq',detect:async()=>null});
  f.api.save({...f.api.settings('guild'),enabled:true,salesEnabled:true,terms:['proibido']});
  await f.api.handle(f.i('np:save-terms',ADMIN,{fields:{getTextInputValue:()=>''}}));
  assert.equal(f.api.settings('guild').enabled,true);
  assert.equal(f.api.settings('guild').salesEnabled,true);
  assert.deepEqual(f.api.settings('guild').terms,[]);
});
test('expired Discord panel interactions produce a specific recovery hint',async t=>{
  const f=fixture(t);
  const i=f.i('np:open',ADMIN,{async deferReply(){
    throw Object.assign(new Error('Unknown interaction'),{code:10062,status:404});
  }});
  await f.api.handle(i);
  assert.match(content(i),/interação expirou|Abra o painel novamente/);
});
test('protection is opt-in and ignores account names when there is no nickname',async t=>{
 const f=fixture(t);await f.api.check(f.guild,USER);assert.equal(f.dms.length,0);f.enable();f.m.nickname=null;f.m.user.username='proibido';await f.api.check(f.guild,USER);assert.equal(f.dms.length,0);
 assert.equal(f.api.state('guild',USER),undefined);
 assert.equal(f.api.match('PrOÍbIdO123',f.api.settings('guild')),'proibido');assert.equal(f.api.match('p.r.o.i.b.i.d.o',f.api.settings('guild')),null);
});
test('a clean nickname ignores prohibited account names',async t=>{
 const f=fixture(t);f.enable();f.m.nickname='limpo';f.m.user.globalName='PROÍBIDO';
 await f.api.check(f.guild,USER);
 assert.equal(f.dms.length,0);
 f.advance(DAY);f.m.user.globalName='limpo';f.m.user.username='proibido';
 await f.api.check(f.guild,USER);
 assert.equal(f.dms.length,0);
 assert.equal(f.api.state('guild',USER),undefined);
});
test('sales are checked only in nickname and count once per person',async t=>{
 const seen=[];
 const f=fixture(t,{configured:true,provider:'groq',detect:async(value,_terms,options)=>{
   seen.push(value);return options.sales&&value==='nitrada na bio'?SALES_MATCH:null;
 }});
 f.api.save({...f.api.settings('guild'),enabled:true,salesEnabled:true});
 f.m.nickname='nome limpo';f.m.user.globalName='nitrada na bio';
 await f.api.check(f.guild,USER);
 assert.equal(f.dms.length,0);
 assert.ok(!seen.includes('nitrada na bio'));
 f.m.nickname='nitrada na bio';f.m.user.username='nitrada na bio';
 await f.api.check(f.guild,USER);
 assert.equal(f.dms.length,1);
 assert.match(JSON.stringify(f.dms[0]),/apelido do servidor/);
});
test('names are never concatenated to fabricate a match across two fields',async t=>{
 const seen=[];
 const f=fixture(t,{configured:true,provider:'groq',detect:async value=>{seen.push(value);return null;}});
 f.api.save({...f.api.settings('guild'),enabled:true,terms:['abcdef']});
 f.m.nickname='def';f.m.user.username='abc';f.m.user.globalName='xyz';
 await f.api.check(f.guild,USER);
 assert.deepEqual(seen,['def']);
 assert.equal(f.dms.length,0);
});
test('account name changes do not trigger rechecks',async t=>{
 const f=fixture(t);f.enable();f.m.nickname='limpo';f.m.user.globalName='proibido';
 assert.equal(f.client.listeners('userUpdate').length,0);
 const handler=f.client.listeners('guildMemberUpdate')[0];
 await handler({nickname:'limpo',user:{username:'normal'}},f.m);
 assert.equal(f.dms.length,0);
});
test('changing the nickname while AI is running invalidates a stale violation',async t=>{
 let f;
 f=fixture(t,{configured:true,provider:'groq',detect:async value=>{
   if(value==='nitrada na bio'){f.m.nickname='nome limpo';return SALES_MATCH;}
   return null;
 }});
 f.api.save({...f.api.settings('guild'),enabled:true,salesEnabled:true});
 f.m.nickname='nitrada na bio';
 await f.api.check(f.guild,USER);
 assert.equal(f.dms.length,0);
 assert.equal(f.kicks.length,0);
});
test('manual scan skips members without a server nickname',async t=>{
 const f=fixture(t,{configured:true,provider:'groq',detect:async(value,_terms,options)=>
   options.sales&&value==='nitrada na bio'?SALES_MATCH:null});
 f.api.save({...f.api.settings('guild'),enabled:true,salesEnabled:true});
 f.m.nickname=null;f.m.user.globalName='nitrada na bio';
 const i=f.i('np:scan');await f.api.handle(i);
 assert.match(JSON.stringify(i.out.at(-1)),/Pessoas verificadas:\*\* 0/);
 assert.match(JSON.stringify(i.out.at(-1)),/Ocorrências identificadas:\*\* 0/);
 assert.equal(f.dms.length,0);
});
test('account names never reach AI, including the displayName fallback',async t=>{
 const seen=[];
 const f=fixture(t,{configured:true,detect:async value=>{seen.push(value);return null;}});
 f.enable();f.m.user.username='proibido';f.m.user.globalName='proibido';f.m.displayName='proibido';
 for(const nickname of [null,undefined,'','   ']){
  f.m.nickname=nickname;
  await f.api.check(f.guild,USER);
 }
 assert.deepEqual(seen,[]);
 assert.equal(f.dms.length,0);
});
test('queued old violation cannot warn or kick because of an account name',async t=>{
 const f=fixture(t);f.enable();
 await f.api.check(f.guild,USER);
 f.db.prepare('UPDATE nickname_protection_users SET warnings=3,nextCheckAt=0').run();
 f.m.nickname=null;f.m.user.username='proibido';
 await f.api.tick();
 assert.equal(f.dms.length,1);
 assert.equal(f.kicks.length,0);
 assert.equal(f.api.state('guild',USER).active,0);
 assert.equal(f.api.state('guild',USER).warnings,3);
});
test('first warning is delivered immediately, repeats cannot accelerate 24 hours, third kicks instead of banning',async t=>{
 const f=fixture(t);f.enable();await Promise.all([f.api.check(f.guild,USER),f.api.check(f.guild,USER)]);assert.equal(f.api.state('guild',USER).warnings,1);
 f.advance(DAY-1);f.m.nickname='outro PROIBIDO';await f.api.check(f.guild,USER);assert.equal(f.dms.length,1);
 f.advance(1);await f.api.check(f.guild,USER);assert.equal(f.api.state('guild',USER).warnings,2);assert.equal(f.kicks.length,0);
 f.advance(DAY);await f.api.check(f.guild,USER);assert.equal(f.dms.length,3);assert.equal(f.kicks.length,1);assert.match(f.kicks[0],/três avisos/);assert.ok(f.api.state('guild',USER).kickedAt);assert.equal(f.api.state('guild',USER).bannedAt,null);
});
test('correcting stops warnings while accumulated counts survive a later prohibited nickname',async t=>{
 const f=fixture(t);f.enable();await f.api.check(f.guild,USER);f.m.nickname='corrigido';f.advance(DAY);await f.api.check(f.guild,USER);assert.equal(f.api.state('guild',USER).active,0);assert.equal(f.api.state('guild',USER).warnings,1);
 f.m.nickname='proibido de novo';await f.api.check(f.guild,USER);assert.equal(f.api.state('guild',USER).warnings,2);
});
test('failed DMs never increment warnings or kick silently without an accessible fallback channel',async t=>{
 const f=fixture(t);f.enable();f.m.send=async()=>{throw new Error('DM closed');};
 for(let n=0;n<4;n++){await f.api.check(f.guild,USER);f.advance(DAY);}
 assert.equal(f.api.state('guild',USER).warnings,0);assert.equal(f.kicks.length,0);
});
test('configured fallback delivers only when the user can view the channel and mentions only the recipient',async t=>{
 const f=fixture(t);f.enable();f.m.send=async()=>{throw new Error('DM closed');};let visible=false;
 f.channels.set('warning',{guildId:'guild',permissionsFor:()=>new PermissionsBitField(visible?[PermissionFlagsBits.ViewChannel]:[]),send:async p=>{f.notices.push(p);return {id:'notice'};}});
 f.api.save({...f.api.settings('guild'),warningChannelId:'warning'});await f.api.check(f.guild,USER);assert.equal(f.api.state('guild',USER).warnings,0);
 visible=true;f.advance(DAY);await f.api.check(f.guild,USER);assert.equal(f.api.state('guild',USER).warnings,1);assert.deepEqual(f.notices[0].allowedMentions,{parse:[],users:[USER]});
});
test('hierarchy failures are recorded and retried after 24 hours without issuing a fourth warning',async t=>{
 const f=fixture(t);f.enable();f.m.kickable=false;for(let n=0;n<3;n++){await f.api.check(f.guild,USER);if(n<2)f.advance(DAY);}
 assert.equal(f.api.state('guild',USER).warnings,3);assert.equal(f.kicks.length,0);await f.api.check(f.guild,USER);assert.equal(f.dms.length,3);
 f.m.kickable=true;f.advance(DAY);await f.api.check(f.guild,USER);assert.equal(f.kicks.length,1);assert.equal(f.dms.length,3);
});
test('nickname and enabled state are rechecked before a third-warning kick',async t=>{
 const f=fixture(t);f.enable();await f.api.check(f.guild,USER);f.advance(DAY);await f.api.check(f.guild,USER);f.advance(DAY);
 f.m.send=async p=>{f.dms.push(p);f.m.nickname='corrigido';};await f.api.check(f.guild,USER);assert.equal(f.api.state('guild',USER).warnings,3);assert.equal(f.kicks.length,0);
});
test('restart preserves warnings and due times and never catches up multiple warnings at once',async t=>{
 const f=fixture(t);f.enable();await f.api.check(f.guild,USER);f.advance(10*DAY);
 const client=new EventEmitter();client.guilds=f.client.guilds;client.channels=f.client.channels;
 const next=install({client,db:f.db,registry:{register(){},preserveMessage(){}},now:f.now});t.after(()=>next.close());
 await next.check(f.guild,USER);await next.check(f.guild,USER);assert.equal(next.state('guild',USER).warnings,2);assert.equal(f.kicks.length,0);
});
test('periodic checks refresh nicknames and configuration disable stops all warnings',async t=>{
 const f=fixture(t);f.enable();await f.api.scan(f.guild);assert.equal(f.dms.length,1);
 f.advance(DAY);f.m.nickname='limpo';await f.api.tick();assert.equal(f.dms.length,1);assert.equal(f.api.state('guild',USER).active,0);
 f.api.save({...f.api.settings('guild'),enabled:false});f.m.nickname='proibido';await f.api.check(f.guild,USER);assert.equal(f.dms.length,1);
});
test('configuration and resets require fresh native ManageGuild and reject forged target IDs',async t=>{
 const f=fixture(t);f.enable();await f.api.check(f.guild,USER);
 for(const route of ['np:open','np:toggle','np:save-terms',`np:reset:${USER}`]){const i=f.i(route,USER);await f.api.handle(i);assert.match(content(i),/Acesso negado/);}
 const invalid=f.i('np:reset:invalid');await f.api.handle(invalid);assert.match(content(invalid),/Acesso negado/);
 const reset=f.i(`np:reset:${USER}`);await f.api.handle(reset);assert.equal(f.api.state('guild',USER).warnings,0);assert.ok(f.api.state('guild',USER).nextCheckAt>=f.now()+DAY);
 f.members.get(ADMIN).permissions=new PermissionsBitField();const stale=f.i('np:toggle');await f.api.handle(stale);assert.match(content(stale),/Acesso negado/);
});
test('owner and administrators receive warnings; only kick remains protected by hierarchy',async t=>{
 const f=fixture(t);f.enable();
 const owner={...f.m,id:OWNER};f.members.set(OWNER,owner);
 const admin={...f.m,id:ADMIN,nickname:'PROIBIDO',user:{id:ADMIN,bot:false},permissions:new PermissionsBitField([PermissionFlagsBits.ManageGuild]),async send(p){f.dms.push(p);}};
 f.members.set(ADMIN,admin);
 await f.api.check(f.guild,OWNER);await f.api.check(f.guild,ADMIN);
 assert.equal(f.dms.length,2);
 assert.equal(f.api.state('guild',OWNER).warnings,1);
 assert.equal(f.api.state('guild',ADMIN).warnings,1);
 f.advance(DAY);f.advance(DAY);
 await f.api.check(f.guild,OWNER);await f.api.check(f.guild,ADMIN);
 await f.api.check(f.guild,OWNER);await f.api.check(f.guild,ADMIN);
 f.advance(DAY);await f.api.check(f.guild,OWNER);await f.api.check(f.guild,ADMIN);
 for(const id of [OWNER,ADMIN])assert.equal(f.api.state('guild',id).warnings,3);
 assert.equal(f.api.state('guild',OWNER).kickedAt,null,"the owner can be warned but not kicked by the bot");
});
test('bots are not checked because they have no human account to warn',async t=>{
 const f=fixture(t);f.enable();f.members.set('bot',{...f.m,id:'bot',user:{id:'bot',bot:true}});
 await f.api.check(f.guild,'bot');
 assert.equal(f.dms.length,0);assert.equal(f.api.state('guild','bot'),undefined);
});
test('manual verification resends the warning before 24h without incrementing or resetting the count',async t=>{
 const f=fixture(t);f.enable();
 await f.api.check(f.guild,USER);
 const before=f.api.state('guild',USER);
 const i=f.i('np:scan');await f.api.handle(i);
 const result=JSON.stringify(i.out.at(-1));
 assert.match(result,/Avisos reenviados neste lote:\*\* 1/);
 assert.equal(f.dms.length,2);
 assert.match(JSON.stringify(f.dms.at(-1)),/Aviso reenviado/);
 assert.match(JSON.stringify(f.dms.at(-1)),/Não aumenta a contagem/);
 const after=f.api.state('guild',USER);
 assert.equal(after.warnings,before.warnings);
 assert.equal(after.lastWarningAt,before.lastWarningAt);
 assert.equal(after.nextCheckAt,before.nextCheckAt);
 assert.equal(f.kicks.length,0);
});
test('automatic maintenance never resends before the cooldown',async t=>{
 const f=fixture(t);f.enable();
 await f.api.check(f.guild,USER);
 assert.equal(f.dms.length,1);
 await f.api.tick('guild');await f.api.maintain();
 assert.equal(f.dms.length,1);
});
test('manual resend does not kick members with three warnings',async t=>{
 const f=fixture(t);f.enable();f.m.kickable=false;
 for(let n=0;n<3;n++){await f.api.check(f.guild,USER);f.advance(DAY);}
 assert.equal(f.kicks.length,0);
 const i=f.i('np:scan');await f.api.handle(i);
 assert.match(JSON.stringify(i.out.at(-1)),/Avisos reenviados neste lote:\*\* 1/);
  assert.equal(f.kicks.length,0);
  assert.equal(f.api.state('guild',USER).kickedAt,null);
});
test('admin terms modal saves literals, ignores empty lines and private panel retains unique IDs',async t=>{
 const f=fixture(t);const save=f.i('np:save-terms',ADMIN,{fields:{getTextInputValue:()=> 'PROÍBIDO\n\nproibido\n[abc]'}});await f.api.handle(save);
 assert.deepEqual(f.api.settings('guild').terms,['proibido','[abc]']);assert.equal(f.api.settings('guild').enabled,false);
 const i=f.i('np:open');await f.api.handle(i);assert.ok(i.out[0].flags&MessageFlags.Ephemeral);
 const ids=[];function walk(c){if(c.custom_id)ids.push(c.custom_id);for(const child of c.components||[])walk(child);}walk(i.out[0].components[0].toJSON());assert.equal(ids.length,new Set(ids).size);
});
test('delivery latency cannot shorten the next 24-hour warning interval',async t=>{
 const f=fixture(t);f.enable();f.m.send=async p=>{f.dms.push(p);f.advance(60000);};await f.api.check(f.guild,USER);
 const first=f.api.state('guild',USER);assert.equal(first.nextCheckAt-first.lastWarningAt,DAY);
 f.advance(DAY-1);await f.api.check(f.guild,USER);assert.equal(f.dms.length,1);f.advance(1);await f.api.check(f.guild,USER);assert.equal(f.dms.length,2);
});
test('disabled protection during delivery prevents third-warning kick and enabling requires KickMembers',async t=>{
 const f=fixture(t);f.enable();await f.api.check(f.guild,USER);f.advance(DAY);await f.api.check(f.guild,USER);f.advance(DAY);
 f.m.send=async p=>{f.dms.push(p);f.api.save({...f.api.settings('guild'),enabled:false});};await f.api.check(f.guild,USER);assert.equal(f.api.state('guild',USER).warnings,3);assert.equal(f.kicks.length,0);
 f.bot.permissions=new PermissionsBitField();const toggle=f.i('np:toggle');await f.api.handle(toggle);assert.match(content(toggle),/Permissão ausente/);assert.equal(f.api.settings('guild').enabled,false);
});
test('log configuration rejects public channels while warning channel is explicitly selectable',async t=>{
 const f=fixture(t);f.channels.set('public',{id:'public',guildId:'guild',type:0,permissionsFor:who=>new PermissionsBitField(who.id==='guild'?[PermissionFlagsBits.ViewChannel]:[PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages])});
 const logs=f.i('np:logs',ADMIN,{values:['public']});await f.api.handle(logs);assert.match(content(logs),/canal privado/);assert.equal(f.api.settings('guild').logChannelId,null);
 const warning=f.i('np:warning-channel',ADMIN,{values:['public']});await f.api.handle(warning);assert.equal(f.api.settings('guild').warningChannelId,'public');
});
test('legacy ban fields survive migration and are never overwritten by a new kick',async t=>{
 const f=fixture(t);f.enable();
 f.db.prepare('INSERT INTO nickname_protection_users(guildId,userId,warnings,bannedAt,lastBanAttemptAt) VALUES(?,?,?,?,?)').run('guild',USER,3,123,456);
 await f.api.check(f.guild,USER);const s=f.api.state('guild',USER);assert.equal(f.kicks.length,1);assert.equal(s.bannedAt,123);assert.equal(s.lastBanAttemptAt,456);assert.ok(s.kickedAt);
});
test('old schema receives independent kick columns without discarding accumulated warnings',t=>{
 const db=new DatabaseSync(':memory:'),client=new EventEmitter();
 db.exec('CREATE TABLE nickname_protection_users(guildId TEXT NOT NULL,userId TEXT NOT NULL,warnings INTEGER NOT NULL DEFAULT 0,lastWarningAt INTEGER,nextCheckAt INTEGER NOT NULL DEFAULT 0,active INTEGER NOT NULL DEFAULT 0,bannedAt INTEGER,lastBanAttemptAt INTEGER,PRIMARY KEY(guildId,userId))');
 db.prepare('INSERT INTO nickname_protection_users(guildId,userId,warnings,bannedAt) VALUES(?,?,?,?)').run('guild',USER,2,123);
 const api=install({client,db,registry:{register(){},preserveMessage(){}}});t.after(()=>{api.close();db.close();});
 const s=api.state('guild',USER);assert.equal(s.warnings,2);assert.equal(s.bannedAt,123);assert.equal(s.kickedAt,null);assert.equal(s.lastKickAttemptAt,null);
});
test('returning after kick preserves warnings and existing cooldown without issuing a fourth warning',async t=>{
 const f=fixture(t);f.enable();for(let n=0;n<3;n++){await f.api.check(f.guild,USER);if(n<2)f.advance(DAY);}
 assert.equal(f.kicks.length,1);f.members.set(USER,f.m);await f.api.check(f.guild,USER);assert.equal(f.api.state('guild',USER).warnings,3);assert.equal(f.kicks.length,1);
 f.advance(DAY);await f.api.check(f.guild,USER);assert.equal(f.kicks.length,2);assert.equal(f.dms.length,3);
});
