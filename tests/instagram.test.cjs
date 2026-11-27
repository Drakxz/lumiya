const test=require("node:test"),assert=require("node:assert/strict");
const {DatabaseSync}=require("node:sqlite"),{EventEmitter}=require("node:events");
const install=require("../instagram");
test("public verification panel is admin-only, links to the invite and updates without duplicates",async t=>{
  const db=new DatabaseSync(":memory:");t.after(()=>db.close());
  const client=new EventEmitter(),commands=new Map(),sent=[],edits=[],preserved=[];
  const message={id:"panel",edit:async p=>edits.push(p)};
  const channel={id:"main-channel",guildId:"main-guild",send:async p=>{sent.push(p);return message;},messages:{fetch:async()=>message}};
  client.channels={fetch:async()=>channel};
  install({client,db,registry:{register:c=>commands.set(c.name,c),preserveMessage:m=>preserved.push(m.id)}});
  const command=commands.get("instapainel");
  assert.deepEqual(command.permissions,["ManageGuild"]);
  const invocation={guild:{id:"main-guild"},guildId:"main-guild",channel,member:{permissions:{has:()=>false}}};
  await command.prefix.execute(invocation);
  assert.equal(sent.length,0);
  invocation.member.permissions.has=()=>true;
  await command.prefix.execute(invocation);
  const payload=sent[0],panel=payload.components[0].toJSON();
  assert.equal(panel.components[0].accessory.media.url,require("../instagram/art").VERIFICATION_THUMBNAIL);
  assert.equal(payload.flags,32768);
  assert.deepEqual(payload.allowedMentions,{parse:[]});
  assert.match(JSON.stringify(panel),/Somente mídias aprovadas/);
  assert.match(JSON.stringify(panel),/Abra um ticket/);
  assert.match(JSON.stringify(panel),/Se sua verificação for aprovada/);
  assert.match(JSON.stringify(panel),/receberá acesso ao canal/);
  const button=panel.components.flatMap(c=>c.components||[]).find(c=>c.url);
  assert.equal(button.url,"https://discord.gg/KMdAGUrZh7");
  assert.equal(button.style,5);
  assert.equal(panel.components.find(c=>c.type===12).items[0].media.url,require("../instagram/art").VERIFICATION_BANNER);
  assert.equal(panel.accent_color,0xC4A7E7);
  assert.equal(panel.components.at(-2).type,12);
  assert.equal(panel.components.at(-1).type,1);
  await command.prefix.execute(invocation);
  assert.equal(sent.length,1);assert.equal(edits.length,1);
  for(const fn of client.listeners("clientReady"))await fn();
  assert.equal(sent.length,1);assert.equal(edits.length,2);
  assert.deepEqual(preserved,["panel","panel","panel"]);
});
function remoteFixture(t){
  const db=new DatabaseSync(":memory:");t.after(()=>db.close());
  const client=new EventEmitter(),notices=[];
  let sourceAdmin=true,permissions=true;
  const channel={id:"123456789012345678",guildId:"source",type:0,
    guild:{members:{fetch:async()=>({permissions:{has:()=>sourceAdmin}})}},
    permissionsFor:()=>({has:()=>permissions}),send:async p=>{notices.push(p);return {id:"notice"};},isTextBased:()=>true};
  client.channels={fetch:async()=>channel};client.user={id:"bot"};
  const api=install({client,db,registry:{register(){},preserveMessage(){}}});
  db.prepare("INSERT INTO instagram_settings VALUES('target','feed')").run();
  const interaction={guildId:"target",customId:"insta:sourcesave",user:{id:"admin"},
    member:{permissions:{has:()=>true}},fields:{getTextInputValue:()=>channel.id},
    deferReply:async()=>{},editReply:async()=>{}};
  return {db,api,client,channel,interaction,notices,sourceAdmin:value=>{sourceAdmin=value;},permissions:value=>{permissions=value;}};
}
test("Instagram panel connects a remote source and shows a clean verification flow",async t=>{
  const f=remoteFixture(t);
  await f.api.handle(f.interaction);
  assert.equal(f.db.prepare("SELECT sourceGuildId FROM instagram_sources").get().sourceGuildId,"source");
  assert.equal(f.api.isIntake("source",f.channel.id),true);
  assert.equal(f.api.isIntake("target","feed"),false);
  assert.equal(f.notices.length,1);
  const panel=JSON.stringify(f.api.settings("target").components[0].toJSON());
  assert.match(panel,/Envio → verificação → publicação/);assert.match(panel,/123456789012345678/);
  assert.match(panel,/<#feed>/);
});
test("connecting remote Instagram requires management access in both guilds and bot permissions",async t=>{
  const f=remoteFixture(t);
  f.sourceAdmin(false);
  await assert.rejects(f.api.handle(f.interaction),/Gerenciar Servidor também na origem/);
  f.sourceAdmin(true);f.permissions(false);
  await assert.rejects(f.api.handle(f.interaction),/Faltam permissões/);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM instagram_sources").get().n,0);
  assert.equal(f.notices.length,0);
});
test("remote delivery persists on restart and cannot fall back to the source after disconnection",async t=>{
  const f=remoteFixture(t);
  await f.api.handle(f.interaction);
  f.api.captureDelivery("case","source",f.channel.id);
  const restarted=install({client:f.client,db:f.db,registry:{register(){},preserveMessage(){}}});
  f.client.channels.fetch=async()=>({id:"feed",guildId:"target",isTextBased:()=>true});
  assert.equal((await restarted.deliveryChannel("case")).guildId,"target");
  f.db.prepare("DELETE FROM instagram_sources").run();
  await assert.rejects(restarted.deliveryChannel("case"),/alterada ou desativada/);
});
test("startup forgets deleted Discord message references but preserves post history",async t=>{
  const db=new DatabaseSync(":memory:");t.after(()=>db.close());
  const client=new EventEmitter();
  client.channels={fetch:async()=>({messages:{fetch:async()=>{throw Object.assign(new Error("Unknown Message"),{code:10008});}}})};
  install({client,db,registry:{register(){},preserveMessage(){}}});
  db.prepare("INSERT INTO instagram_posts(id,guildId,channelId,messageId,authorId,filename,caption) VALUES('deleted','guild','channel','gone','author','photo.png','')").run();
  db.prepare("INSERT INTO instagram_likes VALUES('deleted','fan')").run();
  for(const fn of client.listeners("clientReady"))await fn();
  assert.equal(db.prepare("SELECT messageId FROM instagram_posts WHERE id='deleted'").get().messageId,null);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM instagram_likes").get().n,1);
});
test("legacy posts allow author to add Instagram without DMs",async t=>{
  const db=new DatabaseSync(":memory:");t.after(()=>db.close());
  const client=new EventEmitter();
  client.users={fetch:async()=>assert.fail("No DMs")};
  const api=install({client,db,registry:{register(){},preserveMessage(){}}});
  db.prepare("INSERT INTO instagram_posts(id,guildId,channelId,messageId,authorId,filename,caption) VALUES('legacy','guild','channel','message','author','photo.png','')").run();
  let reply;
  await api.handle({guildId:"guild",customId:"insta:profilesave:legacy",user:{id:"author"},fields:{getTextInputValue:()=>"@legacy"},reply:async p=>{reply=p;}});
  assert.match(JSON.stringify(reply.components[0].toJSON()),/instagram.com\/legacy/);
  assert.ok(reply.flags&64);
});
test("Instagram persists posts, toggles likes, comments, and restricts deletion",async t=>{
  const db=new DatabaseSync(":memory:");t.after(()=>db.close());
  const client=new EventEmitter(),commands=new Map(),edits=[];
  const message={attachments:{first:()=>undefined},components:[{type:17,components:[{type:12,items:[{media:{url:"https://cdn.discordapp.com/test.png"}}]}]}],edit:async p=>edits.push(p),delete:async()=>{}};
  const channel={id:"channel",guildId:"guild",send:async()=>({id:"message"}),messages:{fetch:async()=>message}};
  client.channels={fetch:async()=>channel};
  const registry={register:c=>commands.set(c.name,c),preserveMessage(){}};
  const api=install({client,registry,db});
  client.users={fetch:async()=>assert.fail("No DMs")};
  db.prepare("INSERT INTO instagram_settings VALUES('guild','channel')").run();
  await api.publish({channel,authorId:"author",filename:"photo.png",buffer:Buffer.from("mock"),originalMessageId:"original"});
  const post=db.prepare("SELECT * FROM instagram_posts").get();
  assert.doesNotMatch(JSON.stringify(api.render(post).components[0].toJSON()),/insta:delete:/);
  const replies=[];
  const i=(action,userId="user")=>({guildId:"guild",customId:`insta:${action}:${post.id}`,user:{id:userId},member:{permissions:{has:()=>false}},
    deferReply:async()=>{},reply:async p=>replies.push(p),editReply:async p=>replies.push(p),fields:{getTextInputValue:()=>"Bonita foto!"}});
  await api.handle(i("like"));assert.equal(db.prepare("SELECT COUNT(*) n FROM instagram_likes").get().n,1);
  await api.handle(i("like"));assert.equal(db.prepare("SELECT COUNT(*) n FROM instagram_likes").get().n,0);
  await api.handle(i("submit"));assert.equal(db.prepare("SELECT content FROM instagram_comments").get().content,"Bonita foto!");
  await api.handle(i("list"));
  const activity=replies.at(-1);
  assert.ok(activity.flags&64);
  assert.match(JSON.stringify(activity.components[0].toJSON()),/Atividade da publicação/);
  assert.match(JSON.stringify(activity.components[0].toJSON()),/insta:comments:/);
  for(let n=0;n<17;n++)db.prepare("INSERT INTO instagram_likes VALUES(?,?)").run(post.id,`fan-${n}`);
  const page=JSON.stringify(api.activityPanel(post,"likes",1).components[0].toJSON());
  assert.match(page,/Página 2 de 2/);assert.doesNotMatch(page,/fan-0>/);
  const comments=JSON.stringify(api.activityPanel(post,"comments").components[0].toJSON());
  assert.match(comments,/Bonita foto!/);assert.match(comments,/1 comentários/);
  for(const view of ["likes","comments"])for(const page of [0,1,2]){
    const ids=[];
    function collect(node){
      if(node.custom_id)ids.push(node.custom_id);
      for(const child of node.components||[])collect(child);
    }
    collect(api.activityPanel(post,view,page).components[0].toJSON());
    assert.equal(new Set(ids).size,ids.length,`${view}, página ${page}: IDs únicos`);
    assert.ok(ids.every(id=>id.length<=100));
  }
  await api.handle({...i("comments"),update:async payload=>replies.push(payload)});
  assert.match(JSON.stringify(replies.at(-1).components[0].toJSON()),/Bonita foto!/);
  const panel=()=>JSON.stringify(replies.at(-1).components[0].toJSON());
  await api.handle(i("info"));
  assert.match(panel(),/Nenhum Instagram/);assert.doesNotMatch(panel(),/insta:profileedit:|insta:delete:/);
  const choose=(action,user="author",handle="@meu.insta")=>({...i(action,user),fields:{getTextInputValue:()=>handle}});
  await api.handle(choose("profilesave","other"));assert.match(replies.at(-1).content,/Somente o autor/);
  await api.handle(choose("profilesave","author","https://instagram.com/test"));assert.match(replies.at(-1).content,/Informe apenas/);
  await api.handle(choose("profilesave"));
  await api.handle(i("info"));assert.match(panel(),/instagram.com\/meu.insta/);
  let profileModal;
  await api.handle({...i("profileedit","author"),showModal:async m=>{profileModal=m.toJSON();}});
  assert.match(profileModal.custom_id,/insta:profilesave:/);
  await api.handle(choose("profileremove"));
  await api.handle(i("info"));assert.match(panel(),/Nenhum Instagram/);
  await api.handle(i("info","author"));assert.match(JSON.stringify(replies.at(-1).components),/insta:delete:/);
  let modal;
  await api.handle({...i("comment"),isButton:()=>true,showModal:async m=>{modal=m.toJSON();}});
  assert.match(modal.custom_id,/insta:submit:/);assert.equal(modal.components[0].type,18);
  await api.handle(i("delete"));assert.match(replies.at(-1).content,/Somente o autor/);
  await api.handle({...i("delete"),member:{permissions:{has:()=>true}}});assert.match(replies.at(-1).content,/Somente o autor/);
  install({client:new EventEmitter(),registry,db});
  assert.equal(db.prepare("SELECT COUNT(*) n FROM instagram_posts").get().n,1);
  await api.handle(i("delete","author"));assert.equal(db.prepare("SELECT COUNT(*) n FROM instagram_posts").get().n,0);
  assert.equal(edits.length,3);assert.ok(commands.has("instagram"));
});
