const test=require("node:test"),assert=require("node:assert/strict");
const {EventEmitter}=require("node:events");
const {ChannelType}=require("discord.js");
const install=require("../voice-presence");

test("joins fixed voice channel muted and deafened, then destroys connection on shutdown",async t=>{
  const client=new EventEmitter();client.isReady=()=>false;
  const connection=new EventEmitter();let destroyed=0,options;
  connection.destroy=()=>{destroyed++;};
  const guild={id:"guild",members:{me:{}},voiceAdapterCreator:()=>{}};
  client.channels={fetch:async id=>({id,type:ChannelType.GuildVoice,guild,permissionsFor:()=>({has:()=>true})})};
  const voice={VoiceConnectionStatus:{Ready:"ready",Disconnected:"disconnected",Destroyed:"destroyed"},
    joinVoiceChannel:o=>{options=o;return connection;},entersState:async c=>c};
  const api=install({client,voice});t.after(()=>api.close());
  client.isReady=()=>true;await api.connect();
  assert.equal(options.channelId,"1571977420569845900");
  assert.equal(options.selfMute,true);assert.equal(options.selfDeaf,true);
  api.close();assert.equal(destroyed,1);
});

test("missing voice permissions never attempts to join",async t=>{
  const client=new EventEmitter();client.isReady=()=>false;
  client.channels={fetch:async()=>({type:ChannelType.GuildVoice,guild:{members:{me:{}}},permissionsFor:()=>({has:()=>false})})};
  const api=install({client,voice:{joinVoiceChannel:()=>assert.fail("Must not join")}});
  t.after(()=>api.close());client.isReady=()=>true;
  await api.connect();
});
