// Restore only the missing support panel reported for this channel.
const fs=require("node:fs"),path=require("node:path"),vm=require("node:vm");
const discord=require("discord.js");
const {DatabaseSync}=require("node:sqlite");
async function main(){
  require("dotenv").config({quiet:true});
  const guildId="1331871489368260619",channelId="1570178853870239875";
  const rest=new discord.REST({version:"10"}).setToken(process.env.DISCORD_TOKEN);
  const channel=await rest.get(discord.Routes.channel(channelId));
  if(channel.guild_id!==guildId||channel.type!==0)throw new Error("Canal incompatível.");
  const db=new DatabaseSync(process.env.CALL_STATS_FILE||path.join(__dirname,"../database/call-stats.sqlite"));
  db.exec("PRAGMA busy_timeout=10000");
  try{
    const saved=db.prepare("SELECT * FROM bot_configuration_panels WHERE guildId=? AND channelId=? AND kind='support'").get(guildId,channelId);
    if(!saved)throw new Error("Painel não registrado.");
    try{
      await rest.get(discord.Routes.channelMessage(channelId,saved.messageId));
      console.log("O painel registrado já existe:",saved.messageId);
      return;
    }catch(error){if(error.status!==404)throw error;}
    const me=await rest.get(discord.Routes.user("@me"));
    const recent=await rest.get(discord.Routes.channelMessages(channelId),{query:new URLSearchParams({limit:"100"})});
    const contains=items=>(items||[]).some(c=>c.custom_id==="ticket-support"||contains(c.components));
    let message=recent.find(m=>m.author.id===me.id&&contains(m.components));
    if(!message){
      const guild=await rest.get(discord.Routes.guild(guildId));
      const source=fs.readFileSync(path.join(__dirname,"../index.js"),"utf8");
      const start=source.indexOf("const urlArtePainel ="),end=source.indexOf("const HALL_ART =");
      if(start<0||end<=start)throw new Error("Construtor do painel não encontrado.");
      // Evaluate only the existing panel builders, never the bot bootstrap.
      const component=vm.runInNewContext(source.slice(start,end)+"\ncriarPainel(guild).toJSON();",
        {...discord,...require("../brand"),...require("../panel-art/appearance"),guild});
      message=await rest.post(discord.Routes.channelMessages(channelId),{
        body:{components:[component],flags:discord.MessageFlags.IsComponentsV2,
          allowed_mentions:{parse:[]},nonce:`supportfix${Date.now()}`,enforce_nonce:true}
      });
    }
    db.prepare("UPDATE bot_configuration_panels SET messageId=? WHERE guildId=? AND channelId=? AND kind='support' AND messageId=?")
      .run(message.id,guildId,channelId,saved.messageId);
    console.log(`Painel: https://discord.com/channels/${guildId}/${channelId}/${message.id}`);
  }finally{db.close();}
}
main().catch(error=>{
  console.error("Falha na restauração:",error.status||error.code||error.message);
  if(error.code==="ERR_SQLITE_ERROR")console.error(error.message);
  process.exitCode=1;
});
