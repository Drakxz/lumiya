const test=require("node:test"),assert=require("node:assert/strict");
const {EventEmitter}=require("node:events");
const {ChannelType}=require("discord.js");
const install=require("../voice-presence/secondary");

test("secondary account uses separate gateway and joins only the requested channel",async t=>{
  const client=new EventEmitter();client.isReady=()=>false;client.user={id:"main"};
  client.channels={fetch:async id=>({id,type:ChannelType.GuildVoice,guild:{id:"guild"}})};
  let socket,joined,adapter,updates=0,destroyed=0;
  class Socket extends EventEmitter{
    constructor(){super();this.readyState=1;this.sent=[];socket=this;}
    send(raw){this.sent.push(JSON.parse(raw));}
    terminate(){this.readyState=3;}
  }
  const updatesAudio=[];
  const connection=new EventEmitter();connection.destroy=()=>{destroyed++;};connection.rejoin=options=>{updatesAudio.push(options);return true;};
  const voice={VoiceConnectionStatus:{Ready:"ready",Disconnected:"disconnected"},
    joinVoiceChannel(options){joined=options;adapter=options.adapterCreator({onVoiceStateUpdate(){updates++;},onVoiceServerUpdate(){updates++;}});return connection;},
    entersState:async c=>c};
  const api=install({client,token:"mock-secondary-token",group:"extra-call-account",Socket,voice,fetchImpl:async()=>({ok:true})});t.after(()=>api.close());
  client.isReady=()=>true;await api.start();
  socket.emit("message",JSON.stringify({op:10,d:{heartbeat_interval:45000}}));
  assert.equal(socket.sent[0].d.token,"mock-secondary-token");
  socket.emit("message",JSON.stringify({op:0,t:"READY",s:1,d:{user:{id:"secondary"}}}));
  assert.equal(joined.channelId,"1571977809633615942");
  assert.equal(joined.group,"extra-call-account");assert.equal(joined.selfMute,true);assert.equal(joined.selfDeaf,true);
  socket.emit("message",JSON.stringify({op:0,t:"VOICE_STATE_UPDATE",d:{guild_id:"guild",user_id:"main",channel_id:joined.channelId}}));
  assert.equal(updates,0);
  socket.emit("message",JSON.stringify({op:0,t:"VOICE_STATE_UPDATE",d:{guild_id:"guild",user_id:"secondary",channel_id:joined.channelId}}));
  assert.equal(updates,1);
  assert.equal(adapter.sendPayload({op:4,d:{channel_id:joined.channelId}}),true);
  api.setAudio(false,false);
  assert.deepEqual(updatesAudio.at(-1),{selfMute:false,selfDeaf:false,channelId:joined.channelId});
  api.setAudio(false,true);
  assert.equal(updatesAudio.at(-1).selfMute,true);assert.equal(updatesAudio.at(-1).selfDeaf,true);
  api.close();assert.equal(destroyed,1);assert.equal(socket.readyState,3);
});

test("secondary account remains disabled without its existing token",()=>{
  const client=new EventEmitter();
  const api=install({client,token:"",Socket:class{constructor(){assert.fail("No login");}},voice:{}});
  assert.equal(client.listenerCount("clientReady"),0);api.close();
});
test("presence-only session never fetches or joins a voice channel and sends status updates",async t=>{
  const client=new EventEmitter();client.isReady=()=>false;client.user={id:"main"};
  client.channels={fetch:async()=>assert.fail("No voice channel lookup")};
  let socket;
  class Socket extends EventEmitter{
    constructor(){super();this.readyState=1;this.sent=[];socket=this;}
    send(raw){this.sent.push(JSON.parse(raw));}terminate(){this.readyState=3;}
  }
  const requests=[];let httpStatus=200;
  const api=install({client,token:"mock",joinCall:false,channelId:"",Socket,voice:{joinVoiceChannel:()=>assert.fail("No call")},
    fetchImpl:async(url,options)=>{assert.equal(url,"https://discord.com/api/v9/users/@me/settings");requests.push(JSON.parse(options.body));return {ok:httpStatus===200,status:httpStatus};}});
  t.after(()=>api.close());client.isReady=()=>true;await api.start();
  socket.emit("message",JSON.stringify({op:10,d:{heartbeat_interval:45000}}));
  socket.emit("message",JSON.stringify({op:0,t:"READY",d:{user:{id:"secondary"}}}));
  assert.equal(api.getStatus().state,"online");
  await api.setPresence({status:"dnd",type:3,name:"sla",url:""});
  assert.equal(socket.sent.at(-1).op,3);
  assert.equal(socket.sent.at(-1).d.status,"dnd");
  assert.deepEqual(socket.sent.at(-1).d.activities,[{type:3,name:"sla"}]);
  assert.equal(requests.at(-1).status,"dnd");assert.equal(api.getStatus().presenceDelivery,"sent");
  await api.setPresence({status:"idle",type:4,name:"Meu status",url:""});
  assert.deepEqual(requests.at(-1),{status:"idle",custom_status:{text:"Meu status",expires_at:null}});
  assert.deepEqual(socket.sent.at(-1).d.activities,[{name:"Custom Status",type:4,state:"Meu status"}]);
  await api.setPresence({status:"online",type:4,name:"",url:""});
  assert.equal(requests.at(-1).custom_status,null);
  httpStatus=403;await api.setPresence({status:"dnd",type:4,name:"Teste",url:""});
  assert.equal(api.getStatus().presenceDelivery,"error");assert.match(api.getStatus().presenceError,/recusou/);
});
