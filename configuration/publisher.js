const {PermissionFlagsBits,ChannelType}=require("discord.js");
class Publisher{
  constructor({store,panels,client,commands,onPublish=()=>{}}){Object.assign(this,{store,panels,client,commands,onPublish});this.busy=new Set();}
  async locked(key,fn){
    if(this.busy.has(key))throw new Error("Esta publicação está sendo atualizada. Aguarde e tente novamente.");
    this.busy.add(key);try{return await fn();}finally{this.busy.delete(key);}
  }
  async channel(guild,id,user){
    const channel=await guild.channels.fetch(id);
    if(!channel)throw Object.assign(new Error("Este canal não está disponível."),{code:10003});
    if(channel.guildId!==guild.id||![ChannelType.GuildText,ChannelType.GuildAnnouncement].includes(channel.type))throw new Error("Selecione um canal de texto deste servidor.");
    const me=guild.members.me||await guild.members.fetchMe();
    if(!channel.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages,PermissionFlagsBits.EmbedLinks]))
      throw new Error("A Lumiya precisa de Ver canal, Enviar mensagens e Inserir links neste canal.");
    if(user){
      const actor=await guild.members.fetch({user:user.id,force:true});
      if(!channel.permissionsFor(actor)?.has([PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages]))
        throw new Error("Você precisa de acesso ao canal e permissão para enviar mensagens nele.");
    }
    return channel;
  }
  async payload(panelId,context,channel){
    await this.panels.get(panelId).validate?.(context,channel);
    const payload=await this.panels.render(panelId,{...context,channel});
    if(payload.files.length&&!channel.permissionsFor(context.guild.members.me)?.has(PermissionFlagsBits.AttachFiles))
      throw new Error("A Lumiya precisa de Anexar arquivos para publicar as imagens.");
    return payload;
  }
  async publish(panelId,context,channelId){
    return this.locked(`${context.guild.id}:${panelId}:${channelId}`,async()=>{
      const channel=await this.channel(context.guild,channelId,context.user);
      const payload=await this.payload(panelId,context,channel);
      await this.panels.get(panelId).beforePublish?.(context,channel);
      const message=await channel.send(payload);
      const id=this.store.record(context.guild.id,panelId,channel.id,message.id,context.user.id);
      this.commands.preserveMessage(message);
      await this.onPublish(panelId,message,context);
      this.store.audit(context.guild.id,context.user.id,"panel.published",panelId,null,{id,channelId,messageId:message.id});
      return this.store.publication(context.guild.id,id);
    });
  }
  async existing(row,context){
    try{
      const channel=await this.channel(context.guild,row.channelId,context.user);
      const message=await channel.messages.fetch(row.messageId);
      if(message.author.id!==this.client.user.id)throw new Error("Esta mensagem não pertence à Lumiya.");
      return {channel,message};
    }catch(error){
      if([10008,10003].includes(error.code)){this.store.publicationStatus(row.id,"missing");throw new Error("A mensagem foi excluída ou o canal não existe mais. Use Republicar para escolher um canal válido.");}
      throw error;
    }
  }
  async update(id,context){
    return this.locked(id,async()=>{
      const row=this.store.publication(context.guild.id,id);
      if(row.status!=="published")throw new Error("Esta mensagem não está publicada. Use Republicar.");
      const {channel,message}=await this.existing(row,context);
      await message.edit({...await this.payload(row.panelId,context,channel),attachments:[]});
      this.store.publicationStatus(id,"published");
      this.store.audit(context.guild.id,context.user.id,"panel.updated",row.panelId,null,{id});
      return row;
    });
  }
  async remove(id,context){
    return this.locked(id,async()=>{
      const row=this.store.publication(context.guild.id,id);
      if(row.status==="published"){
        try{const {message}=await this.existing(row,context);await message.delete();}
        catch(error){if(this.store.publication(context.guild.id,id).status!=="missing")throw error;}
      }
      this.store.publicationStatus(id,"deleted");
      this.store.audit(context.guild.id,context.user.id,"panel.deleted",row.panelId,null,{id});
    });
  }
  async republish(id,context,channelId){
    return this.locked(id,async()=>{
      const row=this.store.publication(context.guild.id,id);
      if(!["missing","deleted"].includes(row.status))throw new Error("A publicação ainda existe ou já foi substituída. Atualize-a ou escolha outro registro.");
      const result=await this.publish(row.panelId,context,channelId||row.channelId);
      this.store.publicationStatus(id,"replaced");return result;
    });
  }
}
module.exports={Publisher};
