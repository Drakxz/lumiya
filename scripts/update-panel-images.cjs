// Scoped maintenance: edits only recognized general panels authored by this bot.
const fs=require("node:fs");
const path=require("node:path");
const {REST,Routes}=require("discord.js");
const {panelImagesEnabled,removePanelImages}=require("../panel-art/appearance");
const GUILD="1331871489368260619";
function recognized(components){
  const all=[];
  function walk(items){for(const c of items||[]){all.push(c);walk(c.components);}}
  walk(components);
  return all.some(c=>["ticket-support","ticket-migration","ticket-instagram","unmute:self"].includes(c.custom_id)||
    /^mds-games-(gartic|freefire|valorant|roblox)$/.test(c.custom_id||"")||
    c.url==="https://discord.gg/KMdAGUrZh7")||
    (all.some(c=>c.url==="https://discord.com/terms")&&all.some(c=>
      c.items?.some(i=>i.media?.url?.includes("/1572062628103192617/"))));
}
async function main(){
  require("dotenv").config({quiet:true});
  if(panelImagesEnabled(GUILD))throw new Error("A remoção de imagens não está habilitada para este servidor.");
  if(!process.env.DISCORD_TOKEN)throw new Error("DISCORD_TOKEN ausente.");
  const apply=process.argv.includes("--apply");
  const rest=new REST({version:"10"}).setToken(process.env.DISCORD_TOKEN);
  const me=await rest.get(Routes.user("@me"));
  const channels=await rest.get(Routes.guildChannels(GUILD));
  const tracked=new Map();
  const dbPath=process.env.CALL_STATS_FILE||path.join(__dirname,"../database/call-stats.sqlite");
  if(fs.existsSync(dbPath)){
    const {DatabaseSync}=require("node:sqlite"),db=new DatabaseSync(dbPath,{readOnly:true});
    try{
      for(const table of ["bot_configuration_panels","instagram_entry_panels","instagram_ticket_panels","instagram_media_panels"]){
        if(!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table))continue;
        for(const row of db.prepare(`SELECT * FROM ${table} WHERE guildId=?`).all(GUILD)){
          if(row.messageId)tracked.set(`${row.channelId}:${row.messageId}`,row);
        }
      }
    }finally{db.close();}
  }
  const backup=[],changes=[],errors=[];
  let scanned=0;
  for(const channel of channels.filter(c=>[0,5].includes(c.type))){
    const messages=new Map();
    try{
      let before;
      // Historical panels also come from the registry, even beyond this window.
      for(let page=0;page<5;page++){
        const query=new URLSearchParams({limit:"100",...(before?{before}:{})});
        const batch=await rest.get(Routes.channelMessages(channel.id),{query});
        for(const m of batch)messages.set(m.id,m);
        if(batch.length<100)break;
        before=batch.at(-1).id;
      }
      for(const row of tracked.values())if(row.channelId===channel.id&&!messages.has(row.messageId)){
        try{messages.set(row.messageId,await rest.get(Routes.channelMessage(channel.id,row.messageId)));}
        catch(error){if(error.status!==404)throw error;}
      }
      for(const message of messages.values()){
        scanned++;
        if(message.author?.id!==me.id)continue;
        const key=`${channel.id}:${message.id}`;
        if(!tracked.has(key)&&!recognized(message.components))continue;
        const clean=removePanelImages(message.components||[]);
        if(JSON.stringify(clean)===JSON.stringify(message.components||[]))continue;
        backup.push({guildId:GUILD,channelId:channel.id,message});
        changes.push({channelId:channel.id,messageId:message.id,channelName:channel.name,components:clean});
      }
    }catch(error){
      errors.push({channelId:channel.id,status:error.status||error.code});
    }
  }
  console.log(JSON.stringify({mode:apply?"apply":"dry-run",guildId:GUILD,scanned,
    panels:changes.map(({components,...info})=>info),errors},null,2));
  if(!apply||!changes.length)return;
  const backupPath=path.join(__dirname,`../backups/panel-images-${GUILD}-${Date.now()}.json`);
  fs.writeFileSync(backupPath,JSON.stringify(backup,null,2),{flag:"wx",mode:0o600});
  console.log("Backup:",backupPath);
  for(const change of changes){
    await rest.patch(Routes.channelMessage(change.channelId,change.messageId),{
      body:{components:change.components,attachments:[],allowed_mentions:{parse:[]}}
    });
    console.log("Atualizado:",change.channelId,change.messageId);
  }
}
if(require.main===module)main().catch(error=>{
  console.error("Falha na manutenção dos painéis:",error.status||error.code||"erro local");
  process.exitCode=1;
});
module.exports={recognized};
