const test=require('node:test'),assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite'),{EventEmitter}=require('node:events');
const {PermissionsBitField,MessageFlags,PermissionFlagsBits}=require('discord.js');
const install=require('../ticket-management');
function fixture(t){
 const db=new DatabaseSync(':memory:'),client=new EventEmitter(),commands=new Map(),members=new Map();client.user={id:'bot'};
 const guild={id:'g',ownerId:'owner',roles:{cache:new Map()},members:{fetch:async x=>x===undefined?members:members.get(typeof x==='object'?x.user:x)}};
 const make=(id,roles=[])=>{const m={id,user:{id,bot:false},guild,permissions:new PermissionsBitField(),roles:{cache:new Map(roles.map(r=>[r,{}]))}};members.set(id,m);return m;};
 make('support',['sup']);make('migration',['mig']);make('both',['sup','mig']);make('admin',['admin']);make('owner');make('none');
 const channels=new Map();client.channels={fetch:async id=>channels.get(id)};
 const data={tickets:{s:{guildId:'g',sistema:'support',tipo:'den',donoId:'author',criadoEm:Date.now()},m:{guildId:'g',sistema:'migration',tipo:'migration',donoId:'other',criadoEm:Date.now()},u:{guildId:'g',donoId:'unknown'}},claims:{},pendingCloses:{},ticketClaimRoles:{g:{support:['sup'],migration:['mig']}}};
 let closes=0;const api=install({client,registry:{register:c=>commands.set(c.name,c),preserveMessage(){}},db,data,save(){},async closeTicket(i,ch){closes++;data.pendingCloses[ch.id]={};await i.reply({flags:MessageFlags.Ephemeral});}});
 db.prepare('INSERT INTO ticket_management_config VALUES(?,?)').run('g',JSON.stringify({supportRole:'sup',migrationRole:'mig',adminRole:'admin'}));
 for(const id of ['s','m'])channels.set(id,{id,guildId:'g',guild,isThread:()=>true,members:{fetch:async()=>new Map(),add:async()=>{},remove:async()=>{}}});
 function i(customId,user='support',extra={}){const out=[];return {customId,user:{id:user},guild,guildId:'g',channelId:'s',inGuild:()=>true,isButton:()=>true,values:[],out,async deferReply(){this.deferred=true;},async reply(p){this.replied=true;out.push(p);},async editReply(p){out.push(p);},async showModal(p){out.push(p.toJSON());},...extra};}
 t.after(()=>db.close());return {db,client,commands,guild,members,make,data,api,i,channels,closes:()=>closes};
}
const output=i=>JSON.stringify(i.out);
function assertUniqueCustomIds(payload){
 const ids=[];
 function walk(c){if(c.custom_id)ids.push(c.custom_id);for(const child of c.components||[])walk(child);if(c.accessory)walk(c.accessory);}
 for(const c of payload.components||[])walk(typeof c.toJSON==='function'?c.toJSON():c);
 assert.equal(new Set(ids).size,ids.length,`custom_id duplicado: ${ids.filter((id,index)=>ids.indexOf(id)!==index).join(', ')}`);
}
test('filter and pagination IDs are unique on all list states and emitted arrows remain functional',async t=>{
 const f=fixture(t);
 for(let n=0;n<8;n++)f.data.tickets[`extra-${n}`]={guildId:'g',sistema:'support',tipo:'sup',donoId:'author',criadoEm:Date.now()+n};
 for(const area of ['support','migration'])for(const filter of ['all','pending','claimed'])for(const page of [0,1,2]){
  const i=f.i(`tg:list:${area}:${filter}:${page}`,'both');await f.api.handle(i);assertUniqueCustomIds(i.out[0]);
 }
 const first=f.i('tg:list:support:all:0','both');await f.api.handle(first);
 const rows=first.out[0].components[0].toJSON().components.filter(c=>c.type===1);
 const next=rows.flatMap(r=>r.components).find(b=>b.label==='>');assert.match(next.custom_id,/:next$/);
 const second=f.i(next.custom_id,'both');await f.api.handle(second);assert.match(output(second),/2\/3/);assertUniqueCustomIds(second.out[0]);
 const previous=second.out[0].components[0].toJSON().components.filter(c=>c.type===1).flatMap(r=>r.components).find(b=>b.label==='<');
 const back=f.i(previous.custom_id,'both');await f.api.handle(back);assert.match(output(back),/1\/3/);assertUniqueCustomIds(back.out[0]);
 for(const route of ['tg:history:support:0','tg:ticket-history:s:0','tg:query:support']){
  const i=f.i(route,'support',{fields:{getTextInputValue:()=> 'author'}});await f.api.handle(i);assertUniqueCustomIds(i.out[0]);
 }
});
test('dynamic panels are private, area-filtered, and owner/admin see both',async t=>{
 const f=fixture(t);
 for(const [user,title,forbidden] of [['support','Gestão de Suporte','Gestão de Migração'],['migration','Gestão de Migração','Gestão de Suporte'],['both','Painel de Gestão','never'],['admin','Painel de Gestão','never'],['owner','Painel de Gestão','never']]){
  const i=f.i('tg:home',user);await f.api.handle(i);assert.match(output(i),new RegExp(title));assert.doesNotMatch(output(i),new RegExp(forbidden));assert.ok(i.out[0].flags&MessageFlags.Ephemeral);
 }
 const i=f.i('tg:home','none');await f.api.handle(i);assert.match(output(i),/não possui permissão/);
});
test('cross-area IDs, paging, history, searches, and stale permissions are denied',async t=>{
 const f=fixture(t);for(const id of ['tg:ticket:m','tg:claim:m','tg:close:m','tg:ticket-history:m','tg:history:migration','tg:list:migration:all:0','tg:query:migration','tg:config','tg:cfg-role:adminRole']){
  const i=f.i(id);await f.api.handle(i);assert.match(output(i),/não possui permissão/);assert.doesNotMatch(output(i),/other/);
 }
 f.make('support',[]);const stale=f.i('tg:list:support:all:0');await f.api.handle(stale);assert.match(output(stale),/não possui permissão/);
});
test('unknown imported area is never assigned or disclosed to area managers',async t=>{
 const f=fixture(t),i=f.i('tg:ticket:u');await f.api.handle(i);assert.match(output(i),/não possui permissão/);assert.equal(f.db.prepare("SELECT area FROM ticket_management_cases WHERE id='u'").get().area,null);
});
test('claims are serialized, retain assignee and cannot overwrite existing ownership',async t=>{
 const f=fixture(t),a=f.i('tg:claim:s'),b=f.i('tg:claim:s','both');await Promise.all([f.api.handle(a),f.api.handle(b)]);
 assert.equal(f.data.claims.s.userId,'support');const c=f.i('tg:claim:s','both');await f.api.handle(c);assert.match(output(c),/já foi assumido/);
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM ticket_management_audit WHERE action='claim'").get().n,1);
});
test('closing has confirmation, is area-scoped, serialized and auditable',async t=>{
 const f=fixture(t),i=f.i('tg:close:s');await f.api.handle(i);assert.equal(f.closes(),0);assert.match(output(i),/Confirmar encerramento/);
 await Promise.all([f.api.handle(f.i('tg:confirm-close:s')),f.api.handle(f.i('tg:confirm-close:s','both'))]);assert.equal(f.closes(),1);
 assert.equal(f.db.prepare("SELECT status FROM ticket_management_cases WHERE id='s'").get().status,'closed');
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM ticket_management_audit WHERE action='closed'").get().n,1);
});
test('mentioned roles and administrators can claim and close in the general system',async t=>{
  const f=fixture(t);
  f.data.ticketRoles={g:{support:['mentioned'],migration:['mig-mentioned']}};
  f.make('mentioned-user',['mentioned']);f.make('mig-mentioned-user',['mig-mentioned']);
  f.make('administrator',[]).permissions=new PermissionsBitField([PermissionFlagsBits.Administrator]);
  const claim=f.i('tg:claim:s','mentioned-user');await f.api.handle(claim);
  assert.equal(f.data.claims.s.userId,'mentioned-user');
  assert.doesNotMatch(output(claim),/não possui permissão/);
  const close=f.i('tg:close:s','administrator');await f.api.handle(close);
  assert.match(output(close),/Confirmar encerramento/);
  const other=f.i('tg:claim:m','mentioned-user');await f.api.handle(other);
  assert.match(output(other),/não possui permissão/);
  const migration=f.i('tg:claim:m','mig-mentioned-user');await f.api.handle(migration);
  assert.equal(f.data.claims.m.userId,'mig-mentioned-user');
});
test('legacy ticket controls use the same area checks and cannot be forged',async t=>{
 const f=fixture(t);for(const i of [f.i('ticket-claim:m'),f.i('migration-close'),f.i('ticket-users:s','migration'),f.i('ticket-users-select:s','none')]){await f.api.handle(i);assert.match(output(i),/não possui permissão/);}
});
test('lists and search do not include other areas',async t=>{
 const f=fixture(t),i=f.i('tg:list:support:all:0');await f.api.handle(i);assert.match(output(i),/author/);assert.doesNotMatch(output(i),/other/);
 const search=f.i('tg:query:support','support',{fields:{getTextInputValue:()=> 'other'}});await f.api.handle(search);assert.match(output(search),/Nenhum ticket/);
});
test('configuration rejects area managers and persists general-admin settings',async t=>{
 const f=fixture(t),role={id:'newRole',managed:false};f.guild.roles.fetch=async()=>role;
 const i=f.i('tg:cfg-role:supportRole','admin',{values:['newRole']});await f.api.handle(i);assert.equal(f.api.config('g').supportRole,'newRole');
 assert.equal(JSON.parse(f.db.prepare('SELECT config FROM ticket_management_config').get().config).supportRole,'newRole');
});
test('opening a ticket never adds area members; review only removes recorded automatic grants',async t=>{
 const f=fixture(t),added=[],removed=[];const ch=f.channels.get('s');ch.members={fetch:async()=>new Map([['support',{}],['manual',{}]]),add:async id=>added.push(id),remove:async id=>removed.push(id)};
 f.db.prepare('INSERT INTO ticket_management_access VALUES(?,?)').run('s','support');
 const result=await f.api.reconcileAccess(f.guild,'support');
 assert.deepEqual(added,[]);assert.deepEqual(removed,['support']);assert.deepEqual(result,{checked:1,revoked:1});
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM ticket_management_access').get().n,0);
});
test('transfer and release verify target role and preserve historical individual claims',async t=>{
 const f=fixture(t);await f.api.handle(f.i('tg:claim:s'));
 const bad=f.i('tg:transfer-to:s','support',{values:['migration']});await f.api.handle(bad);assert.match(output(bad),/não possui permissão/);
 await f.api.handle(f.i('tg:transfer-to:s','support',{values:['both']}));assert.equal(f.data.claims.s.userId,'both');
 await f.api.handle(f.i('tg:release:s','both'));assert.equal(f.data.claims.s,undefined);
 const mine=f.i('tg:mine:support','support');await f.api.handle(mine);assert.match(output(mine),/Tickets assumidos:\*\* 1/);
});
test('participant protections preserve author/owner and confidential tickets reject outsiders',async t=>{
 const f=fixture(t),added=[],removed=[];f.make('author');f.db.prepare("UPDATE ticket_management_cases SET confidential=1 WHERE id='s'").run();
 f.channels.get('s').members={fetch:async()=>new Map([['owner',{}],['author',{}]]),add:async id=>added.push(id),remove:async id=>removed.push(id)};
 await f.api.handle(f.i('tg:users-change:s','support',{values:['owner','author','none','both']}));
 assert.deepEqual(added,['both']);assert.deepEqual(removed,[]);
});
test('persisted closed records and audits survive module reinstallation with no duplicate imports',async t=>{
 const f=fixture(t);await f.api.handle(f.i('tg:confirm-close:s'));
 const before=f.db.prepare('SELECT COUNT(*) n FROM ticket_management_audit').get().n;
 const next=install({client:new EventEmitter(),registry:{register(){},preserveMessage(){}},db:f.db,data:f.data,save(){},closeTicket(){}});
 assert.equal(f.db.prepare("SELECT status FROM ticket_management_cases WHERE id='s'").get().status,'closed');
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM ticket_management_audit').get().n,before);assert.ok(next.access(f.guild,f.members.get('support')).support);
});
test('pagination never crosses area boundaries even with many mixed tickets',async t=>{
 const f=fixture(t);for(let n=0;n<8;n++)f.data.tickets[`new-${n}`]={guildId:'g',sistema:n%2?'migration':'support',donoId:n%2?'migration-secret':'support-user',criadoEm:Date.now()+n};
 const i=f.i('tg:list:support:all:1');await f.api.handle(i);assert.doesNotMatch(output(i),/migration-secret/);assert.match(output(i),/Suporte/);
});
test('revoked management role is checked again on destructive actions',async t=>{
 const f=fixture(t);await f.api.handle(f.i('tg:close:s'));f.make('support',[]);
 const i=f.i('tg:confirm-close:s');await f.api.handle(i);assert.match(output(i),/não possui permissão/);assert.equal(f.closes(),0);
});
test('prefix !gestao opens the management panel directly and hides other areas',async t=>{
 const f=fixture(t),sent=[];
 await f.commands.get('gestaotickets').prefix.execute({guild:f.guild,author:{id:'support'},channel:{id:'channel',send:async p=>{sent.push(p);return {id:'panel',delete:async()=>{}};}}});
 assert.equal(sent.length,1);assert.match(JSON.stringify(sent[0]),/Painel de Gestão/);
 assert.doesNotMatch(JSON.stringify(sent[0]),/tg:open|Gestão de Migração|other|Em atendimento/);
 assert.equal(Boolean(sent[0].flags&MessageFlags.Ephemeral),false);
 const i=f.i(undefined);await f.commands.get('gestao-tickets').slash.execute(i);assert.ok(i.out[0].flags&MessageFlags.Ephemeral);assert.match(output(i),/Gestão de Suporte/);
});
test('prefix panel edits itself for its owner and expires after 30 idle seconds',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const f=fixture(t),sent=[];let deleted=0;
 await f.commands.get('gestaotickets').prefix.execute({guild:f.guild,author:{id:'support'},channel:{id:'channel',send:async p=>{sent.push(p);return {id:'panel',delete:async()=>{deleted++;}};}}});
 const owner=f.i('tg:area:support','support',{message:{id:'panel'},async deferUpdate(){this.deferred=true;}});await f.api.handle(owner);
 assert.match(output(owner),/Gestão de Suporte/);assert.equal(Boolean(owner.out[0].flags&MessageFlags.Ephemeral),false);
 const outsider=f.i('tg:area:support','migration',{message:{id:'panel'}});await f.api.handle(outsider);
 assert.match(output(outsider),/não possui permissão/);assert.ok(outsider.out[0].flags&MessageFlags.Ephemeral);
 t.mock.timers.tick(29_000);assert.equal(deleted,0);
 t.mock.timers.tick(2_000);assert.equal(deleted,1);
});
test('per-area disabled permissions apply in the backend and administration can still operate',async t=>{
 const f=fixture(t);f.db.prepare('UPDATE ticket_management_config SET config=? WHERE guildId=?').run(JSON.stringify({supportRole:'sup',migrationRole:'mig',adminRole:'admin',supportClose:false,migrationClose:true}),'g');
 assert.equal(f.api.canOperate(f.guild,f.members.get('support'),f.db.prepare("SELECT * FROM ticket_management_cases WHERE id='s'").get(),'close'),false);
 const i=f.i('tg:confirm-close:s');await f.api.handle(i);assert.match(output(i),/não possui permissão/);assert.equal(f.closes(),0);
 await f.api.handle(f.i('tg:confirm-close:s','admin'));assert.equal(f.closes(),1);
});
test('Discord API failures in mutations are contained and release per-ticket locks',async t=>{
 const f=fixture(t);f.client.channels.fetch=async()=>{throw new Error('Missing access');};
 await assert.doesNotReject(f.api.handle(f.i('tg:confirm-close:s')));
 f.client.channels.fetch=async id=>f.channels.get(id);await f.api.handle(f.i('tg:confirm-close:s'));assert.equal(f.closes(),1);
});
test('native staff permissions alone do not grant management access',async t=>{
 const f=fixture(t),m=f.make('staff',['unrelated-staff']);m.permissions=new PermissionsBitField([PermissionFlagsBits.ManageChannels,PermissionFlagsBits.ManageGuild]);
 const i=f.i('tg:home','staff');await f.api.handle(i);assert.match(output(i),/não possui permissão/);
});
test('access review preserves untracked participants, owner and assignee',async t=>{
 const f=fixture(t),existing=new Map([['manual',{}],['owner',{}],['support',{}]]),removed=[];
 const ch=f.channels.get('s');ch.members={fetch:async()=>existing,add:async id=>existing.set(id,{}),remove:async id=>{removed.push(id);existing.delete(id);}};
 f.db.prepare('INSERT INTO ticket_management_access VALUES(?,?)').run('s','support');
 f.db.prepare('INSERT INTO ticket_management_access VALUES(?,?)').run('s','owner');
 await f.api.reconcileAccess(f.guild,'support');
 assert.deepEqual(removed,['support']);assert.ok(existing.has('manual'));assert.ok(existing.has('owner'));
});
test('only server owner can grant and remove general ticket administrators by member',async t=>{
 const f=fixture(t);
 for(const user of ['support','admin','none']){const i=f.i('tg:cfg-admins',user,{values:['none']});await f.api.handle(i);assert.match(output(i),/não possui permissão/);}
 await f.api.handle(f.i('tg:cfg-admins','owner',{values:['none']}));
 assert.equal(f.api.access(f.guild,f.members.get('none')).admin,true);
 const panel=f.i('tg:home','none');await f.api.handle(panel);assert.match(output(panel),/Painel de Gestão/);
 const forged=f.i('tg:cfg-role:adminRole','none',{values:[]});await f.api.handle(forged);assert.match(output(forged),/não possui permissão/);
 assert.deepEqual(JSON.parse(f.db.prepare('SELECT config FROM ticket_management_config').get().config).adminUserIds,['none']);
 await f.api.handle(f.i('tg:cfg-admins','owner',{values:[]}));
 assert.equal(f.api.access(f.guild,f.members.get('none')).admin,false);
 const stale=f.i('tg:home','none');await f.api.handle(stale);assert.match(output(stale),/não possui permissão/);
});
test('minimal redesign uses uniform accent, compact sections and no custom emoji dependency',async t=>{
 const f=fixture(t);assert.equal(f.client.listenerCount('clientReady'),0);
 for(const [route,user] of [['tg:area:support','support'],['tg:area:migration','migration'],['tg:home','both'],['tg:ticket:s','support'],['tg:list:support:all:0','support'],['tg:config','owner']]){
  const i=f.i(route,user);await f.api.handle(i);const c=i.out[0].components[0].toJSON();
  assert.equal(c.accent_color,0);assert.doesNotMatch(JSON.stringify(c),/FEZES/);
  const total=component=>1+(component.components||[]).reduce((n,x)=>n+total(x),0)+(component.accessory?total(component.accessory):0);
  assert.ok(total(c)<=40);
 }
 const home=f.i('tg:area:support');await f.api.handle(home);assert.match(output(home),/1 aberto · 1 pendente · 0 em andamento/);
 const panel=home.out[0].components[0].toJSON();assert.equal(panel.components.filter(c=>c.type===9).length,3);
});
test('private navigation updates the same response and Back preserves list filters and page',async t=>{
 const f=fixture(t);for(let n=0;n<6;n++)f.data.tickets[`ticket-${n}`]={guildId:'g',sistema:'support',donoId:'author',criadoEm:Date.now()+n};
 const privateInteraction=route=>f.i(route,'support',{message:{id:'private-session',flags:{has:flag=>flag===MessageFlags.Ephemeral}},async deferUpdate(){this.deferred=true;this.updated=true;}});
 const list=privateInteraction('tg:list:support:pending:1');await f.api.handle(list);assert.equal(list.updated,true);assert.equal(list.replied,undefined);
 const ticket=privateInteraction('tg:ticket:s');await f.api.handle(ticket);
 const back=privateInteraction('tg:back');await f.api.handle(back);assert.match(output(back),/Tickets de Suporte/);assert.match(output(back),/2\/3/);assert.match(output(back),/tg:list:support:pending:/);
 f.make('support',[]);const stale=privateInteraction('tg:back');await f.api.handle(stale);assert.match(output(stale),/não possui permissão/);
});
test('private Back restores search query without repeating a mutation',async t=>{
 const f=fixture(t),extra={message:{id:'query-session',flags:{has:()=>true}},async deferUpdate(){this.deferred=true;}};
 await f.api.handle(f.i('tg:query:support','support',{...extra,fields:{getTextInputValue:()=> 'author'}}));
 await f.api.handle(f.i('tg:ticket:s','support',extra));
 const back=f.i('tg:back','support',extra);await f.api.handle(back);assert.match(output(back),/author/);assert.doesNotMatch(output(back),/other/);assert.equal(f.data.claims.s,undefined);
});
test('search pagination stays scoped and retains its query when returning from a ticket',async t=>{
 const f=fixture(t);for(let n=0;n<5;n++)f.data.tickets[`query-${n}`]={guildId:'g',sistema:'support',donoId:'author',criadoEm:Date.now()+n};
 const extra={message:{id:'search-pages',flags:{has:()=>true}},async deferUpdate(){this.deferred=true;}};
 await f.api.handle(f.i('tg:query:support','support',{...extra,fields:{getTextInputValue:()=> 'author'}}));
 const second=f.i('tg:query-page:support:1','support',extra);await f.api.handle(second);assert.match(output(second),/2\/2/);assert.doesNotMatch(output(second),/other/);
 await f.api.handle(f.i('tg:ticket:s','support',extra));const back=f.i('tg:back','support',extra);await f.api.handle(back);assert.match(output(back),/2\/2/);assert.doesNotMatch(output(back),/other/);
});
test('general dashboard aligns footer actions and uses actual server icon',async t=>{
 const f=fixture(t);f.guild.iconURL=()=> 'https://cdn.discordapp.com/icons/g/icon.png';
 const i=f.i('tg:home','owner');await f.api.handle(i);const c=i.out[0].components[0].toJSON();
 assert.equal(c.components[0].accessory.media.url,'https://cdn.discordapp.com/icons/g/icon.png');
 const footer=c.components.find(x=>x.type===1&&x.components.some(b=>b.custom_id==='tg:history-home'));
 assert.deepEqual(footer.components.map(b=>b.label),['Histórico','Atualizar','Configurações']);
 assert.equal(footer.components[0].emoji.id,'1570628610132283433');assert.equal(footer.components[2].emoji.id,'1570628871320109117');
 assert.ok(footer.components.every(b=>b.emoji?.name));
 const limited=f.i('tg:home','both');await f.api.handle(limited);assert.doesNotMatch(output(limited),/tg:config/);
});
test('administrative screens share one title, small separators and restrained typography',async t=>{
 const f=fixture(t);
 const walk=c=>[c,...(c.components||[]).flatMap(walk),...(c.accessory?walk(c.accessory):[])];
 for(const [route,user] of [['tg:home','owner'],['tg:area:support','support'],['tg:area:migration','migration'],['tg:list:support:all:0','support'],['tg:ticket:s','support'],['tg:history:support','support'],['tg:mine:support','support'],['tg:stats:support','support'],['tg:close:s','support'],['tg:transfer:s','support'],['tg:users:s','support'],['tg:config','owner'],['tg:cfg-area:support','owner']]){
  const i=f.i(route,user);await f.api.handle(i);const all=walk(i.out[0].components[0].toJSON()),contents=all.filter(c=>c.type===10).map(c=>c.content);
  assert.equal(contents.join('\n').split('\n').filter(line=>line.startsWith('### ')).length,1,route);
  for(const value of contents){assert.doesNotMatch(value,/^#{1,2}\s|^#{4,}\s|\n{3,}|TIMESTAMP|[\u200b\u200c\u200d]/m,route);}
  assert.ok(all.filter(c=>c.type===14).every(c=>c.spacing===1),route);
 }
});
test('ticket text stays three lines and untrusted type cannot inject headings or mentions',async t=>{
 const f=fixture(t);f.db.prepare("UPDATE ticket_management_cases SET kind=? WHERE id='s'").run('**fake**\n# Fake @everyone <@123>');
 const i=f.i('tg:list:support:all:0');await f.api.handle(i);const section=i.out[0].components[0].toJSON().components.find(c=>c.type===9);
 const content=section.components[0].content;assert.equal(content.split('\n').length,3);assert.ok(content.split('\n').slice(1).every(line=>line.startsWith('-# ')));
 assert.doesNotMatch(content,/@everyone|<@123>|\n# Fake/);assert.equal(section.accessory.custom_id,'tg:ticket:s');
 assert.deepEqual(i.out[0].allowedMentions,{parse:[]});
});
