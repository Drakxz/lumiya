const {EmbedBuilder,escapeMarkdown}=require("discord.js");

// Logs are read-only. Delivery, authorization, retention and deduplication belong
// to the caller; this module never fetches users, files or remote media.
const CATEGORIES=Object.freeze({
  moderation:{color:0xb294d6,icon:"🛡️",label:"Moderação"},
  security:{color:0xd7a18e,icon:"🛡️",label:"Segurança"},
  community:{color:0xe2b8d2,icon:"♡",label:"Comunidade"},
  configuration:{color:0xb4afe3,icon:"⚙️",label:"Configuração"},
  members:{color:0xcbb8e7,icon:"👤",label:"Membros"},
  messages:{color:0xb9aec9,icon:"💬",label:"Mensagens"},
  voice:{color:0xb3c4df,icon:"🎧",label:"Voz"},
  media:{color:0xc4a7e7,icon:"📷",label:"Mídia"},
  backups:{color:0xb4afe3,icon:"☁️",label:"Backups"}
});
const dateFormat=new Intl.DateTimeFormat("pt-BR",{
  timeZone:"America/Sao_Paulo",dateStyle:"short",timeStyle:"medium"
});
const clean=value=>String(value??"—").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,"");
const safe=value=>escapeMarkdown(clean(value)).replace(/@/g,"@\u200b");
const field=(label,value)=>`**${safe(label)}**\n${clean(value)}`;
function chunks(value,max=1500){
  let rest=clean(value),out=[];
  while(rest.length>max){
    let end=rest.lastIndexOf("\n",max);
    if(end<max/2)end=max;
    // Never split a surrogate pair.
    if(/[\uD800-\uDBFF]/.test(rest[end-1]))end--;
    out.push(rest.slice(0,end));rest=rest.slice(end).replace(/^\n/,"");
  }
  if(rest)out.push(rest);
  return out;
}
function validImage(url){
  try{const u=new URL(url);return u.protocol==="https:"?u.href:null;}catch{return null;}
}
function clip(value,max){
  const string=clean(value);
  let end=Math.min(string.length,max);
  if(/[\uD800-\uDBFF]/.test(string[end-1]))end--;
  return string.slice(0,end);
}
function entries(values){
  return (Array.isArray(values)?values:[values])
    .filter(value=>value!==null&&value!==undefined&&value!=="");
}
function card({category="configuration",title,subtitle,summary=[],details=[],preview=[],
  avatarURL,botAvatarURL,imageURL,at=Date.now(),source,eventId,metadata=[]}={}){
  const theme=CATEGORIES[category]||CATEGORIES.configuration;
  const timestamp=Number.isFinite(new Date(Number(at)).getTime())?Number(at):Date.now();
  const heading=clip(`${theme.icon} ${safe(title||theme.label)}`,256);
  const description=clip(safe(subtitle||`Registro de ${theme.label.toLocaleLowerCase("pt-BR")}`),600);
  const footer=clip(`Lumiya · ${dateFormat.format(timestamp)} · Brasília\n${clean(source||theme.label)}${eventId?` · Registro: ${clean(eventId)}`:""}`,600);
  const embed=new EmbedBuilder().setColor(theme.color).setTitle(heading)
    .setDescription(description).setFooter({text:footer}).setTimestamp(timestamp);
  const botImage=validImage(botAvatarURL);
  embed.setAuthor({name:`Lumiya · ${theme.label}`,...(botImage?{iconURL:botImage}:{})});
  const image=validImage(avatarURL);
  if(image)embed.setThumbnail(image);
  // An image preview is opt-in: callers must pass only publishable media.
  // Media moderation intentionally never supplies this option.
  const previewImage=validImage(imageURL);
  if(previewImage)embed.setImage(previewImage);
  // One embed, real native fields, no Components V2 flag or containers.
  // Reserve space for the overflow notice under the 6,000-character total.
  let used=heading.length+description.length+footer.length+embed.data.author.name.length;
  let fieldCount=0;
  const overflow=[];
  function add(name,value,inline=false){
    const parts=chunks(value,1024),label=clip(safe(name),240);
    for(let index=0;index<parts.length;index++){
      const name=index?`${label} · continuação`:label;
      const value=parts[index];
      if(used+name.length+value.length>5500||fieldCount>=24){
        overflow.push(`${name}\n${value}`);continue;
      }
      embed.addFields({name,value,inline:inline&&parts.length===1});
      used+=name.length+value.length;fieldCount++;
    }
  }
  const main=entries(summary);
  // Pair short identity/status fields; long blocks remain full width on mobile.
  if(main.length<=12){
    for(const value of main){
      if(Array.isArray(value))add(value[0],clean(value[1]),clean(value[1]).length<=200);
      else add("Informações",value);
    }
  }else add("Informações",main.map(v=>Array.isArray(v)?field(v[0],v[1]):v).join("\n\n"));
  for(const [label,values]of [["Detalhes",details],["Conteúdo registrado",preview],["Identificadores",metadata]]){
    const content=entries(values).map(v=>Array.isArray(v)?field(v[0],v[1]):v).join("\n\n");
    if(content)add(label,content);
  }
  const payload={embeds:[embed],allowedMentions:{parse:[]}};
  if(overflow.length){
    // Do not silently drop long reasons, role lists or before/after content.
    embed.addFields({name:"Registro completo",value:"Os detalhes extensos continuam no arquivo de texto anexado.",inline:false});
    payload.files=[{attachment:Buffer.from(overflow.join("\n\n"),"utf8"),name:"lumiya-log-detalhes.txt"}];
  }
  return payload;
}

// Read legacy text-only payloads without ever returning their components/flags.
function fromPayload(payload,options={}){
  const blocks=[];
  function visit(component){
    const data=component.toJSON?.()||component;
    if(data.type===10&&data.content){
      const header=options.omitHeader&&!blocks.length&&/^#{1,3} /.test(data.content);
      const duplicateId=options.eventId&&data.content===`-# Registro: ${options.eventId}`;
      if(!header&&!duplicateId)blocks.push(data.content);
    }
    for(const child of data.components||[])visit(child);
  }
  for(const component of payload.components||[])visit(component);
  const result=card({...options,details:blocks});
  if(payload.files?.length)result.files=[...payload.files,...(result.files||[])];
  return result;
}
module.exports={card,fromPayload,CATEGORIES,field,safe,chunks};
