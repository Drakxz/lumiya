const {test}=require("node:test");
const assert=require("node:assert/strict");
const {DatabaseSync}=require("node:sqlite");
const create=require("../instagram-web/latest-photo");
function fixture(){
  const db=new DatabaseSync(":memory:");
  db.exec("CREATE TABLE instagram_posts(id TEXT,guildId TEXT,channelId TEXT,messageId TEXT,authorId TEXT,filename TEXT)");
  const add=(id,guild,user,message)=>db.prepare("INSERT INTO instagram_posts VALUES(?,?,?,?,?,?)").run(id,guild,"channel",message,user,"photo.jpg");
  const fetched=[];
  const message={author:{id:"bot"},attachments:new Map([["a",{name:"photo.jpg",url:"https://cdn.discordapp.com/attachments/channel/photo/photo.jpg?ex=123"}]])};
  const client={user:{id:"bot"},channels:{fetch:async()=>({guildId:"primary",messages:{fetch:async id=>{fetched.push(id);return message;}}})}};
  return {db,add,fetched,message,resolve:create({db,client})};
}
test("last photo uses Discord snowflake order, primary guild and optional author",async()=>{
  const f=fixture();
  try{
    f.add("a","primary","alice","99");
    f.add("b","primary","bob","100");
    f.add("c","other","alice","999");
    f.add("d","primary","alice",null);
    f.add("video","primary","alice","9999");
    f.db.prepare("UPDATE instagram_posts SET filename='clip.mov' WHERE id='video'").run();
    assert.match(await f.resolve("primary"),/^https:\/\/cdn.discordapp.com\/attachments\//);
    assert.deepEqual(f.fetched,["100"]);
    await f.resolve("primary","alice");
    assert.equal(f.fetched[1],"99");
    assert.equal(await f.resolve("primary","missing"),null);
  }finally{f.db.close();}
});
test("missing, deleted, foreign-author and external attachments are not exposed",async()=>{
  const f=fixture();
  try{
    assert.equal(await f.resolve("primary"),null);
    f.add("a","primary","alice","100");
    f.message.author.id="other";
    assert.equal(await f.resolve("primary"),null);
    f.message.author.id="bot";
    f.message.attachments.get("a").url="https://example.com/private.jpg";
    assert.equal(await f.resolve("primary"),null);
    f.message.attachments.clear();
    assert.equal(await f.resolve("primary"),null);
    f.message.components=[{components:[{items:[{media:{url:"https://cdn.discordapp.com/attachments/channel/photo/photo.jpg"}}]}]}];
    assert.match(await f.resolve("primary"),/photo.jpg$/);
  }finally{f.db.close();}
});
