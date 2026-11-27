const test=require('node:test'),assert=require('node:assert/strict');
const {EventEmitter}=require('node:events'),{DatabaseSync}=require('node:sqlite');
const {PermissionsBitField,PermissionFlagsBits,MessageFlags}=require('discord.js');
const {weekStart,WEEK_MS}=require('../voice-hours/time');
const install=require('../ticket-management');
function fixture(t){
 t.mock.method(Date,'now',()=>Date.parse('2026-11-13T12:00:00Z'));
 const db=new DatabaseSync(':memory:'),client=new EventEmitter(),roles=new Map(),members=new Map(),changes=[];client.user={id:'bot'};
 const role=(id,position,permissions=[])=>{const r={id,name:id,position,managed:false,permissions:new PermissionsBitField(permissions),comparePositionTo(other){return this.position-other.position;}};roles.set(id,r);return r;};
 role('g',0);role('team-sup',10);role('team-mig',20);role('sup-manager',50);role('mig-manager',50);role('admin-role',80);role('bot-role',90);
 const guild={id:'g',ownerId:'owner',roles:{cache:roles,fetch:async id=>id?roles.get(id):roles},members:{fetch:async x=>x===undefined?members:members.get(typeof x==='object'?x.user:x),fetchMe:async()=>members.get('bot')}};
 const make=(id,ids=[],perms=[])=>{const cache=new Map(ids.map(id=>[id,roles.get(id)]));const m={id,user:{id,bot:id==='bot'},guild,permissions:new PermissionsBitField(perms),roles:{cache,get highest(){return [...cache.values()].sort((a,b)=>b.position-a.position)[0]||roles.get('g');},async add(rid){changes.push(['add',id,rid]);cache.set(rid,roles.get(rid));},async remove(rid){changes.push(['remove',id,rid]);cache.delete(rid);}}};members.set(id,m);return m;};
 make('lead',['sup-manager']);make('mig-lead',['mig-manager']);make('admin',['admin-role']);make('owner');make('bot',['bot-role'],[PermissionFlagsBits.ManageRoles]);make('worker',['team-sup']);make('pending',['team-sup']);make('new');make('mig-worker',['team-mig']);
 const data={tickets:{},claims:{},pendingCloses:{},ticketClaimRoles:{g:{support:['team-sup'],migration:['team-mig']}},ticketGoalsByRole:{g:{'team-sup':2,'team-mig':3}}};
 const api=install({client,db,data,save(){},registry:{register(){},preserveMessage(){}},closeTicket(){}});
 db.prepare('INSERT INTO ticket_management_config VALUES(?,?)').run('g',JSON.stringify({supportRole:'sup-manager',migrationRole:'mig-manager',adminRole:'admin-role'}));
 function interaction(customId,user='lead',extra={}){const out=[];return {customId,user:{id:user},guild,guildId:'g',channelId:'parent',inGuild:()=>true,isButton:()=>true,values:[],out,async deferReply(){this.deferred=true;},async reply(p){out.push(p);},async editReply(p){out.push(p);},async showModal(p){out.push(p.toJSON());},...extra};}
 function closed(id,user,area,at,status='closed',gid='g'){db.prepare('INSERT INTO ticket_management_cases(id,guildId,area,ownerId,kind,createdAt,status,assigneeId,closedAt) VALUES(?,?,?,?,?,?,?,?,?)').run(id,gid,area,'author','sup',at-10000,status,user,at);}
 t.after(()=>db.close());return {db,api,roles,members,guild,role,make,data,changes,i:interaction,closed,client};
}
const output=i=>JSON.stringify(i.out);
const nodes=p=>{const walk=x=>[x,...(x.components||[]).flatMap(walk),...(x.accessory?walk(x.accessory):[])];return p.components.flatMap(c=>walk(c.toJSON?c.toJSON():c));};
function extraAreas(f){
 f.role('mov-manager',50);f.role('pass-manager',50);f.role('mov-entry',10);f.role('mov-senior',15);f.role('pass-entry',10);f.role('sup-senior',15);
 f.make('mov-lead',['mov-manager']);f.make('pass-lead',['pass-manager']);f.make('mov-worker',['mov-entry']);f.make('pass-worker',['pass-entry']);
 const c=f.api.config('g');Object.assign(c,{movchatRole:'mov-manager',passtimeRole:'pass-manager',movchatTeam:['mov-entry','mov-senior'],passtimeTeam:['pass-entry'],passtimeChannel:'pass-chat',movchatRanks:['mov-entry','mov-senior'],supportRanks:['team-sup','sup-senior']});
 f.data.ticketClaimRoles.g.support.push('sup-senior');f.db.prepare('UPDATE ticket_management_config SET config=? WHERE guildId=?').run(JSON.stringify(c),'g');
}
test('weekly dashboard lists area members with met/pending goals and excludes other periods and areas',async t=>{
 const f=fixture(t),now=Date.now(),start=weekStart(now);
 f.closed('a','worker','support',now-1000);f.closed('b','worker','support',now-2000);f.closed('c','pending','support',now-1000);
 f.closed('old','pending','support',start-1);f.closed('future','pending','support',start+WEEK_MS);f.closed('other-area','pending','migration',now-1000);f.closed('other-guild','pending','support',now-1000,'closed','elsewhere');f.closed('open','pending','support',now-1000,'open');
 const i=f.i('tg:team:support:all:0');await f.api.handle(i);assert.match(output(i),/Meta atingida:\*\* 1/);assert.match(output(i),/Meta pendente:\*\* 1/);assert.doesNotMatch(output(i),/mig-worker/);
 assert.equal(f.api.team.counts('g','support').get('pending'),1);
 const met=f.i('tg:team:support:met:0');await f.api.handle(met);assert.match(output(met),/<@worker>/);assert.doesNotMatch(output(met),/<@pending>/);
 const pending=f.i('tg:team:support:pending:0');await f.api.handle(pending);assert.match(output(pending),/<@pending>/);assert.doesNotMatch(output(pending),/<@worker>/);
 const all=nodes(i.out[0]),ids=all.filter(x=>x.custom_id).map(x=>x.custom_id);assert.equal(new Set(ids).size,ids.length);assert.ok(all.length<=40);
});
test('every team route rejects cross-area access and stale leadership',async t=>{
 const f=fixture(t);for(const route of ['tg:team:migration:all:0','tg:team-goals:migration','tg:team-members:migration:add','tg:team-target:migration:add:team-mig','tg:team-confirm:migration:fake','tg:team-goal-save:migration:fake']){const i=f.i(route);await f.api.handle(i);assert.match(output(i),/não possui permissão/);}
 f.make('lead',[]);const stale=f.i('tg:team:support:all:0');await f.api.handle(stale);assert.match(output(stale),/não possui permissão/);
});
test('leaders save per-cargo weekly goals only in their area, with atomic validation',async t=>{
 const f=fixture(t),select=f.i('tg:team-goal-select:support','lead',{values:['team-sup']});await f.api.handle(select);const id=select.out[0].custom_id;
 const save=f.i(id,'lead',{fields:{getTextInputValue:()=> '5'}});await f.api.handle(save);assert.equal(f.api.team.goal('g','support','team-sup'),5);assert.equal(f.api.team.goal('g','migration','team-mig'),3);
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM ticket_management_audit WHERE action='team-goals-updated'").get().n,1);
 const replay=f.i(id,'lead',{fields:{getTextInputValue:()=> '9'}});await f.api.handle(replay);assert.equal(f.api.team.goal('g','support','team-sup'),5);
 const bad=f.i('tg:team-goal-select:support','lead',{values:['team-mig']});await f.api.handle(bad);assert.match(output(bad),/não possui permissão/);
});
test('member add/remove require confirmation and duplicate confirmation changes roles only once',async t=>{
 const f=fixture(t),target=f.i('tg:team-target:support:add:team-sup','lead',{values:['new']});await f.api.handle(target);assert.equal(f.changes.length,0);
 const confirm=nodes(target.out[0]).find(x=>x.label==='Confirmar').custom_id;
 await Promise.all([f.api.handle(f.i(confirm)),f.api.handle(f.i(confirm))]);assert.deepEqual(f.changes,[['add','new','team-sup']]);
 const remove=f.i('tg:team-target:support:remove:team-sup','lead',{values:['new']});await f.api.handle(remove);
 await f.api.handle(f.i(nodes(remove.out[0]).find(x=>x.label==='Confirmar').custom_id));assert.deepEqual(f.changes.at(-1),['remove','new','team-sup']);
});
test('member actions block self edits, owner, general admins, hierarchy and shared-area roles',async t=>{
 const f=fixture(t);
 for(const user of ['lead','owner','admin']){const i=f.i('tg:team-target:support:add:team-sup','lead',{values:[user]});await f.api.handle(i);assert.match(output(i),/Não foi possível concluir/);}
 f.roles.get('team-sup').permissions=new PermissionsBitField();f.data.ticketClaimRoles.g.migration.push('team-sup');const i=f.i('tg:team-target:support:add:team-sup','lead',{values:['new']});await f.api.handle(i);assert.match(output(i),/duas áreas/);assert.equal(f.changes.length,0);
});
test('roles with administrative permissions can be used when configured in the area list',async t=>{
 const f=fixture(t);
 f.roles.get('team-sup').permissions=new PermissionsBitField([PermissionFlagsBits.Administrator]);
 const preview=f.i('tg:team-target:support:add:team-sup','lead',{values:['new']});await f.api.handle(preview);
 assert.match(output(preview),/Confirmar alteração/);
 const confirm=nodes(preview.out[0]).find(x=>x.label==='Confirmar').custom_id;await f.api.handle(f.i(confirm));
 assert.deepEqual(f.changes,[['add','new','team-sup']]);
 f.data.ticketClaimRoles.g.support=['team-mig'];
 const unlisted=f.i('tg:team-target:support:add:team-sup','lead',{values:['new']});await f.api.handle(unlisted);
 assert.match(output(unlisted),/Não foi possível concluir/);assert.equal(f.changes.length,1);
});
test('leadership revoked after preview cannot confirm a role mutation',async t=>{
 const f=fixture(t),i=f.i('tg:team-target:support:add:team-sup','lead',{values:['new']});await f.api.handle(i);const id=nodes(i.out[0]).find(x=>x.label==='Confirmar').custom_id;f.make('lead',[]);
 const confirm=f.i(id);await f.api.handle(confirm);assert.match(output(confirm),/não possui permissão/);assert.equal(f.changes.length,0);
});
test('week boundaries use Monday midnight in Brasilia',()=>{
 assert.equal(new Date(weekStart(Date.parse('2026-11-09T02:59:59Z'))).toISOString(),'2026-11-02T03:00:00.000Z');
 assert.equal(new Date(weekStart(Date.parse('2026-11-09T03:00:00Z'))).toISOString(),'2026-11-09T03:00:00.000Z');
});
test('weekly goal overrides persist across reinstall and zero disables instead of restoring the legacy goal',async t=>{
 const f=fixture(t),selection=f.i('tg:team-goal-select:support','lead',{values:['team-sup']});await f.api.handle(selection);
 await f.api.handle(f.i(selection.out[0].custom_id,'lead',{fields:{getTextInputValue:()=> '0'}}));assert.equal(f.api.team.goal('g','support','team-sup'),0);assert.equal(f.data.ticketGoalsByRole.g['team-sup'],2);
 const next=install({client:new EventEmitter(),db:f.db,data:f.data,save(){},registry:{register(){},preserveMessage(){}},closeTicket(){}});
 assert.equal(next.team.goal('g','support','team-sup'),0);
});
test('invalid multi-role input changes no goals and target hierarchy/bot permissions are enforced',async t=>{
 const f=fixture(t);f.role('extra-role',15);f.data.ticketClaimRoles.g.support.push('extra-role');
 const selection=f.i('tg:team-goal-select:support','lead',{values:['team-sup','extra-role']});await f.api.handle(selection);
 await f.api.handle(f.i(selection.out[0].custom_id,'lead',{fields:{getTextInputValue:key=>key==='goal-0'?'8':'invalid'}}));assert.equal(f.api.team.goal('g','support','team-sup'),2);
 f.roles.get('team-sup').position=60;let i=f.i('tg:team-target:support:add:team-sup','lead',{values:['new']});await f.api.handle(i);assert.match(output(i),/cargo mais alto/);
 f.roles.get('team-sup').position=10;f.members.get('bot').permissions=new PermissionsBitField();i=f.i('tg:team-target:support:add:team-sup','lead',{values:['new']});await f.api.handle(i);assert.match(output(i),/Gerenciar cargos/);assert.equal(f.changes.length,0);
});
test('Mov Chat counts human messages server-wide and real everyone once; Passtime only counts configured chat',async t=>{
 const f=fixture(t);extraAreas(f);let n=0;
 const msg=(channelId,content,mentions=true,extra={})=>({id:`message-${++n}`,guildId:'g',channelId,author:{id:'mov-worker',bot:false},createdTimestamp:Date.now(),content,mentions:{everyone:mentions},...extra});
 const first=msg('elsewhere','@everyone @everyone');f.api.activity.count(first);f.api.activity.count(first);
 f.api.activity.count(msg('pass-chat','hi'));f.api.activity.count(msg('elsewhere','@here'));f.api.activity.count(msg('elsewhere','@everyone',false));f.api.activity.count(msg('elsewhere','@here `@everyone`'));
 f.api.activity.count(msg('elsewhere','@everyone',true,{author:{id:'bot',bot:true}}));f.api.activity.count(msg('elsewhere','@everyone',true,{webhookId:'hook'}));
 assert.deepEqual(f.api.activity.totals('g','movchat').get('mov-worker'),{messages:5,everyone:1});assert.equal(f.api.activity.totals('g','passtime').get('mov-worker').messages,1);
 assert.equal(f.api.activity.totals('other','movchat').size,0);
 const i=f.i('tg:team:movchat:active:0','mov-lead');await f.api.handle(i);assert.match(output(i),/<@mov-worker>/);assert.doesNotMatch(output(i),/<@pass-worker>/);assert.match(output(i),/Ativo nesta semana/);
});
test('four areas isolate panels, data, administrative config and optional activity goals',async t=>{
 const f=fixture(t);extraAreas(f);
 const own=f.i('tg:home','mov-lead');await f.api.handle(own);assert.match(output(own),/Gestão de Mov Chat/);assert.doesNotMatch(output(own),/Gestão de Suporte/);
 for(const route of ['tg:team:passtime:all:0','tg:area:support','tg:cfg-role:movchatTeam','tg:team-promotion-target:passtime']){const i=f.i(route,'mov-lead',{values:['new']});await f.api.handle(i);assert.match(output(i),/não possui permissão/);}
 assert.equal(f.api.team.goal('g','movchat','mov-entry'),0);
 const goals=f.i('tg:team-goal-select:movchat','mov-lead',{values:['mov-entry']});await f.api.handle(goals);assert.equal(goals.out[0].components.length,2);
 const save=f.i(goals.out[0].custom_id,'mov-lead',{fields:{getTextInputValue:key=>key.startsWith('everyone')?'2':'5'}});await f.api.handle(save);
 const dashboard=f.i('tg:team:movchat:pending:0','mov-lead');await f.api.handle(dashboard);assert.match(output(dashboard),/Mensagens:\*\* 0 \/ 5/);assert.match(output(dashboard),/@everyone:\*\* 0 \/ 2/);
 const all=f.i('tg:home','admin');await f.api.handle(all);assert.match(output(all),/Mov Chat/);assert.match(output(all),/Passtime/);assert.ok(nodes(all.out[0]).length<=40);
});
test('general admins can configure teams and Passtime channel, while area leaders cannot',async t=>{
 const f=fixture(t);extraAreas(f);f.client.channels={fetch:async id=>({id,guildId:'g',type:0})};
 const roles=f.i('tg:cfg-role:movchatTeam','admin',{values:['mov-entry','mov-senior']});await f.api.handle(roles);assert.deepEqual(f.api.config('g').movchatTeam,['mov-entry','mov-senior']);
 const channel=f.i('tg:cfg-channel:passtimeChannel','admin',{values:['new-chat']});await f.api.handle(channel);assert.equal(f.api.config('g').passtimeChannel,'new-chat');
 const denied=f.i('tg:cfg-channel:passtimeChannel','pass-lead',{values:['forbidden']});await f.api.handle(denied);assert.match(output(denied),/não possui permissão/);assert.equal(f.api.config('g').passtimeChannel,'new-chat');
});
test('promotion advances exactly one configured level and checks permission again at confirmation',async t=>{
 const f=fixture(t);extraAreas(f);
 const preview=f.i('tg:team-promotion-target:movchat','mov-lead',{values:['mov-worker']});await f.api.handle(preview);assert.equal(f.changes.length,0);
 const id=nodes(preview.out[0]).find(x=>x.label==='Confirmar').custom_id;await Promise.all([f.api.handle(f.i(id,'mov-lead')),f.api.handle(f.i(id,'mov-lead'))]);
 assert.deepEqual(f.changes,[['add','mov-worker','mov-senior'],['remove','mov-worker','mov-entry']]);
 const support=f.i('tg:team-promotion-target:support','lead',{values:['worker']});await f.api.handle(support);const sid=nodes(support.out[0]).find(x=>x.label==='Confirmar').custom_id;
 f.make('lead',[]);const stale=f.i(sid);await f.api.handle(stale);assert.match(output(stale),/não possui permissão/);assert.equal(f.changes.length,2);
});
test('administrative rank order can be saved/reordered but leaders cannot edit it',async t=>{
 const f=fixture(t);extraAreas(f);
 const save=f.i('tg:cfg-rank-save:movchat','admin',{values:['mov-entry','mov-senior']});await f.api.handle(save);assert.deepEqual(f.api.config('g').movchatRanks,['mov-entry','mov-senior']);
 await f.api.handle(f.i('tg:cfg-rank-move:movchat:mov-senior:up','admin'));assert.deepEqual(f.api.config('g').movchatRanks,['mov-senior','mov-entry']);
 const forged=f.i('tg:cfg-rank-save:movchat','mov-lead',{values:['mov-entry']});await f.api.handle(forged);assert.match(output(forged),/não possui permissão/);
 const invalid=f.i('tg:cfg-rank-save:movchat','admin',{values:['admin-role']});await f.api.handle(invalid);assert.match(output(invalid),/Cargo inválido/);
});

test('rank sequences accept administrative roles configured in the area list',async t=>{
 const f=fixture(t);extraAreas(f);f.role('mov-admin',20,[PermissionFlagsBits.Administrator]);
 const c=f.api.config('g');c.movchatTeam=['mov-entry','mov-admin'];f.db.prepare('UPDATE ticket_management_config SET config=? WHERE guildId=?').run(JSON.stringify(c),'g');
 const save=f.i('tg:cfg-rank-save:movchat','admin',{values:['mov-entry','mov-admin']});await f.api.handle(save);
 assert.deepEqual(f.api.config('g').movchatRanks,['mov-entry','mov-admin']);
});
test('migration and Passtime leaders can promote only to their next configured rank',async t=>{
 const f=fixture(t);extraAreas(f);f.role('mig-senior',25);f.role('pass-senior',15);f.data.ticketClaimRoles.g.migration.push('mig-senior');
 const c=f.api.config('g');c.migrationRanks=['team-mig','mig-senior'];c.passtimeTeam.push('pass-senior');c.passtimeRanks=['pass-entry','pass-senior'];f.db.prepare('UPDATE ticket_management_config SET config=? WHERE guildId=?').run(JSON.stringify(c),'g');
 for(const [area,lead,target] of [['migration','mig-lead','mig-worker'],['passtime','pass-lead','pass-worker']]){
  const preview=f.i(`tg:team-promotion-target:${area}`,lead,{values:[target]});await f.api.handle(preview);const confirm=nodes(preview.out[0]).find(x=>x.label==='Confirmar');assert.ok(confirm);await f.api.handle(f.i(confirm.custom_id,lead));
 }
 assert.ok(f.members.get('mig-worker').roles.cache.has('mig-senior'));assert.ok(f.members.get('pass-worker').roles.cache.has('pass-senior'));
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM ticket_management_audit WHERE action='team-promoted'").get().n,2);
});
test('promotion can use an administrative role configured in the area sequence and audits partial failures',async t=>{
 const f=fixture(t);extraAreas(f);
 f.members.get('mov-worker').roles.remove=async()=>{throw new Error('Discord unavailable');};
 const preview=f.i('tg:team-promotion-target:movchat','mov-lead',{values:['mov-worker']});await f.api.handle(preview);
 const id=nodes(preview.out[0]).find(x=>x.label==='Confirmar').custom_id,result=f.i(id,'mov-lead');await f.api.handle(result);assert.match(output(result),/Promoção parcial/);
 assert.ok(f.members.get('mov-worker').roles.cache.has('mov-senior'));assert.equal(f.db.prepare("SELECT COUNT(*) n FROM ticket_management_audit WHERE action='team-promotion-partial'").get().n,1);
 f.make('mov-worker',['mov-entry']);f.roles.get('admin-role').permissions=new PermissionsBitField([PermissionFlagsBits.Administrator]);f.roles.get('mov-manager').position=90;
 const c=f.api.config('g');c.movchatTeam.push('admin-role');c.movchatRanks=['mov-entry','admin-role'];f.db.prepare('UPDATE ticket_management_config SET config=? WHERE guildId=?').run(JSON.stringify(c),'g');
 const allowed=f.i('tg:team-promotion-target:movchat','mov-lead',{values:['mov-worker']});await f.api.handle(allowed);assert.match(output(allowed),/Confirmar promoção/);
 const confirm=nodes(allowed.out[0]).find(x=>x.label==='Confirmar').custom_id;await f.api.handle(f.i(confirm,'mov-lead'));
 assert.ok(f.members.get('mov-worker').roles.cache.has('admin-role'));assert.equal(f.members.get('mov-worker').roles.cache.has('mov-entry'),false);
});
test('activity counters and channel selection persist without storing message contents',async t=>{
 const f=fixture(t);extraAreas(f);f.api.activity.count({id:'persistent',guildId:'g',channelId:'pass-chat',author:{id:'pass-worker',bot:false},content:'private content',mentions:{everyone:false},createdTimestamp:Date.now()});
 const next=install({client:new EventEmitter(),db:f.db,data:f.data,save(){},registry:{register(){},preserveMessage(){}},closeTicket(){}});
 assert.equal(next.activity.totals('g','passtime').get('pass-worker').messages,1);
 assert.equal(f.db.prepare('PRAGMA table_info(management_activity)').all().some(c=>c.name==='content'),false);
 const old=f.api.config('g');old.passtimeChannel='different-chat';f.db.prepare('UPDATE ticket_management_config SET config=? WHERE guildId=?').run(JSON.stringify(old),'g');assert.equal(next.activity.totals('g','passtime').size,0);
});
