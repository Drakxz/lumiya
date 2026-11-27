const test=require("node:test");
const assert=require("node:assert/strict");
const {mediaEnvelope}=require("../media-moderation/forwarded");
test("forwarded normalization deduplicates attachments without mutating cached Discord messages",()=>{
  const attachment={id:"attachment",url:"https://cdn.discordapp.com/a.png"};let deleted=0;
  const snapshot={content:"forwarded caption",attachments:new Map([[attachment.id,attachment]])};
  const message={id:"destination",author:{id:"forwarder"},content:"comment",attachments:new Map([[attachment.id,attachment]]),messageSnapshots:new Map([["source",snapshot]]),delete(){deleted++;}};
  const normalized=mediaEnvelope(message);assert.notEqual(normalized,message);assert.equal(normalized.attachments.size,1);assert.equal(normalized.author.id,"forwarder");assert.equal(normalized.id,"destination");
  assert.equal(normalized.content,"comment\n\nforwarded caption");normalized.delete();assert.equal(deleted,1);assert.equal(message.content,"comment");
});
test("ordinary replies do not fetch references; nested snapshots with cycles terminate",()=>{
  const message={content:"reply",attachments:new Map(),reference:{messageId:"other"}};assert.equal(mediaEnvelope(message),message);
  const nested={content:"nested",attachments:new Map([["a",{id:"a",url:"https://cdn.discordapp.com/a.png"}]])};
  message.messageSnapshots=new Map([["nested",nested]]);nested.messageSnapshots=new Map([["cycle",message]]);
  const normalized=mediaEnvelope(message);assert.equal(normalized.attachments.size,1);assert.equal(normalized.content,"reply\n\nnested");
});
