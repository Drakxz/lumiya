const test=require("node:test");
const assert=require("node:assert/strict");
const {EventEmitter}=require("node:events");
const d=require("discord.js");
const {DatabaseSync}=require("node:sqlite");
const install=require("../games-roles");

function setup(){
  const client=new EventEmitter(),commands=new Map();client.user={id:"bot"};
  const registry={register(def){commands.set(def.name,def);},preserveMessage(m){m.preserved=true;}};
  const db=new DatabaseSync(":memory:");
  const roles=new Map(["gartic","freefire","valorant","roblox"].map((name,n)=>[String(100000000000000010n+BigInt(n)),{
    id:String(100000000000000010n+BigInt(n)),name,managed:false,position:n+1,guild:{id:"guild"}
  }]));
  const owned=new Set(),changes=[];
  const channel={id:"channel",guildId:"guild",sent:[],isTextBased:()=>true,async send(payload){const m={id:`message-${this.sent.length}`,channelId:this.id};this.sent.push({payload,message:m});return m;}};
  const guild={id:"guild",roles:{cache:roles,async fetch(id){return roles.get(id)||null;}},members:{
    me:{permissions:new d.PermissionsBitField([d.PermissionFlagsBits.ManageRoles]),roles:{highest:{position:99}}},
    async fetch(){return {roles:{cache:new Map([...owned].map(id=>[id,roles.get(id)])),async add(role){owned.add(role.id);changes.push(["add",role.id]);},async remove(role){owned.delete(role.id);changes.push(["remove",role.id]);}}};}
  }};
  guild.channels={cache:new Map([[channel.id,channel]])};
  client.channels={async fetch(){return channel;}};
  const api=install({client,registry,db});
  return {api,client,commands,guild,roles,owned,changes,db,channel};
}
function tree(node){return [node,...(node.components||[]).flatMap(tree),...(node.accessory?tree(node.accessory):[])];}

test("configures roles before publishing exact persistent Games panel",async t=>{
  const f=setup();t.after(()=>f.db.close());
  const message={guild:f.guild,author:{id:"admin",bot:false},member:{permissions:new d.PermissionsBitField([d.PermissionFlagsBits.ManageGuild])},channel:f.channel,content:"!cargosgames"};
  await f.commands.get("cargosgames").prefix.execute(message);
  let config=f.channel.sent[0].payload.components[0].toJSON();
  assert.equal(config.components.filter(c=>c.type===1).length,5,"four role pickers and publish control");
  const selectIds=config.components.filter(c=>c.type===1).slice(0,4).map(row=>row.components[0].custom_id);
  const stateId=selectIds[0].split(":")[1];
  const emitted=async i=>{for(const fn of f.client.listeners("interactionCreate"))await fn(i);};
  let updated;
  for(let n=0;n<4;n++)await emitted({guild:f.guild,guildId:f.guild.id,user:{id:"admin"},member:message.member,
    customId:selectIds[n],values:[String(100000000000000010n+BigInt(n))],inGuild:()=>true,isRoleSelectMenu:()=>true,
    async update(p){updated=p;}});
  assert.ok(updated.components[0].toJSON().components.at(-1).components[0].disabled===false);
  await emitted({guild:f.guild,guildId:f.guild.id,user:{id:"admin"},member:message.member,
    customId:`mds-games-publish:${stateId}`,inGuild:()=>true,
    async update(p){updated=p;}});
  assert.equal(f.channel.sent.length,2);
  assert.equal(f.channel.sent[1].message.preserved,true);
  assert.equal(f.db.prepare("SELECT guildId FROM games_roles_config").get().guildId,"guild");
  const payload=f.channel.sent[1].payload,container=payload.components[0].toJSON();
  assert.equal(payload.flags,d.MessageFlags.IsComponentsV2);
  assert.equal(container.type,d.ComponentType.Container);
  assert.equal(container.accent_color,0xC4A7E7);
  assert.deepEqual(container.components.map(c=>c.type),[10,14,12,14,1]);
  assert.equal(container.components[0].content,"### <:emoji_29:1570189707667579000><:emoji_28:1570189682132652194><:emoji_27:1570189651539660951>");
  assert.equal(container.components[2].items.length,1);
  assert.equal(container.components[2].items[0].media.url,"https://cdn.discordapp.com/attachments/1569908468440367188/1570281109927891004/file_000000001048820e90ef3d220c362384.png");
  assert.deepEqual(container.components[4].components.map(b=>[b.label,b.custom_id,b.style]),[
    ["Gartic","mds-games-gartic",d.ButtonStyle.Secondary],
    ["Free Fire","mds-games-freefire",d.ButtonStyle.Secondary],
    ["Valorant","mds-games-valorant",d.ButtonStyle.Secondary],
    ["Roblox","mds-games-roblox",d.ButtonStyle.Secondary]
  ]);
  assert.deepEqual(container.components[4].components.map(b=>b.emoji),[
    {id:"1570281229125681175",name:"1561108577006002267"},
    {id:"1570281207982194738",name:"1552839465565692074"},
    {id:"1570281485133422592",name:"valorant"},
    {id:"1570280852913397852",name:"roblox"}
  ]);
  assert.ok(container.components[4].components.every(b=>!b.url));
  assert.equal(payload.components.length,1);
});

test("each game button independently adds or removes only its associated role, privately",async t=>{
  const f=setup();t.after(()=>f.db.close());
  f.db.prepare("INSERT INTO games_roles_config VALUES(?,?,?)").run(f.guild.id,JSON.stringify({gartic:String(100000000000000010n),freefire:String(100000000000000011n),valorant:String(100000000000000012n),roblox:String(100000000000000013n)}),Date.now());
  const emitted=async i=>{for(const listener of f.client.listeners("interactionCreate"))await listener(i);};
  const gartic=String(100000000000000010n),freefire=String(100000000000000011n);
  f.owned.add(freefire);
  let addedResponse,removedResponse;
  await emitted({guild:f.guild,guildId:f.guild.id,user:{id:"member"},customId:"mds-games-gartic",inGuild:()=>true,isButton:()=>true,
    async reply(p){addedResponse=p;}});
  await emitted({guild:f.guild,guildId:f.guild.id,user:{id:"member"},customId:"mds-games-freefire",inGuild:()=>true,isButton:()=>true,
    async reply(p){removedResponse=p;}});
  assert.deepEqual(f.changes,[["add",gartic],["remove",freefire]]);
  assert.ok(addedResponse.flags&d.MessageFlags.Ephemeral);assert.ok(removedResponse.flags&d.MessageFlags.Ephemeral);
  assert.match(addedResponse.components[0].toJSON().components[0].content,/Adicionado: Gartic/);
  assert.match(removedResponse.components[0].toJSON().components[0].content,/Removido: Free Fire/);
  assert.equal(addedResponse.components[0].toJSON().accent_color,0);
});

test("unconfigured panel buttons fail privately without changing member roles",async t=>{
  const f=setup();t.after(()=>f.db.close());
  let response;
  for(const listener of f.client.listeners("interactionCreate"))await listener({guild:f.guild,guildId:f.guild.id,user:{id:"member"},
    customId:"mds-games-roblox",inGuild:()=>true,isButton:()=>true,async reply(p){response=p;}});
  assert.ok(response.flags&d.MessageFlags.Ephemeral);
  assert.equal(f.changes.length,0);
  assert.match(response.components[0].toJSON().components[0].content,/ainda não foram configurados/);
});
