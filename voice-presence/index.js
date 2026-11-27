const {ChannelType,PermissionFlagsBits}=require("discord.js");

const CHANNEL_ID="1571977420569845900";

module.exports=function installVoicePresence({client,voice=require("@discordjs/voice"),channelId=CHANNEL_ID}){
  let connection=null,retry=null,connecting=false,closed=false;
  function schedule(){
    if(closed||retry)return;
    retry=setTimeout(()=>{retry=null;void connect();},15000);
    retry.unref();
  }
  async function connect(){
    if(closed||connecting||!client.isReady?.())return;
    connecting=true;
    try{
      const channel=await client.channels.fetch(channelId);
      if(channel?.type!==ChannelType.GuildVoice)throw new Error("Canal de voz não encontrado.");
      const me=channel.guild.members.me||await channel.guild.members.fetchMe();
      if(!channel.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel,PermissionFlagsBits.Connect]))
        throw new Error("Preciso de Ver Canal e Conectar na call configurada.");
      if(closed)return;
      const previous=connection;connection=null;
      previous?.destroy();
      const current=voice.joinVoiceChannel({
        channelId:channel.id,guildId:channel.guild.id,adapterCreator:channel.guild.voiceAdapterCreator,
        selfMute:true,selfDeaf:true
      });
      connection=current;
      current.on("error",error=>{
        console.warn("[Call fixa] Erro de conexão:",error.message);schedule();
      });
      current.on(voice.VoiceConnectionStatus.Disconnected,()=>schedule());
      current.on(voice.VoiceConnectionStatus.Destroyed,()=>schedule());
      await voice.entersState(current,voice.VoiceConnectionStatus.Ready,30000);
      if(closed)return;
      if(retry){clearTimeout(retry);retry=null;}
      console.log("[Call fixa] Conectado ao canal",channelId);
    }catch(error){
      console.warn("[Call fixa] Não foi possível conectar:",error.message);
      schedule();
    }finally{connecting=false;}
  }
  function onState(_old,state){
    if(state.id===client.user?.id&&state.channelId!==channelId)schedule();
  }
  function close(){
    if(closed)return;
    closed=true;clearTimeout(retry);
    client.off("clientReady",connect);
    client.off("voiceStateUpdate",onState);
    for(const signal of ["SIGINT","SIGTERM","exit"])process.removeListener(signal,close);
    connection?.destroy();connection=null;
  }
  client.on("clientReady",connect);
  client.on("voiceStateUpdate",onState);
  for(const signal of ["SIGINT","SIGTERM","exit"])process.once(signal,close);
  if(client.isReady?.())void connect();
  return {connect,close,channelId};
};
