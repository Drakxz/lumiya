const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { Collection, PermissionsBitField, PermissionFlagsBits } = require("discord.js");
const instalarClear = require("../clear");
const CHANNEL = "100000000000000001";
const USER = "100000000000000002";
const OTHER = "100000000000000003";
const GUILD = "100000000000000004";
const OTHER_CHANNEL = "100000000000000005";
const NOW = Date.now();
const DAY = 86_400_000;
function snowflake(timestamp, increment = 0) {
  return (((BigInt(timestamp) - 1420070400000n) << 22n) + BigInt(increment)).toString();
}
function stored(timestamp, increment, authorId = USER, channelId = CHANNEL, bot = false) {
  return { id: snowflake(timestamp, increment), createdTimestamp: timestamp,
    channelId, author: { id: authorId, bot } };
}

function fixture({ history = [], permissions = new PermissionsBitField([
  PermissionFlagsBits.ManageMessages, PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.ViewChannel, PermissionFlagsBits.AddReactions
]) } = {}) {
  const client = new EventEmitter();
  const api = instalarClear({ client });
  const calls = { fetch: [], bulk: [], individual: [], react: [], order: [] };
  const messages = new Map(history.map(item => [item.id, item]));
  const f = { calls, messages, beforeFetch: null, bulkError: null, individualErrors: new Map(), reactionError: null, fetchError: null };
  const channel = {
    id: CHANNEL,
    permissionsFor: () => permissions,
    messages: {
      async fetch(options) {
        if (typeof options === "string") return messages.get(options) || null;
        calls.fetch.push(options); calls.order.push("fetch");
        if (f.beforeFetch) await f.beforeFetch();
        if (f.fetchError) throw f.fetchError;
        const page = [...messages.values()].filter(x => BigInt(x.id) < BigInt(options.before))
          .sort((a, b) => BigInt(a.id) < BigInt(b.id) ? 1 : -1).slice(0, options.limit);
        return new Collection(page.map(x => [x.id, x]));
      },
      async delete(id) {
        calls.individual.push(id); calls.order.push(`delete:${id}`);
        if (f.individualErrors.has(id)) throw f.individualErrors.get(id);
        messages.delete(id);
      }
    },
    async bulkDelete(ids) {
      assert.ok(Array.isArray(ids));
      assert.ok(ids.length >= 2 && ids.length <= 100);
      calls.bulk.push([...ids]); calls.order.push("bulk");
      if (f.bulkError) throw f.bulkError;
      ids.forEach(id => messages.delete(id));
    }
  };
  function command(content = "cl", { authorId = USER, channelId = CHANNEL, id = snowflake(NOW, 1000), bot = false, guild = true,
    admin = false, referenceId = null, mentions = [] } = {}) {
    const message = {
      id, content, channelId, channel, author: { id: authorId, bot },
      guild: guild ? { id: GUILD, members: { me: { id: "bot" } } } : null,
      member: { permissions: new PermissionsBitField(admin ? [PermissionFlagsBits.Administrator] : []) },
      reference: referenceId ? { messageId: referenceId } : null,
      mentions: { users: new Collection(mentions.map(user => [user.id, user])) },
      async react(emoji) {
        calls.react.push([id, emoji]); calls.order.push("react");
        if (f.reactionError) throw f.reactionError;
      }
    };
    messages.set(id, { id, channelId, author: message.author, createdTimestamp: NOW });
    return message;
  }
  const dispatch = async message => { for (const fn of client.listeners("messageCreate")) await fn(message); };
  return { ...f, f, calls, channel, command, dispatch, api, messages, client };
}

test("CL accepts only the exact word, ignoring surrounding spaces and letter case", async () => {
  for (const content of ["cl", "CL", "Cl", " cl ", "\nCL\t"]) {
    const h = fixture(); const cmd = h.command(content); await h.dispatch(cmd);
    assert.deepEqual(h.calls.react, [[cmd.id, "💩"]]);
    assert.equal(h.calls.fetch.length, 1);
    assert.deepEqual(h.calls.individual, [cmd.id]);
  }
  for (const content of ["clear", "claro", "cl teste", "meu cl", "!cl", "c l", ""]) {
    const h = fixture(); await h.dispatch(h.command(content));
    assert.equal(h.calls.fetch.length + h.calls.react.length + h.calls.individual.length, 0);
  }
});

test("mismatched channels, bots and DMs never trigger deletion or reaction", async () => {
  for (const options of [{ channelId: OTHER_CHANNEL }, { bot: true }, { guild: false }]) {
    const h = fixture(); await h.dispatch(h.command("cl", options));
    assert.equal(h.calls.fetch.length + h.calls.react.length + h.calls.individual.length, 0);
  }
});
test("CL invocation disappears before fetching history",async()=>{
  const h=fixture({history:[stored(NOW-1000,1)]});
  const cmd=h.command();
  h.f.beforeFetch=async()=>{assert.equal(h.messages.has(cmd.id),false);};
  await h.dispatch(cmd);
  assert.ok(h.calls.order.indexOf(`delete:${cmd.id}`)<h.calls.order.indexOf("fetch"));
  assert.equal(h.calls.individual.filter(id=>id===cmd.id).length,1);
});

test("CL works in any server channel without an ID allowlist", async () => {
  const own = stored(NOW - 1000, 1, USER, OTHER_CHANNEL);
  const h = fixture({ history: [own] });
  h.channel.id = OTHER_CHANNEL;
  const command = h.command("cl", { channelId: OTHER_CHANNEL });
  await h.dispatch(command);
  assert.equal(h.calls.react.length, 1);
  assert.equal(h.messages.has(own.id), false);
  assert.equal(h.messages.has(command.id), false);
});

test("admin replying to a message cleans that author, including the replied message and the command", async () => {
  const replied = { id: snowflake(NOW - 2000, 1), createdTimestamp: NOW - 2000,
    channelId: CHANNEL, guildId: GUILD, author: { id: OTHER, bot: false } };
  const doAlvo = stored(NOW - 3000, 2, OTHER);
  const doAdmin = stored(NOW - 4000, 3, USER);
  const h = fixture({ history: [replied, doAlvo, doAdmin] });
  const cmd = h.command("cl", { admin: true, referenceId: replied.id });
  await h.dispatch(cmd);
  assert.equal(h.messages.has(doAlvo.id), false);
  assert.equal(h.messages.has(replied.id), false);
  assert.equal(h.messages.has(cmd.id), false);
  assert.equal(h.messages.has(doAdmin.id), true, "the admin's own history is untouched");
});

test("admin mentioning a user targets that user; non-admins keep targeting themselves", async () => {
  const doAlvo = stored(NOW - 3000, 1, OTHER);
  const doAdmin = stored(NOW - 4000, 2, USER);
  const mencionado = { id: OTHER, bot: false };

  const h = fixture({ history: [doAlvo, doAdmin] });
  const cmd = h.command("cl", { admin: true, mentions: [mencionado] });
  await h.dispatch(cmd);
  assert.equal(h.messages.has(doAlvo.id), false);
  assert.equal(h.messages.has(doAdmin.id), true);

  const h2 = fixture({ history: [doAlvo, doAdmin] });
  const cmd2 = h2.command("cl", { mentions: [mencionado] });
  await h2.dispatch(cmd2);
  assert.equal(h2.messages.has(doAdmin.id), false);
  assert.equal(h2.messages.has(doAlvo.id), true, "a regular member cannot redirect CL");
});

test("pagination reaches beyond 100 messages while preserving all other authors and newer messages", async () => {
  const history = Array.from({ length: 357 }, (_, n) => stored(NOW - 100_000 - n * 1000, n, n % 3 ? USER : OTHER));
  const newer = stored(NOW + 1000, 1, USER); history.push(newer);
  const h = fixture({ history }); const cmd = h.command(); await h.dispatch(cmd);
  assert.equal(h.calls.fetch.length, 4);
  assert.equal(h.calls.react.length, 1);
  assert.equal(h.calls.order[0], "react");
  const deleted = [...h.calls.bulk.flat(), ...h.calls.individual];
  assert.equal(new Set(deleted).size, deleted.length);
  for (const item of history) {
    assert.equal(h.messages.has(item.id), item.author.id !== USER || item.id === newer.id);
  }
  assert.equal(h.messages.has(cmd.id), false);
  for (const options of h.calls.fetch) { assert.equal(options.limit, 100); assert.equal(options.cache, false); }
  for (let n = 1; n < h.calls.fetch.length; n++) assert.ok(BigInt(h.calls.fetch[n].before) < BigInt(h.calls.fetch[n - 1].before));
  assert.equal(h.calls.order[1], `delete:${cmd.id}`);
});

test("messages older than 14 days and near the boundary use individual deletion", async () => {
  const old = stored(NOW - 15 * DAY, 1);
  const boundary = stored(NOW - 14 * DAY + 1000, 2);
  const recent = [stored(NOW - DAY, 3), stored(NOW - DAY, 4)];
  const h = fixture({ history: [old, boundary, ...recent] }); const cmd = h.command();
  await h.dispatch(cmd);
  assert.deepEqual(new Set(h.calls.bulk[0]), new Set(recent.map(x => x.id)));
  assert.deepEqual(new Set(h.calls.individual), new Set([old.id, boundary.id, cmd.id]));
});

test("one recent message is deleted individually, not with an invalid bulk size", async () => {
  const own = stored(NOW - 1000, 1); const h = fixture({ history: [own] });
  const cmd = h.command(); await h.dispatch(cmd);
  assert.equal(h.calls.bulk.length, 0); assert.deepEqual(h.calls.individual, [cmd.id, own.id]);
});

test("the bulk payload never contains a different author, bot or channel", async () => {
  const own = [stored(NOW - 1000, 1), stored(NOW - 1000, 2)];
  const foreign = [stored(NOW - 1000, 3, OTHER), stored(NOW - 1000, 4, USER, CHANNEL, true), stored(NOW - 1000, 5, USER, OTHER_CHANNEL)];
  const h = fixture({ history: [...own, ...foreign] }); await h.dispatch(h.command());
  assert.deepEqual(new Set(h.calls.bulk.flat()), new Set(own.map(x => x.id)));
  for (const message of foreign) assert.equal(h.messages.has(message.id), true);
});

test("all four permissions are required before the first fetch or deletion", async t => {
  t.mock.method(console, "warn", () => {});
  for (const missing of ["ManageMessages", "ReadMessageHistory", "ViewChannel", "AddReactions"]) {
    const permissions = new PermissionsBitField([PermissionFlagsBits.ManageMessages, PermissionFlagsBits.ReadMessageHistory,
      PermissionFlagsBits.ViewChannel, PermissionFlagsBits.AddReactions]).remove(PermissionFlagsBits[missing]);
    const h = fixture({ permissions }); const cmd = h.command(); await h.dispatch(cmd);
    assert.equal(h.calls.fetch.length + h.calls.bulk.length + h.calls.react.length, 0);
    assert.deepEqual(h.calls.individual, [cmd.id], "the command itself is always attempted");
    assert.equal(h.api.inProgress.size, 0);
  }
});

test("concurrent CL commands of one user share a single scan and both commands are removed", async () => {
  const h = fixture(); let release;
  h.f.beforeFetch = () => new Promise(resolve => { release = resolve; });
  const first = h.command(); const pending = h.dispatch(first);
  await new Promise(resolve => setImmediate(resolve));
  const duplicate = h.command("CL", { id: snowflake(NOW + 1000, 1) });
  await h.dispatch(duplicate);
  assert.equal(h.api.inProgress.size, 1); assert.equal(h.calls.fetch.length, 1);
  assert.equal(h.calls.react.length, 2);
  release(); await pending;
  assert.deepEqual(new Set(h.calls.individual), new Set([first.id, duplicate.id]));
  assert.equal(h.api.inProgress.size, 0);
});

test("reaction failure does not abort a permitted cleanup", async t => {
  t.mock.method(console, "warn", () => {});
  const own = stored(NOW - 1000, 1); const h = fixture({ history: [own] });
  h.f.reactionError = new Error("Reaction failed");
  await h.dispatch(h.command());
  assert.equal(h.messages.has(own.id), false); assert.equal(h.calls.fetch.length, 1);
});

test("bulk age errors fall back to individual deletion and already-deleted messages are ignored", async t => {
  t.mock.method(console, "warn", () => {});
  const own = [stored(NOW - DAY, 1), stored(NOW - DAY, 2)];
  const h = fixture({ history: own });
  h.f.bulkError = Object.assign(new Error("Too old"), { code: 50034 });
  h.f.individualErrors.set(own[0].id, Object.assign(new Error("Unknown Message"), { code: 10008 }));
  const cmd = h.command(); await h.dispatch(cmd);
  assert.equal(h.calls.bulk.length, 1);
  assert.deepEqual(new Set(h.calls.individual), new Set([...own.map(x => x.id), cmd.id]));
  assert.equal(h.api.inProgress.size, 0);
});

test("history fetch failure releases the lock and still attempts to remove the command", async t => {
  t.mock.method(console, "error", () => {});
  const h = fixture(); h.f.fetchError = new Error("History failed");
  const cmd = h.command(); await h.dispatch(cmd);
  assert.deepEqual(h.calls.individual, [cmd.id]); assert.equal(h.api.inProgress.size, 0);
});

test("permission loss stops further pages without crashing or attempting other channels", async t => {
  t.mock.method(console, "error", () => {}); t.mock.method(console, "warn", () => {});
  const h = fixture({ history: Array.from({ length: 250 }, (_, n) => stored(NOW - DAY - n, n)) });
  h.f.bulkError = Object.assign(new Error("Missing Permissions"), { code: 50013 });
  await h.dispatch(h.command());
  assert.ok(h.calls.fetch.length <= 2); assert.equal(h.calls.bulk.length, 1); assert.equal(h.api.inProgress.size, 0);
});

test("next page is prefetched during deletion with only one page of lookahead", async () => {
  const h = fixture({ history: Array.from({ length: 250 }, (_, n) => stored(NOW - DAY - n, n)) });
  const original = h.channel.bulkDelete.bind(h.channel);
  let release;
  let first = true;
  h.channel.bulkDelete = async ids => {
    if (first) {
      first = false;
      await new Promise(resolve => { release = resolve; });
    }
    return original(ids);
  };
  const command = h.command();
  const pending = h.dispatch(command);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.calls.fetch.length, 2);
  release();
  await pending;
  assert.equal(h.calls.fetch.length, 3);
  assert.equal(h.messages.size, 0);
  assert.equal(h.api.inProgress.size, 0);
});

test("slow reaction and command deletion do not block history bulk deletion",async()=>{
  const own=[stored(NOW-DAY,1),stored(NOW-DAY,2)];
  const h=fixture({history:own}),cmd=h.command();
  let releaseReaction,releaseCommand;
  cmd.react=()=>new Promise(resolve=>{releaseReaction=resolve;});
  const remove=h.channel.messages.delete.bind(h.channel.messages);
  h.channel.messages.delete=async id=>{
    if(id===cmd.id)await new Promise(resolve=>{releaseCommand=resolve;});
    return remove(id);
  };
  const pending=h.dispatch(cmd);
  try{
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(h.calls.bulk.length,1,"bulk proceeds while reaction and command DELETE are pending");
    assert.equal(h.api.inProgress.size,1,"job remains locked until command deletion settles");
    assert.ok(own.every(item=>!h.messages.has(item.id)));
  }finally{
    releaseReaction?.();releaseCommand?.();
    await pending;
  }
  assert.equal(h.api.inProgress.size,0);
});

test("sparse recent messages from three pages share one bulk request",async()=>{
  const history=Array.from({length:300},(_,n)=>stored(NOW-DAY-n,n,n%100===0?USER:OTHER));
  const h=fixture({history});await h.dispatch(h.command());
  assert.equal(h.calls.bulk.length,1);
  assert.equal(h.calls.bulk[0].length,3);
  assert.equal(h.calls.individual.length,1,"only the invocation needs individual deletion");
  for(const item of history)assert.equal(h.messages.has(item.id),item.author.id!==USER);
});

test("individual workers stay busy when one old-message DELETE is slow, with at most eight in flight",async()=>{
  const history=Array.from({length:40},(_,n)=>stored(NOW-20*DAY-n,n));
  const h=fixture({history}),cmd=h.command();
  const remove=h.channel.messages.delete.bind(h.channel.messages);
  let release,active=0,maxActive=0,started=0;
  h.channel.messages.delete=async id=>{
    if(id===cmd.id)return remove(id);
    active++;started++;maxActive=Math.max(maxActive,active);
    try{
      if(id===history[0].id)await new Promise(resolve=>{release=resolve;});
      else await new Promise(resolve=>setImmediate(resolve));
      return await remove(id);
    }finally{active--;}
  };
  const pending=h.dispatch(cmd);
  try{
    for(let i=0;i<8;i++)await new Promise(resolve=>setImmediate(resolve));
    assert.ok(started>8,"other workers continue without waiting for the stalled DELETE");
    assert.ok(maxActive<=8);
  }finally{release?.();await pending;}
  assert.equal(h.messages.size,0);
});

test("different administrators targeting the same author share one history scan",async()=>{
  const h=fixture();let release;
  h.f.beforeFetch=()=>new Promise(resolve=>{release=resolve;});
  const first=h.command("cl",{admin:true,mentions:[{id:OTHER,bot:false}]});
  const pending=h.dispatch(first);
  await new Promise(resolve=>setImmediate(resolve));
  const second=h.command("cl",{admin:true,authorId:"100000000000000006",
    id:snowflake(NOW+1000,1),mentions:[{id:OTHER,bot:false}]});
  try{
    await h.dispatch(second);
    assert.equal(h.calls.fetch.length,1);
    assert.equal(h.api.inProgress.size,1);
  }finally{release();await pending;}
  assert.equal(h.api.inProgress.size,0);
});

test("known target messages start deleting before the first history response, without duplicate IDs",async()=>{
  const own=[stored(NOW-DAY,1),stored(NOW-DAY,2)];
  const other=stored(NOW-DAY,3,OTHER);
  const foreign=stored(NOW-DAY,4,USER,OTHER_CHANNEL);
  const bot=stored(NOW-DAY,5,USER,CHANNEL,true);
  const newer=stored(NOW+1000,6);
  const h=fixture({history:[...own,other,foreign,bot,newer]});
  const cmd=h.command();
  h.channel.messages.cache=new Collection([...own,other,foreign,bot,newer].map(item=>[item.id,item]));
  const remove=h.channel.bulkDelete.bind(h.channel);
  let release,cachedBulk;
  h.channel.bulkDelete=async ids=>{
    cachedBulk=[...ids];
    await new Promise(resolve=>{release=resolve;});
    return remove(ids);
  };
  const pending=h.dispatch(cmd);
  try{
    await new Promise(resolve=>setImmediate(resolve));
    assert.deepEqual(new Set(cachedBulk),new Set(own.map(item=>item.id)));
    assert.equal(h.calls.fetch.length,1,"history proceeds while the cached bulk is pending");
  }finally{release?.();await pending;}
  assert.equal(h.calls.bulk.length,1,"history must not enqueue cached IDs twice");
  for(const item of [other,foreign,bot,newer])assert.equal(h.messages.has(item.id),true);
});

test("first page with multiple target messages is deleted immediately instead of waiting for three pages",async()=>{
  const history=Array.from({length:250},(_,n)=>stored(NOW-DAY-n,n,n<2?USER:OTHER));
  const h=fixture({history});await h.dispatch(h.command());
  const firstBulk=h.calls.order.indexOf("bulk");
  const firstFetch=h.calls.order.indexOf("fetch");
  const secondFetch=h.calls.order.indexOf("fetch",firstFetch+1);
  assert.ok(firstBulk>firstFetch&&firstBulk<secondFetch);
  assert.equal(h.calls.bulk[0].length,2);
});

function enableSearch(h,{pageSize=25,unindexed=false,unindexedIds=new Set()}={}){
  const queries=[];
  h.client.rest={async get(route,{query}){
    assert.equal(route,`/guilds/${GUILD}/messages/search`);
    assert.equal(query.get("channel_id"),CHANNEL);
    assert.equal(query.get("sort_by"),"timestamp");
    assert.equal(query.get("offset"),null);
    queries.push(query);
    if(unindexed)return {code:110000,retry_after:2};
    const matches=[...h.messages.values()].filter(item=>
      item.author.id===query.get("author_id")&&item.channelId===CHANNEL&&!item.author.bot&&
      BigInt(item.id)<BigInt(query.get("max_id"))&&!unindexedIds.has(item.id))
      .sort((a,b)=>BigInt(a.id)>BigInt(b.id)?-1:1).slice(0,pageSize);
    return {doing_deep_historical_index:false,total_results:999999,
      messages:matches.map(item=>[{id:item.id,channel_id:item.channelId,
        author:item.author,timestamp:new Date(item.createdTimestamp).toISOString()}])};
  }};
  return queries;
}

test("author search removes sparse target messages without scanning thousands of unrelated messages",async()=>{
  const history=Array.from({length:2500},(_,n)=>stored(NOW-DAY-n,n,n%50===0?USER:OTHER));
  const h=fixture({history}),queries=enableSearch(h);
  await h.dispatch(h.command());
  assert.equal(queries.length,3,"two pages of target messages followed by empty search");
  assert.equal(h.calls.fetch.length,1,"only the recent index-lag verification needs history");
  for(const item of history)assert.equal(h.messages.has(item.id),item.author.id!==USER);
});

test("short search pages continue by max_id despite inaccurate totals and concurrent deletion",async()=>{
  const history=Array.from({length:38},(_,n)=>stored(NOW-DAY-n,n));
  const h=fixture({history}),queries=enableSearch(h,{pageSize:7});
  await h.dispatch(h.command());
  assert.equal(queries.length,7);
  assert.equal(h.messages.size,0);
  const ids=[...h.calls.bulk.flat(),...h.calls.individual];
  assert.equal(ids.length,new Set(ids).size);
});

test("indexing delay falls back to full history without losing target messages",async()=>{
  const history=Array.from({length:250},(_,n)=>stored(NOW-DAY-n,n,n%2?USER:OTHER));
  const h=fixture({history});enableSearch(h,{unindexed:true});
  await h.dispatch(h.command());
  assert.equal(h.calls.fetch.length,3);
  for(const item of history)assert.equal(h.messages.has(item.id),item.author.id!==USER);
});

test("recent history verification includes messages not yet in the search index",async()=>{
  const history=Array.from({length:50},(_,n)=>stored(NOW-DAY-n,n));
  const h=fixture({history});
  enableSearch(h,{unindexedIds:new Set(history.slice(0,3).map(item=>item.id))});
  await h.dispatch(h.command());
  assert.equal(h.messages.size,0);
});

test("search results cannot authorize another author, channel, bot or messages newer than the command",async()=>{
  const own=stored(NOW-DAY,1),other=stored(NOW-DAY,2,OTHER),
    foreign=stored(NOW-DAY,3,USER,OTHER_CHANNEL),bot=stored(NOW-DAY,4,USER,CHANNEL,true),
    newer=stored(NOW+1000,5);
  const h=fixture({history:[own,other,foreign,bot,newer]});
  let first=true;
  h.client.rest={get:async()=>{
    if(!first)return {messages:[]};
    first=false;
    return {messages:[own,other,foreign,bot,newer,own].map(item=>[{
      id:item.id,channel_id:item.channelId,author:item.author,
      timestamp:new Date(item.createdTimestamp).toISOString()
    }])};
  }};
  await h.dispatch(h.command());
  assert.equal(h.messages.has(own.id),false);
  for(const item of [other,foreign,bot,newer])assert.equal(h.messages.has(item.id),true);
  const ids=[...h.calls.bulk.flat(),...h.calls.individual];
  assert.equal(ids.length,new Set(ids).size);
});
