const { ChannelType } = require("discord.js");
const THREADS = [ChannelType.PublicThread, ChannelType.PrivateThread, ChannelType.AnnouncementThread];
function isThread(channel) {
  return THREADS.includes(channel?.type) || channel?.isThread?.() === true;
}
function channelScope(message) {
  const channel = message.channel;
  const thread = isThread(channel);
  const parent = thread
    ? channel.parent || message.moderationParent || message.guild?.channels?.cache?.get(channel.parentId)
    : null;
  const parentId = thread ? channel.parentId : null;
  return {
    thread, channel, parent, parentId,
    channelIds: [message.channelId, parentId].filter(Boolean),
    categoryId: thread ? parent?.parentId : channel?.parentId
  };
}
module.exports = { channelScope, isThread };
