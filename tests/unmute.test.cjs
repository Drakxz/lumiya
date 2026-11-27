const test=require("node:test");
const assert=require("node:assert/strict");
const {EventEmitter}=require("node:events");
const {Collection,PermissionsBitField,PermissionFlagsBits,MessageFlags,ComponentType}=require("discord.js");
const install=require("../unmute");
const {renderUnmuteBanner}=require("../unmute/banner");

const USER="155000000000000001",GUILD="155000000000000002",STAFF="155000000000000003";
function harness({serverMute=true,serverDeaf=false,selfMute=false,selfDeaf=false,staff=false,timeout=null,botCanMute=true,botCanDeafen=true,operationError=null}={}){
  const client=new EventEmitter(),registered=[];
  const registry={register:c=>registered.push(c),deny:async()=>{}};
  const roles=new Collection(staff?[[STAFF,{id:STAFF}]]:[]);
  let removed=0,deafRemoved=0;
  const member={id:USER,communicationDisabledUntilTimestamp:timeout,roles:{cache:roles,highest:{comparePositionTo:()=>1}},
    voice:{serverMute,serverDeaf,selfMute,selfDeaf,channelId:"voice-channel",async setMute(value){removed++;if(operationError)throw operationError;this.serverMute=value;},
      async setDeaf(value){deafRemoved++;if(operationError)throw operationError;this.serverDeaf=value;}}};
  const botPerms=[];if(botCanMute)botPerms.push(PermissionFlagsBits.MuteMembers);if(botCanDeafen)botPerms.push(PermissionFlagsBits.DeafenMembers);
  const bot={permissions:new PermissionsBitField(botPerms),roles:{highest:{comparePositionTo:()=>1}}};
  const guild={id:GUILD,members:{me:bot,async fetch(){return member;}}};
  const api=install({client,registry,staffRoleId:STAFF});
  const i={guild,guildId:GUILD,user:{id:USER},member,inGuild:()=>true,isButton:()=>true,customId:"unmute:self",
    edits:[],async deferReply(options){this.deferred=true;this.options=options;},async editReply(payload){this.edits.push(payload);return payload;}};
  return {client,registered,api,guild,member,i,get removed(){return removed;},get deafRemoved(){return deafRemoved;}};
}
function responseText(i){return i.edits[0].components[0].toJSON().components.map(c=>c.content||"").join("\n");}

test("public panel uses the exact emoji title, dominant accent, copy, support channel and requested banner",()=>{
  const h=harness(),support={id:"155000000000000777",name:"support",type:0};h.guild.channels={cache:new Collection([[support.id,support]])};
  const p=h.api.panel(h.guild),container=p.components[0].toJSON();
  assert.equal(container.accent_color,0xC4A7E7);
  assert.equal(container.components[0].content,"### <:emoji_21:1570176552476348647><:emoji_20:1570176386893615204><:emoji_19:1570176352378949722>");
  const content=container.components.filter(c=>c.type===ComponentType.TextDisplay).map(c=>c.content).join("\n");
  assert.ok(content.includes("Foi mutado ou ensurdecido pelo servidor? Você pode remover o estado clicando no botão abaixo."));
  assert.ok(content.includes("<#155000000000000777>"));assert.ok(content.includes("Importante:"));
  assert.equal(container.components.some(c=>c.content?.includes("# Unmute")),false);
  assert.ok(container.components.some(c=>c.type===ComponentType.MediaGallery));
  assert.equal(container.components.find(c=>c.type===ComponentType.MediaGallery).items[0].media.url,"https://cdn.discordapp.com/attachments/1570868736926425190/1572067596252094545/file_0000000015cc820eb61043a08ee060bc.png");
  assert.equal(container.components.at(-1).components[0].label,"Seja Desmutado");
});

test("generated premium banner is a real landscape PNG",async()=>{
  const png=renderUnmuteBanner();assert.equal(png.subarray(1,4).toString(),"PNG");
  const {loadImage}=require("@napi-rs/canvas"),image=await loadImage(png);assert.equal(image.width,1280);assert.equal(image.height,430);
});

test("button removes only the clicking member's server mute and replies privately",async()=>{
  const h=harness();await h.api.handle(h.i);
  assert.equal(h.removed,1);assert.equal(h.member.voice.serverMute,false);
  assert.equal(h.deafRemoved,0);
  assert.equal(h.i.options.flags,MessageFlags.IsComponentsV2|MessageFlags.Ephemeral);
  assert.ok(responseText(h.i).includes("Estado de voz atualizado"));assert.ok(responseText(h.i).includes("mute de servidor foi removido"));
});

test("staff can self-unmute; local self-mute, active timeout, disconnected users and already-unmuted users are not changed",async()=>{
  const staff=harness({staff:true});await staff.api.handle(staff.i);
  assert.equal(staff.removed,1);assert.ok(responseText(staff.i).includes("Estado de voz atualizado"));
  for(const [options,expected]of [
    [{serverMute:false,serverDeaf:false,selfMute:true},"auto-mute"],
    [{serverMute:false,serverDeaf:false,selfMute:false},"Nenhum mute de servidor ativo"],
    [{timeout:Date.now()+60_000},"Timeout ativo"]
  ]){
    const h=harness(options);await h.api.handle(h.i);assert.equal(h.removed,0);assert.ok(responseText(h.i).includes(expected));
  }
  const h=harness();h.member.voice.channelId=null;await h.api.handle(h.i);
  assert.equal(h.removed,0);assert.ok(responseText(h.i).includes("Entre em uma call"));
});

test("missing bot permissions and API failures return private safe errors",async()=>{
  const noPerm=harness({botCanMute:false});await noPerm.api.handle(noPerm.i);
  assert.equal(noPerm.removed,0);assert.ok(responseText(noPerm.i).includes("Permissão ausente"));
  const failed=harness({operationError:Object.assign(new Error("Missing Permissions"),{code:50013})});await failed.api.handle(failed.i);
  assert.equal(failed.removed,1);assert.ok(responseText(failed.i).includes("Permissão insuficiente"));
});

test("server deafen can be removed alone or together with server mute; local deaf stays untouched",async()=>{
  const deaf=harness({serverMute:false,serverDeaf:true,selfDeaf:true});await deaf.api.handle(deaf.i);
  assert.equal(deaf.removed,0);assert.equal(deaf.deafRemoved,1);assert.equal(deaf.member.voice.serverDeaf,false);
  assert.ok(responseText(deaf.i).includes("deafen de servidor foi removido"));assert.ok(responseText(deaf.i).includes("Estados locais"));
  const both=harness({serverMute:true,serverDeaf:true});await both.api.handle(both.i);
  assert.equal(both.removed,1);assert.equal(both.deafRemoved,1);
});

test("server deafen requires Deafen Members permission",async()=>{
  const h=harness({serverMute:false,serverDeaf:true,botCanDeafen:false});await h.api.handle(h.i);
  assert.equal(h.deafRemoved,0);assert.ok(responseText(h.i).includes("Ensurdecer membros"));
});

test("only !unmutepainel is registered and requires ManageGuild",()=>{
  const h=harness();assert.deepEqual(h.registered.map(c=>c.name),["unmutepainel"]);
  assert.deepEqual(h.registered[0].permissions,["ManageGuild"]);assert.equal(h.registered[0].prefix.trigger,"!unmutepainel");
});
