const test=require('node:test'),assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {createMemberDirectory,memberDirectory}=require('../ticket-management/members');
test('complete guild member fetches are coalesced across concurrent requests and reused for pagination',async()=>{
 const client=new EventEmitter();let calls=0,resolve;
 const guild={id:'g',members:{fetch(){calls++;return new Promise(r=>{resolve=r;});}}};
 const directory=createMemberDirectory(client),a=directory.get(guild),b=directory.get(guild);await Promise.resolve();
 assert.equal(calls,1);resolve(new Map([['user',{id:'user'}]]));await Promise.all([a,b]);
 await directory.get(guild);await directory.get(guild);assert.equal(calls,1);
 assert.equal(memberDirectory(client),memberDirectory(client));
});
test('gateway rate-limit retry_after is honored without sending another opcode 8 request',async()=>{
 let now=0,calls=0;const client=new EventEmitter(),directory=createMemberDirectory(client,{now:()=>now});
 const guild={id:'g',members:{async fetch(){calls++;throw Object.assign(new Error('rate limited'),{data:{opcode:8,retry_after:11.615}});}}};
 await assert.rejects(directory.get(guild),e=>e.kind==='member_fetch_rate_limit'&&e.retrySeconds===12);
 now=11000;await assert.rejects(directory.get(guild),e=>e.kind==='member_fetch_rate_limit');assert.equal(calls,1);
 now=12000;guild.members.fetch=async()=>{calls++;return new Map();};await directory.get(guild);assert.equal(calls,2);
});
test('member events update complete snapshots while incomplete gateway caches are not silently reported as complete',async()=>{
 const client=new EventEmitter();let calls=0;
 const guild={id:'g',memberCount:2,members:{cache:new Map([['one',{id:'one'}]]),fetch:async()=>{calls++;return new Map([['one',{id:'one'}],['two',{id:'two'}]]);}}};
 const directory=createMemberDirectory(client);await directory.get(guild);assert.equal(calls,1);
 const changed={id:'one',guild,roles:{newRole:true}};client.emit('guildMemberUpdate',{},changed);
 assert.equal((await directory.get(guild)).get('one'),changed);
 client.emit('guildMemberRemove',{id:'two',guild});assert.equal((await directory.get(guild)).has('two'),false);
 client.emit('guildMemberAdd',{id:'three',guild});assert.equal((await directory.get(guild)).has('three'),true);
});
test('fully populated Discord cache needs no gateway request and guild snapshots are isolated',async()=>{
 const directory=createMemberDirectory(new EventEmitter());let calls=0;
 const guild={id:'g',memberCount:1,members:{cache:new Map([['one',{id:'one'}]]),fetch:async()=>{calls++;return new Map();}}};
 assert.equal((await directory.get(guild)).size,1);assert.equal(calls,0);
 const other={id:'other',members:{fetch:async()=>new Map([['two',{id:'two'}]])}};assert.equal((await directory.get(other)).has('one'),false);
});
