const test=require("node:test"),assert=require("node:assert/strict");
const fs=require("node:fs/promises"),path=require("node:path"),os=require("node:os");
const {createStore,portable}=require("../call-panel/store");
async function fixture(t){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),"call-vault-"));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const keyFile=path.join(dir,"vault.key");
  const filename=path.join(dir,"accounts.enc");
  const store=createStore(filename,{protect:value=>portable(value,false,keyFile),unprotect:value=>portable(value,true,keyFile)});
  return {dir,keyFile,filename,store};
}
test("portable vault encrypts and round trips without plaintext credentials",async t=>{
  const {keyFile,filename,store}=await fixture(t);
  assert.deepEqual(await store.load(),[]);
  const rows=[{id:"account",token:"secret-token"}];
  await store.save(rows);
  assert.deepEqual(await store.load(),rows);
  assert.equal((await fs.readFile(filename,"utf8")).includes("secret-token"),false);
  assert.equal((await fs.readFile(keyFile)).length,32);
  const first=await fs.readFile(filename,"utf8");
  await store.save(rows);
  assert.notEqual(await fs.readFile(filename,"utf8"),first);
});
test("portable vault rejects tampering, wrong keys and missing keys",async t=>{
  const {keyFile,filename,store}=await fixture(t);
  await store.save([{token:"secret-token"}]);
  const original=await fs.readFile(filename,"utf8"),key=await fs.readFile(keyFile);
  const envelope=JSON.parse(original),data=Buffer.from(envelope.data,"base64");
  data[0]^=1;envelope.data=data.toString("base64");
  await fs.writeFile(filename,JSON.stringify(envelope));
  await assert.rejects(store.load());
  await fs.writeFile(filename,original);
  await fs.writeFile(keyFile,Buffer.alloc(32));
  await assert.rejects(store.load());
  await fs.unlink(keyFile);
  await assert.rejects(store.load());
  await assert.rejects(fs.stat(keyFile),{code:"ENOENT"});
  await fs.writeFile(keyFile,key);
  assert.deepEqual(await store.load(),[{token:"secret-token"}]);
});
