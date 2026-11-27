const {ContainerBuilder,SectionBuilder,SeparatorBuilder,MediaGalleryBuilder,TextDisplayBuilder,ButtonBuilder,ButtonStyle,MessageFlags}=require("discord.js");
const {createHash}=require("node:crypto");

function replyMessageId(message){
  const ref=message.reference;
  if(!ref?.messageId||ref.type===1||message.messageSnapshots?.size)return null;
  if(ref.channelId&&ref.channelId!==message.channelId)return null;
  if(ref.guildId&&ref.guildId!==message.guildId)return null;
  return /^\d{17,20}$/.test(ref.messageId)?ref.messageId:null;
}

function approvedPublication({authorId,buffer,filename,mime,caption="",replyMessageId}){
  const description=`Mídia aprovada de <@${authorId}>${caption?`\n${caption}`:""}`;
  const payload={files:[{attachment:buffer,name:filename}],allowedMentions:{parse:[]}};
  if(replyMessageId){
    payload.reply={messageReference:replyMessageId,failIfNotExists:false};
    payload.allowedMentions.repliedUser=false;
  }
  payload.nonce=BigInt(`0x${createHash("sha256").update(filename).digest("hex").slice(0,16)}`).toString();payload.enforceNonce=true;
  if(["image/png","image/jpeg","image/webp","image/gif","video/mp4","video/webm","video/quicktime"].includes(mime)){
    const container=new ContainerBuilder().addSectionComponents(new SectionBuilder()
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(`> **<@${authorId}>**`),
        new TextDisplayBuilder().setContent("-# Esta mídia foi verificada pelo nosso sistema."))
      .setButtonAccessory(new ButtonBuilder().setCustomId("mds-media-delete-approved")
        .setEmoji({name:"IconR_Delete",id:"1570542177510232144"}).setStyle(ButtonStyle.Secondary)))
      .addSeparatorComponents(new SeparatorBuilder().setDivider(true))
      .addMediaGalleryComponents(new MediaGalleryBuilder().addItems(item=>item.setURL(`attachment://${filename}`)));
    payload.components=[container];
    payload.flags=MessageFlags.IsComponentsV2;
    if(caption)container.addTextDisplayComponents(new TextDisplayBuilder().setContent(caption));
  }else{
    // Unknown media remains an attachment; never fake a classic image embed.
    payload.content=description;
  }
  return payload;
}
module.exports={approvedPublication,replyMessageId};
