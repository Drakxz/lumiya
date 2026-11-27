const test=require("node:test");
const assert=require("node:assert/strict");
const {ChannelType}=require("discord.js");
const publisher=require("../backups/restore-panels");

test("restore republishes ticket panels only in new channels, with role access and no pings",async()=>{
  const sent=[],preserved=[],tracked=[],grants=[];
  const channel={id:"new",guildId:"guild",type:ChannelType.GuildText,
    async send(payload){sent.push(payload);return {id:"panel-message"};}};
  const guild={id:"guild",channels:{async fetch(){return channel;}}};
  const restore=publisher({
    registry:{preserveMessage:m=>preserved.push(m.id)},
    threadAccess:{async grantStaffRoleAccess(ch,kind){grants.push([ch.id,kind]);}},
    commandCenter:{async republishRestoredPanels(g,ids){assert.deepEqual(ids,["new"]);return [];}},
    renderSupport:async()=>({component:{kind:"support"},files:[{name:"arte-support.png",attachment:Buffer.from("png")}]}),
    renderMigration:async()=>({component:{kind:"migration"},files:[]})
  });
  const result={createdChannelIds:["new"],errors:[]};
  await restore(guild,[{channelId:"new",kind:"support"},{channelId:"new",kind:"support"},{channelId:"existing",kind:"migration"}],
    result,{trackPanel:(...args)=>tracked.push(args)});
  assert.equal(sent.length,1);
  assert.deepEqual(sent[0].allowedMentions,{parse:[]});
  assert.equal(sent[0].files[0].name,"arte-support.png");
  assert.ok(Buffer.isBuffer(sent[0].files[0].attachment));
  assert.deepEqual(grants,[["new","support"]]);
  assert.deepEqual(tracked,[["guild","new","support","panel-message"]]);
  assert.deepEqual(preserved,["panel-message"]);
  assert.deepEqual(result.errors,[]);
});

test("panel permission failures are reported rather than marking restore fully successful",async()=>{
  const restore=publisher({
    registry:{preserveMessage:()=>assert.fail("no message")},
    threadAccess:{async grantStaffRoleAccess(){throw new Error("missing permissions");}},
    commandCenter:{async republishRestoredPanels(){return [];}},
    renderSupport:async()=>({component:{},files:[]}),renderMigration:async()=>({component:{},files:[]})
  });
  const result={createdChannelIds:["new"],errors:[]};
  await restore({id:"guild",channels:{async fetch(){return {id:"new",guildId:"guild",type:ChannelType.GuildText};}}},
    [{channelId:"new",kind:"support"}],result,{trackPanel:()=>assert.fail("no message")});
  assert.equal(result.errors.length,1);
});
