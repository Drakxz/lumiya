const WebSocket=require("ws");
const {ChannelType}=require("discord.js");
const TARGET="1571977809633615942";

// Sessão separada: não modifica a conexão de voz ou o Gateway do bot principal.
module.exports=function installSecondaryVoice({
  client,token=process.env.DISCORD_BIO_CHECK_USER_TOKEN||"",
  channelId=TARGET,group="bio-account",manageSignals=true,selfMute=true,selfDeaf=true,autoReconnect=true,joinCall=true,presence={status:"online",name:"",type:0,url:""},onProfile=()=>{},Socket=WebSocket,voice=require("@discordjs/voice"),fetchImpl=fetch
}){
  token=token.trim();
  if(!token)return {close(){},getStatus:()=>({state:"disabled"})};
  let status="waiting";
  let audio={selfMute:Boolean(selfMute||selfDeaf),selfDeaf:Boolean(selfDeaf)},connectedAt=null;
  function updateProfile(user){
    if(!user||!/^\d{17,20}$/.test(user.id))return;
    const avatar=typeof user.avatar==="string"&&/^(a_)?[a-f0-9]{32}$/.test(user.avatar)?user.avatar:null;
    const discriminator=Number(user.discriminator)||0;
    const index=discriminator?discriminator%5:Number((BigInt(user.id)>>22n)%6n);
    const avatarURL=avatar?`https://cdn.discordapp.com/avatars/${user.id}/${avatar}.${avatar.startsWith("a_")?"gif":"png"}?size=128`
      :`https://cdn.discordapp.com/embed/avatars/${index}.png`;
    void Promise.resolve().then(()=>onProfile({userId:user.id,username:String(user.global_name||user.username||"").slice(0,80),avatarURL}))
      .catch(()=>console.warn("[Call conta secundária] Não foi possível salvar o perfil."));
  }
  let socket=null,heartbeat=null,retry=null,voiceRetry=null,connection=null,adapter=null;
  let stopped=false,connecting=false,seq=null,ack=true,userId=null,guildId=null;
  let presenceDelivery="pending",presenceError=null,presenceTail=Promise.resolve();
  function presencePayload(){
    return {since:presence.status==="idle"?Date.now():null,afk:presence.status==="idle",status:presence.status,
      activities:presence.name?[presence.type===4?{name:"Custom Status",type:4,state:presence.name}:
        {name:presence.name,type:presence.type,...(presence.type===1?{url:presence.url}:{})}]:[]};
  }
  function applyPresence(){
    if(!userId||stopped||socket?.readyState!==1){presenceDelivery="pending";return Promise.resolve();}
    const desired={...presence};
    presenceDelivery="sending";presenceError=null;
    send({op:3,d:presencePayload()});
    const work=presenceTail.catch(()=>{}).then(async()=>{
      if(stopped)return;
      try{
        // O status geral da conta e a presença da sessão são estados distintos.
        // Altera somente as configurações explicitamente solicitadas.
        const settings={status:desired.status};
        if(desired.type===4)settings.custom_status=desired.name?{text:desired.name,expires_at:null}:null;
        const response=await fetchImpl("https://discord.com/api/v9/users/@me/settings",{
          method:"PATCH",headers:{Authorization:token,"Content-Type":"application/json"},
          body:JSON.stringify(settings),redirect:"error",signal:AbortSignal.timeout(10000)
        });
        await response.body?.cancel?.().catch(()=>{});
        if(!response.ok)throw Object.assign(new Error("presence_update_failed"),{status:response.status});
        if(stopped)return;
        if(JSON.stringify(presence)===JSON.stringify(desired)){
          send({op:3,d:presencePayload()});presenceDelivery="sent";presenceError=null;
        }
      }catch(error){
        if(stopped||JSON.stringify(presence)!==JSON.stringify(desired))return;
        presenceDelivery="error";
        const code=Number(error.status);
        presenceError=code===429?"Limite do Discord: aguarde antes de tentar novamente.":
          [401,403].includes(code)?"O Discord recusou o acesso à configuração da conta.":
          code===404?"Configuração de status indisponível nesta API do Discord.":
          "Não foi possível sincronizar o status com o Discord.";
        console.warn("[Call conta secundária]",presenceError);
      }
    });
    presenceTail=work;return work;
  }
  function send(data){
    if(socket?.readyState!==1)return false;
    socket.send(JSON.stringify(data));return true;
  }
  function clearVoice(){
    const old=connection;connection=null;
    if(old)try{old.destroy();}catch{}
    adapter=null;
  }
  function later(){
    if(stopped||retry)return;
    if(!autoReconnect){status="disconnected";return;}
    status="reconnecting";
    retry=setTimeout(()=>{retry=null;void start();},30000);retry.unref();
  }
  function retryVoice(){
    if(stopped||voiceRetry)return;
    if(!autoReconnect){status="disconnected";clearVoice();return;}
    status="reconnecting";
    voiceRetry=setTimeout(()=>{voiceRetry=null;join();},15000);voiceRetry.unref();
  }
  function join(){
    if(stopped||!joinCall||!userId||!guildId||socket?.readyState!==1)return;
    clearVoice();
    try{
      const current=voice.joinVoiceChannel({
        channelId,guildId,...audio,group,
        adapterCreator:methods=>{
          adapter=methods;
          return {sendPayload:send,destroy(){if(adapter===methods)adapter=null;}};
        }
      });
      connection=current;
      current.on("error",()=>{console.warn("[Call conta secundária] Conexão de voz indisponível.");retryVoice();});
      current.on(voice.VoiceConnectionStatus.Disconnected,retryVoice);
      void voice.entersState(current,voice.VoiceConnectionStatus.Ready,30000).then(()=>{
        if(connection===current&&!stopped){
          clearTimeout(voiceRetry);voiceRetry=null;
          status="connected";
          connectedAt=Date.now();
          console.log("[Call conta secundária] Conectada ao canal",channelId);
        }
      }).catch(()=>{if(!stopped&&connection===current)retryVoice();});
    }catch{console.warn("[Call conta secundária] Não foi possível entrar na call.");retryVoice();}
  }
  function pulse(){
    if(!ack){socket?.terminate();return;}
    ack=false;send({op:1,d:seq});
  }
  function onMessage(raw){
    if(stopped)return;
    try{
      const packet=JSON.parse(String(raw));
      if(packet.s!==null&&packet.s!==undefined)seq=packet.s;
      if(packet.op===10){
        const interval=Number(packet.d?.heartbeat_interval);
        if(!Number.isFinite(interval)||interval<1000){socket?.terminate();return;}
        clearInterval(heartbeat);ack=true;
        heartbeat=setInterval(pulse,interval);heartbeat.unref();
        send({op:2,d:{token,properties:{os:process.platform,browser:"mds-bot",device:"mds-bot"},presence:presencePayload()}});
      }else if(packet.op===11)ack=true;
      else if(packet.op===1)send({op:1,d:seq});
      else if(packet.op===7||packet.op===9)socket?.terminate();
      else if(packet.op===0){
        if(packet.t==="READY"){
          userId=packet.d?.user?.id;
          if(userId===client.user?.id){
            console.warn("[Call conta secundária] O token pertence ao bot principal; conexão cancelada.");
            close();return;
          }
          updateProfile(packet.d.user);
          void applyPresence();
          if(joinCall)join();else{status="online";connectedAt=Date.now();}
        }else if(packet.t==="USER_UPDATE"&&packet.d?.id===userId){
          updateProfile(packet.d);
        }else if(packet.t==="VOICE_SERVER_UPDATE"&&packet.d?.guild_id===guildId)
          adapter?.onVoiceServerUpdate(packet.d);
        else if(packet.t==="VOICE_STATE_UPDATE"&&packet.d?.guild_id===guildId&&packet.d?.user_id===userId){
          adapter?.onVoiceStateUpdate(packet.d);
          if(packet.d.channel_id!==channelId)retryVoice();
        }
      }
    }catch{console.warn("[Call conta secundária] Evento de conexão inválido.");}
  }
  async function start(){
    if(stopped||connecting||socket||!client.isReady?.())return;
    connecting=true;
    try{
       const channel=joinCall?await client.channels.fetch(channelId):null;
       if(joinCall&&channel?.type!==ChannelType.GuildVoice)throw new Error("invalid_channel");
      if(stopped)return;
      guildId=channel?.guild.id||null;userId=null;seq=null;
      status="connecting";
      const current=new Socket("wss://gateway.discord.gg/?v=10&encoding=json",{handshakeTimeout:15000});
      socket=current;
      current.on("message",onMessage);
      current.on("error",()=>console.warn("[Call conta secundária] Gateway indisponível."));
      current.on("close",code=>{
        if(socket!==current)return;
        socket=null;clearInterval(heartbeat);clearTimeout(voiceRetry);voiceRetry=null;clearVoice();
        if([4004,4010,4011,4012,4013,4014].includes(Number(code))){
          console.warn("[Call conta secundária] Autenticação/configuração recusada. Não haverá novas tentativas nesta execução.");
          close();status="error";return;
        }
        later();
      });
    }catch{
      console.warn("[Call conta secundária] Canal indisponível; nova tentativa em 30 segundos.");later();
    }finally{connecting=false;}
  }
  function close(){
    if(stopped)return;
    stopped=true;clearInterval(heartbeat);clearTimeout(retry);clearTimeout(voiceRetry);
    status="disconnected";
    clearVoice();
    const current=socket;socket=null;current?.terminate();
    client.off("clientReady",start);
    for(const signal of ["SIGINT","SIGTERM","exit"])process.removeListener(signal,close);
  }
  if(manageSignals)for(const signal of ["SIGINT","SIGTERM","exit"])process.once(signal,close);
  if(client.isReady?.())void start();
  else client.once("clientReady",start);
  return {start,close,getStatus:()=>({state:status,connectedAt:["connected","online"].includes(status)?connectedAt:null,presenceDelivery,presenceError}),
    setPresence(next){presence=next;return applyPresence();},
    setAudio(muted,deafened){
      audio={selfMute:Boolean(muted||deafened),selfDeaf:Boolean(deafened)};
      if(connection&&!stopped)connection.rejoin({...audio,channelId});
    }};
};
