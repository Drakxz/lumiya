const test=require("node:test"),assert=require("node:assert/strict");
const {approvedPublication,replyMessageId}=require("../media-moderation/publication");
const id="100000000000000001";

test("media replies keep the same channel reference without pinging or failing for deleted targets",()=>{
  const message={guildId:"g",channelId:"c",reference:{type:0,messageId:id,channelId:"c",guildId:"g"}};
  assert.equal(replyMessageId(message),id);
  const payload=approvedPublication({authorId:"user",buffer:Buffer.from("image"),filename:"photo.png",
    mime:"image/png",replyMessageId:replyMessageId(message)});
  assert.deepEqual(payload.reply,{messageReference:id,failIfNotExists:false});
  assert.deepEqual(payload.allowedMentions,{parse:[],repliedUser:false});
});

test("forwards and cross-channel or cross-guild references are not turned into media replies",()=>{
  const message={guildId:"g",channelId:"c",reference:{type:0,messageId:id,channelId:"c",guildId:"g"}};
  for(const reference of [
    {...message.reference,type:1},
    {...message.reference,channelId:"other"},
    {...message.reference,guildId:"other"},
    {...message.reference,messageId:"invalid"}
  ])assert.equal(replyMessageId({...message,reference}),null);
  assert.equal(replyMessageId({...message,messageSnapshots:new Map([["forward",{}]])}),null);
  assert.equal(replyMessageId({}),null);
  const payload=approvedPublication({authorId:"user",buffer:Buffer.from("image"),filename:"photo.png",mime:"image/png"});
  assert.equal(payload.reply,undefined);
});
