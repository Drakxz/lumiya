// Discord forwards carry media in messageSnapshots, not necessarily in the
// destination message's attachments. Never fetch/delete the source message.
function mediaEnvelope(message){
  if(!message.messageSnapshots?.size)return message;
  const attachments=new Map(),captions=[],seen=new Set(),pending=[{message,depth:0}];
  let visited=0;
  while(pending.length&&visited++<32){
    const {message:current,depth}=pending.shift();
    if(!current||seen.has(current))continue;seen.add(current);
    if(typeof current.content==="string"&&current.content.trim()&&!captions.includes(current.content))captions.push(current.content);
    for(const attachment of current.attachments?.values?.()||[]){
      const key=attachment.id||attachment.url;
      if(key&&!attachments.has(key))attachments.set(key,attachment);
    }
    if(depth<5)for(const snapshot of current.messageSnapshots?.values?.()||[])pending.push({message:snapshot,depth:depth+1});
  }
  return {id:message.id,guild:message.guild,guildId:message.guildId,channelId:message.channelId,channel:message.channel,
    author:message.author,createdTimestamp:message.createdTimestamp,attachments,content:captions.join("\n\n"),
    delete:(...args)=>message.delete(...args),reply:(...args)=>message.reply(...args)};
}
module.exports={mediaEnvelope};
