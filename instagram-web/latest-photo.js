// Resolve the real Discord attachment, including posts sent outside the portal.
module.exports=function latestPhoto({db,client}){
  return async function resolve(guildId,authorId){
    const photoOnly=" AND (lower(filename) GLOB '*.jpg' OR lower(filename) GLOB '*.jpeg' OR lower(filename) GLOB '*.png' OR lower(filename) GLOB '*.webp' OR lower(filename) GLOB '*.gif')";
    const post=authorId
      ?db.prepare("SELECT * FROM instagram_posts WHERE guildId=? AND authorId=? AND messageId IS NOT NULL"+photoOnly+" ORDER BY length(messageId) DESC,messageId DESC LIMIT 1").get(guildId,authorId)
      :db.prepare("SELECT * FROM instagram_posts WHERE guildId=? AND messageId IS NOT NULL"+photoOnly+" ORDER BY length(messageId) DESC,messageId DESC LIMIT 1").get(guildId);
    if(!post)return null;
    try{
      const channel=await client.channels.fetch(post.channelId);
      if(channel?.guildId!==guildId)return null;
      const message=await channel.messages.fetch(post.messageId);
      if(message?.author?.id!==client.user.id)return null;
      const attachments=[...(message.attachments?.values()||[])];
      const attachment=attachments.find(a=>a.name===post.filename)||attachments.find(a=>a.contentType?.startsWith("image/"));
      // Components V2 can contain the gallery without listing attachments.
      function gallery(components){
        for(const component of components||[]){
          const raw=component.toJSON?.()||component;
          const media=(raw.items||[]).find(item=>item.media?.url)?.media.url;
          if(media)return media;
          const nested=gallery(raw.components);if(nested)return nested;
        }
      }
      const source=attachment?.url||gallery(message.components);
      if(!source)return null;
      const url=new URL(source);
      if(url.protocol!=="https:"||!["cdn.discordapp.com","media.discordapp.net"].includes(url.hostname)||!url.pathname.startsWith("/attachments/"))return null;
      return url.href;
    }catch{return null;}
  };
};
